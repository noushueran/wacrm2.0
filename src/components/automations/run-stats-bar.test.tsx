import { describe, expect, it } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import messages from "../../../messages/en.json";

import { RunStatsBar } from "./run-stats-bar";
import type { RunCounts } from "../../../convex/lib/automations/runStats";

/**
 * Static-render tests, matching this repo's other component tests
 * (`lead-analysis-list.test.tsx`, `conversation-list.test.tsx`) — there
 * is no jsdom and no Testing Library here, so these assert on markup.
 *
 * Renders against the REAL `messages/en.json` (via `NextIntlClientProvider`,
 * the same pattern `lead-analysis-list.test.tsx` uses for a component that
 * calls `useTranslations` internally) rather than a stub translator, so a
 * typo'd or missing `Automations.stats.*` key fails this test instead of
 * only showing up as a raw key string in the browser.
 */
function render(counts: RunCounts, size?: "sm" | "md") {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={messages}>
      {React.createElement(RunStatsBar, { counts, size })}
    </NextIntlClientProvider>,
  );
}

/**
 * `renderToStaticMarkup` returns an HTML string, not a live DOM (this
 * project's `src/**` tests run under plain "node" — no jsdom, no
 * `document`, see vitest.config.ts). Stripping tags approximates
 * `Element.textContent` closely enough for this component's simple,
 * non-nested inline markup: whatever text a screen reader, copy-paste,
 * or browser find-in-page would actually encounter, with pure-CSS
 * (`gap-1`) spacing — which never appears in text content — excluded.
 */
function visibleText(html: string): string {
  return html.replace(/<[^>]+>/g, "");
}

const BASE: RunCounts = {
  enrolled: 10,
  waiting: 3,
  running: 1,
  completed: 5,
  failed: 1,
  cancelled: 0,
};

describe("RunStatsBar", () => {
  it("renders the four core figures with their labels", () => {
    const html = render(BASE);
    expect(html).toContain(">10</strong> Enrolled");
    expect(html).toContain(">3</strong> Waiting");
    // "Sent" reads off `completed`, not a literal `sent` field.
    expect(html).toContain(">5</strong> Sent");
    expect(html).toContain(">1</strong> Failed");
  });

  // ============================================================
  // Fix round (code review on Task 8): the number and its label had no
  // ACTUAL whitespace between them — only a `gap-1` flexbox gap, which
  // is pure CSS and never shows up in `textContent`, copy-paste, browser
  // find-in-page, or some screen readers. `textContent` would have read
  // "0Enrolled". The four assertions immediately above happened to
  // encode that exact bug as the expected value (`>10</strong>Enrolled`,
  // no space) — they passed before this fix and had to be corrected
  // alongside it, which is itself evidence they weren't testing the
  // right thing. This test asserts on the visible text specifically, not
  // on markup adjacency, so it can't make that mistake again.
  // ============================================================

  it("keeps a real space between the number and its label in the visible text, not just a CSS gap", () => {
    const text = visibleText(render(BASE));
    expect(text).toContain("10 Enrolled");
    expect(text).toContain("3 Waiting");
    expect(text).toContain("5 Sent");
    expect(text).toContain("1 Failed");
    // The literal regression, spelled out: these must NOT appear.
    expect(text).not.toContain("10Enrolled");
    expect(text).not.toContain("3Waiting");
    expect(text).not.toContain("5Sent");
    expect(text).not.toContain("1Failed");
  });

  it("omits the cancelled figure when it is zero", () => {
    const html = render({ ...BASE, cancelled: 0 });
    expect(html).not.toContain("Cancelled");
  });

  it("shows the cancelled figure only when non-zero", () => {
    const html = render({ ...BASE, cancelled: 2 });
    expect(html).toContain(">2</strong> Cancelled");
  });

  it("colours the waiting figure amber and leaves enrolled/sent neutral", () => {
    const html = render(BASE);
    expect(html).toMatch(/text-amber-500[^>]*>3</);
    // Neither of the neutral figures' <strong> tags should carry the
    // amber or destructive classes.
    expect(html).not.toMatch(/text-amber-500[^>]*>10</);
    expect(html).not.toMatch(/text-destructive[^>]*>10</);
  });

  it("colours the failed figure destructive", () => {
    const html = render(BASE);
    expect(html).toMatch(/text-destructive[^>]*>1</);
  });

  it("colours waiting/failed even when they are zero — colour marks the figure, not the value", () => {
    const html = render({ ...BASE, waiting: 0, failed: 0 });
    expect(html).toMatch(/text-amber-500[^>]*>0</);
    expect(html).toMatch(/text-destructive[^>]*>0</);
  });

  it("still renders all zeroes for a never-run automation, rather than hiding the bar", () => {
    const zero: RunCounts = {
      enrolled: 0,
      waiting: 0,
      running: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
    };
    const html = render(zero);
    expect(html).toContain(">0</strong> Enrolled");
    expect(html).not.toContain("Cancelled");
  });

  it("uses a smaller text scale for size='sm' than the size='md' default", () => {
    const sm = render(BASE, "sm");
    const md = render(BASE, "md");
    expect(sm).toContain("text-xs");
    expect(md).toContain("text-base");
    expect(md).not.toContain("text-xs");
  });

  // ============================================================
  // Re-review residual (2026-08): `countRunsBounded`
  // (`convex/automations.ts`) caps each status's read, so a busy
  // automation's counts can be a FLOOR rather than exact. The server
  // already logs this via `console.warn`, but that goes to Convex logs
  // nobody looking at this page ever sees — the brief's "reads as
  // complete when it isn't" concern, just moved from the read to the
  // payload. These assert on the actual RENDERED text (not just that
  // `countRunsBounded` returns a `truncated` flag — that's covered in
  // `convex/automations.test.ts`), since a flag nothing renders would
  // reopen the exact same silent-truncation failure one layer up.
  // ============================================================

  it("marks every figure with a '+' and shows a footnote when counts.truncated is true", () => {
    const html = render({ ...BASE, truncated: true });
    const text = visibleText(html);
    expect(text).toContain("10+ Enrolled");
    expect(text).toContain("3+ Waiting");
    expect(text).toContain("5+ Sent");
    expect(text).toContain("1+ Failed");
    // The footnote itself, from next-intl (`Automations.stats.truncated`
    // in messages/en.json) — not a hardcoded string here, so a missing
    // key fails this test rather than only showing a raw key in the UI.
    expect(text).toContain("Showing at least these counts");
  });

  it("shows no '+' suffix and no footnote when counts.truncated is false or absent", () => {
    const notTruncated = visibleText(render({ ...BASE, truncated: false }));
    expect(notTruncated).toContain("10 Enrolled");
    expect(notTruncated).not.toContain("10+");
    expect(notTruncated).not.toContain("Showing at least these counts");

    // `truncated` is optional — omitting it entirely (every pre-existing
    // caller/test, and any `RunCounts` built before this field existed)
    // must read exactly the same as `false`, not crash or misrender.
    const omitted = visibleText(render(BASE));
    expect(omitted).toContain("10 Enrolled");
    expect(omitted).not.toContain("10+");
    expect(omitted).not.toContain("Showing at least these counts");
  });

  it("also marks the cancelled figure when it is both non-zero and truncated", () => {
    const text = visibleText(render({ ...BASE, cancelled: 2, truncated: true }));
    expect(text).toContain("2+ Cancelled");
  });
});
