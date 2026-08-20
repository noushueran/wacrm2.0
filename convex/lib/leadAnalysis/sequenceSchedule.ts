// ============================================================
// The follow-up sequence's scheduling math (spec §8, P3 Task 2). Pure —
// no I/O, no Date.now(), no Convex imports; every timestamp is an
// argument. This module answers WHEN a step sends; `eligibility.ts`
// (Task 1) answers WHETHER it should.
//
// All timezone/working-day arithmetic is delegated to
// `clampToWorkingHours` in `convex/lib/qualification/schedule.ts` — that
// module owns the fixed-UTC-offset, minutes-of-day, working-days math
// (deliberately no DST support). Reimplementing any of that here is
// exactly the mistake this module must not make.
//
// THE MEASUREMENT RULE:
//   - Step 0 is measured from the LAST CUSTOMER MESSAGE, with
//     `idleDaysBeforeSequence` acting as an independent floor on top of
//     the band's own step-0 delay: the effective first touch is
//     `max(idleDaysBeforeSequence, steps[0].delayDays)` days after that
//     message. Neither number alone decides it — whichever is larger
//     does, so a longer configured idle floor still holds back an
//     otherwise-fast band, and a slow band's own delay still holds even
//     with a short floor.
//   - Every later step (n > 0) is measured from the PREVIOUS FOLLOW-UP
//     SEND, never from the customer message again — the cadence is a
//     chain of sends, not a set of offsets from one fixed point.
// ============================================================

import { clampToWorkingHours, type WorkingHoursConfig } from "../qualification/schedule";

const DAY = 24 * 60 * 60_000;

export interface FirstTouchInput {
  /** The timestamp step 0's delay and the idle floor are both measured from. */
  lastCustomerMessageAt: number;
  /** The account-level floor (spec: independent of any band's own cadence). */
  idleDaysBeforeSequence: number;
  /** The resolved band's `steps[0].delayDays`. */
  step0DelayDays: number;
  config: WorkingHoursConfig;
}

/**
 * The first touch: `lastCustomerMessageAt + max(idleDaysBeforeSequence,
 * step0DelayDays)` days, clamped into working hours. Both the floor and
 * the step-0 delay are measured from the same point (the customer's last
 * message) — only the larger of the two governs, per the spec's `max`
 * rule — then the result is clamped, never sent outside configured hours.
 */
export function firstTouchAt(input: FirstTouchInput): number {
  const delayDays = Math.max(input.idleDaysBeforeSequence, input.step0DelayDays);
  const due = input.lastCustomerMessageAt + delayDays * DAY;
  return clampToWorkingHours(due, input.config);
}

export interface NextStepInput {
  /** The previous follow-up SEND — not the customer message. */
  lastFollowUpAt: number;
  /** The resolved band's `steps[n].delayDays` for the step about to fire. */
  delayDays: number;
  config: WorkingHoursConfig;
}

/**
 * Every step after the first: `lastFollowUpAt + delayDays` days, clamped
 * into working hours. Deliberately has no customer-message field in its
 * input at all — the previous send is the only anchor a later step ever
 * measures from.
 */
export function nextStepAt(input: NextStepInput): number {
  const due = input.lastFollowUpAt + input.delayDays * DAY;
  return clampToWorkingHours(due, input.config);
}

/** Whether `ts` already falls inside working hours — agrees with
 *  `clampToWorkingHours` by construction: true iff clamping is a no-op. */
export function isWithinWorkingHours(ts: number, config: WorkingHoursConfig): boolean {
  return clampToWorkingHours(ts, config) === ts;
}
