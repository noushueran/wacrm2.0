import { accountMutation, accountQuery } from "./lib/auth";
import { internal } from "./_generated/api";
import { v, ConvexError } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { internalMutation } from "./_generated/server";
import { requireConversationAccess } from "./lib/conversationAccess";
import { normalizePhone } from "./lib/phone";
import {
  resolveEventName,
  backendForLane,
  getStage,
  FUNNEL_STAGE_KEYS,
  type FunnelStageKey,
} from "./lib/funnel";
import { allItemsDone, isLossCategory } from "./lib/salesChecklist";
import {
  emptyStageCounts,
  emptyEventStatusCounts,
} from "./lib/reportStats";
import { hourStartMs } from "./lib/messageStats";

/** The backfill walks whole UTC days even though it STORES hours — one
 *  source read per day instead of 24. These two are local to that walk;
 *  the stored bucket key is always an hour. */
const DAY_MS_LOCAL = 86_400_000;
const dayFloor = (ms: number) => Math.floor(ms / DAY_MS_LOCAL) * DAY_MS_LOCAL;

const STAGE_VALIDATOR = v.union(
  v.literal("new_lead"),
  v.literal("qualified"),
  v.literal("price_quoted"),
  v.literal("itinerary_created"),
  v.literal("itinerary_sent"),
  v.literal("invoice_sent"),
  v.literal("purchased"),
  v.literal("lost"),
);

/**
 * Advances one conversation's funnel stage (agent-driven). Records the
 * denormalized current stage on the conversation, appends a
 * `funnelTransitions` audit row, and — for an ATTRIBUTED conversation whose
 * stage maps to a Meta event on its lane — seeds a deduped `conversionEvents`
 * row and schedules Phase 1's dispatcher (dormant without env). Organic
 * conversations and internal-only stages (`itinerary_created`) record CRM
 * state only. `purchased` requires a positive `saleValue`.
 *
 * Access mirrors `conversations.setStatus`: `requireRole("agent")` (viewers
 * excluded) + `requireConversationAccess(..., "own")` (agents may only act on
 * a conversation assigned to them; supervisor+ act on any).
 */
/**
 * Seeds the deduped `conversionEvents` outbox row for one (conversation,
 * stage) and schedules Phase 1's dispatcher — extracted from
 * `applyStageTransition` so the purchase-signal engine can fire the
 * `purchased` Meta event WITHOUT moving the operational funnel stage
 * (spec 2026-07-19-purchase-signals §3.3). Reuses the first-touch
 * (new_lead) row as the anchor for the Platform A contract fields
 * (phone/waMessageId/firstMessageAt). Returns the existing row's id on
 * an eventId hit (never re-schedules delivery — the
 * `${conversationId}:${stage}` dedup is what makes the proxy fire and a
 * later real sale structurally unable to double-send), and `undefined`
 * for unattributed conversations, unmapped stages, or a missing lane
 * identifier.
 */
export async function seedStageConversionEvent(
  ctx: { db: MutationCtx["db"]; scheduler: MutationCtx["scheduler"] },
  args: {
    accountId: Id<"accounts">;
    conversation: Doc<"conversations">;
    stage: FunnelStageKey;
    value?: number;
    currency?: string;
  },
): Promise<{ conversionEventId: Id<"conversionEvents"> | undefined }> {
  const { conversation, stage } = args;
  const conversationId = conversation._id;
  const hasValue = args.value !== undefined && args.value > 0;

  let conversionEventId: Id<"conversionEvents"> | undefined;
  const attribution = conversation.attribution;
  if (attribution) {
    const eventName = resolveEventName(attribution.lane, stage);
    const identifier =
      attribution.lane === "code" ? attribution.code : attribution.ctwaClid;
    if (eventName && identifier) {
      const eventId = `${conversationId}:${stage}`;
      const existing = await ctx.db
        .query("conversionEvents")
        .withIndex("by_event_id", (q) => q.eq("eventId", eventId))
        .first();
      if (existing) {
        conversionEventId = existing._id;
      } else {
        const anchor = await ctx.db
          .query("conversionEvents")
          .withIndex("by_event_id", (q) =>
            q.eq("eventId", `${conversationId}:new_lead`),
          )
          .first();
        const contact = await ctx.db.get(conversation.contactId);
        conversionEventId = await ctx.db.insert("conversionEvents", {
          accountId: args.accountId,
          conversationId,
          contactId: conversation.contactId,
          // `lost` can never reach here (resolveEventName returns null for
          // it, so the eventName guard above filters it) — the narrow cast
          // records that invariant instead of widening the events schema.
          stage: stage as Exclude<FunnelStageKey, "lost">,
          lane: attribution.lane,
          backend: backendForLane(attribution.lane),
          eventName,
          identifier,
          ...(hasValue ? { value: args.value, currency: args.currency } : {}),
          phone: anchor?.phone ?? (contact ? normalizePhone(contact.phone) : ""),
          waMessageId: anchor?.waMessageId ?? "",
          firstMessageAt: anchor?.firstMessageAt ?? attribution.firstSeenAt,
          eventId,
          status: "pending",
          attempts: 0,
        });
        // Rollup: this row starts life `pending` in TODAY's bucket. Every
        // later status change moves it within this same bucket — see
        // `moveConversionEventStatusInRollup`.
        await recordConversionEventInRollup(ctx, {
          accountId: args.accountId,
          atMs: Date.now(),
          status: "pending",
        });
        await ctx.scheduler.runAfter(
          0,
          internal.conversionEvents.deliverConversionEvent,
          { conversionEventId },
        );
      }
    }
  }
  return { conversionEventId };
}

// ============================================================
// funnelDailyStats maintenance — the write half of the /reports Funnel
// tab's rollup. See that table's comment in schema.ts for why the rollup
// exists and why every counter in it is additive.
//
// These live in this module rather than a `lib/` one because they touch
// the database, and `lib/reportStats.ts` is deliberately database-free so
// a `'use client'` panel can import from it. `conversionEvents.ts` already
// imports `applyStageTransition` from here, so the dependency direction is
// established and there is no cycle.
// ============================================================

/** Read-modify-write one account-HOUR bucket, creating it on first touch. */
async function patchFunnelHour(
  ctx: { db: MutationCtx["db"] },
  accountId: Id<"accounts">,
  atMs: number,
  mutate: (row: {
    stageFirstReached: ReturnType<typeof emptyStageCounts>;
    purchaseValueTotal: number;
    eventsByStatus: ReturnType<typeof emptyEventStatusCounts>;
  }) => void,
): Promise<void> {
  const hour = hourStartMs(atMs);
  const existing = await ctx.db
    .query("funnelHourlyStats")
    .withIndex("by_account_hour", (q) =>
      q.eq("accountId", accountId).eq("hourStartMs", hour),
    )
    .unique();
  const row = existing
    ? {
        stageFirstReached: { ...existing.stageFirstReached },
        purchaseValueTotal: existing.purchaseValueTotal,
        eventsByStatus: { ...existing.eventsByStatus },
      }
    : {
        stageFirstReached: emptyStageCounts(),
        purchaseValueTotal: 0,
        eventsByStatus: emptyEventStatusCounts(),
      };
  mutate(row);
  if (existing) await ctx.db.patch(existing._id, row);
  else await ctx.db.insert("funnelHourlyStats", { accountId, hourStartMs: hour, ...row });
}

/**
 * Fold a stage transition into the rollup. Called from
 * `applyStageTransition` BEFORE it writes the transition row, so the
 * "has this conversation been here before?" question is asked against the
 * log as it stood without this transition in it.
 *
 * Two things happen, and only the first is conditional:
 *   - if this is the conversation's FIRST EVER arrival at `stage`, its day
 *     bucket's `stageFirstReached[stage]` goes up by one. That is what
 *     makes the counter additive across buckets — see schema.ts.
 *   - a `purchased` transition's recorded value is folded in. A REVISION
 *     (a second purchased transition carrying a different amount) adjusts
 *     the bucket the original landed in by the difference, so the total
 *     tracks the current recorded value rather than the first one quoted.
 */
export async function recordTransitionInRollup(
  ctx: { db: MutationCtx["db"] },
  args: {
    accountId: Id<"accounts">;
    conversationId: Id<"conversations">;
    stage: FunnelStageKey;
    atMs: number;
    saleValue?: number;
  },
): Promise<void> {
  // A conversation's own transition history — bounded by its number of
  // stage moves (single digits in practice), not by account size.
  const prior = await ctx.db
    .query("funnelTransitions")
    .withIndex("by_conversation", (q) =>
      q.eq("conversationId", args.conversationId),
    )
    .collect();
  const priorSameStage = prior.filter((t) => t.stage === args.stage);
  const isFirstReach = priorSameStage.length === 0;

  if (isFirstReach) {
    await patchFunnelHour(ctx, args.accountId, args.atMs, (row) => {
      row.stageFirstReached[args.stage] += 1;
      if (args.stage === "purchased" && args.saleValue !== undefined) {
        row.purchaseValueTotal += args.saleValue;
      }
    });
    return;
  }

  // Not a first reach. The only thing that can still change is the money:
  // adjust the ORIGINAL purchase's bucket by the delta so no conversation
  // is ever counted twice and no revision is silently dropped.
  if (args.stage !== "purchased" || args.saleValue === undefined) return;
  const original = priorSameStage.reduce((a, b) =>
    a._creationTime <= b._creationTime ? a : b,
  );
  const previousValue =
    priorSameStage
      .slice()
      .sort((a, b) => b._creationTime - a._creationTime)
      .find((t) => t.saleValue !== undefined)?.saleValue ?? 0;
  const delta = args.saleValue - previousValue;
  if (delta === 0) return;
  await patchFunnelHour(ctx, args.accountId, original._creationTime, (row) => {
    row.purchaseValueTotal += delta;
  });
}

/** Fold a newly created conversion event into its creation day's bucket. */
export async function recordConversionEventInRollup(
  ctx: { db: MutationCtx["db"] },
  args: {
    accountId: Id<"accounts">;
    atMs: number;
    status: Doc<"conversionEvents">["status"];
  },
): Promise<void> {
  await patchFunnelHour(ctx, args.accountId, args.atMs, (row) => {
    row.eventsByStatus[args.status] += 1;
  });
}

/**
 * Move a conversion event between status counters, in the bucket of the
 * day it was CREATED — never the day the status changed.
 *
 * That choice is what keeps a mutable field exact in an immutable-looking
 * rollup: the event contributes to exactly one bucket for its whole life,
 * and a retry that flips it pending -> sent moves it WITHIN that bucket. A
 * change-day rollup would leave it counted in two.
 *
 * A no-op when the status has not actually changed, so a patch that
 * rewrites other fields costs nothing here.
 */
export async function moveConversionEventStatusInRollup(
  ctx: { db: MutationCtx["db"] },
  args: {
    accountId: Id<"accounts">;
    createdAtMs: number;
    from: Doc<"conversionEvents">["status"];
    to: Doc<"conversionEvents">["status"];
  },
): Promise<void> {
  if (args.from === args.to) return;
  await patchFunnelHour(ctx, args.accountId, args.createdAtMs, (row) => {
    // Clamped at zero. The decrement is only wrong if a row was created
    // before the rollup existed and never backfilled; letting that drive a
    // counter negative would turn one missing row into a permanently wrong
    // total rather than a one-off undercount.
    row.eventsByStatus[args.from] = Math.max(0, row.eventsByStatus[args.from] - 1);
    row.eventsByStatus[args.to] += 1;
  });
}

/**
 * Rebuild `funnelHourlyStats` from the real rows, a batch of UTC days per
 * call, fanning each day's rows into its 24 hour buckets.
 *
 * ASSIGNMENT, NOT INCREMENT. Each call computes a day's counters in full
 * from `funnelTransitions`/`conversionEvents` and writes them absolutely.
 * That is deliberate: this repo has already had a self-scheduling backfill
 * inflate production ~1.8x because two chains overlapped and both applied
 * `+=`. An absolute write converges instead — re-running, or running twice
 * at once, cannot double anything.
 *
 * The trade is the mirror image: a concurrent LIVE write (a stage move, a
 * delivery retry) landing on a day this backfill is mid-way through
 * recomputing will be overwritten by the recomputed figure. That figure is
 * derived from the same rows, so it is only wrong if the live write beat
 * the backfill's read of its own row — a sub-second window, on a day
 * already being rebuilt. Run it when the account is quiet, and if in doubt
 * re-run it: convergence is the whole point.
 *
 * Walks NEWEST day backwards, so the range a report is most likely to ask
 * for is correct first. Stops when it passes the oldest transition or
 * event. Idempotent and resumable — pass no args to start.
 */
/** UTC days rebuilt per `backfillFunnelHourlyStats` call. The walk is still
 *  day-at-a-time — one source read per day, fanned into that day's 24 hour
 *  buckets — because reading 24 separate hour ranges would be 24x the
 *  queries for the same rows. Sized so a typical account's whole history
 *  finishes in a handful of hops while one call stays well inside a
 *  mutation's budget. */
const BACKFILL_DAYS_PER_CALL = 30;

export const backfillFunnelHourlyStats = internalMutation({
  args: {
    accountId: v.optional(v.id("accounts")),
    /** UTC day to rebuild. Absent = today. Threaded by the self-schedule. */
    dayStartMs: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<void> => {
    const accounts = await ctx.db.query("accounts").collect();
    if (accounts.length === 0) return;
    const index = args.accountId
      ? accounts.findIndex((a) => a._id === args.accountId)
      : 0;
    if (index < 0) return; // account vanished mid-backfill; nothing to resume
    const account = accounts[index]!;

    const advanceToNextAccount = async () => {
      const next = accounts[index + 1];
      if (!next) return;
      await ctx.scheduler.runAfter(0, internal.funnel.backfillFunnelHourlyStats, {
        accountId: next._id,
      });
    };

    const firstDay = args.dayStartMs ?? dayFloor(Date.now());

    // Oldest row of either kind decides where this account's walk stops.
    const [oldestTransition, oldestEvent] = await Promise.all([
      ctx.db
        .query("funnelTransitions")
        .withIndex("by_account", (q) => q.eq("accountId", account._id))
        .order("asc")
        .first(),
      ctx.db
        .query("conversionEvents")
        .withIndex("by_account", (q) => q.eq("accountId", account._id))
        .order("asc")
        .first(),
    ]);
    const oldestMs = Math.min(
      oldestTransition?._creationTime ?? Infinity,
      oldestEvent?._creationTime ?? Infinity,
    );
    if (!Number.isFinite(oldestMs) || firstDay < dayFloor(oldestMs)) {
      await advanceToNextAccount();
      return;
    }
    const oldestDay = dayFloor(oldestMs);

    // A BATCH of days per call, not one. The walk is bounded by the
    // account's age, so one-day-per-call turns a two-year history into ~730
    // scheduler hops for work that is individually tiny. Batching also lets
    // a short history finish inside the first, synchronous call — which is
    // what makes this testable without a faked timer queue to pump.
    let day = firstDay;
    for (let processed = 0; processed < BACKFILL_DAYS_PER_CALL; processed++) {
      if (day < oldestDay) {
        await advanceToNextAccount();
        return;
      }
      await rebuildFunnelDay(ctx, account._id, day);
      day -= DAY_MS_LOCAL;
    }

    await ctx.scheduler.runAfter(0, internal.funnel.backfillFunnelHourlyStats, {
      accountId: account._id,
      dayStartMs: day,
    });
  },
});

/** Recompute ONE account-day's counters from the source rows and write them
 *  absolutely. Split out of the backfill's handler so the day loop above
 *  reads as a loop rather than as a wall of index ranges. */
async function rebuildFunnelDay(
  ctx: { db: MutationCtx["db"] },
  accountId: Id<"accounts">,
  day: number,
): Promise<void> {
  const dayEnd = day + DAY_MS_LOCAL;

  const [transitions, events] = await Promise.all([
    ctx.db
      .query("funnelTransitions")
      .withIndex("by_account", (q) =>
        q.eq("accountId", accountId).gte("_creationTime", day).lt("_creationTime", dayEnd),
      )
      .collect(),
    ctx.db
      .query("conversionEvents")
      .withIndex("by_account", (q) =>
        q.eq("accountId", accountId).gte("_creationTime", day).lt("_creationTime", dayEnd),
      )
      .collect(),
  ]);

  // One accumulator per HOUR of this day that actually saw a row. The day
  // is the read unit (one index range instead of 24) but the hour is the
  // storage unit — see the table comment for why the bucket has to be an
  // hour.
  type Bucket = {
    stageFirstReached: ReturnType<typeof emptyStageCounts>;
    purchaseValueTotal: number;
    eventsByStatus: ReturnType<typeof emptyEventStatusCounts>;
  };
  const byHour = new Map<number, Bucket>();
  const bucketAt = (atMs: number): Bucket => {
    const key = hourStartMs(atMs);
    let row = byHour.get(key);
    if (!row) {
      row = {
        stageFirstReached: emptyStageCounts(),
        purchaseValueTotal: 0,
        eventsByStatus: emptyEventStatusCounts(),
      };
      byHour.set(key, row);
    }
    return row;
  };

  // Whether a transition is its conversation's FIRST arrival at that stage
  // can only be decided against the conversation's WHOLE history, not
  // against this day — a `by_conversation` read per row, bounded by that
  // one conversation's stage moves (single digits), not by account size.
  const historyCache = new Map<string, Doc<"funnelTransitions">[]>();
  const historyOf = async (conversationId: Id<"conversations">) => {
    const key = conversationId as string;
    const hit = historyCache.get(key);
    if (hit) return hit;
    const rows = await ctx.db
      .query("funnelTransitions")
      .withIndex("by_conversation", (q) => q.eq("conversationId", conversationId))
      .collect();
    historyCache.set(key, rows);
    return rows;
  };

  // Legacy value fallback, matching `funnelOverview`'s own: a transition
  // written before Task B1 carries no `saleValue`, and the only place that
  // amount survives is the matching conversionEvents row, joined on the
  // same `${conversationId}:${stage}` key its dedup uses.
  const legacyValueFor = async (
    conversationId: Id<"conversations">,
  ): Promise<number | undefined> => {
    const evs = await ctx.db
      .query("conversionEvents")
      .withIndex("by_event_id", (q) =>
        q.eq("eventId", `${conversationId}:purchased`),
      )
      .first();
    return evs?.value;
  };

  for (const tr of transitions) {
    const history = await historyOf(tr.conversationId);
    const sameStage = history.filter((h) => h.stage === tr.stage);
    const earliest = sameStage.reduce(
      (a, b) => (a._creationTime <= b._creationTime ? a : b),
      sameStage[0]!,
    );
    // Only the conversation's earliest arrival at this stage counts, and
    // only when that arrival is the row in hand — so a stage reached twice
    // contributes to exactly one bucket, ever.
    if (earliest._id !== tr._id) continue;
    const bucket = bucketAt(tr._creationTime);
    bucket.stageFirstReached[tr.stage] += 1;

    if (tr.stage !== "purchased") continue;
    const latestWithValue = sameStage
      .slice()
      .sort((a, b) => b._creationTime - a._creationTime)
      .find((h) => h.saleValue !== undefined);
    const value =
      latestWithValue?.saleValue ?? (await legacyValueFor(tr.conversationId));
    if (value !== undefined) bucket.purchaseValueTotal += value;
  }

  for (const ev of events) {
    bucketAt(ev._creationTime).eventsByStatus[ev.status] += 1;
  }

  // Absolute write over every EXISTING bucket in this day as well as every
  // computed one, so an hour whose rows no longer qualify is zeroed rather
  // than left stale.
  const existingRows = await ctx.db
    .query("funnelHourlyStats")
    .withIndex("by_account_hour", (q) =>
      q.eq("accountId", accountId).gte("hourStartMs", day).lt("hourStartMs", dayEnd),
    )
    .collect();
  const existingByHour = new Map(existingRows.map((r) => [r.hourStartMs, r]));

  for (const [hour, bucket] of byHour) {
    const existing = existingByHour.get(hour);
    if (existing) await ctx.db.patch(existing._id, bucket);
    else await ctx.db.insert("funnelHourlyStats", { accountId, hourStartMs: hour, ...bucket });
    existingByHour.delete(hour);
  }
  for (const stale of existingByHour.values()) await ctx.db.delete(stale._id);
}


/**
 * The stage-advance core, shared by the authed `setStage` below and the
 * qualification engine's `completeQualification` (spec §9 — the
 * "internal stage-advance" the design calls for). Byte-identical
 * behavior for the authed path; two engine-only additions:
 *   - `auto` + optional `byUserId` (an engine transition has no user);
 *   - `neverDowngrade`: skip entirely when the conversation already sits
 *     at or past `stage` (a human may have advanced it to price_quoted
 *     while the bot was still collecting — the engine must never pull it
 *     back). Returns whether a transition was applied.
 */
export async function applyStageTransition(
  ctx: { db: MutationCtx["db"]; scheduler: MutationCtx["scheduler"] },
  args: {
    accountId: Id<"accounts">;
    conversation: Doc<"conversations">;
    stage: FunnelStageKey;
    byUserId?: Id<"users">;
    auto: boolean;
    saleValue?: number;
    saleCurrency?: string;
    defaultCurrency: string;
    neverDowngrade?: boolean;
    // Set only on `lost` transitions — persisted onto the audit row.
    lossCategory?: string;
    lossDetail?: string;
  },
): Promise<{ applied: boolean }> {
  const { conversation, stage } = args;
  const conversationId = conversation._id;

  if (args.neverDowngrade && conversation.funnel?.stage) {
    const currentIdx = FUNNEL_STAGE_KEYS.indexOf(conversation.funnel.stage);
    const nextIdx = FUNNEL_STAGE_KEYS.indexOf(stage);
    if (currentIdx >= nextIdx) return { applied: false };
  }

  const hasValue = args.saleValue !== undefined && args.saleValue > 0;
  const now = Date.now();
  const currency = args.saleCurrency ?? args.defaultCurrency;

  // The transition log (`funnelTransitions`) is the system of record for a
  // sale amount; `conversation.funnel` is only a denorm. A stage move that
  // doesn't carry its own value (e.g. reopening a purchased deal to
  // price_quoted) must PRESERVE whatever was last entered rather than drop
  // it — merge, don't replace (Task B1).
  const finalValue = hasValue ? args.saleValue : conversation.funnel?.saleValue;
  const finalCurrency = hasValue ? currency : conversation.funnel?.saleCurrency;

  await ctx.db.patch(conversationId, {
    funnel: {
      stage,
      stageUpdatedAt: now,
      ...(args.byUserId ? { stageUpdatedByUserId: args.byUserId } : {}),
      ...(finalValue !== undefined
        ? { saleValue: finalValue, saleCurrency: finalCurrency }
        : {}),
    },
    updatedAt: now,
  });

  // Seed the mapped Meta conversion event when the conversation is
  // attributed AND the stage maps to an event on its lane.
  const { conversionEventId } = await seedStageConversionEvent(ctx, {
    accountId: args.accountId,
    conversation,
    stage,
    ...(hasValue ? { value: args.saleValue, currency } : {}),
  });

  // Rollup BEFORE the insert: `recordTransitionInRollup` decides whether
  // this is the conversation's first ever arrival at `stage` by reading the
  // transition log, and that question must be asked without this row in it.
  await recordTransitionInRollup(ctx, {
    accountId: args.accountId,
    conversationId,
    stage,
    atMs: now,
    ...(hasValue ? { saleValue: args.saleValue } : {}),
  });

  await ctx.db.insert("funnelTransitions", {
    accountId: args.accountId,
    conversationId,
    contactId: conversation.contactId,
    stage,
    ...(args.byUserId ? { byUserId: args.byUserId } : {}),
    auto: args.auto,
    ...(conversionEventId ? { conversionEventId } : {}),
    ...(args.lossCategory ? { lossCategory: args.lossCategory } : {}),
    ...(args.lossDetail ? { lossDetail: args.lossDetail } : {}),
    // Durable record of the amount on the transition that carried it (this
    // append-only row never gets replaced by a later stage move — Task B1).
    ...(hasValue ? { saleValue: args.saleValue, saleCurrency: currency } : {}),
  });

  return { applied: true };
}

export const setStage = accountMutation({
  args: {
    conversationId: v.id("conversations"),
    stage: STAGE_VALIDATOR,
    saleValue: v.optional(v.number()),
    saleCurrency: v.optional(v.string()),
    // Required (validated below) when stage === "lost".
    lossCategory: v.optional(v.string()),
    lossDetail: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<Id<"conversations">> => {
    ctx.requireRole("agent");
    const conversation = await requireConversationAccess(
      ctx,
      args.conversationId,
      "own",
    );

    const stage = args.stage as FunnelStageKey;
    const stageDef = getStage(stage);
    const hasValue = args.saleValue !== undefined && args.saleValue > 0;
    if (stageDef.needsValue && !hasValue) {
      throw new ConvexError({ code: "BAD_REQUEST", reason: "value_required" });
    }

    // Losing a deal demands the exact why: a fixed category + free text.
    const lossDetail = args.lossDetail?.trim() ?? "";
    if (
      stage === "lost" &&
      (!args.lossCategory ||
        !isLossCategory(args.lossCategory) ||
        lossDetail.length < 5)
    ) {
      throw new ConvexError({
        code: "BAD_REQUEST",
        reason: "loss_reason_required",
      });
    }

    // The deal-discipline gates work off the conversation's latest
    // qualification session's sales checklist (absent for organic /
    // pre-feature conversations → no gate).
    const session = await ctx.db
      .query("qualificationSessions")
      .withIndex("by_conversation", (q) =>
        q.eq("conversationId", args.conversationId),
      )
      .order("desc")
      .first();
    const checklist =
      session && session.accountId === ctx.accountId
        ? await ctx.db
            .query("salesChecklists")
            .withIndex("by_session", (q) => q.eq("sessionId", session._id))
            .unique()
        : null;

    if (
      stage === "purchased" &&
      checklist &&
      !allItemsDone(checklist.items)
    ) {
      throw new ConvexError({
        code: "BAD_REQUEST",
        reason: "checklist_incomplete",
      });
    }

    const previousStage = conversation.funnel?.stage ?? null;
    const account = await ctx.db.get(ctx.accountId);
    const currency = args.saleCurrency ?? account?.defaultCurrency ?? "USD";
    await applyStageTransition(ctx, {
      accountId: ctx.accountId,
      conversation,
      stage,
      byUserId: ctx.userId,
      auto: false,
      saleValue: args.saleValue,
      saleCurrency: args.saleCurrency,
      defaultCurrency: account?.defaultCurrency ?? "USD",
      ...(stage === "lost"
        ? { lossCategory: args.lossCategory, lossDetail }
        : {}),
    });

    // Deal outcome bookkeeping + the AI-processable contact-note trail
    // (same trail agent WhatsApp feedback lands on). Authed path only —
    // the engine's auto transitions never touch won/lost.
    if (checklist) {
      if (stage === "purchased") {
        await ctx.db.patch(checklist._id, {
          outcome: { result: "won", at: Date.now(), byUserId: ctx.userId },
        });
      } else if (stage === "lost") {
        await ctx.db.patch(checklist._id, {
          outcome: {
            result: "lost",
            lossCategory: args.lossCategory,
            lossDetail,
            at: Date.now(),
            byUserId: ctx.userId,
          },
        });
      } else if (checklist.outcome) {
        await ctx.db.patch(checklist._id, { outcome: undefined });
      }
    }

    if (stage === "purchased") {
      await ctx.db.insert("contactNotes", {
        accountId: ctx.accountId,
        contactId: conversation.contactId,
        createdByUserId: ctx.userId,
        noteText: `🏆 Deal won — ${args.saleValue} ${currency}`,
      });
    } else if (stage === "lost") {
      await ctx.db.insert("contactNotes", {
        accountId: ctx.accountId,
        contactId: conversation.contactId,
        createdByUserId: ctx.userId,
        noteText: `❌ Deal lost (${args.lossCategory}): ${lossDetail}`,
      });
    } else if (previousStage === "purchased" || previousStage === "lost") {
      await ctx.db.insert("contactNotes", {
        accountId: ctx.accountId,
        contactId: conversation.contactId,
        createdByUserId: ctx.userId,
        noteText: `↩️ Deal reopened → ${stageDef.label}`,
      });
    }

    return args.conversationId;
  },
});

export const getState = accountQuery({
  args: { conversationId: v.id("conversations") },
  handler: async (ctx, args) => {
    const conversation = await requireConversationAccess(
      ctx,
      args.conversationId,
      "view",
    );

    const transitions = await ctx.db
      .query("funnelTransitions")
      .withIndex("by_conversation", (q) =>
        q.eq("conversationId", args.conversationId),
      )
      .collect();
    const reachedAt: Record<string, number> = {};
    for (const tr of transitions) {
      const at = tr._creationTime;
      if (reachedAt[tr.stage] === undefined || at < reachedAt[tr.stage]) {
        reachedAt[tr.stage] = at;
      }
    }

    const events = await ctx.db
      .query("conversionEvents")
      .withIndex("by_conversation", (q) =>
        q.eq("conversationId", args.conversationId),
      )
      .collect();
    const metaStatus: Record<string, string> = {};
    for (const ev of events) {
      metaStatus[ev.stage] = ev.status;
    }

    return {
      attributed: conversation.attribution !== undefined,
      lane: conversation.attribution?.lane ?? null,
      currentStage: conversation.funnel?.stage ?? null,
      saleValue: conversation.funnel?.saleValue,
      saleCurrency: conversation.funnel?.saleCurrency,
      reachedAt,
      metaStatus,
    };
  },
});
