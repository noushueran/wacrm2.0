// ============================================================
// Pure helpers behind `convex/reports.ts`.
//
// Everything here is a total function over plain data: no database, no
// clock, no Convex ctx. That is deliberate — the fold logic is where a
// report silently produces WRONG numbers rather than failing, so it has to
// be testable without a harness. See `lib/messageStats.ts`, which
// established the pattern for the two folds that already existed.
// ============================================================

import { localDayKeyFromMs, localMondayStartMsFromMs } from "./dashboardDate";

// --- UTC day bucketing (funnelDailyStats) --------------------------------

/** Milliseconds in a UTC day. */
export const DAY_MS = 86_400_000;

/**
 * Start of the UTC day containing `ms` — the bucket key for
 * `funnelDailyStats`, and the exact day analogue of `messageStats.ts`'s
 * `hourStartMs`.
 *
 * UTC, with no `tzOffsetMinutes` parameter, deliberately. A bucket key has
 * to be decided at WRITE time, when the future reader's timezone is
 * unknowable; picking one there is the mistake `messageHourlyStats`'s
 * header warns about. The reader compensates by over-reading at the window
 * edges — see `funnelOverview`.
 */
export function dayStartMs(ms: number): number {
  return Math.floor(ms / DAY_MS) * DAY_MS;
}

/**
 * Empty `funnelDailyStats` counters. Exported so the write path, the
 * backfill and the tests all start from ONE definition of "zero" — a
 * second, drifting copy is how a newly added stage ends up uncounted on
 * one path and counted on another.
 */
export function emptyStageCounts() {
  return {
    new_lead: 0,
    qualified: 0,
    price_quoted: 0,
    itinerary_created: 0,
    itinerary_sent: 0,
    invoice_sent: 0,
    purchased: 0,
    lost: 0,
  };
}

/** Every `conversionEvents.status` literal, in one place. Iterating this
 *  rather than `Object.keys` keeps the fold exhaustive by TYPE: adding a
 *  status to the schema union without adding it here is a compile error at
 *  every call site, not a silently uncounted row. */
export const EVENT_STATUS_KEYS = [
  "pending",
  "sent",
  "unmatched",
  "error",
  "abandoned",
  "dormant",
] as const;

export type EventStatusKey = (typeof EVENT_STATUS_KEYS)[number];

export function emptyEventStatusCounts() {
  return {
    pending: 0,
    sent: 0,
    unmatched: 0,
    error: 0,
    abandoned: 0,
    dormant: 0,
  };
}

// --- Reply-latency histogram --------------------------------------------
//
// WHY A HISTOGRAM AND NOT A `withinTarget` COUNTER
//
// A single counter bakes one SLA threshold in at write time. Changing the
// target from 5 to 15 minutes would make every accumulated row meaningless,
// with no way to recompute — the raw latencies are gone by then. Six
// counters cost the same single patch, make any threshold ON A BUCKET EDGE
// exact, and let p50/p90 be interpolated as an honest RANGE.

export const RESPONSE_BUCKET_KEYS = [
  "m1",
  "m5",
  "m15",
  "m60",
  "m240",
  "over",
] as const;
export type ResponseBucketKey = (typeof RESPONSE_BUCKET_KEYS)[number];
export type ResponseBuckets = Record<ResponseBucketKey, number>;

/** Upper edge of each bucket, in minutes. `over` is unbounded. */
export const RESPONSE_BUCKET_EDGES_MINUTES: Record<ResponseBucketKey, number | null> =
  { m1: 1, m5: 5, m15: 15, m60: 60, m240: 240, over: null };

export function emptyResponseBuckets(): ResponseBuckets {
  return { m1: 0, m5: 0, m15: 0, m60: 0, m240: 0, over: 0 };
}

/** Which bucket a latency falls in. Lower bound inclusive, upper exclusive. */
export function responseBucketFor(elapsedMs: number): ResponseBucketKey {
  const minutes = elapsedMs / 60_000;
  if (minutes < 1) return "m1";
  if (minutes < 5) return "m5";
  if (minutes < 15) return "m15";
  if (minutes < 60) return "m60";
  if (minutes < 240) return "m240";
  return "over";
}

/** Non-mutating +1 on one bucket. Absent histogram reads as all-zero. */
export function addResponseBucket(
  existing: ResponseBuckets | undefined,
  key: ResponseBucketKey,
): ResponseBuckets {
  const next = { ...emptyResponseBuckets(), ...(existing ?? {}) };
  next[key] += 1;
  return next;
}

// --- Meta pricing categories ---------------------------------------------

export const PRICING_CATEGORY_KEYS = [
  "marketing",
  "utility",
  "service",
  "authentication",
  "free",
  "other",
] as const;
export type PricingCategoryKey = (typeof PRICING_CATEGORY_KEYS)[number];
export type PricingCategories = Record<PricingCategoryKey, number>;

export function emptyPricingCategories(): PricingCategories {
  return {
    marketing: 0,
    utility: 0,
    service: 0,
    authentication: 0,
    free: 0,
    other: 0,
  };
}

/**
 * Normalize Meta's raw pricing facts into one bucket.
 *
 * `billable === false` is Meta stating the outcome directly, so it outranks
 * whatever category string arrived with it.
 *
 * `other` is load-bearing, not a fallback nobody hits: schema.ts's own
 * comment notes Meta is mid-migration between conversation-based ("CBP") and
 * per-message ("PMP") pricing, "which spell categories differently". An
 * unmapped spelling must still land somewhere, or the per-category totals
 * stop summing to the message count and the panel quietly lies.
 */
export function pricingCategoryKey(
  category: string | undefined,
  billable: boolean | undefined,
): PricingCategoryKey {
  if (billable === false) return "free";
  switch ((category ?? "").toLowerCase()) {
    case "marketing":
      return "marketing";
    case "utility":
      return "utility";
    case "service":
      return "service";
    case "authentication":
    case "authentication_international":
      return "authentication";
    case "referral_conversion":
    case "free_entry_point":
      return "free";
    default:
      return "other";
  }
}

/** Non-mutating +1 on one category. Absent record reads as all-zero. */
export function addPricingCategory(
  existing: PricingCategories | undefined,
  key: PricingCategoryKey,
): PricingCategories {
  const next = { ...emptyPricingCategories(), ...(existing ?? {}) };
  next[key] += 1;
  return next;
}

// --- Fold helpers ----------------------------------------------------------
//
// Everything below turns `messageHourlyStats` rows (hourly, UTC-keyed) into
// whatever grouping a report query wants: local days, local weeks, hour-of-
// day slots, or a percentile range over the reply-latency histogram. Same
// contract as `foldHoursIntoDays`/`foldHoursIntoResponseBuckets` in
// `messageStats.ts`: every requested key is seeded to zero so a quiet period
// charts as a zero rather than a gap, rows outside the requested keys are
// dropped rather than inventing keys the caller did not ask for, and every
// counter is read with `?? 0` since a row written before a field shipped has
// none of them.

/** The `messageHourlyStats` subset every fold below reads. Every counter is
 *  optional: a row written before these fields shipped has none, and each
 *  must read as zero rather than NaN — one NaN poisons a whole chart axis. */
export type ReportHourRow = {
  hourStartMs: number;
  incoming: number;
  outgoing: number;
  conversationsStarted?: number;
  conversationsStartedAd?: number;
  activeConversations?: number;
  responseCount?: number;
  responseTotalMs?: number;
  responseBuckets?: ResponseBuckets;
  metaConversations?: number;
  freeEntryPointConversations?: number;
  billedMessagesByCategory?: PricingCategories;
};

export type Granularity = "day" | "week";

/** Week key = the week's Monday as `YYYY-MM-DD`. Not an ISO week number,
 *  which drags in week-year edge cases (a January 1st can belong to the
 *  previous year's week 52) for no benefit here. */
export function localWeekKeyFromMs(
  ms: number,
  tzOffsetMinutes: number,
): string {
  return localDayKeyFromMs(
    localMondayStartMsFromMs(ms, tzOffsetMinutes),
    tzOffsetMinutes,
  );
}

function bucketKeyFor(
  ms: number,
  tzOffsetMinutes: number,
  granularity: Granularity,
): string {
  return granularity === "week"
    ? localWeekKeyFromMs(ms, tzOffsetMinutes)
    : localDayKeyFromMs(ms, tzOffsetMinutes);
}

export type VolumeTotals = {
  conversationsStarted: number;
  conversationsStartedAd: number;
  incoming: number;
  outgoing: number;
  /**
   * Sum of each folded period's distinct-conversation count, NOT a distinct
   * count itself — distinct counts are not additive across time buckets.
   * At week granularity a single bucket's value is already conversation-
   * DAYS (the sum of that week's seven daily counts); summed again across a
   * whole `series` — as `reports.ts`'s `volume` handler does to build
   * `totals` — it becomes conversation-DAYS/-PERIODS for the whole range,
   * regardless of granularity. Any consumer that presents this figure must
   * divide by the period count it was summed over (see
   * `conversations-panel.tsx`'s tile/CSV for the two places that do).
   */
  activeConversations: number;
};

/**
 * Fold hourly rows into the caller's local days or weeks.
 *
 * Every requested key is seeded to zero so a quiet period charts as a zero
 * rather than a gap, and hours outside `keys` are dropped rather than adding
 * keys the caller did not ask for — the same contract `foldHoursIntoDays`
 * established in `messageStats.ts`.
 */
export function foldHoursIntoVolume(
  rows: readonly ReportHourRow[],
  keys: readonly string[],
  tzOffsetMinutes: number,
  granularity: Granularity,
): Map<string, VolumeTotals> {
  const out = new Map<string, VolumeTotals>();
  for (const key of keys)
    out.set(key, {
      conversationsStarted: 0,
      conversationsStartedAd: 0,
      incoming: 0,
      outgoing: 0,
      activeConversations: 0,
    });

  for (const row of rows) {
    const bucket = out.get(
      bucketKeyFor(row.hourStartMs, tzOffsetMinutes, granularity),
    );
    if (!bucket) continue;
    bucket.conversationsStarted += row.conversationsStarted ?? 0;
    bucket.conversationsStartedAd += row.conversationsStartedAd ?? 0;
    bucket.incoming += row.incoming;
    bucket.outgoing += row.outgoing;
    bucket.activeConversations += row.activeConversations ?? 0;
  }
  return out;
}

/** Inbound volume by local hour-of-day, 24 slots. Shows which hours are busy
 *  across the whole window, which is what the heatmap renders. */
export function foldHoursIntoHourOfDay(
  rows: readonly ReportHourRow[],
  tzOffsetMinutes: number,
): number[] {
  const slots = Array.from({ length: 24 }, () => 0);
  for (const row of rows) {
    const localMs = row.hourStartMs - tzOffsetMinutes * 60_000;
    const hour = new Date(localMs).getUTCHours();
    slots[hour]! += row.incoming;
  }
  return slots;
}

export type ResponseDayPoint = {
  key: string;
  avgMinutes: number | null;
  samples: number;
};

/** Average reply latency per day/week. `avgMinutes: null` for a period with
 *  no samples — distinct from zero, which would mean instant replies. */
export function foldHoursIntoResponseSeries(
  rows: readonly ReportHourRow[],
  keys: readonly string[],
  tzOffsetMinutes: number,
  granularity: Granularity,
): ResponseDayPoint[] {
  const running = new Map<string, { totalMs: number; count: number }>();
  for (const key of keys) running.set(key, { totalMs: 0, count: 0 });

  for (const row of rows) {
    const count = row.responseCount ?? 0;
    if (count <= 0) continue;
    const bucket = running.get(
      bucketKeyFor(row.hourStartMs, tzOffsetMinutes, granularity),
    );
    if (!bucket) continue;
    bucket.totalMs += row.responseTotalMs ?? 0;
    bucket.count += count;
  }

  return keys.map((key) => {
    const r = running.get(key)!;
    return {
      key,
      avgMinutes: r.count === 0 ? null : r.totalMs / r.count / 60_000,
      samples: r.count,
    };
  });
}

/** Add every row's histogram together. Absent reads as all-zero. */
export function sumResponseBuckets(
  rows: readonly ReportHourRow[],
): ResponseBuckets {
  const out = emptyResponseBuckets();
  for (const row of rows) {
    if (!row.responseBuckets) continue;
    for (const key of RESPONSE_BUCKET_KEYS)
      out[key] += row.responseBuckets[key] ?? 0;
  }
  return out;
}

/**
 * The bucket RANGE containing the p-th percentile.
 *
 * Deliberately a range and not a point. The histogram knows how many
 * replies fell between 5 and 15 minutes but nothing about their
 * distribution inside it, so interpolating to "p90 = 11.4 min" would invent
 * a precision the data does not have. The UI renders "5–15 min".
 *
 * Returns null with no samples — the honest answer, not a zero that would
 * read as "we reply instantly".
 */
export function percentileRange(
  buckets: ResponseBuckets,
  p: number,
): { lowMinutes: number; highMinutes: number | null } | null {
  const total = RESPONSE_BUCKET_KEYS.reduce((s, k) => s + buckets[k], 0);
  if (total === 0) return null;

  const threshold = (p / 100) * total;
  let cumulative = 0;
  let low = 0;
  for (const key of RESPONSE_BUCKET_KEYS) {
    cumulative += buckets[key];
    const high = RESPONSE_BUCKET_EDGES_MINUTES[key];
    if (cumulative > 0 && cumulative >= threshold)
      return { lowMinutes: low, highMinutes: high };
    low = high ?? low;
  }
  return { lowMinutes: 240, highMinutes: null };
}

/**
 * Share of replies at or under `targetMinutes`.
 *
 * Exact ONLY because every allowed target is a bucket edge — that is the
 * whole reason the histogram's edges are 1/5/15/60/240. A target between
 * edges could not be answered without inventing a distribution, so the type
 * does not permit one.
 */
export function withinTargetRatio(
  buckets: ResponseBuckets,
  targetMinutes: 1 | 5 | 15 | 60,
): number | null {
  const total = RESPONSE_BUCKET_KEYS.reduce((s, k) => s + buckets[k], 0);
  if (total === 0) return null;
  let within = 0;
  for (const key of RESPONSE_BUCKET_KEYS) {
    const high = RESPONSE_BUCKET_EDGES_MINUTES[key];
    if (high !== null && high <= targetMinutes) within += buckets[key];
  }
  return within / total;
}

/**
 * `metaConversations` is every distinct Meta conversation window observed,
 * of which `freeEntryPointConversations` is the free SUBSET — not a figure
 * beside it. The billable count is the difference; neither field is it. See
 * `messageHourlyStats.metaConversations` in schema.ts.
 */
export type BillingTotals = {
  metaConversations: number;
  freeEntryPointConversations: number;
  categories: PricingCategories;
};

export function foldHoursIntoBilling(
  rows: readonly ReportHourRow[],
  keys: readonly string[],
  tzOffsetMinutes: number,
  granularity: Granularity,
): Map<string, BillingTotals> {
  const out = new Map<string, BillingTotals>();
  for (const key of keys)
    out.set(key, {
      metaConversations: 0,
      freeEntryPointConversations: 0,
      categories: emptyPricingCategories(),
    });

  for (const row of rows) {
    const bucket = out.get(
      bucketKeyFor(row.hourStartMs, tzOffsetMinutes, granularity),
    );
    if (!bucket) continue;
    bucket.metaConversations += row.metaConversations ?? 0;
    bucket.freeEntryPointConversations += row.freeEntryPointConversations ?? 0;
    for (const key of PRICING_CATEGORY_KEYS)
      bucket.categories[key] += row.billedMessagesByCategory?.[key] ?? 0;
  }
  return out;
}

// --- Status-mix cap ---------------------------------------------------------
//
// Lives here, not in `reports.ts`, so a `'use client'` panel can import it
// directly. `reports.ts` imports `accountQuery` from `./lib/auth` — database
// access, auth, role checks — and none of that is tree-shaken away just
// because only one constant is used from the file: a client component that
// imported `STATUS_MIX_CAP` from `reports.ts` shipped the whole module to
// the browser (every query handler, every `ctx.db.query()` call and index
// name, the full `accountQuery`/`requireRole` role-check machinery)
// to obtain one integer — confirmed by inspecting the built /reports client
// chunk. This file has no such import — nothing here reaches `ctx`, `db`, or
// `_generated/server`; its only dependency is `./dashboardDate` — so it is
// the safe shared home for anything a report panel needs to read directly.

/**
 * Ceiling per status bucket for `conversationStatusMix` (convex/reports.ts),
 * mirroring `dashboard.ACTIVE_CONVERSATIONS_CAP` (same cap pattern, same
 * value). `conversationStatusMix` is a current-state count with no time
 * window to bound it, so the bound has to be a `.take()`.
 *
 * The number is 500 and not larger because THAT query spends this cap FOUR
 * TIMES, not once — that is the one thing that differs from the precedent it
 * copies. `dashboard.metrics`'s `openSample` does a single `.take(CAP + 1)`,
 * so its 500 costs 501 document reads. `conversationStatusMix` runs four
 * takes (open, pending, closed, archived) in one transaction, so its cost is
 * `4 × (CAP + 1)` against Convex's 4096-read ceiling: 2004 at 500, but 4004
 * at 1000 — 2% of headroom on the only query in `reports.ts` with no window
 * to bound it, which is not a bound at all. `conversations` documents are
 * also wide (denormalized contact, ad-referral and lane fields), so the 8
 * MiB transaction limit is in play alongside the read count. Anything above
 * the cap is reported through `capped`, never as an exact figure, so
 * lowering it costs fidelity in the tail and nothing in correctness.
 */
export const STATUS_MIX_CAP = 500;

// --- Ad row limit ------------------------------------------------------------
//
// Lives here for the same reason as `STATUS_MIX_CAP` above: the Ads panel
// needs this number verbatim for its truncation copy ("Showing the top N
// ads..."), and importing it from `reports.ts` instead would ship that
// whole module to the browser — every query handler in the file, every
// `ctx.db.query()` call and index name, the full `accountQuery`/
// `requireRole` machinery — to obtain one integer. Confirmed by inspecting
// the built /reports client chunk.

/**
 * Rows returned by `adPerformance` (convex/reports.ts). Unlike
 * `volume`/`conversationStatusMix`, `adPerformance` is the one read in that
 * file whose cost grows with ad-click VOLUME within the window rather than
 * being pinned by the window alone — an account running many concurrent
 * campaigns can have more distinct ads referred-from in a window than any
 * reasonable page wants to render. The window bound on its two scans plus
 * this cap on the OUTPUT is the accepted v1 bound: the number of ads it
 * drops is reported as `truncated`, never silently sliced, so the table can
 * never imply it is exhaustive. If measurement later shows the referral
 * SCAN itself (not just the row count) is the problem, the documented
 * escape hatch is a per-(account, adId, day) rollup, the same shape as
 * `messageHourlyStats`.
 */
export const AD_ROW_LIMIT = 100;

// --- Awaiting-reply sample cap ----------------------------------------------
//
// Lives here for the same reason as `STATUS_MIX_CAP`/`AD_ROW_LIMIT` above:
// the Response panel needs this number verbatim for its capped-backlog
// copy, and importing it from `reports.ts` instead would ship that whole
// module to the browser — every query handler in the file, every
// `ctx.db.query()` call and index name, the full `accountQuery`/
// `requireRole` machinery — to obtain one integer. Confirmed by inspecting
// the built /reports client chunk.

/**
 * Ceiling on the backlog sample returned by `awaitingReplyAges`
 * (convex/reports.ts). Current-state again, like `STATUS_MIX_CAP`, so no
 * window bounds it — the bound has to be a `.take()`.
 *
 * The take is on `by_account_lane_last_message`, whose key order is
 * `["accountId", "archivedAt", "snoozedUntil", "chasingForcedAt",
 * "awaitingReply", "lastMessageAt"]` (schema.ts). Every key before
 * `awaitingReply` is bound below by EQUALITY — `archivedAt`/`snoozedUntil`/
 * `chasingForcedAt` all as `eq(undefined)`, the exact "not overridden"
 * binding `conversations.ts`'s Active lane uses on this identical index —
 * so every document the take reads already matches the awaiting-reply
 * partition exactly. There is no `.filter()` layered on top that could
 * starve it, which is what makes the take a genuine bound rather than a
 * scan-and-discard.
 *
 * `snoozedUntil`/`chasingForcedAt` being bound to `undefined` is not a
 * guess: `messages.ts`'s single `insert("messages")` choke point
 * unconditionally clears both to `undefined` on every CUSTOMER message
 * (the same transaction that sets `awaitingReply: true` and stamps
 * `pendingCustomerAtMs`), and schema.ts documents presence of either as
 * "appears in NO lane — that is what snooze/force means". So a thread a
 * customer is genuinely waiting on, that no agent has since snoozed or
 * force-chased, carries `undefined` for both — matching live data, not
 * just the Active lane's own query shape.
 */
export const AWAITING_SAMPLE_CAP = 500;
