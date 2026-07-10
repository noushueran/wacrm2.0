import { describe, expect, it } from "vitest";
import { buildMetaTemplatePayload } from "./templateComponents";
import type { TemplateComponentsInput } from "./templateComponents";

// Direct port of `src/lib/whatsapp/template-components.test.ts`'s cases,
// adapted to this port's camelCase input shape — see that file for the
// original source-of-truth assertions this mirrors.

const base: TemplateComponentsInput = {
  name: "order_confirmation",
  category: "Utility",
  language: "en_US",
  bodyText: "Your order is on its way.",
};

describe("buildMetaTemplatePayload", () => {
  it("upcases category and produces minimal components (body only)", () => {
    const payload = buildMetaTemplatePayload(base);
    expect(payload).toEqual({
      name: "order_confirmation",
      category: "UTILITY",
      language: "en_US",
      components: [{ type: "BODY", text: "Your order is on its way." }],
    });
  });

  it("includes bodyText example as a 2D array (Meta spec)", () => {
    const payload = buildMetaTemplatePayload({
      ...base,
      bodyText: "Hi {{1}}, order {{2}}.",
      sampleValues: { body: ["John", "ORD-42"] },
    });
    const body = payload.components.find((c) => c.type === "BODY");
    expect(body?.example?.body_text).toEqual([["John", "ORD-42"]]);
  });

  it("emits TEXT header in canonical first position", () => {
    const payload = buildMetaTemplatePayload({
      ...base,
      headerType: "text",
      headerContent: "Hello {{1}}",
      sampleValues: { header: ["Sara"] },
    });
    expect(payload.components[0]).toEqual({
      type: "HEADER",
      format: "TEXT",
      text: "Hello {{1}}",
      example: { header_text: ["Sara"] },
    });
  });

  it("uses header_url for media headers when no handle is set", () => {
    const payload = buildMetaTemplatePayload({
      ...base,
      headerType: "image",
      headerMediaUrl: "https://example.com/img.jpg",
    });
    expect(payload.components[0]).toEqual({
      type: "HEADER",
      format: "IMAGE",
      example: { header_url: ["https://example.com/img.jpg"] },
    });
  });

  it("prefers headerHandle over headerMediaUrl", () => {
    const payload = buildMetaTemplatePayload({
      ...base,
      headerType: "video",
      headerHandle: "4::aW1...",
      headerMediaUrl: "https://example.com/v.mp4",
    });
    expect(payload.components[0]).toEqual({
      type: "HEADER",
      format: "VIDEO",
      example: { header_handle: ["4::aW1..."] },
    });
  });

  it("emits footer when present, skips when empty", () => {
    const withFooter = buildMetaTemplatePayload({
      ...base,
      footerText: "Reply STOP to opt out",
    });
    expect(
      withFooter.components.some(
        (c) => c.type === "FOOTER" && c.text === "Reply STOP to opt out",
      ),
    ).toBe(true);

    const withoutFooter = buildMetaTemplatePayload({ ...base, footerText: "" });
    expect(withoutFooter.components.some((c) => c.type === "FOOTER")).toBe(false);
  });

  it("emits the buttons component with correct per-type fields", () => {
    const payload = buildMetaTemplatePayload({
      ...base,
      buttons: [
        { type: "QUICK_REPLY", text: "Yes" },
        { type: "URL", text: "Track", url: "https://x/{{1}}", example: "abc" },
        { type: "PHONE_NUMBER", text: "Call", phone_number: "+15551234567" },
        { type: "COPY_CODE", text: "Copy", example: "SUMMER20" },
      ],
    });
    const buttons = payload.components.find((c) => c.type === "BUTTONS");
    expect(buttons?.buttons).toEqual([
      { type: "QUICK_REPLY", text: "Yes" },
      { type: "URL", text: "Track", url: "https://x/{{1}}", example: ["abc"] },
      { type: "PHONE_NUMBER", text: "Call", phone_number: "+15551234567" },
      { type: "COPY_CODE", text: "Copy", example: ["SUMMER20"] },
    ]);
  });

  it("orders components HEADER → BODY → FOOTER → BUTTONS", () => {
    const payload = buildMetaTemplatePayload({
      ...base,
      headerType: "text",
      headerContent: "Hi",
      footerText: "Footer",
      buttons: [{ type: "QUICK_REPLY", text: "Yes" }],
    });
    expect(payload.components.map((c) => c.type)).toEqual([
      "HEADER",
      "BODY",
      "FOOTER",
      "BUTTONS",
    ]);
  });
});
