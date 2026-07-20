// ============================================================
// Fixed-window burst budget for AI auto-replies.
//
// Pure arithmetic, no Convex imports — the mutation that uses it
// (`aiReply.claimAutoReplySlot`) just reads the account's row, calls
// `claimSlot`, and writes the result back.
//
// `RATE_LIMITS.aiAutoReplyAccount` in src/lib/rate-limit.ts declares the
// same 30/min budget for the Next.js side, but that module cannot be
// imported here: it pulls in `next/server`, which Convex's runtime has no
// module for. The two are pinned to each other by a test in
// aiRateLimit.test.ts instead.
//
// PACE, NEVER DROP. `rate-limit.ts`'s own comment says excess inbounds
// "simply don't get an auto-reply" — that predates the owner's 2026-07-18
// decision that the bot answers every message until a human takes over
// (see `aiConfigs.autoReplyMaxPerConversation` in schema.ts). So a refusal
// here is a "come back in N ms", never a "skip this reply", and
// `retryAfterMs` is always > 0 so a deferral cannot busy-loop the
// scheduler. Pacing is also better for delivery than doing nothing:
// tripping the provider's own 429 fails the reply outright, whereas
// waiting out the window just moves it a few seconds.
// ============================================================

/** Auto-replies allowed per account per window. Mirrors
 *  `RATE_LIMITS.aiAutoReplyAccount.limit`. */
export const AUTO_REPLY_LIMIT = 30;

/** Window length. Mirrors `RATE_LIMITS.aiAutoReplyAccount.windowMs`. */
export const AUTO_REPLY_WINDOW_MS = 60_000;

/** The persisted counter, one row per account (`aiAutoReplyRate`). */
export type RateWindow = { windowStartMs: number; count: number };

export type ClaimDecision =
  /** A slot was taken; persist `next`. */
  | { allowed: true; next: RateWindow }
  /** Window is full; re-schedule the dispatch this far out. Always > 0. */
  | { allowed: false; retryAfterMs: number };

/**
 * Decide whether an auto-reply may proceed now.
 *
 * @param current the account's stored window, or null if it has never
 *   auto-replied (first call opens a window).
 * @param nowMs   wall clock, passed in rather than read so the arithmetic
 *   stays pure and testable without fake timers.
 */
export function claimSlot(
  current: RateWindow | null,
  nowMs: number,
): ClaimDecision {
  const elapsed = current ? nowMs - current.windowStartMs : Infinity;

  // No window yet, or the old one has run its course — open a fresh one.
  // `>=` (not `>`) so a call landing exactly on the boundary starts the
  // new window rather than being refused by the expired one.
  if (!current || elapsed >= AUTO_REPLY_WINDOW_MS) {
    return { allowed: true, next: { windowStartMs: nowMs, count: 1 } };
  }

  if (current.count < AUTO_REPLY_LIMIT) {
    // Window start deliberately unchanged: moving it on every claim would
    // make this a sliding window that a steady stream could hold open
    // forever, so the budget would never reset.
    return {
      allowed: true,
      next: { windowStartMs: current.windowStartMs, count: current.count + 1 },
    };
  }

  // Full. Wait out the remainder of the window. `Math.max(1, …)` because
  // the branch above already guarantees elapsed < AUTO_REPLY_WINDOW_MS, so
  // the remainder is >= 1ms — the clamp is a belt-and-braces guard that a
  // deferral always moves time forward.
  return {
    allowed: false,
    retryAfterMs: Math.max(1, AUTO_REPLY_WINDOW_MS - elapsed),
  };
}
