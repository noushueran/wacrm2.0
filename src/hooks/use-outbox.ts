"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  OUTBOX_STORAGE_KEY,
  autoRetryable,
  createEntry,
  deserializeOutbox,
  markFailed,
  markSending,
  removeEntry,
  serializeOutbox,
  type OutboxEntry,
} from "@/lib/inbox/outbox";

/** Sends one queued message. Resolves on success, rejects on failure —
 *  the thread supplies the real Convex action. */
export type OutboxSender = (entry: OutboxEntry) => Promise<unknown>;

/**
 * Owns the pending-message queue: persistence, send attempts, failure
 * classification and reconnect retries. All the RULES live in
 * `@/lib/inbox/outbox` and are unit-tested there; this hook is the thin
 * React and I/O layer around them.
 */
export function useOutbox(send: OutboxSender) {
  const [entries, setEntries] = useState<OutboxEntry[]>([]);
  // `entries` is read inside callbacks that must not be re-created every
  // time the queue changes (the reconnect listener registers once), so
  // the current value is mirrored here.
  const entriesRef = useRef<OutboxEntry[]>(entries);
  // The sender identity changes whenever the open conversation does;
  // mirroring it keeps the reconnect effect from re-subscribing.
  const sendRef = useRef(send);
  useEffect(() => {
    sendRef.current = send;
  });
  // Guards against two attempts for one entry running at once — a manual
  // retry racing the reconnect sweep would otherwise double-send.
  const inFlightRef = useRef<Set<string>>(new Set());
  const [loaded, setLoaded] = useState(false);

  const update = useCallback(
    (next: (prev: OutboxEntry[]) => OutboxEntry[]) => {
      setEntries((prev) => {
        const value = next(prev);
        entriesRef.current = value;
        try {
          localStorage.setItem(OUTBOX_STORAGE_KEY, serializeOutbox(value));
        } catch {
          // Private mode / quota. The queue still works for this session;
          // it just will not survive a kill. Never break sending over it.
        }
        return value;
      });
    },
    [],
  );

  // Restore anything the app died holding. One-shot, in an effect,
  // because localStorage cannot be read during render.
  useEffect(() => {
    let restored: OutboxEntry[] = [];
    try {
      restored = deserializeOutbox(localStorage.getItem(OUTBOX_STORAGE_KEY));
    } catch {
      restored = [];
    }
    entriesRef.current = restored;
    setEntries(restored);
    setLoaded(true);
  }, []);

  /** Attempt one entry. Never throws: a failure is recorded on the entry,
   *  which IS the user-visible outcome. */
  const attempt = useCallback(
    async (entry: OutboxEntry) => {
      if (inFlightRef.current.has(entry.localId)) return;
      inFlightRef.current.add(entry.localId);
      update((prev) => markSending(prev, entry.localId));
      try {
        await sendRef.current(entry);
        update((prev) => removeEntry(prev, entry.localId));
      } catch {
        // Classify at the moment of failure, not later: this is the only
        // point at which we know whether the device had a network when
        // the request was made, and that decides whether retrying is
        // safe to do without asking. See `OutboxFailureKind`.
        const offline =
          typeof navigator !== "undefined" && navigator.onLine === false;
        update((prev) =>
          markFailed(prev, entry.localId, offline ? "offline" : "error"),
        );
      } finally {
        inFlightRef.current.delete(entry.localId);
      }
    },
    [update],
  );

  /** Accept a message from the composer. Returns immediately — the queue
   *  is the source of truth, so the bubble appears whether or not the
   *  network cooperates. */
  const enqueue = useCallback(
    (input: {
      conversationId: string;
      text: string;
      replyToMessageId?: string;
    }) => {
      const entry = createEntry({
        localId:
          globalThis.crypto?.randomUUID?.() ??
          `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        conversationId: input.conversationId,
        text: input.text,
        replyToMessageId: input.replyToMessageId,
        now: Date.now(),
      });
      update((prev) => [...prev, entry]);
      void attempt(entry);
    },
    [attempt, update],
  );

  const retry = useCallback(
    (localId: string) => {
      const entry = entriesRef.current.find((e) => e.localId === localId);
      if (entry) void attempt(entry);
    },
    [attempt],
  );

  /** Manual "retry all" for one conversation. Unrestricted by design —
   *  a person clicking retry has accepted the duplicate risk that stops
   *  US retrying an ambiguous failure on our own. */
  const retryAll = useCallback(
    (conversationId: string) => {
      for (const entry of entriesRef.current) {
        if (entry.conversationId === conversationId && entry.failure) {
          void attempt(entry);
        }
      }
    },
    [attempt],
  );

  const discard = useCallback(
    (localId: string) => update((prev) => removeEntry(prev, localId)),
    [update],
  );

  // Reconnect sweep. Only entries that failed while provably offline are
  // resent without asking; everything else waits for a person.
  useEffect(() => {
    if (!loaded) return;
    const onOnline = () => {
      for (const entry of autoRetryable(entriesRef.current)) {
        void attempt(entry);
      }
    };
    window.addEventListener("online", onOnline);
    // Also sweep once on mount: the app may have been launched already
    // back on a network, having been killed while offline.
    if (typeof navigator === "undefined" || navigator.onLine) onOnline();
    return () => window.removeEventListener("online", onOnline);
  }, [loaded, attempt]);

  return { entries, enqueue, retry, retryAll, discard };
}
