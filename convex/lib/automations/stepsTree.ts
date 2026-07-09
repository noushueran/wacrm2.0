/**
 * Automation-step tree <-> flat-array shape conversion — the pure
 * algorithmic core of `src/lib/automations/steps-tree.ts`, adapted for
 * the Convex automations engine (Phase 6, Task 3).
 *
 * IMPORTANT DEVIATION from a straight 1:1 port, flagged explicitly per
 * this task's brief: the ORIGINAL `steps-tree.ts` is NOT actually pure,
 * despite the Phase 6 plan's own architecture section listing it among
 * the "pure decision helpers... already pure and tested" modules to
 * copy 1:1. In reality:
 *   - `replaceSteps`/`insertSteps` call `supabaseAdmin()` directly
 *     (a DELETE, then a bulk INSERT with client-pre-assigned UUIDs so
 *     `parent_step_id` references resolve within one round trip).
 *   - `loadStepsTree` also calls `supabaseAdmin()` to `select()` the
 *     rows before reassembling them into a tree.
 * It also has NO `.test.ts` file to port (checked: no
 * `steps-tree.test.ts` exists anywhere under `src/lib/automations/`),
 * unlike every other module this task ports.
 *
 * What IS genuinely pure in the original, and IS ported below:
 *   - `seedsToTree` — converts the legacy flat seed form (each step
 *     carries `parent_index`/`branch`) into the nested tree shape.
 *     Ported verbatim (pure in-memory data reshaping, no I/O).
 *   - The tree-walk inside `loadStepsTree` that reassembles an
 *     already-fetched flat row list into a nested tree via a
 *     `parentId -> branch` map. Ported below as `buildStepsTree`,
 *     taking the rows as a plain argument instead of fetching them.
 *
 * What's deliberately NOT ported here: the Supabase delete/insert/
 * select calls, and the `uid()` pre-assignment trick `insertSteps`
 * used so a nested tree's parent/child rows could reference each
 * other within a single bulk insert. Convex's `ctx.db.insert()` always
 * server-generates the `Id`, returned only AFTER the write commits —
 * there is no way to pre-assign an id and insert parent+children in
 * one batch the way Postgres UUID primary keys allow. The natural
 * Convex shape is: insert a step, get its real `Id<"automationSteps">`
 * back, THEN insert its children with `parentStepId` set to that real
 * id — a recursive top-down insert mutation. That belongs to Task 3
 * (the automations engine / step CRUD), not this pure-helpers task;
 * this file gives Task 3 the two pure tree-shape-conversion pieces it
 * needs so that logic isn't re-invented or copy-pasted there.
 */

export interface BuilderStepInput {
  id?: string;
  step_type: string;
  step_config: Record<string, unknown>;
  branches?: { yes?: BuilderStepInput[]; no?: BuilderStepInput[] };
  // Legacy flat form (from template seeds):
  branch?: "yes" | "no" | null;
  parent_index?: number | null;
}

/**
 * Convert the legacy flat seed form (each step optionally carrying
 * `parent_index`/`branch`) into the nested `branches: { yes, no }`
 * tree shape every other function in this module (and the builder UI)
 * expects. Ported verbatim from `src/lib/automations/steps-tree.ts`'s
 * `seedsToTree` — pure in-memory reshaping, no I/O.
 *
 * Callers should invoke this only after detecting the flat form via
 * `input.some((s) => s.branch !== undefined || s.parent_index !== undefined)`,
 * matching the original `insertSteps`'s own gate (a tree already in
 * nested form has no `parent_index`/`branch` markers and would pass
 * through this function as a no-op anyway, since every step's
 * `parent_index` is then `undefined` and lands in `roots`).
 */
export function seedsToTree(seeds: BuilderStepInput[]): BuilderStepInput[] {
  const nodes: BuilderStepInput[] = seeds.map((s) => ({
    ...s,
    branches: { yes: [], no: [] },
  }));
  const roots: BuilderStepInput[] = [];
  nodes.forEach((n, i) => {
    const seed = seeds[i]!;
    if (seed.parent_index == null) {
      roots.push(n);
    } else {
      const parent = nodes[seed.parent_index]!;
      parent.branches = parent.branches ?? { yes: [], no: [] };
      const bucket = (seed.branch ?? "yes") as "yes" | "no";
      (parent.branches[bucket] ??= []).push(n);
    }
  });
  return roots;
}

export interface BuilderStepNode extends BuilderStepInput {
  id: string;
  branches: { yes: BuilderStepNode[]; no: BuilderStepNode[] };
}

/**
 * A single already-fetched `automationSteps` row, shaped for
 * `buildStepsTree` — deliberately loose (camelCase, matching the
 * Convex schema field names in `convex/schema.ts`'s `automationSteps`
 * table) rather than importing `Doc<"automationSteps">` directly, so
 * this pure module has zero dependency on `_generated/dataModel`.
 */
export interface StepRow {
  id: string;
  parentStepId: string | null | undefined;
  branch: "yes" | "no" | null | undefined;
  stepType: string;
  stepConfig: Record<string, unknown> | null | undefined;
}

/**
 * Rebuild the nested tree shape the builder UI expects from a flat,
 * already-fetched row list — the pure counterpart to the original
 * `loadStepsTree`'s reassembly logic, minus the fetch itself. Task 3's
 * query does the fetch (e.g. `ctx.db.query("automationSteps")
 * .withIndex("by_automation", ...).collect()`) and hands the rows to
 * this function. One pass, O(n), same algorithm as the original.
 *
 * A row whose `parentStepId` doesn't resolve to any row in the input
 * (a dangling reference) is silently dropped from the tree — matching
 * the original `loadStepsTree`'s own `if (parent) { ... }` guard.
 */
export function buildStepsTree(rows: StepRow[]): BuilderStepNode[] {
  const byId = new Map<string, BuilderStepNode>();
  for (const row of rows) {
    byId.set(row.id, {
      id: row.id,
      step_type: row.stepType,
      step_config: row.stepConfig ?? {},
      branches: { yes: [], no: [] },
    });
  }

  const roots: BuilderStepNode[] = [];
  for (const row of rows) {
    const node = byId.get(row.id)!;
    if (row.parentStepId) {
      const parent = byId.get(row.parentStepId);
      if (parent) {
        const bucket = (row.branch ?? "yes") as "yes" | "no";
        parent.branches[bucket].push(node);
      }
    } else {
      roots.push(node);
    }
  }
  return roots;
}
