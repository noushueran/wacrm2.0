import { expect, test } from "vitest";
import {
  localDayKeyFromMs,
  localMidnightMsDaysAgo,
  localMondayIndexFromMs,
} from "./dashboardDate";

// ============================================================
// UTC (tzOffsetMinutes = 0) — the trivial case, where every helper
// should agree with plain UTC-getter arithmetic.
// ============================================================

test("localDayKeyFromMs returns the UTC calendar day when tzOffsetMinutes is 0", () => {
  expect(
    localDayKeyFromMs(Date.parse("2026-07-09T23:59:00.000Z"), 0),
  ).toBe("2026-07-09");
  expect(
    localDayKeyFromMs(Date.parse("2026-07-09T00:00:00.000Z"), 0),
  ).toBe("2026-07-09");
});

test("localMondayIndexFromMs returns 0=Mon...6=Sun against UTC when tzOffsetMinutes is 0", () => {
  // 2026-07-06 is a Monday, 2026-07-12 is a Sunday.
  expect(localMondayIndexFromMs(Date.parse("2026-07-06T12:00:00.000Z"), 0)).toBe(0);
  expect(localMondayIndexFromMs(Date.parse("2026-07-07T12:00:00.000Z"), 0)).toBe(1);
  expect(localMondayIndexFromMs(Date.parse("2026-07-09T12:00:00.000Z"), 0)).toBe(3);
  expect(localMondayIndexFromMs(Date.parse("2026-07-12T12:00:00.000Z"), 0)).toBe(6);
});

test("localMidnightMsDaysAgo walks back local calendar days against UTC when tzOffsetMinutes is 0", () => {
  const now = Date.parse("2026-07-09T10:00:00.000Z");
  expect(localMidnightMsDaysAgo(now, 0, 0)).toBe(
    Date.parse("2026-07-09T00:00:00.000Z"),
  );
  expect(localMidnightMsDaysAgo(now, 0, 1)).toBe(
    Date.parse("2026-07-08T00:00:00.000Z"),
  );
  expect(localMidnightMsDaysAgo(now, 0, 13)).toBe(
    Date.parse("2026-06-26T00:00:00.000Z"),
  );
});

// ============================================================
// Non-zero offsets — proves the shift actually changes which calendar
// day/week an instant falls into, not just relabels UTC.
// ============================================================

test("localDayKeyFromMs rolls a timestamp into the NEXT local day for a positive UTC offset (e.g. India, UTC+5:30)", () => {
  const tzOffsetMinutes = -330; // UTC+5:30 -> getTimezoneOffset() convention is negative
  // 20:00 UTC on the 8th is 01:30 local on the 9th.
  expect(
    localDayKeyFromMs(Date.parse("2026-07-08T20:00:00.000Z"), tzOffsetMinutes),
  ).toBe("2026-07-09");
  // 10:00 UTC on the 8th is still the 8th locally (15:30).
  expect(
    localDayKeyFromMs(Date.parse("2026-07-08T10:00:00.000Z"), tzOffsetMinutes),
  ).toBe("2026-07-08");
});

test("localDayKeyFromMs rolls a timestamp into the PREVIOUS local day for a negative UTC offset (e.g. US Eastern, UTC-5)", () => {
  const tzOffsetMinutes = 300; // UTC-5
  // 02:00 UTC on the 8th is 21:00 local on the 7th.
  expect(
    localDayKeyFromMs(Date.parse("2026-01-08T02:00:00.000Z"), tzOffsetMinutes),
  ).toBe("2026-01-07");
});

test("localMidnightMsDaysAgo accounts for a non-zero offset", () => {
  const tzOffsetMinutes = -330; // India, UTC+5:30
  const now = Date.parse("2026-07-09T10:00:00.000Z"); // 15:30 local
  expect(localMidnightMsDaysAgo(now, tzOffsetMinutes, 0)).toBe(
    Date.parse("2026-07-08T18:30:00.000Z"),
  );
  expect(localMidnightMsDaysAgo(now, tzOffsetMinutes, 1)).toBe(
    Date.parse("2026-07-07T18:30:00.000Z"),
  );
});

test("localMondayIndexFromMs uses the LOCAL day-of-week, not the UTC one, near a day boundary", () => {
  const tzOffsetMinutes = -330; // India, UTC+5:30
  // 20:00 UTC Wed 8th is 01:30 local Thu 9th -> mondayIndex should be
  // Thursday's (3), not Wednesday's (2).
  expect(
    localMondayIndexFromMs(Date.parse("2026-07-08T20:00:00.000Z"), tzOffsetMinutes),
  ).toBe(3);
});
