import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { countdownTo } from "./trigger-meta";

// ============================================================
// Task 8 (automations run-tracking UI) — the Waiting tab's countdown to
// `automationRuns.resumeAt`. Pinned in isolation because the obvious
// implementation (reusing `formatRelative`'s `Date.now() - then` math for
// a FUTURE `then`) is silently wrong: the diff goes negative, and a
// negative number is always `< 60`, so it would print "just now" for
// every waiting run regardless of how far off its resume actually is.
// These tests exist specifically to catch that regression if `countdownTo`
// is ever "simplified" back onto that helper.
// ============================================================

describe("countdownTo", () => {
  const NOW = new Date("2026-08-10T12:00:00.000Z").getTime();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports due for a null/undefined target", () => {
    expect(countdownTo(null)).toEqual({ unit: "due", count: 0 });
    expect(countdownTo(undefined)).toEqual({ unit: "due", count: 0 });
  });

  it("reports due for a target already in the past", () => {
    expect(countdownTo(NOW - 5_000)).toEqual({ unit: "due", count: 0 });
  });

  it("reports due for a target that is exactly now", () => {
    expect(countdownTo(NOW)).toEqual({ unit: "due", count: 0 });
  });

  it("never prints 'just now'-style zero for a genuinely future wait — the bug formatRelative would have", () => {
    // 10 minutes out: formatRelative's `Date.now() - then` math would
    // compute -600s here, and -600 < 60 is true, so that helper would
    // wrongly call this "just now" too. countdownTo must not.
    const result = countdownTo(NOW + 10 * 60 * 1000);
    expect(result.unit).not.toBe("due");
    expect(result).toEqual({ unit: "minutes", count: 10 });
  });

  it("rounds sub-minute waits up to 1 minute rather than down to 0", () => {
    expect(countdownTo(NOW + 30_000)).toEqual({ unit: "minutes", count: 1 });
  });

  it("switches to hours at the 60-minute boundary", () => {
    expect(countdownTo(NOW + 59 * 60 * 1000)).toEqual({ unit: "minutes", count: 59 });
    expect(countdownTo(NOW + 60 * 60 * 1000)).toEqual({ unit: "hours", count: 1 });
  });

  it("switches to days at the 24-hour boundary", () => {
    expect(countdownTo(NOW + 23 * 3600 * 1000)).toEqual({ unit: "hours", count: 23 });
    expect(countdownTo(NOW + 24 * 3600 * 1000)).toEqual({ unit: "days", count: 1 });
  });

  it("handles a multi-day wait", () => {
    expect(countdownTo(NOW + 3 * 86400 * 1000)).toEqual({ unit: "days", count: 3 });
  });
});
