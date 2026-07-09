"use client";

import { ConvexProvider, ConvexReactClient } from "convex/react";

// Module-level singleton — created once per browser tab/module load, not
// per render. Next.js App Router pattern for Client Component context
// providers: see `node_modules/next/dist/docs/01-app/01-getting-started/
// 05-server-and-client-components.md` ("Context providers"), the same
// pattern this codebase already follows for `ThemeProvider`
// (src/hooks/use-theme.tsx).
//
// Plain `ConvexProvider` only — no auth wiring here. Task 3 swaps this for
// `ConvexAuthProvider` (or wraps it) once auth is introduced.
const convex = new ConvexReactClient(process.env.NEXT_PUBLIC_CONVEX_URL!);

export function ConvexClientProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  return <ConvexProvider client={convex}>{children}</ConvexProvider>;
}
