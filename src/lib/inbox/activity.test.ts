import { describe, expect, test } from "vitest";
import { filterActivity, stageI18nKey, groupActivityByDay } from "./activity";

describe("filterActivity", () => {
  const entries = [
    { kind: "note", at: 3 },
    { kind: "stage", at: 2 },
    { kind: "note", at: 1 },
  ];

  test("'all' returns everything unchanged", () => {
    expect(filterActivity(entries, "all")).toEqual(entries);
  });

  test("'notes' keeps only notes, preserving order", () => {
    expect(filterActivity(entries, "notes").map((e) => e.at)).toEqual([3, 1]);
  });

  test("does not mutate its input", () => {
    const copy = [...entries];
    filterActivity(entries, "notes");
    expect(entries).toEqual(copy);
  });
});

describe("stageI18nKey", () => {
  test("namespaces the stage under `stage.`", () => {
    expect(stageI18nKey("qualified")).toBe("stage.qualified");
  });
});

describe("groupActivityByDay", () => {
  const HOUR = 60 * 60 * 1000;
  // Local-day fixtures built from `new Date(y, m, d, h)`, not
  // `Date.parse(...Z)` — the bug this replaces (buckets by UTC, header
  // formats local) only shows up when the fixture's local calendar day
  // and UTC calendar day would actually differ, which a `Z`-suffixed
  // fixture can never exercise regardless of the test runner's TZ.
  const day1 = new Date(2026, 6, 30, 9, 0, 0).getTime(); // Jul 30, local
  const day2 = new Date(2026, 6, 31, 1, 0, 0).getTime(); // Jul 31, local

  test("groups entries falling on the same local day", () => {
    const groups = groupActivityByDay([
      { at: day2 + HOUR },
      { at: day2 },
      { at: day1 },
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0].entries).toHaveLength(2);
    expect(groups[1].entries).toHaveLength(1);
  });

  test("splits entries that cross local midnight, however close together", () => {
    // 23:59 and 00:01 local are 2 minutes apart but different local days —
    // this is exactly the boundary the UTC-bucketing bug got wrong when
    // the entries' own timestamps were later formatted in local time.
    const justBeforeMidnight = new Date(2026, 6, 30, 23, 59, 0).getTime();
    const justAfterMidnight = new Date(2026, 6, 31, 0, 1, 0).getTime();
    const groups = groupActivityByDay([
      { at: justAfterMidnight },
      { at: justBeforeMidnight },
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0].entries).toHaveLength(1);
    expect(groups[1].entries).toHaveLength(1);
  });

  test("preserves the newest-first order the query returned", () => {
    const groups = groupActivityByDay([
      { at: day1 + 2 * HOUR },
      { at: day1 + HOUR },
    ]);
    expect(groups[0].entries.map((e) => e.at)).toEqual([
      day1 + 2 * HOUR,
      day1 + HOUR,
    ]);
  });

  test("returns an empty array for no entries", () => {
    expect(groupActivityByDay([])).toEqual([]);
  });

  test("day key is stable and unique per local calendar day", () => {
    const groups = groupActivityByDay([{ at: day2 }, { at: day1 }]);
    expect(groups.map((g) => g.day)).toEqual(["2026-07-31", "2026-07-30"]);
  });
});
