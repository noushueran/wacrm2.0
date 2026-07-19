import { describe, it, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { VoiceTranscript } from "./voice-transcript";

/**
 * Static-render tests, matching this repo's only other component test
 * (`src/components/ui/dropdown-menu-group-label.test.tsx`) — there is
 * no jsdom and no Testing Library here.
 *
 * These are not a formality. `line-clamp` is CSS-only, so the FULL
 * transcript is always present in the DOM regardless of collapse
 * state; asserting on the markup therefore verifies the text was
 * genuinely delivered to the browser, which is the bug being fixed.
 * The expand/collapse interaction itself is not reachable without a
 * DOM and is verified in the browser instead.
 */
const LONG = "I would like to book a family holiday to Dubai in December. ".repeat(6);

function render(props: Partial<React.ComponentProps<typeof VoiceTranscript>> = {}) {
  return renderToStaticMarkup(
    React.createElement(VoiceTranscript, {
      text: "Hello, I want a Dubai package.",
      label: "AI transcript",
      labelTitle: "Transcribed automatically from the voice note",
      moreLabel: "Show more",
      lessLabel: "Show less",
      ...props,
    }),
  );
}

describe("VoiceTranscript", () => {
  it("renders the transcript text", () => {
    expect(render()).toContain("Hello, I want a Dubai package.");
  });

  it("marks the text as machine-generated", () => {
    const html = render();
    expect(html).toContain("AI transcript");
    expect(html).toContain("Transcribed automatically from the voice note");
  });

  it("delivers the WHOLE transcript even when collapsed", () => {
    // the tail of a long transcript, i.e. past the 3-line clamp
    expect(render({ text: LONG })).toContain("in December.");
  });

  it("offers an expand toggle only when the text can actually overflow", () => {
    expect(render({ text: LONG })).toContain("Show more");
    expect(render({ text: "Yes please." })).not.toContain("Show more");
  });
});
