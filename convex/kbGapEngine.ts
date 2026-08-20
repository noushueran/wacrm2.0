import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import {
  DEFAULT_KB_GAP_CONFIG,
  isThinAnswer,
  type KbGapConfig,
} from "./lib/kbGap/select";
import {
  SYNTHETIC_CLUSTER_RAW,
  SYNTHETIC_ENTRY_RAW,
  buildClusterPrompt,
  buildEntryPrompt,
  parseClusters,
  parseEntryDraft,
} from "./lib/kbGap/prompt";
import { generateReply } from "./lib/ai/generate";
import { aiJudgeModel, aiJudgeReasoningEffort, promptCacheKey } from "./lib/ai/defaults";

// ============================================================
// Knowledge gap agent — turns the questions the assistant had to escalate
// into knowledge it will not have to escalate again.
//
// Two jobs from one table. `adminInquiries` holds every question the
// assistant could not answer, and whether a human ever answered it:
//
//   ANSWERED   → a knowledge-base draft, written from the human's own
//                answer. The agent rewrites; it never researches.
//   UNANSWERED → clustered into themes. It is told not to answer these,
//                because nobody has, and inventing a visa rule is worse
//                than admitting the gap.
//
// Dormant-safe: with no enabled config there are no candidates, so the
// cron finds nothing and the feature costs nothing.
// ============================================================

function isDryRun(): boolean {
  return !!process.env.CONVEX_AI_DRY_RUN;
}

/** How many unanswered questions one clustering call may consider.
 *  Bounded like every read here; production had 49. */
const CLUSTER_SCAN = 120;

export const enabledAccounts = internalQuery({
  args: {},
  handler: async (ctx): Promise<Id<"accounts">[]> => {
    const rows = await ctx.db.query("kbGapConfigs").take(100);
    return rows.filter((r) => r.enabled).map((r) => r.accountId);
  },
});

interface Candidate {
  inquiryId: Id<"adminInquiries">;
  question: string;
  answer: string;
}

export const workForAccount = internalQuery({
  args: { accountId: v.id("accounts") },
  handler: async (
    ctx,
    args,
  ): Promise<{
    config: KbGapConfig;
    answered: Candidate[];
    unanswered: string[];
  } | null> => {
    const row = await ctx.db
      .query("kbGapConfigs")
      .withIndex("by_account", (q) => q.eq("accountId", args.accountId))
      .first();
    if (!row || !row.enabled) return null;

    const config: KbGapConfig = {
      enabled: row.enabled,
      entriesPerRun: row.entriesPerRun,
      minAnswerChars: row.minAnswerChars,
    };

    // "answered" and "delivered" both mean a human wrote something —
    // delivered just means the customer also got it.
    const answeredRows = [
      ...(await ctx.db
        .query("adminInquiries")
        .withIndex("by_account_status", (q) =>
          q.eq("accountId", args.accountId).eq("status", "answered"),
        )
        .take(200)),
      ...(await ctx.db
        .query("adminInquiries")
        .withIndex("by_account_status", (q) =>
          q.eq("accountId", args.accountId).eq("status", "delivered"),
        )
        .take(200)),
    ];

    const answered: Candidate[] = [];
    for (const inq of answeredRows) {
      // Already considered — the idempotency record is what stops a
      // sweep re-drafting the same entry every run.
      const seen = await ctx.db
        .query("kbGapProcessed")
        .withIndex("by_inquiry", (q) => q.eq("inquiryId", inq._id))
        .first();
      if (seen) continue;
      answered.push({
        inquiryId: inq._id,
        question: inq.question,
        answer: inq.answer ?? "",
      });
    }

    const pending = await ctx.db
      .query("adminInquiries")
      .withIndex("by_account_status", (q) =>
        q.eq("accountId", args.accountId).eq("status", "pending"),
      )
      .take(CLUSTER_SCAN);

    return {
      config,
      answered,
      unanswered: pending.map((p) => p.question),
    };
  },
});

export const recordProcessed = internalMutation({
  args: {
    accountId: v.id("accounts"),
    inquiryId: v.id("adminInquiries"),
    outcome: v.union(
      v.literal("drafted"),
      v.literal("skipped_thin_answer"),
      v.literal("skipped_not_durable"),
    ),
    reason: v.optional(v.string()),
    entry: v.optional(
      v.object({
        title: v.string(),
        body: v.string(),
        type: v.string(),
        serviceKey: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx, args) => {
    let kbEntryId: Id<"kbEntries"> | undefined;

    if (args.entry) {
      // Lands as a DRAFT in the knowledge base the other agents already
      // read. Publishing stays a human act.
      kbEntryId = await ctx.db.insert("kbEntries", {
        accountId: args.accountId,
        scope: args.entry.serviceKey ? "service" : "company",
        ...(args.entry.serviceKey ? { serviceKey: args.entry.serviceKey } : {}),
        type: args.entry.type as "faq",
        title: args.entry.title,
        body: args.entry.body,
        audience: "customer",
        status: "draft",
        version: 1,
        updatedAt: Date.now(),
      });
    }

    await ctx.db.insert("kbGapProcessed", {
      accountId: args.accountId,
      inquiryId: args.inquiryId,
      outcome: args.outcome,
      ...(kbEntryId ? { kbEntryId } : {}),
      ...(args.reason ? { reason: args.reason } : {}),
      createdAt: Date.now(),
    });
  },
});

export const replaceThemes = internalMutation({
  args: {
    accountId: v.id("accounts"),
    themes: v.array(
      v.object({
        theme: v.string(),
        questionCount: v.number(),
        examples: v.array(v.string()),
      }),
    ),
  },
  handler: async (ctx, args) => {
    // Replaced wholesale, not merged: a theme is a view over the CURRENT
    // backlog. Merging would strand themes whose questions have since
    // been answered, and the board would keep reporting a gap that is
    // closed.
    const existing = await ctx.db
      .query("kbGapThemes")
      .withIndex("by_account", (q) => q.eq("accountId", args.accountId))
      .take(200);
    for (const row of existing) await ctx.db.delete(row._id);

    const now = Date.now();
    for (const t of args.themes) {
      await ctx.db.insert("kbGapThemes", {
        accountId: args.accountId,
        theme: t.theme,
        questionCount: t.questionCount,
        examples: t.examples,
        updatedAt: now,
      });
    }
  },
});

export const sweep = internalAction({
  args: {},
  handler: async (ctx): Promise<void> => {
    const accountIds = await ctx.runQuery(internal.kbGapEngine.enabledAccounts, {});

    for (const accountId of accountIds) {
      const work = await ctx.runQuery(internal.kbGapEngine.workForAccount, {
        accountId,
      });
      if (!work) continue;

      const aiConfig = await ctx.runQuery(internal.aiConfig.loadDecrypted, { accountId });
      if (!aiConfig || !aiConfig.isActive) continue;
      const model = aiJudgeModel(aiConfig.provider, aiConfig.model);

      const extraInstructions = await ctx.runQuery(
        internal.agentInstructions.forAgent,
        { accountId, agentKey: "kbgap" },
      );

      // ── 1. Answered inquiries become drafts ──────────────────────
      let drafted = 0;
      for (const candidate of work.answered) {
        if (drafted >= work.config.entriesPerRun) break;

        // The cheap filter first — a bare "Okay" must never cost a
        // provider call.
        if (isThinAnswer(candidate.answer, work.config)) {
          await ctx.runMutation(internal.kbGapEngine.recordProcessed, {
            accountId,
            inquiryId: candidate.inquiryId,
            outcome: "skipped_thin_answer",
            reason: "The answer was too short to be knowledge",
          });
          continue;
        }

        try {
          let raw: string;
          if (isDryRun()) {
            raw = SYNTHETIC_ENTRY_RAW;
          } else {
            const result = await generateReply({
              provider: aiConfig.provider,
              model,
              apiKey: aiConfig.apiKey,
              systemPrompt: buildEntryPrompt({
                question: candidate.question,
                answer: candidate.answer,
                serviceName: null,
                extraInstructions,
              }),
              messages: [{ role: "user", content: "Write the entry." }],
              reasoningEffort: aiJudgeReasoningEffort(),
              promptCacheKey: promptCacheKey(accountId, "kbgap"),
            });
            raw = result.text;
            if (result.usage) {
              try {
                await ctx.runMutation(internal.aiUsage.log, {
                  accountId,
                  mode: "kb_gap",
                  provider: aiConfig.provider,
                  model,
                  promptTokens: result.usage.promptTokens,
                  completionTokens: result.usage.completionTokens,
                  totalTokens: result.usage.totalTokens,
                });
              } catch (err) {
                console.error("[kbgap] usage log failed:", err);
              }
            }
          }

          const parsed = parseEntryDraft(raw);
          // Unparseable means we learned nothing — leave the inquiry
          // unprocessed so a later sweep can try again.
          if (!parsed) continue;

          if (!parsed.worthKeeping) {
            await ctx.runMutation(internal.kbGapEngine.recordProcessed, {
              accountId,
              inquiryId: candidate.inquiryId,
              outcome: "skipped_not_durable",
              reason: parsed.reason || "Not reusable knowledge",
            });
            continue;
          }

          await ctx.runMutation(internal.kbGapEngine.recordProcessed, {
            accountId,
            inquiryId: candidate.inquiryId,
            outcome: "drafted",
            reason: parsed.reason,
            entry: { title: parsed.title, body: parsed.body, type: parsed.type },
          });
          drafted += 1;
        } catch (err) {
          // One bad inquiry must not stop the rest.
          console.error(`[kbgap] draft failed for ${candidate.inquiryId}:`, err);
        }
      }

      // ── 2. Unanswered questions become themes ────────────────────
      if (work.unanswered.length === 0) {
        await ctx.runMutation(internal.kbGapEngine.replaceThemes, {
          accountId,
          themes: [],
        });
        continue;
      }

      try {
        let raw: string;
        if (isDryRun()) {
          raw = SYNTHETIC_CLUSTER_RAW;
        } else {
          const result = await generateReply({
            provider: aiConfig.provider,
            model,
            apiKey: aiConfig.apiKey,
            systemPrompt: buildClusterPrompt({
              questions: work.unanswered,
              extraInstructions,
            }),
            messages: [{ role: "user", content: "Group them." }],
            reasoningEffort: aiJudgeReasoningEffort(),
            promptCacheKey: promptCacheKey(accountId, "kbgap"),
          });
          raw = result.text;
          if (result.usage) {
            try {
              await ctx.runMutation(internal.aiUsage.log, {
                accountId,
                mode: "kb_gap",
                provider: aiConfig.provider,
                model,
                promptTokens: result.usage.promptTokens,
                completionTokens: result.usage.completionTokens,
                totalTokens: result.usage.totalTokens,
              });
            } catch (err) {
              console.error("[kbgap] usage log failed:", err);
            }
          }
        }

        const themes = parseClusters(raw, work.unanswered.length);
        await ctx.runMutation(internal.kbGapEngine.replaceThemes, {
          accountId,
          themes: themes.map((t) => ({
            theme: t.theme,
            questionCount: t.indexes.length,
            // Verbatim, so a reader can judge the theme rather than
            // trust the label.
            examples: t.indexes.slice(0, 3).map((i) => work.unanswered[i]!),
          })),
        });
      } catch (err) {
        console.error(`[kbgap] clustering failed for ${accountId}:`, err);
      }
    }
  },
});

export const DEFAULTS = DEFAULT_KB_GAP_CONFIG;
