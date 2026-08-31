import { expect, test } from "vitest";
import {
  CSW_WINDOW_MS,
  FEP_WINDOW_MS,
  resolveWindowState,
} from "./messagingWindow";

const NOW = 1_000_000_000_000;

// ------------------------------------------------------------
// 24h customer service window
// ------------------------------------------------------------

test("csw: open when the last inbound message is under 24h old", () => {
  const s = resolveWindowState({ now: NOW, lastInboundAt: NOW - 1000 });
  expect(s.csw.open).toBe(true);
  expect(s.canSendFreeForm).toBe(true);
  expect(s.csw.expiresAt).toBe(NOW - 1000 + CSW_WINDOW_MS);
});

test("csw: closed at exactly 24h and beyond", () => {
  expect(
    resolveWindowState({ now: NOW, lastInboundAt: NOW - CSW_WINDOW_MS }).csw
      .open,
  ).toBe(false);
});

test("csw: absent lastInboundAt is treated as closed, not an error", () => {
  const s = resolveWindowState({ now: NOW });
  expect(s.csw.open).toBe(false);
  expect(s.csw.remainingMs).toBe(0);
  expect(s.canSendFreeForm).toBe(false);
});

// ------------------------------------------------------------
// 72h free entry point window
// ------------------------------------------------------------

test("fep: no ad referral means no free entry point, ever", () => {
  const s = resolveWindowState({ now: NOW, lastInboundAt: NOW - 1000 });
  expect(s.fep.open).toBe(false);
  expect(s.fep.source).toBe("none");
});

test("fep: ad referral with a reply inside 24h opens an estimated window", () => {
  const startedAt = NOW - 2 * 60 * 60 * 1000;
  const firstReplyAt = startedAt + 60 * 60 * 1000;
  const s = resolveWindowState({
    now: NOW,
    lastInboundAt: startedAt,
    adReferralStartedAt: startedAt,
    firstReplyAt,
  });
  expect(s.fep.open).toBe(true);
  expect(s.fep.source).toBe("estimated");
  expect(s.fep.expiresAt).toBe(firstReplyAt + FEP_WINDOW_MS);
  expect(s.confidence).toBe("estimated");
});

test("fep: ad referral with NO reply inside 24h never opens a window", () => {
  const startedAt = NOW - 100 * 60 * 60 * 1000;
  const s = resolveWindowState({
    now: NOW,
    adReferralStartedAt: startedAt,
    firstReplyAt: startedAt + CSW_WINDOW_MS + 1,
  });
  expect(s.fep.open).toBe(false);
  expect(s.fep.source).toBe("none");
  expect(s.confidence).toBe("authoritative");
});

test("fep: ad referral with no reply at all never opens a window", () => {
  const s = resolveWindowState({
    now: NOW,
    adReferralStartedAt: NOW - 1000,
  });
  expect(s.fep.open).toBe(false);
  expect(s.fep.source).toBe("none");
});

test("fep: Meta's authoritative window overrides an active estimate", () => {
  const startedAt = NOW - 2 * 60 * 60 * 1000;
  const s = resolveWindowState({
    now: NOW,
    adReferralStartedAt: startedAt,
    firstReplyAt: startedAt + 1000,
    metaWindow: { isFreeEntryPoint: true, expiresAt: NOW + 5000 },
  });
  expect(s.fep.source).toBe("meta");
  expect(s.fep.expiresAt).toBe(NOW + 5000);
  expect(s.confidence).toBe("authoritative");
});

test("fep: an expired Meta window stays authoritative and closed", () => {
  const s = resolveWindowState({
    now: NOW,
    metaWindow: { isFreeEntryPoint: true, expiresAt: NOW - 1 },
  });
  expect(s.fep.open).toBe(false);
  expect(s.fep.source).toBe("meta");
});

test("fep: a reply at EXACTLY 24h after the ad click is too late — no window", () => {
  const startedAt = NOW - 100 * 60 * 60 * 1000;
  const s = resolveWindowState({
    now: NOW,
    adReferralStartedAt: startedAt,
    firstReplyAt: startedAt + CSW_WINDOW_MS,
  });
  expect(s.fep.open).toBe(false);
  expect(s.fep.source).toBe("none");
});

test("fep: a metaWindow with isFreeEntryPoint false falls through to the local estimate", () => {
  const startedAt = NOW - 2 * 60 * 60 * 1000;
  const firstReplyAt = startedAt + 60 * 60 * 1000;
  const s = resolveWindowState({
    now: NOW,
    adReferralStartedAt: startedAt,
    firstReplyAt,
    metaWindow: { isFreeEntryPoint: false, expiresAt: NOW + 999_999 },
  });
  expect(s.fep.source).toBe("estimated");
  expect(s.fep.expiresAt).toBe(firstReplyAt + FEP_WINDOW_MS);
  expect(s.confidence).toBe("estimated");
});

// ------------------------------------------------------------
// The four-quadrant cost matrix
// ------------------------------------------------------------

test("quadrant 1 — CSW open, FEP open: everything free", () => {
  const s = resolveWindowState({
    now: NOW,
    lastInboundAt: NOW - 1000,
    metaWindow: { isFreeEntryPoint: true, expiresAt: NOW + 5000 },
  });
  expect(s.canSendFreeForm).toBe(true);
  expect(s.cost.freeForm).toEqual({ free: true, reason: "fep" });
  expect(s.cost.templateMarketing).toEqual({ free: true, reason: "fep" });
  expect(s.cost.templateAuthentication).toEqual({ free: true, reason: "fep" });
  expect(s.cost.templateUtility).toEqual({ free: true, reason: "fep" });
});

test("quadrant 2 — CSW closed, FEP open: template-only but still free", () => {
  const s = resolveWindowState({
    now: NOW,
    lastInboundAt: NOW - CSW_WINDOW_MS - 1,
    metaWindow: { isFreeEntryPoint: true, expiresAt: NOW + 5000 },
  });
  expect(s.canSendFreeForm).toBe(false);
  expect(s.cost.freeForm).toEqual({ free: true, reason: "fep" });
  expect(s.cost.templateUtility).toEqual({ free: true, reason: "fep" });
  expect(s.cost.templateMarketing).toEqual({ free: true, reason: "fep" });
  expect(s.cost.templateAuthentication).toEqual({ free: true, reason: "fep" });
});

test("quadrant 3 — CSW open, FEP closed: free-form and utility free, marketing and auth billed", () => {
  const s = resolveWindowState({ now: NOW, lastInboundAt: NOW - 1000 });
  expect(s.canSendFreeForm).toBe(true);
  expect(s.cost.freeForm).toEqual({
    free: true,
    reason: "customer_service_window",
  });
  expect(s.cost.templateUtility).toEqual({
    free: true,
    reason: "customer_service_window",
  });
  expect(s.cost.templateMarketing).toEqual({ free: false, reason: "billed" });
  expect(s.cost.templateAuthentication).toEqual({
    free: false,
    reason: "billed",
  });
});

test("quadrant 4 — both closed: template-only and billed", () => {
  const s = resolveWindowState({
    now: NOW,
    lastInboundAt: NOW - CSW_WINDOW_MS - 1,
  });
  expect(s.canSendFreeForm).toBe(false);
  expect(s.cost.freeForm).toEqual({ free: false, reason: "billed" });
  expect(s.cost.templateUtility).toEqual({ free: false, reason: "billed" });
  expect(s.cost.templateMarketing).toEqual({ free: false, reason: "billed" });
  expect(s.cost.templateAuthentication).toEqual({ free: false, reason: "billed" });
});
