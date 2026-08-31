import { describe, it, expect } from "vitest";

import {
  extensionFromMime,
  extensionFromUrl,
  mediaFilename,
  needsCacheBypass,
  sanitizeFilename,
} from "./download";

/**
 * The download path's fiddly parts are pure on purpose: this repo has no
 * jsdom, so anything living inside a component (the anchor click, the
 * blob fetch) is unreachable from a test. Filename derivation is where
 * the real decisions are, so it lives here where it can be pinned down.
 */

// Fixed instant so the generated-name assertions are not clock-dependent.
// 2026-08-01T18:34:00Z — asserted through the same local-time formatter
// the implementation uses, so this holds in any TZ.
const AT = new Date(2026, 7, 1, 18, 34).getTime();

describe("extensionFromMime", () => {
  it("maps the image types WhatsApp actually delivers", () => {
    expect(extensionFromMime("image/jpeg")).toBe("jpg");
    expect(extensionFromMime("image/png")).toBe("png");
    expect(extensionFromMime("image/webp")).toBe("webp");
  });

  it("ignores charset and other parameters", () => {
    expect(extensionFromMime("image/jpeg; charset=binary")).toBe("jpg");
  });

  it("is case-insensitive and tolerates surrounding space", () => {
    expect(extensionFromMime("  IMAGE/PNG ")).toBe("png");
  });

  it("returns null for unknown or absent types", () => {
    expect(extensionFromMime("application/x-nonsense")).toBeNull();
    expect(extensionFromMime("")).toBeNull();
    expect(extensionFromMime(undefined)).toBeNull();
  });

  it("does not treat a bare blob type as an extension", () => {
    // `blob.type` is "" when the server sent no Content-Type. Falling
    // through to the URL is correct; inventing "jpg" here is not.
    expect(extensionFromMime(null)).toBeNull();
  });
});

describe("extensionFromUrl", () => {
  it("reads the extension off an absolute media URL", () => {
    expect(extensionFromUrl("https://objs.amaniworld.com/wa/abc123.jpg")).toBe(
      "jpg",
    );
  });

  it("ignores query strings and fragments", () => {
    expect(
      extensionFromUrl("https://objs.amaniworld.com/wa/a.png?v=2#top"),
    ).toBe("png");
  });

  it("handles a relative proxy path", () => {
    expect(extensionFromUrl("/api/whatsapp/media/1234567890")).toBeNull();
  });

  it("returns null when the last segment has no extension", () => {
    expect(extensionFromUrl("https://objs.amaniworld.com/wa/abc123")).toBeNull();
  });

  it("rejects a dotted directory that is not a real extension", () => {
    expect(extensionFromUrl("https://objs.amaniworld.com/v1.2/file")).toBeNull();
  });

  it("rejects an implausibly long trailing segment", () => {
    expect(
      extensionFromUrl("https://objs.amaniworld.com/a.verylongsuffix"),
    ).toBeNull();
  });

  it("survives a malformed URL rather than throwing", () => {
    expect(extensionFromUrl("::::")).toBeNull();
    expect(extensionFromUrl("")).toBeNull();
  });
});

describe("sanitizeFilename", () => {
  it("strips path separators so a name cannot escape the download dir", () => {
    expect(sanitizeFilename("../../etc/passwd")).toBe("etc-passwd");
  });

  it("strips characters Windows rejects in a filename", () => {
    expect(sanitizeFilename('in*valid?name"here')).toBe("in-valid-name-here");
  });

  it("collapses runs of replaced characters", () => {
    expect(sanitizeFilename("a///b")).toBe("a-b");
  });

  it("trims leading and trailing dots and dashes", () => {
    expect(sanitizeFilename("...quote.pdf...")).toBe("quote.pdf");
  });

  it("falls back when nothing usable survives", () => {
    expect(sanitizeFilename("///")).toBe("");
    expect(sanitizeFilename("   ")).toBe("");
  });
});

describe("needsCacheBypass", () => {
  const PAGE = "https://wa.amaniworld.com/inbox?c=abc";

  it("bypasses the cache for media on the R2 host", () => {
    // Observed, not theoretical: the bubble displays this URL through an
    // <img>, which (having no `crossorigin` attribute) is cached as an
    // OPAQUE response. A later cors-mode fetch reuses that entry, finds no
    // usable Access-Control-Allow-Origin on it, and rejects — despite the
    // server returning correct CORS headers. The image is always on screen
    // before anyone clicks download, so without the bypass this fails
    // 100% of the time, not occasionally.
    expect(
      needsCacheBypass("https://objs.amaniworld.com/wa/a.jpg", PAGE),
    ).toBe(true);
  });

  it("does not bypass for the same-origin media proxy", () => {
    // Forcing a reload here would re-run the authenticated Meta
    // round-trip behind the proxy route, and there is no CORS problem to
    // solve on our own origin.
    expect(needsCacheBypass("/api/whatsapp/media/12345", PAGE)).toBe(false);
  });

  it("does not bypass for a same-origin absolute URL", () => {
    expect(
      needsCacheBypass("https://wa.amaniworld.com/api/whatsapp/media/1", PAGE),
    ).toBe(false);
  });

  it("treats a different port or scheme as cross-origin", () => {
    expect(needsCacheBypass("http://localhost:3001/x.jpg", "http://localhost:3000/inbox"))
      .toBe(true);
  });

  it("survives a malformed URL rather than throwing", () => {
    expect(needsCacheBypass("::::", PAGE)).toBe(false);
  });
});

describe("mediaFilename", () => {
  it("names an image from the message timestamp and the blob's type", () => {
    expect(
      mediaFilename({
        kind: "image",
        createdAt: AT,
        url: "https://objs.amaniworld.com/wa/abc",
        mime: "image/png",
      }),
    ).toBe("amani-image-2026-08-01-1834.png");
  });

  it("prefers the blob's MIME type over the URL's extension", () => {
    // The proxy route reports the true Content-Type; an R2 key's suffix
    // is whatever the uploader happened to write.
    expect(
      mediaFilename({
        kind: "image",
        createdAt: AT,
        url: "https://objs.amaniworld.com/wa/abc.bin",
        mime: "image/webp",
      }),
    ).toBe("amani-image-2026-08-01-1834.webp");
  });

  it("falls back to the URL extension when the MIME type is unusable", () => {
    expect(
      mediaFilename({
        kind: "image",
        createdAt: AT,
        url: "https://objs.amaniworld.com/wa/abc.png",
        mime: "",
      }),
    ).toBe("amani-image-2026-08-01-1834.png");
  });

  it("falls back to a per-kind default when neither source knows", () => {
    expect(
      mediaFilename({ kind: "image", createdAt: AT, url: "/api/whatsapp/media/9" }),
    ).toBe("amani-image-2026-08-01-1834.jpg");
    expect(
      mediaFilename({ kind: "video", createdAt: AT, url: "/api/whatsapp/media/9" }),
    ).toBe("amani-video-2026-08-01-1834.mp4");
  });

  it("keeps a document's own filename when it already has an extension", () => {
    expect(
      mediaFilename({
        kind: "document",
        createdAt: AT,
        url: "https://objs.amaniworld.com/wa/xyz",
        mime: "application/pdf",
        documentName: "Amani Dubai Itinerary.pdf",
      }),
    ).toBe("Amani Dubai Itinerary.pdf");
  });

  it("appends an extension to a document name that lacks one", () => {
    expect(
      mediaFilename({
        kind: "document",
        createdAt: AT,
        url: "https://objs.amaniworld.com/wa/xyz",
        mime: "application/pdf",
        documentName: "Itinerary",
      }),
    ).toBe("Itinerary.pdf");
  });

  it("sanitizes a hostile document name", () => {
    expect(
      mediaFilename({
        kind: "document",
        createdAt: AT,
        url: "https://objs.amaniworld.com/wa/xyz",
        mime: "application/pdf",
        documentName: "../../../etc/passwd.pdf",
      }),
    ).toBe("etc-passwd.pdf");
  });

  it("generates a name when the document name sanitizes away to nothing", () => {
    expect(
      mediaFilename({
        kind: "document",
        createdAt: AT,
        url: "https://objs.amaniworld.com/wa/xyz",
        mime: "application/pdf",
        documentName: "///",
      }),
    ).toBe("amani-document-2026-08-01-1834.pdf");
  });

  it("accepts an ISO timestamp as well as an epoch number", () => {
    const iso = new Date(AT).toISOString();
    expect(
      mediaFilename({ kind: "image", createdAt: iso, url: "", mime: "image/jpeg" }),
    ).toBe("amani-image-2026-08-01-1834.jpg");
  });

  it("never returns an extension-less name for generated files", () => {
    const name = mediaFilename({
      kind: "document",
      createdAt: AT,
      url: "https://objs.amaniworld.com/wa/xyz",
    });
    expect(name).toMatch(/^amani-document-2026-08-01-1834\.[a-z0-9]+$/);
  });
});
