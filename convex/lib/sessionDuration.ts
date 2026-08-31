// Session lifetimes, in one place because two of them must agree.
//
// Convex Auth exposes two clocks that behave differently
// (see docs/superpowers/specs/2026-07-30-pwa-session-persistence-design.md):
//
//   inactiveDurationMs — the refresh token's lifetime. Re-stamped on
//     every rotation, so it SLIDES forward with use.
//   totalDurationMs    — written into the session row once at sign-in
//     and never revisited, so it is an ABSOLUTE ceiling.
//
// Net policy: open the app at least once a month and you are never
// asked to sign in; a full re-authentication is forced once a year.

const DAY_MS = 1000 * 60 * 60 * 24;

/** Sliding window — this much inactivity ends the session. */
export const SESSION_INACTIVE_DURATION_MS = 30 * DAY_MS;

/** Absolute ceiling from sign-in, however active the user is. */
export const SESSION_TOTAL_DURATION_MS = 365 * DAY_MS;

/**
 * `Max-Age` for the two Convex Auth cookies, in seconds.
 *
 * Derived — never write this as its own literal. The cookie and the
 * refresh token are stamped at the same instant on every rotation, so
 * equal lifetimes mean the cookie can neither die before the token
 * (premature logout) nor outlive it (a cookie carrying a dead token).
 */
export const SESSION_COOKIE_MAX_AGE_SECONDS =
  SESSION_INACTIVE_DURATION_MS / 1000;
