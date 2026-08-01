# Inbox media: full-screen view + download

**Status:** approved
**Date:** 2026-08-02

## Problem

An agent received a tall marketing banner as an inbound WhatsApp image. In the
inbox thread they cannot read it, cannot enlarge it, and cannot save it:

1. **Far too small to read.** `MediaImage` renders at `max-h-64 max-w-60`
   (`src/components/inbox/message-bubble.tsx`). A tall banner is
   height-limited, so a 600×2000 image lands at **76.8×240** — measured in the
   browser against the app's own compiled CSS. The text on it is unreadable at
   that size.

   The `object-cover` on that same element was *suspected* of cropping the
   banner as well. Measurement disproved it: with only `max-*` constraints and
   no fixed width/height, the box already adopts the image's aspect ratio, so
   `cover` and `contain` produce byte-identical layout (both 76.8×256).
   Cropping needs a box whose aspect ratio is forced to differ. The switch to
   `object-contain` is kept as an intent-revealing safeguard for any future
   fixed-dimension styling — **it is not the fix**.
2. **Not openable.** The `<img>` has no click handler. There is no enlarged
   view anywhere in the inbox. This is the real fix for (1).
3. **Not downloadable.** There is no download control, and the obvious fix
   does not work — see below.

### Why download is not a one-line `<a download>`

Inbound media is pulled into Cloudflare R2 at ingest (`convex/ingest.ts`) and
stored as an object **key**. Readers resolve `mediaKey ?? mediaUrl` through
`resolveMediaUrl` (`src/lib/storage/media-url.ts`), which produces
`${NEXT_PUBLIC_R2_PUBLIC_HOST}/${key}` — a **cross-origin** URL.

- `<img src>` works cross-origin without CORS. That is why the banner renders
  at all.
- The `download` attribute on `<a>` is **ignored for cross-origin URLs**; the
  browser navigates instead of saving.
- A client-side `fetch()` → `blob` → `URL.createObjectURL` download needs
  `Access-Control-Allow-Origin` on the **GET** response. The bucket's CORS
  policy is documented as covering `PUT` + `content-type` for the browser
  upload path only
  (`docs/superpowers/specs/2026-07-19-cloudflare-r2-media-storage-design.md`),
  so a GET fetch cannot be relied on.

Therefore **download must be served from a same-origin endpoint** that attaches
`Content-Disposition: attachment`.

## Scope

| Media type | Full-screen view | Download |
| --- | --- | --- |
| image | yes | yes |
| video | yes | yes |
| audio | no (native player is adequate) | yes |
| document | no (cannot render inline) | yes |

No zoom/pan and no prev/next gallery navigation. `object-contain` at 90vh is
enough to read banner text, which is the reported need.

## Design

### 1. `src/lib/media/download.ts` — pure helpers

- `isProxiedDownload(url)` — true when the URL is cross-origin relative to the
  app, i.e. when it must go through the download route.
- `downloadHrefFor(url, filename)` — same-origin URLs pass through unchanged
  (a plain `<a download>` already works); cross-origin URLs become
  `/api/media/download?url=…&name=…`.
- `filenameFor(message)` — documents use `content_text` (the inbox already
  renders it as the filename); everything else uses the last path segment of
  the media URL, falling back to `whatsapp-<message id>` with an extension
  inferred from the content type.

Pure and dependency-free so it is unit-testable without a DOM.

### 2. `src/app/api/media/download/route.ts` — authenticated, allowlisted proxy

`GET /api/media/download?url=<absolute url>&name=<filename>`

1. `convexAuthNextjsToken()` → **401** when absent. Mirrors the existing
   `src/app/api/whatsapp/media/[mediaId]/route.ts`. The bucket is already
   public, so this grants no new read access; it keeps the CRM from being an
   anonymously usable proxy.
2. **Origin allowlist** → **400** for anything whose origin is not
   `NEXT_PUBLIC_R2_PUBLIC_HOST` or the request's own origin. This is the SSRF
   guard and the security-critical line of the change. Non-`http(s)` schemes
   (`file:`, `gopher:`, …) and unparseable URLs are rejected by the same check.
3. Fetch server-side, stream the body back with the upstream `Content-Type`
   and `Content-Disposition: attachment; filename*=UTF-8''<encoded>`.
4. Filename sanitised: path separators, control characters and quotes are
   stripped, length capped.

Streaming (not buffering) keeps a large video from being held in server memory.

### 3. `src/components/inbox/media-lightbox.tsx`

Base UI `Dialog` (`src/components/ui/dialog.tsx`), dark backdrop, content at
`max-h-[90vh] max-w-[90vw] object-contain`. Header carries a download button
and a close button; Esc and backdrop click close via the primitive. `<img>` for
images, `<video controls>` for video.

### 4. `src/components/inbox/message-bubble.tsx`

- `object-cover` → `object-contain` as a safeguard only — see the Problem
  section for why this changes nothing at today's sizing.
- Image and video become clickable (`cursor-zoom-in`) and open the lightbox.
- A download control on image, video, audio and document bubbles.
- Documents keep their existing row but point at the download href, so they
  save instead of opening a tab.
- **Bug fix, pre-existing:** `MediaImage`'s effect cleanup closes over a stale
  `src` — it was `null` when the effect ran, so `URL.revokeObjectURL` is never
  called with a real value and every proxy-fetched blob leaks for the life of
  the page. Track the blob URL in a ref and revoke that.

### 5. i18n

New `Inbox.bubble` keys in `messages/en.json`: `viewImage`, `viewVideo`,
`download`, `closeViewer`. `en` is currently the only locale.

## Testing

The repo has **no jsdom and no Testing Library**; component tests use
`renderToStaticMarkup` (see `src/components/inbox/voice-transcript.test.tsx`).

- `src/lib/media/download.test.ts` — filename derivation (document vs image vs
  fallback, extension inference), and the same-origin/cross-origin routing
  decision.
- `src/app/api/media/download/route.test.ts` — unauthenticated → 401;
  disallowed host → 400 **without** any outbound fetch (the SSRF assertion);
  allowed host → 200 with the expected `Content-Disposition` and passthrough
  `Content-Type`; filename sanitisation.
- `src/components/inbox/media-download-button.test.tsx` — static render proves
  each media bubble emits a download control with the right href.

Click-to-open, Esc-to-close and the actual file save are not reachable without
a DOM and are verified in the browser.

## Out of scope

Zoom/pan, gallery navigation between images, thumbnail generation, and any
change to the R2 bucket's CORS policy.
