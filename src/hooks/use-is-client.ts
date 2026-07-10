"use client";

import { useSyncExternalStore } from "react";

// Returns `false` during SSR and the first hydration render, then `true`
// once mounted — the sanctioned (warning-free, no setState-in-effect) way
// to diverge server vs client. Render the server-safe default on first
// paint, then adopt the real client-only value.
//
// Use this to gate any UI whose value is known only on the client
// (search params, localStorage, `window`, …). Because `getServerSnapshot`
// returns `false`, the SERVER output stays invariant to that value, so a
// CDN can safely cache one variant and the client's first render always
// matches it — no React hydration mismatch (#418).
//
// (This is the same primitive `themed-toaster.tsx` uses to defer the
// light/dark mode; centralised here so both callers share one copy.)
const noopSubscribe = () => () => {};

export function useIsClient(): boolean {
  return useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );
}
