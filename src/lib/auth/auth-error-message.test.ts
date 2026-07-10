import { describe, expect, it } from "vitest";
import { ConvexError } from "convex/values";
import { authErrorMessage } from "./auth-error-message";

describe("authErrorMessage", () => {
  it("shows a ConvexError string payload verbatim (our own intentional messages)", () => {
    // e.g. the password-length rule in convex/auth.ts throws exactly this.
    expect(
      authErrorMessage(new ConvexError("Password must be at least 8 characters.")),
    ).toBe("Password must be at least 8 characters.");
  });

  it("maps a wrong-password sign-in (InvalidSecret) to a friendly credential message", () => {
    expect(authErrorMessage(new Error("InvalidSecret"), "signIn")).toBe(
      "Invalid email or password.",
    );
  });

  it("maps a no-such-account sign-in (InvalidAccountId) to the SAME message (no user enumeration)", () => {
    expect(authErrorMessage(new Error("InvalidAccountId"), "signIn")).toBe(
      "Invalid email or password.",
    );
  });

  it("never leaks a dev stack trace — a wrapped InvalidSecret still maps to the friendly message", () => {
    // This is the exact shape a self-hosted dev deployment surfaces.
    const devError = new Error(
      "[Request ID: 1d343f1fb30c75c9] Server Error Uncaught Error: InvalidSecret " +
        "at retrieveAccount (../../node_modules/@convex-dev/auth/src/server/implementation/index.ts:602:9)",
    );
    const msg = authErrorMessage(devError, "signIn");
    expect(msg).toBe("Invalid email or password.");
    expect(msg).not.toMatch(/node_modules|retrieveAccount|Request ID/);
  });

  it("tells a signing-up user the email is already taken (InvalidSecret on signUp)", () => {
    expect(authErrorMessage(new Error("InvalidSecret"), "signUp")).toBe(
      "An account with this email already exists. Try signing in instead.",
    );
  });

  it("falls back to a safe generic message for unknown errors, never the raw text", () => {
    const msg = authErrorMessage(new Error("ECONNREFUSED 127.0.0.1:9999 socket hang up"));
    expect(msg).toBe("Something went wrong. Please try again.");
    expect(msg).not.toMatch(/ECONNREFUSED/);
  });

  it("does not dump raw JSON for a structured ConvexError", () => {
    const msg = authErrorMessage(new ConvexError({ code: "NO_ACCOUNT" }));
    expect(msg).toBe("Something went wrong. Please try again.");
    expect(msg).not.toMatch(/NO_ACCOUNT|code/);
  });

  it("handles non-Error values without throwing", () => {
    expect(authErrorMessage(undefined)).toBe("Something went wrong. Please try again.");
    expect(authErrorMessage("a bare string")).toBe(
      "Something went wrong. Please try again.",
    );
  });
});
