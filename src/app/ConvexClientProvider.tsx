"use client";

import { ConvexAuthNextjsProvider } from "@convex-dev/auth/nextjs";
import { ConvexReactClient } from "convex/react";
import { ConvexQueryCacheProvider } from "convex-helpers/react/cache/provider";

// Module-level singleton — created once per browser tab/module load, not
// per render. Next.js App Router pattern for Client Component context
// providers: see `node_modules/next/dist/docs/01-app/01-getting-started/
// 05-server-and-client-components.md` ("Context providers"), the same
// pattern this codebase already follows for `ThemeProvider`
// (src/hooks/use-theme.tsx).
//
// `ConvexAuthNextjsProvider` (from `@convex-dev/auth/nextjs`) is the
// Next.js-SSR-aware client provider — it renders `ConvexProviderWithAuth`
// wired to the auth-token context that `ConvexAuthNextjsServerProvider`
// (mounted in `src/app/layout.tsx`) establishes from the request cookies.
// That cookie handshake is what `src/middleware.ts`'s
// `convexAuthNextjsMiddleware` reads to gate protected routes, so the
// plain `ConvexAuthProvider` (from `@convex-dev/auth/react`) is NOT
// interchangeable here — the middleware would never see the session.
// It still makes `Authenticated`/`Unauthenticated`/`AuthLoading` (from
// `convex/react`) and `useAuthActions`/`useConvexAuth` work everywhere
// below it, so `/convex-demo` and `useAuth` (src/hooks/use-auth.tsx) are
// unaffected by the swap.
//
// The `|| <placeholder>` guard keeps a missing `NEXT_PUBLIC_CONVEX_URL`
// from throwing at module load — the old `!` non-null assertion turned
// an unset var into a hard `new ConvexReactClient(undefined)` crash that
// white-screened the entire app before anything rendered. With the
// fallback the client just fails to connect (no data) instead of taking
// down the whole tree. Construction is lazy — no socket opens until the
// first subscription — so a placeholder URL is inert during SSR/build.
const convex = new ConvexReactClient(
  process.env.NEXT_PUBLIC_CONVEX_URL || "https://placeholder.convex.cloud",
);

export function ConvexClientProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <ConvexAuthNextjsProvider client={convex}>
      {/*
        `ConvexQueryCacheProvider` keeps each `useQuery` /
        `usePaginatedQuery` subscription (the cached variants from
        `@/lib/convex/cached`) alive for a few minutes AFTER the
        component using it unmounts, instead of tearing it down
        immediately. That's what makes navigating back to an
        already-visited section (Inbox, Contacts, Dashboard, …) render
        its last data instantly rather than re-fetching from scratch —
        every fresh fetch is a full round-trip to the self-hosted Convex
        backend, which is the bulk of the per-section load time.

        It must sit UNDER `ConvexAuthNextjsProvider` (which supplies the
        `ConvexProvider` the cache reads via `useConvex()`) and ABOVE the
        app tree so every page shares one cache. Idle subscriptions still
        cost an open reactive subscription on the backend, so the
        defaults are deliberately bounded (`expiration` 5 min,
        `maxIdleEntries` 250) — plenty to cover normal back-and-forth
        navigation without leaking subscriptions unboundedly.
      */}
      <ConvexQueryCacheProvider>{children}</ConvexQueryCacheProvider>
    </ConvexAuthNextjsProvider>
  );
}
