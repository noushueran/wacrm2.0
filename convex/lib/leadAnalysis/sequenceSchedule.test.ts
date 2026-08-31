import { expect, test } from "vitest";
import {
  firstTouchAt,
  nextStepAt,
  isWithinWorkingHours,
  type FirstTouchInput,
  type NextStepInput,
} from "./sequenceSchedule";
import type { WorkingHoursConfig } from "../qualification/schedule";

// ============================================================
// Same Dubai fixture as convex/lib/qualification/schedule.test.ts, kept
// byte-identical so the two modules' tests read side by side.
// ============================================================

const DAY = 24 * 60 * 60_000;

const DUBAI: WorkingHoursConfig = {
  utcOffsetMinutes: 240,
  workStartMinute: 10 * 60,
  workEndMinute: 21 * 60,
  workDays: [1, 2, 3, 4, 5, 6], // closed Sunday
};
const MON_NOON_GST = Date.UTC(2026, 6, 20, 8, 0); // Mon 12:00 local

// ---- firstTouchAt: the max(idleDaysBeforeSequence, step0.delayDays) floor ----

test("firstTouchAt: hot band — the idle floor (3) dominates the step-0 delay (2)", () => {
  const input: FirstTouchInput = {
    lastCustomerMessageAt: MON_NOON_GST,
    idleDaysBeforeSequence: 3,
    step0DelayDays: 2,
    config: DUBAI,
  };
  // max(3, 2) = 3 days after Mon noon = Thu noon local, inside working hours.
  expect(firstTouchAt(input)).toBe(MON_NOON_GST + 3 * DAY);
});

test("firstTouchAt: cold band — the step-0 delay (5) dominates the idle floor (3)", () => {
  const input: FirstTouchInput = {
    lastCustomerMessageAt: MON_NOON_GST,
    idleDaysBeforeSequence: 3,
    step0DelayDays: 5,
    config: DUBAI,
  };
  // max(3, 5) = 5 days after Mon noon = Sat noon local, inside working hours.
  expect(firstTouchAt(input)).toBe(MON_NOON_GST + 5 * DAY);
});

test("firstTouchAt: warm band — a tie (3, 3) still resolves to day 3", () => {
  const input: FirstTouchInput = {
    lastCustomerMessageAt: MON_NOON_GST,
    idleDaysBeforeSequence: 3,
    step0DelayDays: 3,
    config: DUBAI,
  };
  expect(firstTouchAt(input)).toBe(MON_NOON_GST + 3 * DAY);
});

test("firstTouchAt: a result landing on a non-working day rolls to the next working day's opening", () => {
  // Thu 12:00 local + 2 days = Sat 12:00 local... pick a case that lands on
  // Sunday instead: Fri noon + 2 days = Sun noon (closed) -> rolls to Mon 10:00.
  const friNoon = Date.UTC(2026, 6, 24, 8, 0); // Fri 12:00 local
  const input: FirstTouchInput = {
    lastCustomerMessageAt: friNoon,
    idleDaysBeforeSequence: 0,
    step0DelayDays: 2, // Fri + 2d = Sun, closed
    config: DUBAI,
  };
  expect(firstTouchAt(input)).toBe(Date.UTC(2026, 6, 27, 6, 0)); // Mon 10:00 local
});

test("firstTouchAt: a result landing outside working hours (but on a working day) rolls to that day's opening", () => {
  // Mon 12:00 local + 0 days delay lands back at Mon noon (in-window) — use a
  // late-in-day base instead so +1 day still lands after closing.
  const monLate = Date.UTC(2026, 6, 20, 18, 30); // Mon 22:30 local
  const input: FirstTouchInput = {
    lastCustomerMessageAt: monLate,
    idleDaysBeforeSequence: 1,
    step0DelayDays: 0,
    config: DUBAI,
  };
  // Mon 22:30 + 1 day = Tue 22:30 local -> after closing -> Wed 10:00 local.
  expect(firstTouchAt(input)).toBe(Date.UTC(2026, 6, 22, 6, 0));
});

// ---- nextStepAt: measured from the PREVIOUS FOLLOW-UP, never the customer message ----

test("nextStepAt: step n>0 is measured from lastFollowUpAt, not the customer message", () => {
  const longAgoCustomerMessage = MON_NOON_GST - 30 * DAY;
  const input: NextStepInput = {
    lastFollowUpAt: MON_NOON_GST,
    delayDays: 5,
    config: DUBAI,
  };
  // If this were (incorrectly) measured from a customer message 30 days back,
  // the result would differ wildly from lastFollowUpAt + 5 days. Assert it
  // ignores that older timestamp entirely by not passing it in at all —
  // the input shape itself has no room for a customer-message field.
  void longAgoCustomerMessage;
  expect(nextStepAt(input)).toBe(MON_NOON_GST + 5 * DAY);
});

test("nextStepAt: clamps into working hours exactly like firstTouchAt", () => {
  const monLate = Date.UTC(2026, 6, 20, 18, 30); // Mon 22:30 local
  const input: NextStepInput = { lastFollowUpAt: monLate, delayDays: 0, config: DUBAI };
  expect(nextStepAt(input)).toBe(Date.UTC(2026, 6, 21, 6, 0)); // Tue 10:00 local
});

// ---- clamping is unconditional: an in-window computed time is untouched ----

test("firstTouchAt: a computed time already inside working hours is returned unchanged", () => {
  const input: FirstTouchInput = {
    lastCustomerMessageAt: MON_NOON_GST,
    idleDaysBeforeSequence: 0,
    step0DelayDays: 0,
    config: DUBAI,
  };
  expect(firstTouchAt(input)).toBe(MON_NOON_GST);
});

// ---- isWithinWorkingHours agrees with clampToWorkingHours ----

test("isWithinWorkingHours: true for a timestamp clampToWorkingHours returns unchanged", () => {
  expect(isWithinWorkingHours(MON_NOON_GST, DUBAI)).toBe(true);
});

test("isWithinWorkingHours: false for a timestamp clampToWorkingHours would move", () => {
  const monLate = Date.UTC(2026, 6, 20, 18, 30); // Mon 22:30 local
  expect(isWithinWorkingHours(monLate, DUBAI)).toBe(false);
  const sunNoon = Date.UTC(2026, 6, 19, 8, 0); // Sun 12:00 local, closed
  expect(isWithinWorkingHours(sunNoon, DUBAI)).toBe(false);
});
