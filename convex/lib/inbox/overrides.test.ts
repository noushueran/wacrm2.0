import { expect, test } from "vitest";
import { resolveSnoozeUntilMs, MAX_SNOOZE_DAYS } from "./overrides";

const HOUR = 3_600_000;
// Wed 2026-07-29 06:00 UTC == 10:00 Dubai (UTC+4).
const NOW = Date.UTC(2026, 6, 29, 6, 0, 0);
// Dubai, opens 10:00, Mon–Sat.
const CONFIG = { utcOffsetMinutes: 240, workStartMinute: 600, workDays: [1, 2, 3, 4, 5, 6] };

test("three_hours is exactly three hours out, no working-hours rounding", () => {
  expect(resolveSnoozeUntilMs("three_hours", NOW, CONFIG)).toBe(NOW + 3 * HOUR);
});

test("tomorrow lands at the next working day's opening, in account-local time", () => {
  // Thu 30 Jul, 10:00 Dubai == 06:00 UTC.
  expect(resolveSnoozeUntilMs("tomorrow", NOW, CONFIG)).toBe(Date.UTC(2026, 6, 30, 6, 0, 0));
});

test("tomorrow skips a non-working day", () => {
  // Sat 2026-08-01 10:00 Dubai. Sunday (0) is not a workday, so "tomorrow" is Monday.
  const sat = Date.UTC(2026, 7, 1, 6, 0, 0);
  expect(resolveSnoozeUntilMs("tomorrow", sat, CONFIG)).toBe(Date.UTC(2026, 7, 3, 6, 0, 0));
});

test("next_week lands on the following Monday's opening", () => {
  expect(resolveSnoozeUntilMs("next_week", NOW, CONFIG)).toBe(Date.UTC(2026, 7, 3, 6, 0, 0));
});

test("a custom time is returned as given, floored to five minutes", () => {
  const target = NOW + 7 * HOUR + 4 * 60_000 + 37_000;
  const got = resolveSnoozeUntilMs({ customMs: target }, NOW, CONFIG);
  expect(got % 300_000).toBe(0);
  expect(got).toBeLessThanOrEqual(target);
  expect(target - got).toBeLessThan(300_000);
});

test("a custom time in the past is rejected", () => {
  expect(() => resolveSnoozeUntilMs({ customMs: NOW - HOUR }, NOW, CONFIG)).toThrow();
});

test("a custom time beyond the ceiling is rejected", () => {
  const tooFar = NOW + (MAX_SNOOZE_DAYS + 1) * 24 * HOUR;
  expect(() => resolveSnoozeUntilMs({ customMs: tooFar }, NOW, CONFIG)).toThrow();
});
