import { describe, expect, test } from "vitest";
import { deriveCustomerState, OFFLINE_NOTE_KINDS } from "./signals";

const note = (
  atMs: number,
  kind?: string | null,
  outcome?: string | null,
) => ({ _creationTime: atMs, kind, outcome });

describe("lastOfflineContact", () => {
  test("is the most recent note whose kind is an off-platform channel", () => {
    const state = deriveCustomerState([
      note(100, "call"),
      note(300, "meeting"),
      note(200, "email"),
    ]);
    expect(state.lastOfflineContact).toEqual({ kind: "meeting", atMs: 300 });
  });

  test("ignores general and system notes — they are not a channel", () => {
    const state = deriveCustomerState([
      note(100, "call"),
      note(500, "general"),
      note(600, null), // engine-written
    ]);
    expect(state.lastOfflineContact).toEqual({ kind: "call", atMs: 100 });
  });

  test("ignores payment notes — money is not a contact channel", () => {
    const state = deriveCustomerState([note(100, "call"), note(900, "payment")]);
    expect(state.lastOfflineContact).toEqual({ kind: "call", atMs: 100 });
  });

  test("is null when no note carries an off-platform kind", () => {
    expect(deriveCustomerState([note(1, "general")]).lastOfflineContact).toBeNull();
    expect(deriveCustomerState([]).lastOfflineContact).toBeNull();
  });

  test("OFFLINE_NOTE_KINDS is exactly the four channels", () => {
    expect([...OFFLINE_NOTE_KINDS].sort()).toEqual([
      "call",
      "email",
      "meeting",
      "whatsapp_external",
    ]);
  });
});

describe("followUpFlaggedAtMs", () => {
  test("is the creation time of the most recent follow_up note", () => {
    const state = deriveCustomerState([
      note(100, "call", "follow_up"),
      note(400, "call", "follow_up"),
      note(200, "call", "no_answer"),
    ]);
    expect(state.followUpFlaggedAtMs).toBe(400);
  });

  test("is null when no note flags a follow-up", () => {
    expect(deriveCustomerState([note(1, "call", "no_answer")]).followUpFlaggedAtMs).toBeNull();
  });
});

describe("markedNotInterested", () => {
  // Stateful on purpose: only the LATEST outcome-bearing note counts, so a
  // customer who says "not interested" and later re-engages is not
  // permanently written off.
  test("is true when the most recent outcome-bearing note is not_interested", () => {
    const state = deriveCustomerState([
      note(100, "call", "follow_up"),
      note(500, "call", "not_interested"),
    ]);
    expect(state.markedNotInterested).toBe(true);
  });

  test("is false when a LATER outcome supersedes it", () => {
    const state = deriveCustomerState([
      note(100, "call", "not_interested"),
      note(500, "call", "follow_up"),
    ]);
    expect(state.markedNotInterested).toBe(false);
  });

  test("notes without an outcome do not supersede", () => {
    const state = deriveCustomerState([
      note(100, "call", "not_interested"),
      note(900, "general"), // no outcome — must not clear the flag
    ]);
    expect(state.markedNotInterested).toBe(true);
  });

  test("is false with no notes at all", () => {
    expect(deriveCustomerState([]).markedNotInterested).toBe(false);
  });
});

describe("input robustness", () => {
  test("tolerates unrecognised kind and outcome values without throwing", () => {
    const state = deriveCustomerState([note(100, "telepathy", "vibes")]);
    expect(state.lastOfflineContact).toBeNull();
    expect(state.followUpFlaggedAtMs).toBeNull();
    expect(state.markedNotInterested).toBe(false);
  });

  test("does not depend on input ordering", () => {
    const notes = [
      note(300, "meeting"),
      note(100, "call", "not_interested"),
      note(500, "email", "follow_up"),
    ];
    const forward = deriveCustomerState(notes);
    const backward = deriveCustomerState([...notes].reverse());
    expect(forward).toEqual(backward);
  });
});
