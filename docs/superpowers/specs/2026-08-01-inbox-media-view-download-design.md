# Inbox media: view large, and download

Date: 2026-08-01

## Problem

An image sent in the inbox renders as a 240×256px thumbnail with
`object-cover` — cropped, uncapped in neither direction, and with no click
behaviour at all. A tall banner is therefore both cropped *and* too small to
read, and there is no way to open it larger or save it. Video has the same
240px cap. Documents open in a new tab but cannot be saved deliberately.

## Scope

Image, video and document messages. Audio, location, template, interactive
and contact-card bubbles are untouched.

## Behaviour

**Image.** The thumbnail becomes a focusable button and switches from
`object-cover` to `object-contain`, so the bubble shows the whole banner
letterboxed rather than a cropped middle slice. Activating it opens a
near-fullscreen dialog with the image scaled to fit the viewport. Clicking the
image (or the zoom button) switches to the image's natural size inside a
scrollable container, where it can be dragged to pan; clicking again returns to
fit. `Esc` and the close button dismiss it.

**Video.** Opens in the same dialog at viewport size with native controls. No
zoom — it does not apply to a video element.

**Document.** Keeps its existing open-in-new-tab link and gains a download
action. It does not open in the dialog: a modal is a poor PDF viewer and
non-PDF types cannot render at all.

**Download** is available from two places: the existing hover / long-press
toolbar that already carries Reply, React and Copy (shown only for the three
media types above), and a button inside the dialog.

## The cross-origin download constraint

The HTML `download` attribute is **silently ignored for cross-origin URLs**.
Media is served from `objs.amaniworld.com`, so a plain `<a download>` would
navigate to the image instead of saving it. The working path is
fetch → `blob()` → object URL → synthetic anchor click → revoke, which
requires CORS on the media host.

Verified live on 2026-08-01: `objs.amaniworld.com` echoes back both
`https://wa.amaniworld.com` and `http://localhost:3000` with `vary: Origin`,
so the CORS side is fine in production *and* in development.

**The cache trap, found in the browser and not by reasoning.** With CORS
correct, the first in-page `fetch` still failed with a bare "Failed to
fetch". Cause: the bubble has already displayed the same URL through an
`<img>`, which — carrying no `crossorigin` attribute — is fetched in
no-cors mode and stored in the HTTP cache as an **opaque** response. A
later cors-mode `fetch` reuses that entry, finds no usable
`Access-Control-Allow-Origin` on it, and rejects. Because the image is
always on screen before anyone clicks download, this is the normal path,
not an edge case: download would have failed *every single time* while
looking correct in review.

`fetch(url, { cache: "reload" })` bypasses the poisoned entry and repairs
it; confirmed in the browser, where the same three fetches then all
succeed. Same-origin proxy URLs are exempt — no CORS problem to solve, and
a forced reload would re-run the authenticated Meta round-trip. The rule
lives in the pure `needsCacheBypass` so it is pinned by tests.

Adding `crossorigin="anonymous"` to the `<img>` would fix the caching at
source and save the re-download, but it makes *display* depend on CORS —
any legacy media host lacking it would stop rendering images at all. One
re-download on an explicit click is the cheaper trade.

**CSP.** `connect-src` listed only `'self'` and the Convex origin, so
`fetch`ing R2 was never going to be allowed once the policy is enforced
(it ships as `Content-Security-Policy-Report-Only` today, with a stated
intent to flip it). `next.config.ts` now adds `NEXT_PUBLIC_R2_PUBLIC_HOST`
to `connect-src`, and to `media-src` as well — `<video>`/`<audio>` bubbles
stream straight from R2 and would have broken on that same flip,
independently of this feature.

**Fallback.** On any fetch failure the user gets an error toast carrying an
"Open in new tab" action. The fallback is deliberately *not* an automatic
`window.open` — that call would happen after an `await`, outside the user
gesture, and popup blockers routinely block it. Putting the escape hatch
behind a click keeps it inside a genuine gesture, so it always works.

## Filenames

Documents reuse their own filename from `content_text`, with an extension
appended only if it lacks one. Images and videos get
`amani-image-2026-08-01-1834.jpg`, the extension resolved from the downloaded
blob's MIME type, falling back to the extension in the URL path, then to a
per-kind default. Names are sanitised of path separators and control
characters.

## Structure

| File | Role |
| --- | --- |
| `src/lib/media/download.ts` | Pure: extension and filename derivation. Impure: `fetchAsBlob`, `triggerBlobDownload`. No i18n, no toasts. |
| `src/components/inbox/use-media-download.ts` | Hook wrapping the above with toast and translation handling, so both call sites behave identically. |
| `src/components/inbox/media-lightbox.tsx` | The dialog: fit / zoom / pan, download, close. |
| `src/components/inbox/message-bubble.tsx` | `useMediaObjectUrl` hook extracted; thumbnails become lightbox triggers. |
| `src/components/inbox/message-actions.tsx` | Download entry, for media messages only. |
| `messages/en.json` | New keys under `Inbox.bubble`. |
| `next.config.ts` | R2 host added to the `connect-src` and `media-src` CSP directives. |

The already-resolved `src` is passed from the bubble into the dialog rather
than refetched, so opening the lightbox costs no second request and shows no
second spinner.

## Bug fixed on the way through

`message-bubble.tsx`'s blob cleanup closes over `src` from the render in which
the effect ran — `null` on mount — so `URL.revokeObjectURL` never fires and
every proxied image leaks its blob for the lifetime of the page. Extracting the
fetch into `useMediaObjectUrl` fixes it: the object URL becomes a local that
the cleanup closure captures directly.

## Testing

This repo has no jsdom and no Testing Library; component tests are static
renders via `renderToStaticMarkup`. The test plan follows that constraint
rather than pretending around it, which is why the fiddly logic is deliberately
pushed into pure functions.

- **Unit tests** for `download.ts`: MIME→extension, URL→extension, precedence
  between them, document names with and without extensions, sanitisation, and
  the same-origin/cross-origin cache-bypass rule.
- **Static-render tests**: the image bubble renders a focusable trigger with an
  accessible name; the document bubble renders both view and download
  affordances; a media-less bubble still renders its unavailable state.
- **Manual verification only**: the zoom/pan interaction and the file save.
  Neither is reachable without a DOM.

Checked in a browser against the real inbox on 2026-08-01: the thumbnail is
uncropped, the lightbox opens full-viewport, click-to-zoom reaches natural
size and lands on the clicked point, drag pans without toggling zoom off,
and the download control fires its cross-origin fetch to completion with no
failure toast. The embedded preview browser has no download manager, so the
final write to disk was not observable there.

## Out of scope

Previous/next navigation across a thread's images, pinch-zoom gestures, and
rotation.
