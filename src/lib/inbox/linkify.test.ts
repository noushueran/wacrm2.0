import { describe, it, expect } from "vitest";
import { linkifyMessage } from "./linkify";

/**
 * The round-trip property is the backbone of these tests: whatever the
 * splitter does, concatenating the segments must reproduce the input
 * exactly. That is what guarantees a linkify bug can never DROP text
 * from a customer's message — the worst it can do is fail to link
 * something, which is visible and harmless.
 */
function roundTrip(input: string): string {
  return linkifyMessage(input)
    .map((s) => s.text)
    .join("");
}

function links(input: string) {
  return linkifyMessage(input)
    .filter((s) => s.type === "link")
    .map((s) => (s.type === "link" ? { text: s.text, href: s.href } : null));
}

describe("linkifyMessage", () => {
  it("links a bare https URL and keeps the surrounding text", () => {
    expect(linkifyMessage("See https://amaniworld.com/visa now")).toEqual([
      { type: "text", text: "See " },
      {
        type: "link",
        text: "https://amaniworld.com/visa",
        href: "https://amaniworld.com/visa",
      },
      { type: "text", text: " now" },
    ]);
  });

  it("upgrades a www. link to https rather than http", () => {
    expect(links("www.amaniworld.com")).toEqual([
      { text: "www.amaniworld.com", href: "https://www.amaniworld.com" },
    ]);
  });

  it("links every URL, not just the first", () => {
    expect(links("https://a.com and https://b.com")).toEqual([
      { text: "https://a.com", href: "https://a.com" },
      { text: "https://b.com", href: "https://b.com" },
    ]);
  });

  it("leaves a sentence-ending period out of the link", () => {
    expect(links("Book at https://amaniworld.com/visa.")).toEqual([
      {
        text: "https://amaniworld.com/visa",
        href: "https://amaniworld.com/visa",
      },
    ]);
    expect(roundTrip("Book at https://amaniworld.com/visa.")).toBe(
      "Book at https://amaniworld.com/visa.",
    );
  });

  it("drops an unbalanced closing paren but keeps a balanced one", () => {
    expect(links("(see https://a.com/x)")).toEqual([
      { text: "https://a.com/x", href: "https://a.com/x" },
    ]);
    expect(links("https://a.com/foo_(bar)")).toEqual([
      { text: "https://a.com/foo_(bar)", href: "https://a.com/foo_(bar)" },
    ]);
  });

  it("preserves query strings and fragments", () => {
    const url = "https://amaniworld.com/p?utm_source=wa&id=7#top";
    expect(links(`Deal: ${url}`)).toEqual([{ text: url, href: url }]);
  });

  // The security boundary. Inbound message text is written by whoever is
  // on the other end of the thread; these must never become live links.
  it("does not linkify javascript: or data: URLs", () => {
    expect(links("javascript:alert(1)")).toEqual([]);
    expect(links("data:text/html;base64,PHNjcmlwdD4=")).toEqual([]);
  });

  it("never yields an href outside http(s), even for a hostile match", () => {
    const hostile = "https://evil.com\"><script>alert(1)</script>";
    for (const segment of linkifyMessage(hostile)) {
      if (segment.type === "link") {
        expect(segment.href).toMatch(/^https?:\/\//);
      }
    }
    expect(roundTrip(hostile)).toBe(hostile);
  });

  it("round-trips text with no links at all", () => {
    const plain = "Hello, your visa is approved. Thanks!";
    expect(linkifyMessage(plain)).toEqual([{ type: "text", text: plain }]);
  });

  it("preserves newlines around a link", () => {
    const input = "Packages:\nhttps://amaniworld.com/p\n\nCall us";
    expect(roundTrip(input)).toBe(input);
    expect(links(input)).toEqual([
      { text: "https://amaniworld.com/p", href: "https://amaniworld.com/p" },
    ]);
  });

  it("returns no segments for empty text", () => {
    expect(linkifyMessage("")).toEqual([]);
  });

  it("does not share regex state between calls", () => {
    const input = "https://a.com";
    expect(links(input)).toEqual(links(input));
  });
});
