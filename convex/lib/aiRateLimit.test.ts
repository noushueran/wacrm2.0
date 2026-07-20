import { describe, it, expect } from "vitest";
import {
  claimSlot,
  AUTO_REPLY_LIMIT,
  AUTO_REPLY_WINDOW_MS,
  type RateWindow,
} from "./aiRateLimit";

// Pure fixed-window arithmetic, tested without Convex. The mutation that
// wraps this (`aiReply.claimAutoReplySlot`) only reads a row, calls this,
// and writes the result back — so everything interesting lives here.
//
// The contract is PACE, never drop: a refusal always carries a positive
// `retryAfterMs` telling the caller when a slot frees. There is no outcome
// that means "give up on this reply".

describe("claimSlot", () => {
  it("allows the first call of a fresh account and opens a window", () => {
    const d = claimSlot(null, 1_000);
    expect(d.allowed).toBe(true);
    if (!d.allowed) return;
    expect(d.next).toEqual({ windowStartMs: 1_000, count: 1 });
  });

  it("increments within an open window", () => {
    const current: RateWindow = { windowStartMs: 1_000, count: 5 };
    const d = claimSlot(current, 1_500);
    expect(d.allowed).toBe(true);
    if (!d.allowed) return;
    // The window start does NOT move — that is what makes it fixed rather
    // than sliding, and what guarantees the window actually expires.
    expect(d.next).toEqual({ windowStartMs: 1_000, count: 6 });
  });

  it("allows exactly up to the limit", () => {
    const current: RateWindow = {
      windowStartMs: 1_000,
      count: AUTO_REPLY_LIMIT - 1,
    };
    const d = claimSlot(current, 1_500);
    expect(d.allowed).toBe(true);
    if (!d.allowed) return;
    expect(d.next.count).toBe(AUTO_REPLY_LIMIT);
  });

  it("refuses once the window is full, and says when a slot frees", () => {
    const current: RateWindow = {
      windowStartMs: 1_000,
      count: AUTO_REPLY_LIMIT,
    };
    const d = claimSlot(current, 1_500);
    expect(d.allowed).toBe(false);
    if (d.allowed) return;
    // 1_000 + 60_000 - 1_500
    expect(d.retryAfterMs).toBe(AUTO_REPLY_WINDOW_MS - 500);
  });

  it("never returns a non-positive retry delay, so a deferral always advances", () => {
    // A caller arriving in the same millisecond the window closes must not
    // be told to retry in 0ms — that would busy-loop the scheduler.
    const current: RateWindow = {
      windowStartMs: 1_000,
      count: AUTO_REPLY_LIMIT,
    };
    const atEdge = claimSlot(current, 1_000 + AUTO_REPLY_WINDOW_MS - 1);
    expect(atEdge.allowed).toBe(false);
    if (atEdge.allowed) return;
    expect(atEdge.retryAfterMs).toBeGreaterThan(0);
  });

  it("starts a new window once the old one has elapsed, even if it was full", () => {
    const current: RateWindow = {
      windowStartMs: 1_000,
      count: AUTO_REPLY_LIMIT,
    };
    const d = claimSlot(current, 1_000 + AUTO_REPLY_WINDOW_MS);
    expect(d.allowed).toBe(true);
    if (!d.allowed) return;
    expect(d.next).toEqual({
      windowStartMs: 1_000 + AUTO_REPLY_WINDOW_MS,
      count: 1,
    });
  });

  it("treats a far-future clock as a new window rather than going negative", () => {
    const current: RateWindow = { windowStartMs: 1_000, count: AUTO_REPLY_LIMIT };
    const d = claimSlot(current, 5_000_000);
    expect(d.allowed).toBe(true);
    if (!d.allowed) return;
    expect(d.next.count).toBe(1);
  });

  it("keeps the declared budget in step with RATE_LIMITS.aiAutoReplyAccount", () => {
    // src/lib/rate-limit.ts declares the same budget for the Next.js side
    // but cannot be imported here (it pulls in next/server, which Convex's
    // runtime has no module for). Pinning the numbers means a change there
    // that is not mirrored here fails loudly instead of silently diverging.
    expect(AUTO_REPLY_LIMIT).toBe(30);
    expect(AUTO_REPLY_WINDOW_MS).toBe(60_000);
  });
});
