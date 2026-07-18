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
import { recipientsForInbound } from "./lib/pushRecipients";
import type { AccountRole } from "./lib/roles";
import { normalizePhone } from "./lib/phone";
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
    if (isAdminAlertNumber(config, args.phoneNormalized)) return; // loop guard
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
      .unique();
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
    // Loop guard (spec §9, review fix): the analysis path must skip the
    // admin-alert channel just like `onInbound` does — an admin REPLYING
    // to a lead alert must never trigger paid analysis, let alone a
    // session (the alert text itself contains qualifying answers, so
    // the model could "qualify" the staff thread and echo fresh alerts).
    const contact = await ctx.db.get(conversation.contactId);
    if (contact && isAdminAlertNumber(config, contact.phoneNormalized)) return null;
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
    // Belt-and-braces admin-channel guard (loadAnalysisContext already
    // filters, but this mutation creates sessions and is independently
    // callable — it must never open one on the alert channel).
    const guardContact = await ctx.db.get(args.contactId);
    if (guardContact && isAdminAlertNumber(config, guardContact.phoneNormalized)) {
      return none;
    }
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
 * (`markHandoff`) so it is never silently dropped.
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
        await ctx.runMutation(internal.aiReply.markHandoff, {
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
    if (!config || !isAdminAlertNumber(config, args.phoneNormalized)) return;
    const pending = await ctx.db
      .query("adminInquiries")
      .withIndex("by_account_status", (q) =>
        q.eq("accountId", args.accountId).eq("status", "pending"),
      )
      .order("desc")
      .first();
    if (!pending) return;
    await ctx.db.patch(pending._id, {
      status: "answered",
      answer: args.text.trim(),
      answeredAt: Date.now(),
    });
    await ctx.scheduler.runAfter(0, internal.qualificationEngine.relayAnswerToCustomer, {
      inquiryId: pending._id,
    });
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

      const claimed = await ctx.runMutation(internal.aiReply.claimReplySlot, {
        accountId: context.accountId,
        conversationId: context.conversationId,
        maxReplies: aiCfg.autoReplyMaxPerConversation,
      });
      if (!claimed) return; // cap reached — pendingAnswers injection remains

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
      await ctx.runMutation(internal.qualificationEngine.markAnswersDelivered, {
        inquiryIds: [args.inquiryId],
      });
    } catch (err) {
      console.error("[qualification] relayAnswerToCustomer failed:", err);
    }
  },
});
