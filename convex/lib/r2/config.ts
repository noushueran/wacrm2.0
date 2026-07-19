// ============================================================
// R2 connection settings, read from Convex deployment env vars. Kept
// separate from `client.ts` so the signing code takes an explicit
// config argument and stays trivially testable without env mutation.
//
// Secrets live only in the deployment's env (set by the owner via
// `npx convex env set`) — never in the repo. See the design spec at
// docs/superpowers/specs/2026-07-19-cloudflare-r2-media-storage-design.md
// ============================================================

export interface R2Config {
  bucket: string;
  /** S3 API endpoint, no trailing slash, no bucket segment. */
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Public custom domain objects are served from, no trailing slash. */
  publicHost: string;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set on this Convex deployment — R2 media storage is misconfigured.`,
    );
  }
  return value.replace(/\/+$/, "");
}

/**
 * Throws (rather than returning null) when unset: a missing R2 config is
 * an operator error, and callers are all best-effort-wrapped already, so
 * a loud throw surfaces in logs without taking a message path down.
 */
export function r2ConfigFromEnv(): R2Config {
  return {
    bucket: required("R2_BUCKET"),
    endpoint: required("R2_ENDPOINT"),
    accessKeyId: required("R2_ACCESS_KEY_ID"),
    secretAccessKey: required("R2_SECRET_ACCESS_KEY"),
    publicHost: required("R2_PUBLIC_HOST"),
  };
}
