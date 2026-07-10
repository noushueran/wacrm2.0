// ============================================================
// Server-side Convex client — the `ConvexHttpClient` counterpart to
// `src/app/ConvexClientProvider.tsx`'s `ConvexReactClient`, for Next.js
// server code that needs a one-shot Convex call rather than a live
// subscription. Used by `src/lib/auth/api-context.ts`'s `requireApiKey`
// (the `/api/v1/*` auth path) and `src/lib/api/v1/*.ts`'s data helpers
// (the `/api/v1/*` data path) — the public REST API's two Next.js
// server surfaces that talk to Convex over plain HTTP instead of
// through a React hook.
//
// `ConvexHttpClient` has no React lifecycle (unlike `ConvexReactClient`,
// a browser-persistent singleton per tab): each call is its own HTTP
// request, so ONE module-level instance is safe to share across
// concurrent requests in the same server process — mirrors
// `ConvexClientProvider.tsx`'s own module-level singleton, minus the
// per-tab concern that motivates that file's specific provider choice.
// ============================================================

import { ConvexHttpClient } from 'convex/browser';

let client: ConvexHttpClient | null = null;

/**
 * Lazily-constructed singleton `ConvexHttpClient`, pointed at the same
 * deployment `NEXT_PUBLIC_CONVEX_URL` the browser client uses. A
 * function (not a bare module-level constant) so tests can
 * `vi.mock('@/lib/convex/server-client')` and swap in a fake client
 * without ever needing a real URL configured.
 */
export function getConvexClient(): ConvexHttpClient {
  if (!client) {
    const url = process.env.NEXT_PUBLIC_CONVEX_URL;
    if (!url) {
      throw new Error(
        'NEXT_PUBLIC_CONVEX_URL environment variable is not set.'
      );
    }
    client = new ConvexHttpClient(url);
  }
  return client;
}
