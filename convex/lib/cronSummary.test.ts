import { describe, expect, test } from "vitest";
import {
  clampLimit,
  COMPLETED_DEFAULT_LIMIT,
  PENDING_DEFAULT_LIMIT,
  PENDING_SCAN_CAP,
  prettyFunctionName,
  RUNS_DEFAULT_LIMIT,
  summarizeSystemTasks,
  type SystemJobRow,
} from "./cronSummary";

const NOW = 1_800_000_000_000;

function row(partial: Partial<SystemJobRow> & { name: string }): SystemJobRow {
  return {
    _id: `job_${Math.abs(partial.scheduledTime ?? 0)}_${partial.name}`,
    _creationTime: partial.scheduledTime ?? NOW,
    args: [],
    scheduledTime: NOW,
    state: { kind: "pending" },
    ...partial,
  };
}

function completedRow(name: string, completedTime: number): SystemJobRow {
  return row({ name, state: { kind: "success" }, completedTime });
}

describe("prettyFunctionName", () => {
  test("strips the .js module suffix and keeps the function path", () => {
    expect(prettyFunctionName("aiReply.js:dispatchInbound")).toBe(
      "aiReply.dispatchInbound",
    );
    expect(prettyFunctionName("qualificationEngine.js:sendFollowUp")).toBe(
      "qualificationEngine.sendFollowUp",
    );
  });

  test("handles nested lib paths and names without a colon", () => {
    expect(prettyFunctionName("lib/ai/embeddings.js:embed")).toBe(
      "lib/ai/embeddings.embed",
    );
    expect(prettyFunctionName("weird")).toBe("weird");
  });
});

describe("clampLimit", () => {
  test("falls back when undefined or not a finite number", () => {
    expect(clampLimit(undefined, 8, 50)).toBe(8);
    expect(clampLimit(Number.NaN, 8, 50)).toBe(8);
    expect(clampLimit(Number.POSITIVE_INFINITY, 8, 50)).toBe(8);
  });

  test("floors fractions and clamps into [1, cap]", () => {
    expect(clampLimit(7.9, 8, 50)).toBe(7);
    expect(clampLimit(0, 8, 50)).toBe(1);
    expect(clampLimit(-3, 8, 50)).toBe(1);
    expect(clampLimit(999, 8, 50)).toBe(50);
  });
});

describe("summarizeSystemTasks", () => {
  test("splits pending (incl. inProgress) from completed and counts them", () => {
    const out = summarizeSystemTasks({
      pendingRows: [
        row({ name: "a.js:one", state: { kind: "pending" }, scheduledTime: NOW + 5_000 }),
        row({ name: "b.js:two", state: { kind: "inProgress" }, scheduledTime: NOW - 1_000 }),
      ],
      completedRows: [
        completedRow("c.js:three", NOW - 59_000),
        row({
          name: "d.js:four",
          state: { kind: "failed", error: "boom" },
          scheduledTime: NOW - 120_000,
          completedTime: NOW - 119_000,
        }),
      ],
      pendingLimit: PENDING_DEFAULT_LIMIT,
      completedLimit: COMPLETED_DEFAULT_LIMIT,
    });
    expect(out.pendingCount).toBe(2);
    expect(out.pendingOverflow).toBe(false);
    expect(out.pending.map((p) => p.name)).toEqual(["b.two", "a.one"]);
    expect(out.completed.map((c) => c.name)).toEqual(["c.three", "d.four"]);
    expect(out.completedOverflow).toBe(false);
  });

  test("sorts pending by scheduledTime ascending and completed by completedTime descending", () => {
    const out = summarizeSystemTasks({
      pendingRows: [
        row({ name: "late.js:p", state: { kind: "pending" }, scheduledTime: NOW + 30_000 }),
        row({ name: "soon.js:p", state: { kind: "pending" }, scheduledTime: NOW + 1_000 }),
      ],
      completedRows: [
        completedRow("old.js:c", NOW - 500_000),
        completedRow("new.js:c", NOW - 1_000),
      ],
      pendingLimit: 10,
      completedLimit: 10,
    });
    expect(out.pending.map((p) => p.name)).toEqual(["soon.p", "late.p"]);
    expect(out.completed.map((c) => c.name)).toEqual(["new.c", "old.c"]);
  });

  test("marks inProgress rows and carries failure errors", () => {
    const out = summarizeSystemTasks({
      pendingRows: [row({ name: "run.js:now", state: { kind: "inProgress" } })],
      completedRows: [
        row({
          name: "bad.js:job",
          state: { kind: "failed", error: "provider down" },
          completedTime: NOW,
        }),
      ],
      pendingLimit: 10,
      completedLimit: 10,
    });
    expect(out.pending[0]).toMatchObject({ name: "run.now", inProgress: true });
    expect(out.completed[0]).toMatchObject({
      name: "bad.job",
      outcome: "failed",
      error: "provider down",
    });
  });

  test("slices pending to pendingLimit but keeps the true count within the scan cap", () => {
    const out = summarizeSystemTasks({
      pendingRows: Array.from({ length: 17 }, (_, i) =>
        row({ name: `p.js:n${i}`, scheduledTime: NOW + i * 1_000 }),
      ),
      completedRows: [],
      pendingLimit: 5,
      completedLimit: 8,
    });
    expect(out.pending).toHaveLength(5);
    expect(out.pendingCount).toBe(17);
    // 17 pending exist, only 5 shown — the client still has more to reveal.
    expect(out.pendingOverflow).toBe(false);
  });

  test("caps pendingCount at the scan cap and flags overflow beyond it", () => {
    const out = summarizeSystemTasks({
      pendingRows: Array.from({ length: PENDING_SCAN_CAP + 1 }, (_, i) =>
        row({ name: `p.js:n${i}`, scheduledTime: NOW + i * 1_000 }),
      ),
      completedRows: [],
      pendingLimit: 10,
      completedLimit: 8,
    });
    expect(out.pending).toHaveLength(10);
    expect(out.pendingCount).toBe(PENDING_SCAN_CAP);
    expect(out.pendingOverflow).toBe(true);
  });

  test("slices completed to completedLimit and flags the extra probe row as overflow", () => {
    const out = summarizeSystemTasks({
      pendingRows: [],
      // Simulates take(completedLimit + 1) returning a full window.
      completedRows: Array.from({ length: 9 }, (_, i) =>
        completedRow(`done.js:n${i}`, NOW - i * 1_000),
      ),
      pendingLimit: 10,
      completedLimit: 8,
    });
    expect(out.completed).toHaveLength(8);
    expect(out.completedOverflow).toBe(true);
    expect(out.completed[0].name).toBe("done.n0");
  });

  test("defensively ignores rows whose state does not match the bucket", () => {
    const out = summarizeSystemTasks({
      pendingRows: [
        row({ name: "gone.js:x", state: { kind: "canceled" } }),
        completedRow("done.js:x", NOW),
      ],
      completedRows: [
        row({ name: "gone.js:y", state: { kind: "canceled" } }),
        row({ name: "wait.js:y", state: { kind: "pending" } }),
      ],
      pendingLimit: 10,
      completedLimit: 10,
    });
    expect(out.pending).toHaveLength(0);
    expect(out.pendingCount).toBe(0);
    expect(out.completed).toHaveLength(0);
  });

  test("default limits stay small so the panel's first paint is light", () => {
    expect(RUNS_DEFAULT_LIMIT).toBeLessThanOrEqual(10);
    expect(COMPLETED_DEFAULT_LIMIT).toBeLessThanOrEqual(10);
    expect(PENDING_DEFAULT_LIMIT).toBeLessThanOrEqual(10);
  });
});
