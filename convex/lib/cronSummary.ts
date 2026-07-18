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
 * whole 7-day history over the wire.
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

export interface SystemTasksSummary {
  pending: PendingTask[];
  /** True pending total, capped at PENDING_SCAN_CAP (render "50+" on overflow). */
  pendingCount: number;
  pendingOverflow: boolean;
  completed: CompletedTask[];
  /** More completed rows exist beyond `completed` — offer "Show more". */
  completedOverflow: boolean;
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
  /** Pending/inProgress rows, any order, at most PENDING_SCAN_CAP + 1. */
  pendingRows: SystemJobRow[];
  /** Completed rows newest-first, at most completedLimit + 1 (overflow probe). */
  completedRows: SystemJobRow[];
  pendingLimit: number;
  completedLimit: number;
}): SystemTasksSummary {
  // Re-filter defensively so the summary never depends on the query
  // predicates staying in sync with this transform.
  const pendingRows = input.pendingRows.filter(
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

  const completedRows = input.completedRows.filter(
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

  return {
    pending,
    pendingCount: Math.min(pendingRows.length, PENDING_SCAN_CAP),
    pendingOverflow: pendingRows.length > PENDING_SCAN_CAP,
    completed,
    completedOverflow: completedRows.length > input.completedLimit,
  };
}
