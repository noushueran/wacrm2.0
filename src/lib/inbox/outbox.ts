import type { Message } from "@/types";

// ---------------------------------------------------------------------
// The outbox — text messages this device accepted but the server has
// not yet confirmed.
//
// Why this exists at all. `api.send.send` is a Convex ACTION, not a
// mutation. Convex queues and replays mutations across a dropped
// socket; it does NOT do that for actions, which reject as soon as the
// connection is gone. So before this module, a message typed on a bad
// connection was simply lost: the composer cleared the textarea on
// submit, the action rejected, a toast appeared, and the text the agent
// had written existed nowhere. On a phone in a lift or a basement —
// which is where this CRM is actually used — that is the difference
// between trusting the app and keeping WhatsApp open beside it.
//
// Everything here is pure and serializable so the queue can be written
// to localStorage and survive the OS killing the app, and so the rules
// below can be tested without a browser.
// ---------------------------------------------------------------------

/**
 * Why a send failed, which decides whether retrying is SAFE — not just
 * whether it is possible.
 *
 *  - `offline`: the device had no network when we tried, so the request
 *    provably never left it. Meta cannot have seen it. Retrying can only
 *    ever produce one delivered message, so this is safe to do
 *    automatically on reconnect.
 *  - `error`: the request did leave, and we got a rejection or nothing
 *    back. That is AMBIGUOUS — the action may have already POSTed to
 *    Meta and had its reply lost. Retrying could send the customer the
 *    same message twice, which is worse than making a person decide, so
 *    these are never retried automatically.
 */
export type OutboxFailureKind = "offline" | "error";

export type OutboxEntry = {
  /** Client-generated. Never collides with a Convex id — see `outboxMessageId`. */
  localId: string;
  conversationId: string;
  text: string;
  replyToMessageId?: string;
  /** Epoch ms, so an entry restored from storage still sorts correctly. */
  createdAt: number;
  /** `undefined` while a send is in flight. */
  failure?: OutboxFailureKind;
  /** How many times a send has been attempted. Used to stop retrying forever. */
  attempts: number;
};

/** Give up auto-retrying after this many attempts; the entry stays as a
 *  manual retry rather than looping against a server that keeps saying no. */
export const MAX_AUTO_ATTEMPTS = 5;

/** Prefix that keeps a pending bubble's React key and any id comparison
 *  from ever colliding with a real Convex message id. */
const OUTBOX_ID_PREFIX = "outbox:";

export function outboxMessageId(localId: string): string {
  return `${OUTBOX_ID_PREFIX}${localId}`;
}

export function isOutboxMessageId(id: string): boolean {
  return id.startsWith(OUTBOX_ID_PREFIX);
}

/**
 * Render an outbox entry as a `Message` so it can be appended to the
 * thread's real message list and flow through the EXISTING grouping and
 * bubble code untouched.
 *
 * This is the whole reason the shape is a `Message`: `MessageBubble`
 * already draws `sending` as a clock and `failed` as a red cross, and
 * the thread already groups by sender and day. A pending message
 * therefore needs no new rendering path at all — it looks exactly like
 * an outbound message because as far as the UI is concerned it is one.
 */
export function outboxEntryToMessage(entry: OutboxEntry): Message {
  return {
    id: outboxMessageId(entry.localId),
    conversation_id: entry.conversationId,
    sender_type: "agent",
    content_type: "text",
    content_text: entry.text,
    status: entry.failure ? "failed" : "sending",
    created_at: new Date(entry.createdAt).toISOString(),
    reply_to_message_id: entry.replyToMessageId,
  };
}

/** Entries for one conversation, oldest first — the order they were typed. */
export function entriesForConversation(
  entries: OutboxEntry[],
  conversationId: string,
): OutboxEntry[] {
  return entries
    .filter((e) => e.conversationId === conversationId)
    .sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * Which entries may be retried automatically when the network returns.
 *
 * Only `offline` failures, and only while under the attempt ceiling. An
 * `error` failure is deliberately excluded however many times the user
 * reconnects: see `OutboxFailureKind`. An in-flight entry (no `failure`)
 * is excluded because something is already sending it.
 */
export function autoRetryable(entries: OutboxEntry[]): OutboxEntry[] {
  return entries.filter(
    (e) => e.failure === "offline" && e.attempts < MAX_AUTO_ATTEMPTS,
  );
}

/** Everything a person could retry by hand — every failure, regardless of
 *  kind or attempt count. Manual retry is always offered; it is only
 *  AUTOMATIC retry that is restricted. */
export function manuallyRetryable(entries: OutboxEntry[]): OutboxEntry[] {
  return entries.filter((e) => e.failure !== undefined);
}

export function createEntry(input: {
  localId: string;
  conversationId: string;
  text: string;
  replyToMessageId?: string;
  now: number;
}): OutboxEntry {
  return {
    localId: input.localId,
    conversationId: input.conversationId,
    text: input.text,
    replyToMessageId: input.replyToMessageId,
    createdAt: input.now,
    attempts: 0,
  };
}

/** Mark an entry as in flight: clears any previous failure and counts the
 *  attempt, so a retry that fails again lands on a higher count. */
export function markSending(
  entries: OutboxEntry[],
  localId: string,
): OutboxEntry[] {
  return entries.map((e) =>
    e.localId === localId
      ? { ...e, failure: undefined, attempts: e.attempts + 1 }
      : e,
  );
}

export function markFailed(
  entries: OutboxEntry[],
  localId: string,
  failure: OutboxFailureKind,
): OutboxEntry[] {
  return entries.map((e) => (e.localId === localId ? { ...e, failure } : e));
}

/** Drop a confirmed entry. Called on success, at which point Convex has
 *  already pushed the real message into the thread's query — Convex
 *  applies a mutation's query updates before resolving its promise — so
 *  removing here cannot leave a gap where neither bubble is on screen. */
export function removeEntry(
  entries: OutboxEntry[],
  localId: string,
): OutboxEntry[] {
  return entries.filter((e) => e.localId !== localId);
}

// ---------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------

export const OUTBOX_STORAGE_KEY = "wacrm:inbox:outbox";

/**
 * Reading is deliberately paranoid. This data survived an app kill and a
 * possible version change, it is parsed at startup on the inbox's
 * critical path, and a single malformed entry must not throw and take
 * the whole thread down with it. Anything that does not look like an
 * entry is dropped rather than repaired.
 *
 * Entries mid-flight when the app died are restored as `offline`
 * failures rather than as still-sending: nothing is sending them any
 * more, and the app being killed is itself decent evidence the request
 * never completed. That also makes them eligible for auto-retry, which
 * is the behaviour an agent expects after force-quitting in a dead spot.
 */
export function deserializeOutbox(raw: string | null): OutboxEntry[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const entries: OutboxEntry[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const e = item as Record<string, unknown>;
    if (
      typeof e.localId !== "string" ||
      typeof e.conversationId !== "string" ||
      typeof e.text !== "string" ||
      typeof e.createdAt !== "number" ||
      !Number.isFinite(e.createdAt)
    ) {
      continue;
    }
    const failure =
      e.failure === "offline" || e.failure === "error"
        ? (e.failure as OutboxFailureKind)
        : "offline";
    entries.push({
      localId: e.localId,
      conversationId: e.conversationId,
      text: e.text,
      replyToMessageId:
        typeof e.replyToMessageId === "string" ? e.replyToMessageId : undefined,
      createdAt: e.createdAt,
      failure,
      attempts:
        typeof e.attempts === "number" && Number.isFinite(e.attempts)
          ? e.attempts
          : 0,
    });
  }
  return entries;
}

export function serializeOutbox(entries: OutboxEntry[]): string {
  return JSON.stringify(entries);
}

// ---------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------

/** Per-conversation composer draft, so a half-typed reply survives both a
 *  chat switch and the OS killing the app. */
export function draftStorageKey(conversationId: string): string {
  return `wacrm:inbox:draft:${conversationId}`;
}
