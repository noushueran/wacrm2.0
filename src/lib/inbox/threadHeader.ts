// Pure branching for the thread header (spec:
// docs/superpowers/specs/2026-07-28-inbox-thread-header-design.md).
// Kept out of the component because `message-thread.tsx` is not statically
// renderable, so this is the only place these rules can be tested.

export type WindowTone = "primary" | "expired" | "free";

export interface WindowSegment {
  key: "service" | "free";
  text: string;
  tone: WindowTone;
}

/**
 * The two messaging windows, as up to two segments of one pill.
 *
 * They are INDEPENDENT: the 24h customer service window governs whether a
 * free-form reply is allowed at all, the 72h free-entry-point window
 * governs whether the conversation costs money. Either can be open alone,
 * and an expired service window alongside an open free window is a normal
 * state, not a contradiction — hence no cross-segment suppression here.
 */
export function windowPill(input: {
  sessionRemaining: string;
  sessionExpired: boolean;
  freeText: string | null;
}): WindowSegment[] {
  const segments: WindowSegment[] = [];
  if (input.sessionRemaining) {
    segments.push({
      key: "service",
      text: input.sessionRemaining,
      tone: input.sessionExpired ? "expired" : "primary",
    });
  }
  if (input.freeText) {
    segments.push({ key: "free", text: input.freeText, tone: "free" });
  }
  return segments;
}

/** First letter of each of the first two words, uppercased. */
export function initials(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word.charAt(0).toUpperCase())
    .join("");
}

/**
 * The lead button's trigger text: the funnel stage, then the assignee's
 * initials. Falls back to a generic label when no stage is set, so the
 * button never renders empty.
 */
export function leadButtonLabel(input: {
  stageLabel: string | null;
  assigneeName: string | null;
  fallbackLabel: string;
}): string {
  const stage = input.stageLabel ?? input.fallbackLabel;
  const who = input.assigneeName ? initials(input.assigneeName) : "";
  return who ? `${stage} · ${who}` : stage;
}
