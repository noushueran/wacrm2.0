# Composer Paste-to-Attach Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an agent press Ctrl/Cmd+V in the inbox composer to stage a clipboard image, video, or document as a WhatsApp attachment, instead of going through the 📎 menu and a file dialog.

**Architecture:** The composer's existing `stageUpload(kind, file)` already handles size caps, R2 upload, GC of a replaced draft, and the caption/send UI — it just needs a second source of `File` objects besides the hidden file pickers. All the *decision* logic (is this paste an attachment? which kind? is the MIME allowed?) moves into a new dependency-free module so it can be unit-tested, since this repo's vitest has no jsdom and cannot dispatch a paste event. The composer's `onPaste` is a thin wrapper over that function.

**Tech Stack:** Next.js (App Router) + React client component, TypeScript, vitest (node environment, no jsdom, no Testing Library), sonner for toasts, next-intl for copy, Convex + Cloudflare R2 for the (untouched) upload path.

**Spec:** `docs/superpowers/specs/2026-07-25-composer-paste-attachments-design.md`

## Global Constraints

- **No backend changes.** `convex/`, the schema, and the Meta send route are untouched. This is a client-only change.
- **Never run `convex deploy` / `convex dev` / `convex codegen`** — this repo points at a self-hosted production deployment.
- **Scope lint to changed files** (`npx eslint <paths>`), never the whole repo.
- **Stage git paths explicitly** (`git add <path> <path>`), never `git add -A` or `git add .` — concurrent sessions share this working tree and there are unrelated modified files present.
- **Pasteable kinds are `image` | `video` | `document` only.** Audio is excluded — it has no file picker either; the composer's recorder is its only source.
- **`PICKER_ACCEPT` must have exactly one home.** After Task 2 it lives in `src/lib/inbox/pasteAttachment.ts` and the composer imports it. It must not be duplicated.
- **New user-facing copy goes in `messages/en.json`** under `Inbox.composer` and is read via `useTranslations("Inbox.composer")`. `en` is the only locale in the repo.
- **Module naming in `src/lib/inbox/` is camelCase** (`adWindow.ts`, `customFieldValues.ts`, `funnelView.ts`), with the test co-located as `<name>.test.ts`. The new module is `pasteAttachment.ts` — note this differs from the kebab-case filename used illustratively in the spec; camelCase wins, to match the directory.

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `src/lib/inbox/pasteAttachment.ts` | Create | Pure paste-decision logic: the `PICKER_ACCEPT` MIME allowlist (moved here), its derived reverse index, and `decidePasteAttachment()`. No React, no Convex, no DOM. |
| `src/lib/inbox/pasteAttachment.test.ts` | Create | Unit tests for every decision rule, using real `File` objects (Node 22 has `File` as a global). |
| `src/components/inbox/message-composer.tsx` | Modify | Drop the local `PICKER_ACCEPT`, import it from the new module, add `handlePaste`, and mount `onPaste` on a wrapper around the composer body. |
| `messages/en.json` | Modify | Two new `Inbox.composer` keys for the unsupported-type and multiple-files toasts. |

---

### Task 1: Paste-decision module

Pure logic, fully test-driven. Produces the function Task 2 consumes. A reviewer can accept or reject this independently of any UI wiring.

**Files:**
- Create: `src/lib/inbox/pasteAttachment.ts`
- Test: `src/lib/inbox/pasteAttachment.test.ts`

**Interfaces:**
- Consumes: nothing (leaf module, dependency-free).
- Produces, for Task 2:
  - `type PasteableKind = "image" | "video" | "document"`
  - `const PICKER_ACCEPT: Record<PasteableKind, string>` — comma-separated MIME lists, the exact strings currently at `src/components/inbox/message-composer.tsx:99-104`
  - `const MIME_TO_KIND: Readonly<Record<string, PasteableKind>>`
  - `type PasteDecision = { action: "ignore" } | { action: "unsupported"; mimeType: string } | { action: "attach"; kind: PasteableKind; file: File; ignoredFileCount: number }`
  - `function decidePasteAttachment(files: readonly File[], types: readonly string[]): PasteDecision`

- [ ] **Step 1: Write the failing test**

Create `src/lib/inbox/pasteAttachment.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run src/lib/inbox/pasteAttachment.test.ts
```

Expected: FAIL — `Failed to resolve import "./pasteAttachment"`, because the module does not exist yet.

- [ ] **Step 3: Write the implementation**

Create `src/lib/inbox/pasteAttachment.ts`:

```ts
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
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run src/lib/inbox/pasteAttachment.test.ts
```

Expected: PASS — 13 passed (the `it.each` block counts as 3).

- [ ] **Step 5: Typecheck and lint the new files**

```bash
npm run typecheck && npx eslint src/lib/inbox/pasteAttachment.ts src/lib/inbox/pasteAttachment.test.ts
```

Expected: both exit 0 with no output. `npm run typecheck` covers the whole repo and must be clean — if it reports errors in files you did not touch, stop and report them rather than fixing them.

- [ ] **Step 6: Commit**

```bash
git add src/lib/inbox/pasteAttachment.ts src/lib/inbox/pasteAttachment.test.ts
git commit -m "feat(inbox): paste-decision logic for composer attachments

Pure module so the rules are testable — vitest here has no jsdom, so a
paste event can't be dispatched from a test. Plain text beats files
because spreadsheet copies carry a PNG rendition of the cells alongside
the text, and attaching that would replace what the agent meant to type.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Wire paste into the composer

Consumes Task 1's module and makes the feature real. Includes the copy it needs.

**Files:**
- Modify: `src/components/inbox/message-composer.tsx` (imports ~46-63; delete `PICKER_ACCEPT` at 99-104; new callback after `handlePicked` at 433-438; wrapper element around the render branches at 623-850)
- Modify: `messages/en.json` (`Inbox.composer` object)

**Interfaces:**
- Consumes from Task 1: `PICKER_ACCEPT`, `decidePasteAttachment`, and the `PasteDecision` union, all from `@/lib/inbox/pasteAttachment`.
- Produces: nothing consumed by later tasks — this is the last task.

**Why a wrapper element rather than the component's root `<div>`:** the interactive-message `<Dialog>` and the `<QuickReplyPicker>` are rendered inside that root (lines 864-901). Radix renders them through a React **portal** — and React's synthetic events propagate along the *React* tree, not the DOM tree. An `onPaste` on the root would therefore also fire for pastes inside those dialogs, letting a file pasted into a dialog's text field stage an attachment invisibly behind it. Wrapping only the composer body avoids this without any `if (dialogOpen)` guard.

- [ ] **Step 1: Add the two new copy strings**

In `messages/en.json`, inside the `Inbox.composer` object, add these two keys immediately after the existing `"removeAttachment"` line:

```json
    "pasteUnsupported": "Can't attach a {type} file — supported: PNG/JPEG/WebP images, MP4/3GP video, PDF and Office documents.",
    "pasteMultipleFiles": "Attached the first file — one attachment per message.",
```

Keep the file's existing 2-space indentation and make sure the preceding line still ends with a comma.

- [ ] **Step 2: Verify the JSON is still valid**

```bash
node -e "const m=require('./messages/en.json').Inbox.composer; console.log(m.pasteUnsupported, '|', m.pasteMultipleFiles)"
```

Expected: both strings print on one line, separated by `|`. A syntax error here fails the build, so do not skip this.

- [ ] **Step 3: Replace the composer's local `PICKER_ACCEPT` with the shared one**

In `src/components/inbox/message-composer.tsx`, delete this entire block (lines 95-104) — the comment and the constant:

```ts
// Mirrors the previous chat-media bucket's allowed_mime_types (migration
// 023) for the file picker so unsupported files are rejected before
// upload rather than failing with a confusing Storage error. Audio has
// no picker — it's captured via the recorder.
const PICKER_ACCEPT: Record<"image" | "video" | "document", string> = {
  image: "image/png,image/jpeg,image/webp",
  video: "video/mp4,video/3gpp",
  document:
    "application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.presentationml.presentation,text/plain",
};
```

Then add this import next to the other `@/lib` imports, immediately after the `mediaUrlFromKey` import on line 51:

```ts
import {
  decidePasteAttachment,
  PICKER_ACCEPT,
} from "@/lib/inbox/pasteAttachment";
```

The three `accept={PICKER_ACCEPT.image}` / `.video` / `.document` usages at lines 595, 605 and 615 are unchanged — they now read the imported constant.

- [ ] **Step 4: Add the paste handler**

In the same file, insert this immediately after the `handlePicked` callback (which ends at line 438, just before the `// ---- Voice recording` comment):

```tsx
  // Ctrl/Cmd+V straight into the composer stages an attachment, reusing the
  // same `stageUpload` path as the 📎 picker. Gated exactly like that menu:
  // no pasting for viewers, outside the 24h window, mid-upload, or while
  // the mic is live.
  const handlePaste = useCallback(
    (e: React.ClipboardEvent<HTMLDivElement>) => {
      if (inputsDisabled || busy || recording) return;

      const decision = decidePasteAttachment(
        Array.from(e.clipboardData.files),
        Array.from(e.clipboardData.types),
      );
      if (decision.action === "ignore") return;

      // Only past this point is the paste media rather than text — so this
      // is the only branch that may suppress the browser's own paste.
      e.preventDefault();

      if (decision.action === "unsupported") {
        toast.error(t("pasteUnsupported", { type: decision.mimeType }));
        return;
      }
      if (decision.ignoredFileCount > 0) {
        toast.info(t("pasteMultipleFiles"));
      }
      // stageUpload owns its own size-limit and upload-failure toasts.
      void stageUpload(decision.kind, decision.file);
    },
    [inputsDisabled, busy, recording, t, stageUpload],
  );
```

- [ ] **Step 5: Mount the handler on a wrapper around the composer body**

Find the three-way render branch that begins at line 623 with `{draft ? (` and ends at line 850 with `)}` (the closing of the `recording ? … : (…)` chain, immediately before the `{/* Hint sits outside the flex row … */}` comment).

Wrap that whole expression in a `<div>` carrying the handler — open it on the line before `{draft ? (`:

```tsx
      {/* Paste target. Deliberately NOT the component root: the dialogs
          below render through a React portal, and synthetic events
          propagate along the React tree, so a root-level onPaste would also
          fire for pastes inside them. This covers the textarea and the
          staged draft's caption input, which is exactly the surface where
          a paste should attach. */}
      <div onPaste={handlePaste}>
```

and close it with `</div>` on the line after the branch's final `)}`.

Do not add a `className` — a bare block-level `<div>` in normal flow leaves the layout unchanged. Both the textarea and the caption input sit inside this subtree, so the event bubbles to it from either.

- [ ] **Step 6: Typecheck and lint**

```bash
npm run typecheck && npx eslint src/components/inbox/message-composer.tsx
```

Expected: both exit 0. A `PICKER_ACCEPT is not defined` error here means Step 3's import was missed; an exhaustiveness complaint about `decision.action` means a branch was dropped.

- [ ] **Step 7: Run the full test suite**

```bash
npm test
```

Expected: all suites pass, including `src/lib/inbox/pasteAttachment.test.ts`. Nothing in the existing suite touches the composer, so this is a regression check on the `PICKER_ACCEPT` move rather than new coverage.

- [ ] **Step 8: Commit**

```bash
git add src/components/inbox/message-composer.tsx messages/en.json
git commit -m "feat(inbox): paste images, video and documents into the composer

Ctrl/Cmd+V now stages a clipboard file through the same upload path as the
attach menu. PICKER_ACCEPT moves to the shared module so the picker's
accept attribute and the paste allowlist can't drift.

The handler sits on a wrapper rather than the component root because the
interactive-message dialog renders through a portal, and React synthetic
events propagate along the React tree — a root handler would attach files
pasted into the dialog.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

- [ ] **Step 9: Manual browser verification**

This cannot be automated here — there is no jsdom, and driving a real OS clipboard is out of reach of the test tools. The app is also behind a login wall, so this needs the human at the keyboard. Ask the user to run through this list on `/inbox` with a conversation open and inside its 24-hour window, and report the results:

1. **Screenshot** — copy a screenshot to the clipboard, click the message box, Cmd/Ctrl+V. Expect: the image stages with a preview and a caption box; Send delivers it.
2. **Text still pastes** — copy a paragraph of text, paste into the message box. Expect: the text appears; nothing attaches.
3. **Spreadsheet cells (the rule-2 case)** — copy a few cells from Excel, Numbers or Google Sheets and paste. Expect: the **text** appears, *not* a picture of the cells.
4. **Finder/Explorer file** — copy a PDF in the file manager and paste. Expect: it stages as a document with its real filename. **In Safari this is the known risk from the spec** — if nothing happens, capture `clipboardData.types` and apply the documented fallback (narrow rule 2 to images only, since renditions are exclusively an image phenomenon).
5. **Unsupported type** — copy a HEIC or GIF and paste. Expect: the "Can't attach…" toast, nothing staged.
6. **Replace a staged attachment** — with one image staged, paste a different image from the caption box. Expect: the preview swaps to the new image.
7. **Expired session** — open a conversation past its 24-hour window and paste an image. Expect: nothing happens (the textarea is disabled and `inputsDisabled` blocks the handler).

- [ ] **Step 10: Record any Safari fallback**

If step 9.4 showed Safari exposing `text/plain` for a copied file, apply the spec's documented fallback in `decidePasteAttachment` — make rule 2 conditional on the first file being an image — add a test for a document-plus-text clipboard, and commit separately. If Safari behaved, note that the risk is closed in the spec's "Known risk" section and commit that edit.

---

## Verification checklist

- [ ] `npx vitest run src/lib/inbox/pasteAttachment.test.ts` passes
- [ ] `npm test` passes
- [ ] `npm run typecheck` clean
- [ ] `npx eslint src/lib/inbox/pasteAttachment.ts src/lib/inbox/pasteAttachment.test.ts src/components/inbox/message-composer.tsx` clean
- [ ] `PICKER_ACCEPT` appears in exactly one source file (`grep -rn "PICKER_ACCEPT" src | grep -v test`)
- [ ] Manual browser pass from Task 2 Step 9 reported back
