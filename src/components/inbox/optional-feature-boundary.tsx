"use client";

import { Component } from "react";
import type { ReactNode } from "react";

/**
 * Renders `null` instead of taking the route down when the subtree it
 * wraps throws while rendering.
 *
 * Why this exists: `useQuery` — both `convex/react`'s and the cached
 * variant this app uses (`convex-helpers/react/cache/hooks`, which ends
 * `if (result instanceof Error) throw result;`) — RETHROWS a query error
 * during render. "Could not find public function" is such an error, so a
 * frontend deployed ahead of `npx convex deploy` doesn't degrade: it
 * throws on every render of every component subscribing to the missing
 * function. Netlify builds the frontend from `main` automatically while
 * Convex is deployed separately, so that window is real, and there is no
 * `error.tsx` under `src/app` to stop it — one absent function would take
 * the entire Inbox route down rather than hiding one supplementary panel.
 *
 * A class boundary is the only thing that can catch a render-time throw
 * (a `try`/`catch` around the hook would make `eslint-plugin-react-hooks`
 * flag a conditional hook call — the same reasoning
 * `DeepLinkFallbackBoundary` in `src/app/(dashboard)/inbox/page.tsx`
 * records, and this is that pattern reused).
 *
 * **Wrap only a component whose ONLY job is the optional feature** —
 * every hook runs in the component that calls it, so the throw happens in
 * the subscriber's own render, not in whatever JSX it later returns.
 * Wrapping a chunk of markup inside the subscriber would catch nothing.
 * Keeping the wrapped subtree that narrow is also what makes catching any
 * error unconditionally safe here: nothing else lives inside, so a
 * genuine bug elsewhere still surfaces normally.
 *
 * `componentDidCatch` logs, so a real post-deploy failure is visible in
 * the console rather than silently swallowed.
 */
export class OptionalFeatureBoundary extends Component<
  { feature: string; children: ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: unknown) {
    const message = `[inbox] optional feature "${this.props.feature}" is unavailable — rendering without it`;
    // Error level in production: a missing function there is a real
    // deploy-ordering bug and should be loud. Warn in development, where
    // the expected state before `npx convex deploy` is exactly this, and
    // where `console.error` additionally trips Next's dev overlay — which
    // reports a caught, survivable degradation as though the page had
    // crashed. The log itself never disappears; only its severity moves.
    if (process.env.NODE_ENV === "development") console.warn(message, error);
    else console.error(message, error);
  }

  render() {
    if (this.state.hasError) return null;
    return this.props.children;
  }
}
