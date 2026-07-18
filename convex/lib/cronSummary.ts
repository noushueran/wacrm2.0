/**
 * Pure helpers for the Settings → Cron schedules panel.
 *
 * `CRON_REGISTRY` mirrors the interval crons registered in
 * `convex/crons.ts` — the registry is what the panel renders, and the
 * wrapper actions in `convex/cronSchedules.ts` stamp run history under
 * these exact names, so keep all three in sync when adding a cron
 * (`cronSchedules.test.ts` asserts the sync against crons.ts itself).
 *
 * `summarizeSystemTasks` is kept pure (no ctx) because convex-test does
 * not emulate `ctx.db.system`; the query shell stays thin and this
 * transformation carries the unit tests.
 *
 * The panel loads bounded slices — small defaults, "Show more" bumps
 * the limit — so opening Settings → Cron schedules never ships the
 * whole 7-day history over the wire. Those limits bound the *payload*;
 * `SYSTEM_SCAN_WINDOW` below bounds the *scan*, which is a separate
 * problem and the one that actually took the panel down.
 */

export const CRON_REGISTRY = [
  { name: "retry-ad-resolution", intervalMinutes: 60 },
  { name: "retry-conversion-events", intervalMinutes: 15 },
  { name: "qualification-follow-ups", intervalMinutes: 5 },
  { name: "qualification-lead-offers", intervalMinutes: 5 },
  { name: "qualification-staff-loops", intervalMinutes: 60 },
] as const;

export type CronName = (typeof CRON_REGISTRY)[number]["name"];

/** Shape of a `_scheduled_functions` system document (convex 1.42). */
export interface SystemJobRow {
  _id: string;
  _creationTime: number;
  name: string;
  args: unknown[];
  scheduledTime: number;
  completedTime?: number;
  state:
    | { kind: "pending" }
    | { kind: "inProgress" }
    | { kind: "success" }
    | { kind: "failed"; error: string }
    | { kind: "canceled" };
}

export interface PendingTask {
  id: string;
  name: string;
  scheduledTime: number;
  inProgress: boolean;
}

export interface CompletedTask {
  id: string;
  name: string;
  completedTime: number | null;
  outcome: "success" | "failed";
  error: string | null;
}

/** What the single bounded read actually covered — see SYSTEM_SCAN_WINDOW. */
export interface SystemTaskWindow {
  /** Documents read from `_scheduled_functions` on this pass. */
  scanned: number;
  /** The window filled up: older jobs exist that were never examined. */
  truncated: boolean;
  /** `_creationTime` of the oldest job examined; null when nothing was read. */
  oldestCreationTime: number | null;
}

export interface SystemTasksSummary {
  pending: PendingTask[];
  /** True pending total, capped at PENDING_SCAN_CAP (render "50+" on overflow). */
  pendingCount: number;
  pendingOverflow: boolean;
  completed: CompletedTask[];
  /** More completed rows exist beyond `completed` — offer "Show more". */
  completedOverflow: boolean;
  /**
   * Every count above describes the scanned window, not the whole table.
   * When `truncated` the panel must say so rather than imply completeness.
   */
  window: SystemTaskWindow;
}

/** "aiReply.js:dispatchInbound" → "aiReply.dispatchInbound". */
export function prettyFunctionName(raw: string): string {
  return raw.replace(".js:", ".");
}

// Client-driven list limits. Defaults keep the first paint to a handful
// of rows per list; "Show more" re-queries with a bigger limit, capped
// so no click can request an unbounded payload.
export const RUNS_DEFAULT_LIMIT = 8;
export const RUNS_CAP = 50;
export const COMPLETED_DEFAULT_LIMIT = 8;
export const COMPLETED_CAP = 100;
export const PENDING_DEFAULT_LIMIT = 10;
export const PENDING_SCAN_CAP = 50;

/**
 * How many `_scheduled_functions` documents one `listSystemTasks` pass
 * may read. Both lists are split out of this single newest-first window.
 *
 * It CANNOT be replaced by a filtered query. `_scheduled_functions` is a
 * system table, so it cannot carry a custom index, and Convex's
 * `.filter()` does not reduce the documents a query scans — `.take(n)`
 * stops after n *matches*, not n reads. So
 * `.filter(state.kind === "pending").take(51)` walks the ENTIRE table
 * whenever fewer than 51 rows match, which is the normal case: pending
 * jobs are mostly sub-second, so production held 4,893 rows and zero
 * pending ones. That scan tripped Convex's 4,096-document read limit and
 * took the panel down on every load (2026-07-18). An unfiltered
 * `.take(SYSTEM_SCAN_WINDOW)` reads exactly this many documents no
 * matter how large the table grows.
 *
 * The price of that bound is coverage: roughly
 * SYSTEM_SCAN_WINDOW ÷ (rows added per hour). At the ~26 rows/hour this
 * deployment generates, 1024 rows ≈ 12 hours, so a job scheduled days
 * out is invisible until it nears its run time. `window.truncated` makes
 * the panel say that instead of implying the list is complete. Raising
 * this buys coverage and costs reads on every re-run (the query is a
 * live subscription over a table the schedulers write constantly) —
 * keep it well clear of 4,096.
 */
export const SYSTEM_SCAN_WINDOW = 1024;

/** Floor + clamp a client-supplied limit into [1, cap]; fall back on junk. */
export function clampLimit(
  value: number | undefined,
  fallback: number,
  cap: number,
): number {
  const n = Number.isFinite(value) ? Math.floor(value as number) : fallback;
  return Math.min(cap, Math.max(1, n));
}

export function summarizeSystemTasks(input: {
  /**
   * One unfiltered window of `_scheduled_functions` rows — at most
   * SYSTEM_SCAN_WINDOW documents, newest-first. Both lists are split out
   * of this single read; see SYSTEM_SCAN_WINDOW for why the split cannot
   * happen in the query.
   */
  rows: SystemJobRow[];
  pendingLimit: number;
  completedLimit: number;
}): SystemTasksSummary {
  // Bucket by state here rather than in the query. `canceled` rows match
  // neither bucket and are simply dropped.
  const pendingRows = input.rows.filter(
    (r) => r.state.kind === "pending" || r.state.kind === "inProgress",
  );
  const pending = pendingRows
    .sort((a, b) => a.scheduledTime - b.scheduledTime)
    .slice(0, input.pendingLimit)
    .map((r) => ({
      id: r._id,
      name: prettyFunctionName(r.name),
      scheduledTime: r.scheduledTime,
      inProgress: r.state.kind === "inProgress",
    }));

  const completedRows = input.rows.filter(
    (r) => r.state.kind === "success" || r.state.kind === "failed",
  );
  const completed = completedRows
    .sort((a, b) => (b.completedTime ?? 0) - (a.completedTime ?? 0))
    .slice(0, input.completedLimit)
    .map((r) => ({
      id: r._id,
      name: prettyFunctionName(r.name),
      completedTime: r.completedTime ?? null,
      outcome: (r.state.kind === "failed" ? "failed" : "success") as
        | "success"
        | "failed",
      error: r.state.kind === "failed" ? r.state.error : null,
    }));

  // Order-agnostic on purpose: the transform never assumes the query
  // handed rows over sorted, so a future caller cannot silently break it.
  const oldestCreationTime = input.rows.reduce<number | null>(
    (min, r) => (min === null || r._creationTime < min ? r._creationTime : min),
    null,
  );

  return {
    pending,
    pendingCount: Math.min(pendingRows.length, PENDING_SCAN_CAP),
    pendingOverflow: pendingRows.length > PENDING_SCAN_CAP,
    completed,
    completedOverflow: completedRows.length > input.completedLimit,
    window: {
      scanned: input.rows.length,
      truncated: input.rows.length >= SYSTEM_SCAN_WINDOW,
      oldestCreationTime,
    },
  };
}
