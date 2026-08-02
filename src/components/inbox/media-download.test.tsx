import { describe, it, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { MessageContentBody } from "./message-bubble";
import type { Message } from "@/types";

/**
 * Static-render tests, matching this repo's other component tests
 * (`voice-transcript.test.tsx`) — there is no jsdom and no Testing Library
 * here, so `t` is passed as a plain prop and stubbed to echo its key.
 *
 * What these pin down: every media bubble offers a way to SAVE the file,
 * and that route goes through `/api/media/download` for cross-origin media.
 * A `<a download>` pointed straight at the R2 host is silently ignored by
 * the browser — it navigates instead of saving — which is the bug being
 * fixed, and it is invisible in a code diff. See
 * `docs/superpowers/specs/2026-08-02-inbox-media-view-and-download-design.md`.
 *
 * The IMAGE bubble is deliberately absent below: `MediaImage` starts in its
 * loading state and only resolves a source from an effect, which a static
 * render never runs, so its controls are not reachable here. Those are
 * verified in the browser.
 */

const R2 = "https://objs.example.com";

function messageFixture(over: Partial<Message> = {}): Message {
  return {
    id: "m1",
    conversation_id: "c1",
    sender_type: "customer",
    content_type: "image",
    status: "delivered",
    created_at: "2026-08-02T00:00:00.000Z",
    ...over,
  } satisfies Message;
}

function renderBody(message: Message) {
  const stubT = ((key: string) => key) as unknown as React.ComponentProps<
    typeof MessageContentBody
  >["t"];
  return renderToStaticMarkup(
    React.createElement(MessageContentBody, {
      message,
      t: stubT,
      isAgent: false,
    }),
  );
}

describe("document bubble", () => {
  const doc = messageFixture({
    content_type: "document",
    content_text: "Itinerary.pdf",
    media_url: `${R2}/acc/doc/deadbeef.pdf`,
  });

  it("routes the download through the same-origin endpoint", () => {
    const html = renderBody(doc);
    expect(html).toContain("/api/media/download");
    expect(html).toContain(encodeURIComponent(`${R2}/acc/doc/deadbeef.pdf`));
  });

  it("asks the browser to save the file under its own name", () => {
    expect(renderBody(doc)).toContain('download="Itinerary.pdf"');
  });

  it("no longer opens the file in a tab instead of saving it", () => {
    // The previous implementation was `target="_blank"` straight at the
    // media url, which is exactly the behaviour that made the file
    // impossible to actually obtain.
    expect(renderBody(doc)).not.toContain('target="_blank"');
  });

  it("still degrades to an unavailable notice with no media url", () => {
    const html = renderBody(
      messageFixture({ content_type: "document", content_text: "Gone.pdf" }),
    );
    expect(html).not.toContain("/api/media/download");
    expect(html).toContain("unavailable");
  });
});

describe("audio bubble", () => {
  it("offers a download alongside the player", () => {
    const html = renderBody(
      messageFixture({
        content_type: "audio",
        media_url: `${R2}/acc/in/voice.ogg`,
      }),
    );

    expect(html).toContain("<audio");
    expect(html).toContain("/api/media/download");
    expect(html).toContain('download="whatsapp-audio-2026-08-02.ogg"');
  });
});

describe("video bubble", () => {
  const video = messageFixture({
    content_type: "video",
    media_url: `${R2}/acc/in/clip.mp4`,
  });

  it("offers a download", () => {
    const html = renderBody(video);
    expect(html).toContain("/api/media/download");
    expect(html).toContain('download="whatsapp-video-2026-08-02.mp4"');
  });

  it("offers a control to enlarge it", () => {
    // A 240px-wide player is the same unreadable-media problem as the
    // cropped image; the corner button is the way out of it.
    expect(renderBody(video)).toContain("viewVideo");
  });

  it("keeps the inline player's native controls", () => {
    expect(renderBody(video)).toContain("controls");
  });
});
