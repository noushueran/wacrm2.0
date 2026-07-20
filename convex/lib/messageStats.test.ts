import { describe, it, expect } from "vitest";
import { HOUR_MS, hourStartMs, foldHoursIntoDays } from "./messageStats";

// The dashboard's messages-per-day chart used to `.collect()` every message
// in the requested window — 4096-read ceiling ÷ window, so ~137 msg/day
// broke the 30-day view and ~45 broke the 90-day one. A chart cannot be
// read-bounded (a `.take()` yields a WRONG chart, which is worse than a
// slow one), so the counts are rolled up at write time instead.
//
// Buckets are HOURLY and keyed in UTC. That makes the read cost a function
// of the requested WINDOW rather than of traffic — 24 rows per day, ~2160
// for the 90-day view — while still letting any whole-hour timezone offset
// re-bucket the hours into correct local days at read time. Asia/Dubai,
// where this CRM runs, is UTC+04:00.

describe("hourStartMs", () => {
  it("floors to the containing UTC hour", () => {
    const t = Date.parse("2026-07-09T13:42:17.512Z");
    expect(hourStartMs(t)).toBe(Date.parse("2026-07-09T13:00:00.000Z"));
  });

  it("is idempotent on an exact hour boundary", () => {
    const t = Date.parse("2026-07-09T13:00:00.000Z");
    expect(hourStartMs(t)).toBe(t);
  });

  it("puts the last millisecond of an hour in that hour, not the next", () => {
    const t = Date.parse("2026-07-09T13:59:59.999Z");
    expect(hourStartMs(t)).toBe(Date.parse("2026-07-09T13:00:00.000Z"));
  });
});

describe("foldHoursIntoDays", () => {
  const dayKeys = ["2026-07-08", "2026-07-09"];

  it("sums hourly buckets into the local day they belong to", () => {
    const rows = [
      { hourStartMs: Date.parse("2026-07-09T08:00:00.000Z"), incoming: 3, outgoing: 1 },
      { hourStartMs: Date.parse("2026-07-09T09:00:00.000Z"), incoming: 2, outgoing: 5 },
    ];
    const out = foldHoursIntoDays(rows, dayKeys, 0);
    expect(out.get("2026-07-09")).toEqual({ incoming: 5, outgoing: 6 });
    expect(out.get("2026-07-08")).toEqual({ incoming: 0, outgoing: 0 });
  });

  it("seeds every requested day so a quiet day charts as zero, not a gap", () => {
    const out = foldHoursIntoDays([], dayKeys, 0);
    expect([...out.keys()]).toEqual(dayKeys);
    expect(out.get("2026-07-08")).toEqual({ incoming: 0, outgoing: 0 });
  });

  it("shifts an hour into the correct local day for a positive offset", () => {
    // 2026-07-08T21:00Z is 2026-07-09T01:00 in Dubai (UTC+4), so it belongs
    // to the 9th locally even though it is the 8th in UTC. tzOffsetMinutes
    // follows Date.prototype.getTimezoneOffset(): west-positive, so UTC+4
    // is -240.
    const rows = [
      { hourStartMs: Date.parse("2026-07-08T21:00:00.000Z"), incoming: 7, outgoing: 0 },
    ];
    const out = foldHoursIntoDays(rows, dayKeys, -240);
    expect(out.get("2026-07-09")).toEqual({ incoming: 7, outgoing: 0 });
    expect(out.get("2026-07-08")).toEqual({ incoming: 0, outgoing: 0 });
  });

  it("drops hours outside the requested day range instead of inventing keys", () => {
    const rows = [
      { hourStartMs: Date.parse("2026-01-01T00:00:00.000Z"), incoming: 99, outgoing: 99 },
    ];
    const out = foldHoursIntoDays(rows, dayKeys, 0);
    expect([...out.keys()]).toEqual(dayKeys);
    expect(out.get("2026-07-08")).toEqual({ incoming: 0, outgoing: 0 });
    expect(out.get("2026-07-09")).toEqual({ incoming: 0, outgoing: 0 });
  });

  it("HOUR_MS is one hour", () => {
    expect(HOUR_MS).toBe(3_600_000);
  });
});
