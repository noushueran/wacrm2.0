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
import {
  aiContextMessageLimit,
  aiJudgeModel,
  aiJudgeReasoningEffort,
  aiReplyReasoningEffort,
  promptCacheKey,
  buildSystemPrompt,
} from "./lib/ai/defaults";
import { latestUserMessage } from "./lib/ai/query";
import { toChatMessages } from "./lib/ai/context";
import { generateReply } from "./lib/ai/generate";
import { applyStageTransition, seedStageConversionEvent } from "./funnel";
import {
  buildPurchasePrompt,
  parsePurchaseVerdict,
  syntheticPurchaseRaw,
  MIN_PURCHASE_CONFIDENCE,
  PURCHASE_EVAL_WINDOW_MS,
  PURCHASE_EVAL_DEBOUNCE_MS,
} from "./lib/qualification/purchase";
import {
  clampToWorkingHours,
  computeNextFollowUpAt,
  isSessionExpired,
  withinServiceWindow,
  pickFollowUpText,
} from "./lib/qualification/schedule";
import { mapFieldsToContact } from "./lib/qualification/contactFields";
import { dispatchTagAdded, dispatchConversationAssigned } from "./lib/automations/triggers";
import { resolveRouting, type FallbackCause } from "./lib/qualification/routing";
import { insertNotification } from "./notifications";
import { chargeLeadIfAgent } from "./lib/leadCharge";
import { applyAssignment } from "./lib/assignment";
import { recipientsForInbound } from "./lib/pushRecipients";
import type { AccountRole } from "./lib/roles";
import { normalizePhone } from "./lib/phone";
import { parseStaffReply } from "./lib/qualification/staffReply";
import { blockedReason } from "./lib/notes/gate";
import { resolveWindowState } from "./lib/whatsapp/messagingWindow";
import { allocateContactCode } from "./contacts";
import { insertConversation } from "./conversations";
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
    // Purchase signals: a post-qualification inbound (text OR media —
    // this hook sees both, unlike the text-only analysis pass) may
    // complete the service's purchase criteria, e.g. the visa documents
    // arriving as images. Cheap gate here; the judge re-checks in full.
    if (
      session &&
      session.status === "qualified" &&
      config.purchaseSignalsEnabled === true &&
      session.purchase?.status !== "sent" &&
      session.qualifiedAt !== undefined &&
      now - session.qualifiedAt <= PURCHASE_EVAL_WINDOW_MS
    ) {
      await ctx.scheduler.runAfter(0, internal.qualificationEngine.evaluatePurchase, {
        accountId: args.accountId,
        conversationId: args.conversationId,
      });
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

/** Dry-run question pool, in priority order — the stub proposes the
 *  first one the same pass did NOT extract an answer for. */
const SYNTHETIC_ASKABLE = [
  {
    key: "travel_dates",
    text: "When are you planning to travel?",
    alternates: ["Rough month works too — when are you thinking?"],
  },
  {
    key: "email",
    text: "What's the best email to send your quote to?",
    alternates: ["Which email should we send the details to?"],
  },
] as const;

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
    // Never propose a question this same pass just answered — the real
    // analyst is instructed not to, and `applyAnalysis` drops it anyway
    // (see its pendingQuestion block), so a stub that always asked for
    // `travel_dates` while extracting `travel_dates` would exercise a
    // path production can no longer reach.
    nextQuestion: checklistSatisfied
      ? null
      : (SYNTHETIC_ASKABLE.find(
          (q) => !fields.some((f) => f.key === q.key),
        ) ?? null),
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
    /** Watermark: newest customer message this session has been analysed
     *  through. Undefined for a session that predates the field. */
    analyzedThroughMs?: number;
    /** Creation time of the newest customer message in the thread, or
     *  null when there is none. Compared against the watermark to decide
     *  whether an extraction would learn anything new. */
    newestCustomerMs: number | null;
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
    // Newest CUSTOMER message — the thing an extraction would read. Taken
    // off the same `by_conversation` index the transcript uses; senders
    // other than the customer cannot carry new answers, so an agent or
    // bot message must not invalidate the watermark.
    const newestCustomer = await ctx.db
      .query("messages")
      .withIndex("by_conversation", (q) => q.eq("conversationId", args.conversationId))
      .order("desc")
      .filter((q) => q.eq(q.field("senderType"), "customer"))
      .first();
    const newestCustomerMs = newestCustomer?._creationTime ?? null;

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
        analyzedThroughMs: session.analyzedThroughMs,
        newestCustomerMs,
      };
    }
    return {
      serviceName: session?.serviceName ?? null,
      knownFields: (session?.fields ?? []).map((f) => ({ key: f.key, value: f.value })),
      basicFields: config.basicFields,
      previousInquiry: undefined,
      analyzedThroughMs: session?.analyzedThroughMs,
      newestCustomerMs,
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
    /** Newest customer message the caller actually analysed — see the
     *  `analyzedThroughMs` note in the patch below. */
    analyzedThroughMs: v.optional(v.number()),
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
      // Watermark for the freshness guard in `analyzeInbound`. Stamped
      // with the caller's OWN view of the newest customer message, not
      // `Date.now()`: a message that arrived while this extraction was
      // in flight was NOT analysed, and stamping now would silently skip
      // it forever.
      ...(args.analyzedThroughMs !== undefined
        ? { analyzedThroughMs: args.analyzedThroughMs }
        : {}),
    };
    if (analysis.serviceName) patch.serviceName = analysis.serviceName;
    if (analysis.summary) patch.summary = analysis.summary;
    // The pending question must be RE-EARNED on every analysis pass, not
    // inherited. It is the only thing the follow-up cron sends (verbatim,
    // hours later, with no LLM call of its own — `pickFollowUpText`), so
    // a question that outlives the turn it was computed on is a question
    // the customer gets asked again after they already answered it. That
    // is exactly what happened on conversation nn7afrjd… : the analyst
    // proposed "inside or outside the UAE?", the customer replied "I am
    // already Dubai" 2 minutes later, the next pass returned
    // nextQuestion: null, the old branch here KEPT the question, and the
    // 4-hour nudge asked it again word for word.
    //
    // `analysis` only exists when `parseAnalysis` succeeded, i.e. the
    // analyst DID see the current transcript — so a null nextQuestion is
    // a considered "nothing to ask", not an absence of information, and
    // clearing is the honest reading. With nothing pending, the cron
    // falls back to its field-driven phrasings, which are derived from
    // what is actually still missing and therefore self-correcting.
    if (analysis.nextQuestion) {
      patch.pendingQuestion = { ...analysis.nextQuestion, askedAt: now };
    } else {
      patch.pendingQuestion = undefined;
    }
    // Belt-and-braces: even a re-proposed question is dropped once the
    // merged fields show its key answered at medium+ confidence. The
    // model proposing a question it just extracted an answer for is the
    // single failure that must never reach the customer.
    const pending = patch.pendingQuestion as
      | { key: string; text: string; alternates: string[]; askedAt: number }
      | undefined;
    if (pending && merged.some((f) => f.key === pending.key && f.confidence !== "low")) {
      patch.pendingQuestion = undefined;
    }
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
    // The lead's sales checklist used to wait for `completeQualification`,
    // which most sessions never reach — 188 checklists against 1,802
    // conversations — so the Inbox panel was empty for nine leads in ten.
    // It is scheduled here instead, on any pass where the session HAS a
    // service — the one just named or one it was already carrying.
    //
    // Deliberately not the "unknown → known" transition. `serviceName` is
    // only ever set, never cleared, so a transition-only guard would reach
    // exactly the sessions that had never named a service and skip every
    // lead already carrying one — which is most of the active ones, and
    // precisely the chats whose empty panel prompted this. Firing on the
    // steady state instead makes the trigger self-healing: an existing
    // `collecting` lead picks up its checklist on the next inbound message.
    //
    // The repetition is free. `generateForSession` early-returns on
    // `info.hasChecklist`, so a lead that already has one costs a scheduled
    // action and one internal query — no LLM call, and the agent's ticked
    // items are never overwritten. `serviceName` still gates it because
    // that is what the KB retrieval and the prompt key on: generating
    // before a service is known (at `ensureSession`, which sets none) would
    // produce a GENERIC checklist and then permanently block the tailored
    // one, since generation early-returns once any row exists.
    //
    // `completeQualification` keeps its own call as the safety net for a
    // lead that qualifies without a service ever being named. Whichever
    // fires first wins; the others no-op on `info.hasChecklist`.
    if (patch.serviceName || session.serviceName) {
      await ctx.scheduler.runAfter(
        0,
        internal.salesChecklists.generateForSession,
        { accountId: args.accountId, sessionId },
      );
    }
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
    // Debounce token — the row id of the inbound that booked this run.
    // At fire time only the run whose trigger is still the NEWEST
    // customer message proceeds, so a burst of quick fragments costs ONE
    // extraction instead of one per fragment. Exactly the token
    // `aiReply.dispatchInbound` already uses for the reply itself.
    //
    // Optional: `dispatchInbound` deliberately calls WITHOUT one, because
    // it is not racing a newer message — it is the reply that must not
    // build its prompt on stale objectives, so it wants the analysis run
    // unconditionally (the freshness guard below still makes that free
    // when the scheduled run already did the work).
    triggerMessageId: v.optional(v.id("messages")),
    // Bypass the freshness watermark below. Exactly one caller needs it:
    // the media pass, after a transcript lands. A transcript attaches new
    // CONTENT to a message that already existed, so the newest-customer
    // -message timestamp does not move and the watermark would otherwise
    // read as "already analysed" and skip the very data that just became
    // readable.
    force: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<void> => {
    try {
      // Burst gate. A newer customer message means ITS scheduled run
      // owns the extraction for the whole burst; this one stands down
      // without spending a provider call.
      if (args.triggerMessageId) {
        const latestInbound = await ctx.runQuery(
          internal.aiReply.latestInboundMessageId,
          { accountId: args.accountId, conversationId: args.conversationId },
        );
        if (latestInbound && latestInbound !== args.triggerMessageId) return;
      }

      const context = await ctx.runQuery(
        internal.qualificationEngine.loadAnalysisContext,
        { accountId: args.accountId, conversationId: args.conversationId },
      );
      if (!context) return;
      // Freshness guard: the session has already been analysed through
      // the newest customer message, so there is nothing new to extract.
      // This is what makes the analysis safe to invoke twice — once from
      // the debounced schedule, once inline from `dispatchInbound` — and
      // charge for it once.
      if (
        !args.force &&
        context.analyzedThroughMs !== undefined &&
        context.newestCustomerMs !== null &&
        context.analyzedThroughMs >= context.newestCustomerMs
      ) {
        return;
      }

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

      const qualifyInstructions = await ctx.runQuery(
        internal.agentInstructions.forAgent,
        { accountId: args.accountId, agentKey: "qualify" },
      );
      const systemPrompt = buildAnalysisPrompt({
        extraInstructions: qualifyInstructions,
        checklistExcerpts,
        basicFields: context.basicFields,
        knownFields: context.knownFields,
        previousInquiry: context.previousInquiry,
      });

      let raw: string;
      if (isAiDryRun()) {
        raw = syntheticAnalysisRaw(latest);
      } else {
        // Extraction emits a fixed JSON schema straight into
        // `parseAnalysis` — no customer ever reads it — so it runs on the
        // cheap judge tier with reasoning off. See `aiJudgeModel`.
        const model = aiJudgeModel(aiCfg.provider, aiCfg.model);
        const gen = await generateReply({
          provider: aiCfg.provider,
          model,
          apiKey: aiCfg.apiKey,
          systemPrompt,
          messages,
          reasoningEffort: aiJudgeReasoningEffort(),
          promptCacheKey: promptCacheKey(args.accountId, "qualify"),
        });
        raw = gen.text;
        try {
          await ctx.runMutation(internal.aiUsage.log, {
            accountId: args.accountId,
            conversationId: args.conversationId,
            mode: "qualify",
            provider: aiCfg.provider,
            // The model actually called, not the account's configured
            // one — otherwise the usage page's by-model breakdown would
            // attribute judge spend to the reply model.
            model,
            promptTokens: gen.usage?.promptTokens ?? 0,
            completionTokens: gen.usage?.completionTokens ?? 0,
            totalTokens: gen.usage?.totalTokens ?? 0,
            cachedPromptTokens: gen.usage?.cachedPromptTokens,
            reasoningTokens: gen.usage?.reasoningTokens,
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
          // The snapshot this run actually read, captured BEFORE the
          // provider call — never a fresh `Date.now()`.
          ...(context.newestCustomerMs !== null
            ? { analyzedThroughMs: context.newestCustomerMs }
            : {}),
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
    unconfirmed: { label: string; value: string }[];
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
      return {
        collected: [],
        unconfirmed: [],
        nextQuestion: null,
        suppressReply: true,
      };
    }

    const label = (f: (typeof session.fields)[number]) =>
      (f.label ?? f.key) +
      (f.carried ? " (from a previous inquiry — reconfirm casually once)" : "");

    const collected = session.fields
      .filter((f) => f.confidence !== "low")
      .map((f) => ({ label: label(f), value: f.value }));

    // Low-confidence rows used to be invisible to the reply prompt
    // entirely, which is a repetition source of its own: the customer
    // DID answer, the analyst just wasn't sure it parsed the answer
    // right, and the assistant — told only about the confident fields —
    // asked from scratch. Surfaced separately so the model confirms
    // ("just to confirm, 30 days?") instead of re-asking blind. Safe to
    // show now that placeholder values ("Not provided") can no longer
    // land in this bucket — see `isNonAnswer`.
    const unconfirmed = session.fields
      .filter((f) => f.confidence === "low")
      .map((f) => ({ label: label(f), value: f.value }));

    // Only a live (collecting) session still has something to ask; a
    // finished one contributes its collected list ONLY (v4: so the
    // assistant never re-asks answered details after completion).
    let nextQuestion: string | null = null;
    if (session.status === "collecting") {
      // Same freshness rule the follow-up cron applies (see
      // `pickFollowUpText`): a question computed BEFORE the customer's
      // latest message may be the one that message answered. Normally
      // `askedAt` wins this comparison — `ingest.ts` awaits the analysis
      // before scheduling the reply — so this only bites when the
      // analysis was skipped (media-only inbound) or raced, which is
      // precisely when the stored question is least trustworthy.
      const pending = session.pendingQuestion;
      const fresh =
        pending !== undefined &&
        pending.askedAt !== undefined &&
        pending.askedAt >= (session.lastCustomerMessageAt ?? 0);
      if (fresh) {
        nextQuestion = pending.text;
      } else if (!pending && !(session.serviceName ?? "").trim()) {
        // No question has ever been proposed (first turn): steer from
        // the first unanswered required basic field. A STALE question is
        // deliberately NOT replaced by this fallback — the basic fields
        // are the generic off-topic set, and pushing "how many
        // travellers?" at a visa applicant is worse than letting the
        // model read the transcript and choose for itself this turn.
        //
        // `serviceName` gates it for the same reason (fix 2026-07-30).
        // "No question has ever been proposed" is not only the first
        // turn: `applyAnalysis` CLEARS `pendingQuestion` whenever the
        // analyst names nothing to ask, so a mature service thread lands
        // here too — and then no basicFields key can ever look answered,
        // because everything known about it is keyed in the CHECKLIST
        // namespace. That steered the reply model to ask a visa applicant
        // what they were looking for. Same root cause and same gate as
        // `pickFollowUpText`; see its comment for the full reasoning.
        const answered = new Set(
          session.fields.filter((f) => f.confidence !== "low").map((f) => f.key),
        );
        const missing = config.basicFields.find(
          (f) => f.required && !answered.has(f.key),
        );
        nextQuestion = missing?.phrasings[0] ?? null;
      }
    }

    return { collected, unconfirmed, nextQuestion };
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

    // Fill blank contact fields from what the assistant already
    // extracted, so a rep never re-types it. Blanks only — a value
    // already on the contact was either typed by a human or written by
    // an earlier qualification, and either way it outranks a fresh
    // guess. Runs once, here, rather than on every analysis pass: with
    // blanks-only semantics whatever lands FIRST wins permanently, so
    // writing early would let a shaky mid-conversation guess lock out
    // the settled answer.
    //
    // Scoped to the write on purpose: `conversations.contactId` can
    // dangle after a contact delete (see `contacts.ts`'s own note on
    // its delete mutation), and a missing contact must NOT abort
    // qualification — the session status, funnel transition, Meta
    // conversion event and notifications above/below all still have to
    // happen regardless.
    const contact = await ctx.db.get(session.contactId);
    if (contact) {
      const contactPatch = mapFieldsToContact(session.fields, contact);
      if (Object.keys(contactPatch).length > 0) {
        await ctx.db.patch(session.contactId, contactPatch);
      }
    }

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
    // Post the sales checklist on the fresh lead (KB/AI-driven with a
    // built-in default fallback — always lands one).
    await ctx.scheduler.runAfter(0, internal.salesChecklists.generateForSession, {
      accountId: args.accountId,
      sessionId: session._id,
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
    // Purchase signals: the first evaluation rides completion itself —
    // when the checklist conversation already covered the purchase bar
    // (e.g. budget), the proxy Purchase fires with zero extra delay.
    if (config.purchaseSignalsEnabled === true) {
      await ctx.scheduler.runAfter(0, internal.qualificationEngine.evaluatePurchase, {
        accountId: args.accountId,
        conversationId: args.conversationId,
      });
    }
  },
});

// ============================================================
// PURCHASE SIGNALS (spec docs/superpowers/specs/2026-07-19-purchase-
// signals-design.md). A second, stricter judge that runs ONLY on
// already-qualified sessions: does this lead also meet its service's
// owner-editable `PURCHASE CRITERIA — <Service>` KB section? If yes,
// seed the `purchased` conversionEvents row directly — WITHOUT moving
// the operational funnel stage — so Meta's Sales-objective campaign
// gets its Purchase the moment the lead is highly qualified, and the
// later real sale (agent-marked `purchased`) links the same
// `${conversationId}:purchased` row instead of double-sending.
// ============================================================

/**
 * Everything the purchase judge needs in one read. Null = don't
 * evaluate: feature/toggle dormant, conversation closed/organic/staff,
 * latest session not `qualified`, signal already sent, outside the
 * post-qualification window, or debounced (an evaluation just ran).
 */
export const loadPurchaseContext = internalQuery({
  args: {
    accountId: v.id("accounts"),
    conversationId: v.id("conversations"),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    serviceName: string | null;
    fields: { key: string; label?: string; value: string }[];
    score: number | null;
    summary: string | null;
    /** Previous inquiry's completion time — the judge must only see
     *  messages after it (v4 transcript-boundary rule). */
    boundary: number | null;
  } | null> => {
    const config = await loadEnabledConfig(ctx, args.accountId);
    if (!config || config.purchaseSignalsEnabled !== true) return null;
    const conversation = await ctx.db.get(args.conversationId);
    if (!conversation || conversation.accountId !== args.accountId) return null;
    if (conversation.status === "closed") return null;
    // Only attributed conversations can carry a Meta event — an organic
    // chat has nothing to fire, so the LLM spend is skipped entirely.
    const attribution = conversation.attribution;
    const identifier =
      attribution &&
      (attribution.lane === "code" ? attribution.code : attribution.ctwaClid);
    if (!identifier) return null;
    // Staff loop guard, same as the analysis path.
    const contact = await ctx.db.get(conversation.contactId);
    if (contact) {
      const staff = await loadStaffPhoneSet(ctx, args.accountId, config);
      if (isStaffNumber(staff, contact.phoneNormalized)) return null;
    }
    const rows = await ctx.db
      .query("qualificationSessions")
      .withIndex("by_conversation", (q) =>
        q.eq("conversationId", args.conversationId),
      )
      .order("desc")
      .collect();
    const session = rows[0];
    if (!session || session.status !== "qualified") return null;
    if (session.purchase?.status === "sent") return null;
    const now = Date.now();
    if (
      session.qualifiedAt === undefined ||
      now - session.qualifiedAt > PURCHASE_EVAL_WINDOW_MS
    ) {
      return null;
    }
    if (
      session.purchase &&
      now - session.purchase.evaluatedAt < PURCHASE_EVAL_DEBOUNCE_MS
    ) {
      return null;
    }
    // Multi-lead: when an OLDER terminal session exists, the judge only
    // sees messages after it finished (same boundary the analysis uses).
    const previous = rows[1];
    const boundary = previous
      ? (previous.qualifiedAt ??
        previous.lastCustomerMessageAt ??
        previous._creationTime)
      : null;
    return {
      serviceName: session.serviceName ?? null,
      fields: session.fields
        .filter((f) => f.confidence !== "low")
        .map((f) => ({
          key: f.key,
          ...(f.label ? { label: f.label } : {}),
          value: f.value,
        })),
      score: session.score ?? null,
      summary: session.summary ?? null,
      boundary,
    };
  },
});

const purchaseVerdictValidator = v.object({
  met: v.boolean(),
  confidence: v.number(),
  reasons: v.array(v.string()),
  value: v.union(v.number(), v.null()),
  currency: v.union(v.string(), v.null()),
  criteriaFound: v.boolean(),
});

/**
 * Applies one judge verdict transactionally. Re-checks every gate (the
 * action's read ran outside this transaction), fires at most once per
 * conversation (session `sent` status + the outbox's
 * `${conversationId}:purchased` eventId dedup), and never touches
 * `conversation.funnel` — the proxy is Meta-only, CRM stages stay
 * operational truth. Not-met verdicts are stamped so /leads can show
 * why, and the next inbound re-evaluates.
 */
export const applyPurchaseVerdict = internalMutation({
  args: {
    accountId: v.id("accounts"),
    conversationId: v.id("conversations"),
    verdict: purchaseVerdictValidator,
  },
  handler: async (ctx, args): Promise<{ fired: boolean }> => {
    const none = { fired: false };
    const config = await loadEnabledConfig(ctx, args.accountId);
    if (!config || config.purchaseSignalsEnabled !== true) return none;
    const conversation = await ctx.db.get(args.conversationId);
    if (!conversation || conversation.accountId !== args.accountId) return none;
    const session = await ctx.db
      .query("qualificationSessions")
      .withIndex("by_conversation", (q) =>
        q.eq("conversationId", args.conversationId),
      )
      .order("desc")
      .first();
    if (!session || session.status !== "qualified") return none;
    if (session.purchase?.status === "sent") return none;
    const now = Date.now();
    const verdict = args.verdict;

    const fire =
      verdict.met &&
      verdict.criteriaFound &&
      verdict.confidence >= MIN_PURCHASE_CONFIDENCE;
    if (!fire) {
      await ctx.db.patch(session._id, {
        purchase: {
          status: "not_met",
          evaluatedAt: now,
          confidence: verdict.confidence,
          reasons: verdict.reasons,
        },
      });
      return none;
    }

    const account = await ctx.db.get(args.accountId);
    const value = verdict.value ?? undefined;
    const currency =
      value !== undefined
        ? (verdict.currency ?? account?.defaultCurrency ?? "USD")
        : undefined;
    // Did a row already exist (agent marked the real sale first)? Decides
    // whether this fire deserves its own notification.
    const existing = await ctx.db
      .query("conversionEvents")
      .withIndex("by_event_id", (q) =>
        q.eq("eventId", `${args.conversationId}:purchased`),
      )
      .first();
    const { conversionEventId } = await seedStageConversionEvent(ctx, {
      accountId: args.accountId,
      conversation,
      stage: "purchased",
      ...(value !== undefined ? { value, currency } : {}),
    });
    if (!conversionEventId) {
      // Attribution vanished between read and write (belt-and-braces) —
      // record the miss instead of pretending the signal went out.
      await ctx.db.patch(session._id, {
        purchase: {
          status: "not_met",
          evaluatedAt: now,
          confidence: verdict.confidence,
          reasons: [...verdict.reasons, "conversation not attributed — no Meta lane"],
        },
      });
      return none;
    }

    await ctx.db.patch(session._id, {
      purchase: {
        status: "sent",
        evaluatedAt: now,
        confidence: verdict.confidence,
        reasons: verdict.reasons,
        ...(value !== undefined ? { value, currency } : {}),
        sentAt: now,
        conversionEventId,
      },
    });

    if (!existing) {
      const members = await ctx.db
        .query("memberships")
        .withIndex("by_account", (q) => q.eq("accountId", args.accountId))
        .collect();
      const recipients = recipientsForInbound({
        assignedToUserId: conversation.assignedToUserId ?? null,
        members: members.map((m) => ({
          userId: m.userId,
          role: m.role as AccountRole,
        })),
      });
      const body =
        (session.serviceName ?? "Qualified lead") +
        (value !== undefined ? ` · ~${value} ${currency}` : "") +
        (verdict.reasons[0] ? ` — ${verdict.reasons[0]}` : "");
      for (const userId of recipients) {
        await insertNotification(ctx, {
          accountId: args.accountId,
          userId,
          type: "purchase_signal",
          conversationId: args.conversationId,
          contactId: session.contactId,
          title: "Purchase signal sent to Meta",
          body,
        });
      }
    }
    return { fired: true };
  },
});

/**
 * The purchase-judge action — read → LLM → apply, the `analyzeInbound`
 * shape (same dry-run gate, same best-effort usage log, same
 * never-throw discipline). Scheduled by `completeQualification` and by
 * `onInbound` on post-qualification messages — INCLUDING media, which
 * the analysis pass skips: visa documents arrive as images/PDFs, and
 * "all documents received" is exactly the kind of purchase criterion
 * the owner writes.
 */
export const evaluatePurchase = internalAction({
  args: {
    accountId: v.id("accounts"),
    conversationId: v.id("conversations"),
  },
  handler: async (ctx, args): Promise<void> => {
    try {
      const context = await ctx.runQuery(
        internal.qualificationEngine.loadPurchaseContext,
        { accountId: args.accountId, conversationId: args.conversationId },
      );
      if (!context) return;

      const aiCfg = await ctx.runQuery(internal.aiConfig.loadDecrypted, {
        accountId: args.accountId,
      });
      if (!aiCfg || !aiCfg.isActive) return;

      let historyRows = await ctx.runQuery(internal.aiReply.recentMessages, {
        accountId: args.accountId,
        conversationId: args.conversationId,
        limit: aiContextMessageLimit(),
      });
      if (context.boundary) {
        const boundary = context.boundary;
        historyRows = historyRows.filter(
          (r) =>
            (r as { createdAt?: number }).createdAt === undefined ||
            (r as { createdAt?: number }).createdAt! > boundary,
        );
      }
      const messages = toChatMessages(historyRows);
      if (messages.length === 0) return;
      const latest = latestUserMessage(messages);
      // Deterministic docs-received signal: the transcript shows media
      // placeholders, and this count makes "sent N documents" explicit.
      const customerMediaCount = historyRows.filter(
        (r) =>
          r.senderType === "customer" &&
          !!r.contentType &&
          r.contentType !== "text",
      ).length;

      let criteriaExcerpts: string[] = [];
      const hasKb = await ctx.runQuery(internal.aiReply.hasKnowledgeChunks, {
        accountId: args.accountId,
      });
      if (hasKb) {
        criteriaExcerpts = await ctx.runAction(internal.aiKnowledge.retrieve, {
          accountId: args.accountId,
          queryText:
            `PURCHASE CRITERIA ${context.serviceName ?? ""} ${latest}`.trim(),
        });
      }

      const systemPrompt = buildPurchasePrompt({
        criteriaExcerpts,
        serviceName: context.serviceName,
        fields: context.fields,
        score: context.score,
        summary: context.summary,
        customerMediaCount,
      });

      let raw: string;
      if (isAiDryRun()) {
        raw = syntheticPurchaseRaw(latest);
      } else {
        // Same reasoning as the analysis pass above: the verdict is
        // parsed by `parsePurchaseVerdict`, never shown to anyone.
        const model = aiJudgeModel(aiCfg.provider, aiCfg.model);
        const gen = await generateReply({
          provider: aiCfg.provider,
          model,
          apiKey: aiCfg.apiKey,
          systemPrompt,
          messages,
          reasoningEffort: aiJudgeReasoningEffort(),
          promptCacheKey: promptCacheKey(args.accountId, "purchase"),
        });
        raw = gen.text;
        try {
          await ctx.runMutation(internal.aiUsage.log, {
            accountId: args.accountId,
            conversationId: args.conversationId,
            mode: "qualify",
            provider: aiCfg.provider,
            model,
            promptTokens: gen.usage?.promptTokens ?? 0,
            completionTokens: gen.usage?.completionTokens ?? 0,
            totalTokens: gen.usage?.totalTokens ?? 0,
            cachedPromptTokens: gen.usage?.cachedPromptTokens,
            reasoningTokens: gen.usage?.reasoningTokens,
          });
        } catch (err) {
          console.warn("[purchase signal] usage log failed:", err);
        }
      }

      const verdict = parsePurchaseVerdict(raw);
      if (!verdict) return; // malformed model output — next inbound retries

      await ctx.runMutation(internal.qualificationEngine.applyPurchaseVerdict, {
        accountId: args.accountId,
        conversationId: args.conversationId,
        verdict,
      });
    } catch (err) {
      console.error("[purchase signal] evaluation failed:", err);
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
    // An agent recorded that this customer asked not to be contacted.
    // `sendClosingMessage` is a one-shot fire scheduled once when the
    // session completes (see its own caller) — nothing re-tries it, so
    // returning null here just means the closing text never goes out;
    // there's no session/row left waiting on it, unlike `followUpContext`
    // above.
    if (blockedReason(contact) !== null) return null;
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
    // Through `insertConversation` (not a bare `ctx.db.insert`) so this
    // thread gets `awaitingReply: true` like every other newly created
    // conversation — see that helper's comment for why an omitted
    // `awaitingReply` makes the row invisible in every Inbox lane.
    const conversationId = await insertConversation(ctx, {
      accountId: args.accountId,
      contactId: contact._id,
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
  | { kind: "optOut" }
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
 * How long a thread yields after a human touches it (assignment, or a
 * manual agent reply) before scheduled nudges resume. Deliberately
 * SHORTER than a day: the anchor is the human's own last activity, so a
 * 24h period would push every resumed nudge past WhatsApp's 24h service
 * window by construction, making the whole feature depend on an approved
 * re-engagement template. At 4h the common case ("agent answered this
 * morning, customer never replied") still sends a plain text message.
 *
 * 4h mirrors `REMINDER_FIRST_MS` below — the interval this codebase
 * already treats as "a human has had a fair chance to act". Working
 * hours are applied on top, so an evening touch resumes next morning,
 * never overnight.
 */
const HUMAN_QUIET_MS = 4 * 3_600_000;

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

    // Loaded here (rather than only where it's finally used, below) so
    // the do-not-contact gate can run before EVERY branch from this
    // point on that can send or reschedule — isSessionExpired, the
    // conversation checks, aiAutoreplyDisabled, snoozedUntil,
    // humanOwned, maxFollowUps, and the working-hours clamp all follow
    // this line. The two guards above (not "collecting", not yet due)
    // stay first on purpose: they're hit on every sweep and must not
    // pay for a contact read.
    const contact = await ctx.db.get(session.contactId);
    if (!contact) return { kind: "clear" };
    // An agent recorded that this customer asked not to be contacted.
    // "optOut", not "clear" and not "skip":
    //   - "skip" leaves nextFollowUpAt in the past, so the session would
    //     stay in getDueSessions' 100-row due range and get re-offered
    //     to the sweep on every pass, forever (the livelock this gate
    //     exists to prevent).
    //   - "clear" fixes the livelock but leaves status "collecting" with
    //     no closedReason — the session then sits in the leadsBoard's
    //     "collecting" bucket forever, displayed to sales as an active
    //     lead to work, which is the opposite of the truth.
    //   - "optOut" reuses the SAME terminal status applyAnalysis already
    //     sets when the LLM classifies an inbound message's intent as
    //     "opt_out" (see the `intent === "opt_out"` branch above): status
    //     "opted_out", closedReason "opted_out". leadsBoard already
    //     buckets/caps/ranks "opted_out" as a closed status, and
    //     leads-board-view.tsx already has a `closedReason.opted_out`
    //     ("Asked to stop") i18n label — no board changes needed.
    // Placed ahead of isSessionExpired/conversation-closed on purpose:
    // "the customer asked us to stop" is a more accurate and more
    // specific closedReason than "no_response" or "conversation_closed"
    // for a session that would also independently qualify for those, so
    // do-not-contact takes precedence.
    if (blockedReason(contact) !== null) {
      return { kind: "optOut" as const };
    }

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
    // An EXPLICIT pause ("Take over" / Resume AI) is never auto-undone:
    // someone deliberately silenced the bot on this thread, so the
    // session just waits out its expiry clock. This is the one yield
    // that stays permanent — the two below are not.
    if (conversation.aiAutoreplyDisabled) return { kind: "reschedule", at: expiryRevisit };
    // A snooze is a deliberate park by a human. Same class of signal as
    // an explicit Take over, so it yields the same way — waiting out the
    // expiry clock rather than cancelling the session, since the snooze
    // will lift on its own.
    if (conversation.snoozedUntil !== undefined) {
      return { kind: "reschedule", at: expiryRevisit };
    }
    // Human activity DEFERS the nudge; it does not kill it (fix
    // 2026-07-26). Assignment and a manual reply are INCIDENTAL signals,
    // not instructions to stop: an agent answering a question is the
    // normal shape of a working thread, not a request for silence.
    //
    // Previously both rescheduled to `expiryRevisit`, so the session sat
    // untouched until the 72h clock killed it and NOT ONE nudge was ever
    // sent — silently, in exactly the case the engine exists for ("we
    // answered, the customer went quiet"). Now they yield for a bounded
    // quiet period measured from the human's own last activity, then
    // rejoin the ladder. Clamped to `expiryRevisit` so a long quiet
    // period can never strand a session past its own window.
    const humanOwned =
      !!conversation.assignedToUserId ||
      (session.humanTouchedAt !== undefined &&
        session.humanTouchedAt > session.lastCustomerMessageAt);
    if (humanOwned) {
      const anchor = Math.max(
        session.humanTouchedAt ?? 0,
        session.lastCustomerMessageAt,
      );
      const resumeAt = anchor + HUMAN_QUIET_MS;
      if (now < resumeAt) {
        return {
          kind: "reschedule",
          at: Math.min(clampToWorkingHours(resumeAt, config), expiryRevisit),
        };
      }
    }
    if (session.followUpsSent >= config.maxFollowUps) {
      return { kind: "reschedule", at: expiryRevisit };
    }
    const clamped = clampToWorkingHours(now, config);
    if (clamped > now) return { kind: "reschedule", at: clamped };

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

/**
 * Same terminal SESSION shape `applyAnalysis` already writes when the
 * LLM classifies an inbound message's intent as "opt_out" — status
 * "opted_out", closedReason "opted_out". Reused here for the
 * do-not-contact gate in `followUpContext` so both paths land the
 * session in the exact same leadsBoard bucket with the exact same
 * label, regardless of which mechanism (an agent's note vs. the
 * customer's own words) triggered it.
 *
 * Deliberately DOES NOT also patch `conversation.aiAutoreplyDisabled =
 * true` the way `applyAnalysis`'s own opt_out branch does (~line
 * 519-522). That field is a standing, supervisor-visible pause a human
 * has to lift explicitly — right for "the customer told us to stop" in
 * their own words, but wrong here: this path fires from an AGENT's
 * do-not-contact note, and auto-reply is already correctly gated on the
 * live `doNotContact` flag via `blockedReason` at every send site. If
 * this also set `aiAutoreplyDisabled`, clearing the note later (the flag
 * flips back off) would NOT resume auto-reply — the conversation would
 * stay silently dead until a supervisor separately noticed and cleared
 * this second, unrelated field too. Leaving it untouched keeps the one
 * flag (`doNotContact`) the single source of truth for this path.
 */
export const markSessionOptedOut = internalMutation({
  args: { sessionId: v.id("qualificationSessions") },
  handler: async (ctx, args): Promise<void> => {
    const session = await ctx.db.get(args.sessionId);
    if (!session || session.status !== "collecting") return;
    await ctx.db.patch(args.sessionId, {
      status: "opted_out",
      closedReason: "opted_out",
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
        case "optOut":
          await ctx.runMutation(internal.qualificationEngine.markSessionOptedOut, session);
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

/** Reverts a failed relay's claim (`delivered` → `answered`) so the
 *  `pendingAnswers` injection path can still carry the answer into the
 *  bot's next reply — an answered question must never be silently lost
 *  to one bad Meta call. */
export const unclaimAnswerDelivery = internalMutation({
  args: { inquiryId: v.id("adminInquiries") },
  handler: async (ctx, args): Promise<void> => {
    const row = await ctx.db.get(args.inquiryId);
    if (!row || row.status !== "delivered") return;
    await ctx.db.patch(args.inquiryId, { status: "answered" });
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
  ctx: {
    db: import("./_generated/server").MutationCtx["db"];
    scheduler: import("./_generated/server").MutationCtx["scheduler"];
  },
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
  // The agent accepted the offer themselves, so they are both actor and
  // target. Guarded above: this branch is only reached when the
  // conversation was still unassigned.
  await applyAssignment(ctx, {
    conversation,
    nextAssignee: offer.agentUserId,
    actorUserId: offer.agentUserId,
    source: "offer_accept",
  });
  await chargeLeadIfAgent(ctx, offer.accountId, offer.agentUserId, offer.conversationId);
  // Guarded above: this branch is only reached when the conversation was
  // still unassigned (an already-assigned one cancels the offer), so the
  // assignee genuinely changed.
  await dispatchConversationAssigned(ctx, {
    accountId: offer.accountId,
    conversationId: offer.conversationId,
    contactId: conversation.contactId,
    agentId: offer.agentUserId,
  });
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

/**
 * Tiny helper action: plain text to a staff phone.
 *
 * Meta ACCEPTS a free-form send outside the recipient's 24h customer
 * service window, hands back a wamid, then reports `failed`
 * asynchronously (code 131047, "more than 24 hours have passed since
 * the customer last replied to this number") — a failure this action's
 * own try/catch below can never see, because it already returned by the
 * time Meta's status callback lands.
 *
 * `skipWhenWindowClosed` (default `false`, i.e. always attempt — the
 * original behavior) makes that check-before-send opt-in PER CALLER,
 * because whether skipping is safe depends entirely on whether the
 * caller has a fallback channel:
 *
 * - `ingest.ts`'s SLA alert opts in (`skipWhenWindowClosed: true`). It
 *   writes an in-app `sla_alert` notification in the same mutation
 *   before this ever runs, so a skip loses nothing — and production
 *   confirms this send NEEDED gating: 442 of 856 (51.6%) silently
 *   failed the invisible way described above.
 * - `alertRoutingFailure`'s routing "exhausted"/"unroutable"/
 *   "misconfigured" admin alerts (`:2884`-ish, below) stay on the
 *   default. They have NO in-app fallback — nothing else ever tells an
 *   admin "this lead is stranded" or "routing is broken" — and,
 *   measured against live production data, they are NOT the failing
 *   case: 61 of 61 delivered (0% failure), against the SLA alert's
 *   51.6%. Gating this caller would trade a channel that already works
 *   for a silent, unrecoverable loss (self-hosted Convex keeps no log
 *   history; the existing `deliveryError` capture on the `messages` row
 *   only fires on an attempted-and-failed send, never on a skip). A
 *   rare failure here stays visible exactly the way it does today: a
 *   persisted `messages` row with `status: "failed"` and a captured
 *   `deliveryError`.
 * - The two staff replies-to-a-reply in `onAdminInbound` ("someone
 *   already took that lead", "no problem, next agent") also stay on the
 *   default — moot either way, since they fire as an immediate reply to
 *   an agent who just texted the bot, so their own window is open by
 *   construction and the check would never trip.
 *
 * When `skipWhenWindowClosed` IS set, reuses
 * `automationsEngine.resolveWindowQuery` — the same authoritative lookup
 * over the shared pure `resolveWindowState` resolver that the
 * automations send step already gates on — rather than a second,
 * qualificationEngine-local copy of the conversation lookup.
 */
export const notifyStaffText = internalAction({
  args: {
    accountId: v.id("accounts"),
    phone: v.string(),
    text: v.string(),
    skipWhenWindowClosed: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<void> => {
    try {
      const target = await ctx.runMutation(
        internal.qualificationEngine.ensureAdminConversation,
        { accountId: args.accountId, phone: args.phone },
      );
      if (args.skipWhenWindowClosed) {
        const window = await ctx.runQuery(internal.automationsEngine.resolveWindowQuery, {
          accountId: args.accountId,
          conversationId: target.conversationId,
        });
        if (!window.canSendFreeForm) {
          // Deliberately skipped, not failed — kept at a different log
          // level than the catch below purely so a live tail can tell
          // the two apart; self-hosted Convex keeps no execution
          // history here, so this is NOT a durable audit trail (that's
          // `deliveryError` on the `messages` row, for callers that
          // don't skip and hit an actual send failure instead).
          console.warn(
            "[qualification] notifyStaffText skipped: recipient's window is closed",
            { accountId: args.accountId, conversationId: target.conversationId },
          );
          return;
        }
      }
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
    // An agent recorded that this customer asked not to be contacted.
    // Returning null here leaves `inquiry.status` at "answered" — the
    // SAME terminal-looking state every other `aiEligible: false` skip
    // (human-owned thread, paused auto-reply) already leaves it in, per
    // this query's own `aiEligible` comment: nothing re-sweeps this row,
    // and the answer would only ever reach the customer through the
    // `pendingAnswers` injection on their next AI reply — which is
    // itself gated by `blockedReason` (`aiReply.ts`'s `loadDispatchContext`),
    // so a blocked contact can't receive it that way either. No separate
    // terminal state to force here.
    if (blockedReason(contact) !== null) return null;
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
 * reply (LLM-composed; deterministic in DRY-RUN). Best-effort with no
 * loss: if the immediate send can't happen (human took over, window
 * closed, Meta failure — the claim is reverted on a failed send), the
 * answer stays `answered` and reaches the customer through the
 * `pendingAnswers` knowledge injection on their next message. The
 * claim-before-send only guards against two relays double-texting.
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
          // Deliberately the account's own model, NOT the judge tier:
          // this text is sent to the customer verbatim, so it is reply
          // prose and belongs on the reply model and reply effort.
          model: aiCfg.model,
          apiKey: aiCfg.apiKey,
          systemPrompt,
          messages,
          reasoningEffort: aiReplyReasoningEffort(),
          promptCacheKey: promptCacheKey(context.accountId, "reply"),
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

      try {
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
        // Send failed AFTER the claim — un-claim so the answer stays
        // "answered" and reaches the customer through the pendingAnswers
        // injection on their next message. Nothing is lost.
        console.error("[qualification] relay send failed — un-claiming:", err);
        await ctx.runMutation(internal.qualificationEngine.unclaimAnswerDelivery, {
          inquiryId: args.inquiryId,
        });
      }
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
 * with the caller's `source` (see below), deduped via `by_contact_tag`.
 * Multiple leads on one conversation therefore stack multiple service
 * tags. Kept best-effort by the caller — a tagging hiccup must never
 * fail completion.
 *
 * `source` is a parameter defaulting to `"ai"` — the qualification path
 * that has always owned this helper. `convex/adServiceTagging.ts` passes
 * `"ad"` when it tags a contact from a click-to-WhatsApp referral before
 * qualification runs.
 */
export async function tagContactForService(
  ctx: {
    db: import("./_generated/server").MutationCtx["db"];
    scheduler: import("./_generated/server").MutationCtx["scheduler"];
  },
  args: {
    accountId: Id<"accounts">;
    contactId: Id<"contacts">;
    serviceName: string;
    /** Provenance for the `contactTags` link. Defaults to "ai" — the
     *  qualification path that has always owned this helper. */
    source?: "ai" | "ad";
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
    source: args.source ?? "ai",
  });
  // Service tagging attaches a real tag, so it fires `tag_added` too —
  // this is the path that makes "when the <service> tag lands, follow
  // up" automations work off qualification.
  await dispatchTagAdded(ctx, {
    accountId: args.accountId,
    contactId: args.contactId,
    tagId: tag._id,
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

type OfferCandidate = { userId: Id<"users">; phone: string; name: string; recent: number };

// The routing rule itself now lives in `lib/qualification/routing.ts`,
// shared with the Chasing auto-assign sweep. `FallbackCause` is
// re-exported from its new home so every existing importer of it from
// this module keeps resolving unchanged.
export type { FallbackCause };

/**
 * What the engine decided to do about a session's lead offer.
 *
 * This is a discriminated union rather than `T | null` on purpose. It
 * previously returned a bare `null` for seven distinct conditions —
 * three benign, four genuine routing failures — and the single caller
 * could not tell them apart, so every failure was swallowed as "nothing
 * to do". Because no `leadOffers` row is written in the failure cases,
 * `sweepLeadOffers` (which finds work via `by_status_offered`) could
 * never retry them either, and the lead was orphaned permanently.
 */
export type OfferDecision =
  | { kind: "noop" }
  | { kind: "unroutable"; reason: "no_agents"; serviceName: string; customerName: string }
  | {
      kind: "exhausted";
      /**
       * Which pool was actually asked. `"linked"` means only the agents
       * linked to the service tag were offered this lead and the rest of
       * the team was deliberately never asked — so an admin must not be
       * told "everyone eligible has passed", which would read as "the
       * team is busy" and invite them to deprioritise a lead that one
       * click would route.
       */
      scope: "linked" | "team";
      serviceName: string;
      customerName: string;
    }
  | {
      kind: "offer";
      /** `null` on the happy path (routed by tag); otherwise why we widened. */
      fallback: FallbackCause | null;
      /**
       * True only on the first offer attempt for this session. The
       * fallback alert is ungated WhatsApp to the owner's phone, so it
       * fires once per lead rather than once per agent walked.
       */
      firstAttempt: boolean;
      accountId: Id<"accounts">;
      conversationId: Id<"conversations">;
      contactId: Id<"contacts">;
      agent: OfferCandidate;
      serviceName: string;
      score: number | null;
      summary: string | null;
      customerName: string;
    };

/** Decides who to offer a session's lead to, and why not when nobody. */
export const offerContext = internalQuery({
  args: { sessionId: v.id("qualificationSessions") },
  handler: async (ctx, args): Promise<OfferDecision> => {
    const session = await ctx.db.get(args.sessionId);
    if (!session || session.status !== "qualified") return { kind: "noop" };
    const config = await loadEnabledConfig(ctx, session.accountId);
    if (!config || config.autoAssignEnabled === false) return { kind: "noop" };
    const conversation = await ctx.db.get(session.conversationId);
    if (!conversation || conversation.assignedToUserId) return { kind: "noop" }; // taken already
    // one live offer at a time per session
    const offers = await ctx.db
      .query("leadOffers")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
      .collect();
    if (offers.some((o) => o.status === "offered" || o.status === "accepted")) return { kind: "noop" };
    const alreadyTried = new Set(offers.map((o) => o.agentUserId));

    // A missing service name is deliberately NOT a noop. `patch.serviceName`
    // is only written `if (analysis.serviceName)`, and neither the readiness
    // nor the completion gate consults it, so a session really can reach
    // `qualified` with no service — and bailing here dropped that lead
    // exactly the way the bare `null` used to: no `leadOffers` row, so
    // `sweepLeadOffers` (which finds work on `by_status_offered`) could
    // never retry it either. It has, by definition, no routing intent that
    // COULD have been expressed, which is the same condition that licenses
    // widening inside `resolveRouting`, so it takes the fallback path
    // under its own cause.
    const serviceName = session.serviceName ?? null;
    // Same placeholder convention as the handoff/notification/board copy
    // above (`?? "New lead"` / `?? "Qualified lead"` / `?? "New inquiry"`),
    // so no admin- or agent-facing text ever interpolates "undefined".
    const serviceLabel = serviceName ?? "New inquiry";
    const contact = await ctx.db.get(session.contactId);
    const customerName = contact?.name?.trim() || contact?.phone || "a customer";

    const { eligibleById, poolIds, fallback } = await resolveRouting(ctx, {
      accountId: session.accountId,
      serviceName,
    });

    // Both no-candidate exits below answer the same question; building it
    // once is what keeps them from drifting apart.
    const nobodyLeft = (): OfferDecision =>
      alreadyTried.size > 0
        ? {
            kind: "exhausted",
            scope: fallback ? "team" : "linked",
            serviceName: serviceLabel,
            customerName,
          }
        : { kind: "unroutable", reason: "no_agents", serviceName: serviceLabel, customerName };

    const pool = poolIds.filter((id) => !alreadyTried.has(id));
    if (pool.length === 0) return nobodyLeft();

    const cutoff = Date.now() - 72 * 3_600_000;
    const candidates: OfferCandidate[] = [];
    for (const userId of pool) {
      const m = eligibleById.get(userId);
      if (!m) continue;
      const recentAccepts = await ctx.db
        .query("leadOffers")
        .withIndex("by_agent_status", (q) =>
          q.eq("agentUserId", userId).eq("status", "accepted"),
        )
        .order("desc")
        .take(10);
      candidates.push({
        userId,
        phone: m.phone,
        name: m.name,
        recent: recentAccepts.filter((o) => (o.respondedAt ?? 0) > cutoff).length,
      });
    }
    candidates.sort((a, b) => a.recent - b.recent);

    // Unreachable today — `pool ⊆ keys(eligibleById)`, so the loop above
    // never actually skips. It is here because `noUncheckedIndexedAccess`
    // is off in tsconfig, so `candidates[0]` types as `OfferCandidate`
    // rather than `| undefined`: anyone later adding a filter inside that
    // loop (an on-leave check, a rate limit) would type-check clean, hand
    // `startLeadOffer` an `undefined` agent, throw on `agent.userId`, and
    // land in the outer catch as one more silently dropped lead — the
    // exact failure this file exists to prevent.
    const agent = candidates[0];
    if (!agent) return nobodyLeft();

    return {
      kind: "offer",
      fallback,
      firstAttempt: alreadyTried.size === 0,
      accountId: session.accountId,
      conversationId: session.conversationId,
      contactId: session.contactId,
      agent,
      serviceName: serviceLabel,
      score: session.score ?? null,
      summary: session.summary ?? null,
      customerName,
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

/** Read side for `alertRoutingFailure`. */
export const routingAlertPhones = internalQuery({
  args: { accountId: v.id("accounts") },
  handler: async (ctx, args): Promise<string[]> => {
    const config = await ctx.db
      .query("qualificationConfigs")
      .withIndex("by_account", (q) => q.eq("accountId", args.accountId))
      .unique();
    return config?.adminAlertPhones ?? [];
  },
});

/**
 * Fans a routing-failure notice out to every configured admin number.
 *
 * Deliberately NOT gated on `adminAlertEnabled`. `adminAlertContext`
 * above gates the routine new-qualified-lead notification on that
 * toggle; these alerts are a different category — operational failures
 * ("your routing is broken", "this lead is stranded") that someone who
 * muted routine lead alerts still needs to see. With no admin numbers
 * configured there is no channel at all, so this no-ops.
 *
 * Best-effort, mirroring `sendAdminAlerts` above: this alert is
 * supplementary, never the thing that actually routes the lead, so a
 * failure here (say, `.unique()` tripping over a misconfigured account
 * with more than one `qualificationConfigs` row) is logged and swallowed
 * rather than propagated to the caller. `startLeadOffer` also always
 * fires the primary, agent-facing send before calling this for a used
 * fallback, precisely so this alert can never sit on the critical path.
 */
export const alertRoutingFailure = internalAction({
  args: { accountId: v.id("accounts"), text: v.string() },
  handler: async (ctx, args): Promise<void> => {
    try {
      const phones = await ctx.runQuery(internal.qualificationEngine.routingAlertPhones, {
        accountId: args.accountId,
      });
      for (const phone of phones) {
        try {
          await ctx.runAction(internal.qualificationEngine.notifyStaffText, {
            accountId: args.accountId, phone, text: args.text,
          });
        } catch (err) {
          console.error("[qualification] routing failure alert failed:", err);
        }
      }
    } catch (err) {
      console.error("[qualification] routing failure alerts failed:", err);
    }
  },
});

/**
 * The admin-facing explanation for a whole-team fallback.
 *
 * Split per cause because the remedies genuinely differ. The single old
 * message ("no agent is linked to that tag — link the right agents") is
 * outright false when someone IS linked but has no WhatsApp number, and
 * sends an admin hunting for a tag that does not exist when the tag row
 * is simply absent.
 */
function fallbackAlertText(
  cause: FallbackCause,
  serviceName: string,
  customerName: string,
): string {
  const head =
    "⚠️ Routing not configured\n" +
    `${customerName}'s lead was offered to the whole team.\n`;
  switch (cause) {
    case "no_service_name":
      return (
        head +
        "The lead qualified without the AI identifying a service, so it could not be routed " +
        "by tag. Nothing to fix in Settings — check the AI's checklist if this keeps happening."
      );
    case "tag_missing":
      return (
        head +
        `No tag named "${serviceName}" exists, so there was nothing to route by. ` +
        "Create it in Settings → Tags and link the right agents to it."
      );
    case "tag_unlinked":
      return (
        head +
        `No agent is linked to the tag "${serviceName}". ` +
        "Link the right agents to that tag in Settings → Team to route it properly."
      );
    case "links_ineligible":
      return (
        head +
        `Everyone linked to "${serviceName}" is unreachable — each is either missing a ` +
        "WhatsApp number or holds the admin or viewer role. Add a number, or change the " +
        "role, in Settings → Team."
      );
  }
}

export const startLeadOffer = internalAction({
  args: { accountId: v.id("accounts"), sessionId: v.id("qualificationSessions") },
  handler: async (ctx, args): Promise<void> => {
    try {
      const decision = await ctx.runQuery(internal.qualificationEngine.offerContext, {
        sessionId: args.sessionId,
      });
      if (decision.kind === "noop") return;
      if (decision.kind === "exhausted") {
        await ctx.runAction(internal.qualificationEngine.alertRoutingFailure, {
          accountId: args.accountId,
          text:
            `⚠️ Lead not taken\n${decision.customerName} — ${decision.serviceName}\n` +
            (decision.scope === "linked"
              // Only the linked agents were ever asked, and the rest of
              // the team was deliberately never offered this lead (see
              // the intent rule in `offerContext`). Claiming "everyone
              // eligible" here would tell an admin the team is busy and
              // invite them to deprioritise, when in fact eligible
              // colleagues were never asked and one click would route it.
              ? `Every agent linked to "${decision.serviceName}" has passed or timed out, and ` +
                "nobody else was asked. Assign this lead manually, or link more agents to that tag."
              : "Everyone eligible has passed or timed out. Please assign this lead manually."),
        });
        return;
      }
      if (decision.kind === "unroutable") {
        await ctx.runAction(internal.qualificationEngine.alertRoutingFailure, {
          accountId: args.accountId,
          text:
            `⚠️ Lead could not be routed\n${decision.customerName} — ${decision.serviceName}\n` +
            "No team member has the agent or supervisor role with a WhatsApp number. " +
            "Add one in Settings → Team, then assign this lead manually.",
        });
        return;
      }
      const context = decision;
      const offerId = await ctx.runMutation(internal.qualificationEngine.createOffer, {
        accountId: context.accountId,
        sessionId: args.sessionId,
        conversationId: context.conversationId,
        contactId: context.contactId,
        agentUserId: context.agent.userId,
        agentPhone: context.agent.phone,
      });
      if (!offerId) return;
      // Primary, agent-facing send FIRST — this is what actually routes
      // the lead, so it must never sit behind the supplementary fallback
      // alert below. If `alertRoutingFailure` threw ahead of this, the
      // offer row would already say "offered" and `offerContext`'s own
      // live-offer guard would mean the sweep cron could never retry it
      // — a silently stranded lead, exactly what this file exists to
      // prevent. (`alertRoutingFailure` also now catches its own
      // failures, so this ordering is belt-and-suspenders, not the only
      // guard.)
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
      // Once per LEAD, not once per offer attempt. On a whole-team
      // fallback every decline re-enters this action for the next
      // candidate, so an ungated alert here fired up to team-size
      // identical "Routing not configured" messages at the owner's phone
      // for a single lead — on the one channel this whole failsafe
      // depends on. `firstAttempt` is `alreadyTried.size === 0`.
      if (context.fallback && context.firstAttempt) {
        await ctx.runAction(internal.qualificationEngine.alertRoutingFailure, {
          accountId: args.accountId,
          text: fallbackAlertText(context.fallback, context.serviceName, context.customerName),
        });
      }
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
      // Customer-facing half only — gated. The agent still needs to know
      // precisely that this lead is theirs (so they see the do-not-contact
      // banner on the thread and don't chase), so that send below runs
      // unconditionally; only the intro text + contact card TO THE
      // CUSTOMER are skipped.
      if (!data.customerBlocked) {
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
          jobTitle: data.agentJobTitle,
          company: data.company,
          email: data.companyEmail,
          website: data.companyWebsite,
          companyPhone: data.companyPhone,
          address: data.companyAddress,
        });
      }
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
    // Company half of the contact card: the admin-configured
    // `contactCard` settings, with the account name as the company-name
    // fallback so the card names the business even before any setup.
    const config = await ctx.db
      .query("qualificationConfigs")
      .withIndex("by_account", (q) => q.eq("accountId", offer.accountId))
      .unique();
    const account = await ctx.db.get(offer.accountId);
    const cc = config?.contactCard;
    const address = {
      street: cc?.street,
      city: cc?.city,
      state: cc?.state,
      zip: cc?.zip,
      country: cc?.country,
      countryCode: cc?.countryCode,
    };
    const hasAddress = Object.values(address).some((s) => s?.trim());
    return {
      accountId: offer.accountId,
      customerConversationId: offer.conversationId,
      customerPhone: contact.phone,
      customerName: contact.name?.trim() || contact.phone,
      // An agent recorded that this customer asked not to be contacted.
      // Read here (not filtered by returning null) because this row also
      // carries the AGENT half of the announcement — `announceAssignment`
      // below uses this flag to skip ONLY the two customer-facing sends
      // (the intro text + contact card) while still telling the agent
      // they own the lead, same as `blockedReason`'s own doc comment:
      // "Machines are stopped; people are informed."
      customerBlocked: blockedReason(contact) !== null,
      agentName: membership.fullName ?? membership.email ?? "our travel expert",
      agentPhone: offer.agentPhone,
      agentJobTitle: membership.jobTitle,
      company: cc?.companyName?.trim() || account?.name,
      companyEmail: cc?.email,
      companyWebsite: cc?.website,
      companyPhone: cc?.phone,
      companyAddress: hasAddress ? address : undefined,
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
    // `.order("desc")` is load-bearing: `by_status_offered` is
    // `["status","offeredAt"]`, so an UNORDERED `.take(200)` returns the
    // OLDEST 200 accepted offers. `accepted` is terminal and only
    // accumulates, so past 200 a freshly-accepted offer — the one whose
    // feedback loop actually needs nudging — would never enter this sweep.
    // Newest-first keeps new acceptances reachable (the tail beyond 200 has,
    // in practice, already been reminded/escalated).
    const accepted = await ctx.db
      .query("leadOffers")
      .withIndex("by_status_offered", (q) => q.eq("status", "accepted"))
      .order("desc")
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
            // Ranged on `by_conversation_sender` so this reads only the
            // customer partition: this runs inside a loop over EVERY
            // account's staff, so each conversation's scan sums toward one
            // 4096-read budget — a post-scan `.filter()` down a long
            // outbound-heavy staff thread could blow it for the whole sweep.
            const lastMsg = await ctx.db
              .query("messages")
              .withIndex("by_conversation_sender", (q) =>
                q.eq("conversationId", conversation._id).eq("senderType", "customer"),
              )
              .order("desc")
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
          windowOpen: resolveWindowState({
            now,
            // `lastInbound` is 0 when the conversation has no customer
            // message yet. The resolver takes `undefined` for that case
            // and reports the window closed either way, which preserves
            // the `lastInbound > 0` guard this replaces.
            lastInboundAt: lastInbound > 0 ? lastInbound : undefined,
          }).csw.open,
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
