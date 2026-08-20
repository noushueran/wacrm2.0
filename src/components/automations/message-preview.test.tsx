import { describe, expect, it } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import messages from "../../../messages/en.json";

import { MessagePreview, TemplatePreview } from "./message-preview";
import type { SendMessageStepConfig } from "@/types";

/**
 * Static-render tests, matching this repo's other component tests
 * (`run-stats-bar.test.tsx`, `lead-analysis-list.test.tsx`) — there is
 * no jsdom and no Testing Library here, so these assert on markup.
 *
 * These cover the cases the browser walk in the task report could NOT —
 * image/audio/document all need a `media.key`/`url` that only exists
 * after a real upload, and the dev server here points at PRODUCTION
 * Convex (reads only, per this task's constraints). Rendering with a
 * hand-built config exercises the exact same component code without
 * writing a file to production storage. The audio+text split
 * (`planPreviewBubbles`) already has dedicated unit coverage in
 * `preview-plan.test.ts`; what's new here is confirming the REACT
 * COMPONENT actually renders two separate bubble containers for it, not
 * just that the planner returns two array entries.
 */
function renderPreview(config: SendMessageStepConfig) {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={messages}>
      {React.createElement(MessagePreview, { config })}
    </NextIntlClientProvider>,
  );
}

function renderTemplate(
  body: string,
  variables?: Record<string, string>,
  extra?: { loading?: boolean; notFoundLabel?: string },
) {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={messages}>
      {React.createElement(TemplatePreview, { body, variables, ...extra })}
    </NextIntlClientProvider>,
  );
}

function visibleText(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

/** Counts top-level chat bubbles by the card class every bubble variant
 *  in message-preview.tsx shares (BUBBLE_CLASS) — the one visible signal
 *  a static HTML string can give for "how many bubbles did this render",
 *  short of a live DOM. */
function bubbleCount(html: string): number {
  return (html.match(/rounded-lg bg-card text-foreground shadow-sm ring-1 ring-border/g) ?? [])
    .length;
}

describe("MessagePreview", () => {
  it("renders the muted empty state for a config with nothing to send", () => {
    const html = renderPreview({});
    expect(visibleText(html)).toContain("Nothing to send yet.");
    expect(bubbleCount(html)).toBe(0);
  });

  it("renders one text bubble, preserving line breaks and pilling the one token the engine resolves ({{ message.text }})", () => {
    const html = renderPreview({ text: "Hi,\nsee you tomorrow. You said: {{ message.text }}" });
    expect(bubbleCount(html)).toBe(1);
    expect(visibleText(html)).toContain("Hi, see you tomorrow. You said: {{message.text}}");
    // whitespace-pre-wrap is what actually preserves the line break —
    // confirm the class made it onto the bubble's text, not just that
    // the raw "\n" survived render() (which strips to nothing visually).
    expect(html).toContain("whitespace-pre-wrap");
    // A resolving token stays the neutral muted pill, not the vanishing
    // (destructive/struck-through) treatment below.
    expect(html).not.toMatch(/line-through/);
  });

  // ============================================================
  // I-1 fix: a token `interpolate()` (convex/automationsEngine.ts) does
  // NOT resolve to content in production must not render as the same
  // confident pill as {{ message.text }} — it's deleted at send time, not
  // left literal, so the preview has to show it will vanish.
  // ============================================================

  it("renders a token the engine deletes at send time (e.g. {{ contact.name }}) with destructive, struck-through styling instead of a confident pill", () => {
    const html = renderPreview({ text: "Hi {{ contact.name }}, your booking is confirmed." });
    expect(bubbleCount(html)).toBe(1);
    // The token's literal text is still present (readable on inspection)…
    expect(visibleText(html)).toContain("{{contact.name}}");
    // …but styled as vanishing, not as a normal resolves-at-send-time pill.
    expect(html).toMatch(/line-through/);
    expect(html).toMatch(/destructive/);
  });

  it("renders {{ vars.* }} tokens the same vanishing way — AutomationContext.vars is never populated in production", () => {
    const html = renderPreview({ text: "Source: {{ vars.source }}" });
    expect(html).toMatch(/line-through/);
    expect(html).toMatch(/destructive/);
    expect(visibleText(html)).toContain("{{vars.source}}");
  });

  it("a vanishing token carries an explanatory title, not just color/strikethrough", () => {
    const html = renderPreview({ text: "{{ contact.name }}" });
    expect(html).toMatch(/title="[^"]+"/);
  });

  it("renders one media bubble with the resolved image and its caption beneath", () => {
    const html = renderPreview({
      text: "Here is the villa",
      media: { type: "image", url: "https://example.com/villa.jpg" },
    });
    expect(bubbleCount(html)).toBe(1);
    expect(html).toContain('src="https://example.com/villa.jpg"');
    expect(visibleText(html)).toContain("Here is the villa");
  });

  it("renders the unavailable placeholder when an image has neither key nor url", () => {
    const html = renderPreview({ media: { type: "image" } });
    expect(bubbleCount(html)).toBe(1);
    expect(html).not.toContain("<img");
    expect(visibleText(html)).toContain("Image unavailable");
  });

  it("renders a document chip with its filename and caption", () => {
    const html = renderPreview({
      text: "Your itinerary",
      media: { type: "document", url: "https://example.com/trip.pdf", filename: "trip.pdf" },
    });
    expect(bubbleCount(html)).toBe(1);
    expect(visibleText(html)).toContain("trip.pdf");
    expect(visibleText(html)).toContain("Your itinerary");
  });

  it("falls back to a key-derived name when a document has no filename", () => {
    const html = renderPreview({ media: { type: "document", key: "acc123/automation/quote.pdf" } });
    expect(visibleText(html)).toContain("quote.pdf");
  });

  // ============================================================
  // The rule this whole component exists for: audio + text is TWO
  // bubbles, audio first, because WhatsApp can't caption audio and the
  // engine sends it as two separate messages (sendPlan.ts's
  // `media_then_text`, automationsEngine.ts's `runStep`). One bubble
  // here would misrepresent what the customer actually receives.
  // ============================================================

  it("renders TWO bubbles for audio+text — an audio player, then a separate text bubble beneath it", () => {
    const html = renderPreview({
      text: "This is the voice note explaining pricing",
      media: { type: "audio", url: "https://example.com/note.ogg" },
    });
    expect(bubbleCount(html)).toBe(2);
    expect(html).toContain("<audio");
    expect(html).toContain('src="https://example.com/note.ogg"');
    expect(visibleText(html)).toContain("This is the voice note explaining pricing");
    // Order: the audio bubble's markup must appear BEFORE the text
    // bubble's — matching send order (audio first, text follows).
    const audioIndex = html.indexOf("<audio");
    const textIndex = html.indexOf("This is the voice note");
    expect(audioIndex).toBeGreaterThan(-1);
    expect(textIndex).toBeGreaterThan(audioIndex);
  });

  it("renders a single audio bubble with no follow-up when there is no text", () => {
    const html = renderPreview({ media: { type: "audio", url: "https://example.com/note.ogg" } });
    expect(bubbleCount(html)).toBe(1);
    expect(html).toContain("<audio");
  });

  it("delegates the interactive case to InteractivePreview instead of drawing its own bubble", () => {
    const html = renderPreview({
      interactive: {
        kind: "buttons",
        body: "Pick one",
        buttons: [{ id: "a", title: "Option A" }],
      },
    });
    // InteractivePreview's own card happens to share the exact same class
    // string as BUBBLE_CLASS (deliberately, so the two "read as one
    // component") — so bubbleCount can't distinguish whose div it is, but
    // it CAN catch a double-wrap: if message-preview.tsx drew a second
    // bubble around the delegated InteractivePreview, this would read 2,
    // not 1.
    expect(bubbleCount(html)).toBe(1);
    expect(visibleText(html)).toContain("Pick one");
    expect(visibleText(html)).toContain("Option A");
  });

  it("media outranks interactive, matching planSend's precedence", () => {
    const html = renderPreview({
      media: { type: "image", url: "https://example.com/a.jpg" },
      interactive: { kind: "buttons", body: "Pick one", buttons: [{ id: "a", title: "A" }] },
    });
    expect(html).toContain('src="https://example.com/a.jpg"');
    expect(visibleText(html)).not.toContain("Pick one");
  });
});

describe("TemplatePreview", () => {
  it("shows the muted empty state when there is no body yet", () => {
    const html = renderTemplate("");
    expect(visibleText(html)).toContain("Nothing to send yet.");
  });

  it("substitutes a filled variable as literal text", () => {
    const html = renderTemplate("Hi {{1}}, your trip to {{2}} is booked.", {
      "1": "Noushad",
      "2": "Zanzibar",
    });
    const text = visibleText(html);
    expect(text).toContain("Hi Noushad, your trip to Zanzibar is booked.");
    expect(text).not.toContain("{{1}}");
    expect(text).not.toContain("{{2}}");
  });

  it("leaves an unfilled variable as a muted {{n}} pill instead of sending it blank", () => {
    const html = renderTemplate("Hi {{1}}, your code is {{2}}.", { "1": "Noushad" });
    const text = visibleText(html);
    expect(text).toContain("Hi Noushad, your code is {{2}} .");
    expect(html).toContain("font-mono");
  });

  // ============================================================
  // I-4 fix: the account's `templates` list resolves to `[]` while the
  // Convex query is in flight, identically to a genuinely not-found
  // template — automation-builder.tsx used to feed both into `body ?? ""`,
  // so both showed "Nothing to send yet." even though a not-found
  // template's step passes validation and the engine WILL attempt the
  // send. loading/notFoundLabel let the caller distinguish all three
  // states explicitly instead.
  // ============================================================

  it("shows a loading state instead of the empty state while the template list is still loading", () => {
    const html = renderTemplate("", undefined, { loading: true });
    const text = visibleText(html);
    expect(text).not.toContain("Nothing to send yet.");
    expect(text.length).toBeGreaterThan(0);
  });

  it("loading wins even when a real body is already known — never renders it as resolved mid-flight", () => {
    const html = renderTemplate("Hi {{1}}!", { "1": "Amani" }, { loading: true });
    expect(visibleText(html)).not.toContain("Hi Amani!");
  });

  it("shows the not-found label verbatim — the exact text the template <select> already uses — instead of the empty state", () => {
    const html = renderTemplate("", undefined, {
      notFoundLabel: "booking_confirmation (en_US) — not in approved list",
    });
    const text = visibleText(html);
    expect(text).toContain("booking_confirmation (en_US) — not in approved list");
    expect(text).not.toContain("Nothing to send yet.");
  });

  it("not-found wins over a stale body — a since-deleted template's old body must not render as sendable", () => {
    const html = renderTemplate("Hi {{1}}!", { "1": "Amani" }, {
      notFoundLabel: "gone (en_US) — not in approved list",
    });
    const text = visibleText(html);
    expect(text).toContain("gone (en_US) — not in approved list");
    expect(text).not.toContain("Hi Amani!");
  });
});
