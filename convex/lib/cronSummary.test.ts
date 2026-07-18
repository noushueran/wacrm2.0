import { describe, expect, test } from "vitest";
import {
  prettyFunctionName,
  summarizeScheduledFunctions,
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

describe("summarizeScheduledFunctions", () => {
  test("splits pending (incl. inProgress) from completed and counts them", () => {
    const rows: SystemJobRow[] = [
      row({ name: "a.js:one", state: { kind: "pending" }, scheduledTime: NOW + 5_000 }),
      row({ name: "b.js:two", state: { kind: "inProgress" }, scheduledTime: NOW - 1_000 }),
      row({
        name: "c.js:three",
        state: { kind: "success" },
        scheduledTime: NOW - 60_000,
        completedTime: NOW - 59_000,
      }),
      row({
        name: "d.js:four",
        state: { kind: "failed", error: "boom" },
        scheduledTime: NOW - 120_000,
        completedTime: NOW - 119_000,
      }),
    ];
    const out = summarizeScheduledFunctions(rows);
    expect(out.pendingCount).toBe(2);
    expect(out.pending.map((p) => p.name)).toEqual(["b.two", "a.one"]);
    expect(out.completed.map((c) => c.name)).toEqual(["c.three", "d.four"]);
  });

  test("sorts pending by scheduledTime ascending and completed by completedTime descending", () => {
    const rows: SystemJobRow[] = [
      row({ name: "late.js:p", state: { kind: "pending" }, scheduledTime: NOW + 30_000 }),
      row({ name: "soon.js:p", state: { kind: "pending" }, scheduledTime: NOW + 1_000 }),
      row({
        name: "old.js:c",
        state: { kind: "success" },
        completedTime: NOW - 500_000,
      }),
      row({
        name: "new.js:c",
        state: { kind: "success" },
        completedTime: NOW - 1_000,
      }),
    ];
    const out = summarizeScheduledFunctions(rows);
    expect(out.pending.map((p) => p.name)).toEqual(["soon.p", "late.p"]);
    expect(out.completed.map((c) => c.name)).toEqual(["new.c", "old.c"]);
  });

  test("marks inProgress rows, carries failure errors, and caps completed at 25", () => {
    const rows: SystemJobRow[] = [
      row({ name: "run.js:now", state: { kind: "inProgress" } }),
      row({
        name: "bad.js:job",
        state: { kind: "failed", error: "provider down" },
        completedTime: NOW,
      }),
      ...Array.from({ length: 30 }, (_, i) =>
        row({
          name: `bulk.js:done${i}`,
          state: { kind: "success" },
          completedTime: NOW - 10_000 - i,
        }),
      ),
    ];
    const out = summarizeScheduledFunctions(rows);
    expect(out.pending[0]).toMatchObject({ name: "run.now", inProgress: true });
    expect(out.completed).toHaveLength(25);
    expect(out.completed[0]).toMatchObject({
      name: "bad.job",
      outcome: "failed",
      error: "provider down",
    });
  });

  test("ignores canceled rows entirely", () => {
    const rows: SystemJobRow[] = [
      row({ name: "gone.js:x", state: { kind: "canceled" } }),
    ];
    const out = summarizeScheduledFunctions(rows);
    expect(out.pending).toHaveLength(0);
    expect(out.completed).toHaveLength(0);
    expect(out.pendingCount).toBe(0);
  });
});
