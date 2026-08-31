// ============================================================
// Pure sentence selection for one ownership event: which i18n key, and
// which names fill it. No React and no Convex import, so the branching
// is unit-testable without rendering — the same split
// `src/lib/inbox/notes.ts` and `threadHeader.ts` established.
// ============================================================

export type AssignmentEventSource =
  | "manual"
  | "takeover"
  | "release"
  | "auto_assign"
  | "automation"
  | "offer_accept";

/** Exactly the fields `conversations.listEvents` projects that the
 *  sentence depends on. */
export interface AssignmentEventView {
  kind: "assigned" | "unassigned";
  source: AssignmentEventSource;
  actorUserId: string | null;
  targetUserId: string | null;
  actorName: string | null;
  targetName: string | null;
  previousName: string | null;
}

/** Stand-in for a member who has left the account — `listEvents` returns
 *  a null name for them. The component swaps this for a translated word;
 *  it is a sentinel rather than English so this module stays language-free. */
export const UNKNOWN_MEMBER = "__unknown__";

const name = (value: string | null) => value ?? UNKNOWN_MEMBER;

/** Key under the `Inbox.assignmentEvents` namespace, plus its values. */
export function assignmentEventLine(event: AssignmentEventView): {
  key: string;
  values: Record<string, string>;
} {
  if (event.kind === "unassigned") {
    // Resume AI released the thread — nobody handed it anywhere.
    if (event.source === "release") {
      return { key: "released", values: { previous: name(event.previousName) } };
    }
    return {
      key: "unassigned",
      values: { actor: name(event.actorName), previous: name(event.previousName) },
    };
  }

  // System paths have no actor, and each names its own machinery rather
  // than pretending a person did it.
  if (event.source === "auto_assign") {
    return { key: "autoAssigned", values: { target: name(event.targetName) } };
  }
  if (event.source === "automation") {
    return { key: "automationAssigned", values: { target: name(event.targetName) } };
  }
  if (event.source === "offer_accept") {
    return { key: "offerAccepted", values: { target: name(event.targetName) } };
  }

  // Somebody held this chat before — say who lost it, whichever path
  // moved it. Checked ahead of both self-assignment sentences because
  // neither can carry a third name: "took over from the AI" is untrue
  // when a colleague (not the AI) had it, and "took this chat" silently
  // drops the person it was taken from. `reassigned` is the only line
  // that names all three, so it wins whenever there is a third name.
  if (event.previousName) {
    return {
      key: "reassigned",
      values: {
        actor: name(event.actorName),
        target: name(event.targetName),
        previous: event.previousName,
      },
    };
  }

  if (event.source === "takeover") {
    return { key: "takeover", values: { actor: name(event.actorName) } };
  }

  // Manual. Claiming a chat nobody held is "took", not "assigned to".
  if (event.actorUserId && event.actorUserId === event.targetUserId) {
    return { key: "selfAssigned", values: { actor: name(event.actorName) } };
  }
  return {
    key: "assigned",
    values: { actor: name(event.actorName), target: name(event.targetName) },
  };
}
