/**
 * Browser-side mirror of `convex/lib/r2/url.ts`. The two are deliberately
 * separate modules rather than one shared file: the Convex side reads the
 * deployment env (`R2_PUBLIC_HOST`) and the Next.js side reads the build-time
 * public env (`NEXT_PUBLIC_R2_PUBLIC_HOST`), and Convex function modules
 * cannot import from `src/`. Keep the two `resolveMediaUrl` behaviors
 * identical — `convex/lib/r2/url.test.ts` and this module's test assert the
 * same precedence rules.
 */

function publicHost(): string {
  const host = process.env.NEXT_PUBLIC_R2_PUBLIC_HOST;
  if (!host) {
    throw new Error(
      "NEXT_PUBLIC_R2_PUBLIC_HOST is not set — media URLs cannot be built.",
    );
  }
  return host.replace(/\/+$/, "");
}

function encodeKey(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}

export function mediaUrlFromKey(key: string): string {
  return `${publicHost()}/${encodeKey(key)}`;
}

export function resolveMediaUrl(row: {
  key?: string | null;
  url?: string | null;
}): string | null {
  if (row.key) return mediaUrlFromKey(row.key);
  return row.url ?? null;
}
