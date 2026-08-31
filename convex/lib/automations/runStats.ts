// Pure aggregation of automationRuns rows into the numbers the UI shows.
// Dependency-free so the server query and any component test share one
// definition of what "enrolled" means — the alternative is two counts
// that disagree, which is worse than no counts at all.

export type RunStatus =
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled";

export interface RunStatusRow {
  status: string;
}

export interface RunCounts {
  /** Everyone who ever entered, whatever became of them. */
  enrolled: number;
  waiting: number;
  running: number;
  completed: number;
  failed: number;
  cancelled: number;
  /**
   * True when the read that produced these counts hit its bound
   * (`convex/automations.ts`'s `countRunsBounded` /
   * `RUN_COUNTS_STATUS_CAP`) — every figure here is then a FLOOR, not an
   * exact count. Deliberately not set by `summarizeRuns`/`emptyRunCounts`
   * below: neither knows whether the rows it was handed are the whole
   * story or a capped read, only the caller that did the reading does.
   * Optional (not a required `false`) so every existing exact-count call
   * site — and every `.toEqual()` test pinned to the plain five-field
   * shape — stays unaffected; the UI (`RunStatsBar`) treats an absent
   * value the same as `false`.
   */
  truncated?: boolean;
}

export function emptyRunCounts(): RunCounts {
  return {
    enrolled: 0,
    waiting: 0,
    running: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
  };
}

export function summarizeRuns(rows: RunStatusRow[]): RunCounts {
  const counts = emptyRunCounts();
  for (const r of rows) {
    counts.enrolled += 1;
    switch (r.status) {
      case "waiting":
        counts.waiting += 1;
        break;
      case "running":
        counts.running += 1;
        break;
      case "completed":
        counts.completed += 1;
        break;
      case "failed":
        counts.failed += 1;
        break;
      case "cancelled":
        counts.cancelled += 1;
        break;
      // An unrecognised status still counts as an enrolment. Silently
      // dropping it would make the buckets fail to sum to `enrolled`,
      // which is the kind of discrepancy nobody can debug from the UI.
      default:
        break;
    }
  }
  return counts;
}
