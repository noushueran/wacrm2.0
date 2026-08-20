// ============================================================
// Lane derivation + the board's sort key. Both are PURE and computed at
// read time, never stored: a lead going stale must change position with
// no LLM call and no write. `leadLane` is the safety primitive the whole
// automation rests on — a customer waiting on US is never sequenced and
// never archived (see the spec's Principle section).
// ============================================================

export type LeadLane = "awaiting_us" | "awaiting_them";

/**
 * Who owes the next message. A thread with no messages at all is
 * conservatively "awaiting us" — the lane that is never automated
 * against — so an unexpected empty thread can never be nudged.
 */
export function leadLane(
  lastSenderType: "customer" | "agent" | "bot" | null,
): LeadLane {
  return lastSenderType === "customer" || lastSenderType === null
    ? "awaiting_us"
    : "awaiting_them";
}

export interface PriorityInput {
  score: number | null;
  lane: LeadLane;
  lastMessageAt: number | null;
}

const LANE_RANK: Record<LeadLane, number> = {
  awaiting_us: 0,
  awaiting_them: 1,
};

/**
 * Board order: score desc (unscored last), then awaiting-us first, then
 * most recent activity first. Usable directly as an Array#sort
 * comparator.
 */
export function comparePriority(a: PriorityInput, b: PriorityInput): number {
  // -1 sorts an unscored lead below score 1 without special-casing.
  const byScore = (b.score ?? -1) - (a.score ?? -1);
  if (byScore !== 0) return byScore;

  const byLane = LANE_RANK[a.lane] - LANE_RANK[b.lane];
  if (byLane !== 0) return byLane;

  return (b.lastMessageAt ?? -1) - (a.lastMessageAt ?? -1);
}
