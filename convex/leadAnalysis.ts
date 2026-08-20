import { v, ConvexError } from "convex/values";
import { accountQuery, accountMutation } from "./lib/auth";
import { internalMutation } from "./_generated/server";
import { defaultLeadAnalysisConfig } from "./lib/leadAnalysis/defaults";
import { comparePriority, leadLane, type LeadLane } from "./lib/leadAnalysis/priority";
import {
  archivedForInsert,
  isArchiveReason,
  normalizeArchiveNote,
  type ArchiveReason,
} from "./lib/leadAnalysis/archive";
import { evaluateSequence, type EligibilityInput } from "./lib/leadAnalysis/eligibility";
import { bandsMissingTemplate } from "./lib/leadAnalysis/bands";
import { isWithinWorkingHours } from "./lib/leadAnalysis/sequenceSchedule";
import { claimSendSlot, dayStartFor, type SendRateState } from "./lib/leadAnalysis/sendRate";
import { clampToWorkingHours, type WorkingHoursConfig } from "./lib/qualification/schedule";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";

// ============================================================
// Lead Analysis — account-scoped surface (spec 2026-07-26).
// Config CRUD is admin-gated on BOTH read and write, mirroring
// `qualification.getConfig`: the config governs automated outbound
// spend, so it is not an agent-visible setting.
//
// `patch: v.any()` plus a key whitelist (not a giant validator literal)
// mirrors `qualification.updateConfig`: the schema's own table
// validator still enforces shape on insert/patch, and the whitelist
// turns a stray client field into a clean no-op rather than a raw
// schema-validation error.
// ============================================================

const CONFIG_PATCH_KEYS = [
  "enabled",
  "rescoreDebounceMinutes",
  "scorePerRun",
  "backfillEnabled",
  "backfillPerRun",
  "idleDaysBeforeSequence",
  "humanQuietHours",
  "dailySendCap",
  "agedOutDays",
  "bands",
] as const;

/** Bounds that keep a mis-typed admin value from melting the cron budget. */
const NUMERIC_BOUNDS: Record<string, { min: number; max: number }> = {
  rescoreDebounceMinutes: { min: 1, max: 240 },
  scorePerRun: { min: 1, max: 100 },
  backfillPerRun: { min: 1, max: 100 },
  idleDaysBeforeSequence: { min: 1, max: 90 },
  humanQuietHours: { min: 1, max: 720 },
  dailySendCap: { min: 1, max: 1000 },
  agedOutDays: { min: 7, max: 3650 },
};

export const getConfig = accountQuery({
  args: {},
  handler: async (ctx) => {
    ctx.requireRole("admin");
    const row = await ctx.db
      .query("leadAnalysisConfigs")
      .withIndex("by_account", (q) => q.eq("accountId", ctx.accountId))
      .unique();
    if (row) return { ...row, isPersisted: true as const };
    return {
      ...defaultLeadAnalysisConfig(),
      accountId: ctx.accountId,
      isPersisted: false as const,
    };
  },
});

export const updateConfig = accountMutation({
  args: { patch: v.any() },
  handler: async (ctx, args) => {
    ctx.requireRole("admin");

    const raw = (args.patch ?? {}) as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    for (const key of CONFIG_PATCH_KEYS) {
      if (raw[key] !== undefined) patch[key] = raw[key];
    }

    for (const [key, bounds] of Object.entries(NUMERIC_BOUNDS)) {
      const value = patch[key];
      if (value === undefined) continue;
      if (typeof value !== "number" || !Number.isFinite(value) ||
          value < bounds.min || value > bounds.max) {
        throw new ConvexError({
          code: "BAD_REQUEST",
          reason: `${key} must be ${bounds.min}–${bounds.max}`,
        });
      }
    }

    // Fix 1 (whole-branch review, "a duplicate-send path"): `bands`
    // passes through the `v.any()` patch with NO per-step validation of
    // its own — `NUMERIC_BOUNDS` above only ever looked at top-level
    // scalars. A step's `delayDays: 0` collapses `nextStepAt`'s
    // `clampToWorkingHours(now + 0)` to exactly `now`, and
    // `claimSequenceSlot`'s own concurrency guard
    // (`row.nextFollowUpAt > now`) is FALSE the instant `nextFollowUpAt
    // === now` — two overlapping sweep ticks can then both pass that
    // guard and both send: a duplicate real WhatsApp marketing message
    // to a real customer. The settings UI's `min={1}` is a courtesy
    // only; this is the actual correctness boundary, same relationship
    // as gate 1's template-completeness check below. Validated against
    // whatever `patch.bands` itself contains (not the merged/final
    // bands) — an invalid delay is wrong regardless of `enabled`, and a
    // step that fails here can never even reach `merged.bands`.
    if (Array.isArray(patch.bands)) {
      for (const band of patch.bands as Array<{ key?: unknown; steps?: unknown }>) {
        const steps = Array.isArray(band?.steps) ? band.steps : [];
        for (const step of steps as Array<{ delayDays?: unknown }>) {
          const delayDays = step?.delayDays;
          if (
            typeof delayDays !== "number" ||
            !Number.isInteger(delayDays) ||
            delayDays < 1 ||
            delayDays > 90
          ) {
            throw new ConvexError({
              code: "BAD_REQUEST",
              reason:
                `Each band step's delayDays must be a whole number of days from 1-90 ` +
                `(band "${String(band?.key ?? "?")}").`,
            });
          }
        }
      }
    }

    const existing = await ctx.db
      .query("leadAnalysisConfigs")
      .withIndex("by_account", (q) => q.eq("accountId", ctx.accountId))
      .unique();

    // Merge over the stored row (or the seeded defaults on first save) so
    // a partial patch always lands as a complete, schema-valid document.
    const base = existing ?? {
      ...defaultLeadAnalysisConfig(),
      accountId: ctx.accountId,
    };
    const merged = { ...base, ...patch, updatedAt: Date.now() };

    // Gate 1 (spec "THREE THINGS THE UI MUST MAKE IMPOSSIBLE TO GET
    // WRONG"): `enabled: true` can never persist while any band step
    // has no template — that step would stop every lead that reaches
    // it with `template_unavailable` (silent, not loud). Checked
    // against the FINAL merged bands (not just `patch.bands`), so a
    // patch that only flips `enabled` and leaves an already-incomplete
    // stored config alone is caught too — this is the actual
    // correctness boundary; the settings UI's disabled toggle is only
    // a courtesy that calls this exact same function.
    if (
      merged.enabled === true &&
      Array.isArray(merged.bands) &&
      bandsMissingTemplate(merged.bands)
    ) {
      throw new ConvexError({
        code: "BAD_REQUEST",
        reason:
          "Every band step needs an approved template before the follow-up sequence can be enabled.",
      });
    }

    if (existing) {
      const { _id, _creationTime, ...update } = merged as typeof existing;
      await ctx.db.patch(existing._id, update);
      return existing._id;
    }
    return await ctx.db.insert("leadAnalysisConfigs", merged);
  },
});

// ============================================================
// The Lead Analysis board (spec §"The section"). ONE round-trip:
// summary tiles plus the priority-sorted lead list with the joins the
// board renders. Bounded by an explicit `take` — no unbounded collects
// (the campaigns.overview scale lesson).
//
// RBAC mirrors `qualification.leadsBoard`: agents work ONLY their own
// assigned leads, supervisor+ see everything, viewers have no board.
// ============================================================

// A plain object (not a bare `const number`) so tests can shrink `.cap`
// to exercise the cap boundary honestly without seeding hundreds of rows
// — reassigning an imported binding is illegal under ESM live-binding
// rules, but mutating a field on an exported object is not.
export const BOARD_LIMITS = { cap: 400 };
const DAY_MS = 86_400_000;

/**
 * Name-or-phone search, applied SERVER-SIDE so it spans the whole board
 * rather than whichever page the browser happens to be holding. That is
 * the half of pagination that is easy to get wrong: once only one page
 * crosses the wire, a filter left in the client silently narrows from
 * "search the board" to "search these 25 rows".
 *
 * Digits are compared with punctuation stripped, so "500000001" finds
 * "+971 50 000 0001" — an agent reading a number off a screen rarely
 * types the spaces. Mirrors `matchesSearch` in
 * `src/components/lead-analysis/lead-analysis-filter.ts`.
 */
function matchesLeadSearch(
  lead: { contactName: string; contactPhone: string },
  search: string | undefined,
): boolean {
  const needle = search?.trim().toLowerCase();
  if (!needle) return true;
  if (`${lead.contactName} ${lead.contactPhone}`.toLowerCase().includes(needle)) {
    return true;
  }
  const digits = needle.replace(/\D/g, "");
  return digits.length > 0 && lead.contactPhone.replace(/\D/g, "").includes(digits);
}

export const board = accountQuery({
  args: {
    view: v.optional(v.union(v.literal("active"), v.literal("archived"))),
    // ── Server-side filter + page (both opt-in) ──────────────────
    // Every one of these is optional and defaults to today's behaviour:
    // omit `pageSize` and the board returns the full list exactly as it
    // always has. That is what lets the existing callers and the whole
    // test suite keep passing `{}` while /lead-analysis asks for one
    // page at a time.
    band: v.optional(
      v.union(v.literal("hot"), v.literal("warm"), v.literal("cold")),
    ),
    lane: v.optional(
      v.union(v.literal("awaiting_us"), v.literal("awaiting_them")),
    ),
    search: v.optional(v.string()),
    page: v.optional(v.number()),
    pageSize: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    ctx.requireRole("agent");
    const ownOnly = ctx.role === "agent";
    const view = args.view ?? "active";

    const memberships = await ctx.db
      .query("memberships")
      .withIndex("by_account", (q) => q.eq("accountId", ctx.accountId))
      .collect();
    const memberName = new Map(
      memberships.map((m) => [m.userId, m.fullName ?? "Member"]),
    );

    // The candidate set differs by role, but every row from either path
    // flows through the identical join/filter/sort loop below — the cap
    // and ordering choice must never change what the board's contents
    // *mean*, only which rows are eligible to be read at all.
    let rows: Array<Doc<"leadAnalyses">>;
    if (ownOnly) {
      // Agent: read the caller's OWN conversations first, ordered by
      // recency, via the existing `by_account_assigned_last_message`
      // index — never by score. This guarantees an agent's assigned
      // leads are never gated by how colleagues' leads happen to score;
      // "agents see only their own assigned leads" means *all* of theirs,
      // not the subset that out-ranks everyone else's.
      const own = await ctx.db
        .query("conversations")
        .withIndex("by_account_assigned_last_message", (q) =>
          q.eq("accountId", ctx.accountId).eq("assignedToUserId", ctx.userId),
        )
        .order("desc")
        .take(BOARD_LIMITS.cap);

      rows = [];
      for (const conversation of own) {
        // The agent path already loads each conversation, so it filters
        // on `conversation.archivedAt` directly rather than the
        // denormalised `leadAnalyses.archived` mirror — correct here
        // because this path is already bounded by the agent's own
        // assignment range, not by score, so there is no starvation risk
        // to guard against.
        const isArchived = conversation.archivedAt !== undefined;
        if (view === "archived" ? !isArchived : isArchived) continue;

        const analysis = await ctx.db
          .query("leadAnalyses")
          .withIndex("by_conversation", (q) => q.eq("conversationId", conversation._id))
          .unique();
        // A conversation with no leadAnalyses row yet (never scored, never
        // queued) simply has nothing to show on the board.
        if (analysis) rows.push(analysis);
      }
    } else {
      // Supervisor+: descending on `by_account_archived_score` puts the
      // highest scores first within the selected archive partition;
      // unscored rows (score unset) sort last, which is exactly where
      // the board wants them, so the cap never truncates a scored lead in
      // favour of an unscored one. Safe here because a supervisor's board
      // is the WHOLE account, not a subset gated by assignment — there is
      // no assignee filter downstream to defeat.
      rows = await ctx.db
        .query("leadAnalyses")
        .withIndex("by_account_archived_score", (q) =>
          q
            .eq("accountId", ctx.accountId)
            // Exact ranges, both directions. Archived rows hold `true`;
            // active rows hold `undefined` because `restore` and
            // `unarchiveOnInbound` CLEAR the field rather than writing
            // `false` (see the representation note in schema.ts).
            // Pre-archive rows also hold `undefined`, so they land in
            // the active view with no backfill.
            .eq("archived", view === "archived" ? true : undefined),
        )
        .order("desc")
        .take(BOARD_LIMITS.cap);
    }

    const now = Date.now();
    const leads: {
      analysisId: string;
      conversationId: string;
      contactName: string;
      contactPhone: string;
      score: number | null;
      band: "hot" | "warm" | "cold" | null;
      reason: string | null;
      signals: string[];
      lane: LeadLane;
      scoreStatus: string;
      lastMessageAt: number | null;
      daysSinceLastMessage: number | null;
      assigneeName: string | null;
      source: "ad" | "website" | "organic";
      serviceName: string | null;
      sequenceStatus: string;
      followUpsSent: number;
      scoredAt: number | null;
      archived: boolean;
      returnedAt: number | null;
    }[] = [];

    for (const row of rows) {
      // "skipped" is not a lead (no customer ever wrote in).
      if (row.scoreStatus === "skipped") continue;

      const conversation = await ctx.db.get(row.conversationId);
      const contact = await ctx.db.get(row.contactId);
      if (!conversation || !contact) continue;
      if (ownOnly && conversation.assignedToUserId !== ctx.userId) continue;

      // Denormalised lane source. `undefined` means "not backfilled
      // yet" and MUST fall back to the real row rather than default —
      // `leadLane` is the primitive that decides what automation may
      // touch (`lib/leadAnalysis/priority.ts`), so a guess here is a
      // safety bug, not a cosmetic one. Once the backfill has run this
      // branch is cold and the board does two point-gets per row
      // instead of four reads.
      const lastSenderType =
        conversation.lastMessageSenderType ??
        (
          await ctx.db
            .query("messages")
            .withIndex("by_conversation", (q) =>
              q.eq("conversationId", row.conversationId),
            )
            .order("desc")
            .first()
        )?.senderType ??
        null;

      // Cached at score time by `applyScore`; absent on rows scored
      // before the field existed, which fall back to the real session
      // query so their service name doesn't blank out.
      const serviceName =
        row.serviceName ??
        (
          await ctx.db
            .query("qualificationSessions")
            .withIndex("by_conversation", (q) =>
              q.eq("conversationId", row.conversationId),
            )
            .order("desc")
            .first()
        )?.serviceName ??
        null;

      const source: "ad" | "website" | "organic" =
        conversation.attribution?.lane === "ctwa" || conversation.adReferral
          ? "ad"
          : conversation.attribution?.lane === "code"
            ? "website"
            : "organic";

      leads.push({
        analysisId: row._id,
        conversationId: row.conversationId,
        contactName: contact.name?.trim() || contact.phone,
        contactPhone: contact.phone,
        score: row.score ?? null,
        band: row.band ?? null,
        reason: row.reason ?? null,
        signals: row.signals ?? [],
        lane: leadLane(lastSenderType),
        scoreStatus: row.scoreStatus,
        lastMessageAt: conversation.lastMessageAt ?? null,
        daysSinceLastMessage: conversation.lastMessageAt
          ? Math.floor((now - conversation.lastMessageAt) / DAY_MS)
          : null,
        assigneeName: conversation.assignedToUserId
          ? (memberName.get(conversation.assignedToUserId) ?? null)
          : null,
        source,
        serviceName,
        sequenceStatus: row.sequenceStatus,
        followUpsSent: row.followUpsSent,
        scoredAt: row.scoredAt ?? null,
        archived: conversation.archivedAt !== undefined,
        returnedAt: conversation.returnedAt ?? null,
      });
    }

    leads.sort(comparePriority);

    const summary = {
      hot: leads.filter((l) => l.band === "hot").length,
      warm: leads.filter((l) => l.band === "warm").length,
      cold: leads.filter((l) => l.band === "cold").length,
      awaitingUs: leads.filter((l) => l.lane === "awaiting_us").length,
      awaitingThem: leads.filter((l) => l.lane === "awaiting_them").length,
      unscored: leads.filter((l) => l.score === null).length,
      total: leads.length,
      avgScore: (() => {
        const scored = leads.filter((l) => l.score !== null).map((l) => l.score as number);
        if (scored.length === 0) return 0;
        return Math.round((scored.reduce((a, b) => a + b, 0) / scored.length) * 10) / 10;
      })(),
    };

    // The summary counts the WHOLE board, never the filtered page. The
    // tiles are how you decide which filter to apply, so recomputing
    // them from the filtered set would make the active tile echo the
    // filter you just chose and every other tile read 0.
    const matched = leads.filter((lead) => {
      if (args.band !== undefined && lead.band !== args.band) return false;
      if (args.lane !== undefined && lead.lane !== args.lane) return false;
      return matchesLeadSearch(lead, args.search);
    });

    const pageSize = Math.trunc(args.pageSize ?? 0);
    const total = matched.length;
    const paged = pageSize > 0;
    const pageCount = paged ? Math.max(1, Math.ceil(total / pageSize)) : 1;
    // Clamped, not trusted. The board is a live subscription, so the row
    // the client last counted can be archived out from under it; without
    // this, "page 5 of 5" turns into an out-of-range slice and an empty
    // list the moment someone else archives a lead.
    const page = paged
      ? Math.min(Math.max(Math.trunc(args.page ?? 0), 0), pageCount - 1)
      : 0;

    return {
      summary,
      leads: paged ? matched.slice(page * pageSize, page * pageSize + pageSize) : matched,
      // Size of the FILTERED set — what the pagination control counts.
      total,
      page,
      pageCount,
    };
  },
});

/**
 * Manual re-score. Clears `scoredThroughMs` so the sweep's dedup
 * short-circuit cannot swallow the request when the transcript has not
 * changed — a human asking again always costs a real call.
 */
export const reanalyze = accountMutation({
  args: { conversationId: v.id("conversations") },
  handler: async (ctx, args) => {
    ctx.requireRole("agent");

    const conversation = await ctx.db.get(args.conversationId);
    if (!conversation || conversation.accountId !== ctx.accountId) {
      throw new ConvexError({ code: "NOT_FOUND", reason: "conversation" });
    }
    if (ctx.role === "agent" && conversation.assignedToUserId !== ctx.userId) {
      throw new ConvexError({ code: "FORBIDDEN", reason: "not_assigned" });
    }

    const existing = await ctx.db
      .query("leadAnalyses")
      .withIndex("by_conversation", (q) => q.eq("conversationId", args.conversationId))
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, {
        scoreStatus: "pending",
        rescoreDueAt: Date.now(),
        scoredThroughMs: undefined,
        attempts: 0,
        lastError: undefined,
      });
      return existing._id;
    }

    return await ctx.db.insert("leadAnalyses", {
      accountId: ctx.accountId,
      conversationId: args.conversationId,
      contactId: conversation.contactId,
      // SYNC INVARIANT (schema.ts, `leadAnalyses.archived`): this row can
      // be an archived conversation's FIRST row (the backfill hasn't
      // reached it yet), so `archived` must mirror `archivedAt` right at
      // insert — never left to default to `undefined`, or an archived
      // lead would silently reappear on the active board.
      archived: archivedForInsert(conversation),
      scoreStatus: "pending",
      rescoreDueAt: Date.now(),
      attempts: 0,
      sequenceStatus: "idle",
      followUpsSent: 0,
    });
  },
});

// ============================================================
// sequencePreview + stopSequence (P3 Task 9). The follow-up sequence
// sends real WhatsApp marketing templates, so before an owner ever flips
// `leadAnalysisConfigs.enabled`, they need to see who it WOULD message —
// and after it's running, a way to pull one lead out by hand.
// ============================================================

/** Bounds a client-supplied preview size into [1, cap]. */
export const PREVIEW_LIMITS = { cap: 200, defaultLimit: 50 };
const PREVIEW_DAY_MS = 86_400_000;
const PREVIEW_WINDOW_MS = 7 * PREVIEW_DAY_MS;

/**
 * "Who would be messaged in the next 7 days" — meant to be run BEFORE
 * the owner ever enables the feature, so it is deliberately NOT gated on
 * `leadAnalysisConfigs.enabled`. It shares `evaluateSequence`
 * (`lib/leadAnalysis/eligibility.ts`) — the SAME gate chain
 * `leadAnalysisEngine.sequenceContext` calls at real send time — with
 * `enabled` forced to `true`. That is the only way this preview can
 * reflect the real cadence rather than drifting from it as a second,
 * hand-rolled copy of the gate logic.
 *
 * Every OTHER input (archived, conversation status, last messages,
 * qualification session, working hours, today's send cap, template
 * approval) is read fresh from the SAME tables `sequenceContext` reads,
 * assembled the same way — only the `enabled` flag itself is overridden.
 *
 * FAIL-CLOSED SURFACING (the spec's own warning: a configuration that
 * looks complete but sends nothing is the most confusing failure here):
 *   - `workingHoursKnown: false` when `qualificationConfigs` is absent,
 *     plus a top-level warning — every lead reaching tier 4 will show
 *     `stop: working_hours_unset` rather than a send that will never
 *     fire.
 *   - a top-level warning (deduped per band+step) whenever a step's
 *     template is missing or not APPROVED, alongside each affected
 *     lead's own `stop: template_unavailable` verdict.
 *
 * Bounded by an explicit `.take(limit)` over `by_account_archived_score`
 * (the same index `board` uses) — never an unbounded scan.
 */
export const sequencePreview = accountQuery({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    ctx.requireRole("supervisor");

    const limit = Math.min(
      PREVIEW_LIMITS.cap,
      Math.max(1, Math.floor(args.limit ?? PREVIEW_LIMITS.defaultLimit)),
    );

    const rawConfig = await ctx.db
      .query("leadAnalysisConfigs")
      .withIndex("by_account", (q) => q.eq("accountId", ctx.accountId))
      .unique();
    const config = rawConfig
      ? { ...defaultLeadAnalysisConfig(), ...rawConfig }
      : defaultLeadAnalysisConfig();

    const qualConfig = await ctx.db
      .query("qualificationConfigs")
      .withIndex("by_account", (q) => q.eq("accountId", ctx.accountId))
      .unique();
    const workingHoursKnown = qualConfig !== null;
    const hoursConfig: WorkingHoursConfig | null = qualConfig
      ? {
          utcOffsetMinutes: qualConfig.utcOffsetMinutes,
          workStartMinute: qualConfig.workStartMinute,
          workEndMinute: qualConfig.workEndMinute,
          workDays: qualConfig.workDays,
        }
      : null;

    const sendRateRow = await ctx.db
      .query("leadSequenceSendRate")
      .withIndex("by_account", (q) => q.eq("accountId", ctx.accountId))
      .unique();

    const now = Date.now();
    const utcOffsetMinutes = qualConfig?.utcOffsetMinutes ?? 0;
    const sendRateState: SendRateState | null = sendRateRow
      ? { dayStartMs: sendRateRow.dayStartMs, count: sendRateRow.count }
      : null;
    // READ-ONLY, same as `sequenceContext`: pure arithmetic over the
    // already-persisted counter, never a write of its own.
    const capCheck = claimSendSlot(sendRateState, now, utcOffsetMinutes, config.dailySendCap);

    const warnings: string[] = [];
    if (!workingHoursKnown) {
      warnings.push(
        "Working hours are not configured for this account (qualificationConfigs) — " +
          "every send is blocked (working_hours_unset) until they are set.",
      );
    }
    const flaggedTemplates = new Set<string>();

    // Active leads, highest score first — the same bounded, indexed read
    // `board` performs. `archived: undefined` is the exact range over
    // active rows (see the schema.ts representation note).
    const rows = await ctx.db
      .query("leadAnalyses")
      .withIndex("by_account_archived_score", (q) =>
        q.eq("accountId", ctx.accountId).eq("archived", undefined),
      )
      .order("desc")
      .take(limit);

    const leads: {
      analysisId: string;
      contactName: string;
      contactPhone: string;
      band: "hot" | "warm" | "cold";
      stepIndex: number;
      templateName: string;
      templateApproved: boolean;
      projectedSendAt: number | null;
      verdict: "send" | "reschedule" | "stop" | "archive" | "exhaust";
      reason: string | null;
    }[] = [];

    for (const row of rows) {
      // "skipped" is not a lead; a row with no resolved band has no
      // cadence to preview (evaluateSequence would say `no_band`, which
      // is a scoring-configuration question, not a scheduling one).
      if (row.scoreStatus === "skipped") continue;
      if (!row.band) continue;
      // Already terminal — nothing upcoming to preview.
      if (row.sequenceStatus === "stopped" || row.sequenceStatus === "exhausted") continue;

      const bandRule = config.bands.find((b) => b.key === row.band) ?? null;
      if (!bandRule) continue; // band key removed from config since scoring
      const stepIndex = row.followUpsSent;
      const currentStep = stepIndex < bandRule.steps.length ? bandRule.steps[stepIndex] : null;
      if (!currentStep) continue; // exhausted — evaluateSequence would archive/exhaust, not send

      const conversation = await ctx.db.get(row.conversationId);
      if (!conversation) continue;
      const contact = await ctx.db.get(row.contactId);
      if (!contact) continue;

      const [lastMessage, lastCustomerMessage, lastAgentMessage, session, template] =
        await Promise.all([
          ctx.db
            .query("messages")
            .withIndex("by_conversation", (q) => q.eq("conversationId", row.conversationId))
            .order("desc")
            .first(),
          ctx.db
            .query("messages")
            .withIndex("by_conversation_sender", (q) =>
              q.eq("conversationId", row.conversationId).eq("senderType", "customer"),
            )
            .order("desc")
            .first(),
          ctx.db
            .query("messages")
            .withIndex("by_conversation_sender", (q) =>
              q.eq("conversationId", row.conversationId).eq("senderType", "agent"),
            )
            .order("desc")
            .first(),
          ctx.db
            .query("qualificationSessions")
            .withIndex("by_conversation", (q) => q.eq("conversationId", row.conversationId))
            .order("desc")
            .first(),
          ctx.db
            .query("messageTemplates")
            .withIndex("by_account_name_lang", (q) =>
              q
                .eq("accountId", ctx.accountId)
                .eq("name", currentStep.templateName)
                .eq("language", currentStep.templateLanguage),
            )
            .first(),
        ]);

      const templateApproved = template?.status === "APPROVED";
      if (!templateApproved) {
        const key = `${row.band}:${stepIndex}`;
        if (!flaggedTemplates.has(key)) {
          flaggedTemplates.add(key);
          warnings.push(
            `Template "${currentStep.templateName || "(none configured)"}" for the ` +
              `${row.band} band's step ${stepIndex + 1} is ` +
              `${template ? `not APPROVED (status: ${template.status ?? "unknown"})` : "missing"}` +
              " — those sends will not go out.",
          );
        }
      }

      const input: EligibilityInput = {
        now,
        // FORCED true: the whole point of this preview is to be run
        // before the feature is ever enabled — see the doc comment above.
        enabled: true,
        archived: conversation.archivedAt !== undefined,
        snoozed: conversation.snoozedUntil !== undefined,
        conversationStatus: conversation.status,
        lastMessageSenderType: lastMessage?.senderType ?? "bot",
        lastCustomerMessageAt: lastCustomerMessage?._creationTime ?? null,
        lastAgentMessageAt: lastAgentMessage?._creationTime ?? null,
        idleDaysBeforeSequence: config.idleDaysBeforeSequence,
        humanQuietHours: config.humanQuietHours,
        qualification: session
          ? {
              status: session.status,
              followUpsSent: session.followUpsSent,
              maxFollowUps: qualConfig?.maxFollowUps ?? session.followUpsSent,
            }
          : null,
        optedOut: session?.status === "opted_out",
        band: bandRule,
        followUpsSent: row.followUpsSent,
        lastFollowUpAt: row.lastFollowUpAt ?? null,
        workingHoursKnown,
        withinWorkingHours: workingHoursKnown && isWithinWorkingHours(now, hoursConfig!),
        dailyCapReached: !capCheck.granted,
        templateApproved,
      };

      const verdict = evaluateSequence(input);

      // WHEN math: reuses the SAME pure schedule primitives
      // (`clampToWorkingHours`, `dayStartFor`) the arming/rescheduling
      // code already uses — never a duplicate of `evaluateSequence`'s
      // own gate conditions, only of the "when does this gate's
      // threshold pass" arithmetic for the handful of reschedule reasons
      // where that has a deterministic answer.
      let projectedSendAt: number | null = null;
      if (verdict.kind === "send") {
        projectedSendAt = now;
      } else if (verdict.kind === "reschedule") {
        if (verdict.reason === "not_idle_yet" && input.lastCustomerMessageAt !== null) {
          // Mirrors gate 5b's own threshold exactly: idle for
          // `idleDaysBeforeSequence` days since the customer's last
          // message is when this gate stops firing.
          const threshold =
            input.lastCustomerMessageAt + config.idleDaysBeforeSequence * PREVIEW_DAY_MS;
          projectedSendAt = hoursConfig ? clampToWorkingHours(threshold, hoursConfig) : threshold;
        } else if (verdict.reason === "outside_hours" && hoursConfig) {
          // Gate 10b implies hours ARE known (10a already stopped
          // otherwise) — the next window opening.
          projectedSendAt = clampToWorkingHours(now, hoursConfig);
        } else if (verdict.reason === "daily_cap" && hoursConfig) {
          // Gate 11 implies hours are known and we're within them right
          // now — the next opportunity is tomorrow's opening.
          const tomorrow = dayStartFor(now, utcOffsetMinutes) + PREVIEW_DAY_MS;
          projectedSendAt = clampToWorkingHours(tomorrow, hoursConfig);
        }
        // qualification_owns / agent_active: depends on another actor's
        // future behavior — no deterministic date, left `null`.
      }

      // Bound to the advertised 7-day window: a lead with a computed
      // date beyond it isn't part of THIS preview. Blocked/unknown-date
      // entries (`projectedSendAt: null`) are never pruned here — that
      // would silently hide exactly the fail-closed conditions this
      // query exists to surface.
      if (projectedSendAt !== null && projectedSendAt > now + PREVIEW_WINDOW_MS) continue;

      leads.push({
        analysisId: row._id,
        contactName: contact.name?.trim() || contact.phone,
        contactPhone: contact.phone,
        band: row.band,
        stepIndex,
        templateName: currentStep.templateName,
        templateApproved,
        projectedSendAt,
        verdict: verdict.kind,
        reason:
          verdict.kind === "stop" || verdict.kind === "reschedule" ? verdict.reason : null,
      });
    }

    leads.sort((a, b) => (a.projectedSendAt ?? Infinity) - (b.projectedSendAt ?? Infinity));

    return { workingHoursKnown, warnings, windowDays: 7, leads };
  },
});

/**
 * Pull a lead out of the follow-up sequence by hand (spec P3 Task 9).
 * `"manual"` is one of `STOP_REASONS` (`lib/leadAnalysis/eligibility.ts`)
 * — the same vocabulary the automated gates use, so a stopped-for-a-
 * human-reason row is indistinguishable in shape from any other stop.
 */
export const stopSequence = accountMutation({
  args: { conversationId: v.id("conversations") },
  handler: async (ctx, args) => {
    // agent+, not supervisor+ (spec 2026-07-27-inbox-lanes §RBAC). This
    // comment used to be `archive`'s, copy-pasted — neither
    // `archivedByUserId` nor "Restore is one click" has anything to do
    // with stopping a sequence, so here is what actually justifies the
    // level (final review, Finding 6).
    //
    // The spec's §UI requirement is "clock sweeps by default, agent
    // overrides": the automation nudges on a timer, and the person who
    // can tell that further nudges are pointless — a wrong number, a
    // customer who said no on the phone, a duplicate thread — is the
    // agent reading it. At supervisor+ they would have to escalate to
    // silence it, so in practice they would not, and the sequence would
    // keep sending to a lead the human has already written off. That is a
    // CUSTOMER-facing cost, unlike a wrong archive, which is internal.
    //
    // The blast radius in the other direction is small but NOT
    // self-healing, and that asymmetry is deliberate: this patches only
    // `leadAnalyses`' sequence fields — it sends nothing, hides nothing,
    // and moves the conversation out of no lane — but
    // `leadAnalysisEngine.armOnOutbound` refuses to re-arm a row whose
    // `stoppedReason` is `"manual"`, precisely so a human decision is not
    // undone by the next outbound message. So a wrong stop costs this
    // lead's automated nudges permanently, while the agent can still work
    // the thread by hand. `stoppedReason: "manual"` is what records that
    // a human, not a gate, did it.
    ctx.requireRole("agent");
    await requireOwnConversation(ctx, args.conversationId);

    const row = await ctx.db
      .query("leadAnalyses")
      .withIndex("by_conversation", (q) => q.eq("conversationId", args.conversationId))
      .unique();
    if (!row) {
      throw new ConvexError({ code: "NOT_FOUND", reason: "leadAnalyses" });
    }

    await ctx.db.patch(row._id, {
      sequenceStatus: "stopped",
      stoppedReason: "manual",
      nextFollowUpAt: undefined,
    });

    return row._id;
  },
});

// ============================================================
// Archive / restore (spec 2026-07-26 §"Changes to conversations").
//
// Agent+ (spec 2026-07-27-inbox-lanes §RBAC amends this from P2's
// supervisor+ — see the `requireRole` call in `archive`/`restore` below
// for why): archiving removes a thread from every agent's Inbox, so it
// is a queue-management act, but one the people who read the Inbox now
// perform directly.
//
// Each writer patches BOTH `conversations` and the mirrored
// `leadAnalyses.archived` — see the sync invariant in schema.ts.
// `archiveConversationCore` below is the ONLY place that performs the
// "archive" direction; `restore` and `conversations.unarchiveOnInbound`
// remain separate writers of the inverse (clear) direction.
//
// P3: the follow-up sequence's auto-archive (reason `no_response`) runs
// from a cron with no acting user, so it cannot go through the
// agent-gated `archive` mutation. It calls `archiveConversationCore`
// directly via the `archiveAutomated` internal mutation below — never a
// second copy of this logic.
// ============================================================

/** The conversation, checked for tenancy. Shared by both mutations.
 *  Typed structurally (mirrors `requireConversationAccess` in
 *  `convex/lib/conversationAccess.ts`) rather than importing the full
 *  `MutationCtx`, so it works from `accountMutation`'s custom ctx too. */
async function requireOwnConversation(
  ctx: { db: MutationCtx["db"]; accountId: Id<"accounts"> },
  conversationId: Id<"conversations">,
) {
  const conversation = await ctx.db.get(conversationId);
  if (!conversation || conversation.accountId !== ctx.accountId) {
    throw new ConvexError({ code: "NOT_FOUND", reason: "conversation" });
  }
  return conversation;
}

/**
 * The shared archive core (P3 Task 5). Holds P2's `archive` body
 * verbatim: the idempotence guard (a re-archive must not move
 * `archivedAt`, or a double-click / duplicate cron tick would reorder
 * the Archived tab) and the `unreadCount: 0` reset (load-bearing for the
 * unread badge). Both the manual `archive` mutation and the automated
 * `archiveAutomated` mutation call this — do not duplicate it at a third
 * site. Callers are responsible for their own auth/tenancy/reason
 * validation before calling in; this function only performs the write.
 */
async function archiveConversationCore(
  ctx: { db: MutationCtx["db"] },
  args: {
    conversationId: Id<"conversations">;
    reason: ArchiveReason;
    note?: string;
    byUserId?: Id<"users">;
  },
) {
  const conversation = await ctx.db.get(args.conversationId);
  if (!conversation) return;

  // Idempotent: re-archiving an archived thread must not move the
  // timestamp, or a double-click would reorder the Archived tab.
  if (conversation.archivedAt === undefined) {
    await ctx.db.patch(args.conversationId, {
      archivedAt: Date.now(),
      archivedReason: args.reason,
      archivedNote: normalizeArchiveNote(args.note),
      archivedByUserId: args.byUserId,
      // Archiving declares the thread dealt with. Clearing the unread
      // count keeps the app-wide sidebar badge honest without needing
      // an archive-aware variant of the `by_account_unread` index.
      unreadCount: 0,
      // Archived outranks both lane overrides. Clear the snooze and
      // forced-chasing marks so a stale snooze cannot resurrect the
      // thread into no lane after the wake sweep clears it.
      snoozedUntil: undefined,
      snoozedByUserId: undefined,
      snoozedReason: undefined,
      chasingForcedAt: undefined,
      chasingForcedByUserId: undefined,
    });
  }

  const analysis = await ctx.db
    .query("leadAnalyses")
    .withIndex("by_conversation", (q) => q.eq("conversationId", args.conversationId))
    .unique();
  // A conversation the backfill has not reached yet has no row; the
  // conversation is still the system of record, so this is not an error.
  if (analysis) await ctx.db.patch(analysis._id, { archived: true });
}

export const archive = accountMutation({
  args: {
    conversationId: v.id("conversations"),
    reason: v.optional(v.string()),
    note: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // agent+, not supervisor+ (spec 2026-07-27-inbox-lanes §RBAC): at
    // supervisor+ the people who actually read the Inbox cannot clear a
    // wrong number or a spam message, so Active — the one count this
    // design asks the team to drive to zero — fills with threads that
    // need no work. `archivedByUserId` records who, and Restore is one
    // click, so the blast radius is small.
    ctx.requireRole("agent");
    await requireOwnConversation(ctx, args.conversationId);

    const reason = args.reason ?? "manual";
    if (!isArchiveReason(reason)) {
      throw new ConvexError({ code: "BAD_REQUEST", reason: "unknown_archive_reason" });
    }

    await archiveConversationCore(ctx, {
      conversationId: args.conversationId,
      reason,
      note: args.note,
      byUserId: ctx.userId,
    });

    return args.conversationId;
  },
});

/**
 * The engine's auto-archive entry point (P3 Task 5). No acting user —
 * runs from the sequence sweep, so `archivedByUserId` stays unset, which
 * is the existing P2 convention for "archived by automation" (see
 * schema.ts). Not exposed to the client API; only reachable from other
 * Convex functions via `internal.leadAnalysis.archiveAutomated`.
 *
 * Takes `accountId` and verifies it against the conversation before
 * archiving, mirroring every other internal function that touches a
 * `conversationId` (`conversations.getForAccountInternal`,
 * `conversations.resolveSendTarget`, `conversations.unarchiveOnInbound`):
 * "internal" only means unreachable from a client, not immune to being
 * called with the wrong id by a caller bug or a bad join in the sweep,
 * and archiving is a customer-visible write. Returns early rather than
 * throwing on a mismatch — same shape as `unarchiveOnInbound` — so one
 * bad row skips instead of crashing the whole sweep. `leadAnalyses` rows
 * already carry `accountId`, so callers have it for free.
 */
export const archiveAutomated = internalMutation({
  args: {
    accountId: v.id("accounts"),
    conversationId: v.id("conversations"),
    reason: v.string(),
    note: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const conversation = await ctx.db.get(args.conversationId);
    if (!conversation || conversation.accountId !== args.accountId) return;

    if (!isArchiveReason(args.reason)) {
      throw new ConvexError({ code: "BAD_REQUEST", reason: "unknown_archive_reason" });
    }

    await archiveConversationCore(ctx, {
      conversationId: args.conversationId,
      reason: args.reason,
      note: args.note,
    });

    return args.conversationId;
  },
});

export const restore = accountMutation({
  args: { conversationId: v.id("conversations") },
  handler: async (ctx, args) => {
    // agent+, not supervisor+ (spec 2026-07-27-inbox-lanes §RBAC): at
    // supervisor+ the people who actually read the Inbox cannot clear a
    // wrong number or a spam message, so Active — the one count this
    // design asks the team to drive to zero — fills with threads that
    // need no work. `archivedByUserId` records who, and Restore is one
    // click, so the blast radius is small.
    ctx.requireRole("agent");
    await requireOwnConversation(ctx, args.conversationId);

    await ctx.db.patch(args.conversationId, {
      archivedAt: undefined,
      archivedReason: undefined,
      archivedNote: undefined,
      archivedByUserId: undefined,
    });

    const analysis = await ctx.db
      .query("leadAnalyses")
      .withIndex("by_conversation", (q) => q.eq("conversationId", args.conversationId))
      .unique();
    // CLEARED, not `false` — see the representation note in schema.ts.
    if (analysis) await ctx.db.patch(analysis._id, { archived: undefined });

    return args.conversationId;
  },
});
