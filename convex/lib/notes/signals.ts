// ============================================================
// Distils a contact's notes into a FIXED-VOCABULARY summary safe to put
// in front of the customer-facing reply model.
//
// The safety property is the TYPE, not a review rule: `CustomerState`
// has no string field an agent can write into, so no agent-authored
// prose can reach a prompt built from it. `convex/aiReply.ts`'s own
// comment (the `audience: "internal"` filter) explains why that matters
// — the model cannot self-censor, so the only reliable filter is one
// that runs before the model sees anything.
//
// Raw note text goes only to `buildScoreSystemPrompt`, whose output an
// agent reads and a customer never does.
// ============================================================

/** The channels that mean "someone actually spoke to this customer off
 *  this platform". `payment` and `general` are deliberately excluded:
 *  they record a fact, not a contact event. */
export const OFFLINE_NOTE_KINDS = [
  "call",
  "whatsapp_external",
  "meeting",
  "email",
] as const;

export type OfflineNoteKind = (typeof OFFLINE_NOTE_KINDS)[number];

/** The minimum a note row needs to be distilled. Deliberately typed with
 *  loose `string` fields rather than the schema's unions: this runs over
 *  rows written by five different engines across two years of history,
 *  and an unrecognised value must be ignored, never throw. */
export interface NoteSignalInput {
  _creationTime: number;
  kind?: string | null;
  outcome?: string | null;
}

export interface CustomerState {
  /** The most recent off-platform contact, or null. */
  lastOfflineContact: { kind: OfflineNoteKind; atMs: number } | null;
  /** When an agent last flagged "follow up later". The note carries no
   *  target date — only that the flag was raised, and when. */
  followUpFlaggedAtMs: number | null;
  /** Whether the LATEST outcome-bearing note says not-interested. Stateful
   *  on purpose: a customer who cools off and later re-engages must not be
   *  permanently written off by one old note. */
  markedNotInterested: boolean;
}

function isOfflineKind(kind: string | null | undefined): kind is OfflineNoteKind {
  return (OFFLINE_NOTE_KINDS as readonly string[]).includes(kind ?? "");
}

/**
 * Pure, order-independent. Callers pass whatever they have; this sorts
 * defensively rather than trusting the query's order, so a change to a
 * caller's `.order()` cannot silently invert the meaning of "latest".
 */
export function deriveCustomerState(notes: NoteSignalInput[]): CustomerState {
  const byNewest = [...notes].sort((a, b) => b._creationTime - a._creationTime);

  const offline = byNewest.find((n) => isOfflineKind(n.kind));
  const followUp = byNewest.find((n) => n.outcome === "follow_up");
  const latestOutcome = byNewest.find((n) => !!n.outcome);

  return {
    lastOfflineContact: offline
      ? { kind: offline.kind as OfflineNoteKind, atMs: offline._creationTime }
      : null,
    followUpFlaggedAtMs: followUp ? followUp._creationTime : null,
    markedNotInterested: latestOutcome?.outcome === "not_interested",
  };
}
