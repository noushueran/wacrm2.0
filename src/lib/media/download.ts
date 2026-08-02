/**
 * Download helpers for inbox media bubbles.
 *
 * Inbound WhatsApp media is pulled into Cloudflare R2 at ingest
 * (`convex/ingest.ts`) and read back as `${NEXT_PUBLIC_R2_PUBLIC_HOST}/${key}`
 * (`src/lib/storage/media-url.ts`) — a CROSS-ORIGIN url. Two browser rules
 * make that url impossible to save from the client alone:
 *
 *  - the `download` attribute on `<a>` is IGNORED cross-origin (the browser
 *    navigates to the file instead of saving it), and
 *  - a `fetch()` → `blob` → `createObjectURL` download needs
 *    `Access-Control-Allow-Origin` on the GET response, which the bucket's
 *    CORS policy does not promise — it covers the `PUT` upload path only
 *    (see the R2 storage design doc).
 *
 * So anything absolute is routed through the same-origin
 * `/api/media/download` endpoint, which re-serves the bytes with a
 * `Content-Disposition: attachment` header. Legacy same-origin proxy urls
 * (`/api/whatsapp/media/<id>`) need none of this and pass straight through.
 *
 * Everything here is pure and DOM-free so it unit-tests in the repo's plain
 * "node" vitest project.
 */

import type { Message } from "@/types";

/** Extension used when the stored key carries none of its own. */
const DEFAULT_EXTENSION: Record<string, string> = {
  image: "jpg",
  video: "mp4",
  audio: "ogg",
  document: "pdf",
};

/**
 * True when `url` must be routed through the download endpoint.
 *
 * A root-relative url is same-origin and needs no help. Everything else —
 * absolute, or protocol-relative — is treated as cross-origin. Routing a
 * same-origin absolute url through the endpoint anyway would still work
 * (the route allowlists its own origin), so erring this way is safe.
 */
export function isProxiedDownload(url: string): boolean {
  return !(url.startsWith("/") && !url.startsWith("//"));
}

/** The `href` a download control should point at for this media url. */
export function downloadHrefFor(url: string, filename: string): string {
  if (!isProxiedDownload(url)) return url;
  const params = new URLSearchParams({ url, name: filename });
  return `/api/media/download?${params.toString()}`;
}

/** Strip any directory component a filename may carry. */
function basename(name: string): string {
  return name.split(/[\\/]/).pop() ?? "";
}

/**
 * The extension carried by a media url's own last path segment, if any.
 * R2 keys look like `acc123/in/0123456789abcdef.jpg` (`buildMediaKey`), but
 * the extension is omitted when neither the source filename nor the content
 * type revealed one — hence the caller's per-type default.
 */
function extensionFromUrl(url: string | undefined): string | null {
  if (!url) return null;
  // Take the path only: a query string or fragment is not part of the name.
  const path = url.split(/[?#]/)[0] ?? "";
  const segment = basename(path);
  const dot = segment.lastIndexOf(".");
  // `dot > 0` skips dotfiles, where the leading dot starts the name rather
  // than an extension.
  if (dot <= 0) return null;
  const ext = segment.slice(dot + 1);
  return /^[a-z0-9]{1,5}$/i.test(ext) ? ext.toLowerCase() : null;
}

/** `YYYY-MM-DD` for the day the message arrived. */
function datePart(createdAt: string): string {
  if (/^\d{4}-\d{2}-\d{2}/.test(createdAt)) return createdAt.slice(0, 10);
  const parsed = new Date(createdAt);
  return Number.isNaN(parsed.getTime())
    ? "unknown-date"
    : parsed.toISOString().slice(0, 10);
}

/**
 * A human-readable filename for a media message.
 *
 * Documents keep the label the sender gave them — the bubble already renders
 * it as the file's name, so saving under a different one would be a surprise.
 * Everything else gets `whatsapp-<type>-<date>.<ext>`, which beats the raw R2
 * key: that is a 32-char hex blob and tells the agent nothing in their
 * Downloads folder.
 */
export function filenameFor(message: Message): string {
  const type = message.content_type;
  const ext = extensionFromUrl(message.media_url) ?? DEFAULT_EXTENSION[type] ?? "bin";

  if (type === "document" && message.content_text?.trim()) {
    // Customer-controlled: it arrives on the inbound WhatsApp payload, so a
    // path in it must never steer where the browser writes. The route
    // sanitises again — this is the first of the two passes.
    const named = basename(message.content_text.trim());
    if (named) return named;
  }

  return `whatsapp-${type}-${datePart(message.created_at)}.${ext}`;
}
