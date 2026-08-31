import { describe, it, expect } from "vitest";

import {
  decidePasteAttachment,
  MIME_TO_KIND,
  PICKER_ACCEPT,
  type PasteableKind,
} from "./pasteAttachment";

/**
 * Pure-function tests for the clipboard → attachment decision. There is no
 * jsdom in this repo's vitest setup (see
 * `src/components/inbox/conversation-list.test.tsx`), so a real paste event
 * can't be dispatched — which is exactly why the decision lives in its own
 * module rather than inline in the composer.
 *
 * `File` is a Node 22 global, so these use real File objects.
 */

function file(type: string, name = "clipboard-item"): File {
  return new File([new Uint8Array([1, 2, 3])], name, { type });
}

// What a browser puts in `clipboardData.types` for a pure image copy: the
// image, plus an HTML rendition — but no plain text.
const IMAGE_ONLY_TYPES = ["Files", "text/html"];

describe("decidePasteAttachment", () => {
  it("ignores a paste with no files so text pastes normally", () => {
    expect(decidePasteAttachment([], ["text/plain"])).toEqual({
      action: "ignore",
    });
  });

  it("attaches a pasted PNG screenshot as an image", () => {
    const png = file("image/png", "image.png");
    expect(decidePasteAttachment([png], IMAGE_ONLY_TYPES)).toEqual({
      action: "attach",
      kind: "image",
      file: png,
      ignoredFileCount: 0,
    });
  });

  it("attaches a pasted MP4 as a video", () => {
    const mp4 = file("video/mp4", "clip.mp4");
    const decision = decidePasteAttachment([mp4], ["Files"]);
    expect(decision).toMatchObject({ action: "attach", kind: "video" });
  });

  it("attaches a pasted PDF as a document", () => {
    const pdf = file("application/pdf", "invoice.pdf");
    const decision = decidePasteAttachment([pdf], ["Files"]);
    expect(decision).toMatchObject({ action: "attach", kind: "document" });
  });

  // The rule that stops the most damaging failure mode: Excel, Numbers and
  // Google Sheets put BOTH the copied text and a PNG *rendition* of the
  // cells on the clipboard. Attaching there would silently replace the
  // agent's pasted text with a picture of it.
  it("ignores an image that arrives alongside plain text (spreadsheet copy)", () => {
    const rendition = file("image/png", "image.png");
    const decision = decidePasteAttachment(
      [rendition],
      ["text/plain", "text/html", "Files"],
    );
    expect(decision).toEqual({ action: "ignore" });
  });

  // `uploadAccountMedia` does no MIME validation, so anything not caught
  // here uploads cleanly and is then rejected by Meta with an opaque 400.
  it.each(["image/tiff", "image/heic", "image/gif"])(
    "reports %s as unsupported rather than uploading it",
    (mimeType) => {
      const decision = decidePasteAttachment([file(mimeType)], ["Files"]);
      expect(decision).toEqual({ action: "unsupported", mimeType });
    },
  );

  it("reports a typeless file as unsupported without an empty message", () => {
    expect(decidePasteAttachment([file("")], ["Files"])).toEqual({
      action: "unsupported",
      mimeType: "unknown",
    });
  });

  // `text/plain` is deliberately in PICKER_ACCEPT.document (a .txt file is a
  // sendable document) AND is the clipboard marker rule 2 keys off. The two
  // never collide: rule 2 reads the CLIPBOARD's types, this reads the FILE's
  // MIME. Copying text yields no files at all; copying a .txt file yields a
  // file whose clipboard types are ["Files"].
  it("attaches a copied .txt file as a document", () => {
    const txt = file("text/plain", "notes.txt");
    const decision = decidePasteAttachment([txt], ["Files"]);
    expect(decision).toMatchObject({ action: "attach", kind: "document" });
  });

  it("attaches the first of several files and reports the rest", () => {
    const first = file("image/png", "a.png");
    const decision = decidePasteAttachment(
      [first, file("image/png", "b.png"), file("image/png", "c.png")],
      ["Files"],
    );
    expect(decision).toEqual({
      action: "attach",
      kind: "image",
      file: first,
      ignoredFileCount: 2,
    });
  });
});

describe("MIME_TO_KIND", () => {
  // Guards the derivation: every MIME the file pickers accept must also be
  // pasteable, or the two paths would silently disagree.
  it("indexes every MIME type listed in PICKER_ACCEPT", () => {
    for (const [kind, accept] of Object.entries(PICKER_ACCEPT)) {
      for (const mime of accept.split(",")) {
        expect(MIME_TO_KIND[mime]).toBe(kind as PasteableKind);
      }
    }
  });

  it("does not invent types the pickers reject", () => {
    const accepted = Object.values(PICKER_ACCEPT).flatMap((a) => a.split(","));
    expect(Object.keys(MIME_TO_KIND).sort()).toEqual(accepted.sort());
  });
});
