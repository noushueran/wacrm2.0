import { describe, it, expect } from "vitest";
import {
  MAX_AUTO_ATTEMPTS,
  autoRetryable,
  createEntry,
  deserializeOutbox,
  draftStorageKey,
  entriesForConversation,
  isOutboxMessageId,
  manuallyRetryable,
  markFailed,
  markSending,
  outboxEntryToMessage,
  outboxMessageId,
  removeEntry,
  serializeOutbox,
  type OutboxEntry,
} from "./outbox";

function entry(over: Partial<OutboxEntry> = {}): OutboxEntry {
  return {
    localId: "l1",
    conversationId: "c1",
    text: "hello",
    createdAt: 1_000,
    attempts: 0,
    ...over,
  };
}

describe("outbox ids", () => {
  it("namespaces local ids so they can never collide with a Convex id", () => {
    expect(outboxMessageId("abc")).toBe("outbox:abc");
    expect(isOutboxMessageId("outbox:abc")).toBe(true);
    // A real Convex id — must not be mistaken for a pending bubble.
    expect(isOutboxMessageId("kx7apqsm6bq0qxmez8q436zfn58acv6p")).toBe(false);
  });
});

describe("outboxEntryToMessage", () => {
  it("renders as an outbound message so the existing bubble draws it unchanged", () => {
    const m = outboxEntryToMessage(entry({ text: "on my way" }));
    expect(m.sender_type).toBe("agent");
    expect(m.content_type).toBe("text");
    expect(m.content_text).toBe("on my way");
    expect(m.id).toBe("outbox:l1");
  });

  it("is 'sending' while in flight and 'failed' once it failed", () => {
    expect(outboxEntryToMessage(entry()).status).toBe("sending");
    expect(outboxEntryToMessage(entry({ failure: "offline" })).status).toBe("failed");
    expect(outboxEntryToMessage(entry({ failure: "error" })).status).toBe("failed");
  });

  it("carries the reply target through, so a queued reply still quotes", () => {
    expect(
      outboxEntryToMessage(entry({ replyToMessageId: "m9" })).reply_to_message_id,
    ).toBe("m9");
  });
});

describe("entriesForConversation", () => {
  it("returns only this chat's entries, oldest first", () => {
    const all = [
      entry({ localId: "b", createdAt: 200 }),
      entry({ localId: "other", conversationId: "c2", createdAt: 150 }),
      entry({ localId: "a", createdAt: 100 }),
    ];
    expect(entriesForConversation(all, "c1").map((e) => e.localId)).toEqual([
      "a",
      "b",
    ]);
  });
});

describe("retry eligibility", () => {
  it("auto-retries an offline failure — the request provably never left the device", () => {
    expect(autoRetryable([entry({ failure: "offline" })])).toHaveLength(1);
  });

  it("NEVER auto-retries an ambiguous error — it may already have reached the customer", () => {
    // This is the safety property of the whole module. A duplicate
    // WhatsApp message to a real customer is worse than asking a person.
    expect(autoRetryable([entry({ failure: "error" })])).toHaveLength(0);
  });

  it("does not auto-retry something already in flight", () => {
    expect(autoRetryable([entry({ failure: undefined })])).toHaveLength(0);
  });

  it("stops auto-retrying at the attempt ceiling instead of looping forever", () => {
    expect(
      autoRetryable([entry({ failure: "offline", attempts: MAX_AUTO_ATTEMPTS })]),
    ).toHaveLength(0);
    expect(
      autoRetryable([
        entry({ failure: "offline", attempts: MAX_AUTO_ATTEMPTS - 1 }),
      ]),
    ).toHaveLength(1);
  });

  it("always offers MANUAL retry, including for errors and past the ceiling", () => {
    const stuck = [
      entry({ localId: "a", failure: "error" }),
      entry({ localId: "b", failure: "offline", attempts: 99 }),
      entry({ localId: "c", failure: undefined }),
    ];
    expect(manuallyRetryable(stuck).map((e) => e.localId)).toEqual(["a", "b"]);
  });
});

describe("state transitions", () => {
  it("markSending clears the failure and counts the attempt", () => {
    const next = markSending([entry({ failure: "error", attempts: 1 })], "l1");
    expect(next[0].failure).toBeUndefined();
    expect(next[0].attempts).toBe(2);
  });

  it("markFailed records why, which is what gates auto-retry later", () => {
    expect(markFailed([entry()], "l1", "offline")[0].failure).toBe("offline");
    expect(markFailed([entry()], "l1", "error")[0].failure).toBe("error");
  });

  it("leaves other entries untouched", () => {
    const two = [entry({ localId: "a" }), entry({ localId: "b" })];
    const next = markFailed(two, "a", "error");
    expect(next[1]).toEqual(two[1]);
  });

  it("removeEntry drops exactly one", () => {
    const two = [entry({ localId: "a" }), entry({ localId: "b" })];
    expect(removeEntry(two, "a").map((e) => e.localId)).toEqual(["b"]);
  });

  it("createEntry starts with no failure and no attempts", () => {
    const e = createEntry({
      localId: "x",
      conversationId: "c1",
      text: "hi",
      now: 5,
    });
    expect(e.failure).toBeUndefined();
    expect(e.attempts).toBe(0);
    expect(e.createdAt).toBe(5);
  });
});

describe("persistence", () => {
  it("round-trips", () => {
    const entries = [entry({ failure: "error", attempts: 2 })];
    expect(deserializeOutbox(serializeOutbox(entries))).toEqual(entries);
  });

  it("survives junk instead of throwing on the inbox's critical path", () => {
    expect(deserializeOutbox(null)).toEqual([]);
    expect(deserializeOutbox("")).toEqual([]);
    expect(deserializeOutbox("not json")).toEqual([]);
    expect(deserializeOutbox('{"not":"an array"}')).toEqual([]);
    expect(deserializeOutbox("[null, 3, \"x\"]")).toEqual([]);
  });

  it("drops malformed entries but keeps the good ones beside them", () => {
    const raw = JSON.stringify([
      { localId: "ok", conversationId: "c1", text: "hi", createdAt: 1, attempts: 0 },
      { localId: "missing-text", conversationId: "c1", createdAt: 1 },
      { conversationId: "c1", text: "no id", createdAt: 1 },
      { localId: "bad-date", conversationId: "c1", text: "x", createdAt: "nope" },
    ]);
    const out = deserializeOutbox(raw);
    expect(out.map((e) => e.localId)).toEqual(["ok"]);
  });

  it("restores an entry that was mid-flight when the app was killed as an offline failure", () => {
    // Nothing is sending it any more, and the kill is itself evidence the
    // request never completed — so it becomes eligible for auto-retry
    // rather than sitting forever as a permanent 'sending' clock.
    const raw = JSON.stringify([
      { localId: "l1", conversationId: "c1", text: "hi", createdAt: 1, attempts: 1 },
    ]);
    const [restored] = deserializeOutbox(raw);
    expect(restored.failure).toBe("offline");
    expect(autoRetryable([restored])).toHaveLength(1);
  });

  it("defaults a corrupt attempt count to zero rather than dropping the message", () => {
    const raw = JSON.stringify([
      {
        localId: "l1",
        conversationId: "c1",
        text: "keep me",
        createdAt: 1,
        attempts: "lots",
      },
    ]);
    const [restored] = deserializeOutbox(raw);
    expect(restored.attempts).toBe(0);
    expect(restored.text).toBe("keep me");
  });
});

describe("draftStorageKey", () => {
  it("is per-conversation, so switching chats never shows the wrong draft", () => {
    expect(draftStorageKey("c1")).not.toBe(draftStorageKey("c2"));
    expect(draftStorageKey("c1")).toContain("c1");
  });
});
