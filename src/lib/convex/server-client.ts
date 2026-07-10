// ============================================================
// Server-side Convex client — the `ConvexHttpClient` counterpart to
// `src/app/ConvexClientProvider.tsx`'s `ConvexReactClient`, for Next.js
// server code that needs a one-shot Convex call rather than a live
// subscription. Used by `src/lib/auth/api-context.ts`'s `requireApiKey`
// (the `/api/v1/*` auth path) and every `/api/v1/*` route (the data
// path) — the public REST API's two Next.js server surfaces that talk
// to Convex over plain HTTP instead of through a React hook.
//
// `ConvexHttpClient` has no React lifecycle (unlike `ConvexReactClient`,
// a browser-persistent singleton per tab): each call is its own HTTP
// request, so ONE module-level instance is safe to share across
// concurrent requests in the same server process — mirrors
// `ConvexClientProvider.tsx`'s own module-level singleton, minus the
// per-tab concern that motivates that file's specific provider choice.
//
// Also re-exports `api` (typed Convex function references) from this
// one `@/lib/...`-aliased module, so the 11 `/api/v1/*` route files
// don't each need their own fragile `../../../../../convex/_generated/
// api` relative path (the depth differs per route file, e.g.
// `contacts/route.ts` vs `contacts/[id]/route.ts` vs `conversations/
// [id]/messages/route.ts`) — one correct relative import here, reused
// everywhere via the `@/*` alias.
// ============================================================

import { ConvexHttpClient } from 'convex/browser';

export { api } from '../../../convex/_generated/api';
export type { Id } from '../../../convex/_generated/dataModel';

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
