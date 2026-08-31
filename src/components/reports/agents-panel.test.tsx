import { describe, expect, it, vi } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import messages from "../../../messages/en.json";

/**
 * Static-render tests for the Agents panel, matching this repo's other
 * component tests (`run-stats-bar.test.tsx`, `lead-analysis-list.test.tsx`) —
 * there is no jsdom and no Testing Library here, so these assert on markup.
 *
 * Two things this covers that `convex/reports.test.ts` cannot:
 *
 *  1. The i18n keys. Rendering against the REAL `messages/en.json` means a
 *     missing or typo'd `Reports.agents.*` key fails here, rather than
 *     shipping and showing a raw key string on screen. That is the live risk
 *     for this panel specifically: its copy was added to `en.json` by hand.
 *  2. The arithmetic ON SCREEN — the totals column, the totals row and the
 *     released row are computed in the component, not by the query, so they
 *     are only ever exercised here.
 *
 * The panel is browser-unverifiable until `assignmentsByAgent` is deployed
 * (the query does not exist on the backend yet), which is what makes a render
 * test the meaningful check rather than a formality.
 */

// The panel's only data dependency. Mocked at the module boundary so the test
// never needs a Convex client, an account, or a session.
const useQuery = vi.fn();
vi.mock("@/lib/convex/cached", () => ({
  useQuery: (...args: unknown[]) => useQuery(...args),
}));

// Recharts measures its container with ResizeObserver, which does not exist
// in this project's plain-"node" test environment. The chart is not what
// these tests assert on — the table is — so it is stubbed to a marker element
// that proves the panel reached the chart branch at all.
vi.mock("recharts", () => {
  const stub = (element: string) => {
    // `name` is rendered as text rather than dropped: on `<Bar>` it is the
    // series label real Recharts puts in the legend, and it is the only place
    // the "N other agents" pooling label appears. A stub that swallowed it
    // would make that assertion vacuous.
    const Component = ({
      children,
      name,
    }: {
      children?: React.ReactNode;
      name?: string;
    }) =>
      React.createElement(
        "div",
        { "data-chart": element },
        name ?? null,
        children,
      );
    Component.displayName = element;
    return Component;
  };
  return {
    ResponsiveContainer: stub("ResponsiveContainer"),
    BarChart: stub("BarChart"),
    Bar: stub("Bar"),
    XAxis: stub("XAxis"),
    YAxis: stub("YAxis"),
    CartesianGrid: stub("CartesianGrid"),
    Tooltip: stub("Tooltip"),
    Legend: stub("Legend"),
  };
});

const { AgentsPanel } = await import("./agents-panel");
const { reportWindow, ASSIGNMENT_HISTORY_FLOOR_MS } = await import(
  "@/lib/reports/types"
);

type PanelData = {
  days: Array<{
    dayKey: string;
    byAgent: Record<string, number>;
    released: number;
  }>;
  agents: Array<{ userId: string; name: string | null; total: number }>;
  truncated: boolean;
  earliestCoveredDay: string | null;
};

function render(data: PanelData | undefined, sinceMs?: number) {
  useQuery.mockReturnValue(data);
  // A window whose `dayKeys` are irrelevant to the panel (it renders
  // `data.days`, not the window) but whose `sinceMs` drives the history-floor
  // note. Defaults to well AFTER the floor so the note stays off unless a
  // test asks for it.
  const base = reportWindow(7);
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={messages}>
      {React.createElement(AgentsPanel, {
        reportWindow: {
          ...base,
          sinceMs: sinceMs ?? ASSIGNMENT_HISTORY_FLOOR_MS + 86_400_000,
        },
        canRead: true,
      })}
    </NextIntlClientProvider>,
  );
}

function visibleText(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

const TWO_AGENTS: PanelData = {
  days: [
    { dayKey: "2026-08-19", byAgent: { u1: 23, u2: 19 }, released: 2 },
    { dayKey: "2026-08-20", byAgent: { u1: 24 }, released: 0 },
  ],
  agents: [
    { userId: "u1", name: "Ashna", total: 47 },
    { userId: "u2", name: "Rahul", total: 19 },
  ],
  truncated: false,
  earliestCoveredDay: null,
};

describe("AgentsPanel", () => {
  it("resolves every translation key it uses", () => {
    const text = visibleText(render(TWO_AGENTS));
    // A missing key renders as the raw dotted path, so this is the guard
    // against a typo in the hand-edited `messages/en.json`.
    expect(text).not.toMatch(/Reports\.agents\./);
    expect(text).not.toMatch(/agents\.[a-zA-Z]+/);
    expect(text).toContain("Leads assigned per agent");
    expect(text).toContain("Day by day");
    expect(text).toContain("Released to pool");
  });

  it("renders each agent's row and the totals column", () => {
    const text = visibleText(render(TWO_AGENTS));
    expect(text).toContain("Ashna");
    expect(text).toContain("Rahul");
    // Column headers are trimmed to MM-DD to keep 90 columns readable.
    expect(text).toContain("08-19");
    expect(text).toContain("08-20");
  });

  it("sums the day totals and the released row from the day data", () => {
    const html = render(TWO_AGENTS);
    // 23 + 19 on the 19th, 24 on the 20th, 66 overall — computed in the
    // component, so nothing else in the suite covers this.
    expect(html).toContain(">42</td>");
    expect(html).toContain(">24</td>");
    expect(html).toContain(">66</td>");
    // Released: 2 + 0 = 2, and it is NOT added to any agent's total.
    expect(visibleText(html)).toContain("Released to pool 2 0 2");
  });

  it("labels an assignee with no membership row as a former member", () => {
    const text = visibleText(
      render({
        days: [{ dayKey: "2026-08-19", byAgent: { gone: 4 }, released: 0 }],
        agents: [{ userId: "gone", name: null, total: 4 }],
        truncated: false,
        earliestCoveredDay: null,
      }),
    );
    expect(text).toContain("Former member");
  });

  it("pools agents past the chart limit but still lists them all", () => {
    const agents = Array.from({ length: 11 }, (_, i) => ({
      userId: `u${i}`,
      name: `Agent ${i}`,
      total: 11 - i,
    }));
    const text = visibleText(
      render({
        days: [
          {
            dayKey: "2026-08-19",
            byAgent: Object.fromEntries(agents.map((a) => [a.userId, a.total])),
            released: 0,
          },
        ],
        agents,
        truncated: false,
        earliestCoveredDay: null,
      }),
    );
    // 11 agents, 8 charted -> 3 pooled.
    expect(text).toContain("3 other agents");
    // ...but the table names every one of them, including the pooled tail.
    for (const agent of agents) expect(text).toContain(agent.name);
  });

  it("explains an empty range instead of drawing a flat chart", () => {
    const text = visibleText(
      render({
        days: [{ dayKey: "2026-08-19", byAgent: {}, released: 0 }],
        agents: [],
        truncated: false,
        earliestCoveredDay: null,
      }),
    );
    expect(text).toContain("No leads were assigned in this range");
  });

  it("warns when the window reaches back before assignment history began", () => {
    const before = visibleText(
      render(TWO_AGENTS, ASSIGNMENT_HISTORY_FLOOR_MS - 86_400_000),
    );
    expect(before).toContain("Assignment history starts on 2026-08-13");

    // ...and stays quiet when the whole window is inside recorded history.
    const after = visibleText(
      render(TWO_AGENTS, ASSIGNMENT_HISTORY_FLOOR_MS + 86_400_000),
    );
    expect(after).not.toContain("Assignment history starts");
  });

  it("names the first incomplete day when the read was capped", () => {
    const text = visibleText(
      render({ ...TWO_AGENTS, truncated: true, earliestCoveredDay: "2026-08-19" }),
    );
    expect(text).toContain("12,000");
    expect(text).toContain("2026-08-19");
  });

  it("renders a skeleton, not a crash, before the query resolves", () => {
    expect(() => render(undefined)).not.toThrow();
  });
});
