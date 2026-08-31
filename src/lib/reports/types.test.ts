import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ASSIGNMENT_HISTORY_FLOOR_DAY,
  ASSIGNMENT_HISTORY_FLOOR_MS,
  RANGE_OPTIONS,
  REPORT_TABS,
  parseRange,
  parseTab,
  reportWindow,
} from "./types";

describe("parseTab", () => {
  it("accepts every value in REPORT_TABS", () => {
    for (const tab of REPORT_TABS) {
      expect(parseTab(tab)).toBe(tab);
    }
  });

  it("defaults to conversations for null, empty, or unknown values", () => {
    expect(parseTab(null)).toBe("conversations");
    expect(parseTab("")).toBe("conversations");
    expect(parseTab("bogus")).toBe("conversations");
  });
});

describe("parseRange", () => {
  it("accepts every value in RANGE_OPTIONS", () => {
    for (const range of RANGE_OPTIONS) {
      expect(parseRange(String(range))).toBe(range);
    }
  });

  it("defaults to 30 for null, empty, unknown, or non-numeric values", () => {
    expect(parseRange(null)).toBe(30);
    expect(parseRange("")).toBe(30);
    expect(parseRange("14")).toBe(30);
    expect(parseRange("not-a-number")).toBe(30);
  });
});

describe("reportWindow", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 4, 18, 13, 45)); // Mon 2026-05-18, local
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sinceMs is local midnight of the first day in range", () => {
    const w = reportWindow(7);
    expect(new Date(w.sinceMs)).toEqual(new Date(2026, 4, 12, 0, 0, 0, 0));
  });

  it("untilMs is local midnight of the day AFTER today — exclusive, not today's own midnight", () => {
    const w = reportWindow(7);
    expect(new Date(w.untilMs)).toEqual(new Date(2026, 4, 19, 0, 0, 0, 0));
    // Regression guard for the brief's original omission of `untilMs`:
    // it must be strictly past the end of today, or a window ending
    // "today" would silently drop today's own data.
    expect(w.untilMs).toBeGreaterThan(
      new Date(2026, 4, 18, 23, 59, 59, 999).getTime(),
    );
  });

  it("dayKeys spans exactly `range` chronological local days ending today", () => {
    const w = reportWindow(7);
    expect(w.dayKeys).toEqual([
      "2026-05-12",
      "2026-05-13",
      "2026-05-14",
      "2026-05-15",
      "2026-05-16",
      "2026-05-17",
      "2026-05-18",
    ]);
  });

  it("weekKeys are deduplicated Mondays covering the range, in chronological order", () => {
    const w = reportWindow(7);
    // 2026-05-12 (Tue) falls in the week of Mon 2026-05-11; 2026-05-18
    // (Mon) starts the next week — so this 7-day range spans two weeks.
    expect(w.weekKeys).toEqual(["2026-05-11", "2026-05-18"]);
  });

  it("weekKeys collapse to one entry when the range is exactly one Mon-Sun week", () => {
    vi.setSystemTime(new Date(2026, 4, 17, 9, 0)); // Sun 2026-05-17
    const w = reportWindow(7);
    expect(w.dayKeys).toEqual([
      "2026-05-11",
      "2026-05-12",
      "2026-05-13",
      "2026-05-14",
      "2026-05-15",
      "2026-05-16",
      "2026-05-17",
    ]);
    expect(w.weekKeys).toEqual(["2026-05-11"]);
  });

  it("partialWeekKeys flags BOTH weeks of a 7-day range that straddles a Monday", () => {
    // Tue 2026-05-12 → Mon 2026-05-18. The week of Mon 2026-05-11
    // contributes 6 of its 7 days and the week of Mon 2026-05-18 just
    // one, so neither bar is a full week's volume — the case that makes
    // the trailing bar look like a collapse if left unlabelled.
    const w = reportWindow(7);
    expect(w.partialWeekKeys).toEqual(["2026-05-11", "2026-05-18"]);
  });

  it("partialWeekKeys is empty when the range is exactly one Mon-Sun week", () => {
    vi.setSystemTime(new Date(2026, 4, 17, 9, 0)); // Sun 2026-05-17
    const w = reportWindow(7);
    expect(w.partialWeekKeys).toEqual([]);
  });

  it("partialWeekKeys flags only the clipped leading and trailing weeks of a longer range", () => {
    // Sun 2026-04-19 → Mon 2026-05-18: the leading week (Mon 2026-04-13)
    // contributes only its Sunday and the trailing week (Mon 2026-05-18)
    // only its Monday; the four weeks between are fully covered.
    const w = reportWindow(30);
    expect(w.weekKeys).toEqual([
      "2026-04-13",
      "2026-04-20",
      "2026-04-27",
      "2026-05-04",
      "2026-05-11",
      "2026-05-18",
    ]);
    expect(w.partialWeekKeys).toEqual(["2026-04-13", "2026-05-18"]);
  });

  it("partialWeekKeys is always a subset of weekKeys, for every range", () => {
    for (const range of RANGE_OPTIONS) {
      const w = reportWindow(range);
      for (const key of w.partialWeekKeys) {
        expect(w.weekKeys).toContain(key);
      }
    }
  });

  it("tzOffsetMinutes matches the runtime's current offset", () => {
    const w = reportWindow(30);
    expect(w.tzOffsetMinutes).toBe(new Date().getTimezoneOffset());
  });

  it("every RANGE_OPTIONS value produces exactly that many day keys, ending today", () => {
    for (const range of RANGE_OPTIONS) {
      const w = reportWindow(range);
      expect(w.dayKeys).toHaveLength(range);
      expect(w.dayKeys[w.dayKeys.length - 1]).toBe("2026-05-18");
    }
  });

  it("reports days per week that sum to the range length", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-05-18T10:00:00Z")); // a Monday
      const w = reportWindow(30);
      const total = Object.values(w.daysPerWeek).reduce((a, b) => a + b, 0);
      expect(total).toBe(30);
      expect(
        Object.values(w.daysPerWeek).filter((n) => n === 7).length,
      ).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("ASSIGNMENT_HISTORY_FLOOR", () => {
  // The env var is read once at module load, so this suite covers the
  // FALLBACK branch — the one every deployment that forgets to set
  // `NEXT_PUBLIC_ASSIGNMENT_HISTORY_FLOOR_DAY` actually takes. The
  // override branch is exercised by setting the variable, which vitest
  // cannot do per-test against an already-imported module.
  it("falls back to a valid day when the env var is unset", () => {
    expect(ASSIGNMENT_HISTORY_FLOOR_DAY).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  // The guard that matters: `NaN` would make `sinceMs < floor` always
  // false, silently dropping the "history starts on" caveat instead of
  // showing a wrong one. Never NaN, whatever the configured value.
  it("never yields NaN, so the caveat comparison stays meaningful", () => {
    expect(Number.isNaN(ASSIGNMENT_HISTORY_FLOOR_MS)).toBe(false);
    expect(ASSIGNMENT_HISTORY_FLOOR_MS).toBeGreaterThanOrEqual(0);
  });

  it("parses the day string it reports, at local midnight", () => {
    const [y, m, d] = ASSIGNMENT_HISTORY_FLOOR_DAY.split("-").map(Number);
    expect(ASSIGNMENT_HISTORY_FLOOR_MS).toBe(new Date(y, m - 1, d).getTime());
  });
});
