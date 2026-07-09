"use client";

import { ConvexAuthProvider } from "@convex-dev/auth/react";
import { ConvexReactClient } from "convex/react";

// Module-level singleton — created once per browser tab/module load, not
// per render. Next.js App Router pattern for Client Component context
// providers: see `node_modules/next/dist/docs/01-app/01-getting-started/
// 05-server-and-client-components.md` ("Context providers"), the same
// pattern this codebase already follows for `ThemeProvider`
// (src/hooks/use-theme.tsx).
//
// `ConvexAuthProvider` wraps `ConvexProviderWithAuth` internally (see
// `@convex-dev/auth/react`'s `index.js`), so it's a drop-in replacement
// for the plain `ConvexProvider` that also makes `Authenticated`/
// `Unauthenticated`/`AuthLoading` (from `convex/react`) and
// `useAuthActions`/`useConvexAuth` (from `@convex-dev/auth/react`) work
// anywhere under this provider. Existing Supabase-authed pages don't
// import any of these, so they're unaffected — see `/convex-demo`
// (src/app/convex-demo/page.tsx) for the first consumer.
const convex = new ConvexReactClient(process.env.NEXT_PUBLIC_CONVEX_URL!);

export function ConvexClientProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  return <ConvexAuthProvider client={convex}>{children}</ConvexAuthProvider>;
}
