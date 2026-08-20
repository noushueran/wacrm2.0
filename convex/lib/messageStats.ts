// ============================================================
// Hourly message rollup — the read-bounded source for the dashboard's
// messages-per-day chart.
//
// `dashboard.conversationsSeries` used to `.collect()` every message in the
// requested window. That is bounded by the WINDOW but not by traffic, so
// against Convex's 4096-document read ceiling it broke at roughly 137
// msg/day on the default 30-day view and 45 msg/day on the 90-day one — a
// handful of conversations for an account whose AI answers every inbound.
//
// A chart cannot be rescued by a read bound: `.take()` returns a partial,
// silently WRONG chart, which is worse than a slow one. So the counts are
// accumulated at write time instead, in `messageHourlyStats`.
//
// WHY HOURLY, AND WHY UTC
//
// The chart's day boundaries depend on the viewer's timezone, which arrives
// per-request as `tzOffsetMinutes` — so a rollup keyed by DAY would have to
// choose a timezone at write time and could not serve a viewer in another
// one. Hourly UTC buckets dodge that: they are timezone-neutral on write,
// and any whole-hour offset re-buckets them into correct local days on
// read. Cost becomes a function of the window (24 rows/day, ~2160 for the
// 90-day view) rather than of message volume.
//
// KNOWN LIMIT: offsets that are not a whole number of hours (India +05:30,
// Nepal +05:45) can misplace an hour that straddles their local midnight,
// moving up to one hour of traffic to the adjacent day. Asia/Dubai, where
// this CRM runs, is UTC+04:00, so the chart is exact there. Fixing it in
// general means 15-minute buckets, which would quadruple the read for a
// timezone nobody here uses.
// ============================================================

import { localDayKeyFromMs, localMondayIndexFromMs } from "./dashboardDate";

export const HOUR_MS = 3_600_000;

/** The start of the UTC hour containing `ms`. The bucket key. */
export function hourStartMs(ms: number): number {
  return Math.floor(ms / HOUR_MS) * HOUR_MS;
}

export const DAY_MS = 24 * HOUR_MS;

/**
 * The start of the UTC day containing `ms`. The dedup key for
 * `activeConversations`.
 *
 * UTC and not local, for the same reason the buckets themselves are UTC: a
 * Convex function runs in UTC and the viewer's offset arrives per request, so
 * a local-day key would have to choose a timezone at write time.
 *
 * The consequence is documented rather than hidden — a UTC+4 local day spans
 * two UTC days, so a thread active both before ~04:00 local and again later
 * counts twice in that local day. Business-hours traffic (09:00-18:00 local =
 * 05:00-14:00 UTC) falls in one UTC day and counts once.
 */
export function utcDayStartMs(ms: number): number {
  return Math.floor(ms / DAY_MS) * DAY_MS;
}

export type HourBucket = {
  hourStartMs: number;
  incoming: number;
  outgoing: number;
};

export type DayTotals = { incoming: number; outgoing: number };

/**
 * Fold hourly UTC buckets into the caller's local calendar days.
 *
 * Every key in `dayKeys` is seeded to zero so a quiet day charts as a zero
 * rather than a gap, and hours falling outside that range are dropped
 * rather than adding keys the caller did not ask for — the same contract
 * the previous per-message loop had.
 */
export function foldHoursIntoDays(
  rows: readonly HourBucket[],
  dayKeys: readonly string[],
  tzOffsetMinutes: number,
): Map<string, DayTotals> {
  const buckets = new Map<string, DayTotals>();
  for (const key of dayKeys) buckets.set(key, { incoming: 0, outgoing: 0 });

  for (const row of rows) {
    // Keyed off the hour's START. With a whole-hour offset every message in
    // the bucket shares that local day, which is what makes the re-bucket
    // exact (see KNOWN LIMIT above).
    const key = localDayKeyFromMs(row.hourStartMs, tzOffsetMinutes);
    const bucket = buckets.get(key);
    if (!bucket) continue;
    bucket.incoming += row.incoming;
    bucket.outgoing += row.outgoing;
  }

  return buckets;
}

// ============================================================
// Reply-latency rollup — the same trick, for `dashboard.responseTime`.
//
// That query used to `.collect()` every message in its 14-day window and pair
// customer messages with the next reply in JS. Identical failure mode to the
// chart above (a window bounds the SPAN, not the ROW COUNT), and it is what
// actually took /dashboard down: `Your request timed out performing too many
// system operations`, thrown inside `useQuery` on a page with no Error
// Boundary, so the whole route died rather than one card.
//
// The pairing now happens once, on write (`recordResponseSample` in
// messages.ts), and each sample is accumulated into the hour its CUSTOMER
// message landed in. Sum + count survive re-bucketing into any grouping the
// read wants — day-of-week here — and still divide out to an exact mean.
//
// Inherits the whole-hour-offset caveat documented above: a bucket is placed
// by its hour START, so a non-whole-hour zone (India +05:30) can attribute an
// hour straddling local midnight to the adjacent day. Asia/Dubai is UTC+04:00,
// so this is exact where the CRM runs.
// ============================================================

export type HourResponseBucket = {
  hourStartMs: number;
  responseCount?: number;
  responseTotalMs?: number;
};

export type ResponseDowBucket = {
  dow: number;
  avgMinutes: number | null;
  samples: number;
};

export type ResponseSummary = {
  buckets: ResponseDowBucket[];
  thisWeekAvg: number | null;
  lastWeekAvg: number | null;
};

type Running = { totalMs: number; count: number };

/**
 * Fold hourly reply-latency buckets into per-local-day-of-week averages plus
 * this-week / last-week figures.
 *
 * All seven days are always present (a day with no samples reports
 * `avgMinutes: null` and `samples: 0`, which the chart renders muted) so the
 * caller gets a stable seven-bar shape regardless of how quiet the window was
 * — the same contract the per-message implementation had.
 *
 * `thisWeekStartMs`/`lastWeekStartMs` are absolute local-midnight instants
 * computed by the caller, which is the only party that knows "now".
 */
export function foldHoursIntoResponseBuckets(
  rows: readonly HourResponseBucket[],
  tzOffsetMinutes: number,
  thisWeekStartMs: number,
  lastWeekStartMs: number,
): ResponseSummary {
  const byDow: Running[] = Array.from({ length: 7 }, () => ({
    totalMs: 0,
    count: 0,
  }));
  const thisWeek: Running = { totalMs: 0, count: 0 };
  const lastWeek: Running = { totalMs: 0, count: 0 };

  for (const row of rows) {
    // Absent means "this hour predates the rollup", which is not the same as
    // "nobody replied in this hour" — but both contribute nothing, so both
    // read as zero here. Skipping early also keeps an hour that only carries
    // message COUNTS from being mistaken for a zero-latency sample.
    const count = row.responseCount ?? 0;
    if (count <= 0) continue;
    const totalMs = row.responseTotalMs ?? 0;

    const dow = localMondayIndexFromMs(row.hourStartMs, tzOffsetMinutes);
    byDow[dow]!.totalMs += totalMs;
    byDow[dow]!.count += count;

    // Week boundaries are local midnights, which line up exactly with an
    // hour start for every whole-hour offset (see the caveat above).
    if (row.hourStartMs >= thisWeekStartMs) {
      thisWeek.totalMs += totalMs;
      thisWeek.count += count;
    } else if (row.hourStartMs >= lastWeekStartMs) {
      lastWeek.totalMs += totalMs;
      lastWeek.count += count;
    }
  }

  const avgMinutes = (r: Running) =>
    r.count === 0 ? null : r.totalMs / r.count / 60_000;

  return {
    buckets: byDow.map((running, dow) => ({
      dow,
      avgMinutes: avgMinutes(running),
      samples: running.count,
    })),
    thisWeekAvg: avgMinutes(thisWeek),
    lastWeekAvg: avgMinutes(lastWeek),
  };
}
