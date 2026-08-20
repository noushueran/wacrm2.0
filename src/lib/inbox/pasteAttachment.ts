// Pure decision logic for turning a clipboard paste into a composer
// attachment. Dependency-free (no React/Convex/DOM), same convention as
// `./adWindow.ts` and `./view.ts` — which is what makes it testable, since
// this repo's vitest has no jsdom and so cannot dispatch a paste event.

/** Content kinds that can arrive via the clipboard — a subset of the
 *  composer's `ComposerMediaKind`. Audio is deliberately absent: it has no
 *  file picker either, and the in-browser recorder is its only source. */
export type PasteableKind = "image" | "video" | "document";

/**
 * MIME allowlist shared by the composer's hidden `<input accept=…>` pickers
 * and the paste path. Mirrors the old chat-media bucket's
 * `allowed_mime_types` (migration 023).
 *
 * This is the ONLY MIME gate on either path: `uploadAccountMedia` forwards
 * `file.type` to R2 without validating it, so a type missing from this list
 * would upload cleanly, stage as a draft, and then be rejected by Meta at
 * send time with an opaque 400.
 */
export const PICKER_ACCEPT: Record<PasteableKind, string> = {
  image: "image/png,image/jpeg,image/webp",
  video: "video/mp4,video/3gpp",
  document:
    "application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.presentationml.presentation,text/plain",
};

/** Reverse index of `PICKER_ACCEPT`: one MIME type → the kind it belongs to.
 *  Derived rather than hand-written so the picker and paste paths cannot
 *  drift apart when a type is added. */
export const MIME_TO_KIND: Readonly<Record<string, PasteableKind>> =
  Object.freeze(
    Object.fromEntries(
      (Object.entries(PICKER_ACCEPT) as [PasteableKind, string][]).flatMap(
        ([kind, accept]) =>
          accept.split(",").map((mime) => [mime, kind] as const),
      ),
    ),
  );

export type PasteDecision =
  /** Not media — let the browser paste normally. */
  | { action: "ignore" }
  /** Media, but a type Meta would reject. Attach nothing, tell the user. */
  | { action: "unsupported"; mimeType: string }
  /** Stage `file` as `kind`; `ignoredFileCount` further files were dropped
   *  because the composer holds one attachment at a time. */
  | {
      action: "attach";
      kind: PasteableKind;
      file: File;
      ignoredFileCount: number;
    };

/**
 * Decide what a paste means, from the two things a `ClipboardEvent` exposes:
 * its files and its `types`.
 *
 * Note `types` here is the CLIPBOARD's type list, not any file's MIME type.
 * They overlap confusingly on `text/plain` — which is also a legitimate
 * document MIME in `PICKER_ACCEPT` — but never collide: copying text puts no
 * file on the clipboard, and copying a .txt file gives `types === ["Files"]`.
 *
 * Order matters. Plain text beats files (rule 2) because spreadsheet apps —
 * Excel, Numbers, Google Sheets — put BOTH the copied text and a PNG
 * *rendition* of the cells on the clipboard. Without that rule, pasting a
 * few cells into the message box would silently attach a picture of them
 * instead of typing them.
 */
export function decidePasteAttachment(
  files: readonly File[],
  types: readonly string[],
): PasteDecision {
  const [file, ...rest] = files;
  if (!file) return { action: "ignore" };
  if (types.includes("text/plain")) return { action: "ignore" };

  const kind = MIME_TO_KIND[file.type];
  // `file.type` is "" when the OS can't classify the item; report something
  // nameable rather than an empty gap in the toast.
  if (!kind) return { action: "unsupported", mimeType: file.type || "unknown" };

  return { action: "attach", kind, file, ignoredFileCount: rest.length };
}
