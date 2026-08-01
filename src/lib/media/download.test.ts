import { describe, it, expect } from "vitest";

import { downloadHrefFor, filenameFor, isProxiedDownload } from "./download";
import type { Message } from "@/types";

/**
 * The rules these lock down are the whole reason the download feature
 * needs a server route at all — see
 * `docs/superpowers/specs/2026-08-02-inbox-media-view-and-download-design.md`.
 * Inbound media resolves to a CROSS-ORIGIN R2 url, where the `download`
 * attribute is silently ignored by the browser, so anything absolute has
 * to be routed through `/api/media/download`.
 */

function msg(over: Partial<Message> = {}): Message {
  return {
    id: "msg_1",
    conversation_id: "conv_1",
    sender_type: "customer",
    content_type: "image",
    status: "delivered",
    created_at: "2026-08-02T09:30:00.000Z",
    ...over,
  };
}

describe("isProxiedDownload", () => {
  it("passes a relative proxy url straight through", () => {
    // Same-origin: a plain `<a download>` already works here.
    expect(isProxiedDownload("/api/whatsapp/media/abc123")).toBe(false);
  });

  it("proxies an absolute R2 url", () => {
    expect(isProxiedDownload("https://objs.example.com/acc/in/deadbeef.jpg")).toBe(
      true,
    );
  });

  it("proxies any other absolute url, including legacy storage hosts", () => {
    expect(isProxiedDownload("https://xyz.supabase.co/storage/v1/o/a.png")).toBe(
      true,
    );
  });

  it("treats a protocol-relative url as cross-origin", () => {
    expect(isProxiedDownload("//objs.example.com/a.jpg")).toBe(true);
  });
});

describe("downloadHrefFor", () => {
  it("returns a same-origin url unchanged", () => {
    expect(downloadHrefFor("/api/whatsapp/media/abc123", "photo.jpg")).toBe(
      "/api/whatsapp/media/abc123",
    );
  });

  it("routes a cross-origin url through the download endpoint", () => {
    const href = downloadHrefFor(
      "https://objs.example.com/acc/in/deadbeef.jpg",
      "whatsapp-image-2026-08-02.jpg",
    );
    const url = new URL(href, "http://localhost");

    expect(url.pathname).toBe("/api/media/download");
    expect(url.searchParams.get("url")).toBe(
      "https://objs.example.com/acc/in/deadbeef.jpg",
    );
    expect(url.searchParams.get("name")).toBe("whatsapp-image-2026-08-02.jpg");
  });

  it("encodes a url whose key contains characters that would break the query", () => {
    const href = downloadHrefFor(
      "https://objs.example.com/acc/in/a b&c=d.jpg",
      "x.jpg",
    );
    const url = new URL(href, "http://localhost");

    expect(url.searchParams.get("url")).toBe(
      "https://objs.example.com/acc/in/a b&c=d.jpg",
    );
  });
});

describe("filenameFor", () => {
  it("uses a document's own filename, which the bubble already shows as its label", () => {
    expect(
      filenameFor(
        msg({ content_type: "document", content_text: "Invoice 4471.pdf" }),
      ),
    ).toBe("Invoice 4471.pdf");
  });

  it("falls back to a dated name for a document with no label", () => {
    expect(
      filenameFor(
        msg({
          content_type: "document",
          media_url: "https://objs.example.com/a/d/deadbeef.pdf",
        }),
      ),
    ).toBe("whatsapp-document-2026-08-02.pdf");
  });

  it("builds a readable dated name for an image rather than the R2 hex key", () => {
    expect(
      filenameFor(
        msg({ media_url: "https://objs.example.com/acc/in/0123456789ab.jpg" }),
      ),
    ).toBe("whatsapp-image-2026-08-02.jpg");
  });

  it("keeps the extension carried by the media url", () => {
    expect(
      filenameFor(
        msg({ media_url: "https://objs.example.com/acc/in/0123456789ab.png" }),
      ),
    ).toBe("whatsapp-image-2026-08-02.png");
  });

  it("ignores a query string when reading the extension", () => {
    expect(
      filenameFor(
        msg({ media_url: "https://objs.example.com/a/in/x.webp?v=2" }),
      ),
    ).toBe("whatsapp-image-2026-08-02.webp");
  });

  it("defaults the extension per media type when the key carries none", () => {
    // `buildMediaKey` omits the extension when neither the filename nor
    // the content type revealed one (see convex/lib/r2/keys.test.ts).
    expect(
      filenameFor(
        msg({
          content_type: "video",
          media_url: "https://objs.example.com/acc/in/0123456789ab",
        }),
      ),
    ).toBe("whatsapp-video-2026-08-02.mp4");

    expect(
      filenameFor(
        msg({
          content_type: "audio",
          media_url: "https://objs.example.com/acc/in/0123456789ab",
        }),
      ),
    ).toBe("whatsapp-audio-2026-08-02.ogg");
  });

  it("does not mistake a dotted path segment for the file's extension", () => {
    expect(
      filenameFor(msg({ media_url: "https://objs.example.com/v1.2/in/photo" })),
    ).toBe("whatsapp-image-2026-08-02.jpg");
  });

  it("strips a path a malicious document label might smuggle in", () => {
    // The label is customer-controlled: it arrives on the inbound
    // WhatsApp payload. It must never steer where the browser writes.
    expect(
      filenameFor(
        msg({ content_type: "document", content_text: "../../etc/passwd" }),
      ),
    ).toBe("passwd");
  });

  it("survives a message with no media url at all", () => {
    expect(filenameFor(msg({ media_url: undefined }))).toBe(
      "whatsapp-image-2026-08-02.jpg",
    );
  });
});
