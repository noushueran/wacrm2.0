// ============================================================
// Password policy for the `Password` provider (`convex/auth.ts`).
//
// Why this exists as its own module: the policy needs unit tests, and
// `validatePasswordRequirements` is otherwise an anonymous callback
// buried in the `convexAuth({...})` config object where no test can
// reach it.
//
// Threat model — read this before tuning the numbers.
// ---------------------------------------------------
// Convex Auth already rate-limits FAILED sign-ins to 10 per hour per
// account by default, refilling continuously and resetting on success
// (`@convex-dev/auth/dist/server/implementation/rateLimit.js`, reached
// from the password path in `retrieveAccountWithCredentials.js`).
// `convex/auth.ts` now pins that number explicitly rather than
// inheriting the default.
//
// That cap makes online brute force impractical — but ONLY against a
// password that survives the first handful of guesses. An attacker with
// 10 attempts/hour spends them on `password1`, `qwerty123`,
// `<something>2026`, not on random strings. So the job of this module is
// narrow and specific: make sure a password cannot be in that first
// handful. It is NOT trying to enforce "complexity theatre" (forced
// symbol/digit/case classes), which NIST SP 800-63B explicitly
// recommends against because it pushes users toward predictable
// mutations like `Password1!`.
//
// NIST's actual guidance — an 8-character minimum IS acceptable provided
// candidates are screened against known-common/breached passwords — is
// what this implements: keep the existing 8-character floor (raising it
// would invalidate nothing for existing users, since this runs only on
// sign-up and reset, but adds friction without addressing the real
// risk) and add the screening that was missing.
//
// The list below is deliberately SMALL. It is not a breach corpus and
// is not trying to be — a serious deployment should screen against Have
// I Been Pwned's k-anonymity range API. It covers the passwords that
// would plausibly be tried inside a 10-guess-per-hour budget, which is
// the exact gap the rate limiter leaves open.
// ============================================================

/** Minimum length. See this module's header for why it stays at 8. */
export const MIN_PASSWORD_LENGTH = 8;

/**
 * Common passwords, lowercased. Chosen for "would a human or a script
 * try this in its first ten guesses", not for corpus completeness.
 * Entries shorter than 8 characters are still worth listing: the length
 * check runs first, but keeping them documents intent and costs nothing.
 */
const COMMON_PASSWORDS = new Set([
  "password",
  "password1",
  "password12",
  "password123",
  "password1234",
  "passw0rd",
  "p@ssword",
  "p@ssw0rd",
  "12345678",
  "123456789",
  "1234567890",
  "123123123",
  "111111111",
  "qwerty123",
  "qwertyui",
  "qwerty123456",
  "1q2w3e4r",
  "1qaz2wsx",
  "zaq12wsx",
  "asdfghjk",
  "asdfghjkl",
  "iloveyou",
  "princess",
  "sunshine",
  "football",
  "baseball",
  "basketball",
  "superman",
  "batman123",
  "trustno1",
  "letmein1",
  "letmein123",
  "welcome1",
  "welcome123",
  "admin123",
  "administrator",
  "root1234",
  "monkey123",
  "dragon123",
  "master123",
  "shadow123",
  "michael1",
  "jennifer",
  "jordan23",
  "hello123",
  "abc12345",
  "abcd1234",
  "a1b2c3d4",
  "changeme",
  "changeme123",
  "secret123",
  "temp1234",
  "test1234",
  "testtest",
  "whatsapp",
  "whatsapp123",
  "amani123",
  "amani1234",
]);

/** Longest run of sequential characters (forward or backward) in `s`. */
function longestSequentialRun(s: string): number {
  let best = 1;
  let forward = 1;
  let backward = 1;
  for (let i = 1; i < s.length; i++) {
    const delta = s.charCodeAt(i) - s.charCodeAt(i - 1);
    forward = delta === 1 ? forward + 1 : 1;
    backward = delta === -1 ? backward + 1 : 1;
    best = Math.max(best, forward, backward);
  }
  return best;
}

/** True if every character in `s` is the same one. */
function isSingleRepeatedChar(s: string): boolean {
  return s.length > 0 && [...s].every((c) => c === s[0]);
}

/**
 * The failure reason for a rejected password, or `null` if it passes.
 * Returned rather than thrown so this stays a pure function; the
 * provider callback in `convex/auth.ts` turns a non-null result into
 * the `ConvexError` the sign-up form renders.
 *
 * Messages are written to be shown verbatim to the user.
 */
export function passwordRejectionReason(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }

  const normalized = password.toLowerCase();

  if (COMMON_PASSWORDS.has(normalized)) {
    return "That password is too common — please choose something less guessable.";
  }

  if (isSingleRepeatedChar(password)) {
    return "Password cannot be a single repeated character.";
  }

  // "12345678", "abcdefgh", "87654321" — trivially enumerable despite
  // clearing the length floor. Anything at or above the floor that is
  // ENTIRELY one run is rejected.
  if (longestSequentialRun(normalized) >= MIN_PASSWORD_LENGTH) {
    return "Password cannot be a sequence of consecutive characters.";
  }

  return null;
}
