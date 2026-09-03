import { describe, it, expect } from "vitest";
import { isEmptyShare, shareToDraft } from "./share";

describe("shareToDraft", () => {
  it("uses the selection the user actually made", () => {
    expect(shareToDraft({ text: "Flight lands 6pm" })).toBe("Flight lands 6pm");
  });

  it("appends a shared link to the text", () => {
    expect(
      shareToDraft({ text: "This one", url: "https://example.com/tour" }),
    ).toBe("This one\nhttps://example.com/tour");
  });

  it("does not repeat a URL Chrome already put inside the text", () => {
    // Some Android versions populate BOTH fields for one shared link.
    // Pasting the same URL twice into a customer's chat looks broken.
    const url = "https://example.com/tour";
    expect(shareToDraft({ text: `Look at ${url}`, url })).toBe(`Look at ${url}`);
  });

  it("falls back to the page title only when there is no text", () => {
    expect(shareToDraft({ title: "Dubai City Tour", url: "https://x.test" })).toBe(
      "Dubai City Tour\nhttps://x.test",
    );
    // With a real selection the title is noise, not context.
    expect(shareToDraft({ title: "Dubai City Tour", text: "book this" })).toBe(
      "book this",
    );
  });

  it("shares a bare phone number unchanged — the contact-card case", () => {
    expect(shareToDraft({ text: "+971 50 123 4567" })).toBe("+971 50 123 4567");
  });

  it("trims and tolerates every field being absent or blank", () => {
    expect(shareToDraft({})).toBe("");
    expect(shareToDraft({ text: "   ", url: null, title: undefined })).toBe("");
    expect(shareToDraft({ text: "  padded  " })).toBe("padded");
  });
});

describe("isEmptyShare", () => {
  it("detects a share with nothing usable in it", () => {
    expect(isEmptyShare({})).toBe(true);
    expect(isEmptyShare({ text: "  " })).toBe(true);
    expect(isEmptyShare({ url: "https://x.test" })).toBe(false);
  });
});
