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

import { localDayKeyFromMs } from "./dashboardDate";

export const HOUR_MS = 3_600_000;

/** The start of the UTC hour containing `ms`. The bucket key. */
export function hourStartMs(ms: number): number {
  return Math.floor(ms / HOUR_MS) * HOUR_MS;
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
