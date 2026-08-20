import { describe, it, expect } from "vitest";
import {
  CATCH_UP_WINDOW_MINUTES,
  isDailyDue,
  localDateKey,
  localMinuteOfDay,
  parseDailyTime,
} from "./schedule";

/** UTC instant helper — keeps the cases readable. */
function utc(y: number, mo: number, d: number, h: number, mi: number): number {
  return Date.UTC(y, mo - 1, d, h, mi, 0, 0);
}

const GULF = 240; // UTC+4 (Dubai) — the offset this account actually runs on
const INDIA = 330; // UTC+5:30

describe("parseDailyTime", () => {
  it("parses a 24-hour HH:mm into minutes since midnight", () => {
    expect(parseDailyTime("00:00")).toBe(0);
    expect(parseDailyTime("09:00")).toBe(540);
    expect(parseDailyTime("9:05")).toBe(545);
    expect(parseDailyTime("23:59")).toBe(1439);
    expect(parseDailyTime("  09:30  ")).toBe(570);
  });

  it("refuses everything that is not a daily time", () => {
    // The old validation accepted ANY non-empty string, so each of these
    // could be activated and would then never fire.
    expect(parseDailyTime("0 9 * * *")).toBeNull();
    expect(parseDailyTime("every morning")).toBeNull();
    expect(parseDailyTime("")).toBeNull();
    expect(parseDailyTime("24:00")).toBeNull();
    expect(parseDailyTime("09:60")).toBeNull();
    expect(parseDailyTime("09")).toBeNull();
    expect(parseDailyTime("09:5")).toBeNull();
  });
});

describe("local time at a fixed offset", () => {
  it("reads minutes-of-day in account-local time", () => {
    // 06:00 UTC is 10:00 in Dubai (+4).
    expect(localMinuteOfDay(utc(2026, 8, 9, 6, 0), GULF)).toBe(600);
    // …and 11:30 in India (+5:30).
    expect(localMinuteOfDay(utc(2026, 8, 9, 6, 0), INDIA)).toBe(690);
    expect(localMinuteOfDay(utc(2026, 8, 9, 6, 0), 0)).toBe(360);
  });

  it("rolls the local date over before UTC midnight", () => {
    // 21:00 UTC on the 9th is already 01:00 on the 10th in Dubai.
    expect(localDateKey(utc(2026, 8, 9, 21, 0), GULF)).toBe("2026-08-10");
    expect(localDateKey(utc(2026, 8, 9, 21, 0), 0)).toBe("2026-08-09");
  });
});

describe("isDailyDue", () => {
  const scheduledMinute = 540; // 09:00 local

  it("fires once local time reaches the scheduled minute", () => {
    // 05:00 UTC = 09:00 in Dubai.
    expect(
      isDailyDue({ nowMs: utc(2026, 8, 9, 5, 0), utcOffsetMinutes: GULF, scheduledMinute }),
    ).toBe(true);
  });

  it("does not fire before the scheduled minute", () => {
    // 08:59 local.
    expect(
      isDailyDue({ nowMs: utc(2026, 8, 9, 4, 59), utcOffsetMinutes: GULF, scheduledMinute }),
    ).toBe(false);
  });

  it("does not fire long after the scheduled minute", () => {
    // 20:00 local — activating a 09:00 automation in the evening must
    // not blast it immediately.
    expect(
      isDailyDue({ nowMs: utc(2026, 8, 9, 16, 0), utcOffsetMinutes: GULF, scheduledMinute }),
    ).toBe(false);
  });

  it("still catches up inside the window after a missed sweep", () => {
    const justInside = utc(2026, 8, 9, 5, 0) + (CATCH_UP_WINDOW_MINUTES - 1) * 60_000;
    const justOutside = utc(2026, 8, 9, 5, 0) + CATCH_UP_WINDOW_MINUTES * 60_000;
    expect(isDailyDue({ nowMs: justInside, utcOffsetMinutes: GULF, scheduledMinute })).toBe(true);
    expect(isDailyDue({ nowMs: justOutside, utcOffsetMinutes: GULF, scheduledMinute })).toBe(false);
  });

  it("fires only once per local day", () => {
    const at0900 = utc(2026, 8, 9, 5, 0);
    const at0915 = utc(2026, 8, 9, 5, 15);
    // Already ran at 09:00 today — the 09:15 sweep must not re-fire.
    expect(
      isDailyDue({
        nowMs: at0915,
        utcOffsetMinutes: GULF,
        scheduledMinute,
        lastExecutedAt: at0900,
      }),
    ).toBe(false);
    // Next local day is a fresh slot.
    expect(
      isDailyDue({
        nowMs: at0900 + 24 * 60 * 60_000,
        utcOffsetMinutes: GULF,
        scheduledMinute,
        lastExecutedAt: at0900,
      }),
    ).toBe(true);
  });

  it("does not wrap a late-night job past local midnight", () => {
    // 23:30 local scheduled; 00:15 local the next day is outside the
    // clamped window even though it is within 60 minutes.
    const scheduled2330 = 1410;
    // 19:30 UTC = 23:30 Dubai.
    expect(
      isDailyDue({ nowMs: utc(2026, 8, 9, 19, 30), utcOffsetMinutes: GULF, scheduledMinute: scheduled2330 }),
    ).toBe(true);
    // 20:15 UTC = 00:15 Dubai on the 10th.
    expect(
      isDailyDue({ nowMs: utc(2026, 8, 9, 20, 15), utcOffsetMinutes: GULF, scheduledMinute: scheduled2330 }),
    ).toBe(false);
  });

  it("treats a run from a previous day as no bar to today's run", () => {
    expect(
      isDailyDue({
        nowMs: utc(2026, 8, 9, 5, 0),
        utcOffsetMinutes: GULF,
        scheduledMinute,
        lastExecutedAt: utc(2026, 8, 8, 5, 0),
      }),
    ).toBe(true);
  });
});
