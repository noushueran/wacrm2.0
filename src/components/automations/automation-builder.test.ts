import { describe, expect, it } from "vitest";
import {
  fromServerSteps,
  resolveStepStats,
  stepStatsChipParts,
  type ServerStepNode,
  type StepStatsEntry,
} from "./automation-builder";

/**
 * Task 8's canvas chip row (`142 reached · 18 waiting · 3 failed`) pulled
 * its "which figures, in what order, omitting zero" decision out into
 * this plain function specifically so it's testable without rendering
 * `AutomationBuilder` — a 2000+ line client component with no existing
 * test harness (Convex/next-intl providers, the full step-tree state
 * machine, ...). This pins the one rule the brief calls out explicitly:
 * "omit zero-valued figures so an untouched step shows nothing rather
 * than three zeroes."
 */
describe("stepStatsChipParts", () => {
  const zero: StepStatsEntry = { reached: 0, sent: 0, failed: 0, waiting: 0 };

  it("returns nothing for an untouched step, not three zeroes", () => {
    expect(stepStatsChipParts(zero)).toEqual([]);
  });

  it("shows reached/waiting/failed in that order when all three are non-zero", () => {
    const entry: StepStatsEntry = { reached: 142, sent: 121, failed: 3, waiting: 18 };
    expect(stepStatsChipParts(entry)).toEqual([
      { kind: "reached", count: 142 },
      { kind: "waiting", count: 18 },
      { kind: "failed", count: 3 },
    ]);
  });

  it("never surfaces `sent` — that word is already spoken for by the automation-level RunStatsBar", () => {
    const entry: StepStatsEntry = { reached: 10, sent: 10, failed: 0, waiting: 0 };
    const parts = stepStatsChipParts(entry);
    expect(parts.some((p) => (p.kind as string) === "sent")).toBe(false);
  });

  it("omits only the zero-valued figures, keeping the rest", () => {
    expect(stepStatsChipParts({ reached: 5, sent: 5, failed: 0, waiting: 0 })).toEqual([
      { kind: "reached", count: 5 },
    ]);
    expect(stepStatsChipParts({ reached: 0, sent: 0, failed: 0, waiting: 4 })).toEqual([
      { kind: "waiting", count: 4 },
    ]);
    expect(stepStatsChipParts({ reached: 6, sent: 4, failed: 2, waiting: 0 })).toEqual([
      { kind: "reached", count: 6 },
      { kind: "failed", count: 2 },
    ]);
  });
});

// ============================================================
// Fix round (code review on Task 8): schema.ts promises "Readers derive
// an effective key as `stepKey ?? _id`, so old rows keep working" —
// `automationsEngine.ts` writes `automationStepStats`/`automationRuns.
// currentStepKey` that way, but nothing on the read side computed the
// same fallback, so a step saved before Task 10's stepKey migration had
// no key its own accumulated stats could be found by: the canvas chip
// looked up `step.step_key` (undefined for such a step) and silently
// rendered nothing, however much real traffic that step had seen.
//
// `stepsTree.test.ts`'s new tests pin the ROOT of the fix
// (`buildStepsTree` computing `effectiveStepKey`) with a genuine
// watch-it-fail-first cycle. These two cover the rest of the pipeline —
// `fromServerSteps` carrying that value onto `BuilderStep`, and the
// join itself finding a legacy step's stats by it.
// ============================================================

describe("fromServerSteps — effective_step_key passthrough", () => {
  it("carries effectiveStepKey from the server node onto BuilderStep.effective_step_key", () => {
    const nodes: ServerStepNode[] = [
      {
        id: "row-abc123",
        stepKey: undefined,
        effectiveStepKey: "row-abc123",
        step_type: "wait",
        step_config: { amount: 10, unit: "minutes" },
        branches: { yes: [], no: [] },
      },
    ];
    const steps = fromServerSteps(nodes);
    expect(steps[0]!.step_key).toBeUndefined();
    expect(steps[0]!.effective_step_key).toBe("row-abc123");
  });

  it("carries a real stepKey through as both step_key and effective_step_key", () => {
    const nodes: ServerStepNode[] = [
      {
        id: "row-xyz",
        stepKey: "stable-key-9",
        effectiveStepKey: "stable-key-9",
        step_type: "wait",
        step_config: {},
        branches: { yes: [], no: [] },
      },
    ];
    const steps = fromServerSteps(nodes);
    expect(steps[0]!.step_key).toBe("stable-key-9");
    expect(steps[0]!.effective_step_key).toBe("stable-key-9");
  });
});

describe("resolveStepStats — the canvas chip's join", () => {
  it("finds a pre-migration step's accumulated stats by its row id, the exact scenario the schema's fallback exists for", () => {
    // Mirrors automationsEngine.ts's own write-time fallback: a step with
    // no stored stepKey has its stats filed under its row's real `_id`
    // (here "row-abc123") by `appendLogResults`'s `item.stepKey ??
    // step._id`. The canvas step for it has step_key === undefined (no
    // migration yet) but, after this fix, effective_step_key ===
    // "row-abc123".
    const stats = new Map<string, StepStatsEntry>([
      ["row-abc123", { reached: 142, sent: 121, failed: 3, waiting: 18 }],
    ]);
    const entry = resolveStepStats("row-abc123", stats);
    expect(entry).toEqual({ reached: 142, sent: 121, failed: 3, waiting: 18 });
  });

  it("returns undefined for a step with no effective key (never saved this session)", () => {
    const stats = new Map<string, StepStatsEntry>([
      ["row-abc123", { reached: 142, sent: 121, failed: 3, waiting: 18 }],
    ]);
    expect(resolveStepStats(undefined, stats)).toBeUndefined();
  });

  it("does not fall back to searching by _id when a real stepKey has its own row — the two key spaces don't get confused", () => {
    const stats = new Map<string, StepStatsEntry>([
      ["real-migrated-key", { reached: 5, sent: 5, failed: 0, waiting: 0 }],
    ]);
    // A row id that happens to look like an id but isn't this step's
    // effective key at all — must not match.
    expect(resolveStepStats("some-other-row-id", stats)).toBeUndefined();
  });
});
