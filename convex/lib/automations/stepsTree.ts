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
  // Passed through from `StepRow.stepKey` (see its comment below) so
  // `automations.get`'s caller — the builder UI's `fromServerSteps` — can
  // round-trip it on the next save via `toApiSteps`'s `id`. Deliberately
  // left RAW (possibly absent) — see `effectiveStepKey` immediately below
  // for why this must not gain a `?? id` fallback of its own.
  stepKey: string | null | undefined;
  // schema.ts's own comment on `automationSteps.stepKey`: "Readers derive
  // an effective key as `stepKey ?? _id`, so old rows keep working." This
  // is that fallback, computed once here so every reader (the canvas's
  // per-step stats chips, the Waiting tab's step lookup) joins against
  // `automationStepStats`/`automationRuns.currentStepKey` the same way
  // `automationsEngine.ts` wrote them (`step.stepKey ?? step._id`) —
  // without a computed field like this, a step saved before Task 10's
  // stepKey migration has no key its own accumulated stats can be found
  // by.
  //
  // A SEPARATE field from `stepKey` on purpose, not a change to it:
  // `stepKey` also feeds `toApiSteps`'s "should this save mint a fresh
  // key" decision (automation-builder.tsx), and folding the fallback in
  // there would make a fabricated identity look like a real stored one,
  // silently defeating Task 10's intentional mint-on-first-save. Readers
  // that need identity for JOINING should use this field; `stepKey`
  // itself stays reserved for round-tripping into a save.
  effectiveStepKey: string;
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
  // The stable identity from `automationSteps.stepKey` (see that field's
  // comment in convex/schema.ts). `id` above stays the row's real `_id` —
  // needed as-is to resolve `parentStepId` references while rebuilding the
  // tree — so this is a second, separate field, not a replacement for it.
  //
  // Whoever builds a `StepRow` owns resolving that field's documented
  // `stepKey ?? _id` fallback for a row that predates key-minting;
  // `convex/automations.ts`'s `toStepRow` is the real caller and does
  // exactly that. This module deliberately passes whatever it is given
  // through verbatim (see `buildStepsTree`) and never substitutes `id`
  // itself — it has no way to know the two are related.
  stepKey: string | null | undefined;
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
      stepKey: row.stepKey,
      effectiveStepKey: row.stepKey ?? row.id,
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

// ============================================================
// stepsTreeEqual — fix wave (2026-08), finding 3. `automations.update`
// scoped its "cancel queued runs" side effect to `steps !== undefined`,
// with an explicit comment that a name-only or `stopOnReply`-only save
// must cancel nothing — but the ONLY caller, `automation-builder.tsx`'s
// `save()`, sends the full (unedited) steps array on EVERY save, so
// that guard never actually fires on the real UI's rename-only path.
// The fix moves the real distinction from "was `steps` present" to "did
// the tree ACTUALLY change" — this function is that comparison.
//
// Deliberately ignores `id`/`stepKey`/`effectiveStepKey`: a genuinely
// unedited resave round-trips each step's stable key as `id` (mirrors
// `automation-builder.tsx`'s `toApiSteps`), but comparing on identity
// would make ANY resave (even a byte-for-byte one) register as
// "changed" the moment a single step's incoming `id` happens to differ
// from how `buildStepsTree` represents the stored side — which is
// exactly the false positive this function exists to avoid. Order
// still matters (position drives `automationRuns.nextPosition`
// resolution), so a plain reorder DOES register as a change: array
// order is compared alongside content, not sorted away.
// ============================================================

/** Structural (not reference) equality for JSON-shaped values — used
 *  only to compare `step_config` objects. Treats a key whose value is
 *  `undefined` as absent on both sides, since a step round-tripped
 *  through a save can pick up/drop `undefined` fields that carry no
 *  actual meaning (Convex strips `undefined` values on write; the
 *  builder's own local state may or may not include them). Being
 *  lenient here only widens what counts as "unchanged" — it can never
 *  cause a REAL difference to be missed, since any two values that
 *  differ in a defined key still compare unequal. */
function deepEqualJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return a === b;
  if (typeof a !== "object" || typeof b !== "object") return false;

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqualJson(v, b[i]));
  }

  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  const aKeys = Object.keys(aObj).filter((k) => aObj[k] !== undefined);
  const bKeys = Object.keys(bObj).filter((k) => bObj[k] !== undefined);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((k) => bKeys.includes(k) && deepEqualJson(aObj[k], bObj[k]));
}

/**
 * True when two step trees are structurally identical: same length and
 * order at every level, each pair sharing the same `step_type` and a
 * deep-equal `step_config`, recursing into `branches.yes`/`branches.no`.
 * Ignores `id`/`stepKey`/`branch`/`parent_index` — see this section's
 * own header comment for why.
 *
 * Both sides are expected already in nested-tree form — callers pass
 * `buildStepsTree`'s output for the stored side and
 * `normalizeStepsInput`'s output for the incoming side (both live in
 * `convex/automations.ts`, which imports this function; not re-imported
 * here to keep this module dependency-free per its own header comment).
 */
export function stepsTreeEqual(a: BuilderStepInput[], b: BuilderStepInput[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const nodeA = a[i]!;
    const nodeB = b[i]!;
    if (nodeA.step_type !== nodeB.step_type) return false;
    if (!deepEqualJson(nodeA.step_config ?? {}, nodeB.step_config ?? {})) return false;
    const aYes = nodeA.branches?.yes ?? [];
    const aNo = nodeA.branches?.no ?? [];
    const bYes = nodeB.branches?.yes ?? [];
    const bNo = nodeB.branches?.no ?? [];
    if (!stepsTreeEqual(aYes, bYes)) return false;
    if (!stepsTreeEqual(aNo, bNo)) return false;
  }
  return true;
}
