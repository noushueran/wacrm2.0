import { describe, it, expect, vi } from "vitest";
import {
  SESSION_INACTIVE_DURATION_MS,
  SESSION_TOTAL_DURATION_MS,
  SESSION_COOKIE_MAX_AGE_SECONDS,
} from "./lib/sessionDuration";

// What this pins, and why a test that reads the CONSTANTS cannot.
//
// `convex/lib/sessionDuration.ts` has its own test, and it passed
// throughout the window in which the session clocks were not applied at
// all: a rewrite of the `convexAuth({...})` config dropped the `session:`
// key, and asserting that SESSION_TOTAL_DURATION_MS still equals 365 days
// says nothing about whether anything reads it. The constants were right;
// the wiring was gone. Convex Auth then fell back to its own default, so
// the total cap silently became ~30 days — undoing the fix that added it —
// while `src/middleware.ts` went on setting the auth cookie's `maxAge`
// from those same constants, leaving cookie and session disagreeing about
// how long a login lasts.
//
// So this asserts the CONFIG OBJECT HANDED TO THE LIBRARY, by mocking
// `convexAuth` and capturing its argument. That is the only place the
// wiring is observable without a running deployment, and it fails if the
// key is dropped, renamed or reordered out.
//
// `vi.hoisted` because `vi.mock` factories are hoisted above imports and
// cannot otherwise close over a local.
const { captured } = vi.hoisted(() => ({
  captured: {} as { config?: Record<string, unknown> },
}));

vi.mock("@convex-dev/auth/server", () => ({
  convexAuth: (config: Record<string, unknown>) => {
    captured.config = config;
    // `auth.ts` destructures these off the return value at module scope.
    return {
      auth: {},
      signIn: {},
      signOut: {},
      store: {},
      isAuthenticated: {},
    };
  },
}));

// Imported for its side effect: the module calls `convexAuth` on load.
await import("./auth");

const session = () =>
  captured.config?.session as
    | { inactiveDurationMs?: number; totalDurationMs?: number }
    | undefined;

describe("convexAuth config", () => {
  it("calls convexAuth exactly once, at module load", () => {
    expect(captured.config).toBeTypeOf("object");
  });

  it("applies both session clocks", () => {
    // The regression this file exists for: `session` absent entirely.
    expect(
      session(),
      "convexAuth was called without a `session` block — the clocks in " +
        "lib/sessionDuration.ts are dead code and the library default applies",
    ).toBeTypeOf("object");
    expect(session()?.inactiveDurationMs).toBe(SESSION_INACTIVE_DURATION_MS);
    expect(session()?.totalDurationMs).toBe(SESSION_TOTAL_DURATION_MS);
  });

  it("keeps the auth cookie and the session inactivity clock in agreement", () => {
    // src/middleware.ts sets the cookie's maxAge from
    // SESSION_COOKIE_MAX_AGE_SECONDS. If the session's inactivity window
    // and that cookie ever diverge, a login expires on one side while the
    // other still believes it is valid.
    expect(SESSION_COOKIE_MAX_AGE_SECONDS * 1000).toBe(
      session()?.inactiveDurationMs,
    );
  });

  it("pins the failed-sign-in budget rather than inheriting it", () => {
    // Equal to the library's current default on purpose — the point is
    // that a dependency bump changing that default cannot loosen this app
    // without showing up as a diff here.
    expect(captured.config?.signIn).toEqual({ maxFailedAttempsPerHour: 10 });
  });

  it("registers a provider", () => {
    expect(Array.isArray(captured.config?.providers)).toBe(true);
    expect((captured.config?.providers as unknown[]).length).toBeGreaterThan(0);
  });
});
