"use client";

import { ConvexAuthNextjsProvider } from "@convex-dev/auth/nextjs";
import { ConvexReactClient } from "convex/react";

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
      {children}
    </ConvexAuthNextjsProvider>
  );
}
