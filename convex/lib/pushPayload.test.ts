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
    expect(p.title).toBe("Holidayys WA CRM");
    expect(p.body).toBe("New WhatsApp message");
    expect(p.url).toBe("/inbox?c=c1"); // routing still works
  });
});
