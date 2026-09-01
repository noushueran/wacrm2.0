import { accountMutation, accountQuery } from "./lib/auth";
import { v, ConvexError } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { requireConversationAccess } from "./lib/conversationAccess";
import { projectChecklist, type ChecklistProjection } from "./lib/salesChecklist";
import { defaultQualificationConfig } from "./lib/qualification/defaults";
import {
  validateConfigPatch,
  CONFIG_PATCH_KEYS,
  type QualificationConfigPatch,
} from "./lib/qualification/validate";
import { seedStageConversionEvent } from "./funnel";
import {
  effectivePipelineStage,
  PIPELINE_STAGE_KEYS,
  PURCHASE_SIGNAL_PROXY_STAGE,
  type PipelineStageKey,
} from "./lib/funnel";

/**
 * Ceiling on the deals `pipelineSummary` counts, per take.
 *
 * Sized like `dashboard.ACTIVE_CONVERSATIONS_CAP` and for the same reason:
 * past a few hundred a stage bar communicates "a lot" rather than a
 * quantity, so a fixed read cost is worth more than an exact tail. Unlike
 * `leadsBoard`'s per-status caps, this bounds a COUNT rather than a
 * rendered list, and the `capped` flag it produces is surfaced instead of
 * being silently clamped.
 */
export const QUALIFIED_PIPELINE_CAP = 500;

/** The purchase verdict shape the board/chip render — one projection so
 *  the two surfaces can never drift. */
function purchaseProjection(session: Doc<"qualificationSessions">) {
  const p = session.purchase;
  if (!p) return null;
  return {
    status: p.status,
    confidence: p.confidence,
    reasons: p.reasons,
    value: p.value ?? null,
    currency: p.currency ?? null,
    sentAt: p.sentAt ?? null,
    manual: p.manual ?? false,
  };
}

// ============================================================
// Lead-qualification config CRUD (P0 — spec §11/§12). Admin-gated on
// BOTH read and write: the config carries the admin alert phone
// numbers. The engine itself never reads through here — it uses
// `lib/qualification/track.ts`'s `loadEnabledConfig` (internal,
// caller-supplied accountId), the same split `aiConfig.loadDecrypted`
// keeps from its own settings CRUD.
//
// `patch: v.any()` + the pure `validateConfigPatch` (not a giant
// validator literal): the patch is admin-only input, the schema's own
// table validator still enforces shape on insert/patch, and the pure
// function gives friendlier errors + direct unit-testability.
// ============================================================

export const getConfig = accountQuery({
  args: {},
  handler: async (ctx) => {
    ctx.requireRole("admin");
    const row = await ctx.db
      .query("qualificationConfigs")
      .withIndex("by_account", (q) => q.eq("accountId", ctx.accountId))
      .unique();
    if (row) return { ...row, isPersisted: true as const };
    return {
      ...defaultQualificationConfig(),
      accountId: ctx.accountId,
      isPersisted: false as const,
    };
  },
});

export const updateConfig = accountMutation({
  args: { patch: v.any() },
  handler: async (ctx, args) => {
    ctx.requireRole("admin");
    // Whitelist (review fix): only known config keys survive, so a stray
    // client field fails HERE as a clean no-op instead of surfacing as a
    // raw schema-validation error from db.insert/patch.
    const raw = (args.patch ?? {}) as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    for (const key of CONFIG_PATCH_KEYS) {
      if (raw[key] !== undefined) patch[key] = raw[key];
    }

    const error = validateConfigPatch(patch as QualificationConfigPatch);
    if (error) throw new ConvexError({ code: "BAD_REQUEST", reason: error });

    const existing = await ctx.db
      .query("qualificationConfigs")
      .withIndex("by_account", (q) => q.eq("accountId", ctx.accountId))
      .unique();

    // Merge over the stored row (or the seeded defaults on first save) so
    // a partial patch — e.g. just {enabled:true} from the settings toggle
    // — always lands on a complete, schema-valid document.
    const base = existing ?? {
      ...defaultQualificationConfig(),
      accountId: ctx.accountId,
    };
    const merged = { ...base, ...patch, updatedAt: Date.now() };
    if (merged.workStartMinute >= merged.workEndMinute) {
      throw new ConvexError({
        code: "BAD_REQUEST",
        reason: "workStartMinute must be before workEndMinute",
      });
    }

    if (existing) {
      const { _id, _creationTime, ...update } = merged as typeof existing;
      await ctx.db.patch(existing._id, update);
      return existing._id;
    }
    return await ctx.db.insert("qualificationConfigs", merged);
  },
});

/**
 * Inbox chip data (spec §10): one conversation's qualification progress.
 * Access mirrors the thread itself — `requireConversationAccess(...,
 * "view")` (agents: own + unassigned; supervisor+: all; viewers may
 * look). Null when the conversation has no session (feature off, admin
 * channel, or pre-feature history) so the chip simply doesn't render.
 */
export const getSessionForConversation = accountQuery({
  args: { conversationId: v.id("conversations") },
  handler: async (ctx, args) => {
    await requireConversationAccess(ctx, args.conversationId, "view");
    const session = await ctx.db
      .query("qualificationSessions")
      .withIndex("by_conversation", (q) => q.eq("conversationId", args.conversationId))
      .order("desc")
      .first();
    if (!session || session.accountId !== ctx.accountId) return null;

    // Tooltip hint: the next thing the engine wants to know.
    let missingHint: string | null = session.pendingQuestion?.text ?? null;
    if (!missingHint && session.status === "collecting") {
      const config = await ctx.db
        .query("qualificationConfigs")
        .withIndex("by_account", (q) => q.eq("accountId", ctx.accountId))
        .unique();
      const answered = new Set(
        session.fields.filter((f) => f.confidence !== "low").map((f) => f.key),
      );
      // Same absent-row fallback as `getConfig` above: defaults apply
      // until an admin persists a config.
      const basicFields = config?.basicFields ?? defaultQualificationConfig().basicFields;
      missingHint =
        basicFields.find((f) => f.required && !answered.has(f.key))?.label ?? null;
    }

    return {
      status: session.status,
      answeredCount: session.answeredCount,
      expectedCount: session.expectedCount,
      score: session.score ?? null,
      serviceName: session.serviceName ?? null,
      ready: !!session.checklistSatisfiedAt,
      missingHint,
      // Task 6 (conversation-notes-p2): `ContactStatusHeader`'s "next
      // follow-up" line reads straight off this session — same
      // `s.nextFollowUpAt ?? null` projection `leadsBoard` already uses
      // below, added here rather than a second query for one field.
      nextFollowUpAt: session.nextFollowUpAt ?? null,
      purchase: purchaseProjection(session),
    };
  },
});

/**
 * Manual purchase signal (purchase-signals spec §3.4): a supervisor+
 * judges a qualified lead purchase-worthy case-by-case — even when the
 * automatic judge said not-met, and even when `purchaseSignalsEnabled`
 * is off (the toggle governs the AUTOMATIC judge; a manual fire is
 * explicit human intent). Seeds the same deduped
 * `${conversationId}:purchased` outbox row the automatic path uses, so
 * it can never double-send against the judge or a later real sale.
 */
export const sendPurchaseSignal = accountMutation({
  args: { sessionId: v.id("qualificationSessions") },
  handler: async (ctx, args) => {
    ctx.requireRole("supervisor");
    const session = await ctx.db.get(args.sessionId);
    if (!session || session.accountId !== ctx.accountId) {
      throw new ConvexError({ code: "NOT_FOUND", reason: "session" });
    }
    if (session.status !== "qualified") {
      throw new ConvexError({ code: "BAD_REQUEST", reason: "not_qualified" });
    }
    if (session.purchase?.status === "sent") {
      throw new ConvexError({ code: "BAD_REQUEST", reason: "already_sent" });
    }
    const conversation = await ctx.db.get(session.conversationId);
    if (!conversation || conversation.accountId !== ctx.accountId) {
      throw new ConvexError({ code: "NOT_FOUND", reason: "conversation" });
    }
    const attribution = conversation.attribution;
    const identifier =
      attribution &&
      (attribution.lane === "code" ? attribution.code : attribution.ctwaClid);
    if (!identifier) {
      // Organic chat: there is no ad click / website code to attribute
      // the Purchase to — Meta has nothing to receive.
      throw new ConvexError({ code: "BAD_REQUEST", reason: "not_attributed" });
    }

    const account = await ctx.db.get(ctx.accountId);
    const prior = session.purchase;
    const value = prior?.value;
    const currency =
      value !== undefined
        ? (prior?.currency ?? account?.defaultCurrency ?? "USD")
        : undefined;
    // Re-pointed with the automatic judge (CAPI lifecycle spec §2.4/§22):
    // a supervisor asserting "this lead is ready to buy" is a buying-intent
    // judgement, not a receipt, so it reports the SQL milestone. The
    // CONVERTED event stays reserved for a recorded payment, which on this
    // codebase means `funnel.setStage("purchased")` with its required
    // amount. See `qualificationEngine.ts`'s PURCHASE SIGNALS header.
    const { conversionEventId } = await seedStageConversionEvent(ctx, {
      accountId: ctx.accountId,
      conversation,
      stage: PURCHASE_SIGNAL_PROXY_STAGE,
      ...(value !== undefined ? { value, currency } : {}),
    });
    if (!conversionEventId) {
      throw new ConvexError({ code: "BAD_REQUEST", reason: "not_attributed" });
    }

    const now = Date.now();
    await ctx.db.patch(session._id, {
      purchase: {
        status: "sent",
        evaluatedAt: prior?.evaluatedAt ?? now,
        confidence: prior?.confidence ?? 100,
        reasons: ["Manually sent (supervisor override)", ...(prior?.reasons ?? [])],
        ...(value !== undefined ? { value, currency } : {}),
        sentAt: now,
        conversionEventId,
        manual: true,
      },
    });
    return session._id;
  },
});

// ============================================================
// The Leads workspace query (P4 — spec §10). Supervisor+ (matches the
// app's nav philosophy: agents work their assigned leads from the
// Inbox; the cross-account sales queue is a supervisor surface).
// ONE round-trip: summary counts + the score-sorted lead list with the
// joins the board renders (contact, assignee, source, answers).
// Bounded: per-status `take` caps — no unbounded collects (the
// campaigns.overview scale lesson).
// ============================================================

const LEAD_STATUSES = [
  "collecting",
  "qualified",
  "expired",
  "opted_out",
  "disqualified",
] as const;

/** The three terminal statuses the board groups behind one "Closed" filter. */
const CLOSED_LEAD_STATUSES = new Set(["expired", "opted_out", "disqualified"]);

/**
 * The board's free-text search, applied SERVER-SIDE so it spans every
 * lead rather than whichever page the browser is holding. Covers the
 * same five fields the client used to match on, in the same order.
 */
function matchesBoardSearch(
  lead: {
    contactName: string;
    contactPhone: string;
    serviceName: string | null;
    assigneeName: string | null;
    summary: string | null;
  },
  search: string | undefined,
): boolean {
  const needle = search?.trim().toLowerCase();
  if (!needle) return true;
  return [
    lead.contactName,
    lead.contactPhone,
    lead.serviceName ?? "",
    lead.assigneeName ?? "",
    lead.summary ?? "",
  ]
    .join(" ")
    .toLowerCase()
    .includes(needle);
}

export const leadsBoard = accountQuery({
  args: {
    // ── Server-side filter + page (both opt-in) ──────────────────
    // All optional, all defaulting to today's behaviour: omit
    // `pageSize` and the board returns every lead exactly as before.
    // `dashboard/leads-pipeline-card.tsx` and the Pipeline (kanban) view
    // both need the FULL list to group by stage, so they simply keep
    // calling this with `{}`.
    status: v.optional(
      v.union(v.literal("qualified"), v.literal("collecting"), v.literal("closed")),
    ),
    service: v.optional(v.string()),
    search: v.optional(v.string()),
    page: v.optional(v.number()),
    pageSize: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    // v4 RBAC (owner rule): agents work ONLY their own assigned leads;
    // supervisor+ see everything (with assignee details). Viewers have
    // no lead queue.
    ctx.requireRole("agent");
    const ownOnly = ctx.role === "agent";

    const caps: Record<(typeof LEAD_STATUSES)[number], number> = {
      collecting: 200,
      qualified: 200,
      expired: 50,
      opted_out: 50,
      disqualified: 50,
    };

    const memberships = await ctx.db
      .query("memberships")
      .withIndex("by_account", (q) => q.eq("accountId", ctx.accountId))
      .collect();
    // No `email` fallback: `members.list` nulls a member's email below
    // admin (staff PII), and this board is served to agents/supervisors —
    // a name or the generic "Member", never the email.
    const memberName = new Map(
      memberships.map((m) => [m.userId, m.fullName ?? "Member"]),
    );

    const summary: Record<string, number> = {};
    const leads: {
      sessionId: string;
      conversationId: string;
      status: string;
      origin: string;
      score: number | null;
      serviceName: string | null;
      summary: string | null;
      answeredCount: number;
      expectedCount: number;
      followUpsSent: number;
      nextFollowUpAt: number | null;
      qualifiedAt: number | null;
      closedReason: string | null;
      startedAt: number;
      contactName: string;
      contactPhone: string;
      source: "ad" | "website" | "organic";
      assigneeName: string | null;
      fields: { key: string; label: string | null; value: string; confidence: string }[];
      scoreBreakdown: { criterion: string; marks: number; maxMarks: number; reason: string | null }[];
      assignment: {
        acceptedAt: number | null;
        offersMade: number;
        lastFeedback: string | null;
        lastFeedbackAt: number | null;
      };
      funnelStage: string | null;
      funnelStageUpdatedAt: number | null;
      saleValue: number | null;
      saleCurrency: string | null;
      purchase: {
        status: "sent" | "not_met";
        confidence: number;
        reasons: string[];
        value: number | null;
        currency: string | null;
        sentAt: number | null;
        manual: boolean;
      } | null;
      checklist: ChecklistProjection | null;
    }[] = [];

    for (const status of LEAD_STATUSES) {
      const rows = await ctx.db
        .query("qualificationSessions")
        .withIndex("by_account_status", (q) =>
          q.eq("accountId", ctx.accountId).eq("status", status),
        )
        .order("desc")
        .take(caps[status]);

      for (const s of rows) {
        const contact = await ctx.db.get(s.contactId);
        const conversation = await ctx.db.get(s.conversationId);
        if (!contact || !conversation) continue;
        if (ownOnly && conversation.assignedToUserId !== ctx.userId) continue;
        const source: "ad" | "website" | "organic" =
          conversation.attribution?.lane === "ctwa" || conversation.adReferral
            ? "ad"
            : conversation.attribution?.lane === "code"
              ? "website"
              : "organic";
        // P6 assignment trail for the board (offers, acceptance, agent
        // feedback) — one small indexed collect per rendered session.
        const offers = await ctx.db
          .query("leadOffers")
          .withIndex("by_session", (q) => q.eq("sessionId", s._id))
          .collect();
        const accepted = offers
          .filter((o) => o.status === "accepted")
          .sort((a, b) => (b.respondedAt ?? 0) - (a.respondedAt ?? 0))[0];
        // The lead's sales checklist (pipeline discipline) — one indexed
        // point read per rendered session.
        const checklistRow = await ctx.db
          .query("salesChecklists")
          .withIndex("by_session", (q) => q.eq("sessionId", s._id))
          .unique();
        leads.push({
          sessionId: s._id,
          conversationId: s.conversationId,
          status: s.status,
          origin: s.origin,
          score: s.score ?? null,
          serviceName: s.serviceName ?? null,
          summary: s.summary ?? null,
          answeredCount: s.answeredCount,
          expectedCount: s.expectedCount,
          followUpsSent: s.followUpsSent,
          nextFollowUpAt: s.nextFollowUpAt ?? null,
          qualifiedAt: s.qualifiedAt ?? null,
          closedReason: s.closedReason ?? null,
          startedAt: s._creationTime,
          contactName: contact.name?.trim() || contact.phone,
          contactPhone: contact.phone, // supervisor+ always sees phones (canSeeContactPhone)
          source,
          assigneeName: conversation.assignedToUserId
            ? (memberName.get(conversation.assignedToUserId) ?? null)
            : null,
          fields: s.fields.map((f) => ({
            key: f.key,
            label: f.label ?? null,
            value: f.value,
            confidence: f.confidence,
          })),
          scoreBreakdown: (s.scoreBreakdown ?? []).map((b) => ({
            criterion: b.criterion,
            marks: b.marks,
            maxMarks: b.maxMarks,
            reason: b.reason ?? null,
          })),
          assignment: {
            acceptedAt: accepted?.respondedAt ?? null,
            offersMade: offers.length,
            lastFeedback: accepted?.feedback ?? null,
            lastFeedbackAt: accepted?.feedbackAt ?? null,
          },
          funnelStage: conversation.funnel?.stage ?? null,
          funnelStageUpdatedAt: conversation.funnel?.stageUpdatedAt ?? null,
          saleValue: conversation.funnel?.saleValue ?? null,
          saleCurrency: conversation.funnel?.saleCurrency ?? null,
          purchase: purchaseProjection(s),
          checklist: checklistRow ? projectChecklist(checklistRow, memberName) : null,
        });
      }
    }

    // The sales queue: qualified first by score desc, then in-progress by
    // score desc, then the closed states, newest first within ties.
    const statusRank: Record<string, number> = {
      qualified: 0,
      collecting: 1,
      expired: 2,
      opted_out: 3,
      disqualified: 4,
    };
    leads.sort((a, b) => {
      const rank = statusRank[a.status] - statusRank[b.status];
      if (rank !== 0) return rank;
      const score = (b.score ?? -1) - (a.score ?? -1);
      if (score !== 0) return score;
      return b.startedAt - a.startedAt;
    });

    for (const status of LEAD_STATUSES) {
      summary[status] = leads.filter((l) => l.status === status).length;
    }

    const qualifiedScores = leads
      .filter((l) => l.status === "qualified" && l.score !== null)
      .map((l) => l.score as number);
    const totalTracked = LEAD_STATUSES.reduce((n, s) => n + (summary[s] ?? 0), 0);

    // Every service present on the WHOLE board, so the service dropdown
    // keeps offering all of them. Derived client-side from `board.leads`
    // before this change, which under pagination would have quietly
    // narrowed the dropdown to the services on the current page — and
    // made the option you were filtering by vanish as you paged past it.
    const services = [...new Set(leads.map((l) => l.serviceName).filter((n): n is string => !!n))].sort();

    const matched = leads.filter((lead) => {
      if (args.status === "qualified" && lead.status !== "qualified") return false;
      if (args.status === "collecting" && lead.status !== "collecting") return false;
      if (args.status === "closed" && !CLOSED_LEAD_STATUSES.has(lead.status)) return false;
      if (args.service !== undefined && lead.serviceName !== args.service) return false;
      return matchesBoardSearch(lead, args.search);
    });

    const pageSize = Math.trunc(args.pageSize ?? 0);
    const total = matched.length;
    const paged = pageSize > 0;
    const pageCount = paged ? Math.max(1, Math.ceil(total / pageSize)) : 1;
    // Clamped, not trusted — see the identical note on `leadAnalysis.board`.
    const page = paged
      ? Math.min(Math.max(Math.trunc(args.page ?? 0), 0), pageCount - 1)
      : 0;

    return {
      summary: {
        collecting: summary.collecting ?? 0,
        qualified: summary.qualified ?? 0,
        expired: summary.expired ?? 0,
        opted_out: summary.opted_out ?? 0,
        disqualified: summary.disqualified ?? 0,
        total: totalTracked,
        qualificationRate:
          totalTracked > 0 ? Math.round(((summary.qualified ?? 0) / totalTracked) * 100) : 0,
        avgScore:
          qualifiedScores.length > 0
            ? Math.round(qualifiedScores.reduce((a, b) => a + b, 0) / qualifiedScores.length)
            : 0,
      },
      leads: paged ? matched.slice(page * pageSize, page * pageSize + pageSize) : matched,
      services,
      // Size of the FILTERED set — what the pagination control counts.
      // The `summary` above deliberately stays whole-board: those counts
      // are the filter pills' own labels, so deriving them from the
      // filtered set would make each pill report its own selection.
      total,
      page,
      pageCount,
    };
  },
});

/**
 * The deals pipeline as ~15 numbers: per-stage counts, win rate, won value
 * by currency, and how many leads are still being qualified.
 *
 * WHY THIS EXISTS ALONGSIDE `leadsBoard`. The pipeline card used to render
 * from `leadsBoard({})`, which is the right query for the /leads board and
 * exactly the wrong one for a summary: measured in production at 1,668
 * document reads and a ~2.4 MB payload — 459 fully hydrated leads, each
 * costing a contact, a conversation, an offers collect and a checklist
 * lookup, all issued SEQUENTIALLY — to draw a bar the reader takes ten
 * numbers off. This reads only what a count needs, and issues the one
 * unavoidable per-lead lookup as a single parallel wave rather than a
 * chain: ~2 round-trips instead of ~800.
 *
 * Only QUALIFIED sessions are deals, so unlike `leadsBoard` this does not
 * touch the other four statuses at all — `collecting` is reported from a
 * bounded count, not from hydrated rows.
 *
 * Deliberately NOT deduped against `reports.funnelOverview`, which also
 * reports per-stage numbers. They answer different questions: this is
 * where deals stand RIGHT NOW (one card per conversation, current stage),
 * that is how many conversations REACHED each stage within a window. A
 * conversation counts once here and in every stage it passed through
 * there.
 */
export const pipelineSummary = accountQuery({
  args: {},
  handler: async (ctx) => {
    // Same floor as `leadsBoard`: agents work only their own leads,
    // supervisor+ see everything, viewers have no lead queue at all.
    ctx.requireRole("agent");
    const ownOnly = ctx.role === "agent";

    const qualified = await ctx.db
      .query("qualificationSessions")
      .withIndex("by_account_status", (q) =>
        q.eq("accountId", ctx.accountId).eq("status", "qualified"),
      )
      .order("desc")
      .take(QUALIFIED_PIPELINE_CAP + 1);
    const capped = qualified.length > QUALIFIED_PIPELINE_CAP;
    const deals = capped ? qualified.slice(0, QUALIFIED_PIPELINE_CAP) : qualified;

    // The stage lives on the CONVERSATION, so one lookup per session is
    // unavoidable — but nothing depends across sessions, so it is one wave
    // rather than a chain. This is the whole latency difference against
    // `leadsBoard`, which awaits four reads inside its per-lead loop.
    const conversations = await Promise.all(
      deals.map((s) => ctx.db.get(s.conversationId)),
    );

    // Collapse to one deal per conversation BEFORE counting, for the reason
    // `groupLeadsByStage` gives: every session of a conversation shares its
    // single funnel stage, so counting each qualified session would count
    // one deal N times. Newest qualified session wins — the same
    // "latest session" rule `funnel.setStage`'s checklist gate uses.
    const latestByConversation = new Map<
      string,
      { startedAt: number; stage: PipelineStageKey; saleValue: number | null; saleCurrency: string | null }
    >();
    for (let i = 0; i < deals.length; i++) {
      const session = deals[i];
      const conversation = conversations[i];
      if (!conversation) continue;
      if (ownOnly && conversation.assignedToUserId !== ctx.userId) continue;
      const stage = effectivePipelineStage({
        status: session.status,
        funnelStage: conversation.funnel?.stage ?? null,
      });
      if (stage === null) continue;
      const key = conversation._id as string;
      const current = latestByConversation.get(key);
      if (current && current.startedAt >= session._creationTime) continue;
      latestByConversation.set(key, {
        startedAt: session._creationTime,
        stage,
        saleValue: conversation.funnel?.saleValue ?? null,
        saleCurrency: conversation.funnel?.saleCurrency ?? null,
      });
    }

    const counts = Object.fromEntries(
      PIPELINE_STAGE_KEYS.map((k) => [k, 0]),
    ) as Record<PipelineStageKey, number>;
    const wonByCurrency = new Map<string, number>();
    for (const deal of latestByConversation.values()) {
      counts[deal.stage] += 1;
      if (deal.stage === "purchased" && deal.saleValue && deal.saleValue > 0) {
        const currency = deal.saleCurrency ?? "USD";
        wonByCurrency.set(
          currency,
          (wonByCurrency.get(currency) ?? 0) + deal.saleValue,
        );
      }
    }

    // Still-being-qualified. A bounded count, not hydrated rows — every key
    // in this range is bound by equality, so every document read is a match
    // and the `.take()` is a genuine read bound.
    const collectingSample = await ctx.db
      .query("qualificationSessions")
      .withIndex("by_account_status", (q) =>
        q.eq("accountId", ctx.accountId).eq("status", "collecting"),
      )
      .take(QUALIFIED_PIPELINE_CAP + 1);

    const closed = counts.purchased + counts.lost;
    return {
      stages: PIPELINE_STAGE_KEYS.map((key) => ({ key, count: counts[key] })),
      total: [...latestByConversation.values()].length,
      // `null`, not 0: nothing has closed yet, which is not the same claim
      // as "nothing that closed was won".
      winRate: closed > 0 ? Math.round((counts.purchased / closed) * 100) : null,
      wonByCurrency: [...wonByCurrency.entries()].map(([currency, value]) => ({
        currency,
        value,
      })),
      inQualification: Math.min(collectingSample.length, QUALIFIED_PIPELINE_CAP),
      /** True when either take hit its ceiling, so the UI can say "500+"
       *  rather than presenting the cap as an exact figure. */
      capped: capped || collectingSample.length > QUALIFIED_PIPELINE_CAP,
    };
  },
});
