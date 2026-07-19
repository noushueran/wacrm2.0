/**
 * Browser-side mirror of `convex/lib/r2/url.ts`. The two are deliberately
 * separate modules rather than one shared file: the Convex side reads the
 * deployment env (`R2_PUBLIC_HOST`) and the Next.js side reads the build-time
 * public env (`NEXT_PUBLIC_R2_PUBLIC_HOST`), and Convex function modules
 * cannot import from `src/`.
 *
 * The two `resolveMediaUrl` implementations are deliberately NOT identical
 * on the "key present, host unconfigured" path:
 *
 * - Server (`convex/lib/r2/url.ts`): throws. Every server call site passes
 *   a lazy config thunk (`resolveMediaUrlLazy`) that is only invoked when a
 *   key exists, itself wrapped in a try/catch at that call site — the throw
 *   is contained and actionable there, not a crash of the whole request.
 * - Client (this module): degrades instead of throwing. This
 *   `resolveMediaUrl` runs in places where a throw is unrecoverable —
 *   inside `AuthProvider`'s render (`src/hooks/use-auth.tsx`) and inside a
 *   `useMemo` over the full message list (`src/lib/convex/adapters.ts`,
 *   consumed by `src/components/inbox/message-thread.tsx`). Throwing there
 *   doesn't fail one avatar or one message — it blanks the entire app or
 *   the entire thread the instant a single row carries a key. So when the
 *   host isn't configured, this side falls back to the legacy `row.url`
 *   (still live during the migration window) and reports the
 *   misconfiguration via `console.error` instead of throwing.
 *
 * Both sides still agree on precedence whenever a host IS configured: key
 * wins over url, and an empty-string url is treated the same as absent —
 * see `convex/lib/r2/url.test.ts` and this module's test for the shared
 * rules.
 */

function publicHost(): string | null {
  const host = process.env.NEXT_PUBLIC_R2_PUBLIC_HOST;
  return host ? host.replace(/\/+$/, "") : null;
}

function encodeKey(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}

export function mediaUrlFromKey(key: string): string | null {
  const host = publicHost();
  return host ? `${host}/${encodeKey(key)}` : null;
}

export function resolveMediaUrl(row: {
  key?: string | null;
  url?: string | null;
}): string | null {
  if (row.key) {
    const url = mediaUrlFromKey(row.key);
    if (url) return url;
    // The host isn't configured. A throw here is unrecoverable at both call
    // sites this reaches during render (see module doc comment above), so
    // degrade to the legacy url instead of blanking the app — but still
    // surface the misconfiguration loudly, since a silent fallback would
    // hide it until someone notices new media doesn't load.
    console.error(
      "NEXT_PUBLIC_R2_PUBLIC_HOST is not set — falling back to legacy media URLs. Media uploaded after the R2 cutover will not load.",
    );
    return row.url || null;
  }
  // `||`, not `??`, is deliberate: an empty-string legacy url is treated as
  // absent, matching the truthy check on `row.key` above.
  return row.url || null;
}
