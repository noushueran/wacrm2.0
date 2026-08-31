import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import {
  DEFAULT_SALES_COACH_CONFIG,
  coachSkipReason,
  firstHumanResponseMinutes,
  type SalesCoachConfig,
} from "./lib/salesCoach/select";
import {
  SYNTHETIC_COACHING_RAW,
  buildCoachPrompt,
  parseCoaching,
} from "./lib/salesCoach/prompt";
import { generateReply } from "./lib/ai/generate";
import { aiJudgeModel, aiJudgeReasoningEffort, promptCacheKey } from "./lib/ai/defaults";

// ============================================================
// Sales coach — reads threads a person handled and writes specific,
// quotable observations about the handling.
//
// It never scores or ranks: this account has no outcome data at all, so
// a number would be invented precision attached to a colleague's name.
// It never coaches a thread the bot handled alone, and it drops any
// observation the model could not evidence with a quote.
//
// Dormant-safe: with no enabled config there are no candidates.
// ============================================================

function isDryRun(): boolean {
  return !!process.env.CONVEX_AI_DRY_RUN;
}

/** Conversations examined per sweep. Bounded like every read here. */
const SCAN = 400;
/** Messages fed to one review. Enough to judge handling, bounded so a
 *  long thread cannot blow the context or the bill. */
const TRANSCRIPT_LIMIT = 40;

export const enabledAccounts = internalQuery({
  args: {},
  handler: async (ctx): Promise<Id<"accounts">[]> => {
    const rows = await ctx.db.query("salesCoachConfigs").take(100);
    return rows.filter((r) => r.enabled).map((r) => r.accountId);
  },
});

interface ReviewTarget {
  conversationId: Id<"conversations">;
  subjectUserId: Id<"users">;
  salespersonName: string;
  transcript: string;
  outstandingChecklist: string[];
  firstResponseMinutes: number | null;
  reviewedThroughMs: number;
}

export const targetsForAccount = internalQuery({
  args: { accountId: v.id("accounts") },
  handler: async (
    ctx,
    args,
  ): Promise<{ config: SalesCoachConfig; targets: ReviewTarget[] } | null> => {
    const row = await ctx.db
      .query("salesCoachConfigs")
      .withIndex("by_account", (q) => q.eq("accountId", args.accountId))
      .first();
    if (!row || !row.enabled) return null;

    const config: SalesCoachConfig = {
      enabled: row.enabled,
      threadsPerRun: row.threadsPerRun,
      minMessages: row.minMessages,
      lookbackDays: row.lookbackDays,
    };

    const now = Date.now();
    const conversations = await ctx.db
      .query("conversations")
      .withIndex("by_account_archived_status", (q) =>
        q.eq("accountId", args.accountId).eq("archivedAt", undefined),
      )
      .order("desc")
      .take(SCAN);

    // Cheap pass first: everything decidable without extra reads.
    const maybe = conversations.filter(
      (c) =>
        c.assignedToUserId &&
        c.lastMessageAt !== undefined &&
        now - c.lastMessageAt <= config.lookbackDays * 86_400_000,
    );

    const targets: ReviewTarget[] = [];
    for (const c of maybe) {
      if (targets.length >= config.threadsPerRun) break;

      const messages = await ctx.db
        .query("messages")
        .withIndex("by_conversation", (q) => q.eq("conversationId", c._id))
        .order("desc")
        .take(TRANSCRIPT_LIMIT);
      if (messages.length === 0) continue;

      const lastReview = await ctx.db
        .query("salesCoachNotes")
        .withIndex("by_conversation", (q) => q.eq("conversationId", c._id))
        .order("desc")
        .first();

      const skip = coachSkipReason(
        {
          assignedToUserId: c.assignedToUserId ?? null,
          messageCount: messages.length,
          lastMessageAt: c.lastMessageAt!,
          reviewedThroughMs: lastReview?.reviewedThroughMs ?? null,
          hasHumanTurn: messages.some((m) => m.senderType === "agent"),
        },
        config,
        now,
      );
      if (skip !== null) continue;

      const member = await ctx.db
        .query("memberships")
        .withIndex("by_user_account", (q) =>
          q.eq("userId", c.assignedToUserId!).eq("accountId", args.accountId),
        )
        .first();

      const ordered = [...messages].reverse();
      const transcript = ordered
        .map((m) => {
          const who =
            m.senderType === "customer"
              ? "Customer"
              : m.senderType === "bot"
                ? "Assistant"
                : "Salesperson";
          return `${who}: ${(m.contentText ?? "(media)").slice(0, 400)}`;
        })
        .join("\n");

      // Outstanding checklist items, when the lead has a checklist.
      // `salesChecklists` is keyed by SESSION, not conversation, so this
      // goes through the qualification session to find it.
      const session = await ctx.db
        .query("qualificationSessions")
        .withIndex("by_conversation", (q) => q.eq("conversationId", c._id))
        .first();
      const checklist = session
        ? await ctx.db
            .query("salesChecklists")
            .withIndex("by_session", (q) => q.eq("sessionId", session._id))
            .first()
        : null;
      const outstanding = (checklist?.items ?? [])
        .filter((i: { done: boolean }) => !i.done)
        .map((i: { title: string }) => i.title)
        .slice(0, 8);

      targets.push({
        conversationId: c._id,
        subjectUserId: c.assignedToUserId!,
        salespersonName: member?.fullName ?? "the salesperson",
        transcript,
        outstandingChecklist: outstanding,
        firstResponseMinutes: firstHumanResponseMinutes(
          ordered.map((m) => ({ senderType: m.senderType, at: m._creationTime })),
        ),
        reviewedThroughMs: Math.max(...ordered.map((m) => m._creationTime)),
      });
    }

    return { config, targets };
  },
});

export const saveNote = internalMutation({
  args: {
    accountId: v.id("accounts"),
    conversationId: v.id("conversations"),
    subjectUserId: v.id("users"),
    observations: v.array(
      v.object({
        dimension: v.union(
          v.literal("unanswered_question"),
          v.literal("checklist_skipped"),
          v.literal("slow_response"),
          v.literal("tone"),
        ),
        observation: v.string(),
        quote: v.optional(v.string()),
      }),
    ),
    strengths: v.array(v.string()),
    firstResponseMinutes: v.optional(v.number()),
    reviewedThroughMs: v.number(),
    model: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("salesCoachNotes", { ...args, createdAt: Date.now() });
  },
});

export const sweep = internalAction({
  args: {},
  handler: async (ctx): Promise<void> => {
    const accountIds = await ctx.runQuery(internal.salesCoachEngine.enabledAccounts, {});

    for (const accountId of accountIds) {
      const loaded = await ctx.runQuery(internal.salesCoachEngine.targetsForAccount, {
        accountId,
      });
      if (!loaded || loaded.targets.length === 0) continue;

      const aiConfig = await ctx.runQuery(internal.aiConfig.loadDecrypted, { accountId });
      if (!aiConfig || !aiConfig.isActive) continue;
      const model = aiJudgeModel(aiConfig.provider, aiConfig.model);

      const extraInstructions = await ctx.runQuery(
        internal.agentInstructions.forAgent,
        { accountId, agentKey: "coach" },
      );

      for (const target of loaded.targets) {
        try {
          let raw: string;
          if (isDryRun()) {
            raw = SYNTHETIC_COACHING_RAW;
          } else {
            const result = await generateReply({
              provider: aiConfig.provider,
              model,
              apiKey: aiConfig.apiKey,
              systemPrompt: buildCoachPrompt({
                salespersonName: target.salespersonName,
                transcript: target.transcript,
                outstandingChecklist: target.outstandingChecklist,
                firstResponseMinutes: target.firstResponseMinutes,
                extraInstructions,
              }),
              messages: [{ role: "user", content: "Review it." }],
              reasoningEffort: aiJudgeReasoningEffort(),
              promptCacheKey: promptCacheKey(accountId, "coach"),
            });
            raw = result.text;
            if (result.usage) {
              try {
                await ctx.runMutation(internal.aiUsage.log, {
                  accountId,
                  conversationId: target.conversationId,
                  mode: "coach",
                  provider: aiConfig.provider,
                  model,
                  promptTokens: result.usage.promptTokens,
                  completionTokens: result.usage.completionTokens,
                  totalTokens: result.usage.totalTokens,
                });
              } catch (err) {
                console.error("[coach] usage log failed:", err);
              }
            }
          }

          const parsed = parseCoaching(raw);
          if (!parsed) continue;

          await ctx.runMutation(internal.salesCoachEngine.saveNote, {
            accountId,
            conversationId: target.conversationId,
            subjectUserId: target.subjectUserId,
            observations: parsed.observations,
            strengths: parsed.strengths,
            ...(target.firstResponseMinutes !== null
              ? { firstResponseMinutes: target.firstResponseMinutes }
              : {}),
            reviewedThroughMs: target.reviewedThroughMs,
            model,
          });
        } catch (err) {
          console.error(`[coach] review failed for ${target.conversationId}:`, err);
        }
      }
    }
  },
});

export const DEFAULTS = DEFAULT_SALES_COACH_CONFIG;
