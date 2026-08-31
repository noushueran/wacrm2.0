import { describe, it, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { MessageContentBody } from "./message-bubble";
import type { Message } from "@/types";

/**
 * Static-render tests, same harness and reasoning as
 * `voice-transcript.test.tsx`: no jsdom and no Testing Library in this
 * repo, and `MessageContentBody` takes `t` as a plain prop rather than
 * reading next-intl from context, so it renders with no provider.
 *
 * What these pin is that a URL in a message reaches the DOM as a real
 * `<a>`. Before this, every bubble rendered `content_text` as an inert
 * string — the failure the customer actually reported alongside the
 * missing WhatsApp-side preview — and the regression is silent, since
 * the text still LOOKS right in the thread; only clicking reveals it.
 */
function messageFixture(over: Partial<Message> = {}): Message {
  return {
    id: "m1",
    conversation_id: "c1",
    sender_type: "agent",
    content_type: "text",
    status: "delivered",
    created_at: "2026-08-08T00:00:00.000Z",
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
      isAgent: true,
    }),
  );
}

describe("MessageContentBody link rendering", () => {
  it("renders a URL in a text message as an anchor", () => {
    const html = renderBody({
      content_text: "Our packages: https://amaniworld.com/packages",
    });
    expect(html).toContain('href="https://amaniworld.com/packages"');
    expect(html).toContain("<a ");
  });

  it("opens links in a new tab without leaking the opener", () => {
    const html = renderBody({ content_text: "https://amaniworld.com/visa" });
    expect(html).toContain('target="_blank"');
    // noopener is the security-relevant half: target="_blank" otherwise
    // hands the opened page a handle back to the inbox tab.
    expect(html).toContain("noopener");
    expect(html).toContain("noreferrer");
  });

  it("links a URL in an image caption too", () => {
    const html = renderBody({
      content_type: "image",
      media_url: "https://cdn.example.com/a.jpg",
      content_text: "Details: https://amaniworld.com/dubai",
    });
    expect(html).toContain('href="https://amaniworld.com/dubai"');
  });

  it("links a URL inside a template body", () => {
    const html = renderBody({
      content_type: "template",
      content_text: "Book here: https://amaniworld.com/book",
    });
    expect(html).toContain('href="https://amaniworld.com/book"');
  });

  it("leaves link-free text with no anchor", () => {
    const html = renderBody({ content_text: "Your visa is approved." });
    expect(html).not.toContain("<a ");
    expect(html).toContain("Your visa is approved.");
  });

  // Inbound text is attacker-controlled; React's escaping is what makes
  // the pure-splitter design safe, so it gets an explicit test rather
  // than being left as an assumed property.
  it("escapes markup in an inbound message instead of executing it", () => {
    const html = renderBody({
      sender_type: "customer",
      content_text: "<img src=x onerror=alert(1)> https://ok.com",
    });
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img");
    expect(html).toContain('href="https://ok.com"');
  });

  it("never emits a javascript: href", () => {
    const html = renderBody({
      sender_type: "customer",
      content_text: "javascript:alert(document.cookie)",
    });
    // The literal text SHOULD still be shown — it is what the customer
    // sent, and hiding message content would be its own bug. The
    // property under test is narrower: it must not become a link.
    expect(html).toContain("javascript:alert(document.cookie)");
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("href=");
  });
});
