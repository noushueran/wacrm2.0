// ============================================================
// Pure note logic — vocabulary, classification and limits, with no
// React and no Convex import, so it is unit-testable without rendering
// and without a convex-test harness. Mirrors the structure
// `src/lib/inbox/threadHeader.ts` established: branching lives here,
// components stay presentational.
// ============================================================

export const NOTE_KINDS = [
  "call",
  "whatsapp_external",
  "meeting",
  "email",
  "payment",
  "general",
] as const;

export type NoteKind = (typeof NOTE_KINDS)[number];

export const NOTE_OUTCOMES = [
  "no_answer",
  "follow_up",
  "do_not_contact",
  "not_interested",
] as const;

export type NoteOutcome = (typeof NOTE_OUTCOMES)[number];

/** What the UI renders. `system` is never stored — it is derived for
 *  the engine-written rows that predate (and continue alongside) the
 *  hand-written ones. */
export type DisplayNoteKind = NoteKind | "system";

/** Bounded in `contactNotes.add`/`update`, mirrored in the composer so
 *  a user is told before the upload rather than after. */
export const NOTE_ATTACHMENT_MAX_COUNT = 5;

/** 25 MB. Deliberately above `MEDIA_MAX_BYTES` (16 MB): that ceiling
 *  mirrors Meta's WhatsApp caps, and a note attachment is never sent to
 *  Meta. `uploadAccountMedia` leaves size validation to its caller
 *  precisely so a feature can set its own. */
export const NOTE_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;

/**
 * Human-readable attachment size for the composer preview and the
 * thread's attachment chip (e.g. "2.4 MB", "340 KB", "512 B") — the
 * spec calls for "filename + size", and this is the "+ size" half.
 * Pure and unit-tested here rather than inlined in `NoteCard` so the
 * threshold/rounding rules have one place to live and one place to
 * test.
 *
 * Thresholds mirror the binary (1024-based) convention every OS file
 * picker already uses, so the number an agent sees here matches what
 * their own file browser showed them before they attached it.
 */
export function formatAttachmentSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
}

/**
 * The display kind for a note row, including the two legacy shapes this
 * table already holds:
 *
 *   - no `kind`, no `createdByUserId` → written by an engine (funnel,
 *     AI tagging, checklist, qualification, invitations) → `system`.
 *   - no `kind`, but an author → a human note from before this feature
 *     → `general`.
 *
 * Derived at read time on purpose: no backfill, and an engine that
 * starts stamping `kind` later needs no change here.
 */
export function noteKindOf(note: {
  kind?: NoteKind | null;
  createdByUserId?: string | null;
}): DisplayNoteKind {
  if (note.kind) return note.kind;
  return note.createdByUserId ? "general" : "system";
}

/** Key under the `Inbox.notes` namespace. */
export function noteKindI18nKey(kind: DisplayNoteKind): string {
  return `kind.${kind}`;
}

/** Key under the `Inbox.notes` namespace. */
export function noteOutcomeI18nKey(outcome: NoteOutcome): string {
  return `outcome.${outcome}`;
}

/** The minimum a row needs to be placed on the timeline. */
export interface TimelineNote {
  _id: string;
  _creationTime: number;
}

/**
 * The thread is cursor-paginated (`loadMore(30)`), so a note or event
 * older than the oldest loaded message has no message to sit beside.
 * Those are split off and rendered as a single "N earlier notes" pill at
 * the top of the loaded range rather than being silently dropped. Keyed
 * on `_creationTime`, so it works unchanged for either row shape.
 *
 * `oldestLoadedAt` is `null` when nothing is loaded or the whole history
 * is present — either way nothing can be "earlier", so everything stays
 * in the window.
 */
export function splitEarlierNotes<T extends TimelineNote>(
  notes: T[],
  oldestLoadedAt: number | null,
): { earlier: T[]; inWindow: T[] } {
  if (oldestLoadedAt === null) return { earlier: [], inWindow: notes };
  const earlier: T[] = [];
  const inWindow: T[] = [];
  for (const note of notes) {
    // `>=` — a note created in the same millisecond as the oldest
    // message belongs beside it, not above the fold.
    (note._creationTime >= oldestLoadedAt ? inWindow : earlier).push(note);
  }
  return { earlier, inWindow };
}

export type TimelineItem<M, N, E> =
  | { type: "message"; value: M }
  | { type: "note"; value: N }
  | { type: "event"; value: E };

/** A note or an ownership event, already tagged by the caller. Tagging up
 *  front rather than merging twice keeps ONE sorted pass, so a note and an
 *  event a second apart can never land in the wrong order. */
export type TimelineEntry<N, E> =
  | { type: "note"; value: N }
  | { type: "event"; value: E };

/**
 * Places each entry inside the existing date groups by timestamp, so the
 * thread reads as one story: customer said X, the chat came to me, I
 * called and they said Y, I sent the quote.
 *
 * Entries are assigned to a group rather than re-grouped by their own date
 * on purpose — the caller already owns date bucketing and its separators,
 * and duplicating that here would let the two drift. An entry newer than
 * every message lands in the last group; older than every message, the
 * first; with no messages at all, its own single group.
 */
export function mergeTimelineEntries<
  M,
  N extends TimelineNote,
  E extends TimelineNote,
  G extends { date: string; messages: M[] },
>(
  groups: G[],
  entries: Array<TimelineEntry<N, E>>,
  getMessageTime: (message: M) => number,
): Array<{ date: string; items: Array<TimelineItem<M, N, E>> }> {
  const sorted = [...entries].sort(
    (a, b) => a.value._creationTime - b.value._creationTime,
  );

  if (groups.length === 0) {
    if (sorted.length === 0) return [];
    return [{ date: "", items: sorted }];
  }

  const base = groups.map((group) => ({
    date: group.date,
    items: group.messages.map((value) => ({ type: "message" as const, value })),
  })) as Array<{ date: string; items: Array<TimelineItem<M, N, E>> }>;

  for (const entry of sorted) {
    // The last group whose first message starts at or before the entry.
    let target = 0;
    for (let i = 0; i < groups.length; i++) {
      const first = groups[i].messages[0];
      if (
        first !== undefined &&
        getMessageTime(first) <= entry.value._creationTime
      ) {
        target = i;
      }
    }

    const items = base[target].items;
    const at = items.findIndex(
      (item) =>
        item.type === "message" &&
        getMessageTime(item.value) > entry.value._creationTime,
    );
    if (at === -1) items.push(entry);
    else items.splice(at, 0, entry);
  }

  return base;
}
