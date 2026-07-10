import { ConvexError } from "convex/values";

export type AuthFlow = "signIn" | "signUp";

// Convex Auth's Password provider throws PLAIN `Error`s (not `ConvexError`s)
// for credential failures — `InvalidSecret` (wrong password) and
// `InvalidAccountId` (no such account). Their `.message` must NEVER reach the
// user: on a self-hosted dev deployment it's a full stack trace (internal
// file paths + line numbers), and on a production deployment Convex sanitizes
// it to an opaque "[Request ID: …] Server Error". Neither is meaningful — and
// the dev shape leaks implementation details. Match the signature instead.
const CREDENTIAL_ERROR = /InvalidSecret|InvalidAccountId|InvalidAccount\b/i;

/**
 * Turn any error thrown by the auth flow into a safe, user-facing string.
 *
 * - Our OWN intentional errors (e.g. the password-length rule in
 *   `convex/auth.ts`) are thrown as `ConvexError` with a string payload,
 *   which survives the client boundary intact — show those verbatim.
 * - Convex Auth's credential failures are collapsed to a single generic
 *   message per flow (sign-in vs sign-up), never revealing whether an email
 *   is registered and never leaking the raw server error / stack trace.
 * - Everything else (structured `ConvexError`, sanitized server error,
 *   network failure, non-Error values) falls back to a safe generic.
 */
export function authErrorMessage(
  err: unknown,
  flow: AuthFlow = "signIn",
): string {
  if (err instanceof ConvexError && typeof err.data === "string") {
    return err.data;
  }

  const raw = err instanceof Error ? err.message : String(err ?? "");

  if (CREDENTIAL_ERROR.test(raw)) {
    return flow === "signUp"
      ? "An account with this email already exists. Try signing in instead."
      : "Invalid email or password.";
  }

  return "Something went wrong. Please try again.";
}
