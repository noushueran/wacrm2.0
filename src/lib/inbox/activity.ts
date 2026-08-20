// ============================================================
// Pure activity-feed logic. No React, no Convex — same shape as
// `src/lib/inbox/notes.ts`, so the branching is testable without a
// rendering harness.
// ============================================================

export type ActivityFilter = "all" | "notes";

/** Non-mutating. The query already returns newest-first; every helper
 *  here preserves that order rather than re-sorting, so the two cannot
 *  disagree about what "newest" means. */
export function filterActivity<T extends { kind: string }>(
  entries: T[],
  filter: ActivityFilter,
): T[] {
  if (filter === "all") return entries;
  return entries.filter((entry) => entry.kind === "note");
}

/** Key under the `Inbox.activity` namespace. */
export function stageI18nKey(stage: string): string {
  return `stage.${stage}`;
}

/** Buckets by LOCAL calendar day, not UTC. The entries beside the header
 *  (`contact-activity.tsx`) are already formatted in the reader's local
 *  time, via `date-fns`'s default local `format`; bucketing by UTC day
 *  made the header disagree with the rows directly beneath it whenever
 *  an event fell in the offset window between UTC midnight and the
 *  reader's local midnight (up to 5.5 hours in India, 4 in Dubai) — an
 *  event at 2026-07-30T22:00Z would bucket to "30" but its own row would
 *  read "Jul 31, 02:00" in Dubai. An earlier version of this function
 *  bucketed by UTC deliberately, reasoning that a bucket which shifts
 *  with the reader's clock makes "which day did that happen" unanswerable
 *  across offices — but the timestamps beside the header are already
 *  local, so UTC bucketing bought no cross-office stability, only this
 *  internal disagreement. Internal consistency wins.
 *
 *  The day string is a plain `YYYY-MM-DD` built from local
 *  `getFullYear`/`getMonth`/`getDate` — it exists only as a stable
 *  grouping key (and React `key`), NOT for the component to re-parse:
 *  `new Date("YYYY-MM-DD")` parses as UTC midnight, which would
 *  reintroduce this exact bug. The component instead formats the
 *  group's header from an entry's own `at` timestamp. */
export function groupActivityByDay<T extends { at: number }>(
  entries: T[],
): Array<{ day: string; entries: T[] }> {
  const groups: Array<{ day: string; entries: T[] }> = [];
  for (const entry of entries) {
    const d = new Date(entry.at);
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.entries.push(entry);
    else groups.push({ day, entries: [entry] });
  }
  return groups;
}
