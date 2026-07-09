// ============================================================
// Local-day helpers for `convex/dashboard.ts`. A Convex function always
// executes in UTC (there is no per-request process timezone the way a
// browser or a Node server configured with a local TZ has), so any
// "local calendar day" concept the dashboard needs — which day-of-week
// a message landed on, which day bucket to sum a message into — has to
// be computed relative to a caller-supplied `tzOffsetMinutes` rather
// than the server's own clock.
//
// `tzOffsetMinutes` uses the exact same sign convention as the
// browser's `Date.prototype.getTimezoneOffset()`: UTC minus local, in
// minutes (e.g. UTC+5:30 -> -330, UTC-5 -> +300). Every helper below
// treats it as a single fixed constant across the whole request, which
// is a deliberate simplification carried over from
// `src/lib/dashboard/date-utils.ts` itself (that client-side code reads
// the browser's *current* offset once per call too) — a DST transition
// falling inside the requested range could shift a handful of samples
// by an hour right at the boundary. Acceptable at current scale; see
// the Phase 3 Task 3 report for the tradeoff.
// ============================================================

/**
 * Shifts a UTC instant so that reading its UTC-getters
 * (`getUTCFullYear`/`getUTCMonth`/`getUTCDate`/`getUTCDay`) yields the
 * LOCAL calendar fields for that instant, given a fixed
 * `tzOffsetMinutes`. This is the one primitive every helper below
 * builds on: it lets plain `Date.UTC`/`getUTC*` arithmetic stand in for
 * "local" arithmetic without the runtime needing to know a real IANA
 * timezone.
 */
function shiftToLocal(ms: number, tzOffsetMinutes: number): Date {
  return new Date(ms - tzOffsetMinutes * 60_000);
}

/**
 * Date-only key (YYYY-MM-DD) for bucketing a UTC timestamp by its LOCAL
 * calendar day. Mirrors `src/lib/dashboard/date-utils.ts`'s
 * `localDayKey`, parameterized by an explicit offset instead of
 * relying on the runtime's own timezone.
 */
export function localDayKeyFromMs(ms: number, tzOffsetMinutes: number): string {
  const d = shiftToLocal(ms, tzOffsetMinutes);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * ISO day-of-week where 0 = Monday ... 6 = Sunday, of a UTC timestamp's
 * LOCAL calendar day. Mirrors `date-utils.ts`'s `mondayIndex`.
 */
export function localMondayIndexFromMs(
  ms: number,
  tzOffsetMinutes: number,
): number {
  const jsDow = shiftToLocal(ms, tzOffsetMinutes).getUTCDay(); // 0=Sun..6=Sat
  return (jsDow + 6) % 7;
}

/**
 * Absolute UTC ms of local midnight, `daysAgo` local calendar days
 * before the instant `nowMs`. Mirrors `date-utils.ts`'s
 * `daysAgoStart`/`startOfLocalDay` (`daysAgo=0` gives "start of local
 * today"), parameterized by a fixed offset instead of the runtime's own
 * timezone. Uses `Date.UTC` (not raw ms subtraction) for the day-offset
 * step so month/year rollovers are handled correctly, same as
 * `daysAgoStart`'s own `setDate(getDate() - days)`.
 */
export function localMidnightMsDaysAgo(
  nowMs: number,
  tzOffsetMinutes: number,
  daysAgo: number,
): number {
  const shifted = shiftToLocal(nowMs, tzOffsetMinutes);
  const localMidnightShiftedMs = Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate() - daysAgo,
  );
  return localMidnightShiftedMs + tzOffsetMinutes * 60_000;
}
