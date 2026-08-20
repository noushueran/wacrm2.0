import { describe, expect, it } from "vitest";
import { flattenStepsByKey, type StepTreeNode } from "./step-lookup";

function node(overrides: Partial<StepTreeNode> = {}): StepTreeNode {
  return {
    stepKey: undefined,
    effectiveStepKey: "default-key",
    step_type: "send_message",
    step_config: {},
    branches: { yes: [], no: [] },
    ...overrides,
  };
}

describe("flattenStepsByKey", () => {
  it("maps root-level steps by their effectiveStepKey", () => {
    const tree = [
      node({ stepKey: "k1", effectiveStepKey: "k1" }),
      node({ stepKey: "k2", effectiveStepKey: "k2", step_type: "wait" }),
    ];
    const map = flattenStepsByKey(tree);
    expect(map.size).toBe(2);
    expect(map.get("k1")?.step_type).toBe("send_message");
    expect(map.get("k2")?.step_type).toBe("wait");
  });

  it("descends into both condition branches", () => {
    const tree = [
      node({
        stepKey: "root",
        effectiveStepKey: "root",
        step_type: "condition",
        branches: {
          yes: [node({ stepKey: "yes-wait", effectiveStepKey: "yes-wait", step_type: "wait" })],
          no: [node({ stepKey: "no-wait", effectiveStepKey: "no-wait", step_type: "wait" })],
        },
      }),
    ];
    const map = flattenStepsByKey(tree);
    expect(map.get("yes-wait")?.step_type).toBe("wait");
    expect(map.get("no-wait")?.step_type).toBe("wait");
    expect(map.get("root")?.step_type).toBe("condition");
  });

  // ============================================================
  // Fix round (code review on Task 8): this test used to assert the
  // OPPOSITE — that a step with no `stepKey` was silently dropped — on
  // the (wrong, undocumented) theory that nothing could ever be waiting
  // on such a step. `automationsEngine.ts`'s `markRunWaiting` call writes
  // `currentStepKey: step.stepKey ?? step._id`, so a wait step saved
  // before Task 10's stepKey migration absolutely CAN have a real
  // contact parked on it — keyed by that step's row id. Before this fix,
  // `WaitingRow` (logs/page.tsx) would look that run's `currentStepKey`
  // up in a map that never contained the row, rendering "an unknown
  // step" for a perfectly identifiable one.
  // ============================================================

  it("still maps a pre-migration step (no stepKey) by its effectiveStepKey — the row's own id", () => {
    const tree = [
      node({ stepKey: undefined, effectiveStepKey: "row-abc123", step_type: "wait" }),
    ];
    const map = flattenStepsByKey(tree);
    expect(map.size).toBe(1);
    expect(map.get("row-abc123")?.step_type).toBe("wait");
    // Resolvable by the SAME value automationsEngine.ts would have used
    // as this step's `currentStepKey` at suspend time: `stepKey ?? _id`
    // with `stepKey` absent is the row id itself.
    expect(map.get("row-abc123")?.stepKey).toBeUndefined();
  });

  it("returns an empty map for an empty tree", () => {
    expect(flattenStepsByKey([]).size).toBe(0);
  });
});
