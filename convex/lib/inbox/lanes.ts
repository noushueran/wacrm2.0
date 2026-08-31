// ============================================================
// Pure lane arithmetic (spec 2026-07-27-inbox-lanes §The four lanes).
// No I/O and no `Date.now()` — the caller passes `nowMs`, so every
// boundary is deterministic under test. This is the ONLY place the
// Waiting/Chasing cutoff is computed; two copies would let the two
// lanes drift apart and overlap or leave a gap.
//
// Every boundary here is also QUANTIZED — see `BOUNDARY_BUCKET_MS`.
// These values are index range keys, so they are part of the identity of
// a paginated query, and a boundary that moved on every execution broke
// pagination outright on the lanes that use one.
// ============================================================

const DAY_MS = 24 * 3_600_000;

/**
 * The step every time-derived lane boundary moves in.
 *
 * Both boundaries below are bound as INDEX RANGE keys by
 * `conversations.list` (`gt("lastMessageAt", cutoff).lte("lastMessageAt",
 * grace)`), and Convex fingerprints an index range into the pagination
 * cursor it mints from it. So a boundary computed straight off
 * `Date.now()` makes every execution of that query a *different* query,
 * and every cursor the previous execution handed out comes back
 * `InvalidCursor`.
 *
 * That is not theoretical — it is the owner's 2026-07-30 report. On
 * Waiting and Chasing, "Load more" appended nothing (47 rows -> 47 rows)
 * and the list flashed back to its skeleton on every click, because
 * `usePaginatedQuery` absorbs `InvalidCursor` by discarding all
 * pagination state and restarting from page one. The same reset fired on
 * every mutation that touched the list, which is why archiving a chat
 * "refreshed the whole section" instead of just dropping the row. Active
 * and Snoozed bind no time-derived key and paginated correctly
 * throughout; that contrast is what identified the cause.
 *
 * Flooring `nowMs` to a bucket makes repeated executions produce a
 * byte-identical range, so cursors stay valid for as long as the bucket
 * does. A bucket boundary still invalidates them once — that is the
 * normal, documented `InvalidCursor` the hook is designed to absorb, now
 * happening a few times an hour instead of on every interaction.
 *
 * 15 minutes, matching `GRACE_MINUTES`, is the coarsest step that does
 * not make a lane visibly wrong: it is what turns the grace window into
 * "15-30 minutes" rather than exactly 15, which suits a boundary whose
 * whole purpose is "a beat of silence". Widening it further to buy fewer
 * cursor resets would start parking answered threads in Active for over
 * an hour, which is the lane being wrong rather than approximate.
 */
export const BOUNDARY_BUCKET_MS = 15 * 60_000;

/**
 * `nowMs` floored to the bucket. Applied INSIDE both boundary helpers
 * rather than at the call site on purpose: `inboxChaseAssign.ts` reads
 * "exactly the Chasing lane's own DERIVED range" by calling
 * `chasingCutoffMs` itself, and a sweep whose cutoff drifted 15 minutes
 * from the lane's would hand out threads the lane does not show.
 */
function floorToBucket(nowMs: number): number {
  return Math.floor(nowMs / BOUNDARY_BUCKET_MS) * BOUNDARY_BUCKET_MS;
}

/** Never let the cutoff reach `now`: at 0 days every thread an agent
 *  just answered would render as neglected, and the auto-assign sweep
 *  would treat the whole Waiting lane as abandoned. Deliberately a hard
 *  floor rather than `min(1 day, window)` — see the note below. */
const MIN_DAYS = 1;

/**
 * The instant that divides Waiting (newer) from Chasing (at or older).
 *
 * `chasingAfterDays` absent means "exactly where the qualification
 * engine gives up" — `sessionWindowHours / 24` — so out of the box (72h)
 * the two boundaries are the same number by construction and a thread
 * can never be in Chasing while its session could still be `collecting`.
 * That is safety property two in the spec, and deriving it here rather
 * than duplicating the literal `3` is what keeps the two numbers
 * agreeing whenever an owner raises `sessionWindowHours`.
 *
 * LIMIT, stated honestly: the agreement holds for windows of 24h and up
 * only. `lib/qualification/validate.ts` permits `sessionWindowHours` as
 * low as 1, and MIN_DAYS then wins — at a 12h window the qualification
 * engine gives up at 12h but Chasing does not begin until 24h, leaving a
 * 12h band where neither works the lead. That gap is accepted, not
 * overlooked: its direction is the safe one (a thread is never in
 * Chasing while its session could still be `collecting`, so the safety
 * property itself survives), and the alternative — clamping to
 * `min(1 day, window)` so the boundaries always meet — would make a 1h
 * window put a thread answered 61 minutes ago into Chasing and hand it
 * to the auto-assign sweep. A sub-24h qualification window is not a real
 * configuration; a cutoff shorter than a working day is a real hazard.
 */
export function chasingCutoffMs(
  nowMs: number,
  config: { chasingAfterDays?: number; sessionWindowHours: number },
): number {
  const raw = config.chasingAfterDays ?? config.sessionWindowHours / 24;
  return floorToBucket(nowMs) - Math.max(raw, MIN_DAYS) * DAY_MS;
}

/**
 * How long a thread we just replied to stays in Active (owner report,
 * 2026-07-28).
 *
 * Without this the lane is a pure function of who spoke last, so a live
 * back-and-forth throws the thread across the Active/Waiting boundary on
 * every single message: the agent replies and the row they are working
 * vanishes from the list beside them, then reappears when the customer
 * answers, then vanishes again. Correct by the letter of the model and
 * unusable in practice.
 *
 * The fix reads the situation honestly rather than papering over it: a
 * conversation we answered ninety seconds ago is not "parked waiting on
 * the customer", it is live work, and Active is where live work belongs.
 * Waiting means "genuinely handed back", which needs a beat of silence
 * to be true.
 *
 * 15 minutes is chosen to comfortably span a typing exchange while
 * staying far below the Waiting/Chasing cutoff (a day at minimum), so
 * the two boundaries can never cross. A constant rather than config
 * until there is evidence a tenant needs a different value — making it
 * configurable is one field, and premature here.
 *
 * Read it as a FLOOR, not an exact figure: `BOUNDARY_BUCKET_MS` quantizes
 * the boundary, so in practice a thread we answered stays in Active for
 * 15-30 minutes depending on where in the bucket the reply landed. That
 * slack is why the bucket is 15 minutes and not an hour.
 */
const GRACE_MINUTES = 15;

/**
 * The instant that divides "still live" from Waiting. Threads whose last
 * message is OURS and newer than this stay in Active.
 *
 * Note the asymmetry, which is deliberate: this applies only when WE
 * spoke last. A thread the customer spoke on last is in Active at any
 * age, grace or no grace — that is safety property one and nothing here
 * touches it.
 */
export function graceCutoffMs(nowMs: number): number {
  return floorToBucket(nowMs) - GRACE_MINUTES * 60_000;
}
