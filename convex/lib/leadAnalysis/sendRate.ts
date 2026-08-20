// ============================================================
// Fixed-window daily send cap for the follow-up sequence's marketing
// template sends (spec P3). Pure arithmetic, no Convex imports — mirrors
// the shape of `convex/lib/aiRateLimit.ts`: the mutation that uses this
// (still to be wired) reads the account's row, calls `claimSendSlot`, and
// writes the result back.
//
// THE DELIBERATE DIFFERENCE FROM `aiRateLimit.claimSlot`:
// `aiRateLimit` PACES — a refusal there means "come back in N ms",
// because the owner decided the auto-reply bot answers every message
// (see aiRateLimit.ts's own comment). A marketing TEMPLATE send is not
// that: sending it over the day's cap would spend real WhatsApp send
// quota and risk the account's Meta quality rating, so a refusal here
// means "not today, at all" — there is no `retryAfterMs` in this
// module's result at all, because there is nowhere for a caller to be
// told to retry moments later. The caller (`eligibility.ts`'s
// `daily_cap` gate) reschedules the send to a later working-hours
// window instead, same as `outside_hours` does — see that module's
// tier-4 comment.
//
// THE DAY BOUNDARY IS ACCOUNT-LOCAL, not UTC. A cap described as "100
// per day" that reset at 4am local (because the server treats midnight
// UTC as the boundary) would be a surprising, undocumented behavior
// change from what the owner configured. `dayStartFor` uses the same
// fixed-UTC-offset, no-DST arithmetic as `clampToWorkingHours` in
// `convex/lib/qualification/schedule.ts` (same `utcOffsetMinutes` the
// working hours use) — deliberately NOT reimplemented as a UTC-calendar-
// date comparison, which would silently disagree with that module
// across every non-UTC account.
// ============================================================

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** The persisted counter, one row per account (analogous to
 *  `aiRateLimit.RateWindow`, but keyed to the account-local day rather
 *  than a rolling window). */
export interface SendRateState {
  /** The account-local midnight (as a UTC ms instant) this count belongs to. */
  dayStartMs: number;
  count: number;
}

export interface ClaimSendResult {
  /** Whether a send may proceed right now. `false` means "not today" —
   *  never "try again shortly". */
  granted: boolean;
  /** Always a complete, valid state — persist this regardless of `granted`. */
  next: SendRateState;
}

/**
 * The UTC ms instant of account-local midnight for the day containing
 * `ts`, given the account's fixed UTC offset. Two timestamps in the same
 * account-local calendar day always map to the same `dayStartFor` value,
 * even when they fall on different UTC calendar dates.
 */
export function dayStartFor(ts: number, utcOffsetMinutes: number): number {
  const offsetMs = utcOffsetMinutes * MINUTE;
  const local = ts + offsetMs;
  const dayStartLocal = Math.floor(local / DAY) * DAY;
  return dayStartLocal - offsetMs;
}

/**
 * Decide whether a marketing template send may go out now, against the
 * account's daily cap.
 *
 * @param state stored counter, or null if the account has never sent.
 * @param now wall clock, passed in rather than read so this stays pure
 *   and testable without fake timers.
 * @param utcOffsetMinutes the account's fixed offset — the same value
 *   `WorkingHoursConfig.utcOffsetMinutes` carries, so the send cap's day
 *   and the working-hours day always agree.
 * @param cap sends allowed per account-local day.
 */
export function claimSendSlot(
  state: SendRateState | null,
  now: number,
  utcOffsetMinutes: number,
  cap: number,
): ClaimSendResult {
  const todayStart = dayStartFor(now, utcOffsetMinutes);

  // No state yet, or the stored window belongs to a different account-
  // local day (past OR — under clock skew — a "future" one) than today:
  // start fresh rather than accumulating onto a stale count. This is the
  // reset path a new day (or a stale, many-days-old row) both take.
  const current: SendRateState =
    state && state.dayStartMs === todayStart ? state : { dayStartMs: todayStart, count: 0 };

  if (current.count >= cap) {
    // REFUSE. Unlike `aiRateLimit.claimSlot`, there is no `retryAfterMs`
    // here at all — see the module comment. `next` is unchanged: a
    // refusal never bumps the count past the cap.
    return { granted: false, next: current };
  }

  return {
    granted: true,
    next: { dayStartMs: current.dayStartMs, count: current.count + 1 },
  };
}
