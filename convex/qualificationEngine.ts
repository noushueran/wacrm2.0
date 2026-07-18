import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import {
  loadEnabledConfig,
  isAdminAlertNumber,
  loadStaffPhoneSet,
  isStaffNumber,
  recordInboundActivity,
  ensureSession,
} from "./lib/qualification/track";
import {
  buildAnalysisPrompt,
  parseAnalysis,
  mergeFields,
  countAnswered,
  carryoverFields,
  type AnalysisResult,
} from "./lib/qualification/analyze";
import { aiContextMessageLimit, buildSystemPrompt } from "./lib/ai/defaults";
import { latestUserMessage } from "./lib/ai/query";
import { toChatMessages } from "./lib/ai/context";
import { generateReply } from "./lib/ai/generate";
import { applyStageTransition } from "./funnel";
import {
  clampToWorkingHours,
  computeNextFollowUpAt,
  isSessionExpired,
  withinServiceWindow,
  pickFollowUpText,
} from "./lib/qualification/schedule";
import { insertNotification } from "./notifications";
import { chargeLeadIfAgent } from "./lib/leadCharge";
import { recipientsForInbound } from "./lib/pushRecipients";
import type { AccountRole } from "./lib/roles";
import { normalizePhone } from "./lib/phone";
import { parseStaffReply } from "./lib/qualification/staffReply";
import { allocateContactCode } from "./contacts";
import type { Doc, Id } from "./_generated/dataModel";

// ============================================================
// Qualification engine internals (P0: tracking only — spec §6 of
// docs/superpowers/specs/2026-07-18-lead-qualification-followup-
// design.md). Every entry point is an `internalMutation` with an
// explicit, caller-supplied `accountId` (webhook context — there is no
// user session inside the ingest fan-out), exactly like
// `automationsEngine.runForTrigger` / `flowsEngine.dispatchInbound` /
// `aiReply.dispatchInbound` before it. P1 adds the analysis action;
// P3 adds the follow-up sweep + sender.
// ============================================================

/**
 * Ingest hook: every non-duplicate inbound message counts as customer
 * activity. Upserts the conversation's qualification session and bumps
 * the 24h/72h clocks (which also cancels any pending follow-up).
 * Dormant-safe (no enabled config → no-op) and guarded against the
 * account's own admin-alert numbers so the future lead-alert channel
 * (spec §9) can never qualify itself.
 */
export const onInbound = internalMutation({
  args: {
    accountId: v.id("accounts"),
    conversationId: v.id("conversations"),
    contactId: v.id("contacts"),
    phoneNormalized: v.string(),
  },
  handler: async (ctx, args): Promise<void> => {
    const config = await loadEnabledConfig(ctx, args.accountId);
    if (!config) return; // dormant
    const staff = await loadStaffPhoneSet(ctx, args.accountId, config);
    if (isStaffNumber(staff, args.phoneNormalized)) return; // loop guard (P6: all staff)
    const conversation = await ctx.db.get(args.conversationId);
    if (!conversation || conversation.accountId !== args.accountId) return;
    if (conversation.status === "closed") return;
    const now = Date.now();
    await recordInboundActivity(ctx, {
      accountId: args.accountId,
      conversationId: args.conversationId,
      contactId: args.contactId,
      now,
    });
    // Arm the follow-up clock (spec §6 step 4) — unconditionally while
    // the session is collecting, independent of whether the assistant
    // replies. Any later inbound re-arms; completion/terminal intents
    // clear it. `recordInboundActivity` just cleared the previous value,
    // so this is the single arming point.
    const session = await ctx.db
      .query("qualificationSessions")
      .withIndex("by_conversation", (q) => q.eq("conversationId", args.conversationId))
      .order("desc")
      .first();
    if (session && session.status === "collecting") {
      // Past the nudge cap the ladder returns null — fall back to the
      // expiry revisit so the 72h clock still fires (review fix: without
      // this, a reply AFTER the final nudge orphaned the session in
      // "collecting" forever — the sweep only visits armed rows).
      const at =
        computeNextFollowUpAt(config, session.followUpsSent, now) ??
        now + config.sessionWindowHours * 3_600_000 + 60_000;
      await ctx.db.patch(session._id, { nextFollowUpAt: at });
    }
  },
});

// ============================================================
// P1 — the analysis pass (spec §7). One LLM call per inbound text on
// the account's own BYO key: identify the service, extract answers,
// award marks, detect intent, pre-write the next question. Best-effort
// and PASSIVE: it runs regardless of aiAutoreplyDisabled (a human-led
// chat keeps tracking) but never sends anything and never blocks the
// reply engines. Completion side-effects are P2 — here readiness is
// only STAMPED (`checklistSatisfiedAt`), status stays "collecting".
// ============================================================

function isAiDryRun(): boolean {
  return !!process.env.CONVEX_AI_DRY_RUN;
}

/**
 * DRY-RUN stand-in for the analysis LLM call — deterministic JSON
 * derived from markers in the latest customer message, so tests steer
 * every branch without a network:
 *   `field:key=value;...`  → high-confidence extracted fields
 *   `score:NN`             → score (default 50)
 *   `[[COMPLETE]]`         → checklistSatisfied
 *   `[[STOP]]` / `[[HUMAN]]` / `[[DISQ]]` → intents
 */
export function syntheticAnalysisRaw(latestText: string): string {
  const fields = [...latestText.matchAll(/field:([a-z_]+)=([^;]+)/g)].map(
    (m) => ({ key: m[1], value: m[2].trim(), confidence: "high" as const }),
  );
  const scoreMatch = latestText.match(/score:(\d+)/);
  const intent = latestText.includes("[[STOP]]")
    ? "opt_out"
    : latestText.includes("[[HUMAN]]")
      ? "wants_human"
      : latestText.includes("[[DISQ]]")
        ? "disqualified"
        : "none";
  const checklistSatisfied = latestText.includes("[[COMPLETE]]");
  const newInquiry = latestText.includes("[[NEW]]");
  return JSON.stringify({
    newInquiry,
    service: "UAE visa",
    fields,
    score: scoreMatch ? Number(scoreMatch[1]) : 50,
    scoreBreakdown: fields.map((f) => ({
      criterion: f.key,
      marks: 10,
      maxMarks: 20,
    })),
    checklistSatisfied,
    expectedCount: 4,
    nextQuestion: checklistSatisfied
      ? null
      : {
          key: "travel_dates",
          text: "When are you planning to travel?",
          alternates: ["Rough month works too — when are you thinking?"],
        },
    intent,
    summary: "dry-run analysis",
  });
}

/**
 * Everything the analysis action needs in one read. Null = don't
 * analyse: feature dormant, conversation missing/closed/cross-account,
 * or the session already reached a terminal state.
 */
export const loadAnalysisContext = internalQuery({
  args: {
    accountId: v.id("accounts"),
    conversationId: v.id("conversations"),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    serviceName: string | null;
    knownFields: { key: string; value: string }[];
    basicFields: { key: string; label: string; required: boolean; phrasings: string[] }[];
    previousInquiry?: {
      serviceName: string | null;
      carried: { key: string; value: string }[];
      completedAt: number;
    };
  } | null> => {
    const config = await loadEnabledConfig(ctx, args.accountId);
    if (!config) return null;
    const conversation = await ctx.db.get(args.conversationId);
    if (!conversation || conversation.accountId !== args.accountId) return null;
    if (conversation.status === "closed") return null;
    // Loop guard (spec §9, review fix): the analysis path must skip the
    // admin-alert channel just like `onInbound` does — an admin REPLYING
    // to a lead alert must never trigger paid analysis, let alone a
    // session (the alert text itself contains qualifying answers, so
    // the model could "qualify" the staff thread and echo fresh alerts).
    const contact = await ctx.db.get(conversation.contactId);
    if (contact) {
      const staff = await loadStaffPhoneSet(ctx, args.accountId, config);
      if (isStaffNumber(staff, contact.phoneNormalized)) return null;
    }
    // v3 multi-lead: the LATEST session is the live one; older terminal
    // rows are history. A terminal latest no longer bails — the analysis
    // decides whether this message starts a NEW inquiry.
    const session = await ctx.db
      .query("qualificationSessions")
      .withIndex("by_conversation", (q) => q.eq("conversationId", args.conversationId))
      .order("desc")
      .first();
    if (session && session.status !== "collecting") {
      return {
        serviceName: null,
        knownFields: [],
        basicFields: config.basicFields,
        previousInquiry: {
          serviceName: session.serviceName ?? null,
          carried: carryoverFields(session.fields, Date.now()).map((f) => ({
            key: f.key,
            value: f.value,
          })),
          // Transcript boundary (v4): the analysis must only see
          // messages AFTER the previous inquiry finished, so history
          // can never be re-extracted into a duplicate lead.
          completedAt:
            session.qualifiedAt ??
            session.lastCustomerMessageAt ??
            session._creationTime,
        },
      };
    }
    return {
      serviceName: session?.serviceName ?? null,
      knownFields: (session?.fields ?? []).map((f) => ({ key: f.key, value: f.value })),
      basicFields: config.basicFields,
      previousInquiry: undefined,
    };
  },
});

const analysisValidator = v.object({
  serviceName: v.union(v.string(), v.null()),
  fields: v.array(
    v.object({
      key: v.string(),
      label: v.optional(v.string()),
      value: v.string(),
      confidence: v.union(v.literal("high"), v.literal("medium"), v.literal("low")),
    }),
  ),
  score: v.number(),
  scoreBreakdown: v.array(
    v.object({
      criterion: v.string(),
      marks: v.number(),
      maxMarks: v.number(),
      reason: v.optional(v.string()),
    }),
  ),
  checklistSatisfied: v.boolean(),
  expectedCount: v.number(),
  nextQuestion: v.union(
    v.null(),
    v.object({ key: v.string(), text: v.string(), alternates: v.array(v.string()) }),
  ),
  intent: v.union(
    v.literal("none"),
    v.literal("opt_out"),
    v.literal("wants_human"),
    v.literal("disqualified"),
  ),
  summary: v.union(v.string(), v.null()),
  newInquiry: v.boolean(),
});

/**
 * Applies one parsed analysis to the session in a single transaction.
 * Ensures the session exists (analysis may race/precede `onInbound`
 * when the feature was just enabled), re-checks it is still
 * `collecting`, merges fields (high/medium overwrite, low fills
 * blanks), and stamps readiness per spec §7's gate:
 * checklistSatisfied AND score >= threshold AND >= 3 answers.
 * Intents: opt_out/disqualified close the session here (opt-out also
 * silences the bot entirely); wants_human is returned to the action,
 * which routes through `aiReply.flagForHuman` (surface, never silence).
 */
export const applyAnalysis = internalMutation({
  args: {
    accountId: v.id("accounts"),
    conversationId: v.id("conversations"),
    contactId: v.id("contacts"),
    analysis: analysisValidator,
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ wantsHuman: boolean; readyToComplete: boolean }> => {
    const none = { wantsHuman: false, readyToComplete: false };
    const config = await loadEnabledConfig(ctx, args.accountId);
    if (!config) return none;
    // Belt-and-braces admin-channel guard (loadAnalysisContext already
    // filters, but this mutation creates sessions and is independently
    // callable — it must never open one on the alert channel).
    const guardContact = await ctx.db.get(args.contactId);
    if (guardContact) {
      const staff = await loadStaffPhoneSet(ctx, args.accountId, config);
      if (isStaffNumber(staff, guardContact.phoneNormalized)) return none;
    }
    const now = Date.now();
    const analysis = args.analysis as AnalysisResult;

    // v3 multi-lead: work on the LATEST session. A terminal latest only
    // yields a fresh lead when the analysis says the customer started a
    // NEW request — post-completion chit-chat never reopens anything.
    const latest = await ctx.db
      .query("qualificationSessions")
      .withIndex("by_conversation", (q) => q.eq("conversationId", args.conversationId))
      .order("desc")
      .first();
    let session: Doc<"qualificationSessions"> | null = null;
    if (!latest) {
      const sessionId = await ensureSession(ctx, {
        accountId: args.accountId,
        conversationId: args.conversationId,
        contactId: args.contactId,
        origin: "inbound",
        now,
      });
      session = await ctx.db.get(sessionId);
    } else if (latest.status === "collecting") {
      session = latest;
    } else {
      // v4 duplicate-lead guards (deterministic — never trust the model
      // alone here; the Italy-duplicate incident): a new lead requires
      //   1. the model's newInquiry verdict,
      //   2. an identified service,
      //   3. fresh evidence (at least one extracted field),
      //   4. NOT the same service the previous session just finished —
      //      same-service re-booking is only accepted after 48h.
      if (!analysis.newInquiry) return none;
      if (!analysis.serviceName) return none;
      if (analysis.fields.length === 0) return none;
      const closedBoundary =
        latest.qualifiedAt ?? latest.lastCustomerMessageAt ?? latest._creationTime;
      const sameService =
        !!latest.serviceName &&
        analysis.serviceName.trim().toLowerCase() ===
          latest.serviceName.trim().toLowerCase();
      if (sameService && now - closedBoundary < 48 * 3_600_000) return none;
      // Fresh lead for the same contact: profile facts carry over at
      // medium confidence (marked `carried`) so the assistant verifies
      // them casually instead of re-collecting; trip-specific details
      // start blank.
      const carried = carryoverFields(latest.fields, now);
      const sessionId = await ctx.db.insert("qualificationSessions", {
        accountId: args.accountId,
        conversationId: args.conversationId,
        contactId: args.contactId,
        status: "collecting",
        origin: "inbound",
        fields: carried,
        expectedCount: Math.max(analysis.expectedCount, 1),
        answeredCount: countAnswered(carried),
        lastCustomerMessageAt: now,
        followUpsSent: 0,
        phrasingCursor: 0,
        sendAttemptErrors: 0,
      });
      session = await ctx.db.get(sessionId);
    }
    if (!session || session.status !== "collecting") return none;
    const sessionId = session._id;
    const merged = mergeFields(session.fields, analysis.fields, now);
    const answeredCount = countAnswered(merged);
    const expectedCount = Math.max(analysis.expectedCount, answeredCount, 1);

    const ready =
      analysis.checklistSatisfied &&
      analysis.score >= config.qualifyThresholdScore &&
      answeredCount >= 3;

    const patch: Record<string, unknown> = {
      fields: merged,
      answeredCount,
      expectedCount,
      score: analysis.score,
      scoreBreakdown: analysis.scoreBreakdown,
    };
    if (analysis.serviceName) patch.serviceName = analysis.serviceName;
    if (analysis.summary) patch.summary = analysis.summary;
    if (analysis.nextQuestion) {
      patch.pendingQuestion = analysis.nextQuestion;
    } else if (analysis.checklistSatisfied) {
      patch.pendingQuestion = undefined; // nothing left to ask
    } // null + unsatisfied → keep the prior question for follow-ups
    if (ready && !session.checklistSatisfiedAt) patch.checklistSatisfiedAt = now;

    if (analysis.intent === "opt_out") {
      patch.status = "opted_out";
      patch.closedReason = "opted_out";
      patch.nextFollowUpAt = undefined;
      await ctx.db.patch(args.conversationId, {
        aiAutoreplyDisabled: true,
        updatedAt: now,
      });
    } else if (analysis.intent === "disqualified") {
      patch.status = "disqualified";
      patch.closedReason = "disqualified";
      patch.nextFollowUpAt = undefined;
    }

    await ctx.db.patch(sessionId, patch);
    // A terminal intent (opt-out / disqualified) always wins over
    // readiness — the customer told us to stop. `wants_human` readiness
    // still completes: completion's own handoff covers the human ask.
    const terminal = analysis.intent === "opt_out" || analysis.intent === "disqualified";
    return {
      wantsHuman: analysis.intent === "wants_human",
      readyToComplete: ready && !terminal,
    };
  },
});

/**
 * The analysis action — orchestrates read → LLM → apply, exactly the
 * `aiTagging.classify` shape (same dry-run gate, same best-effort usage
 * log, same never-throw discipline as `aiReply.dispatchInbound`).
 */
export const analyzeInbound = internalAction({
  args: {
    accountId: v.id("accounts"),
    conversationId: v.id("conversations"),
    contactId: v.id("contacts"),
  },
  handler: async (ctx, args): Promise<void> => {
    try {
      const context = await ctx.runQuery(
        internal.qualificationEngine.loadAnalysisContext,
        { accountId: args.accountId, conversationId: args.conversationId },
      );
      if (!context) return;

      const aiCfg = await ctx.runQuery(internal.aiConfig.loadDecrypted, {
        accountId: args.accountId,
      });
      // Extraction needs a key (`isActive`) but NOT `autoReplyEnabled` —
      // tracking works even when the assistant itself is off (spec §7).
      if (!aiCfg || !aiCfg.isActive) return;

      let historyRows = await ctx.runQuery(internal.aiReply.recentMessages, {
        accountId: args.accountId,
        conversationId: args.conversationId,
        limit: aiContextMessageLimit(),
      });
      // Transcript boundary (v4 duplicate-lead fix): once the previous
      // inquiry finished, only messages AFTER it may feed the analysis —
      // otherwise the model re-extracts the finished inquiry from
      // history and mints duplicate leads on every "thanks"/"hello".
      const boundary = context.previousInquiry?.completedAt;
      if (boundary) {
        historyRows = historyRows.filter(
          (r) => (r as { createdAt?: number }).createdAt === undefined ||
            (r as { createdAt?: number }).createdAt! > boundary,
        );
      }
      const messages = toChatMessages(historyRows);
      if (messages.length === 0) return;
      const latest = latestUserMessage(messages);

      // Pull the service's QUALIFICATION CHECKLIST from the knowledge
      // base (spec §4) — best-effort; without it the prompt falls back
      // to the config's basic fields.
      let checklistExcerpts: string[] = [];
      const hasKb = await ctx.runQuery(internal.aiReply.hasKnowledgeChunks, {
        accountId: args.accountId,
      });
      if (hasKb) {
        checklistExcerpts = await ctx.runAction(internal.aiKnowledge.retrieve, {
          accountId: args.accountId,
          queryText: `QUALIFICATION CHECKLIST ${context.serviceName ?? ""} ${latest}`.trim(),
        });
      }

      const systemPrompt = buildAnalysisPrompt({
        checklistExcerpts,
        basicFields: context.basicFields,
        knownFields: context.knownFields,
        previousInquiry: context.previousInquiry,
      });

      let raw: string;
      if (isAiDryRun()) {
        raw = syntheticAnalysisRaw(latest);
      } else {
        const gen = await generateReply({
          provider: aiCfg.provider,
          model: aiCfg.model,
          apiKey: aiCfg.apiKey,
          systemPrompt,
          messages,
        });
        raw = gen.text;
        try {
          await ctx.runMutation(internal.aiUsage.log, {
            accountId: args.accountId,
            conversationId: args.conversationId,
            mode: "qualify",
            provider: aiCfg.provider,
            model: aiCfg.model,
            promptTokens: gen.usage?.promptTokens ?? 0,
            completionTokens: gen.usage?.completionTokens ?? 0,
            totalTokens: gen.usage?.totalTokens ?? 0,
          });
        } catch (err) {
          console.warn("[qualification analysis] usage log failed:", err);
        }
      }

      const analysis = parseAnalysis(raw);
      if (!analysis) return; // malformed model output — next inbound retries

      const { wantsHuman, readyToComplete } = await ctx.runMutation(
        internal.qualificationEngine.applyAnalysis,
        {
          accountId: args.accountId,
          conversationId: args.conversationId,
          contactId: args.contactId,
          analysis,
        },
      );

      if (readyToComplete) {
        // Completion includes its own handoff, so the wants_human path
        // below is intentionally skipped when both apply (spec §9).
        await ctx.runMutation(internal.qualificationEngine.completeQualification, {
          accountId: args.accountId,
          conversationId: args.conversationId,
        });
      } else if (wantsHuman) {
        // Surface it for the team (pending + summary) — the bot keeps
        // replying and reassuring; takeover is a manual dashboard
        // action only (owner decision 2026-07-18).
        await ctx.runMutation(internal.aiReply.flagForHuman, {
          accountId: args.accountId,
          conversationId: args.conversationId,
          summary:
            "🤖 Customer asked for a human during qualification." +
            (analysis.summary ? ` ${analysis.summary}` : ""),
        });
      }
    } catch (err) {
      console.error("[qualification analysis] failed:", err);
    }
  },
});

/**
 * Steering input for the assistant (spec §7): what's collected (never
 * re-ask) and the ONE next question. Null when the feature is dormant
 * or the session isn't collecting — `aiReply.dispatchInbound` then
 * builds its prompt exactly as before this feature existed.
 * `nextQuestion` prefers the analysis pass's `pendingQuestion`; before
 * the first analysis lands it falls back to the first unanswered
 * required basic field's first phrasing, so the assistant steers
 * usefully from the very first reply.
 */
export const getObjectives = internalQuery({
  args: {
    accountId: v.id("accounts"),
    conversationId: v.id("conversations"),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    collected: { label: string; value: string }[];
    nextQuestion: string | null;
    suppressReply?: boolean;
  } | null> => {
    const config = await loadEnabledConfig(ctx, args.accountId);
    if (!config) return null;
    const session = await ctx.db
      .query("qualificationSessions")
      .withIndex("by_conversation", (q) => q.eq("conversationId", args.conversationId))
      .order("desc")
      .first();
    if (!session || session.accountId !== args.accountId) return null;
    // v4: a fresh completion (< 90s) suppresses the assistant's regular
    // reply entirely — the closing message IS the reply for that turn
    // (previously the customer got closing message + a second AI reply
    // that could even re-ask an already-given detail).
    if (
      session.status === "qualified" &&
      session.qualifiedAt &&
      Date.now() - session.qualifiedAt < 90_000
    ) {
      return { collected: [], nextQuestion: null, suppressReply: true };
    }

    const collected = session.fields
      .filter((f) => f.confidence !== "low")
      .map((f) => ({
        label:
          (f.label ?? f.key) +
          (f.carried ? " (from a previous inquiry — reconfirm casually once)" : ""),
        value: f.value,
      }));

    // Only a live (collecting) session still has something to ask; a
    // finished one contributes its collected list ONLY (v4: so the
    // assistant never re-asks answered details after completion).
    let nextQuestion: string | null = null;
    if (session.status === "collecting") {
      nextQuestion = session.pendingQuestion?.text ?? null;
      if (!nextQuestion) {
        const answered = new Set(
          session.fields.filter((f) => f.confidence !== "low").map((f) => f.key),
        );
        const missing = config.basicFields.find(
          (f) => f.required && !answered.has(f.key),
        );
        nextQuestion = missing?.phrasings[0] ?? null;
      }
    }

    return { collected, nextQuestion };
  },
});

// ============================================================
// P2 — completion pipeline (spec §9). ALL db effects happen in ONE
// mutation (compare-and-set → funnel/Meta → handoff → notifications);
// the outward sends (closing message, admin WhatsApp alert, web push)
// are scheduled actions so a network failure can never roll back the
// qualified state.
// ============================================================

export const completeQualification = internalMutation({
  args: {
    accountId: v.id("accounts"),
    conversationId: v.id("conversations"),
  },
  handler: async (ctx, args): Promise<void> => {
    const config = await loadEnabledConfig(ctx, args.accountId);
    if (!config) return;
    const session = await ctx.db
      .query("qualificationSessions")
      .withIndex("by_conversation", (q) => q.eq("conversationId", args.conversationId))
      .order("desc")
      .first();
    if (!session || session.accountId !== args.accountId) return;
    // Compare-and-set: only a collecting session that reached readiness
    // completes; Convex OCC serializes concurrent inbounds, so a second
    // completion attempt sees "qualified" and returns (idempotent).
    if (session.status !== "collecting" || !session.checklistSatisfiedAt) return;
    const conversation = await ctx.db.get(args.conversationId);
    if (!conversation || conversation.accountId !== args.accountId) return;
    const now = Date.now();

    await ctx.db.patch(session._id, {
      status: "qualified",
      qualifiedAt: now,
      nextFollowUpAt: undefined,
      pendingQuestion: undefined,
    });

    // Funnel → qualified (auto). Seeds the deduped conversionEvents row
    // + schedules the live dispatcher — THE Meta signal (ad lane
    // "QualifiedLead" CAPI event, website lane Platform A pixel; organic
    // = CRM-only). Never downgrades a human-advanced stage.
    const account = await ctx.db.get(args.accountId);
    await applyStageTransition(ctx, {
      accountId: args.accountId,
      conversation,
      stage: "qualified",
      auto: true,
      neverDowngrade: true,
      defaultCurrency: account?.defaultCurrency ?? "USD",
    });

    // v3: the assistant KEEPS the conversation after qualification — no
    // aiAutoreplyDisabled, no auto-assignment, no charge here. The bot
    // only stands down when a human actually takes over (assign /
    // pause — the existing dispatch guards), and the lead charge fires
    // through those existing assignment paths at that moment. The
    // conversation still surfaces to the team: status → "pending" (the
    // needs-attention queue), the summary lands on the thread, and the
    // notifications/push/alerts below all fire.
    const answers = session.fields
      .filter((f) => f.confidence !== "low")
      .map((f) => `${f.label ?? f.key}: ${f.value}`)
      .join(" · ");
    const summary =
      `🎯 Qualified lead (score ${session.score ?? "–"}/100)` +
      (session.serviceName ? ` — ${session.serviceName}` : "") +
      (session.summary ? `: ${session.summary}` : "") +
      (answers ? `. ${answers}` : "");
    await ctx.db.patch(args.conversationId, {
      status: "pending",
      aiHandoffSummary: summary,
      updatedAt: now,
    });

    // Mandatory auto-tag (v4): the contact carries a tag per qualified
    // service — one lead per tag, multiple leads stack multiple tags.
    // Best-effort: a tagging hiccup never fails completion.
    if (session.serviceName) {
      try {
        await tagContactForService(ctx, {
          accountId: args.accountId,
          contactId: session.contactId,
          serviceName: session.serviceName,
        });
      } catch (err) {
        console.error("[qualification] auto-tag failed:", err);
      }
    }

    // In-app bell notifications: the assignee if any, else everyone who
    // works the shared pool (supervisor+ — same rule as inbound push).
    const members = await ctx.db
      .query("memberships")
      .withIndex("by_account", (q) => q.eq("accountId", args.accountId))
      .collect();
    const recipients = recipientsForInbound({
      assignedToUserId: conversation.assignedToUserId ?? null,
      members: members.map((m) => ({ userId: m.userId, role: m.role as AccountRole })),
    });
    const body =
      (session.serviceName ?? "New lead") +
      (session.score !== undefined ? ` · score ${session.score}/100` : "") +
      (session.summary ? ` — ${session.summary}` : "");
    for (const userId of recipients) {
      await insertNotification(ctx, {
        accountId: args.accountId,
        userId,
        type: "lead_qualified",
        conversationId: args.conversationId,
        contactId: session.contactId,
        title: "New qualified lead",
        body,
      });
    }

    // Outward sends — scheduled so they can't roll back the state above.
    await ctx.scheduler.runAfter(0, internal.qualificationEngine.sendClosingMessage, {
      accountId: args.accountId,
      conversationId: args.conversationId,
    });
    await ctx.scheduler.runAfter(0, internal.qualificationEngine.sendAdminAlerts, {
      accountId: args.accountId,
      sessionId: session._id,
    });
    await ctx.scheduler.runAfter(0, internal.pushSend.deliverForQualifiedLead, {
      accountId: args.accountId,
      conversationId: args.conversationId,
    });
    // P6: consent-based auto-assignment — offer the lead to a matching
    // agent over WhatsApp (no-ops when disabled, already assigned, or
    // nobody routes for this service).
    if (config.autoAssignEnabled !== false && !conversation.assignedToUserId) {
      await ctx.scheduler.runAfter(0, internal.qualificationEngine.startLeadOffer, {
        accountId: args.accountId,
        sessionId: session._id,
      });
    }
  },
});

/** Read side for `sendClosingMessage`: null unless the session really is
 *  qualified and the feature is still enabled. */
export const closingContext = internalQuery({
  args: { accountId: v.id("accounts"), conversationId: v.id("conversations") },
  handler: async (
    ctx,
    args,
  ): Promise<{ to: string; text: string } | null> => {
    const config = await loadEnabledConfig(ctx, args.accountId);
    if (!config || !config.closingMessage.trim()) return null;
    const rows = await ctx.db
      .query("qualificationSessions")
      .withIndex("by_conversation", (q) => q.eq("conversationId", args.conversationId))
      .order("desc")
      .collect();
    const session = rows.find(
      (s) => s.accountId === args.accountId && s.status === "qualified",
    );
    if (!session) return null;
    const conversation = await ctx.db.get(args.conversationId);
    if (!conversation || conversation.accountId !== args.accountId) return null;
    const contact = await ctx.db.get(conversation.contactId);
    if (!contact) return null;
    return { to: contact.phone, text: config.closingMessage };
  },
});

/** "Thank you! Our travel expert will contact you shortly." — always
 *  inside the 24h window (qualification happens right after an inbound),
 *  so a plain free-form send. Best-effort. */
export const sendClosingMessage = internalAction({
  args: { accountId: v.id("accounts"), conversationId: v.id("conversations") },
  handler: async (ctx, args): Promise<void> => {
    try {
      const context = await ctx.runQuery(internal.qualificationEngine.closingContext, args);
      if (!context) return;
      await ctx.runAction(internal.metaSend.sendText, {
        accountId: args.accountId,
        conversationId: args.conversationId,
        to: context.to,
        text: context.text,
      });
    } catch (err) {
      console.error("[qualification] closing message failed:", err);
    }
  },
});

/** Read side for `sendAdminAlerts`. */
export const adminAlertContext = internalQuery({
  args: { accountId: v.id("accounts"), sessionId: v.id("qualificationSessions") },
  handler: async (ctx, args) => {
    const config = await loadEnabledConfig(ctx, args.accountId);
    if (!config || !config.adminAlertEnabled || config.adminAlertPhones.length === 0) {
      return null;
    }
    const session = await ctx.db.get(args.sessionId);
    if (!session || session.accountId !== args.accountId) return null;
    if (session.status !== "qualified") return null;
    const contact = await ctx.db.get(session.contactId);
    if (!contact) return null;
    const answers = session.fields
      .filter((f) => f.confidence !== "low")
      .map((f) => `${f.label ?? f.key}: ${f.value}`)
      .join(", ");
    return {
      phones: config.adminAlertPhones,
      templateName: config.adminAlertTemplateName ?? null,
      templateLanguage: config.adminAlertTemplateLanguage ?? null,
      contactName: contact.name?.trim() || contact.phone,
      contactPhone: contact.phone,
      service: session.serviceName ?? "New inquiry",
      summary: session.summary ?? answers ?? "",
      score: session.score ?? 0,
    };
  },
});

/**
 * Upserts the internal alert contact ("Lead alerts (staff)") + its
 * conversation, silenced (`aiAutoreplyDisabled`) so the assistant never
 * talks to its own alert channel. The P0 tracking hooks additionally
 * skip these numbers entirely (spec §9 loop guards).
 */
export const ensureAdminConversation = internalMutation({
  args: { accountId: v.id("accounts"), phone: v.string() },
  handler: async (
    ctx,
    args,
  ): Promise<{ conversationId: Id<"conversations">; to: string }> => {
    const phoneNormalized = normalizePhone(args.phone);
    let contact = await ctx.db
      .query("contacts")
      .withIndex("by_account_phone", (q) =>
        q.eq("accountId", args.accountId).eq("phoneNormalized", phoneNormalized),
      )
      .unique();
    if (!contact) {
      // Every contact insert path allocates a sequential HC- code — this
      // one included (review fix; see contacts.ts's allocator comment).
      const contactCode = await allocateContactCode(ctx.db, args.accountId);
      const contactId = await ctx.db.insert("contacts", {
        accountId: args.accountId,
        phone: args.phone,
        phoneNormalized,
        name: "Lead alerts (staff)",
        contactCode,
      });
      contact = (await ctx.db.get(contactId))!;
    }
    const existing = await ctx.db
      .query("conversations")
      .withIndex("by_contact", (q) => q.eq("contactId", contact._id))
      .first();
    if (existing && existing.accountId === args.accountId) {
      if (!existing.aiAutoreplyDisabled) {
        await ctx.db.patch(existing._id, { aiAutoreplyDisabled: true });
      }
      return { conversationId: existing._id, to: contact.phone };
    }
    const conversationId = await ctx.db.insert("conversations", {
      accountId: args.accountId,
      contactId: contact._id,
      status: "open",
      unreadCount: 0,
      aiAutoreplyDisabled: true,
    });
    return { conversationId, to: contact.phone };
  },
});

/**
 * The admin WhatsApp lead alert (spec §9 step 5). Template-first (a
 * UTILITY template delivers regardless of any 24h window); free-form
 * fallback when no template is configured (works only while the admin's
 * own chat window is open — surfaced as a Settings warning). Per-number
 * best-effort: one failing number never blocks the others.
 */
export const sendAdminAlerts = internalAction({
  args: { accountId: v.id("accounts"), sessionId: v.id("qualificationSessions") },
  handler: async (ctx, args): Promise<void> => {
    try {
      const data = await ctx.runQuery(internal.qualificationEngine.adminAlertContext, args);
      if (!data) return;
      const text =
        `New qualified lead: ${data.contactName} (${data.contactPhone}) — ` +
        `${data.service}: ${data.summary}. Score ${data.score}/100. ` +
        "Open the CRM to claim.";
      for (const phone of data.phones) {
        try {
          const target = await ctx.runMutation(
            internal.qualificationEngine.ensureAdminConversation,
            { accountId: args.accountId, phone },
          );
          if (data.templateName) {
            await ctx.runAction(internal.metaSend.sendTemplate, {
              accountId: args.accountId,
              conversationId: target.conversationId,
              to: target.to,
              templateName: data.templateName,
              language: data.templateLanguage ?? undefined,
              params: [
                data.contactName,
                data.contactPhone,
                `${data.service}: ${data.summary}`,
                String(data.score),
              ],
              contentText: text,
            });
          } else {
            await ctx.runAction(internal.metaSend.sendText, {
              accountId: args.accountId,
              conversationId: target.conversationId,
              to: target.to,
              text,
            });
          }
        } catch (err) {
          console.error("[qualification] admin alert failed:", err);
        }
      }
    } catch (err) {
      console.error("[qualification] admin alerts failed:", err);
    }
  },
});

// ============================================================
// P3 — the follow-up engine (spec §8). A 5-minute cron sweeps due
// sessions (`by_due`, bounded — the retryConversionEvents shape) and
// fans each out to `sendFollowUp`, which re-checks EVERY guard at send
// time, then sends free-form (inside the 24h window, rotating the
// pre-written phrasings) or the approved re-engagement template
// (outside it). All state changes go through small mutations so a
// mid-flight crash never double-sends.
// ============================================================

export const getDueSessions = internalQuery({
  args: {},
  handler: async (ctx): Promise<Doc<"qualificationSessions">[]> => {
    const now = Date.now();
    return await ctx.db
      .query("qualificationSessions")
      .withIndex("by_due", (q) =>
        q.eq("status", "collecting").gt("nextFollowUpAt", 0).lte("nextFollowUpAt", now),
      )
      .take(100);
  },
});

export const sweepFollowUps = internalAction({
  args: {},
  handler: async (ctx): Promise<void> => {
    const due = await ctx.runQuery(internal.qualificationEngine.getDueSessions, {});
    for (const session of due) {
      await ctx.scheduler.runAfter(0, internal.qualificationEngine.sendFollowUp, {
        sessionId: session._id,
      });
    }
  },
});

type FollowUpVerdict =
  | { kind: "skip" }
  | { kind: "clear" }
  | { kind: "expire"; reason: string }
  | { kind: "reschedule"; at: number }
  | { kind: "sendText"; to: string; text: string; nextCursor: number }
  | {
      kind: "sendTemplate";
      to: string;
      templateName: string;
      language: string | null;
      params: string[];
      contentText: string;
    };

/**
 * The guard chain (spec §8), evaluated at SEND time — arming happened
 * minutes-to-hours earlier and anything may have changed since. Order
 * matters: expiry always wins (the 3-day rule applies even to threads a
 * human paused), then human-owned threads yield until the expiry check
 * (extraction may still qualify them), then hours, then the 24h window
 * picks the channel.
 */
export const followUpContext = internalQuery({
  args: { sessionId: v.id("qualificationSessions") },
  handler: async (ctx, args): Promise<FollowUpVerdict> => {
    const session = await ctx.db.get(args.sessionId);
    if (!session || session.status !== "collecting") return { kind: "skip" };
    const config = await loadEnabledConfig(ctx, session.accountId);
    if (!config) return { kind: "clear" };
    const now = Date.now();
    if (!session.nextFollowUpAt || session.nextFollowUpAt > now) return { kind: "skip" };
    // Outbound-origin sessions with no reply yet have no service window
    // at all — passive by design (spec §8; outboundNudgesEnabled is a
    // future lever). Defensive: arming only happens on inbound.
    if (!session.lastCustomerMessageAt) return { kind: "clear" };

    if (isSessionExpired(session.lastCustomerMessageAt, now, config.sessionWindowHours)) {
      return { kind: "expire", reason: "no_response" };
    }
    const conversation = await ctx.db.get(session.conversationId);
    if (!conversation || conversation.accountId !== session.accountId) {
      return { kind: "clear" };
    }
    if (conversation.status === "closed") {
      return { kind: "expire", reason: "conversation_closed" };
    }
    // One more visit right after expiry so the sweep can close the file.
    const expiryRevisit =
      session.lastCustomerMessageAt + config.sessionWindowHours * 3_600_000 + 60_000;
    if (conversation.aiAutoreplyDisabled) return { kind: "reschedule", at: expiryRevisit };
    if (
      session.humanTouchedAt &&
      session.humanTouchedAt > session.lastCustomerMessageAt
    ) {
      return { kind: "reschedule", at: expiryRevisit };
    }
    if (session.followUpsSent >= config.maxFollowUps) {
      return { kind: "reschedule", at: expiryRevisit };
    }
    const clamped = clampToWorkingHours(now, config);
    if (clamped > now) return { kind: "reschedule", at: clamped };

    const contact = await ctx.db.get(session.contactId);
    if (!contact) return { kind: "clear" };

    if (withinServiceWindow(session.lastCustomerMessageAt, now)) {
      const picked = pickFollowUpText(session, config);
      return {
        kind: "sendText",
        to: contact.phone,
        text: picked.text,
        nextCursor: picked.nextCursor,
      };
    }
    if (config.reengagementTemplateName) {
      const name = contact.name?.trim() || "there";
      return {
        kind: "sendTemplate",
        to: contact.phone,
        templateName: config.reengagementTemplateName,
        language: config.reengagementTemplateLanguage ?? null,
        params: [name],
        contentText:
          `Hi ${name}! We're still here to prepare your travel options — ` +
          "reply and we'll pick up right where we left off.",
      };
    }
    // Window closed and no approved template: nothing compliant to send.
    // Wait out the 72h clock (surfaced as a Settings warning).
    return { kind: "reschedule", at: expiryRevisit };
  },
});

export const markSessionExpired = internalMutation({
  args: { sessionId: v.id("qualificationSessions"), reason: v.string() },
  handler: async (ctx, args): Promise<void> => {
    const session = await ctx.db.get(args.sessionId);
    if (!session || session.status !== "collecting") return;
    await ctx.db.patch(args.sessionId, {
      status: "expired",
      closedReason: args.reason,
      nextFollowUpAt: undefined,
    });
  },
});

export const setNextFollowUpAt = internalMutation({
  args: {
    sessionId: v.id("qualificationSessions"),
    at: v.union(v.number(), v.null()),
  },
  handler: async (ctx, args): Promise<void> => {
    const session = await ctx.db.get(args.sessionId);
    if (!session || session.status !== "collecting") return;
    await ctx.db.patch(args.sessionId, {
      nextFollowUpAt: args.at === null ? undefined : args.at,
    });
  },
});

/**
 * CLAIMS the slot BEFORE the send (review fix — the codebase's
 * `aiReply.claimReplySlot` pattern): advances the attempt count, the
 * phrasing rotation, and the next rung of the ladder (or the expiry
 * revisit once the ladder/cap is exhausted) in one OCC-serialized
 * mutation. Returns false when the slot is no longer claimable (state
 * changed, or a concurrent sender already claimed it — its patch moved
 * `nextFollowUpAt` into the future), so a duplicate follow-up can never
 * reach the customer. The tradeoff is at-most-once: a transient Meta
 * failure after a claim costs that one nudge (the next rung is already
 * booked) rather than ever risking a double text.
 */
export const claimFollowUpSlot = internalMutation({
  args: {
    sessionId: v.id("qualificationSessions"),
    nextCursor: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<boolean> => {
    const session = await ctx.db.get(args.sessionId);
    if (!session || session.status !== "collecting") return false;
    const now = Date.now();
    if (!session.nextFollowUpAt || session.nextFollowUpAt > now) return false;
    const config = await loadEnabledConfig(ctx, session.accountId);
    if (!config) return false;
    const sent = session.followUpsSent + 1;
    let next = computeNextFollowUpAt(config, sent, now);
    if (next === null && session.lastCustomerMessageAt) {
      next = session.lastCustomerMessageAt + config.sessionWindowHours * 3_600_000 + 60_000;
    }
    await ctx.db.patch(args.sessionId, {
      followUpsSent: sent,
      sendAttemptErrors: 0,
      ...(args.nextCursor !== undefined ? { phrasingCursor: args.nextCursor } : {}),
      nextFollowUpAt: next ?? undefined,
    });
    return true;
  },
});

export const sendFollowUp = internalAction({
  args: { sessionId: v.id("qualificationSessions") },
  handler: async (ctx, args): Promise<void> => {
    try {
      const verdict = await ctx.runQuery(internal.qualificationEngine.followUpContext, {
        sessionId: args.sessionId,
      });
      const session = { sessionId: args.sessionId };
      switch (verdict.kind) {
        case "skip":
          return;
        case "clear":
          await ctx.runMutation(internal.qualificationEngine.setNextFollowUpAt, {
            ...session,
            at: null,
          });
          return;
        case "expire":
          await ctx.runMutation(internal.qualificationEngine.markSessionExpired, {
            ...session,
            reason: verdict.reason,
          });
          return;
        case "reschedule":
          await ctx.runMutation(internal.qualificationEngine.setNextFollowUpAt, {
            ...session,
            at: verdict.at,
          });
          return;
        case "sendText":
        case "sendTemplate": {
          const meta = await ctx.runQuery(internal.qualificationEngine.sendTarget, {
            sessionId: args.sessionId,
          });
          if (!meta) return;
          // Claim BEFORE the send (see claimFollowUpSlot): losing the
          // claim means another sender (or a state change) got here
          // first — never send twice.
          const claimed = await ctx.runMutation(
            internal.qualificationEngine.claimFollowUpSlot,
            verdict.kind === "sendText"
              ? { ...session, nextCursor: verdict.nextCursor }
              : session,
          );
          if (!claimed) return;
          try {
            if (verdict.kind === "sendText") {
              await ctx.runAction(internal.metaSend.sendText, {
                accountId: meta.accountId,
                conversationId: meta.conversationId,
                to: verdict.to,
                text: verdict.text,
              });
            } else {
              await ctx.runAction(internal.metaSend.sendTemplate, {
                accountId: meta.accountId,
                conversationId: meta.conversationId,
                to: verdict.to,
                templateName: verdict.templateName,
                language: verdict.language ?? undefined,
                params: verdict.params,
                contentText: verdict.contentText,
              });
            }
          } catch (err) {
            // At-most-once by design: the slot is spent, the next rung is
            // already booked — a transient failure skips one nudge, it
            // never duplicates one.
            console.error("[qualification] follow-up send failed:", err);
          }
          return;
        }
      }
    } catch (err) {
      console.error("[qualification] follow-up failed:", err);
    }
  },
});

/** Tiny address lookup for `sendFollowUp` (an action has no db). */
export const sendTarget = internalQuery({
  args: { sessionId: v.id("qualificationSessions") },
  handler: async (
    ctx,
    args,
  ): Promise<{ accountId: Id<"accounts">; conversationId: Id<"conversations"> } | null> => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) return null;
    return { accountId: session.accountId, conversationId: session.conversationId };
  },
});

// ============================================================
// v3 — the ask-admin relay. When the assistant lacks an answer it tells
// the customer "let me check with my team" (aiReply parses the
// [[ASK_ADMIN: …]] marker) and the question is WhatsApped to the admin
// numbers as a PLAIN message — owner-stated operating assumption: the
// admin channel's 24h window never closes, so no template is needed.
// The admin's next reply answers the LATEST pending inquiry and is
// relayed back to the customer by the assistant. Undelivered answers
// are also injected into the assistant's knowledge on the customer's
// next turn (`pendingAnswers`), so nothing gets lost if the immediate
// relay can't send.
// ============================================================

/** Team answers not yet delivered to this customer thread — injected as
 *  knowledge notes into the assistant's next reply. */
export const pendingAnswers = internalQuery({
  args: {
    accountId: v.id("accounts"),
    conversationId: v.id("conversations"),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ notes: string[]; inquiryIds: Id<"adminInquiries">[] }> => {
    const rows = await ctx.db
      .query("adminInquiries")
      .withIndex("by_conversation", (q) => q.eq("conversationId", args.conversationId))
      .collect();
    const cutoff = Date.now() - 48 * 3_600_000;
    const answered = rows.filter(
      (r) =>
        r.accountId === args.accountId &&
        r.status === "answered" &&
        (r.answeredAt ?? 0) > cutoff,
    );
    return {
      notes: answered.map(
        (r) =>
          `Team answer to the customer's earlier question. Question: "${r.question}" — Team answer: "${r.answer}". Relay this warmly and accurately; do not add facts beyond it.`,
      ),
      inquiryIds: answered.map((r) => r._id),
    };
  },
});

/**
 * Compare-and-set claim for `relayAnswerToCustomer`: flips exactly one
 * `answered` inquiry to `delivered` BEFORE the send, so two concurrent
 * relays (e.g. the scheduled one and a manual retry) can never both
 * text the customer — Convex OCC serializes the two patches and the
 * loser sees `delivered`. Same claim-before-send discipline as
 * `claimFollowUpSlot`.
 */
export const claimAnswerDelivery = internalMutation({
  args: { inquiryId: v.id("adminInquiries") },
  handler: async (ctx, args): Promise<boolean> => {
    const row = await ctx.db.get(args.inquiryId);
    if (!row || row.status !== "answered") return false;
    await ctx.db.patch(args.inquiryId, { status: "delivered" });
    return true;
  },
});

export const markAnswersDelivered = internalMutation({
  args: { inquiryIds: v.array(v.id("adminInquiries")) },
  handler: async (ctx, args): Promise<void> => {
    for (const id of args.inquiryIds) {
      const row = await ctx.db.get(id);
      if (row && row.status === "answered") {
        await ctx.db.patch(id, { status: "delivered" });
      }
    }
  },
});

export const recordAdminInquiry = internalMutation({
  args: {
    accountId: v.id("accounts"),
    conversationId: v.id("conversations"),
    contactId: v.id("contacts"),
    question: v.string(),
    customerName: v.string(),
    customerPhone: v.string(),
  },
  handler: async (ctx, args): Promise<Id<"adminInquiries">> => {
    return await ctx.db.insert("adminInquiries", {
      ...args,
      status: "pending",
      askedAt: Date.now(),
    });
  },
});

/** Read side for `relayQuestionToAdmin`. Null = nowhere to ask. */
export const relayContext = internalQuery({
  args: { accountId: v.id("accounts"), contactId: v.id("contacts") },
  handler: async (
    ctx,
    args,
  ): Promise<{ phones: string[]; customerName: string; customerPhone: string } | null> => {
    // Deliberately NOT gated on `enabled`: the ask-admin protocol lives
    // in the assistant's own prompt, so it must work whenever admin
    // numbers are configured — even with lead qualification off.
    const config = await ctx.db
      .query("qualificationConfigs")
      .withIndex("by_account", (q) => q.eq("accountId", args.accountId))
      .unique();
    if (!config || config.adminAlertPhones.length === 0) return null;
    const contact = await ctx.db.get(args.contactId);
    if (!contact || contact.accountId !== args.accountId) return null;
    return {
      phones: config.adminAlertPhones,
      customerName: contact.name?.trim() || contact.phone,
      customerPhone: contact.phone,
    };
  },
});

/**
 * Sends the assistant's question to every admin number (plain text; see
 * the section header on why no template). Without configured admin
 * numbers the question falls back to the in-app human queue
 * (`flagForHuman` — pending + summary, bot stays on) so it is never
 * silently dropped.
 */
export const relayQuestionToAdmin = internalAction({
  args: {
    accountId: v.id("accounts"),
    conversationId: v.id("conversations"),
    contactId: v.id("contacts"),
    question: v.string(),
  },
  handler: async (ctx, args): Promise<void> => {
    try {
      const context = await ctx.runQuery(internal.qualificationEngine.relayContext, {
        accountId: args.accountId,
        contactId: args.contactId,
      });
      if (!context) {
        // No admin numbers configured — nobody to ask over WhatsApp.
        // Surface the thread (pending + the open question) WITHOUT
        // silencing the bot: it keeps answering what it can from the KB
        // while the team picks the question up from the dashboard.
        await ctx.runMutation(internal.aiReply.flagForHuman, {
          accountId: args.accountId,
          conversationId: args.conversationId,
          summary: `🤖 Needs an answer for the customer: ${args.question}`,
        });
        return;
      }
      await ctx.runMutation(internal.qualificationEngine.recordAdminInquiry, {
        accountId: args.accountId,
        conversationId: args.conversationId,
        contactId: args.contactId,
        question: args.question,
        customerName: context.customerName,
        customerPhone: context.customerPhone,
      });
      const text =
        `❓ Question from ${context.customerName} (${context.customerPhone}):\n` +
        `${args.question}\n\n` +
        "Reply here and I'll pass your answer straight to the customer.";
      for (const phone of context.phones) {
        try {
          const target = await ctx.runMutation(
            internal.qualificationEngine.ensureAdminConversation,
            { accountId: args.accountId, phone },
          );
          await ctx.runAction(internal.metaSend.sendText, {
            accountId: args.accountId,
            conversationId: target.conversationId,
            to: target.to,
            text,
          });
        } catch (err) {
          console.error("[qualification] admin question relay failed:", err);
        }
      }
    } catch (err) {
      console.error("[qualification] relayQuestionToAdmin failed:", err);
    }
  },
});

/**
 * Inbound from an admin number answers the LATEST pending inquiry
 * (admins reply to what's on their screen). Records the answer and
 * schedules the customer-facing relay.
 */
export const onAdminInbound = internalMutation({
  args: {
    accountId: v.id("accounts"),
    phoneNormalized: v.string(),
    text: v.string(),
  },
  handler: async (ctx, args): Promise<void> => {
    if (!args.text.trim()) return;
    const config = await ctx.db
      .query("qualificationConfigs")
      .withIndex("by_account", (q) => q.eq("accountId", args.accountId))
      .unique();
    if (!config) return;

    // P6 routing precedence for a STAFF inbound:
    //   1. a member with a live lead OFFER → interpret YES/NO consent;
    //   2. an admin-alert number with a pending inquiry → team answer;
    //   3. a member with an accepted lead → status update (logged as a
    //      contact note + on the offer, resetting the reminder clock);
    //   4. anything else → ignore (free chat).
    const memberships = await ctx.db
      .query("memberships")
      .withIndex("by_account", (q) => q.eq("accountId", args.accountId))
      .collect();
    const member = memberships.find(
      (m) => m.phone && normalizePhone(m.phone) === args.phoneNormalized,
    );

    if (member) {
      const offered = await ctx.db
        .query("leadOffers")
        .withIndex("by_agent_status", (q) =>
          q.eq("agentUserId", member.userId).eq("status", "offered"),
        )
        .order("desc")
        .first();
      if (offered && offered.accountId === args.accountId) {
        const verdict = parseStaffReply(args.text);
        if (verdict === "accept") {
          const result = await ctx.db.get(offered._id); // freshness via OCC
          void result;
          const outcome = await acceptOfferCore(ctx, offered._id);
          if (outcome.ok) {
            await ctx.scheduler.runAfter(0, internal.qualificationEngine.announceAssignment, {
              offerId: offered._id,
            });
          } else if (outcome.alreadyAssigned) {
            await ctx.scheduler.runAfter(0, internal.qualificationEngine.notifyStaffText, {
              accountId: args.accountId,
              phone: offered.agentPhone,
              text: "Someone already took that lead — I'll send you the next one! 🙌",
            });
          }
          return;
        }
        if (verdict === "decline") {
          const closed = await markOfferClosedCore(ctx, offered._id, "declined");
          if (closed) {
            await ctx.scheduler.runAfter(0, internal.qualificationEngine.startLeadOffer, {
              accountId: args.accountId,
              sessionId: closed.sessionId,
            });
            await ctx.scheduler.runAfter(0, internal.qualificationEngine.notifyStaffText, {
              accountId: args.accountId,
              phone: offered.agentPhone,
              text: "No problem 👍 I'll offer it to someone else.",
            });
          }
          return;
        }
        // ambiguous while an offer is pending → leave the offer open,
        // fall through to inquiry/feedback handling below.
      }
    }

    if (isAdminAlertNumber(config, args.phoneNormalized)) {
      const pending = await ctx.db
        .query("adminInquiries")
        .withIndex("by_account_status", (q) =>
          q.eq("accountId", args.accountId).eq("status", "pending"),
        )
        .order("desc")
        .first();
      if (pending) {
        await ctx.db.patch(pending._id, {
          status: "answered",
          answer: args.text.trim(),
          answeredAt: Date.now(),
        });
        await ctx.scheduler.runAfter(0, internal.qualificationEngine.relayAnswerToCustomer, {
          inquiryId: pending._id,
        });
        return;
      }
    }

    // 3. feedback from an agent on their most recent accepted lead
    if (member) {
      const accepted = await ctx.db
        .query("leadOffers")
        .withIndex("by_agent_status", (q) =>
          q.eq("agentUserId", member.userId).eq("status", "accepted"),
        )
        .order("desc")
        .first();
      if (
        accepted &&
        accepted.accountId === args.accountId &&
        Date.now() - (accepted.respondedAt ?? 0) < 14 * 24 * 3_600_000
      ) {
        const now = Date.now();
        await ctx.db.patch(accepted._id, {
          feedback: args.text.trim(),
          feedbackAt: now,
          lastReminderAt: now,
        });
        await ctx.db.insert("contactNotes", {
          accountId: args.accountId,
          contactId: accepted.contactId,
          createdByUserId: member.userId,
          noteText: `📋 WhatsApp update from ${member.fullName ?? member.email ?? "agent"}: ${args.text.trim()}`,
        });
      }
    }
  },
});

/** Shared cores so the router (a mutation) can act without runMutation. */
async function acceptOfferCore(
  ctx: { db: import("./_generated/server").MutationCtx["db"] },
  offerId: Id<"leadOffers">,
): Promise<{ ok: boolean; alreadyAssigned?: boolean }> {
  const offer = await ctx.db.get(offerId);
  if (!offer || offer.status !== "offered") return { ok: false };
  const conversation = await ctx.db.get(offer.conversationId);
  if (!conversation) return { ok: false };
  if (conversation.assignedToUserId) {
    await ctx.db.patch(offerId, { status: "cancelled", respondedAt: Date.now() });
    return { ok: false, alreadyAssigned: true };
  }
  const now = Date.now();
  await ctx.db.patch(offerId, { status: "accepted", respondedAt: now });
  await ctx.db.patch(offer.conversationId, {
    assignedToUserId: offer.agentUserId,
    updatedAt: now,
  });
  await chargeLeadIfAgent(ctx, offer.accountId, offer.agentUserId, offer.conversationId);
  await insertNotification(ctx, {
    accountId: offer.accountId,
    userId: offer.agentUserId,
    type: "conversation_assigned",
    conversationId: offer.conversationId,
    contactId: offer.contactId,
    title: "Lead assigned to you",
    body: "You accepted a qualified lead over WhatsApp.",
  });
  return { ok: true };
}

async function markOfferClosedCore(
  ctx: { db: import("./_generated/server").MutationCtx["db"] },
  offerId: Id<"leadOffers">,
  status: "declined" | "timed_out",
): Promise<{ sessionId: Id<"qualificationSessions"> } | null> {
  const offer = await ctx.db.get(offerId);
  if (!offer || offer.status !== "offered") return null;
  await ctx.db.patch(offerId, { status, respondedAt: Date.now() });
  return { sessionId: offer.sessionId };
}

/** Tiny helper action: plain text to a staff phone. */
export const notifyStaffText = internalAction({
  args: { accountId: v.id("accounts"), phone: v.string(), text: v.string() },
  handler: async (ctx, args): Promise<void> => {
    try {
      const target = await ctx.runMutation(
        internal.qualificationEngine.ensureAdminConversation,
        { accountId: args.accountId, phone: args.phone },
      );
      await ctx.runAction(internal.metaSend.sendText, {
        accountId: args.accountId,
        conversationId: target.conversationId,
        to: target.to,
        text: args.text,
      });
    } catch (err) {
      console.error("[qualification] notifyStaffText failed:", err);
    }
  },
});

/** Read side for `relayAnswerToCustomer`. */
export const answerContext = internalQuery({
  args: { inquiryId: v.id("adminInquiries") },
  handler: async (ctx, args) => {
    const inquiry = await ctx.db.get(args.inquiryId);
    if (!inquiry || inquiry.status !== "answered" || !inquiry.answer) return null;
    const conversation = await ctx.db.get(inquiry.conversationId);
    if (!conversation || conversation.accountId !== inquiry.accountId) return null;
    const contact = await ctx.db.get(inquiry.contactId);
    if (!contact) return null;
    return {
      accountId: inquiry.accountId,
      conversationId: inquiry.conversationId,
      question: inquiry.question,
      answer: inquiry.answer,
      to: contact.phone,
      // A human who took the thread owns the relay too — the assistant
      // stands down (the answer stays injected via `pendingAnswers` if
      // the bot ever resumes).
      aiEligible: !conversation.aiAutoreplyDisabled && !conversation.assignedToUserId,
    };
  },
});

/**
 * Relays the admin's answer to the waiting customer as a warm assistant
 * reply (LLM-composed; deterministic in DRY-RUN). Best-effort: if the
 * immediate send can't happen (human took over, cap, window closed),
 * the answer stays `answered` and reaches the customer through the
 * `pendingAnswers` knowledge injection on their next message.
 */
export const relayAnswerToCustomer = internalAction({
  args: { inquiryId: v.id("adminInquiries") },
  handler: async (ctx, args): Promise<void> => {
    try {
      const context = await ctx.runQuery(internal.qualificationEngine.answerContext, {
        inquiryId: args.inquiryId,
      });
      if (!context || !context.aiEligible) return;

      const aiCfg = await ctx.runQuery(internal.aiConfig.loadDecrypted, {
        accountId: context.accountId,
      });
      if (!aiCfg || !aiCfg.isActive) return;

      let text: string;
      if (isAiDryRun()) {
        text = `Good news about your question — ${context.answer}`;
      } else {
        const historyRows = await ctx.runQuery(internal.aiReply.recentMessages, {
          accountId: context.accountId,
          conversationId: context.conversationId,
          limit: aiContextMessageLimit(),
        });
        const messages = toChatMessages(historyRows);
        const systemPrompt = buildSystemPrompt({
          userPrompt: aiCfg.systemPrompt ?? null,
          mode: "auto_reply",
          knowledge: [
            `The team answered the customer's earlier question. Question: "${context.question}" — Team answer: "${context.answer}". Write the next reply relaying this answer warmly and accurately; do not add facts beyond it and do not ask the team again.`,
          ],
        });
        const gen = await generateReply({
          provider: aiCfg.provider,
          model: aiCfg.model,
          apiKey: aiCfg.apiKey,
          systemPrompt,
          messages,
        });
        text = gen.text || `Update on your question: ${context.answer}`;
      }

      // CLAIM the inquiry before sending (compare-and-set answered →
      // delivered, the `claimFollowUpSlot` pattern): two concurrent
      // relays for the same answer must never double-text the customer.
      // At-most-once by design — a send failure after the claim falls
      // back to nothing rather than ever risking a duplicate. No reply
      // cap (owner decision): the count is bumped purely as a metric.
      const claimed = await ctx.runMutation(
        internal.qualificationEngine.claimAnswerDelivery,
        { inquiryId: args.inquiryId },
      );
      if (!claimed) return; // another relay already delivered this answer

      const sendResult = await ctx.runAction(internal.metaSend.sendText, {
        accountId: context.accountId,
        conversationId: context.conversationId,
        to: context.to,
        text,
      });
      await ctx.runMutation(internal.aiReply.markMessageAiGenerated, {
        accountId: context.accountId,
        whatsappMessageId: sendResult.whatsappMessageId,
      });
      await ctx.runMutation(internal.aiReply.bumpReplyCount, {
        accountId: context.accountId,
        conversationId: context.conversationId,
      });
    } catch (err) {
      console.error("[qualification] relayAnswerToCustomer failed:", err);
    }
  },
});

// ============================================================
// v4 — mandatory auto-tagging + duplicate-lead cleanup.
// ============================================================

/**
 * Tags the CONTACT with the qualified lead's service (v4, owner rule:
 * "tagging is mandatory when qualifying"). The tag is found by
 * case-insensitive name (created flat/ungrouped if missing) and linked
 * with `source: "ai"`, deduped via `by_contact_tag`. Multiple leads on
 * one conversation therefore stack multiple service tags. Kept
 * best-effort by the caller — a tagging hiccup must never fail
 * completion.
 */
export async function tagContactForService(
  ctx: { db: import("./_generated/server").MutationCtx["db"] },
  args: {
    accountId: Id<"accounts">;
    contactId: Id<"contacts">;
    serviceName: string;
  },
): Promise<void> {
  const name = args.serviceName.trim();
  if (!name) return;
  const tags = await ctx.db
    .query("tags")
    .withIndex("by_account", (q) => q.eq("accountId", args.accountId))
    .collect();
  let tag = tags.find((t) => t.name.trim().toLowerCase() === name.toLowerCase());
  if (!tag) {
    const tagId = await ctx.db.insert("tags", {
      accountId: args.accountId,
      name,
      color: "#0ea5e9",
    });
    tag = (await ctx.db.get(tagId))!;
  }
  const existing = await ctx.db
    .query("contactTags")
    .withIndex("by_contact_tag", (q) =>
      q.eq("contactId", args.contactId).eq("tagId", tag._id),
    )
    .first();
  if (existing) return;
  await ctx.db.insert("contactTags", {
    accountId: args.accountId,
    contactId: args.contactId,
    tagId: tag._id,
    source: "ai",
  });
}

/**
 * One-off / operational dedupe (the Italy-duplicate incident): within
 * each conversation, later QUALIFIED sessions repeating the SAME
 * service within 48h of the kept one are retired to `disqualified`
 * (`closedReason: "duplicate"`). Safe to re-run; returns the count.
 */
export const cleanupDuplicateLeads = internalMutation({
  args: { accountId: v.id("accounts") },
  handler: async (ctx, args): Promise<{ removed: number }> => {
    const qualified = await ctx.db
      .query("qualificationSessions")
      .withIndex("by_account_status", (q) =>
        q.eq("accountId", args.accountId).eq("status", "qualified"),
      )
      .take(500);
    const kept = new Map<string, number>(); // conversation|service → earliest qualifiedAt
    let removed = 0;
    const sorted = [...qualified].sort(
      (a, b) => (a.qualifiedAt ?? a._creationTime) - (b.qualifiedAt ?? b._creationTime),
    );
    for (const s of sorted) {
      const key = `${s.conversationId}|${(s.serviceName ?? "").trim().toLowerCase()}`;
      const at = s.qualifiedAt ?? s._creationTime;
      const first = kept.get(key);
      if (first === undefined) {
        kept.set(key, at);
        continue;
      }
      if (at - first < 48 * 3_600_000) {
        await ctx.db.patch(s._id, {
          status: "disqualified",
          closedReason: "duplicate",
          nextFollowUpAt: undefined,
        });
        removed++;
      } else {
        kept.set(key, at); // a later, legitimate re-booking becomes the new anchor
      }
    }
    return { removed };
  },
});

// ============================================================
// P6 — consent-based lead offers. On qualification (auto-assign on,
// conversation unassigned) the engine walks eligible agents — members
// whose memberTags include the lead's service tag AND who have their
// own WhatsApp number — fewest recent accepts first, offering each a
// 10-minute (configurable) YES/NO window over WhatsApp. Accept →
// assign + charge + tell the customer + send the agent's contact card.
// Decline/timeout → next agent. Nobody left → the lead stays in the
// shared queue exactly as before (supervisors were already notified).
// ============================================================

/** Picks the next eligible agent for a session's offer, or null. */
export const offerContext = internalQuery({
  args: { sessionId: v.id("qualificationSessions") },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session || session.status !== "qualified" || !session.serviceName) return null;
    const config = await loadEnabledConfig(ctx, session.accountId);
    if (!config || config.autoAssignEnabled === false) return null;
    const conversation = await ctx.db.get(session.conversationId);
    if (!conversation || conversation.assignedToUserId) return null; // taken already
    // one live offer at a time per session
    const offers = await ctx.db
      .query("leadOffers")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
      .collect();
    if (offers.some((o) => o.status === "offered" || o.status === "accepted")) return null;
    const alreadyTried = new Set(offers.map((o) => o.agentUserId));

    // the service tag (auto-created at completion)
    const tags = await ctx.db
      .query("tags")
      .withIndex("by_account", (q) => q.eq("accountId", session.accountId))
      .collect();
    const serviceTag = tags.find(
      (t) => t.name.trim().toLowerCase() === session.serviceName!.trim().toLowerCase(),
    );
    if (!serviceTag) return null;

    const links = await ctx.db
      .query("memberTags")
      .withIndex("by_account_tag", (q) =>
        q.eq("accountId", session.accountId).eq("tagId", serviceTag._id),
      )
      .collect();
    const memberships = await ctx.db
      .query("memberships")
      .withIndex("by_account", (q) => q.eq("accountId", session.accountId))
      .collect();
    const byUser = new Map(memberships.map((m) => [m.userId, m]));

    const candidates: { userId: Id<"users">; phone: string; name: string; recent: number }[] = [];
    for (const link of links) {
      if (alreadyTried.has(link.userId)) continue;
      const m = byUser.get(link.userId);
      if (!m || !m.phone) continue;
      if (m.role !== "agent" && m.role !== "supervisor") continue;
      const recentAccepts = await ctx.db
        .query("leadOffers")
        .withIndex("by_agent_status", (q) =>
          q.eq("agentUserId", link.userId).eq("status", "accepted"),
        )
        .order("desc")
        .take(10);
      const cutoff = Date.now() - 72 * 3_600_000;
      candidates.push({
        userId: link.userId,
        phone: m.phone,
        name: m.fullName ?? m.email ?? "Team member",
        recent: recentAccepts.filter((o) => (o.respondedAt ?? 0) > cutoff).length,
      });
    }
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => a.recent - b.recent);
    const pick = candidates[0];

    const contact = await ctx.db.get(session.contactId);
    return {
      accountId: session.accountId,
      conversationId: session.conversationId,
      contactId: session.contactId,
      agent: pick,
      serviceName: session.serviceName,
      score: session.score ?? null,
      summary: session.summary ?? null,
      customerName: contact?.name?.trim() || contact?.phone || "a customer",
    };
  },
});

export const createOffer = internalMutation({
  args: {
    accountId: v.id("accounts"),
    sessionId: v.id("qualificationSessions"),
    conversationId: v.id("conversations"),
    contactId: v.id("contacts"),
    agentUserId: v.id("users"),
    agentPhone: v.string(),
  },
  handler: async (ctx, args): Promise<Id<"leadOffers"> | null> => {
    const existing = await ctx.db
      .query("leadOffers")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
      .collect();
    if (existing.some((o) => o.status === "offered" || o.status === "accepted")) {
      return null; // race: someone else already offering/accepted
    }
    return await ctx.db.insert("leadOffers", {
      ...args,
      status: "offered",
      offeredAt: Date.now(),
    });
  },
});

export const startLeadOffer = internalAction({
  args: { accountId: v.id("accounts"), sessionId: v.id("qualificationSessions") },
  handler: async (ctx, args): Promise<void> => {
    try {
      const context = await ctx.runQuery(internal.qualificationEngine.offerContext, {
        sessionId: args.sessionId,
      });
      if (!context) return;
      const offerId = await ctx.runMutation(internal.qualificationEngine.createOffer, {
        accountId: context.accountId,
        sessionId: args.sessionId,
        conversationId: context.conversationId,
        contactId: context.contactId,
        agentUserId: context.agent.userId,
        agentPhone: context.agent.phone,
      });
      if (!offerId) return;
      const target = await ctx.runMutation(
        internal.qualificationEngine.ensureAdminConversation,
        { accountId: context.accountId, phone: context.agent.phone },
      );
      await ctx.runAction(internal.metaSend.sendText, {
        accountId: context.accountId,
        conversationId: target.conversationId,
        to: target.to,
        text:
          `🆕 New qualified lead: ${context.serviceName}` +
          (context.score !== null ? ` · score ${context.score}/100` : "") +
          (context.summary ? `\n${context.summary}` : "") +
          `\nCustomer: ${context.customerName}` +
          "\n\nAre you available to take it? Reply YES to accept or NO to pass.",
      });
    } catch (err) {
      console.error("[qualification] startLeadOffer failed:", err);
    }
  },
});

export const acceptOffer = internalMutation({
  args: { offerId: v.id("leadOffers") },
  handler: async (ctx, args) => acceptOfferCore(ctx, args.offerId),
});

export const markOfferClosed = internalMutation({
  args: {
    offerId: v.id("leadOffers"),
    status: v.union(v.literal("declined"), v.literal("timed_out")),
  },
  handler: async (ctx, args) => markOfferClosedCore(ctx, args.offerId, args.status),
});

/** Tells the customer who's coming + sends the agent's contact card,
 *  and confirms to the agent. Best-effort, after `acceptOffer`. */
export const announceAssignment = internalAction({
  args: { offerId: v.id("leadOffers") },
  handler: async (ctx, args): Promise<void> => {
    try {
      const data = await ctx.runQuery(internal.qualificationEngine.announceContext, {
        offerId: args.offerId,
      });
      if (!data) return;
      await ctx.runAction(internal.metaSend.sendText, {
        accountId: data.accountId,
        conversationId: data.customerConversationId,
        to: data.customerPhone,
        text:
          `Great news — ${data.agentName} from our team will contact you shortly to take this forward! 🎉\n` +
          "Meanwhile, here's their contact — feel free to save it in case you'd like to call.",
      });
      await ctx.runAction(internal.metaSend.sendContactCard, {
        accountId: data.accountId,
        conversationId: data.customerConversationId,
        to: data.customerPhone,
        cardName: data.agentName,
        cardPhone: data.agentPhone,
      });
      const staff = await ctx.runMutation(
        internal.qualificationEngine.ensureAdminConversation,
        { accountId: data.accountId, phone: data.agentPhone },
      );
      await ctx.runAction(internal.metaSend.sendText, {
        accountId: data.accountId,
        conversationId: staff.conversationId,
        to: staff.to,
        text:
          `✅ It's yours — ${data.customerName} (${data.customerPhone}).\n` +
          "I've told them you'll be in touch. Reply here anytime with an update and I'll log it on the lead.",
      });
    } catch (err) {
      console.error("[qualification] announceAssignment failed:", err);
    }
  },
});

export const announceContext = internalQuery({
  args: { offerId: v.id("leadOffers") },
  handler: async (ctx, args) => {
    const offer = await ctx.db.get(args.offerId);
    if (!offer || offer.status !== "accepted") return null;
    const contact = await ctx.db.get(offer.contactId);
    const membership = await ctx.db
      .query("memberships")
      .withIndex("by_user_account", (q) =>
        q.eq("userId", offer.agentUserId).eq("accountId", offer.accountId),
      )
      .first();
    if (!contact || !membership) return null;
    return {
      accountId: offer.accountId,
      customerConversationId: offer.conversationId,
      customerPhone: contact.phone,
      customerName: contact.name?.trim() || contact.phone,
      agentName: membership.fullName ?? membership.email ?? "our travel expert",
      agentPhone: offer.agentPhone,
    };
  },
});

/** Cron: expire offers past the consent window and move to the next agent. */
export const sweepLeadOffers = internalAction({
  args: {},
  handler: async (ctx): Promise<void> => {
    const due = await ctx.runQuery(internal.qualificationEngine.getExpiredOffers, {});
    for (const offer of due) {
      const closed = await ctx.runMutation(internal.qualificationEngine.markOfferClosed, {
        offerId: offer._id,
        status: "timed_out",
      });
      if (closed) {
        await ctx.scheduler.runAfter(0, internal.qualificationEngine.startLeadOffer, {
          accountId: offer.accountId,
          sessionId: closed.sessionId,
        });
      }
    }
  },
});

export const getExpiredOffers = internalQuery({
  args: {},
  handler: async (ctx): Promise<Doc<"leadOffers">[]> => {
    const now = Date.now();
    const offered = await ctx.db
      .query("leadOffers")
      .withIndex("by_status_offered", (q) => q.eq("status", "offered").lte("offeredAt", now))
      .take(100);
    const out: Doc<"leadOffers">[] = [];
    for (const offer of offered) {
      const config = await ctx.db
        .query("qualificationConfigs")
        .withIndex("by_account", (q) => q.eq("accountId", offer.accountId))
        .unique();
      const timeoutMs = (config?.offerTimeoutMinutes ?? 10) * 60_000;
      if (now - offer.offeredAt >= timeoutMs) out.push(offer);
    }
    return out;
  },
});

// ============================================================
// P6 — staff loops cron (hourly): (a) feedback reminders for assigned
// leads that haven't moved (first nudge 4 working-hours after accept,
// then daily, supervisor escalation after 48 quiet hours); (b) daily
// window keepalive for every staff number (plain reminder while the
// 24h window is open, the approved staff_checkin template once closed).
// ============================================================

const REMINDER_FIRST_MS = 4 * 3_600_000;
const REMINDER_REPEAT_MS = 24 * 3_600_000;
const ESCALATE_AFTER_MS = 48 * 3_600_000;
const CHECKIN_EVERY_MS = 20 * 3_600_000;

export const staffLoopsDue = internalQuery({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const reminders: {
      offerId: Id<"leadOffers">;
      accountId: Id<"accounts">;
      agentPhone: string;
      customerName: string;
      escalate: boolean;
    }[] = [];
    const accepted = await ctx.db
      .query("leadOffers")
      .withIndex("by_status_offered", (q) => q.eq("status", "accepted"))
      .take(200);
    for (const offer of accepted) {
      const config = await ctx.db
        .query("qualificationConfigs")
        .withIndex("by_account", (q) => q.eq("accountId", offer.accountId))
        .unique();
      if (!config?.enabled) continue;
      // outside working hours → skip this pass (the hourly cron retries)
      if (clampToWorkingHours(now, config) !== now) continue;
      const conversation = await ctx.db.get(offer.conversationId);
      if (!conversation) continue;
      if (conversation.assignedToUserId !== offer.agentUserId) continue; // re-assigned
      if (conversation.status === "closed") continue; // done
      if (conversation.funnel?.stage && conversation.funnel.stage !== "qualified") {
        continue; // the agent moved the funnel — no nagging
      }
      const anchor = Math.max(
        offer.respondedAt ?? 0,
        offer.feedbackAt ?? 0,
        offer.lastReminderAt ?? 0,
      );
      const firstReminder = !offer.lastReminderAt && !offer.feedbackAt;
      const wait = firstReminder ? REMINDER_FIRST_MS : REMINDER_REPEAT_MS;
      if (now - anchor < wait) continue;
      const contact = await ctx.db.get(offer.contactId);
      const quietSince = Math.max(offer.respondedAt ?? 0, offer.feedbackAt ?? 0);
      reminders.push({
        offerId: offer._id,
        accountId: offer.accountId,
        agentPhone: offer.agentPhone,
        customerName: contact?.name?.trim() || contact?.phone || "the customer",
        escalate: !offer.escalatedAt && now - quietSince > ESCALATE_AFTER_MS,
      });
    }
    return reminders;
  },
});

export const recordReminderSent = internalMutation({
  args: { offerId: v.id("leadOffers"), escalated: v.boolean() },
  handler: async (ctx, args): Promise<void> => {
    const offer = await ctx.db.get(args.offerId);
    if (!offer) return;
    const now = Date.now();
    await ctx.db.patch(args.offerId, {
      lastReminderAt: now,
      remindersSent: (offer.remindersSent ?? 0) + 1,
      ...(args.escalated ? { escalatedAt: now } : {}),
    });
    if (args.escalated) {
      const members = await ctx.db
        .query("memberships")
        .withIndex("by_account", (q) => q.eq("accountId", offer.accountId))
        .collect();
      const recipients = recipientsForInbound({
        assignedToUserId: null, // escalation goes to the whole supervisor pool
        members: members.map((m) => ({ userId: m.userId, role: m.role as AccountRole })),
      });
      const agent = members.find((m) => m.userId === offer.agentUserId);
      for (const userId of recipients) {
        await insertNotification(ctx, {
          accountId: offer.accountId,
          userId,
          type: "lead_qualified",
          conversationId: offer.conversationId,
          contactId: offer.contactId,
          title: "Assigned lead needs attention",
          body: `${agent?.fullName ?? "An agent"} hasn't updated this lead in 2 days.`,
        });
      }
    }
  },
});

export const staffCheckinsDue = internalQuery({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const out: {
      accountId: Id<"accounts">;
      phone: string;
      phoneNormalized: string;
      windowOpen: boolean;
      templateName: string | null;
      templateLanguage: string | null;
    }[] = [];
    // every enabled config = one account's staff set
    const configs = await ctx.db.query("qualificationConfigs").collect();
    for (const config of configs) {
      if (!config.enabled) continue;
      const staff = await loadStaffPhoneSet(ctx, config.accountId, config);
      for (const phoneNormalized of staff) {
        const checkin = await ctx.db
          .query("staffCheckins")
          .withIndex("by_account_phone", (q) =>
            q.eq("accountId", config.accountId).eq("phoneNormalized", phoneNormalized),
          )
          .unique();
        if (checkin && now - checkin.lastCheckinSentAt < CHECKIN_EVERY_MS) continue;
        // last inbound FROM this staff number = their staff conversation's
        // latest customer-sender message
        const contact = await ctx.db
          .query("contacts")
          .withIndex("by_account_phone", (q) =>
            q.eq("accountId", config.accountId).eq("phoneNormalized", phoneNormalized),
          )
          .unique();
        let lastInbound = 0;
        let phone = "+" + phoneNormalized;
        if (contact) {
          phone = contact.phone;
          const conversation = await ctx.db
            .query("conversations")
            .withIndex("by_contact", (q) => q.eq("contactId", contact._id))
            .first();
          if (conversation) {
            const lastMsg = await ctx.db
              .query("messages")
              .withIndex("by_conversation", (q) =>
                q.eq("conversationId", conversation._id),
              )
              .order("desc")
              .filter((q) => q.eq(q.field("senderType"), "customer"))
              .first();
            lastInbound = lastMsg?._creationTime ?? 0;
          }
        }
        // fresh chatter (<20h) needs nothing today
        if (now - lastInbound < CHECKIN_EVERY_MS) continue;
        out.push({
          accountId: config.accountId,
          phone,
          phoneNormalized,
          windowOpen: now - lastInbound < 24 * 3_600_000 && lastInbound > 0,
          templateName: config.staffCheckinTemplateName ?? null,
          templateLanguage: config.staffCheckinTemplateLanguage ?? null,
        });
      }
    }
    return out;
  },
});

export const recordCheckinSent = internalMutation({
  args: { accountId: v.id("accounts"), phoneNormalized: v.string() },
  handler: async (ctx, args): Promise<void> => {
    const existing = await ctx.db
      .query("staffCheckins")
      .withIndex("by_account_phone", (q) =>
        q.eq("accountId", args.accountId).eq("phoneNormalized", args.phoneNormalized),
      )
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, { lastCheckinSentAt: Date.now() });
    } else {
      await ctx.db.insert("staffCheckins", {
        accountId: args.accountId,
        phoneNormalized: args.phoneNormalized,
        lastCheckinSentAt: Date.now(),
      });
    }
  },
});

export const runStaffLoops = internalAction({
  args: {},
  handler: async (ctx): Promise<void> => {
    // (a) assigned-lead feedback reminders
    try {
      const reminders = await ctx.runQuery(internal.qualificationEngine.staffLoopsDue, {});
      for (const r of reminders) {
        try {
          const target = await ctx.runMutation(
            internal.qualificationEngine.ensureAdminConversation,
            { accountId: r.accountId, phone: r.agentPhone },
          );
          await ctx.runAction(internal.metaSend.sendText, {
            accountId: r.accountId,
            conversationId: target.conversationId,
            to: target.to,
            text:
              `⏰ Quick reminder about your lead ${r.customerName} — any progress? ` +
              "Reply here with an update (I'll log it), and please keep the CRM lead status current.",
          });
          await ctx.runMutation(internal.qualificationEngine.recordReminderSent, {
            offerId: r.offerId,
            escalated: r.escalate,
          });
        } catch (err) {
          console.error("[qualification] reminder failed:", err);
        }
      }
    } catch (err) {
      console.error("[qualification] reminders sweep failed:", err);
    }
    // (b) staff window keepalive
    try {
      const checkins = await ctx.runQuery(internal.qualificationEngine.staffCheckinsDue, {});
      for (const c of checkins) {
        try {
          const target = await ctx.runMutation(
            internal.qualificationEngine.ensureAdminConversation,
            { accountId: c.accountId, phone: c.phone },
          );
          if (c.windowOpen || !c.templateName) {
            await ctx.runAction(internal.metaSend.sendText, {
              accountId: c.accountId,
              conversationId: target.conversationId,
              to: target.to,
              text:
                "👋 Daily check-in! Reply anything to this message once a day so our chat window stays open — " +
                "that way I can reach you instantly with new leads and customer questions.",
            });
          } else {
            await ctx.runAction(internal.metaSend.sendTemplate, {
              accountId: c.accountId,
              conversationId: target.conversationId,
              to: c.phone,
              templateName: c.templateName,
              language: c.templateLanguage ?? undefined,
              params: [],
              contentText:
                "👋 Our chat window closed — please reply to this message so I can reach you again with leads and updates.",
            });
          }
          await ctx.runMutation(internal.qualificationEngine.recordCheckinSent, {
            accountId: c.accountId,
            phoneNormalized: c.phoneNormalized,
          });
        } catch (err) {
          console.error("[qualification] checkin failed:", err);
        }
      }
    } catch (err) {
      console.error("[qualification] checkin sweep failed:", err);
    }
  },
});
