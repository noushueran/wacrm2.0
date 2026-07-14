// Pure helper for the Click-to-WhatsApp 72h free-entry-point window.
// Dependency-free (no React/Convex) so it's unit-testable and shared,
// same convention as `./view.ts`.

/** The free-entry-point window Meta grants an ad lead: 72 hours. Within it
 *  all messages (incl. templates) are free of charge. NOTE: this window is
 *  about COST only — it does NOT extend the 24h free-form messaging window,
 *  which is enforced separately (`sessionExpired`). */
export const AD_FREE_WINDOW_MS = 72 * 60 * 60 * 1000;

/** Milliseconds remaining in the 72h free window, anchored to when the ad
 *  conversation started. 0 once elapsed. */
export function adFreeWindowRemainingMs(
  startedAtMs: number,
  nowMs: number,
): number {
  return Math.max(0, startedAtMs + AD_FREE_WINDOW_MS - nowMs);
}
