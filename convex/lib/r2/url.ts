import type { R2Config } from "./config";

// ============================================================
// Key → public URL. Objects are served from the R2 custom domain
// (`objs.holidayys.co`), NOT the S3 API endpoint and NOT `r2.dev`
// (Cloudflare rate-limits `r2.dev` and documents it as development-only;
// Meta and OpenAI both fetch these URLs server-side).
//
// `resolveMediaUrl` is the migration seam: rows written before the R2
// cutover carry only a legacy Convex-storage URL, rows written after
// carry a key, and rows touched by the Plan 2 backfill carry both. Key
// wins whenever present, so the backfill can run without a flag day.
// ============================================================

/** Percent-encode each path segment, preserving the `/` separators. */
function encodeKey(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}

export function publicUrl(cfg: R2Config, key: string): string {
  // Normalized here as well as in `r2ConfigFromEnv` — this module's parity
  // with `src/lib/storage/media-url.ts` must hold for ANY `R2Config`, not
  // only one built through that helper. R2 does not collapse `//`.
  const host = cfg.publicHost.replace(/\/+$/, "");
  return `${host}/${encodeKey(key)}`;
}

export function resolveMediaUrl(
  cfg: R2Config,
  row: { key?: string | null; url?: string | null },
): string | null {
  if (row.key) return publicUrl(cfg, row.key);
  // `||`, not `??`, is deliberate: an empty-string legacy url is treated as
  // absent, matching the truthy check on `row.key` above.
  return row.url || null;
}
