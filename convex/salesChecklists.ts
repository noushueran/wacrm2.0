import {
  internalAction,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { v, ConvexError } from "convex/values";
import { accountMutation } from "./lib/auth";
import type { AccountRole } from "./lib/roles";
import { requireConversationAccess } from "./lib/conversationAccess";
import {
  DEFAULT_SALES_CHECKLIST,
  buildChecklistPrompt,
  parseChecklistGeneration,
  type ChecklistItemSeed,
} from "./lib/salesChecklist";
import { generateReply } from "./lib/ai/generate";

// ============================================================
// The post-qualification sales checklist. One row per qualification
// session, posted automatically when a lead qualifies
// (`completeQualification` schedules `generateForSession`): the KB's
// `SALES CHECKLIST` section → the account's LLM → task list, with the
// built-in 6-step default as the always-works fallback. Salespeople tick
// items off ONLY with a note ("Okay, I have done this…"); every tick,
// reopen, and deal outcome also lands on `contactNotes` — the same
// AI-processable trail agent WhatsApp feedback uses. Access mirrors
// `funnel.setStage`: agents act on their own assigned leads,
// supervisor+ on any, viewers read-only.
// ============================================================

function isAiDryRun(): boolean {
  return !!process.env.CONVEX_AI_DRY_RUN;
}

/** DRY-RUN stand-in for the generation LLM call — deterministic, so tests
 *  can steer the KB path without a network. */
const SYNTHETIC_CHECKLIST_RAW = JSON.stringify([
  { title: "Call the lead", description: "Real call, not chat." },
  { title: "Pitch the Bali package", description: "Match the collected answers." },
  { title: "Send the price", description: "Exact quote with inclusions." },
]);

const ITEM_SEED_VALIDATOR = v.array(
  v.object({
    key: v.string(),
    title: v.string(),
    description: v.optional(v.string()),
  }),
);

/** Loads the checklist + asserts the caller may WORK it (not just view):
 *  same own-gate as `funnel.setStage`. Structural ctx typing mirrors
 *  `requireConversationAccess` itself. */
async function requireChecklistAccess(
  ctx: {
    db: MutationCtx["db"];
    accountId: Id<"accounts">;
    role: AccountRole;
    userId: Id<"users">;
    requireRole: (min: AccountRole) => void;
  },
  checklistId: Id<"salesChecklists">,
) {
  ctx.requireRole("agent");
  const checklist = await ctx.db.get(checklistId);
  if (!checklist || checklist.accountId !== ctx.accountId) {
    throw new ConvexError({ code: "NOT_FOUND" });
  }
  await requireConversationAccess(ctx, checklist.conversationId, "own");
  return checklist;
}

export const setItemDone = accountMutation({
  args: {
    checklistId: v.id("salesChecklists"),
    itemKey: v.string(),
    note: v.string(),
  },
  handler: async (ctx, args) => {
    const checklist = await requireChecklistAccess(ctx, args.checklistId);

    const item = checklist.items.find((i) => i.key === args.itemKey);
    if (!item) {
      throw new ConvexError({ code: "NOT_FOUND", reason: "item_not_found" });
    }
    if (item.done) {
      throw new ConvexError({
        code: "BAD_REQUEST",
        reason: "item_already_done",
      });
    }
    const note = args.note.trim();
    if (note.length < 3) {
      throw new ConvexError({ code: "BAD_REQUEST", reason: "note_required" });
    }

    const now = Date.now();
    await ctx.db.patch(checklist._id, {
      items: checklist.items.map((i) =>
        i.key === args.itemKey
          ? { ...i, done: true, doneAt: now, doneByUserId: ctx.userId, note }
          : i,
      ),
    });
    await ctx.db.insert("contactNotes", {
      accountId: ctx.accountId,
      contactId: checklist.contactId,
      createdByUserId: ctx.userId,
      noteText: `✅ Checklist — ${item.title}: ${note}`,
    });
    return checklist._id;
  },
});

export const reopenItem = accountMutation({
  args: {
    checklistId: v.id("salesChecklists"),
    itemKey: v.string(),
  },
  handler: async (ctx, args) => {
    const checklist = await requireChecklistAccess(ctx, args.checklistId);

    const item = checklist.items.find((i) => i.key === args.itemKey);
    if (!item) {
      throw new ConvexError({ code: "NOT_FOUND", reason: "item_not_found" });
    }
    if (!item.done) {
      throw new ConvexError({ code: "BAD_REQUEST", reason: "item_not_done" });
    }

    await ctx.db.patch(checklist._id, {
      items: checklist.items.map((i) =>
        i.key === args.itemKey
          ? {
              key: i.key,
              title: i.title,
              ...(i.description ? { description: i.description } : {}),
              done: false,
            }
          : i,
      ),
    });
    await ctx.db.insert("contactNotes", {
      accountId: ctx.accountId,
      contactId: checklist.contactId,
      createdByUserId: ctx.userId,
      noteText: `↩️ Checklist task reopened: ${item.title}`,
    });
    return checklist._id;
  },
});

/** Read side for `generateForSession`. */
export const generationContext = internalQuery({
  args: {
    accountId: v.id("accounts"),
    sessionId: v.id("qualificationSessions"),
  },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session || session.accountId !== args.accountId) return null;
    const existing = await ctx.db
      .query("salesChecklists")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
      .first();
    return {
      serviceName: session.serviceName ?? null,
      hasChecklist: existing !== null,
    };
  },
});

/** Insert-if-absent (idempotent per session — OCC serializes the race).
 *  Items arrive as seeds; completion state starts clean. */
export const insertChecklist = internalMutation({
  args: {
    sessionId: v.id("qualificationSessions"),
    source: v.union(v.literal("kb"), v.literal("default")),
    items: ITEM_SEED_VALIDATOR,
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("salesChecklists")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
      .first();
    if (existing) return existing._id;
    const session = await ctx.db.get(args.sessionId);
    if (!session) return null;
    return await ctx.db.insert("salesChecklists", {
      accountId: session.accountId,
      sessionId: args.sessionId,
      conversationId: session.conversationId,
      contactId: session.contactId,
      source: args.source,
      items: args.items.map((i) => ({
        key: i.key,
        title: i.title,
        ...(i.description ? { description: i.description } : {}),
        done: false,
      })),
      generatedAt: Date.now(),
    });
  },
});

/**
 * Posts the sales checklist onto a freshly qualified lead. KB-driven when
 * possible (active AI config + knowledge chunks → `SALES CHECKLIST
 * <service>` retrieval → strict-JSON generation), the built-in default
 * otherwise — ANY failure still posts the default, so a qualified lead
 * is never left without its checklist.
 */
export const generateForSession = internalAction({
  args: {
    accountId: v.id("accounts"),
    sessionId: v.id("qualificationSessions"),
  },
  handler: async (ctx, args): Promise<void> => {
    const info = await ctx.runQuery(internal.salesChecklists.generationContext, {
      accountId: args.accountId,
      sessionId: args.sessionId,
    });
    if (!info || info.hasChecklist) return;

    let seeds: ChecklistItemSeed[] | null = null;
    try {
      const aiCfg = await ctx.runQuery(internal.aiConfig.loadDecrypted, {
        accountId: args.accountId,
      });
      if (aiCfg?.isActive) {
        if (isAiDryRun()) {
          seeds = parseChecklistGeneration(SYNTHETIC_CHECKLIST_RAW);
        } else {
          const hasKb = await ctx.runQuery(internal.aiReply.hasKnowledgeChunks, {
            accountId: args.accountId,
          });
          const excerpts: string[] = hasKb
            ? await ctx.runAction(internal.aiKnowledge.retrieve, {
                accountId: args.accountId,
                queryText: `SALES CHECKLIST ${info.serviceName ?? ""}`.trim(),
              })
            : [];
          if (excerpts.length > 0) {
            const gen = await generateReply({
              provider: aiCfg.provider,
              model: aiCfg.model,
              apiKey: aiCfg.apiKey,
              systemPrompt: buildChecklistPrompt({
                excerpts,
                serviceName: info.serviceName,
              }),
              messages: [
                {
                  role: "user",
                  content: "Generate the checklist for this lead now.",
                },
              ],
            });
            seeds = parseChecklistGeneration(gen.text);
            try {
              await ctx.runMutation(internal.aiUsage.log, {
                accountId: args.accountId,
                mode: "checklist",
                provider: aiCfg.provider,
                model: aiCfg.model,
                promptTokens: gen.usage?.promptTokens ?? 0,
                completionTokens: gen.usage?.completionTokens ?? 0,
                totalTokens: gen.usage?.totalTokens ?? 0,
              });
            } catch (err) {
              console.warn("[salesChecklist] usage log failed:", err);
            }
          }
        }
      }
    } catch (err) {
      console.error(
        "[salesChecklist] generation failed — posting the default checklist:",
        err,
      );
      seeds = null;
    }

    await ctx.runMutation(internal.salesChecklists.insertChecklist, {
      sessionId: args.sessionId,
      source: seeds ? "kb" : "default",
      items: seeds ?? DEFAULT_SALES_CHECKLIST,
    });
  },
});

/** One-shot: default checklists for already-qualified sessions that
 *  predate this feature. Run manually:
 *  `npx convex run salesChecklists:backfill`. */
export const backfill = internalMutation({
  args: {},
  handler: async (ctx) => {
    const qualified = await ctx.db
      .query("qualificationSessions")
      .withIndex("by_due", (q) => q.eq("status", "qualified"))
      .take(1000);
    let created = 0;
    for (const session of qualified) {
      const existing = await ctx.db
        .query("salesChecklists")
        .withIndex("by_session", (q) => q.eq("sessionId", session._id))
        .first();
      if (existing) continue;
      await ctx.db.insert("salesChecklists", {
        accountId: session.accountId,
        sessionId: session._id,
        conversationId: session.conversationId,
        contactId: session.contactId,
        source: "default",
        items: DEFAULT_SALES_CHECKLIST.map((i) => ({ ...i, done: false })),
        generatedAt: Date.now(),
      });
      created += 1;
    }
    return { created };
  },
});
