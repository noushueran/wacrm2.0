import { describe, it, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { MessageContentBody } from "./message-bubble";
import type { Message } from "@/types";

/**
 * Static-render tests, matching this repo's other component tests — there
 * is no jsdom and no Testing Library here, so the assertions are on the
 * markup that reaches the browser.
 *
 * What that CAN pin down: that the affordances exist, are reachable by
 * keyboard and assistive tech, and carry the right classes. What it
 * cannot: the lightbox's zoom/pan and the actual file save, both of which
 * need a DOM and are verified in a browser instead.
 *
 * `MessageContentBody` takes `t` as a plain prop rather than reading
 * next-intl from context, so it renders with no provider. The stub echoes
 * the key back, which is why assertions below look for e.g. "viewLarger".
 */

const R2_IMAGE = "https://objs.amaniworld.com/wa/banner.jpg";

function messageFixture(over: Partial<Message> = {}): Message {
  return {
    id: "m1",
    conversation_id: "c1",
    sender_type: "customer",
    content_type: "image",
    status: "delivered",
    created_at: "2026-08-01T10:00:00.000Z",
    ...over,
  } satisfies Message;
}

function renderBody(over: Partial<Message> = {}) {
  const stubT = ((key: string) => key) as unknown as React.ComponentProps<
    typeof MessageContentBody
  >["t"];
  return renderToStaticMarkup(
    React.createElement(MessageContentBody, {
      message: messageFixture(over),
      t: stubT,
      isAgent: false,
    }),
  );
}

describe("image bubble", () => {
  it("shows the whole image rather than a cropped slice", () => {
    // The bug this replaces: `object-cover` cut the top and bottom off a
    // tall banner, so the parts the agent needed to check were simply not
    // on screen — before any question of opening it larger.
    const html = renderBody({ media_url: R2_IMAGE });
    expect(html).toContain("object-contain");
    expect(html).not.toContain("object-cover");
  });

  it("makes the thumbnail an activatable control, not an inert image", () => {
    const html = renderBody({ media_url: R2_IMAGE });
    // A <button> is focusable and Enter/Space-activatable for free; a
    // div with onClick is neither.
    expect(html).toContain("<button");
    expect(html).toContain('type="button"');
  });

  it("names that control for assistive tech", () => {
    expect(renderBody({ media_url: R2_IMAGE })).toContain(
      'aria-label="viewLarger"',
    );
  });

  it("renders a directly-displayable URL on the first pass", () => {
    // R2 URLs need no fetch, so they must resolve during render rather
    // than through an effect — otherwise every image in the thread shows
    // a spinner for a frame, and none of it survives a static render.
    expect(renderBody({ media_url: R2_IMAGE })).toContain(R2_IMAGE);
  });

  it("uses the caption as alt text when the sender wrote one", () => {
    const html = renderBody({
      media_url: R2_IMAGE,
      content_text: "Eid offer banner",
    });
    expect(html).toContain('alt="Eid offer banner"');
  });

  it("still reports an image with no URL as unavailable", () => {
    const html = renderBody({ media_url: undefined });
    expect(html).toContain("unavailable");
    expect(html).not.toContain("<button");
  });
});

describe("video bubble", () => {
  it("keeps the inline player and adds a separate enlarge control", () => {
    // The video's own click is play/pause, so enlarging cannot reuse it.
    const html = renderBody({
      content_type: "video",
      media_url: "https://objs.amaniworld.com/wa/clip.mp4",
    });
    expect(html).toContain("<video");
    expect(html).toContain("controls");
    expect(html).toContain('aria-label="viewLarger"');
  });
});

describe("document bubble", () => {
  const doc = {
    content_type: "document" as const,
    media_url: "https://objs.amaniworld.com/wa/itinerary.pdf",
    content_text: "Dubai Itinerary.pdf",
  };

  it("keeps the existing open-in-a-new-tab link", () => {
    const html = renderBody(doc);
    expect(html).toContain(`href="${doc.media_url}"`);
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it("adds a download control alongside it", () => {
    expect(renderBody(doc)).toContain('aria-label="download"');
  });

  it("shows the document's own filename", () => {
    expect(renderBody(doc)).toContain("Dubai Itinerary.pdf");
  });

  it("still reports a document with no URL as unavailable", () => {
    const html = renderBody({ ...doc, media_url: undefined });
    expect(html).toContain("unavailable");
    expect(html).not.toContain('aria-label="download"');
  });
});
