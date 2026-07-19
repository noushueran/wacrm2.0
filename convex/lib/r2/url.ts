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

/**
 * Same contract as `resolveMediaUrl`, but takes a config THUNK instead of
 * an already-built `R2Config`, and only calls it when `row.key` is
 * present.
 *
 * `resolveMediaUrl` needs a fully-built `R2Config` as its first argument
 * even on the "no key, fall back to url" branch where the config is never
 * actually read — so any caller that builds the config eagerly (e.g.
 * `resolveMediaUrl(r2ConfigFromEnv(), row)`) pays `r2ConfigFromEnv()`'s
 * throw-when-unset cost (`config.ts:31-34`) on EVERY row, including the
 * legacy-url-only rows that are the entire fleet today (Task 5 ships
 * before Task 6/7 write a single key). That would turn "R2 isn't
 * configured yet" into "media sends throw" on every hot path that reads a
 * media row — `send.ts`, `apiV1.ts`, `flowsEngine.ts`, `aiReply.ts` — and
 * in the test suite, which doesn't set R2 env vars for most suites.
 *
 * Gating on `row.key` (rather than e.g. try/catching `getConfig()`
 * unconditionally) mirrors exactly what `resolveMediaUrl` itself already
 * does internally, and what the client-side mirror
 * (`src/lib/storage/media-url.ts`'s `resolveMediaUrl`) gets for free
 * because IT calls `publicHost()` lazily from inside its own `if
 * (row.key)` branch. The server side can't get that for free because
 * `R2Config` is a plain argument, not something this function can defer
 * building itself — hence this wrapper.
 *
 * A key present with R2 unconfigured is left to throw (not swallowed):
 * by the time any row carries a key, R2 is expected to be configured, and
 * a loud throw is `r2ConfigFromEnv`'s own designed behavior for that
 * operator error.
 */
export function resolveMediaUrlLazy(
  getConfig: () => R2Config,
  row: { key?: string | null; url?: string | null },
): string | null {
  if (!row.key) return row.url || null;
  return resolveMediaUrl(getConfig(), row);
}
