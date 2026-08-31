# Paste-to-attach in the inbox composer

**Date:** 2026-07-25
**Surface:** `/inbox` → message thread → composer (`src/components/inbox/message-composer.tsx`)
**Status:** Approved design, ready for implementation planning

## Problem

Attaching media to an outbound WhatsApp message today requires the 📎 menu (or the ➕
menu on phones) → pick a kind → navigate a file dialog → choose the file. For the most
common case — a screenshot the agent just took, or an image already on the clipboard —
that is three interactions and a file dialog for something the operating system already
holds ready.

Agents expect Ctrl/Cmd+V in the message box to attach, because that is how Slack and
WhatsApp Web behave. Today it does nothing.

## Key architectural fact (why this is small)

The composer's upload path is already file-source-agnostic. `stageUpload(kind, file)`
(`message-composer.tsx:389`) takes a plain `File` and does everything downstream:

- enforces the per-kind Meta ceiling from `MEDIA_MAX_BYTES_BY_KIND` (image 5 MB, etc.),
- uploads straight to R2 via `uploadAccountMedia` with R2 kind `"outbound"`,
- GCs any previously staged object (`message-composer.tsx:422`),
- sets the `MediaDraft`, which renders `MediaDraftPreview` with the caption box and
  Send/Discard.

The hidden `<input type="file">` elements are merely one *source* of `File` objects.
The clipboard is another. So this change adds **no** backend, schema, Convex function,
or send-path work — `convex/send.ts` and the Meta send route are untouched.

## Key architectural gap (what actually needs care)

`uploadAccountMedia` performs **no MIME validation** — it forwards `file.type` to
`startUpload` and PUTs the bytes. The only thing keeping an unsupported type out of the
bucket today is the `accept` attribute on the file pickers, i.e. `PICKER_ACCEPT`
(`message-composer.tsx:99`).

A paste path has no `accept` attribute. Without an explicit allowlist check, a pasted
HEIC / TIFF / GIF would upload cleanly, stage as a draft, and then be **rejected by Meta
at send time with an opaque 400**. Validating the MIME before `stageUpload` is therefore
a requirement of this feature, not a nicety.

Safari's "Copy Image" in particular commonly yields `image/tiff`, which is not in
`PICKER_ACCEPT`.

## Decisions (locked)

1. **Scope of pasteable types:** everything the composer already supports —
   image, video, and document — driven by the existing `PICKER_ACCEPT` allowlist.
   Audio is excluded: it has no picker either, and is captured via the recorder.
2. **Listener scope:** the composer's root container, not just the textarea. This
   covers the textarea *and* the caption input of a staged draft, so pasting a second
   file swaps the staged attachment (free — `stageUpload` already GCs the old object).
   Rejected: document-level paste for the whole thread. The page has other editable
   fields (contact sidebar, conversation search) that would need target guards, for a
   modest gain. It remains an easy follow-up on top of this.
3. **Single attachment:** the composer's draft model holds one attachment. A multi-file
   paste attaches the first and toasts about the rest.
4. **Text paste is never broken.** The handler only calls `preventDefault()` on the
   branch where it actually attaches.

## Architecture

### New module: `src/lib/inbox/paste-attachment.ts`

The hard part of paste is not the upload — it is deciding *whether a given paste is an
attachment at all*. That decision is pure, and it moves out of the component:

- `PICKER_ACCEPT` **moves here** from `message-composer.tsx` and is re-imported by the
  composer, so the file pickers and the paste path share one allowlist. Adding a MIME
  type in future updates both surfaces at once.
- A derived `MIME_TO_KIND` lookup is built from `PICKER_ACCEPT` at module scope.
- One exported decision function maps clipboard contents to one of:
  `attach` (kind + file) · `unsupported` (the offending MIME, for the toast) ·
  `ignore` (let the browser paste normally).

The function takes the primitives it needs (the list of `File`s and the clipboard's
`types` array), not a `ClipboardEvent` — so it is testable without a DOM.

Why a separate module and not a helper inside the component: this repo's vitest setup
has **no jsdom and no Testing Library** (documented at
`src/components/inbox/conversation-list.test.tsx:8`). Component tests here assert on
static markup and cannot dispatch a paste event. A pure function is the only way these
rules get real test coverage.

### Composer change

An `onPaste` on the composer's root `<div>` (`message-composer.tsx:562`) that:

1. Returns immediately when `inputsDisabled || busy || recording`.
2. Calls the decision function.
3. `ignore` → return without touching the event.
4. `unsupported` → `preventDefault()`, toast, attach nothing.
5. `attach` → `preventDefault()`, `void stageUpload(kind, file)`; toast if extra files
   were dropped.

`stageUpload` already surfaces its own size-limit and upload-failure toasts, so no error
handling is duplicated.

## Decision rules

Evaluated in order:

| # | Condition | Result |
|---|---|---|
| 1 | No files on the clipboard | `ignore` — normal text paste |
| 2 | Files present **and** a `text/plain` item is also present | `ignore` — text wins |
| 3 | First file's MIME is in the allowlist | `attach` with the mapped kind |
| 4 | First file's MIME is not in the allowlist | `unsupported` |

**Rule 2 is the non-obvious one.** Copying cells from Excel, Numbers, or Google Sheets
puts *both* the text and a PNG **rendition** of those cells on the clipboard. Without
rule 2, pasting a spreadsheet snippet into the message box would silently attach a
picture of the cells instead of typing the text — a data-loss-shaped bug, and the single
most likely way this feature annoys someone in production.

## Gating

Paste reuses the composer's existing `inputsDisabled` (`message-composer.tsx:208`),
which is `readOnly || sessionExpired`. So paste-to-attach is unavailable to viewers, and
unavailable outside the 24-hour session window — identical to the 📎 attach menu, since
a pasted image is free-form media subject to the same Meta rule. No new capability or
permission is introduced.

Also a no-op while an upload is in flight (`busy`) or while the mic is recording, both
matching the attach menu's own disabled states.

## Filenames

Clipboard screenshots arrive as a `File` named `image.png`; a file copied in
Finder/Explorer keeps its real name. Both are usable as-is, so no filenames are
synthesized. This matters only for documents, where `filename` is surfaced to the
recipient by the send path (`SendMediaPayload.filename`).

## i18n

Two new keys under `Inbox.composer` in `messages/en.json` (the only locale in the repo):

- `pasteUnsupported` — unsupported clipboard type, interpolating the MIME type.
- `pasteMultipleFiles` — only the first of several pasted files was attached.

## Testing

`src/lib/inbox/paste-attachment.test.ts`, plain vitest with plain objects, no DOM:

- no files → `ignore`
- PNG screenshot, no text item → `attach` as `image`
- MP4 → `attach` as `video`; PDF → `attach` as `document`
- **image + `text/plain` present (the spreadsheet case)** → `ignore`
- `image/tiff` and `image/heic` → `unsupported`
- multiple files → first is attached, remainder reported
- `PICKER_ACCEPT` and `MIME_TO_KIND` agree (guards against the two drifting)

The spreadsheet case and the unsupported-MIME case are the two that would otherwise only
be discovered in production.

## Known risk to verify during implementation

Rule 2 assumes a Finder/Explorer-copied **file** does not also place `text/plain` on the
clipboard. This holds in Chrome; **Safari is unverified** and may expose the filename as
text, in which case pasting a file copied from Finder in Safari would fall to rule 2 and
do nothing.

The failure mode is deliberately the safe one — a no-op, never a wrong attachment — so
this does not block. Verification step: check `clipboardData.types` for a Finder-copied
file in Safari. If `text/plain` is present, narrow rule 2 to apply only when the first
file is an **image** (renditions are exclusively an image phenomenon — no application
places a PDF or MP4 rendition of copied text on the clipboard).

## Out of scope

- Drag-and-drop onto the composer (a natural sibling; separate change).
- Document-level paste for the whole thread (decision 2).
- Multiple attachments per message (requires reworking the single `MediaDraft` model).
- Pasting audio (no picker either; the recorder is the audio path).
