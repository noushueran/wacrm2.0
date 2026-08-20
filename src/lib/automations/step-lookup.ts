// Resolves a run's `currentStepKey` (the wait it is suspended on — see
// `automationsEngine.ts`'s `wait` case, the sole writer of that field)
// back to the step it names, out of the nested tree `automations.get`
// returns. Pulled into its own pure module — rather than living inline in
// `automations/[id]/logs/page.tsx`, a "use client" page component whose
// only exports Next.js's app router allows are the page itself and a
// small fixed set of route config — so this is actually importable from
// a test file.

export interface StepTreeNode {
  stepKey?: string | null
  /** `stepKey ?? _id` — `stepsTree.ts`'s `BuilderStepNode.effectiveStepKey`.
   *  USE THIS for joining against `automationRuns.currentStepKey`, not
   *  `stepKey` above. Fix round (code review): a step saved before Task
   *  10's stepKey migration has `stepKey` absent, but `automationsEngine.
   *  ts`'s `markRunWaiting` call still writes `currentStepKey: step.
   *  stepKey ?? step._id` when THAT step is what a run suspends on — so a
   *  waiting run parked on a pre-migration step is real and reachable, it
   *  is keyed by that step's row id, and only `effectiveStepKey` matches
   *  it. (An earlier version of this file's own comment claimed the
   *  opposite — "nothing can ever be suspended on" a keyless step — which
   *  was wrong; not double-checked against `automationsEngine.ts`'s
   *  actual write path before being written.) */
  effectiveStepKey: string
  step_type: string
  step_config: Record<string, unknown>
  branches: { yes: StepTreeNode[]; no: StepTreeNode[] }
}

/**
 * Flattens a builder step tree into a lookup by EFFECTIVE key
 * (`stepKey ?? _id`), matching how `automationsEngine.ts` writes
 * `automationRuns.currentStepKey` at suspend time. Every node has a
 * non-empty `effectiveStepKey` (see that field's own comment), so —
 * unlike an earlier version of this function, which skipped any node
 * with a falsy `stepKey` — nothing is silently dropped here.
 */
export function flattenStepsByKey(nodes: StepTreeNode[]): Map<string, StepTreeNode> {
  const map = new Map<string, StepTreeNode>()
  const visit = (list: StepTreeNode[]) => {
    for (const node of list) {
      map.set(node.effectiveStepKey, node)
      visit(node.branches.yes)
      visit(node.branches.no)
    }
  }
  visit(nodes)
  return map
}

/** A `wait` step's raw `{amount, unit}` config, read defensively since
 *  `step_config` is `Record<string, unknown>` server-side too. */
export function waitStepDuration(node: StepTreeNode): { amount: unknown; unit: unknown } {
  return { amount: node.step_config.amount, unit: node.step_config.unit }
}
