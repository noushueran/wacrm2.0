import { describe, expect, test } from "vitest";
import {
  NOTE_KINDS,
  NOTE_OUTCOMES,
  NOTE_ATTACHMENT_MAX_COUNT,
  NOTE_ATTACHMENT_MAX_BYTES,
  noteKindOf,
  noteKindI18nKey,
  noteOutcomeI18nKey,
  splitEarlierNotes,
  mergeTimelineEntries,
  formatAttachmentSize,
} from "./notes";

describe("noteKindOf", () => {
  test("returns the explicit kind when the note carries one", () => {
    expect(noteKindOf({ kind: "call", createdByUserId: "u1" })).toBe("call");
  });

  // The two legacy shapes this table already contains. Neither is
  // rewritten — the display kind is derived at read time.
  test("classifies an engine-written row (no kind, no author) as system", () => {
    expect(noteKindOf({})).toBe("system");
    expect(noteKindOf({ createdByUserId: null })).toBe("system");
  });

  test("classifies a legacy human note (no kind, but an author) as general", () => {
    expect(noteKindOf({ createdByUserId: "u1" })).toBe("general");
  });

  test("an explicit kind wins even without an author", () => {
    expect(noteKindOf({ kind: "payment" })).toBe("payment");
  });
});

describe("i18n keys", () => {
  test("every kind including system has a key, and they are unique", () => {
    const keys = [...NOTE_KINDS, "system" as const].map(noteKindI18nKey);
    expect(keys).toHaveLength(7);
    expect(new Set(keys).size).toBe(7);
    expect(keys.every((k) => k.startsWith("kind."))).toBe(true);
  });

  test("every outcome has a unique key", () => {
    const keys = NOTE_OUTCOMES.map(noteOutcomeI18nKey);
    expect(keys).toHaveLength(4);
    expect(new Set(keys).size).toBe(4);
    expect(keys.every((k) => k.startsWith("outcome."))).toBe(true);
  });
});

describe("attachment limits", () => {
  test("are the values the mutation and the composer both enforce", () => {
    expect(NOTE_ATTACHMENT_MAX_COUNT).toBe(5);
    expect(NOTE_ATTACHMENT_MAX_BYTES).toBe(26_214_400);
  });
});

describe("formatAttachmentSize", () => {
  test("formats sub-KB sizes in bytes", () => {
    expect(formatAttachmentSize(0)).toBe("0 B");
    expect(formatAttachmentSize(512)).toBe("512 B");
    expect(formatAttachmentSize(1023)).toBe("1023 B");
  });

  test("formats KB with one decimal below 10, none at or above", () => {
    expect(formatAttachmentSize(1024)).toBe("1.0 KB");
    expect(formatAttachmentSize(1536)).toBe("1.5 KB");
    expect(formatAttachmentSize(10 * 1024)).toBe("10 KB");
    expect(formatAttachmentSize(500 * 1024)).toBe("500 KB");
  });

  test("formats MB with one decimal below 10, none at or above", () => {
    expect(formatAttachmentSize(2.4 * 1024 * 1024)).toBe("2.4 MB");
    expect(formatAttachmentSize(10 * 1024 * 1024)).toBe("10 MB");
    // NOTE_ATTACHMENT_MAX_BYTES itself — the ceiling a real chip renders.
    expect(formatAttachmentSize(NOTE_ATTACHMENT_MAX_BYTES)).toBe("25 MB");
  });

  test("treats a negative or non-finite input as 0 B rather than throwing", () => {
    expect(formatAttachmentSize(-5)).toBe("0 B");
    expect(formatAttachmentSize(NaN)).toBe("0 B");
    expect(formatAttachmentSize(Infinity)).toBe("0 B");
  });
});

const note = (id: string, at: number) => ({ _id: id, _creationTime: at });
const message = (id: string, at: number) => ({ id, created_at: at });
const timeOf = (m: { created_at: number }) => m.created_at;

describe("splitEarlierNotes", () => {
  test("parks notes older than the loaded window in `earlier`", () => {
    const notes = [note("a", 100), note("b", 500), note("c", 900)];
    const { earlier, inWindow } = splitEarlierNotes(notes, 400);
    expect(earlier.map((n) => n._id)).toEqual(["a"]);
    expect(inWindow.map((n) => n._id)).toEqual(["b", "c"]);
  });

  test("a note exactly at the boundary stays in the window", () => {
    const { earlier, inWindow } = splitEarlierNotes([note("a", 400)], 400);
    expect(earlier).toHaveLength(0);
    expect(inWindow).toHaveLength(1);
  });

  // The whole history is loaded, so nothing can be "earlier".
  test("keeps everything in the window when there is no oldest message", () => {
    const { earlier, inWindow } = splitEarlierNotes(
      [note("a", 100), note("b", 900)],
      null,
    );
    expect(earlier).toHaveLength(0);
    expect(inWindow).toHaveLength(2);
  });
});

describe("mergeTimelineEntries — note-only inputs (migrated from mergeNotesIntoGroups)", () => {
  test("interleaves notes with messages by time inside each date group", () => {
    const groups = [
      { date: "2026-07-28", messages: [message("m1", 10), message("m2", 30)] },
      { date: "2026-07-29", messages: [message("m3", 50)] },
    ];
    const notes = [note("n1", 20), note("n2", 60)];

    const merged = mergeTimelineEntries(
      groups,
      notes.map((value) => ({ type: "note" as const, value })),
      timeOf,
    );

    expect(merged[0].items.map((i) => i.type)).toEqual([
      "message",
      "note",
      "message",
    ]);
    expect(merged[1].items.map((i) => i.type)).toEqual(["message", "note"]);
  });

  test("puts a note into the LAST group when it is newer than every message", () => {
    const groups = [{ date: "2026-07-29", messages: [message("m1", 10)] }];
    const merged = mergeTimelineEntries(
      groups,
      [{ type: "note" as const, value: note("n1", 999) }],
      timeOf,
    );
    expect(merged[0].items.map((i) => i.type)).toEqual(["message", "note"]);
  });

  test("puts a note into the FIRST group when it is older than every message", () => {
    const groups = [{ date: "2026-07-29", messages: [message("m1", 500)] }];
    const merged = mergeTimelineEntries(
      groups,
      [{ type: "note" as const, value: note("n1", 1) }],
      timeOf,
    );
    expect(merged[0].items.map((i) => i.type)).toEqual(["note", "message"]);
  });

  test("returns a note-only group when there are no messages at all", () => {
    const merged = mergeTimelineEntries(
      [],
      [{ type: "note" as const, value: note("n1", 5) }],
      timeOf,
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].items).toHaveLength(1);
    expect(merged[0].items[0].type).toBe("note");
    // Pins the contract `message-thread.tsx` depends on: a note-only
    // group's `date` is the empty string, which the render side must
    // treat as "no date separator" rather than feeding into
    // `new Date("")` (an Invalid Date `date-fns`'s `format` throws on).
    expect(merged[0].date).toBe("");
  });

  test("leaves groups untouched when there are no notes", () => {
    const groups = [{ date: "2026-07-29", messages: [message("m1", 10)] }];
    const merged = mergeTimelineEntries(groups, [], timeOf);
    expect(merged[0].items.map((i) => i.type)).toEqual(["message"]);
  });

  // Ledger finding "Task 6 minor (b)": the target-selection loop only
  // considers `groups[i].messages[0]`, so a group with an empty
  // `messages` array is invisible to it (`first !== undefined` guards
  // it out of ever setting `target = i`). A note whose time falls
  // inside that empty group's date range is misattributed to the
  // nearest earlier group with a message instead — pinned here as
  // documented behavior rather than fixed, since `groupMessagesByDate`
  // never actually produces an empty-messages group in practice (every
  // group starts life with the message that caused it to be pushed).
  test("a group with an empty `messages` array is invisible to the selection loop", () => {
    const groups = [
      { date: "2026-07-28", messages: [message("m1", 10)] },
      { date: "2026-07-29", messages: [] as ReturnType<typeof message>[] },
      { date: "2026-07-30", messages: [message("m2", 1000)] },
    ];
    // Chronologically belongs in the empty middle group (10 < 500 < 1000).
    const merged = mergeTimelineEntries(
      groups,
      [{ type: "note" as const, value: note("n1", 500) }],
      timeOf,
    );
    // The empty group never receives it...
    expect(merged[1].items).toHaveLength(0);
    // ...it lands appended to the earlier group instead.
    expect(merged[0].items.map((i) => i.type)).toEqual(["message", "note"]);
    expect(merged[2].items.map((i) => i.type)).toEqual(["message"]);
  });
});

describe("mergeTimelineEntries", () => {
  const msg = (t: number) => ({ id: `m${t}`, at: t });
  const at = (m: { at: number }) => m.at;
  const note = (t: number) => ({ _id: `n${t}`, _creationTime: t });
  const evt = (t: number) => ({ _id: `e${t}`, _creationTime: t });

  test("places a note and an event in timestamp order between messages", () => {
    const groups = [{ date: "d1", messages: [msg(10), msg(40)] }];
    const out = mergeTimelineEntries(
      groups,
      [
        { type: "event" as const, value: evt(30) },
        { type: "note" as const, value: note(20) },
      ],
      at,
    );
    expect(out[0].items.map((i) => i.type)).toEqual([
      "message", "note", "event", "message",
    ]);
  });

  // The mirror image of the test above, and the one that actually pins
  // the single-sorted-pass design: every other fixture here happens to
  // put the note first, so a regression to "merge all notes, then all
  // events" would still pass them. This one fails the moment the two
  // sources stop being sorted together.
  test("an event BEFORE a note keeps that order — one sorted pass, not two merges", () => {
    const groups = [{ date: "d1", messages: [msg(10), msg(40)] }];
    const out = mergeTimelineEntries(
      groups,
      [
        { type: "note" as const, value: note(30) },
        { type: "event" as const, value: evt(20) },
      ],
      at,
    );
    expect(out[0].items.map((i) => i.type)).toEqual([
      "message", "event", "note", "message",
    ]);
  });

  test("an entry newer than every message lands last in the final group", () => {
    const groups = [
      { date: "d1", messages: [msg(10)] },
      { date: "d2", messages: [msg(100)] },
    ];
    const out = mergeTimelineEntries(
      groups, [{ type: "event" as const, value: evt(500) }], at,
    );
    expect(out[1].items.map((i) => i.type)).toEqual(["message", "event"]);
  });

  test("an entry older than every message lands first in the first group", () => {
    const groups = [{ date: "d1", messages: [msg(100)] }];
    const out = mergeTimelineEntries(
      groups, [{ type: "event" as const, value: evt(5) }], at,
    );
    expect(out[0].items.map((i) => i.type)).toEqual(["event", "message"]);
  });

  test("with no messages at all, entries form one dateless group in order", () => {
    const out = mergeTimelineEntries(
      [],
      [
        { type: "event" as const, value: evt(20) },
        { type: "note" as const, value: note(10) },
      ],
      at,
    );
    expect(out).toHaveLength(1);
    expect(out[0].date).toBe("");
    expect(out[0].items.map((i) => i.type)).toEqual(["note", "event"]);
  });

  // Same guard as above for the group `mergeTimelineEntries` builds
  // itself: with no messages there is nothing to interleave against, so
  // the sort is the ONLY thing deciding the order.
  test("in the dateless group an older event still precedes a newer note", () => {
    const out = mergeTimelineEntries(
      [],
      [
        { type: "note" as const, value: note(20) },
        { type: "event" as const, value: evt(10) },
      ],
      at,
    );
    expect(out).toHaveLength(1);
    expect(out[0].date).toBe("");
    expect(out[0].items.map((i) => i.type)).toEqual(["event", "note"]);
  });

  test("no entries leaves the groups untouched", () => {
    const groups = [{ date: "d1", messages: [msg(10), msg(20)] }];
    const out = mergeTimelineEntries(groups, [], at);
    expect(out[0].items.map((i) => i.type)).toEqual(["message", "message"]);
  });

  test("entries sharing a timestamp with a message sit after it", () => {
    const groups = [{ date: "d1", messages: [msg(10), msg(20)] }];
    const out = mergeTimelineEntries(
      groups, [{ type: "event" as const, value: evt(10) }], at,
    );
    expect(out[0].items.map((i) => i.type)).toEqual(["message", "event", "message"]);
  });
});
