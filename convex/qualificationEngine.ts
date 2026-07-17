import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import {
  loadEnabledConfig,
  isAdminAlertNumber,
  recordInboundActivity,
  ensureSession,
} from "./lib/qualification/track";
import {
  buildAnalysisPrompt,
  parseAnalysis,
  mergeFields,
  countAnswered,
  type AnalysisResult,
} from "./lib/qualification/analyze";
import { aiContextMessageLimit } from "./lib/ai/defaults";
import { latestUserMessage } from "./lib/ai/query";
import { toChatMessages } from "./lib/ai/context";
import { generateReply } from "./lib/ai/generate";
import { applyStageTransition } from "./funnel";
import { insertNotification } from "./notifications";
import { chargeLeadIfAgent } from "./lib/leadCharge";
import { recipientsForInbound } from "./lib/pushRecipients";
import type { AccountRole } from "./lib/roles";
import { normalizePhone } from "./lib/phone";
import type { Id } from "./_generated/dataModel";

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
    if (isAdminAlertNumber(config, args.phoneNormalized)) return; // loop guard
    const conversation = await ctx.db.get(args.conversationId);
    if (!conversation || conversation.accountId !== args.accountId) return;
    if (conversation.status === "closed") return;
    await recordInboundActivity(ctx, {
      accountId: args.accountId,
      conversationId: args.conversationId,
      contactId: args.contactId,
      now: Date.now(),
    });
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
  return JSON.stringify({
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
  } | null> => {
    const config = await loadEnabledConfig(ctx, args.accountId);
    if (!config) return null;
    const conversation = await ctx.db.get(args.conversationId);
    if (!conversation || conversation.accountId !== args.accountId) return null;
    if (conversation.status === "closed") return null;
    const session = await ctx.db
      .query("qualificationSessions")
      .withIndex("by_conversation", (q) => q.eq("conversationId", args.conversationId))
      .unique();
    if (session && session.status !== "collecting") return null; // terminal
    return {
      serviceName: session?.serviceName ?? null,
      knownFields: (session?.fields ?? []).map((f) => ({ key: f.key, value: f.value })),
      basicFields: config.basicFields,
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
 * which routes through `aiReply.markHandoff`.
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
    const now = Date.now();
    const sessionId = await ensureSession(ctx, {
      accountId: args.accountId,
      conversationId: args.conversationId,
      contactId: args.contactId,
      origin: "inbound",
      now,
    });
    const session = await ctx.db.get(sessionId);
    if (!session || session.status !== "collecting") return none;

    const analysis = args.analysis as AnalysisResult;
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

      const historyRows = await ctx.runQuery(internal.aiReply.recentMessages, {
        accountId: args.accountId,
        conversationId: args.conversationId,
        limit: aiContextMessageLimit(),
      });
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
        await ctx.runMutation(internal.aiReply.markHandoff, {
          accountId: args.accountId,
          conversationId: args.conversationId,
          handoffAgentId: aiCfg.handoffAgentId ?? undefined,
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
  } | null> => {
    const config = await loadEnabledConfig(ctx, args.accountId);
    if (!config) return null;
    const session = await ctx.db
      .query("qualificationSessions")
      .withIndex("by_conversation", (q) => q.eq("conversationId", args.conversationId))
      .unique();
    if (!session || session.status !== "collecting") return null;
    if (session.accountId !== args.accountId) return null;

    const collected = session.fields
      .filter((f) => f.confidence !== "low")
      .map((f) => ({ label: f.label ?? f.key, value: f.value }));

    let nextQuestion: string | null = session.pendingQuestion?.text ?? null;
    if (!nextQuestion) {
      const answered = new Set(
        session.fields.filter((f) => f.confidence !== "low").map((f) => f.key),
      );
      const missing = config.basicFields.find(
        (f) => f.required && !answered.has(f.key),
      );
      nextQuestion = missing?.phrasings[0] ?? null;
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
      .unique();
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

    // Handoff to the human queue — mirrors `aiReply.markHandoff` (kept
    // inline: a mutation cannot runMutation another; parity is pinned by
    // the tests). Assigns the AI config's handoff agent only when the
    // thread is unassigned, and the idempotent lead charge follows the
    // same rule as every other assignment path.
    const answers = session.fields
      .filter((f) => f.confidence !== "low")
      .map((f) => `${f.label ?? f.key}: ${f.value}`)
      .join(" · ");
    const summary =
      `🎯 Qualified lead (score ${session.score ?? "–"}/100)` +
      (session.serviceName ? ` — ${session.serviceName}` : "") +
      (session.summary ? `: ${session.summary}` : "") +
      (answers ? `. ${answers}` : "");
    const aiCfg = await ctx.db
      .query("aiConfigs")
      .withIndex("by_account", (q) => q.eq("accountId", args.accountId))
      .unique();
    const assignTo =
      !conversation.assignedToUserId && aiCfg?.handoffAgentId
        ? aiCfg.handoffAgentId
        : undefined;
    await ctx.db.patch(args.conversationId, {
      aiAutoreplyDisabled: true,
      status: "pending",
      aiHandoffSummary: summary,
      updatedAt: now,
      ...(assignTo ? { assignedToUserId: assignTo } : {}),
    });
    if (assignTo) {
      await chargeLeadIfAgent(ctx, args.accountId, assignTo, args.conversationId);
    }

    // In-app bell notifications: the assignee if any, else everyone who
    // works the shared pool (supervisor+ — same rule as inbound push).
    const members = await ctx.db
      .query("memberships")
      .withIndex("by_account", (q) => q.eq("accountId", args.accountId))
      .collect();
    const recipients = recipientsForInbound({
      assignedToUserId: assignTo ?? conversation.assignedToUserId ?? null,
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
    const session = await ctx.db
      .query("qualificationSessions")
      .withIndex("by_conversation", (q) => q.eq("conversationId", args.conversationId))
      .unique();
    if (!session || session.accountId !== args.accountId) return null;
    if (session.status !== "qualified") return null;
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
      const contactId = await ctx.db.insert("contacts", {
        accountId: args.accountId,
        phone: args.phone,
        phoneNormalized,
        name: "Lead alerts (staff)",
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
