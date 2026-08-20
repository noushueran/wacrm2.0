import { format } from "date-fns";

/**
 * Saving inbox media to disk.
 *
 * The whole reason this module exists rather than an `<a download>` in the
 * bubble: **the `download` attribute is silently ignored for cross-origin
 * URLs.** Media is served from the R2 custom domain
 * (the R2 public host, see `convex/lib/r2/url.ts`), so a plain anchor
 * would navigate to the image instead of saving it — which is exactly the
 * "I can't download it" symptom this replaces.
 *
 * The path that does work is fetch → `blob()` → object URL → synthetic
 * anchor → revoke, and that fetch needs CORS on the media host. R2 sends
 * `access-control-allow-origin: <this deployment's origin>`, so it works in
 * production. That allow-list is a single origin, so the fetch FAILS from
 * `localhost` — callers must handle the rejection, and
 * `use-media-download.ts` does, by offering an open-in-a-tab escape hatch.
 *
 * Filename derivation is kept pure here (no DOM, no i18n) because this repo
 * has no jsdom: pure is the only shape these decisions can be tested in.
 */

export type MediaKind = "image" | "video" | "document";

/** Only the types WhatsApp actually delivers — an open-ended map would be
 *  a guess. Anything unlisted falls through to the URL's own extension. */
const MIME_EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "video/mp4": "mp4",
  "video/3gpp": "3gp",
  "video/quicktime": "mov",
  "audio/mpeg": "mp3",
  "audio/ogg": "ogg",
  "audio/amr": "amr",
  "application/pdf": "pdf",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    "docx",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.ms-powerpoint": "ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation":
    "pptx",
  "text/plain": "txt",
  "text/csv": "csv",
};

const DEFAULT_EXTENSION: Record<MediaKind, string> = {
  image: "jpg",
  video: "mp4",
  // No honest default for an arbitrary document, and inventing `.pdf`
  // would mislabel the file. This only fires when the message carries
  // neither a filename nor a Content-Type, which is vanishingly rare.
  document: "bin",
};

/** A plausible extension: 1–5 alphanumerics. Long enough for `xlsx`,
 *  short enough that `v1.2/` and `.verylongsuffix` are not mistaken for
 *  one. */
const EXTENSION_PATTERN = /\.([a-z0-9]{1,5})$/i;

/** Characters no filesystem (or at least not Windows) will accept, plus
 *  the separators that would let a hostile name climb out of the download
 *  directory. Spaces are deliberately NOT in this set — `Dubai
 *  Itinerary.pdf` is a perfectly good filename. */
const ILLEGAL_FILENAME_CHARS = /[\\/:*?"<>|\x00-\x1f]/g;

export function extensionFromMime(mime: string | null | undefined): string | null {
  if (!mime) return null;
  // `blob.type` arrives as e.g. `image/jpeg; charset=binary`.
  const base = mime.split(";")[0]!.trim().toLowerCase();
  return MIME_EXTENSIONS[base] ?? null;
}

export function extensionFromUrl(url: string): string | null {
  if (!url) return null;
  let pathname: string;
  try {
    // A base makes this work for the relative proxy path
    // (`/api/whatsapp/media/<id>`) as well as absolute R2 URLs. The base
    // is never read back out.
    pathname = new URL(url, "http://localhost").pathname;
  } catch {
    return null;
  }
  const lastSegment = pathname.split("/").pop() ?? "";
  const match = EXTENSION_PATTERN.exec(decodeURIComponent(lastSegment));
  return match ? match[1]!.toLowerCase() : null;
}

/** Make an arbitrary string safe to hand to a browser's save dialog.
 *  Returns `""` when nothing usable survives — callers fall back to a
 *  generated name rather than saving something called `-`. */
export function sanitizeFilename(name: string): string {
  return name
    .trim()
    .replace(ILLEGAL_FILENAME_CHARS, "-")
    .replace(/-{2,}/g, "-")
    // Leading dots would hide the file on Unix; leading/trailing dashes
    // are just debris from the replacement above. `../../etc/passwd`
    // becomes `etc-passwd` here.
    .replace(/^[.\-]+/, "")
    .replace(/[.\-]+$/, "");
}

export function mediaFilename({
  kind,
  createdAt,
  url,
  mime,
  documentName,
}: {
  kind: MediaKind;
  createdAt: number | string;
  url: string;
  mime?: string | null;
  /** A document's own filename, which WhatsApp puts in `content_text`. */
  documentName?: string | null;
}): string {
  const extension =
    extensionFromMime(mime) ?? extensionFromUrl(url) ?? DEFAULT_EXTENSION[kind];

  if (kind === "document" && documentName) {
    const safe = sanitizeFilename(documentName);
    if (safe) {
      // Respect the sender's own extension when they gave one — it
      // describes the file better than anything derived here.
      return EXTENSION_PATTERN.test(safe) ? safe : `${safe}.${extension}`;
    }
  }

  const stamp = format(new Date(createdAt), "yyyy-MM-dd-HHmm");
  return `amani-${kind}-${stamp}.${extension}`;
}

/**
 * Whether fetching `url` from a page at `pageHref` must bypass the HTTP
 * cache. True for cross-origin URLs only — see `fetchMediaBlob`.
 *
 * Takes the page location as an argument rather than reading `window` so
 * the rule can be tested: this repo has no jsdom, and this decision is the
 * difference between download working and failing every time.
 */
export function needsCacheBypass(url: string, pageHref: string): boolean {
  try {
    const page = new URL(pageHref);
    return new URL(url, page).origin !== page.origin;
  } catch {
    return false;
  }
}

/**
 * Fetch media as a blob.
 *
 * `cache: "reload"` on the cross-origin path is load-bearing, not
 * belt-and-braces. The bubble has ALREADY displayed this URL through an
 * `<img>`, which — having no `crossorigin` attribute — is fetched in
 * no-cors mode and stored in the HTTP cache as an **opaque** response.
 * A later `fetch(url)` in cors mode reuses that cache entry, finds no
 * usable `Access-Control-Allow-Origin` on it, and rejects with a bare
 * "Failed to fetch" — even though the server returns perfectly good CORS
 * headers. Since the image is always on screen before anyone clicks
 * download, the poisoned entry is the normal case, not the edge case:
 * without this, downloading a visible image fails every single time.
 *
 * `reload` bypasses that entry, revalidates against the network, and
 * repairs the cache. Same-origin proxy URLs are exempt — they have no
 * CORS problem to solve, and forcing a reload there would re-run the
 * authenticated Meta round-trip behind
 * `src/app/api/whatsapp/media/[mediaId]/route.ts`.
 *
 * Adding `crossorigin="anonymous"` to the `<img>` would fix the caching
 * at source, but it would also make DISPLAY depend on CORS — any legacy
 * media host without it would stop rendering images entirely. Paying one
 * re-download on an explicit click is the cheaper trade.
 */
export async function fetchMediaBlob(url: string): Promise<Blob> {
  const response = await fetch(
    url,
    needsCacheBypass(url, window.location.href) ? { cache: "reload" } : undefined,
  );
  if (!response.ok) {
    throw new Error(`Media fetch failed with ${response.status}`);
  }
  return response.blob();
}

/** Hand a blob to the browser's save dialog under a chosen name. */
export function triggerBlobDownload(blob: Blob, filename: string): void {
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = filename;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Revoking synchronously can cancel the download in Chrome — the click
  // is queued, not completed, by the time this line runs.
  setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
}
