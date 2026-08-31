// Frontend adapter over the shared, pure messaging-window resolver.
//
// The resolver itself lives in `convex/lib/whatsapp/messagingWindow.ts` and is
// imported directly rather than mirrored, so the backend and the inbox can
// never disagree about whether a conversation is free. (Same cross-boundary
// pattern as `convex/lib/kb/lint` in the knowledge editors and
// `convex/lib/cronSummary` in Settings — the module is dependency-free.)
//
// This file's whole job is the impedance mismatch:
//   1. UI `Conversation` timestamps are ISO strings; the resolver takes epoch ms.
//   2. `last_inbound_at` / `first_reply_at` only exist on conversations that
//      have seen traffic since those fields shipped. For everything older we
//      derive the same values from the loaded `messages`, so the windows are
//      correct for pre-existing threads instead of silently reading "closed".
//
// Deriving from messages also means the 72h window works from `ad_referral`
// alone — which the webhook has been capturing all along — so the inbox shows
// a real (estimated) free window before Meta's authoritative `meta_window`
// data starts arriving.

import {
  CSW_WINDOW_MS,
  resolveWindowState,
  type FepSource,
} from "../../../convex/lib/whatsapp/messagingWindow";
import type { Conversation, Message } from "@/types";

export { CSW_WINDOW_MS };

export interface ConversationWindows {
  /** 24h customer service window — governs message TYPE. */
  csw: { open: boolean; remainingMs: number };
  /** 72h free entry point window — governs COST. */
  fep: { open: boolean; remainingMs: number; source: FepSource };
  /** Free-form (non-template) messages are permitted right now. */
  canSendFreeForm: boolean;
  /** True when every message kind is currently free of charge. */
  allMessagesFree: boolean;
  /**
   * Milliseconds left to reply and still unlock the 72h free window, or
   * `null` when that no longer applies — not an ad lead, already replied,
   * or the 24h reply deadline has passed. Drives the unlock nudge.
   */
  unlockRemainingMs: number | null;
}

/** Epoch ms of the most recent inbound customer message, or `undefined`. */
function lastInboundFromMessages(messages: Message[]): number | undefined {
  let latest: number | undefined;
  for (const m of messages) {
    if (m.sender_type !== "customer") continue;
    const at = Date.parse(m.created_at);
    if (Number.isNaN(at)) continue;
    if (latest === undefined || at > latest) latest = at;
  }
  return latest;
}

/** Epoch ms of the first outbound message at/after `sinceMs`, or `undefined`. */
function firstReplyFromMessages(
  messages: Message[],
  sinceMs: number,
): number | undefined {
  let earliest: number | undefined;
  for (const m of messages) {
    if (m.sender_type === "customer") continue;
    const at = Date.parse(m.created_at);
    if (Number.isNaN(at) || at < sinceMs) continue;
    if (earliest === undefined || at < earliest) earliest = at;
  }
  return earliest;
}

function parseIso(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : ms;
}

export function resolveConversationWindows({
  conversation,
  messages,
  now,
}: {
  conversation: Pick<
    Conversation,
    "last_inbound_at" | "first_reply_at" | "meta_window" | "ad_referral"
  >;
  messages: Message[];
  now: number;
}): ConversationWindows {
  const adStartedAt = parseIso(conversation.ad_referral?.started_at);

  // Stored field first; fall back to the loaded thread for older rows.
  const lastInboundAt =
    parseIso(conversation.last_inbound_at) ?? lastInboundFromMessages(messages);

  const firstReplyAt =
    parseIso(conversation.first_reply_at) ??
    (adStartedAt !== undefined
      ? firstReplyFromMessages(messages, adStartedAt)
      : undefined);

  const metaWindow = conversation.meta_window
    ? {
        expiresAt: parseIso(conversation.meta_window.expires_at),
        isFreeEntryPoint: conversation.meta_window.is_free_entry_point,
      }
    : undefined;

  const state = resolveWindowState({
    now,
    lastInboundAt,
    metaWindow,
    adReferralStartedAt: adStartedAt,
    firstReplyAt,
  });

  // The free window can still be unlocked only while this is an unanswered
  // ad lead inside the 24h reply deadline. Once Meta has spoken there is
  // nothing left to unlock.
  let unlockRemainingMs: number | null = null;
  if (
    adStartedAt !== undefined &&
    firstReplyAt === undefined &&
    state.fep.source !== "meta"
  ) {
    const remaining = adStartedAt + CSW_WINDOW_MS - now;
    if (remaining > 0) unlockRemainingMs = remaining;
  }

  return {
    csw: { open: state.csw.open, remainingMs: state.csw.remainingMs },
    fep: {
      open: state.fep.open,
      remainingMs: state.fep.remainingMs,
      source: state.fep.source,
    },
    canSendFreeForm: state.canSendFreeForm,
    // Inside an open free-entry-point window every kind is free, which is
    // exactly what the resolver reports for a marketing template.
    allMessagesFree: state.cost.templateMarketing.free,
    unlockRemainingMs,
  };
}

/** `61h` / `45m` — compact countdown text. Returns `null` at/below zero. */
export function formatWindowRemaining(remainingMs: number): string | null {
  if (remainingMs <= 0) return null;
  const hours = Math.floor(remainingMs / (60 * 60 * 1000));
  if (hours >= 1) return `${hours}h`;
  return `${Math.max(1, Math.floor(remainingMs / (60 * 1000)))}m`;
}
