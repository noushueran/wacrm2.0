import { expect, test } from "vitest";
import {
  formatWindowRemaining,
  resolveConversationWindows,
} from "./messagingWindow";
import type { Message } from "@/types";

const NOW = Date.parse("2026-07-24T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;

function msg(senderType: Message["sender_type"], atMs: number): Message {
  return {
    id: `m-${atMs}-${senderType}`,
    conversation_id: "c1",
    sender_type: senderType,
    content_type: "text",
    status: "delivered",
    created_at: new Date(atMs).toISOString(),
  } as Message;
}

// ------------------------------------------------------------
// 24h customer service window
// ------------------------------------------------------------

test("csw: uses the stored last_inbound_at when present", () => {
  const w = resolveConversationWindows({
    conversation: { last_inbound_at: new Date(NOW - 2 * HOUR).toISOString() },
    messages: [],
    now: NOW,
  });
  expect(w.csw.open).toBe(true);
  expect(w.canSendFreeForm).toBe(true);
  expect(w.csw.remainingMs).toBe(22 * HOUR);
});

test("csw: falls back to the last customer message for pre-existing threads", () => {
  const w = resolveConversationWindows({
    conversation: {},
    messages: [msg("customer", NOW - 3 * HOUR), msg("agent", NOW - HOUR)],
    now: NOW,
  });
  expect(w.csw.open).toBe(true);
  expect(w.csw.remainingMs).toBe(21 * HOUR);
});

test("csw: an outbound-only thread has no window", () => {
  const w = resolveConversationWindows({
    conversation: {},
    messages: [msg("agent", NOW - HOUR)],
    now: NOW,
  });
  expect(w.csw.open).toBe(false);
  expect(w.canSendFreeForm).toBe(false);
});

test("csw: closed once the last inbound message is over 24h old", () => {
  const w = resolveConversationWindows({
    conversation: {},
    messages: [msg("customer", NOW - 25 * HOUR)],
    now: NOW,
  });
  expect(w.csw.open).toBe(false);
});

// ------------------------------------------------------------
// 72h free entry point window
// ------------------------------------------------------------

test("fep: a non-ad conversation never has a free window", () => {
  const w = resolveConversationWindows({
    conversation: {},
    messages: [msg("customer", NOW - HOUR)],
    now: NOW,
  });
  expect(w.fep.open).toBe(false);
  expect(w.allMessagesFree).toBe(false);
  expect(w.unlockRemainingMs).toBeNull();
});

test("fep: an ad lead replied to within 24h has an estimated free window", () => {
  const adStart = NOW - 10 * HOUR;
  const w = resolveConversationWindows({
    conversation: { ad_referral: { started_at: new Date(adStart).toISOString() } },
    messages: [msg("customer", adStart), msg("agent", adStart + HOUR)],
    now: NOW,
  });
  expect(w.fep.open).toBe(true);
  expect(w.fep.source).toBe("estimated");
  expect(w.allMessagesFree).toBe(true);
  // 72h from the reply, which was 9h ago.
  expect(w.fep.remainingMs).toBe(63 * HOUR);
  expect(w.unlockRemainingMs).toBeNull();
});

test("fep: an ad lead never replied to within 24h gets no free window", () => {
  const adStart = NOW - 30 * HOUR;
  const w = resolveConversationWindows({
    conversation: { ad_referral: { started_at: new Date(adStart).toISOString() } },
    messages: [msg("customer", adStart), msg("agent", adStart + 25 * HOUR)],
    now: NOW,
  });
  expect(w.fep.open).toBe(false);
  expect(w.allMessagesFree).toBe(false);
  expect(w.unlockRemainingMs).toBeNull();
});

test("fep: Meta's authoritative window overrides the estimate", () => {
  const adStart = NOW - 10 * HOUR;
  const w = resolveConversationWindows({
    conversation: {
      ad_referral: { started_at: new Date(adStart).toISOString() },
      meta_window: {
        is_free_entry_point: true,
        expires_at: new Date(NOW + 5 * HOUR).toISOString(),
      },
    },
    messages: [msg("customer", adStart), msg("agent", adStart + HOUR)],
    now: NOW,
  });
  expect(w.fep.source).toBe("meta");
  expect(w.fep.remainingMs).toBe(5 * HOUR);
});

test("fep: an expired Meta window reports closed and stays authoritative", () => {
  const w = resolveConversationWindows({
    conversation: {
      meta_window: {
        is_free_entry_point: true,
        expires_at: new Date(NOW - 1).toISOString(),
      },
    },
    messages: [],
    now: NOW,
  });
  expect(w.fep.open).toBe(false);
  expect(w.fep.source).toBe("meta");
});

// ------------------------------------------------------------
// The quadrant that the old UI could not express
// ------------------------------------------------------------

test("24h closed but 72h open: template-only, yet every message is free", () => {
  const adStart = NOW - 30 * HOUR;
  const w = resolveConversationWindows({
    conversation: { ad_referral: { started_at: new Date(adStart).toISOString() } },
    // Customer went quiet 30h ago; we replied 29h ago, inside the deadline.
    messages: [msg("customer", adStart), msg("agent", adStart + HOUR)],
    now: NOW,
  });
  expect(w.csw.open).toBe(false);
  expect(w.canSendFreeForm).toBe(false);
  expect(w.fep.open).toBe(true);
  expect(w.allMessagesFree).toBe(true);
});

// ------------------------------------------------------------
// Unlock nudge
// ------------------------------------------------------------

test("unlock: an unanswered ad lead inside 24h counts down to the deadline", () => {
  const adStart = NOW - 6 * HOUR;
  const w = resolveConversationWindows({
    conversation: { ad_referral: { started_at: new Date(adStart).toISOString() } },
    messages: [msg("customer", adStart)],
    now: NOW,
  });
  expect(w.unlockRemainingMs).toBe(18 * HOUR);
  expect(w.fep.open).toBe(false);
});

test("unlock: disappears once the deadline has passed", () => {
  const adStart = NOW - 25 * HOUR;
  const w = resolveConversationWindows({
    conversation: { ad_referral: { started_at: new Date(adStart).toISOString() } },
    messages: [msg("customer", adStart)],
    now: NOW,
  });
  expect(w.unlockRemainingMs).toBeNull();
});

test("unlock: the stored first_reply_at also counts as replied", () => {
  const adStart = NOW - 6 * HOUR;
  const w = resolveConversationWindows({
    conversation: {
      ad_referral: { started_at: new Date(adStart).toISOString() },
      first_reply_at: new Date(adStart + HOUR).toISOString(),
    },
    messages: [msg("customer", adStart)],
    now: NOW,
  });
  expect(w.unlockRemainingMs).toBeNull();
  expect(w.fep.open).toBe(true);
});

// ------------------------------------------------------------
// formatWindowRemaining
// ------------------------------------------------------------

test("formatWindowRemaining: hours, then minutes, then null", () => {
  expect(formatWindowRemaining(61 * HOUR)).toBe("61h");
  expect(formatWindowRemaining(45 * 60 * 1000)).toBe("45m");
  expect(formatWindowRemaining(30 * 1000)).toBe("1m");
  expect(formatWindowRemaining(0)).toBeNull();
  expect(formatWindowRemaining(-1)).toBeNull();
});
