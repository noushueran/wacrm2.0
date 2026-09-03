import { describe, expect, it, vi } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import messages from "../../../messages/en.json";

const useQuery = vi.fn();
vi.mock("@/lib/convex/cached", () => ({
  useQuery: (...args: unknown[]) => useQuery(...args),
}));

const { EventsPanel } = await import("./events-panel");

const reportWindow = {
  sinceMs: 0,
  untilMs: 1,
  dayKeys: ["2026-09-01", "2026-09-02", "2026-09-03"],
} as never;

function render(data: unknown) {
  useQuery.mockReturnValue(data);
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={messages}>
      <EventsPanel reportWindow={reportWindow} canRead />
    </NextIntlClientProvider>,
  );
}

/**
 * Extracts the Recorded column's own cell text, anchored on the Reached
 * and Delivered cells that immediately precede it in the markup.
 *
 * A bare `toContain` on the whole page cannot isolate the Recorded cell:
 * `"—"` also appears in the timezone note ("Days in UTC — the dataset
 * timezone is unknown") and the unavailable banner ("... unavailable —
 * Graph 400: ..."), and even the tighter `">—<"` (an element whose ENTIRE
 * text is the dash) still matches the Delta cell, which renders its own
 * independent "—" for a null `delta` regardless of what Recorded shows.
 * With one row in the fixture, `">—<"` occurs twice — Recorded AND Delta
 * — so a regression that turns Recorded's null into 0 leaves one match
 * behind and a plain `toContain` still passes. Anchoring on the two
 * numeric cells that come immediately before Recorded in the row (Reached,
 * Delivered — both fixed values in every fixture below) ties the
 * assertion to that specific `<td>`.
 */
function recordedCellText(html: string, reached: number, delivered: number): string {
  const cell = '<td class="px-3 py-2 text-right tabular-nums">';
  const pattern = new RegExp(`${cell}${reached}</td>${cell}${delivered}</td>${cell}([^<]*)</td>`);
  const match = html.match(pattern);
  if (!match) {
    throw new Error("Recorded cell not found — row markup structure changed");
  }
  return match[1];
}

const baseRow = {
  stage: "qualified",
  label: "Qualified lead",
  eventName: "QualifiedLead",
  reached: 9,
  delivered: 8,
  byStatus: { pending: 0, sent: 8, unmatched: 1, error: 0, abandoned: 0, dormant: 0 },
  recorded: null as number | null,
  delta: null as number | null,
};

describe("EventsPanel", () => {
  it("renders an unknown Meta count as an em dash, never as zero", () => {
    const html = render({
      rows: [baseRow],
      meta: {
        available: false, datasetId: "ds1", tzName: null, tzOffsetMinutes: 0,
        lastSyncedAt: null, lastError: "Graph 400: no such edge",
        coverageGap: null, sinceMs: 0, untilMs: 1, catalogueSize: 8,
      },
    });
    // The Recorded cell itself — not just "some em dash somewhere" — is
    // the load-bearing check. See `recordedCellText`'s comment.
    expect(recordedCellText(html, 9, 8)).toBe("—");
    expect(html).toContain("Graph 400: no such edge");
    // The delta cell must not claim -8 from an unknown. Matched as
    // ">-8<" (a bare text node) rather than a plain substring: the
    // Radio icon's own SVG path data coincidentally contains the
    // literal substring "-8" (`d="M7.753 ... 0-8.478"`), which would
    // make a plain `toContain("-8")` a false positive unrelated to the
    // delta cell this assertion exists to check.
    expect(html).not.toContain(">-8<");
  });

  it("renders a real zero when Meta is available and recorded none", () => {
    const html = render({
      rows: [{ ...baseRow, recorded: 0, delta: -8 }],
      meta: {
        available: true, datasetId: "ds1", tzName: "Asia/Dubai",
        tzOffsetMinutes: -240, lastSyncedAt: Date.now(), lastError: null,
        coverageGap: null, sinceMs: 0, untilMs: 1, catalogueSize: 8,
      },
    });
    // The wrong-direction regression — em-dashing a genuine 0 — is what
    // this cell-scoped check catches that a page-wide `toContain` cannot.
    expect(recordedCellText(html, 9, 8)).toBe("0");
    expect(html).toContain(">-8<");
    expect(html).toContain("Asia/Dubai");
  });

  it("labels an internal-only milestone rather than hiding it", () => {
    const html = render({
      rows: [{ ...baseRow, stage: "itinerary_created", label: "Itinerary created",
               eventName: null, recorded: null, delta: null }],
      meta: {
        available: true, datasetId: "ds1", tzName: "Asia/Dubai",
        tzOffsetMinutes: -240, lastSyncedAt: Date.now(), lastError: null,
        coverageGap: null, sinceMs: 0, untilMs: 1, catalogueSize: 8,
      },
    });
    expect(html).toContain("Itinerary created");
    expect(html).toContain("Not sent to Meta");
  });

  it("explains a short coverage window, naming the range the sync has read", () => {
    // The sync worked; it has simply not read back across the selected
    // range. Same degraded treatment as the unavailable case — the query
    // sends nulls, so Recorded and Δ are already em dashes — but the
    // reason has to be on screen, or the table is a page of dashes with
    // nothing to explain them.
    const html = render({
      rows: [baseRow],
      meta: {
        available: true, datasetId: "ds1", tzName: "Asia/Dubai",
        tzOffsetMinutes: -240, lastSyncedAt: Date.now(), lastError: null,
        coverageGap: "2026-09-01 to 2026-09-03",
        sinceMs: 0, untilMs: 1, catalogueSize: 8,
      },
    });
    expect(recordedCellText(html, 9, 8)).toBe("—");
    expect(html).toContain("2026-09-01 to 2026-09-03");
    // Not reported as an error: the sync did not fail.
    expect(html).not.toContain("Meta counts unavailable — ");
  });

  it("explains a sync that has recorded no coverage bounds at all", () => {
    const html = render({
      rows: [baseRow],
      meta: {
        available: true, datasetId: "ds1", tzName: "Asia/Dubai",
        tzOffsetMinutes: -240, lastSyncedAt: Date.now(), lastError: null,
        coverageGap: "",
        sinceMs: 0, untilMs: 1, catalogueSize: 8,
      },
    });
    expect(html).toContain("has not recorded which days it has read");
  });

  it("shows the table when Meta holds events and we produced none", () => {
    // The state a fresh deployment starts in. Gating the table on our own
    // `reached` alone hid Meta's column exactly when it carried the most
    // signal — a positive delta on every row — behind "No conversion
    // events in this range."
    const html = render({
      rows: [{ ...baseRow, reached: 0, delivered: 0,
               byStatus: { pending: 0, sent: 0, unmatched: 0, error: 0, abandoned: 0, dormant: 0 },
               recorded: 5, delta: 5 }],
      meta: {
        available: true, datasetId: "ds1", tzName: "Asia/Dubai",
        tzOffsetMinutes: -240, lastSyncedAt: Date.now(), lastError: null,
        coverageGap: null, sinceMs: 0, untilMs: 1, catalogueSize: 8,
      },
    });
    expect(html).not.toContain("No conversion events in this range");
    expect(recordedCellText(html, 0, 0)).toBe("5");
    expect(html).toContain(">+5<");
  });

  it("passes the range through as rangeDays", () => {
    render({ rows: [], meta: { available: false, datasetId: null, tzName: null,
      tzOffsetMinutes: 0, lastSyncedAt: null, lastError: null,
      coverageGap: null, sinceMs: 0, untilMs: 1, catalogueSize: 8 } });
    expect(useQuery).toHaveBeenCalledWith(expect.anything(), { rangeDays: 3 });
  });

  // The header's window caption. Two things can go wrong here and both
  // would be invisible without an assertion on the rendered dates.
  //
  // The expected strings are built with the same formatter the panel uses,
  // deliberately: the display FORMAT follows the viewer's locale and is not
  // what these tests are about. What they pin is which INSTANTS get
  // formatted — the inclusive start, the last included day (not the
  // exclusive bound), and the dataset's timezone rather than UTC.
  const caption = (ms: number, tzOffsetMinutes: number) =>
    new Date(ms - tzOffsetMinutes * 60_000).toLocaleDateString(undefined, {
      day: "numeric",
      month: "short",
      timeZone: "UTC",
    });

  it("captions the window with the last INCLUDED day, not the exclusive end", () => {
    // Asia/Dubai (UTC+4 => -240). Window: 1 Sep 00:00 local through
    // 3 Sep 00:00 local, EXCLUSIVE — so the last day actually reconciled
    // is 2 Sep, and 3 Sep must not appear.
    const tz = -240;
    const local = (y: number, m: number, d: number) =>
      Date.UTC(y, m, d) + tz * 60_000;
    const sinceMs = local(2026, 8, 1);
    const untilMs = local(2026, 8, 3);
    const html = render({
      rows: [baseRow],
      meta: {
        available: true, datasetId: "ds1", tzName: "Asia/Dubai",
        tzOffsetMinutes: tz, lastSyncedAt: Date.now(), lastError: null,
        coverageGap: null, sinceMs, untilMs, catalogueSize: 8,
      },
    });
    expect(html).toContain(caption(sinceMs, tz));
    expect(html).toContain(caption(untilMs - 1, tz));
    // Naming the exclusive bound would caption the table with a day whose
    // counts are not in it.
    expect(html).not.toContain(caption(untilMs, tz));
  });

  it("captions the window in the DATASET's timezone, not UTC", () => {
    // 2 Sep 20:00 UTC is already 3 Sep in Asia/Dubai. A caption built from
    // UTC would print 2 Sep here; only the dataset's own zone agrees with
    // the counts underneath it.
    const tz = -240;
    const sinceMs = Date.UTC(2026, 8, 2, 20, 0, 0);
    const untilMs = Date.UTC(2026, 8, 3, 20, 0, 0);
    const html = render({
      rows: [baseRow],
      meta: {
        available: true, datasetId: "ds1", tzName: "Asia/Dubai",
        tzOffsetMinutes: tz, lastSyncedAt: Date.now(), lastError: null,
        coverageGap: null, sinceMs, untilMs, catalogueSize: 8,
      },
    });
    expect(html).toContain(caption(sinceMs, tz));
    // What a UTC-based caption would have printed for the same instant.
    expect(html).not.toContain(caption(sinceMs, 0));
  });
});
