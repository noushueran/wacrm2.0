import { describe, it, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { VoiceTranscript } from "./voice-transcript";
import { MessageContentBody } from "./message-bubble";
import type { Message } from "@/types";

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

  it("can break an unbroken run rather than overflowing the bubble", () => {
    // `line-clamp` carries no word-breaking of its own, so without
    // `break-words` a single long token — a URL, a spelled-out email, a
    // PNR — runs off the side of the bubble instead of wrapping. That
    // is issue #165's failure class, and it bites hardest in the
    // UNCLAMPED state, i.e. every transcript under the threshold.
    // Asserting the class is the only handle available here: real
    // overflow needs layout, and this repo has no jsdom.
    expect(render({ text: "https://holidayys.co/packages/dubai-family-7n-6d-winter-2026" }))
      .toContain("break-words");
  });

  it("reports its collapsed state to assistive tech", () => {
    expect(render({ text: LONG })).toContain('aria-expanded="false"');
  });
});

/**
 * `messages.aiTranscription` (`ai_transcription` on the client) holds
 * TWO different things depending on `content_type`: Whisper's voice
 * transcript for `"audio"`, and gpt-4o-mini's image description for
 * `"image"` (see the comment above `ai_transcription` in `@/types` and
 * the one above the `<VoiceTranscript>` call in `message-bubble.tsx`).
 * Only the audio one may ever reach the DOM. Today that guarantee is
 * enforced solely by which `switch` case in `MessageContentBody` the
 * `<VoiceTranscript>` JSX happens to sit inside — nothing pins it down,
 * so a future edit that "helpfully" hoists the block out of the case
 * (to dedupe it, say) would leak an image's description into the
 * bubble unnoticed. These two tests pin it.
 *
 * `MessageContentBody` (`message-bubble.tsx`) takes `t` as a plain prop
 * rather than reading next-intl from context, so — like
 * `VoiceTranscript` above — it renders with no provider needed. None of
 * these assertions depend on translated copy, only on whether the
 * transcript text itself made it into the markup, so the stub below
 * just echoes the key back.
 */
const TRANSCRIPT = "I would like to book a family holiday to Dubai in December.";

function messageFixture(over: Partial<Message> = {}): Message {
  return {
    id: "m1",
    conversation_id: "c1",
    sender_type: "customer",
    content_type: "audio",
    status: "delivered",
    created_at: "2026-07-20T00:00:00.000Z",
    ...over,
  } satisfies Message;
}

function renderBody(props: Partial<React.ComponentProps<typeof MessageContentBody>> = {}) {
  const stubT = ((key: string) => key) as unknown as React.ComponentProps<
    typeof MessageContentBody
  >["t"];
  return renderToStaticMarkup(
    React.createElement(MessageContentBody, {
      message: messageFixture(),
      t: stubT,
      isAgent: false,
      ...props,
    }),
  );
}

describe("MessageContentBody keeps the transcript audio-only", () => {
  it("never renders an image's transcription, even though it shares the same field", () => {
    const html = renderBody({
      message: messageFixture({ content_type: "image", ai_transcription: TRANSCRIPT }),
    });
    expect(html).not.toContain(TRANSCRIPT);
  });

  it("renders an audio message's transcription", () => {
    const html = renderBody({
      message: messageFixture({ content_type: "audio", ai_transcription: TRANSCRIPT }),
    });
    expect(html).toContain(TRANSCRIPT);
  });
});
