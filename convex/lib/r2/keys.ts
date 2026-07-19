// ============================================================
// R2 object keys. The key is the ONLY ownership signal we keep for an
// object: it is minted server-side with the caller's own `ctx.accountId`
// as its first segment, so "does this account own this key" is a string
// comparison rather than a lookup table. That is why the old
// `fileOwners` table is not carried over to R2 — see the design spec.
//
// A client never supplies a key, only a filename, and the filename is
// used for its EXTENSION ONLY (basename stripped) so nothing a caller
// controls can traverse out of its own prefix.
// ============================================================

export const MEDIA_KINDS = [
  "inbound",
  "outbound",
  "template",
  "flow",
  "avatar",
  "ad",
] as const;

export type MediaKind = (typeof MEDIA_KINDS)[number];

/** Minimal MIME → extension map, covering what WhatsApp actually carries. */
const EXT_BY_CONTENT_TYPE: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "audio/ogg": "ogg",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/amr": "amr",
  "video/mp4": "mp4",
  "video/3gpp": "3gp",
  "application/pdf": "pdf",
};

/** 32 hex chars from the platform CSPRNG — the same `crypto.getRandomValues`
 *  route `convex/lib/apiKey.ts` uses, which is known-good in Convex's
 *  default runtime (`crypto.randomUUID` is not relied on). */
function defaultRandomHex(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Extension from a filename, else from a content type, else "". Never
 *  includes a dot, never longer than 5 chars, always lowercase. */
function extensionFor(filename?: string, contentType?: string): string {
  const basename = filename?.split("/").pop() ?? "";
  const dot = basename.lastIndexOf(".");
  // `> 0`, not `>= 0`: a leading-dot name like ".env" is a dotfile, not an
  // extension, and should fall through to the content-type map.
  const fromName = dot > 0 ? basename.slice(dot + 1) : "";
  const cleaned = fromName.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (cleaned && cleaned.length <= 5) return cleaned;
  const base = contentType?.split(";")[0]?.trim().toLowerCase() ?? "";
  return EXT_BY_CONTENT_TYPE[base] ?? "";
}

export function buildMediaKey(args: {
  accountId: string;
  kind: MediaKind;
  filename?: string;
  contentType?: string;
  /** Injectable for deterministic tests. */
  randomHex?: () => string;
}): string {
  const id = (args.randomHex ?? defaultRandomHex)();
  const ext = extensionFor(args.filename, args.contentType);
  return `${args.accountId}/${args.kind}/${id}${ext ? `.${ext}` : ""}`;
}

/** Inverse of the prefix portion — `null` for anything not shaped like a
 *  key this module minted. Used to enforce per-account ownership. */
export function parseMediaKey(
  key: string,
): { accountId: string; kind: MediaKind } | null {
  const parts = key.split("/");
  if (parts.length !== 3) return null;
  const [accountId, kind, object] = parts;
  if (!accountId || !object) return null;
  if (!(MEDIA_KINDS as readonly string[]).includes(kind)) return null;
  return { accountId, kind: kind as MediaKind };
}
