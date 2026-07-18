/**
 * Pure helpers for the Settings → Cron schedules panel.
 *
 * `CRON_REGISTRY` mirrors the interval crons registered in
 * `convex/crons.ts` — the registry is what the panel renders, and the
 * wrapper actions in `convex/cronSchedules.ts` stamp run history under
 * these exact names, so keep all three in sync when adding a cron.
 *
 * `summarizeScheduledFunctions` is kept pure (no ctx) because
 * convex-test does not emulate `ctx.db.system`; the query shell stays
 * thin and this transformation carries the unit tests.
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
  pendingCount: number;
  completed: CompletedTask[];
}

/** "aiReply.js:dispatchInbound" → "aiReply.dispatchInbound". */
export function prettyFunctionName(raw: string): string {
  return raw.replace(".js:", ".");
}

const MAX_PENDING = 50;
const MAX_COMPLETED = 25;

export function summarizeScheduledFunctions(
  rows: SystemJobRow[],
): SystemTasksSummary {
  const pendingRows = rows.filter(
    (r) => r.state.kind === "pending" || r.state.kind === "inProgress",
  );
  const pending = pendingRows
    .sort((a, b) => a.scheduledTime - b.scheduledTime)
    .slice(0, MAX_PENDING)
    .map((r) => ({
      id: r._id,
      name: prettyFunctionName(r.name),
      scheduledTime: r.scheduledTime,
      inProgress: r.state.kind === "inProgress",
    }));

  const completed = rows
    .filter((r) => r.state.kind === "success" || r.state.kind === "failed")
    .sort((a, b) => (b.completedTime ?? 0) - (a.completedTime ?? 0))
    .slice(0, MAX_COMPLETED)
    .map((r) => ({
      id: r._id,
      name: prettyFunctionName(r.name),
      completedTime: r.completedTime ?? null,
      outcome: (r.state.kind === "failed" ? "failed" : "success") as
        | "success"
        | "failed",
      error: r.state.kind === "failed" ? r.state.error : null,
    }));

  return { pending, pendingCount: pendingRows.length, completed };
}
