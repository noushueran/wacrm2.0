# Media Viewer Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the unified codebase Amani's zoom-and-pan media viewer on top of Holidayys' download
transport — the spec's §Decision, which the merge deferred.

**Architecture:** The transport already survived the merge untouched; nothing about it changes.
Only the viewer is replaced: Amani's 262-line lightbox is ported from `feat/inbox-media-view-download`
(`d770b0a`) and rewired from a callback-driven download to an `<a download>` pointing at the
existing same-origin route.

**Tech Stack:** React 19, Next.js App Router, Base UI dialog, next-intl, vitest.

**Parent spec:** `docs/superpowers/specs/2026-08-02-crm-codebase-unification-design.md` §Decision
**Depends on:** `2026-08-02-history-graft-and-merge.md` — this operates on the merged tree.

## Why this is smaller than the spec implies

The spec treated this as a hard conflict needing two implementations pulled apart. The graft dry run
showed otherwise: **Amani's media work never reached `main`** — it is on
`feat/inbox-media-view-download` — so the merge saw no competing implementation and Holidayys' code
survived intact. There is nothing to untangle and nothing to delete.

That collapses the work to one substitution:

| Layer | Merged tree today | After this plan |
|---|---|---|
| Download route | `src/app/api/media/download/route.ts` | **unchanged** |
| Download URL builder | `src/lib/media/download.ts` | **unchanged** |
| Viewer | `media-lightbox.tsx`, 109 lines, fit-to-window | Amani's, 262 lines, zoom + pan |
| Client fetch hooks | absent | **stay absent** |

Two corrections to the spec, both found by reading the merged code rather than the commit messages:

- **The blob leak is not applicable.** The spec said to carry Amani's fix across. Holidayys' image
  loader already stores the object URL in a ref (`blobUrlRef.current`) and its cleanup reads the
  ref, not closed-over state — the pattern Amani's fix introduced. There is no leak here to fix.
- **The CSP gap is real and is carried across.** Holidayys' `next.config.ts:69` is
  `media-src 'self' blob: ${CONVEX_URL}` with no R2 host, so `<video>` and `<audio>` bubbles will
  break the moment CSP moves from Report-Only to enforced. Unrelated to this feature, fixed here
  because this is the change that touches that file (Task 3).

The `connect-src` half of Amani's CSP change is **not** carried across: it existed to permit the
cross-origin `fetch()` that §Decision discards.

## Global Constraints

- **Do not reintroduce the client-fetch download path.** No `fetchMediaBlob`, no
  `needsCacheBypass`, no `triggerBlobDownload`, no `use-media-download.ts`. §Decision rejected them
  because they require a per-tenant R2 bucket CORS policy and fail in local development. If a
  download appears broken, fix the route — do not add a client fetch.
- **Labels are props, not `t()` calls.** The merged component takes explicit label strings rather
  than a translator, so it stays renderable without a next-intl provider — the condition this
  repo's static-render component tests depend on. Amani's own `use-media-download.ts` documents
  exactly this reasoning; its lightbox is the outlier, and the port normalises it.
- **The viewer cannot be unit-tested here, and the plan does not pretend otherwise.** See below.
- Stage paths explicitly; commit per task.

## On testing: what is and is not possible

This repo has no jsdom and no Testing Library. Component tests are `renderToStaticMarkup` from
`react-dom/server` (`src/components/inbox/media-download.test.tsx`, `voice-transcript.test.tsx`).

The lightbox renders inside a dialog **portal**, which `renderToStaticMarkup` does not traverse, so
its markup is unreachable from a static render. Zoom, pan, and the drag threshold are pointer
interactions, which are unreachable regardless. Both original implementations were verified in a
browser for exactly this reason — Amani's commit says so outright.

So the gate here is: **TypeScript, the existing suite staying green, and browser verification.**

What stays tested and must not regress:

- `src/lib/media/download.test.ts` — `downloadHrefFor`, `filenameFor`, `isProxiedDownload`. The
  download *decision* is pure and is covered.
- `src/app/api/media/download/route.test.ts` — auth, the origin allowlist, redirect refusal,
  filename sanitising. The transport is covered.
- `src/components/inbox/media-download.test.tsx` — that every non-image bubble offers a save control
  routed through `/api/media/download`. (Image bubbles are absent from it by design: `MediaImage`
  resolves its source in an effect, which a static render never runs.)

None of those change in this plan. If any of them needs editing to pass, something has gone wrong
with the transport — stop and re-read §Decision.

## File Structure

| File | Responsibility |
|---|---|
| `src/components/inbox/media-lightbox.tsx` | **Replace.** Amani's zoom/pan viewer, rewired to an `<a download>`. |
| `src/components/inbox/message-bubble.tsx` | **Modify.** Pass the three new label props. |
| `messages/en.json` | **Modify.** Add `zoomIn` / `zoomOut`. |
| `next.config.ts` | **Modify.** Add the R2 host to `media-src`. |

---

### Task 1: Replace the viewer

**Files:**
- Replace: `src/components/inbox/media-lightbox.tsx`

**Interfaces:**
- Consumes: nothing new. The component is self-contained.
- Produces: `MediaLightbox` with these props — Task 2 supplies them:

```ts
{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  kind: "image" | "video";
  src: string;
  alt: string;
  /** Accessible name for the dialog itself — visually hidden. */
  title: string;
  downloadHref: string;
  filename: string;
  downloadLabel: string;
  closeLabel: string;
  zoomInLabel: string;
  zoomOutLabel: string;
  caption?: string | null;
}
```

Compared with Amani's original: `onDownload`, `downloadPending` and `t` are gone; `title`,
`downloadHref`, `filename` and the four label strings replace them. Everything else — the zoom
state, the pan handlers, the drag threshold, the caption strip — is carried over unchanged.

- [ ] **Step 1: Get Amani's implementation**

The source is on a branch in the Amani repo, which the unified repo already has as a remote after
the graft. If `amani` is not a remote in this checkout, add it:

```bash
git remote get-url amani >/dev/null 2>&1 || \
  git remote add amani /Volumes/CurserDisk/Dev/wa-amani
git fetch amani
git show amani/feat/inbox-media-view-download:src/components/inbox/media-lightbox.tsx \
  > /tmp/amani-lightbox.tsx
wc -l /tmp/amani-lightbox.tsx    # expect 262
```

- [ ] **Step 2: Write the replacement**

Overwrite `src/components/inbox/media-lightbox.tsx` with Amani's file, then apply exactly the five
changes below. Everything not listed is copied verbatim — the zoom/pan logic is subtle (the
render-phase zoom reset, the `requestAnimationFrame` scroll centring, the 4px drag threshold, the
`active:` class rather than a ref-derived one) and each of those has a comment explaining a bug it
prevents. Do not rewrite them.

**(a) Imports.** Drop the `useTranslations` type import; keep the rest:

```ts
"use client";

import { useCallback, useRef, useState } from "react";
import { Download, X, ZoomIn, ZoomOut } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
```

**(b) Props.** Replace Amani's `MediaLightboxProps` with:

```ts
interface MediaLightboxProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  kind: "image" | "video";
  /** Already-resolved source — a blob URL for proxied media. Passed in
   *  rather than re-resolved so opening costs no second request and shows
   *  no second spinner. */
  src: string;
  alt: string;
  /** Accessible name for the dialog itself — visually hidden. */
  title: string;
  /** Same-origin download URL from `downloadHrefFor`. NOT the raw media
   *  URL: `<a download>` is silently ignored cross-origin, so pointing
   *  this at R2 would navigate to the file instead of saving it. */
  downloadHref: string;
  filename: string;
  downloadLabel: string;
  closeLabel: string;
  zoomInLabel: string;
  zoomOutLabel: string;
  caption?: string | null;
}
```

Labels are strings rather than a `t` function so this component renders without a next-intl
provider — the condition this repo's static-render tests depend on.

**(c) Signature.** Replace the destructured parameter list to match, dropping `onDownload`,
`downloadPending` and `t`:

```ts
export function MediaLightbox({
  open,
  onOpenChange,
  kind,
  src,
  alt,
  title,
  downloadHref,
  filename,
  downloadLabel,
  closeLabel,
  zoomInLabel,
  zoomOutLabel,
  caption,
}: MediaLightboxProps) {
```

**(d) The dialog title.** Amani's reads `t("imageViewer")` / `t("videoViewer")`; use the prop:

```tsx
        <DialogTitle className="sr-only">{title}</DialogTitle>
```

**(e) The toolbar.** Replace Amani's three controls with these. The zoom button takes its labels
from props; the download button becomes an **anchor** — this is the actual substitution the whole
plan is for:

```tsx
        <div className="absolute top-0 right-0 z-10 flex items-center gap-1 p-3">
          {kind === "image" && (
            <Button
              variant="ghost"
              size="icon-lg"
              className={toolbarButton}
              aria-label={zoomed ? zoomOutLabel : zoomInLabel}
              onClick={() => setZoomed((value) => !value)}
            >
              {zoomed ? <ZoomOut /> : <ZoomIn />}
            </Button>
          )}
          {/* An anchor, not a button with an onClick: the bytes come back
              through the same-origin `/api/media/download` route, which
              re-serves them with `Content-Disposition: attachment`. The
              browser then does the saving natively — no fetch, no blob, no
              object URL, and it works in local development, none of which
              was true of the client-fetch path this replaces. */}
          <Button
            render={<a href={downloadHref} download={filename} />}
            variant="ghost"
            size="icon-lg"
            className={toolbarButton}
            aria-label={downloadLabel}
          >
            <Download />
          </Button>
          <DialogClose
            render={
              <Button
                variant="ghost"
                size="icon-lg"
                className={toolbarButton}
                aria-label={closeLabel}
              />
            }
          >
            <X />
          </DialogClose>
        </div>
```

The `render={<a .../>}` form is Base UI's element-substitution prop: `src/components/ui/button.tsx`
wraps `@base-ui/react/button` and spreads `...props`, so `render` passes through, and
`src/components/ui/dialog.tsx:112` already uses the same pattern (`DialogClose render={<Button/>}`).
It keeps the button's styling while changing the rendered element.

This would be the repo's first `render={<a>}`, so confirm it really produces an anchor rather than a
`<button>` — Task 4 Step 5 catches it, since a `<button>` would silently do nothing on click.

- [ ] **Step 3: Typecheck**

```bash
npx tsc --noEmit
```

Expected: errors in `message-bubble.tsx` only, reporting the props that no longer exist and the ones
now required. **That is the correct result at this point** — Task 2 fixes the call site. Errors
anywhere else mean something beyond the viewer was disturbed.

- [ ] **Step 4: Commit**

```bash
git add src/components/inbox/media-lightbox.tsx
git commit -m "feat(inbox): zoom and pan in the media viewer

Applies the codebase-unification spec's decision on the media viewer.
Both CRMs built this feature independently on the same day; this takes
the better half of each.

The viewer is Amani's: an image opens fit-to-window and toggles to
natural size on click, where the container scrolls and can be dragged to
pan. That is the case the fit-to-window viewer could not serve — a tall
banner whose fine print is unreadable at fit size, which both designs
named as the reason for building this.

The download stays Holidayys': an <a download> pointing at the
same-origin /api/media/download route, which re-serves the bytes with
Content-Disposition. Amani's client fetch is deliberately NOT carried
over — it needs the R2 bucket to name the app origin in its CORS policy,
which makes a feature depend on per-tenant infrastructure config and
fails outright in local development.

Labels are props rather than t() calls so the component renders without
a next-intl provider, matching the rest of this repo's components.

The call site is updated in the next commit; this one does not typecheck
on its own."
```

---

### Task 2: Update the call site and the copy

**Files:**
- Modify: `src/components/inbox/message-bubble.tsx`
- Modify: `messages/en.json`

**Interfaces:**
- Consumes: `MediaLightbox` from Task 1.
- Produces: a typechecking tree.

- [ ] **Step 1: Add the two new message keys**

In `messages/en.json`, in the same object that already holds `viewImage`, `viewVideo`, `download`
and `closeViewer`, add:

```json
      "zoomIn": "Zoom in",
      "zoomOut": "Zoom out",
```

Amani's branch also carried `downloadFailed` and `openInTab`. Both are deliberately **not** added:
they were the toast fallback for a cross-origin fetch that failed, and that path no longer exists.

- [ ] **Step 2: Pass the new props**

In `src/components/inbox/message-bubble.tsx`, the `<MediaLightbox>` call currently reads:

```tsx
        <MediaLightbox
          open={zoomed}
          onOpenChange={setZoomed}
          kind="image"
          src={src}
          alt={alt}
          title={alt}
          downloadHref={downloadHref ?? src}
          filename={filename}
          downloadLabel={t("download")}
          closeLabel={t("closeViewer")}
        />
```

Add the two zoom labels:

```tsx
        <MediaLightbox
          open={zoomed}
          onOpenChange={setZoomed}
          kind="image"
          src={src}
          alt={alt}
          title={alt}
          downloadHref={downloadHref ?? src}
          filename={filename}
          downloadLabel={t("download")}
          closeLabel={t("closeViewer")}
          zoomInLabel={t("zoomIn")}
          zoomOutLabel={t("zoomOut")}
        />
```

Leave `downloadHref={downloadHref ?? src}` exactly as it is. The fallback covers a message with no
resolvable media URL, where `src` is already a same-origin blob URL and needs no proxying — the
comment above it in the file explains this.

- [ ] **Step 3: Do the same for any video call site**

```bash
grep -n 'MediaLightbox' src/components/inbox/message-bubble.tsx
```

If a second instance renders with `kind="video"`, add the same two props. The zoom control does not
render for video, but the props are required by the type — supply them rather than making them
optional, so a future video zoom does not silently render an unlabelled button.

- [ ] **Step 4: Typecheck**

```bash
npx tsc --noEmit
```

Expected: **no errors**, including the ones Task 1 Step 3 produced.

- [ ] **Step 5: Run the suite**

```bash
npx vitest run
```

Expected: PASS with no test edited. The three media test files named in §On testing exercise the
transport and the non-image bubbles, none of which this plan touches. **A failure there means the
transport was disturbed** — re-read §Decision before changing a test to match.

- [ ] **Step 6: Commit**

```bash
git add src/components/inbox/message-bubble.tsx messages/en.json
git commit -m "feat(inbox): wire the zoom controls into the media bubble

Passes the two new zoom labels and adds their copy.

downloadFailed and openInTab from Amani's branch are deliberately not
carried over: they were the toast fallback for a cross-origin fetch that
could fail, and that path no longer exists — the same-origin route
either serves the bytes or returns a status.

No test needed editing, which is the point: this changed the viewer, not
the transport, and the transport is what the media tests cover."
```

---

### Task 3: Close the CSP media-src gap

**Files:**
- Modify: `next.config.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: a `media-src` that permits the R2 host.

Independent of the viewer, and a real latent bug. `next.config.ts:69` is currently:

```ts
      `media-src 'self' blob: ${CONVEX_URL}`,
```

Inbound video and audio bubbles stream straight from the R2 custom domain, which is not listed. The
policy ships Report-Only today, so nothing is broken yet — the moment it is enforced, every voice
note and video in the Inbox stops playing. Fixed here because this is the change that touches this
file.

- [ ] **Step 1: Derive the R2 host**

Next to the existing `CONVEX_URL` declaration, add:

```ts
// The R2 custom domain media is served from, mirroring
// `NEXT_PUBLIC_R2_PUBLIC_HOST` the same way CONVEX_URL mirrors the Convex
// origin. `img-src https:` already covers DISPLAYING images, but <video>
// and <audio> bubbles stream straight from R2 and `media-src` does not
// have an `https:` wildcard to fall back on.
//
// Empty string when unset, filtered out below, so a deployment without R2
// configured emits the policy it always did.
const R2_PUBLIC_HOST = (process.env.NEXT_PUBLIC_R2_PUBLIC_HOST || "").replace(
  /\/+$/,
  "",
);
```

- [ ] **Step 2: Add it to `media-src` only**

Replace the `media-src` line:

```ts
      ["media-src 'self' blob:", CONVEX_URL, R2_PUBLIC_HOST]
        .filter(Boolean)
        .join(" "),
```

**Do not add it to `connect-src`.** Amani's branch did, because its download `fetch()`ed the object
cross-origin. That path is not in this codebase, and widening `connect-src` for a request nothing
makes is a permission granted for nothing.

- [ ] **Step 3: Verify the header**

```bash
npx next build && npx next start &
sleep 5
curl -sI http://localhost:3000/inbox | grep -i 'content-security-policy' | tr ';' '\n' | grep -E 'media-src|connect-src'
kill %1
```

Expected: `media-src` includes the R2 host; `connect-src` does **not**.

If `NEXT_PUBLIC_R2_PUBLIC_HOST` is unset locally the host is absent from both — that is the
`.filter(Boolean)` working. Set it and re-run to see the real output.

- [ ] **Step 4: Commit**

```bash
git add next.config.ts
git commit -m "fix(csp): allow media to stream from the R2 host

media-src listed only 'self', blob: and Convex, but inbound video and
audio bubbles stream straight from the R2 custom domain. The policy
ships Report-Only so nothing is broken yet — the moment it is enforced,
every voice note and video in the Inbox stops playing.

img-src already covered displaying images via its https: wildcard, which
is why this was invisible: the common case kept working.

Only media-src. connect-src is deliberately left alone — the download
path is a same-origin route, so nothing fetches R2 from the browser, and
widening it would grant a permission for a request nothing makes."
```

---

### Task 4: Verify in a browser

**Files:** none.

**Interfaces:**
- Consumes: the finished change.
- Produces: the only real evidence available for this feature.

Zoom, pan and the file write cannot be reached from a static render — see §On testing. Both original
implementations were browser-verified and so is this.

- [ ] **Step 1: Start the app against a real deployment**

The Inbox needs data, so run against a real Convex deployment with media in it (`npm run use:amani`
or `use:holidayys` if the deploy machinery has landed, otherwise a `.env.local` pointing at one).

Use the preview tooling rather than asking anyone to check by hand.

- [ ] **Step 2: Open an image bubble and confirm fit-to-window**

Find a thread with a tall image. Click the bubble.

Expected: the viewer opens with the whole image visible, letterboxed — not cropped, not overflowing.

- [ ] **Step 3: Zoom and pan — the reason this plan exists**

Click the image.

Expected: it jumps to natural size, centred on the point clicked. Drag: the image pans and the
cursor shows a grab state. Click again (without dragging): it returns to fit.

Then check the case the 4px threshold exists for: **drag by a few pixels and release.** It must
*not* toggle zoom — a shaky click while panning should stay panning.

- [ ] **Step 4: Reopen and confirm the zoom reset**

Close the viewer, open a different image.

Expected: fit-to-window again, not carrying the previous zoom or scroll offset.

- [ ] **Step 5: Download — the substitution**

Click the download control in the toolbar.

Expected: the browser **saves a file**, with a sensible name (`whatsapp-image-2026-08-02.jpg`, or
the sender's own filename for a document). It must not navigate to the image or open a new tab.

Then confirm the request went where it should:

```
/api/media/download?url=…&name=…
```

not directly to the R2 host. If the network panel shows a request straight to `objs.*`, the anchor
is pointing at `src` rather than `downloadHref` — the exact bug §Decision exists to prevent, and
one that would work on production while failing in local development.

- [ ] **Step 6: Video**

Open a video bubble.

Expected: it opens large and plays; **no zoom control is rendered** (zoom does not apply); download
works.

- [ ] **Step 7: Console and network**

Check for console errors and for any CSP violation report mentioning `media-src` or `connect-src`.

Expected: none. A `media-src` report here means Task 3's host is wrong; a `connect-src` report means
something is still fetching R2 from the browser, which nothing in this design should do.

- [ ] **Step 8: Record what was verified**

Zoom, pan, the drag threshold, the zoom reset, the saved file and its name, and the download request
path — none are covered by a test, so the PR description is where the evidence lives. Note the
browser used; the `<a download>` attribute and the drag-threshold behaviour are the two things most
likely to differ across browsers.

---

## What this plan does NOT do

- **Change the download transport.** The route, the origin allowlist and the URL builder are
  untouched and their tests are unedited. If a download misbehaves, the fault is in the anchor's
  `href`, not in the route.
- **Bring across Amani's client-fetch hooks.** `use-media-download.ts`, `use-media-object-url.ts`,
  `fetchMediaBlob`, `needsCacheBypass` and `triggerBlobDownload` stay absent. §Decision rejected the
  approach; the well-diagnosed opaque-cache bug those contained simply stops existing once the fetch
  is same-origin.
- **Fix a blob leak.** The spec expected one. Holidayys' image loader already uses a ref for the
  object URL and its cleanup reads the ref, so the leak Amani fixed does not exist in this codebase.
- **Add lightbox unit tests.** Not possible here — no jsdom, and the dialog renders through a portal
  that `renderToStaticMarkup` does not traverse. Task 4 is the substitute, deliberately and
  explicitly.
