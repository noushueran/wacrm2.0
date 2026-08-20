import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import {
  DEFAULT_REVIVAL_CONFIG,
  WINDOW_MS,
  candidateSkipReason,
  type CandidateInput,
  type RevivalConfig,
} from "./lib/revival/select";
import {
  SYNTHETIC_REVIVAL_RAW,
  buildRevivalPrompt,
  parseRevivalDraft,
} from "./lib/revival/prompt";
import { generateReply } from "./lib/ai/generate";
import { aiJudgeModel, aiJudgeReasoningEffort, promptCacheKey } from "./lib/ai/defaults";
import { blockedReason } from "./lib/notes/gate";

// ============================================================
// Revival agent — the sweep that fills the queue (spec
// docs/superpowers/specs/2026-08-09-revival-agent-design.md).
//
// It DRAFTS. It never sends. Every row it writes waits for a human tap
// in `convex/revival.ts`, which re-checks every guard at that moment.
//
// Dormant-safe like `leadAnalysisEngine`: with no enabled config the
// account has no candidates, so the cron finds nothing and the feature
// costs nothing.
// ============================================================

function isDryRun(): boolean {
  return !!process.env.CONVEX_AI_DRY_RUN;
}

/** How many conversations one sweep may examine. Bounded for the same
 *  reason `lib/cronSummary.ts`'s `SYSTEM_SCAN_WINDOW` is — this runs
 *  every 30 minutes over a table the ingest pipeline writes constantly. */
const CANDIDATE_SCAN = 500;

/** How many stale drafts one reap may retire. Bounded for the same
 *  reason `CANDIDATE_SCAN` is; the sweep runs every 30 minutes, so a
 *  backlog drains over a few runs rather than in one long transaction. */
export const REAP_CAP = 200;

/**
 * How many conversations may be ENRICHED — read fully, at five extra
 * document reads each — in one sweep.
 *
 * The scan above is cheap (one index range). Enrichment is not, and
 * doing it for all `CANDIDATE_SCAN` rows cost ~2,500 operations and blew
 * Convex's per-query limit the moment the fixed turn rule started
 * matching leads (2026-08-09, in production). Everything that can be
 * decided from the conversation row alone is decided BEFORE enriching,
 * and only the survivors are read in full.
 *
 * Generously above `draftsPerRun` (20) so the score sort still has a
 * real field to choose from, but bounded so the cost cannot grow with
 * the size of the account.
 */
const ENRICH_CAP = 60;

interface Candidate extends CandidateInput {
  conversationId: Id<"conversations">;
  contactId: Id<"contacts">;
  contactName: string | null;
  assignedToUserId?: Id<"users">;
  serviceName: string | null;
  profileLines: string[];
}

/**
 * Every account with the agent switched on. Returned as plain ids so the
 * action can fan out without holding a transaction open.
 */
export const enabledAccounts = internalQuery({
  args: {},
  handler: async (ctx): Promise<Id<"accounts">[]> => {
    const configs = await ctx.db.query("revivalConfigs").take(100);
    return configs.filter((c) => c.enabled).map((c) => c.accountId);
  },
});

/**
 * The candidates for one account, already filtered through
 * `candidateSkipReason` and ordered best-lead-first.
 *
 * The field mapping here is deliberately explicit — three of these do
 * not line up with their names in the schema, and getting any of them
 * wrong sends a message to someone who should not receive one:
 *   - `archivedAt` is a timestamp whose PRESENCE means archived.
 *   - `lastMessageAt` is optional; a conversation without one is skipped
 *     outright rather than defaulted to 0, which would read as
 *     infinitely quiet and always qualify.
 *   - do-not-contact lives on the CONTACT, and is read through
 *     `lib/notes/gate`'s `blockedReason` — the same gate
 *     `leadAnalysisEngine` runs on every chase sweep.
 */
export const candidatesForAccount = internalQuery({
  args: { accountId: v.id("accounts") },
  handler: async (ctx, args): Promise<{ config: RevivalConfig; candidates: Candidate[] } | null> => {
    const row = await ctx.db
      .query("revivalConfigs")
      .withIndex("by_account", (q) => q.eq("accountId", args.accountId))
      .first();
    if (!row || !row.enabled) return null;

    const config: RevivalConfig = {
      enabled: row.enabled,
      minQuietMinutes: row.minQuietMinutes,
      windowSafetyMinutes: row.windowSafetyMinutes,
      cooldownHours: row.cooldownHours,
      draftsPerRun: row.draftsPerRun,
      dailyDraftCap: row.dailyDraftCap,
      minLeadScore: row.minLeadScore,
    };

    const now = Date.now();

    // Whether the OTHER chase engine will actually act on a lead it
    // holds. Read once per sweep, not per candidate.
    const qualConfig = await ctx.db
      .query("qualificationConfigs")
      .withIndex("by_account", (q) => q.eq("accountId", args.accountId))
      .first();
    const qualNudgesOn = qualConfig?.outboundNudgesEnabled === true;

    // Genuine index range: `archivedAt: undefined` is bound, not filtered
    // after the fact, so archived threads are never read at all.
    //
    // NEWEST FIRST. The default ascending order would hand back the
    // oldest CANDIDATE_SCAN conversations, and a lead still inside the
    // 24h window is by definition among the newest — so an ascending
    // scan would look straight past every conversation this agent
    // exists to find.
    const conversations = await ctx.db
      .query("conversations")
      .withIndex("by_account_archived_status", (q) =>
        q.eq("accountId", args.accountId).eq("archivedAt", undefined),
      )
      .order("desc")
      .take(CANDIDATE_SCAN);

    // Cheap pass: everything decidable from the conversation row alone,
    // at zero extra reads. This is what keeps the expensive pass bounded.
    const latestUsable = WINDOW_MS - config.windowSafetyMinutes * 60_000;
    const prefiltered = conversations.filter((c) => {
      if (c.lastMessageAt === undefined) return false;
      if (c.archivedAt !== undefined) return false;
      if (c.snoozedUntil !== undefined && c.snoozedUntil > now) return false;
      const quiet = now - c.lastMessageAt;
      return quiet >= config.minQuietMinutes * 60_000 && quiet < latestUsable;
    });

    const out: Candidate[] = [];
    for (const c of prefiltered.slice(0, ENRICH_CAP)) {
      if (c.lastMessageAt === undefined) continue;

      const contact = await ctx.db.get(c.contactId);
      if (!contact) continue;

      // Newest message decides whose turn it is. `lastMessageAt` counts
      // outbound too, so it cannot answer this on its own.
      const newest = await ctx.db
        .query("messages")
        .withIndex("by_conversation", (q) => q.eq("conversationId", c._id))
        .order("desc")
        .first();
      if (!newest) continue;

      const session = await ctx.db
        .query("qualificationSessions")
        .withIndex("by_conversation", (q) => q.eq("conversationId", c._id))
        .first();

      const lastDraft = await ctx.db
        .query("revivalDrafts")
        .withIndex("by_conversation", (q) => q.eq("conversationId", c._id))
        .order("desc")
        .first();

      const analysis = await ctx.db
        .query("leadAnalyses")
        .withIndex("by_conversation", (q) => q.eq("conversationId", c._id))
        .first();

      const input: CandidateInput = {
        lastMessageAt: c.lastMessageAt,
        lastMessageInbound: newest.senderType === "customer",
        snoozedUntil: c.snoozedUntil ?? null,
        doNotContact: blockedReason(contact) !== null,
        // The session status is the ONLY reliable opt-out signal.
        // `conversation.aiAutoreplyDisabled` is NOT one: it is overloaded
        // across three meanings — an agent pausing AI to take the thread
        // over (`conversations.ts`'s `setAiPaused`), a staff-initiated
        // outbound thread (`qualificationEngine.ts` ~1511), and a real
        // opt-out. Gating on it would skip every human-handled lead,
        // which contradicts this agent routing assigned leads to their
        // assignee rather than excluding them.
        optedOut: session?.status === "opted_out",
        archived: c.archivedAt !== undefined,
        qualificationWillNudge:
          session?.status === "collecting" && qualNudgesOn,
        lastDraftAt: lastDraft?.createdAt ?? null,
        // 1–10 per `leadAnalyses.score`, absent until first scored.
        leadScore: analysis?.score ?? null,
      };

      if (candidateSkipReason(input, config, now) !== null) continue;

      const profileLines: string[] = [];
      // Free text on purpose — the qualification extractor returns prose
      // ("mid December", "2 adults + 1 child"), so it goes to the model
      // exactly as captured.
      for (const [k, val] of Object.entries({
        destination: contact.preferredDestination,
        dates: contact.travelDates,
        travellers: contact.travelers,
        budget: contact.budget,
      })) {
        if (typeof val === "string" && val.trim()) profileLines.push(`${k}: ${val}`);
      }

      out.push({
        ...input,
        conversationId: c._id,
        contactId: c.contactId,
        contactName: contact.name ?? null,
        ...(c.assignedToUserId ? { assignedToUserId: c.assignedToUserId } : {}),
        serviceName: session?.serviceName ?? null,
        profileLines,
      });
    }

    // Best leads first, so the caps spend themselves where they matter.
    // An unscored lead sorts last rather than first: it is unproven, not
    // worthless, and should not outrank a lead we know is hot.
    out.sort((a, b) => (b.leadScore ?? -1) - (a.leadScore ?? -1));
    return { config, candidates: out };
  },
});

/** Drafts created since UTC midnight — the daily cap's counter. */
export const draftsToday = internalQuery({
  args: { accountId: v.id("accounts"), cap: v.number() },
  handler: async (ctx, args): Promise<number> => {
    const since = new Date(new Date().toISOString().slice(0, 10)).getTime();
    const rows = await ctx.db
      .query("revivalDrafts")
      .withIndex("by_account_status", (q) => q.eq("accountId", args.accountId))
      .filter((q) => q.gte(q.field("createdAt"), since))
      .take(args.cap + 1);
    return rows.length;
  },
});

export const insertDraft = internalMutation({
  args: {
    accountId: v.id("accounts"),
    conversationId: v.id("conversations"),
    contactId: v.id("contacts"),
    body: v.string(),
    reason: v.string(),
    confidence: v.union(v.literal("high"), v.literal("medium"), v.literal("low")),
    model: v.string(),
    assignedToUserId: v.optional(v.id("users")),
    expiresAt: v.number(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("revivalDrafts", {
      ...args,
      channel: "free_text",
      status: "pending",
      createdAt: Date.now(),
    });
  },
});

/**
 * Retire drafts whose 24-hour window has shut.
 *
 * Without this the queue rots in a way that is worse than untidy. Rows
 * only ever left `pending` by a human tap, `revival.queue` is capped,
 * and the `by_account_status` index reads oldest-first — so dead drafts
 * accumulate at exactly the end the reader sees. Production reached 361
 * pending with 311 past their window, and every one of the 50 sendable
 * drafts sat beyond the cap, unreachable. Nine days, zero sends.
 *
 * Bounded per run and re-entrant: `more` tells the caller a backlog
 * remains, and the next sweep takes the next slice.
 */
export const reapExpired = internalMutation({
  args: { accountId: v.id("accounts") },
  handler: async (ctx, args): Promise<{ reaped: number; more: boolean }> => {
    const rows = await ctx.db
      .query("revivalDrafts")
      .withIndex("by_account_status", (q) =>
        q.eq("accountId", args.accountId).eq("status", "pending"),
      )
      .take(REAP_CAP + 1);

    const now = Date.now();
    // The index reads oldest-first, so the deadest drafts are retired
    // first and a capped run always makes progress at the stale end.
    const expired = rows.filter((row) => row.expiresAt <= now);
    const batch = expired.slice(0, REAP_CAP);

    for (const row of batch) {
      await ctx.db.patch(row._id, { status: "expired" });
    }

    return { reaped: batch.length, more: expired.length > REAP_CAP };
  },
});

/**
 * The 30-minute sweep. Draft, queue, never send.
 *
 * A failure on one lead skips that lead; it never fails the run, because
 * one unparseable model response must not stop every other account's
 * nudges from being drafted.
 */
export const sweep = internalAction({
  args: {},
  handler: async (ctx): Promise<void> => {
    const accountIds = await ctx.runQuery(internal.revivalEngine.enabledAccounts, {});

    for (const accountId of accountIds) {
      // Before anything else, and before any `continue` below: an
      // account with no candidates today still has yesterday's dead
      // drafts to clear out.
      const reaped = await ctx.runMutation(internal.revivalEngine.reapExpired, {
        accountId,
      });
      if (reaped.more) {
        console.log(
          `[revival] account ${accountId}: reaped ${reaped.reaped} expired drafts, more remain`,
        );
      }

      const loaded = await ctx.runQuery(internal.revivalEngine.candidatesForAccount, {
        accountId,
      });
      if (!loaded) continue;
      const { config, candidates } = loaded;
      if (candidates.length === 0) continue;

      const aiConfig = await ctx.runQuery(internal.aiConfig.loadDecrypted, { accountId });
      if (!aiConfig || !aiConfig.isActive) continue;

      const usedToday = await ctx.runQuery(internal.revivalEngine.draftsToday, {
        accountId,
        cap: config.dailyDraftCap,
      });
      const dailyRemaining = Math.max(0, config.dailyDraftCap - usedToday);
      const budget = Math.min(config.draftsPerRun, dailyRemaining);

      if (budget < candidates.length) {
        // Never truncate silently — a capped run must not read as
        // "nobody qualified".
        console.log(
          `[revival] account ${accountId}: ${candidates.length} candidates, drafting ${budget} (perRun ${config.draftsPerRun}, dailyRemaining ${dailyRemaining})`,
        );
      }

      // (provider, configuredModel) — both arguments matter: on a
      // non-OpenAI provider the judge tier IS the configured model.
      const model = aiJudgeModel(aiConfig.provider, aiConfig.model);

      // Read once per account per sweep, not per lead — it cannot change
      // mid-run and re-reading it 20 times would be pure waste.
      const extraInstructions = await ctx.runQuery(
        internal.agentInstructions.forAgent,
        { accountId, agentKey: "revival" },
      );

      for (const candidate of candidates.slice(0, budget)) {
        try {
          const quietHours = Math.round(
            (Date.now() - candidate.lastMessageAt) / 3_600_000,
          );
          const prompt = buildRevivalPrompt({
            contactName: candidate.contactName,
            serviceName: candidate.serviceName,
            profileLines: candidate.profileLines,
            quietHours,
            extraInstructions,
          });

          let raw: string;
          let usage: { promptTokens: number; completionTokens: number; totalTokens: number } | null =
            null;

          if (isDryRun()) {
            raw = SYNTHETIC_REVIVAL_RAW;
          } else {
            const result = await generateReply({
              provider: aiConfig.provider,
              model,
              apiKey: aiConfig.apiKey,
              systemPrompt: prompt,
              messages: [{ role: "user", content: "Write the follow-up." }],
              reasoningEffort: aiJudgeReasoningEffort(),
              promptCacheKey: promptCacheKey(accountId, "revive"),
            });
            raw = result.text;
            usage = result.usage ?? null;
          }

          const parsed = parseRevivalDraft(raw);
          // A model that returned junk costs us this lead, not the run.
          if (!parsed) continue;

          await ctx.runMutation(internal.revivalEngine.insertDraft, {
            accountId,
            conversationId: candidate.conversationId,
            contactId: candidate.contactId,
            body: parsed.body,
            reason: parsed.reason,
            confidence: parsed.confidence,
            model,
            ...(candidate.assignedToUserId
              ? { assignedToUserId: candidate.assignedToUserId }
              : {}),
            // 24h from THEIR last message, not from now — the window is
            // theirs, not the draft's.
            expiresAt: candidate.lastMessageAt + WINDOW_MS,
          });

          if (usage) {
            try {
              await ctx.runMutation(internal.aiUsage.log, {
                accountId,
                conversationId: candidate.conversationId,
                mode: "revive",
                provider: aiConfig.provider,
                model,
                promptTokens: usage.promptTokens,
                completionTokens: usage.completionTokens,
                totalTokens: usage.totalTokens,
              });
            } catch (err) {
              // Usage logging must never cost us a draft already written.
              console.error("[revival] usage log failed:", err);
            }
          }
        } catch (err) {
          console.error(
            `[revival] draft failed for conversation ${candidate.conversationId}:`,
            err,
          );
        }
      }
    }
  },
});

/** Exported for tests and for a future settings UI. */
export const DEFAULTS = DEFAULT_REVIVAL_CONFIG;
