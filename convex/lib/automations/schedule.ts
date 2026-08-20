// ============================================================
// `time_based` automation scheduling — pure, ctx-free, unit-tested.
//
// The builder's schedule field accepts a daily "HH:mm" in ACCOUNT-LOCAL
// time. Local time is a FIXED UTC offset (`qualificationConfigs
// .utcOffsetMinutes`), not an IANA zone — the same choice schema.ts
// already documents for working hours ("Gulf/India have no DST; pure
// arithmetic, unit-testable"). Accounts with no qualification config
// fall back to UTC.
//
// The sweep that uses this runs on an interval, so "is it 09:00 yet?"
// is really "did we cross 09:00 since the last sweep, and have we
// already run today?" — `isDailyDue` answers exactly that.
// ============================================================

/**
 * How long after its scheduled minute a run may still fire. Bounds two
 * different failure modes at once:
 *
 *   - Activating a 09:00 automation at 20:00 must NOT blast it
 *     immediately just because 20:00 is "past" 09:00 today.
 *   - A sweep that misses its slot (deploy, outage, a slow tick) should
 *     still catch up shortly after rather than silently skipping a day.
 *
 * Must stay comfortably larger than the sweep interval in `crons.ts`.
 */
export const CATCH_UP_WINDOW_MINUTES = 60;

const MINUTES_PER_DAY = 1440;

/** `ms` shifted into account-local time, so the UTC getters read local. */
function shifted(ms: number, utcOffsetMinutes: number): Date {
  return new Date(ms + utcOffsetMinutes * 60_000);
}

/** Minutes since account-local midnight. */
export function localMinuteOfDay(ms: number, utcOffsetMinutes: number): number {
  const d = shifted(ms, utcOffsetMinutes);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

/**
 * Account-local calendar day as "YYYY-MM-DD" — the once-per-day key.
 * A string (not a day number) so it stays readable in logs and can't be
 * confused with a minute count.
 */
export function localDateKey(ms: number, utcOffsetMinutes: number): string {
  const d = shifted(ms, utcOffsetMinutes);
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${d.getUTCFullYear()}-${month}-${day}`;
}

/**
 * Parse the builder's schedule field: a strict 24-hour "HH:mm" (or
 * "H:mm"), returning minutes since local midnight, or `null` when it
 * isn't a valid daily time.
 *
 * Deliberately strict. The field's placeholder used to read "Cron
 * expression or HH:mm" while `validateTriggerForActivation` accepted
 * ANY non-empty string, so "every morning" or "0 9 * * *" would sail
 * through activation and then never fire. Anything this returns `null`
 * for is refused at activation instead.
 */
export function parseDailyTime(schedule: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(schedule.trim());
  if (!m) return null;
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/**
 * Should a daily automation fire on this sweep?
 *
 * True only when local time sits in `[scheduled, scheduled + catch-up)`
 * AND nothing has already run it on this local calendar day.
 *
 * The window is clamped at local midnight rather than wrapping: a 23:30
 * job that misses its slot does not fire at 00:15, because that instant
 * belongs to the NEXT local day and would both surprise the owner and
 * consume the next day's slot via the date-key check below.
 */
export function isDailyDue(input: {
  nowMs: number;
  utcOffsetMinutes: number;
  scheduledMinute: number;
  /** `automations.lastExecutedAt` — absent means it has never run. */
  lastExecutedAt?: number;
}): boolean {
  const { nowMs, utcOffsetMinutes, scheduledMinute, lastExecutedAt } = input;
  const minute = localMinuteOfDay(nowMs, utcOffsetMinutes);

  if (minute < scheduledMinute) return false;
  const windowEnd = Math.min(
    scheduledMinute + CATCH_UP_WINDOW_MINUTES,
    MINUTES_PER_DAY,
  );
  if (minute >= windowEnd) return false;

  if (
    lastExecutedAt !== undefined &&
    localDateKey(lastExecutedAt, utcOffsetMinutes) ===
      localDateKey(nowMs, utcOffsetMinutes)
  ) {
    return false;
  }

  return true;
}
