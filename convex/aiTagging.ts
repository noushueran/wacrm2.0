import { action, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { getAuthUserId } from "@convex-dev/auth/server";
import { v, ConvexError } from "convex/values";
import type { Id, Doc } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { hasMinRole, canAccessConversation } from "./lib/roles";
import { accountMutation, accountQuery } from "./lib/auth";
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
 * no more than that. When the account's catalogue is entirely empty (no
 * `tagGroups`/`tags` at all) there's nothing to pick a tag from — and
 * nothing worth noting either, so `note` comes back empty too. That lets
 * a dry-run test exercise `suggest`'s empty-classification short-circuit
 * (`parsed.tagIds.length === 0 && !parsed.note` → `{code: "no_tags"}`)
 * deterministically, the same way a non-empty catalogue exercises the
 * normal record path.
 */
function syntheticClassifyRaw(catalogue: Catalogue): string {
  const tags = catalogue.groups
    .map((g) => g.tags[0]?.name)
    .filter((name): name is string => Boolean(name));
  const note = tags.length > 0 ? "dry-run classification" : "";
  return JSON.stringify({ tags, note, confidence: "low" });
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

/**
 * The account's pending `tagSuggestions` row for a conversation, if any —
 * `suggest`'s own idempotency guard: called BEFORE any classify work so a
 * redundant "Suggest tags" click (two agents racing, or one click landing
 * before the reactive `pendingForConversation` query has re-rendered the
 * banner out of its CTA face) returns the existing row instead of
 * inserting a second, orphaned one. Same `by_conversation`-scan-then-
 * filter shape as `pendingForConversation` near the bottom of this file
 * (see that query's own comment for why it isn't a compound index) —
 * kept as a separate `internalQuery` rather than reused directly because
 * `suggest` is a plain `action` with no `ctx.db` of its own, while
 * `pendingForConversation` is an `accountQuery` that derives `accountId`
 * from the authenticated caller rather than taking it as an arg.
 */
export const existingPending = internalQuery({
  args: { accountId: v.id("accounts"), conversationId: v.id("conversations") },
  handler: async (ctx, args): Promise<Doc<"tagSuggestions"> | null> => {
    const rows = await ctx.db
      .query("tagSuggestions")
      .withIndex("by_conversation", (q) => q.eq("conversationId", args.conversationId))
      .collect();
    return rows.find((r) => r.accountId === args.accountId && r.status === "pending") ?? null;
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
 * If the conversation already has a pending suggestion (`existingPending`,
 * above) — two agents both clicking "Suggest tags", or a redundant click
 * landing before the reactive `pendingForConversation` query has hidden
 * the CTA — that row is returned as-is rather than reclassifying, so a
 * race never produces two pending rows and never burns a second (paid)
 * provider call. Otherwise: loads the account's config + the
 * conversation's recent text history (REUSING
 * `aiReply.recentMessages`/`toChatMessages`, the same internals
 * `aiReply.draft` uses), loads the account's tag catalogue, and
 * classifies it (a real provider call, or a deterministic synthetic
 * result under `CONVEX_AI_DRY_RUN`). If that classification came back
 * with nothing — no tags AND no note — there's nothing worth showing an
 * agent, so it's returned as `{error, code: "no_tags"}` WITHOUT recording
 * an empty pending row; otherwise the result is recorded as a pending
 * suggestion for an agent to review. Usage is logged via
 * `internal.aiUsage.log` (`mode: "classify"`) whenever a real call
 * reported any, AFTER that record-or-skip decision (never before — the
 * account already paid the provider for this classification regardless
 * of how it comes out, so the spend is logged either way) and wrapped in
 * try/catch — best-effort, mirrors `draft`'s own usage logging: a
 * transient log failure must not throw away an already-recorded (or
 * already-decided-empty) classification.
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
    // Per-conversation RBAC: the account check above lets an agent classify a
    // COLLEAGUE'S thread grounded in history `messages.listByConversation`
    // would deny them. Same "view" policy as `reactions.reactToMeta`, surfaced
    // as this action's own `{error, code:"not_found"}` shape (it never throws).
    if (
      !canAccessConversation(
        role,
        {
          isMine: conversation.assignedToUserId === userId,
          isUnassigned: conversation.assignedToUserId === undefined,
        },
        "view",
      )
    ) {
      return { error: "Conversation not found", code: "not_found" };
    }

    // Idempotency guard — deliberately BEFORE any config/catalogue load or
    // the classify call itself, so a redundant click can't burn a real
    // provider call: see `existingPending`'s own comment for the race this
    // closes (or narrows — it's a read here and a later insert below,
    // across two separate function calls, not one atomic transaction).
    const existing = await ctx.runQuery(internal.aiTagging.existingPending, {
      accountId,
      conversationId: args.conversationId,
    });
    if (existing) {
      return {
        suggestionId: existing._id,
        tagIds: existing.suggestedTagIds,
        note: existing.note,
        confidence: existing.confidence,
      };
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

    if (parsed.tagIds.length === 0 && !parsed.note) {
      // Nothing worth showing an agent. A real provider call still
      // consumed tokens even though it came back empty, so that spend is
      // still logged (best-effort, same try/catch as the success path
      // below) — but `recordSuggestion` is skipped: an empty pending row
      // would just be dead UI weight with nothing to accept, dismiss, or
      // act on.
      if (usage) {
        try {
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
        } catch (err) {
          console.warn("[ai tag suggest] usage log failed:", err);
        }
      }
      return {
        error: "The AI didn't find any matching tags for this conversation.",
        code: "no_tags" as const,
      };
    }

    // Record FIRST, log usage second (and best-effort): the account
    // already paid the provider for this classification, so a transient
    // failure logging that spend must never discard the suggestion it
    // already paid for — unlike a thrown error here, which would roll
    // back nothing (the insert below already committed) but WOULD
    // incorrectly surface as a failed `suggest` call to the banner even
    // though the suggestion is sitting there, pending, un-reachable by
    // the caller that just "failed".
    const suggestionId = await ctx.runMutation(internal.aiTagging.recordSuggestion, {
      accountId,
      conversationId: args.conversationId,
      contactId: conversation.contactId,
      suggestedTagIds: parsed.tagIds as Id<"tags">[],
      note: parsed.note,
      confidence: parsed.confidence,
      model: config.model,
    });

    if (usage) {
      try {
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
      } catch (err) {
        console.warn("[ai tag suggest] usage log failed:", err);
      }
    }

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
 * Idempotent: re-invoking on a suggestion that's no longer "pending" (already
 * accepted or dismissed) is a no-op. The tag upsert below is naturally safe
 * to repeat (it looks up `by_contact_tag` before inserting), but the
 * `contactNotes` insert below is NOT — without this guard, re-invoking on an
 * already-accepted suggestion would insert a duplicate note every time.
 */
export const acceptSuggestion = accountMutation({
  args: { suggestionId: v.id("tagSuggestions") },
  handler: async (ctx, args) => {
    ctx.requireRole("agent");
    const sug = await requireOwnSuggestion(ctx, args.suggestionId);
    if (sug.status !== "pending") return; // already reviewed — no-op

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
 * Idempotent: re-invoking on a suggestion that's no longer "pending" is a
 * no-op — in particular, this won't flip an already-accepted suggestion
 * back to dismissed.
 */
export const dismissSuggestion = accountMutation({
  args: { suggestionId: v.id("tagSuggestions") },
  handler: async (ctx, args) => {
    ctx.requireRole("agent");
    const sug = await requireOwnSuggestion(ctx, args.suggestionId);
    if (sug.status !== "pending") return; // already reviewed — no-op
    await ctx.db.patch(args.suggestionId, { status: "dismissed", reviewedByUserId: ctx.userId });
  },
});

// ============================================================
// pendingForConversation — backend for the inbox "Suggest tags" banner
// ============================================================

/**
 * The account's pending `tagSuggestions` row for a conversation, if any —
 * lets the inbox banner decide which face to show: the "Suggest tags" CTA
 * when this is `null`, or the accept/dismiss review UI when it's a row.
 * `by_conversation` isn't compound with `status`, so this scans the
 * (small in practice) set of a conversation's suggestions and filters
 * `status === "pending"` in memory; the `accountId` check is the same
 * belt-and-suspenders cross-tenant guard `requireOwnSuggestion` uses,
 * defensive since `by_conversation` alone can't scope by account.
 * `suggest` now guards against creating a second pending row itself
 * (`existingPending`, defined earlier in this file) before it ever
 * classifies — but that guard is a plain read-then-later-insert split
 * across two separate function calls, not an atomic/schema-level
 * uniqueness constraint, so it narrows the race rather than eliminating
 * it. Don't treat "at most one pending row per conversation" as an
 * invariant this table enforces; `.find(...)` below deliberately returns
 * just the first match rather than asserting there's only one.
 */
export const pendingForConversation = accountQuery({
  args: { conversationId: v.id("conversations") },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("tagSuggestions")
      .withIndex("by_conversation", (q) => q.eq("conversationId", args.conversationId))
      .collect();
    return rows.find((r) => r.accountId === ctx.accountId && r.status === "pending") ?? null;
  },
});
