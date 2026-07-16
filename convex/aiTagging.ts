import { action, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { getAuthUserId } from "@convex-dev/auth/server";
import { v, ConvexError } from "convex/values";
import type { Id, Doc } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { hasMinRole } from "./lib/roles";
import { accountMutation } from "./lib/auth";
import { toChatMessages } from "./lib/ai/context";
import { aiContextMessageLimit } from "./lib/ai/defaults";
import { generateReply } from "./lib/ai/generate";
import { AiError, type AiUsage } from "./lib/ai/types";
import { buildClassifyPrompt, parseClassification, type Catalogue } from "./lib/ai/classify";

// ============================================================
// AI tag-suggestion classify pipeline (AI Tag Suggestions, Task 4) — a
// new "classify" path that reuses the existing AI stack exactly the way
// `convex/aiReply.ts`'s `draft` action does: same account/role
// derivation, same `aiConfig.loadDecrypted` + `aiReply.recentMessages` +
// `toChatMessages` chain, same dry-run gate, same best-effort
// `aiUsage.log`. The two pure pieces this reuses — `buildClassifyPrompt`
// (renders the account's tag catalogue as a fixed option set) and
// `parseClassification` (maps the model's chosen tag NAMES back to real
// tag ids, never throws) — landed in `./lib/ai/classify.ts` in earlier
// tasks of this same feature.
//
// Unlike `draft`, EVERY failure mode here — auth, role, ownership, and
// AI-config state alike — is returned as `{error, code}` rather than
// thrown. `draft` mixes both (throws for auth/role/ownership, returns
// for AI-config/generation state); `suggest` is deliberately uniform so
// a caller (the inbox "suggest tags" banner) can branch on one shape.
// ============================================================

function isDryRun(): boolean {
  return !!process.env.CONVEX_AI_DRY_RUN;
}

/**
 * DRY-RUN stand-in for a real classification call — skips the network
 * entirely (mirrors `aiReply.ts`'s own `syntheticGeneration`). Picks the
 * FIRST tag of every group so `parseClassification` always has a real
 * tag name to map back to an id, giving tests a deterministic way to
 * exercise the full classify-then-record pipeline without ever touching
 * a provider. Confidence is pinned to `"low"` — a synthetic guess earns
 * no more than that.
 */
function syntheticClassifyRaw(catalogue: Catalogue): string {
  const tags = catalogue.groups
    .map((g) => g.tags[0]?.name)
    .filter((name): name is string => Boolean(name));
  return JSON.stringify({ tags, note: "dry-run classification", confidence: "low" });
}

// ------------------------------------------------------------
// Internal queries/mutations — DB access for the action below.
// ------------------------------------------------------------

/**
 * The account's tag catalogue — every `tagGroups` row with its own
 * `tags`, groups ordered by `position`. Shaped exactly as
 * `./lib/ai/classify.ts`'s `Catalogue` expects, so both
 * `buildClassifyPrompt` and `parseClassification` can consume it
 * directly. Ungrouped tags (`groupId` unset) are omitted — the classify
 * prompt only ever offers tags via their group, matching how `tags.ts`'s
 * `assignTag` already treats ungrouped tags as outside any single/multi
 * selection rule.
 */
export const loadCatalogue = internalQuery({
  args: { accountId: v.id("accounts") },
  handler: async (ctx, args): Promise<Catalogue> => {
    const groups = await ctx.db
      .query("tagGroups")
      .withIndex("by_account", (q) => q.eq("accountId", args.accountId))
      .collect();
    const tags = await ctx.db
      .query("tags")
      .withIndex("by_account", (q) => q.eq("accountId", args.accountId))
      .collect();
    return {
      groups: groups
        .sort((a, b) => a.position - b.position)
        .map((g) => ({
          id: g._id,
          name: g.name,
          selectionMode: g.selectionMode,
          tags: tags
            .filter((tag) => tag.groupId === g._id)
            .map((tag) => ({ id: tag._id, name: tag.name })),
        })),
    };
  },
});

const CONFIDENCE = v.union(v.literal("high"), v.literal("medium"), v.literal("low"));

/**
 * Records one classification result as a `"pending"` `tagSuggestions`
 * row, awaiting an agent's accept/dismiss. Always inserts as pending —
 * an eventual auto-apply path (`status: "auto_applied"`) is a later
 * task's concern, not this one's.
 */
export const recordSuggestion = internalMutation({
  args: {
    accountId: v.id("accounts"),
    conversationId: v.id("conversations"),
    contactId: v.id("contacts"),
    suggestedTagIds: v.array(v.id("tags")),
    note: v.optional(v.string()),
    confidence: CONFIDENCE,
    model: v.string(),
  },
  handler: async (ctx, args): Promise<Id<"tagSuggestions">> => {
    return await ctx.db.insert("tagSuggestions", {
      accountId: args.accountId,
      conversationId: args.conversationId,
      contactId: args.contactId,
      suggestedTagIds: args.suggestedTagIds,
      note: args.note,
      confidence: args.confidence,
      status: "pending",
      model: args.model,
    });
  },
});

// ------------------------------------------------------------
// suggest — the public entry point.
// ------------------------------------------------------------

type SuggestResult =
  | {
      suggestionId: Id<"tagSuggestions">;
      tagIds: string[];
      note?: string;
      confidence: "high" | "medium" | "low";
    }
  | { error: string; code: string };

/**
 * Agent+ "classify this conversation" action. Body: `{conversationId}`.
 * Loads the account's config + the conversation's recent text history
 * (REUSING `aiReply.recentMessages`/`toChatMessages`, the same internals
 * `aiReply.draft` uses), loads the account's tag catalogue, classifies
 * it (a real provider call, or a deterministic synthetic result under
 * `CONVEX_AI_DRY_RUN`), and records the result as a pending suggestion
 * for an agent to review. Usage is logged via `internal.aiUsage.log`
 * (`mode: "classify"`) whenever a real call reported any — mirrors
 * `draft`'s own best-effort usage logging, minus the try/catch: unlike
 * `draft`'s fire-and-forget-but-caught log call, a failure here is
 * allowed to propagate (there's no already-sent reply to protect).
 *
 * Tenant scoping mirrors `aiReply.draft`: `getAuthUserId` +
 * `internal.accounts.accountContextForUser({userId})` (an action has no
 * `ctx.db` of its own to look up the caller's membership inline). UNLIKE
 * `draft`, though, every failure mode — including auth/role/ownership —
 * comes back as `{error, code}` rather than a thrown `ConvexError`: see
 * this file's header for why.
 */
export const suggest = action({
  args: { conversationId: v.id("conversations") },
  handler: async (ctx, args): Promise<SuggestResult> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return { error: "Not authenticated", code: "unauthenticated" };

    const context = await ctx.runQuery(internal.accounts.accountContextForUser, { userId });
    if (!context) return { error: "No account", code: "no_account" };
    const { accountId, role } = context;

    // Agent floor — same rank `contacts.assignTag`/`contactNotes.add`
    // require via `ctx.requireRole("agent")`; supervisor+ and agents may
    // classify, viewers may not. `suggest` is a plain `action` (no
    // `ctx.db`, hence no `accountMutation`/`requireRole` helper), so the
    // check is the explicit `hasMinRole` `draft`/`playground` also use.
    if (!hasMinRole(role, "agent")) {
      return { error: "Forbidden", code: "forbidden" };
    }

    const conversation = await ctx.runQuery(internal.aiReply.getConversationForAccount, {
      accountId,
      conversationId: args.conversationId,
    });
    if (!conversation) {
      return { error: "Conversation not found", code: "not_found" };
    }

    let config;
    try {
      config = await ctx.runQuery(internal.aiConfig.loadDecrypted, { accountId });
    } catch {
      return { error: "Stored API key could not be decrypted.", code: "key_decrypt_failed" };
    }
    if (!config || !config.isActive || !config.apiKey) {
      return { error: "AI is not configured", code: "ai_not_configured" };
    }

    const catalogue = await ctx.runQuery(internal.aiTagging.loadCatalogue, { accountId });

    const historyRows = await ctx.runQuery(internal.aiReply.recentMessages, {
      accountId,
      conversationId: args.conversationId,
      limit: aiContextMessageLimit(),
    });
    const messages = toChatMessages(historyRows);
    const systemPrompt = buildClassifyPrompt(catalogue);

    let raw: string;
    let usage: AiUsage | null = null;
    if (isDryRun()) {
      raw = syntheticClassifyRaw(catalogue);
    } else {
      try {
        const gen = await generateReply({
          provider: config.provider,
          model: config.model,
          apiKey: config.apiKey,
          systemPrompt,
          messages,
        });
        raw = gen.text;
        usage = gen.usage;
      } catch (err) {
        if (err instanceof AiError) return { error: err.message, code: err.code };
        throw err;
      }
    }

    const parsed = parseClassification(raw, catalogue);

    if (usage) {
      await ctx.runMutation(internal.aiUsage.log, {
        accountId,
        conversationId: args.conversationId,
        mode: "classify",
        provider: config.provider,
        model: config.model,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        totalTokens: usage.totalTokens,
      });
    }

    const suggestionId = await ctx.runMutation(internal.aiTagging.recordSuggestion, {
      accountId,
      conversationId: args.conversationId,
      contactId: conversation.contactId,
      suggestedTagIds: parsed.tagIds as Id<"tags">[],
      note: parsed.note,
      confidence: parsed.confidence,
      model: config.model,
    });

    return {
      suggestionId,
      tagIds: parsed.tagIds,
      note: parsed.note,
      confidence: parsed.confidence,
    };
  },
});

// ============================================================
// accept/dismiss mutations — backend for suggestion review UI
// ============================================================

/**
 * Validates that the suggestion belongs to the current account.
 * Throws NOT_FOUND if missing or cross-account.
 */
async function requireOwnSuggestion(
  ctx: { db: MutationCtx["db"]; accountId: Id<"accounts"> },
  suggestionId: Id<"tagSuggestions">,
): Promise<Doc<"tagSuggestions">> {
  const sug = await ctx.db.get(suggestionId);
  if (!sug || sug.accountId !== ctx.accountId) {
    throw new ConvexError({ code: "NOT_FOUND", entity: "tagSuggestion" });
  }
  return sug;
}

/**
 * Applies a pending suggestion's tags to the contact with source:"ai",
 * adds its note (if any) to contactNotes, and marks the suggestion accepted.
 * Single-select displacement: if a tag's group is `selectionMode:"single"`,
 * delete other tags from the same group before inserting.
 */
export const acceptSuggestion = accountMutation({
  args: { suggestionId: v.id("tagSuggestions") },
  handler: async (ctx, args) => {
    ctx.requireRole("agent");
    const sug = await requireOwnSuggestion(ctx, args.suggestionId);

    for (const tagId of sug.suggestedTagIds) {
      const tag = await ctx.db.get(tagId);
      if (!tag || tag.accountId !== ctx.accountId) continue; // tag deleted since — skip

      // single-select displacement
      if (tag.groupId) {
        const group = await ctx.db.get(tag.groupId);
        if (group?.selectionMode === "single") {
          const links = await ctx.db
            .query("contactTags")
            .withIndex("by_contact", (q) => q.eq("contactId", sug.contactId))
            .collect();
          for (const link of links) {
            if (link.tagId === tagId) continue;
            const other = await ctx.db.get(link.tagId);
            if (other?.groupId === tag.groupId) await ctx.db.delete(link._id);
          }
        }
      }

      const existing = await ctx.db
        .query("contactTags")
        .withIndex("by_contact_tag", (q) => q.eq("contactId", sug.contactId).eq("tagId", tagId))
        .first();
      if (existing) {
        if (existing.source === undefined) await ctx.db.patch(existing._id, { source: "ai" });
      } else {
        await ctx.db.insert("contactTags", {
          accountId: ctx.accountId,
          contactId: sug.contactId,
          tagId,
          source: "ai",
        });
      }
    }

    if (sug.note) {
      await ctx.db.insert("contactNotes", {
        accountId: ctx.accountId,
        contactId: sug.contactId,
        noteText: sug.note,
        createdByUserId: ctx.userId,
      });
    }

    await ctx.db.patch(args.suggestionId, { status: "accepted", reviewedByUserId: ctx.userId });
  },
});

/**
 * Marks a pending suggestion as dismissed (no data change to contact/tags).
 */
export const dismissSuggestion = accountMutation({
  args: { suggestionId: v.id("tagSuggestions") },
  handler: async (ctx, args) => {
    ctx.requireRole("agent");
    await requireOwnSuggestion(ctx, args.suggestionId);
    await ctx.db.patch(args.suggestionId, { status: "dismissed", reviewedByUserId: ctx.userId });
  },
});
