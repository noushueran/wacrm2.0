import { describe, it, expect } from "vitest";
import { buildInboundPayload } from "./pushPayload";

describe("buildInboundPayload", () => {
  it("shows name + text when preview visible", () => {
    const p = buildInboundPayload({
      contactName: "Ravi Kumar",
      contentType: "text",
      text: "I'd like to book Bali",
      conversationId: "c1",
      hidePreview: false,
    });
    expect(p.title).toBe("Ravi Kumar");
    expect(p.body).toBe("I'd like to book Bali");
    expect(p.url).toBe("/inbox?c=c1");
    expect(p.tag).toBe("c1");
  });
  it("labels non-text content", () => {
    expect(
      buildInboundPayload({ contactName: "A", contentType: "audio", conversationId: "c1", hidePreview: false }).body,
    ).toBe("🎤 Voice message");
  });
  it("truncates long text", () => {
    const long = "x".repeat(200);
    expect(
      buildInboundPayload({ contactName: "A", contentType: "text", text: long, conversationId: "c1", hidePreview: false }).body.length,
    ).toBeLessThanOrEqual(121);
  });
  it("hides everything when hidePreview", () => {
    const p = buildInboundPayload({
      contactName: "Ravi Kumar",
      contentType: "text",
      text: "secret",
      conversationId: "c1",
      hidePreview: true,
    });
    expect(p.title).toBe("Testco WA CRM");
    expect(p.body).toBe("New WhatsApp message");
    expect(p.url).toBe("/inbox?c=c1"); // routing still works
  });
});

describe("buildInboundPayload unread badge", () => {
  it("carries the count through for the service worker to badge with", () => {
    expect(
      buildInboundPayload({
        contactName: "A",
        contentType: "text",
        text: "hi",
        conversationId: "c1",
        hidePreview: false,
        unread: 7,
      }).unread,
    ).toBe(7);
  });

  it("still carries the count when the preview is hidden — a bare number leaks nothing", () => {
    const p = buildInboundPayload({
      contactName: "Ravi Kumar",
      contentType: "text",
      text: "secret",
      conversationId: "c1",
      hidePreview: true,
      unread: 3,
    });
    expect(p.body).toBe("New WhatsApp message");
    expect(p.unread).toBe(3);
  });

  it("omits the key entirely when no count is known, so sw.js leaves the badge alone", () => {
    const p = buildInboundPayload({
      contactName: "A",
      contentType: "text",
      conversationId: "c1",
      hidePreview: false,
    });
    expect("unread" in p).toBe(false);
  });

  it("passes zero through so a fully-read inbox clears the badge", () => {
    expect(
      buildInboundPayload({
        contactName: "A",
        contentType: "text",
        conversationId: "c1",
        hidePreview: false,
        unread: 0,
      }).unread,
    ).toBe(0);
  });
});
