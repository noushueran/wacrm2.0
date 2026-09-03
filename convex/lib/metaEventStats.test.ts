import { describe, it, expect } from "vitest";
import {
  META_EVENT_CATALOGUE,
  coversWindow,
  datasetDayKeys,
  datasetDayStartMs,
  dayKeyStartMs,
  sumMetaCounts,
  buildReconciliation,
} from "./metaEventStats";

describe("META_EVENT_CATALOGUE", () => {
  it("lists every funnel stage in funnel order, internal-only ones included", () => {
    expect(META_EVENT_CATALOGUE.map((r) => r.stage)).toEqual([
      "new_lead",
      "qualified",
      "price_quoted",
      "itinerary_created",
      "itinerary_sent",
      "invoice_sent",
      "purchased",
      "lost",
    ]);
  });

  it("carries the ctwa wire name, or null for an internal-only stage", () => {
    const byStage = new Map(META_EVENT_CATALOGUE.map((r) => [r.stage, r]));
    expect(byStage.get("new_lead")!.eventName).toBe("LeadSubmitted");
    expect(byStage.get("qualified")!.eventName).toBe("QualifiedLead");
    expect(byStage.get("purchased")!.eventName).toBe("Purchase");
    expect(byStage.get("itinerary_created")!.eventName).toBeNull();
    expect(byStage.get("lost")!.eventName).toBeNull();
  });

  it("carries the human label from FUNNEL_STAGES", () => {
    const byStage = new Map(META_EVENT_CATALOGUE.map((r) => [r.stage, r]));
    expect(byStage.get("qualified")!.label).toBe("Qualified lead");
  });
});

describe("datasetDayKeys", () => {
  it("returns one key per local day the window covers, ascending", () => {
    // UTC+4 (Asia/Dubai) is -240 in the tzOffsetMinutes convention used by
    // localDayKeyFromMs: local = ms - tzOffsetMinutes * 60_000.
    const tz = -240;
    const since = Date.UTC(2026, 8, 1, 20, 0, 0); // 2026-09-02 00:00 local
    const until = Date.UTC(2026, 8, 4, 20, 0, 0); // 2026-09-05 00:00 local
    expect(datasetDayKeys(since, until, tz)).toEqual([
      "2026-09-02",
      "2026-09-03",
      "2026-09-04",
    ]);
  });

  it("excludes the exclusive upper bound's own day", () => {
    const tz = 0;
    const since = Date.UTC(2026, 8, 1, 0, 0, 0);
    const until = Date.UTC(2026, 8, 2, 0, 0, 0);
    expect(datasetDayKeys(since, until, tz)).toEqual(["2026-09-01"]);
  });
});

describe("dayKeyStartMs / datasetDayStartMs", () => {
  const DUBAI = -240; // UTC+4

  it("is the exact inverse of the day-key the same offset produces", () => {
    const ms = dayKeyStartMs("2026-09-02", DUBAI);
    // 00:00 on 2026-09-02 in Asia/Dubai is 20:00 UTC the day before.
    expect(new Date(ms).toISOString()).toBe("2026-09-01T20:00:00.000Z");
    expect(datasetDayKeys(ms, ms + 1, DUBAI)).toEqual(["2026-09-02"]);
  });

  it("floors an instant to the start of its own local day, and is idempotent", () => {
    const midday = Date.parse("2026-09-02T09:00:00Z"); // 13:00 in Dubai
    const start = datasetDayStartMs(midday, DUBAI);
    expect(new Date(start).toISOString()).toBe("2026-09-01T20:00:00.000Z");
    expect(datasetDayStartMs(start, DUBAI)).toBe(start);
  });
});

describe("coversWindow", () => {
  const week = ["2026-08-28", "2026-08-29", "2026-08-30"];

  it("is false when either bound is missing — absent coverage is UNKNOWN coverage", () => {
    // The migration state (rows written before the fields existed) and
    // the never-synced state both land here. Neither may be read as
    // "everything is covered".
    expect(coversWindow(undefined, "2026-08-30", week)).toBe(false);
    expect(coversWindow("2026-08-01", undefined, week)).toBe(false);
    expect(coversWindow(undefined, undefined, week)).toBe(false);
  });

  it("is false when the window reaches back before the coverage", () => {
    expect(coversWindow("2026-08-29", "2026-08-30", week)).toBe(false);
  });

  it("is false when the window runs past the last covered day", () => {
    expect(coversWindow("2026-08-01", "2026-08-29", week)).toBe(false);
  });

  it("is true on exact bounds, inclusive at both ends", () => {
    expect(coversWindow("2026-08-28", "2026-08-30", week)).toBe(true);
  });

  it("compares across a month boundary, where string order is the only ordering available", () => {
    // "2026-09-01" > "2026-08-31" lexicographically AND chronologically —
    // the property the whole day-key comparison rests on.
    expect(coversWindow("2026-08-31", "2026-09-02", ["2026-09-01"])).toBe(true);
    expect(coversWindow("2026-09-01", "2026-09-02", ["2026-08-31"])).toBe(false);
  });
});

describe("sumMetaCounts", () => {
  it("sums per event name across only the requested days", () => {
    const rows = [
      { dayKey: "2026-09-02", eventName: "QualifiedLead", count: 5 },
      { dayKey: "2026-09-03", eventName: "QualifiedLead", count: 3 },
      { dayKey: "2026-09-09", eventName: "QualifiedLead", count: 99 },
      { dayKey: "2026-09-02", eventName: "LeadSubmitted", count: 40 },
    ];
    const out = sumMetaCounts(rows, ["2026-09-02", "2026-09-03"]);
    expect(out.get("QualifiedLead")).toBe(8);
    expect(out.get("LeadSubmitted")).toBe(40);
  });

  it("is empty, not zero-filled, for an event with no rows", () => {
    expect(sumMetaCounts([], ["2026-09-02"]).has("Purchase")).toBe(false);
  });
});

describe("buildReconciliation", () => {
  // No `eventName` on these: the fold does not consume one. It matches
  // Meta's counts on the CATALOGUE's `metaCapi` name keyed by `stage`
  // (the same stage has a different wire name per lane), which is why
  // `ConversionEventFact` no longer carries the field.
  const events = [
    { conversationId: "c1", stage: "new_lead", status: "sent" },
    { conversationId: "c1", stage: "new_lead", status: "sent" },
    { conversationId: "c2", stage: "new_lead", status: "unmatched" },
    { conversationId: "c1", stage: "qualified", status: "sent" },
  ] as const;

  it("counts reached as DISTINCT conversations, not rows", () => {
    const rows = buildReconciliation({ events: [...events], metaCounts: null });
    const newLead = rows.find((r) => r.stage === "new_lead")!;
    // c1 produced two rows for the same milestone; it is one lead.
    expect(newLead.reached).toBe(2);
  });

  it("counts delivered as distinct conversations with a sent row", () => {
    const rows = buildReconciliation({ events: [...events], metaCounts: null });
    expect(rows.find((r) => r.stage === "new_lead")!.delivered).toBe(1);
  });

  it("breaks the reached-minus-delivered gap down by status", () => {
    const rows = buildReconciliation({ events: [...events], metaCounts: null });
    const newLead = rows.find((r) => r.stage === "new_lead")!;
    expect(newLead.byStatus.sent).toBe(1);
    expect(newLead.byStatus.unmatched).toBe(1);
    expect(newLead.byStatus.error).toBe(0);
  });

  it("reports recorded and delta as null — NOT zero — when Meta is unavailable", () => {
    const rows = buildReconciliation({ events: [...events], metaCounts: null });
    for (const row of rows) {
      expect(row.recorded).toBeNull();
      expect(row.delta).toBeNull();
    }
  });

  it("reports a real zero when Meta is available and recorded nothing", () => {
    const metaCounts = new Map<string, number>([["LeadSubmitted", 1]]);
    const rows = buildReconciliation({ events: [...events], metaCounts });
    expect(rows.find((r) => r.stage === "new_lead")!.recorded).toBe(1);
    // Available, and Meta holds none of these: a genuine 0, not an unknown.
    expect(rows.find((r) => r.stage === "qualified")!.recorded).toBe(0);
  });

  it("computes delta as recorded minus delivered", () => {
    const metaCounts = new Map<string, number>([["LeadSubmitted", 3]]);
    const rows = buildReconciliation({ events: [...events], metaCounts });
    expect(rows.find((r) => r.stage === "new_lead")!.delta).toBe(2);
  });

  it("leaves internal-only stages null throughout — they are never sent", () => {
    const rows = buildReconciliation({ events: [...events], metaCounts: new Map() });
    const internal = rows.find((r) => r.stage === "itinerary_created")!;
    expect(internal.eventName).toBeNull();
    expect(internal.recorded).toBeNull();
    expect(internal.delta).toBeNull();
  });

  it("returns a row for every catalogue entry even with no events at all", () => {
    const rows = buildReconciliation({ events: [], metaCounts: null });
    expect(rows).toHaveLength(META_EVENT_CATALOGUE.length);
    expect(rows.every((r) => r.reached === 0 && r.delivered === 0)).toBe(true);
  });
});
