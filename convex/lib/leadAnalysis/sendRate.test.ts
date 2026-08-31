import { expect, test } from "vitest";
import { claimSendSlot, dayStartFor, type SendRateState } from "./sendRate";

// ============================================================
// Same Dubai fixture as convex/lib/qualification/schedule.test.ts and
// convex/lib/leadAnalysis/sequenceSchedule.test.ts, kept byte-identical
// so the account-local day math reads the same way everywhere it appears.
//
// Dubai (+240): Mon 2026-07-20 12:00 GST == 08:00 UTC.
// ============================================================

const DUBAI_OFFSET = 240;
const MON_NOON_GST = Date.UTC(2026, 6, 20, 8, 0); // Mon 12:00 local

// ---- dayStartFor: account-local midnight, not UTC midnight ----

test("dayStartFor: Dubai noon maps to that same local day's midnight", () => {
  // Mon 2026-07-20 00:00 local == 2026-07-19 20:00 UTC.
  expect(dayStartFor(MON_NOON_GST, DUBAI_OFFSET)).toBe(Date.UTC(2026, 6, 19, 20, 0));
});

test("dayStartFor: a moment just after local midnight still maps to that day, not the previous one", () => {
  const justAfterLocalMidnight = Date.UTC(2026, 6, 19, 20, 5); // Mon 00:05 local
  expect(dayStartFor(justAfterLocalMidnight, DUBAI_OFFSET)).toBe(Date.UTC(2026, 6, 19, 20, 0));
});

test("dayStartFor: a moment just before local midnight still maps to the earlier day", () => {
  const justBeforeLocalMidnight = Date.UTC(2026, 6, 19, 19, 55); // Sun 23:55 local
  expect(dayStartFor(justBeforeLocalMidnight, DUBAI_OFFSET)).toBe(Date.UTC(2026, 6, 18, 20, 0));
});

test("dayStartFor: offset 0 (UTC account) behaves like plain UTC midnight", () => {
  const utcNoon = Date.UTC(2026, 6, 20, 12, 0);
  expect(dayStartFor(utcNoon, 0)).toBe(Date.UTC(2026, 6, 20, 0, 0));
});

// ---- claimSendSlot: refuses, never paces ----

test("claimSendSlot: a fresh account (null state) grants and opens today's window", () => {
  const d = claimSendSlot(null, MON_NOON_GST, DUBAI_OFFSET, 5);
  expect(d.granted).toBe(true);
  expect(d.next).toEqual<SendRateState>({
    dayStartMs: dayStartFor(MON_NOON_GST, DUBAI_OFFSET),
    count: 1,
  });
});

test("claimSendSlot: increments the count within the same local day", () => {
  const current: SendRateState = {
    dayStartMs: dayStartFor(MON_NOON_GST, DUBAI_OFFSET),
    count: 2,
  };
  const later = MON_NOON_GST + 60 * 60_000; // an hour later, same local day
  const d = claimSendSlot(current, later, DUBAI_OFFSET, 5);
  expect(d.granted).toBe(true);
  expect(d.next).toEqual<SendRateState>({ dayStartMs: current.dayStartMs, count: 3 });
});

test("claimSendSlot: grants exactly up to the cap", () => {
  const current: SendRateState = {
    dayStartMs: dayStartFor(MON_NOON_GST, DUBAI_OFFSET),
    count: 4, // cap - 1
  };
  const d = claimSendSlot(current, MON_NOON_GST, DUBAI_OFFSET, 5);
  expect(d.granted).toBe(true);
  expect(d.next.count).toBe(5);
});

test("claimSendSlot: refuses at the cap, and the refusal is final for today — not a pace", () => {
  const current: SendRateState = {
    dayStartMs: dayStartFor(MON_NOON_GST, DUBAI_OFFSET),
    count: 5, // at cap
  };
  const d = claimSendSlot(current, MON_NOON_GST, DUBAI_OFFSET, 5);
  expect(d.granted).toBe(false);
  // Unlike aiRateLimit.claimSlot, there is no `retryAfterMs` at all — the
  // shape itself has nowhere to put a "come back in N ms" instruction.
  expect(d).not.toHaveProperty("retryAfterMs");
  // The count is NOT bumped past the cap on a refusal.
  expect(d.next).toEqual<SendRateState>({ dayStartMs: current.dayStartMs, count: 5 });
});

test("claimSendSlot: a new local day resets the window even though it was exhausted", () => {
  const current: SendRateState = {
    dayStartMs: dayStartFor(MON_NOON_GST, DUBAI_OFFSET),
    count: 5, // fully spent Monday's budget
  };
  const tueNoonGst = MON_NOON_GST + 24 * 60 * 60_000;
  const d = claimSendSlot(current, tueNoonGst, DUBAI_OFFSET, 5);
  expect(d.granted).toBe(true);
  expect(d.next).toEqual<SendRateState>({
    dayStartMs: dayStartFor(tueNoonGst, DUBAI_OFFSET),
    count: 1,
  });
});

test("claimSendSlot: a state stale by many days resets rather than accumulating", () => {
  const current: SendRateState = {
    dayStartMs: dayStartFor(MON_NOON_GST, DUBAI_OFFSET) - 10 * 24 * 60 * 60_000, // 10 days stale
    count: 5,
  };
  const d = claimSendSlot(current, MON_NOON_GST, DUBAI_OFFSET, 5);
  expect(d.granted).toBe(true);
  expect(d.next).toEqual<SendRateState>({
    dayStartMs: dayStartFor(MON_NOON_GST, DUBAI_OFFSET),
    count: 1,
  });
});

test("claimSendSlot: honours a non-zero utcOffsetMinutes — refuses across a UTC calendar-date rollover that is still the same local day", () => {
  // Local Tuesday 01:00 GST == 2026-07-20 21:00 UTC (still July 20 in UTC).
  const tueEarlyLocal = Date.UTC(2026, 6, 20, 21, 0);
  const afterFirstSend: SendRateState = {
    dayStartMs: dayStartFor(tueEarlyLocal, DUBAI_OFFSET),
    count: 1, // cap of 1, spent
  };
  // Local Tuesday 20:00 GST == 2026-07-21 16:00 UTC — a DIFFERENT UTC
  // calendar date (July 21), but the SAME account-local day (Tuesday).
  // A day-boundary check that used UTC calendar dates instead of the
  // account offset would wrongly treat this as a new day and grant here;
  // the correct, offset-aware boundary must still refuse.
  const laterSameLocalDay = Date.UTC(2026, 6, 21, 16, 0);
  const d = claimSendSlot(afterFirstSend, laterSameLocalDay, DUBAI_OFFSET, 1);
  expect(d.granted).toBe(false);
  expect(d.next).toEqual<SendRateState>({
    dayStartMs: afterFirstSend.dayStartMs,
    count: 1,
  });
});

test("claimSendSlot: honours a non-zero utcOffsetMinutes — grants once the account-local day actually rolls over", () => {
  const tueEarlyLocal = Date.UTC(2026, 6, 20, 21, 0); // Tue 01:00 GST
  const afterFirstSend: SendRateState = {
    dayStartMs: dayStartFor(tueEarlyLocal, DUBAI_OFFSET),
    count: 1,
  };
  const wedJustAfterMidnightLocal = Date.UTC(2026, 6, 21, 20, 5); // Wed 00:05 GST
  const d = claimSendSlot(afterFirstSend, wedJustAfterMidnightLocal, DUBAI_OFFSET, 1);
  expect(d.granted).toBe(true);
  expect(d.next).toEqual<SendRateState>({
    dayStartMs: dayStartFor(wedJustAfterMidnightLocal, DUBAI_OFFSET),
    count: 1,
  });
});

test("claimSendSlot: `next` is always a complete, valid state on both outcomes", () => {
  const granted = claimSendSlot(null, MON_NOON_GST, DUBAI_OFFSET, 1);
  expect(typeof granted.next.dayStartMs).toBe("number");
  expect(typeof granted.next.count).toBe("number");

  const refused = claimSendSlot(granted.next, MON_NOON_GST, DUBAI_OFFSET, 1);
  expect(refused.granted).toBe(false);
  expect(typeof refused.next.dayStartMs).toBe("number");
  expect(typeof refused.next.count).toBe("number");
  expect(refused.next.count).toBeLessThanOrEqual(1);
});
