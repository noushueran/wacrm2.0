import { expect, test } from "vitest";
import { buildStepsTree, seedsToTree, stepsTreeEqual, type BuilderStepInput, type StepRow } from "./stepsTree";

// No pre-existing test to port — see stepsTree.ts's header comment:
// `src/lib/automations/steps-tree.ts` has no `.test.ts` file anywhere
// in the source tree. This is new coverage authored for the two pure
// functions extracted from that (not-actually-pure) module.

test("seedsToTree: flat seeds with no parent_index all become roots, in order", () => {
  const tree = seedsToTree([
    { step_type: "send_message", step_config: { text: "hi" } },
    { step_type: "add_tag", step_config: { tag_id: "t1" } },
  ]);
  expect(tree).toEqual([
    {
      step_type: "send_message",
      step_config: { text: "hi" },
      branches: { yes: [], no: [] },
    },
    {
      step_type: "add_tag",
      step_config: { tag_id: "t1" },
      branches: { yes: [], no: [] },
    },
  ]);
});

test("seedsToTree: nests a child under its parent's yes/no branch by parent_index", () => {
  const tree = seedsToTree([
    { step_type: "condition", step_config: { subject: "tag" } },
    {
      step_type: "add_tag",
      step_config: { tag_id: "vip" },
      parent_index: 0,
      branch: "yes",
    },
    {
      step_type: "send_message",
      step_config: { text: "sorry" },
      parent_index: 0,
      branch: "no",
    },
  ]);
  expect(tree).toHaveLength(1);
  expect(tree[0]!.step_type).toBe("condition");
  expect(tree[0]!.branches!.yes).toEqual([
    {
      step_type: "add_tag",
      step_config: { tag_id: "vip" },
      parent_index: 0,
      branch: "yes",
      branches: { yes: [], no: [] },
    },
  ]);
  expect(tree[0]!.branches!.no).toEqual([
    {
      step_type: "send_message",
      step_config: { text: "sorry" },
      parent_index: 0,
      branch: "no",
      branches: { yes: [], no: [] },
    },
  ]);
});

test("seedsToTree: defaults a child with no branch field to the 'yes' bucket", () => {
  const tree = seedsToTree([
    { step_type: "condition", step_config: {} },
    { step_type: "add_tag", step_config: { tag_id: "x" }, parent_index: 0 },
  ]);
  expect(tree[0]!.branches!.yes).toHaveLength(1);
  expect(tree[0]!.branches!.no).toHaveLength(0);
});

test("seedsToTree: supports multiple children in the same branch bucket, preserving order", () => {
  const tree = seedsToTree([
    { step_type: "condition", step_config: {} },
    {
      step_type: "add_tag",
      step_config: { tag_id: "a" },
      parent_index: 0,
      branch: "yes",
    },
    {
      step_type: "add_tag",
      step_config: { tag_id: "b" },
      parent_index: 0,
      branch: "yes",
    },
  ]);
  const yesBranch = tree[0]!.branches!.yes ?? [];
  expect(yesBranch.map((n) => n.step_config.tag_id)).toEqual(["a", "b"]);
});

test("buildStepsTree: rows with no parentStepId all become roots, in input order", () => {
  const rows: StepRow[] = [
    { id: "1", parentStepId: undefined, branch: undefined, stepType: "send_message", stepConfig: { text: "hi" }, stepKey: undefined },
    { id: "2", parentStepId: null, branch: null, stepType: "add_tag", stepConfig: { tag_id: "t1" }, stepKey: null },
  ];
  const tree = buildStepsTree(rows);
  expect(tree.map((n) => n.id)).toEqual(["1", "2"]);
  expect(tree[0]!.step_type).toBe("send_message");
  expect(tree[0]!.step_config).toEqual({ text: "hi" });
  expect(tree[0]!.branches).toEqual({ yes: [], no: [] });
});

test("buildStepsTree: nests a child under its parent's yes/no branch by parentStepId", () => {
  const rows: StepRow[] = [
    { id: "root", parentStepId: undefined, branch: undefined, stepType: "condition", stepConfig: { subject: "tag" }, stepKey: undefined },
    { id: "child-yes", parentStepId: "root", branch: "yes", stepType: "add_tag", stepConfig: { tag_id: "vip" }, stepKey: undefined },
    { id: "child-no", parentStepId: "root", branch: "no", stepType: "send_message", stepConfig: { text: "sorry" }, stepKey: undefined },
  ];
  const tree = buildStepsTree(rows);
  expect(tree).toHaveLength(1);
  expect(tree[0]!.id).toBe("root");
  expect(tree[0]!.branches.yes.map((n) => n.id)).toEqual(["child-yes"]);
  expect(tree[0]!.branches.no.map((n) => n.id)).toEqual(["child-no"]);
});

test("buildStepsTree: defaults a child row with no branch to the 'yes' bucket", () => {
  const rows: StepRow[] = [
    { id: "root", parentStepId: undefined, branch: undefined, stepType: "condition", stepConfig: {}, stepKey: undefined },
    { id: "child", parentStepId: "root", branch: undefined, stepType: "add_tag", stepConfig: {}, stepKey: undefined },
  ];
  const tree = buildStepsTree(rows);
  expect(tree[0]!.branches.yes.map((n) => n.id)).toEqual(["child"]);
  expect(tree[0]!.branches.no).toEqual([]);
});

test("buildStepsTree: a row whose stepConfig is null/undefined falls back to {}", () => {
  const rows: StepRow[] = [
    { id: "1", parentStepId: undefined, branch: undefined, stepType: "close_conversation", stepConfig: undefined, stepKey: undefined },
  ];
  const tree = buildStepsTree(rows);
  expect(tree[0]!.step_config).toEqual({});
});

test("buildStepsTree: silently drops a row whose parentStepId doesn't resolve (dangling reference)", () => {
  const rows: StepRow[] = [
    { id: "orphan", parentStepId: "missing-parent", branch: "yes", stepType: "add_tag", stepConfig: {}, stepKey: undefined },
  ];
  const tree = buildStepsTree(rows);
  // Matches the original loadStepsTree's own `if (parent) { ... }` guard:
  // an unresolvable parent means the child is neither a root nor nested
  // anywhere — it's dropped, not crashed on.
  expect(tree).toEqual([]);
});

test("buildStepsTree: reassembles a deeper multi-level tree correctly", () => {
  const rows: StepRow[] = [
    { id: "a", parentStepId: undefined, branch: undefined, stepType: "condition", stepConfig: { subject: "tag" }, stepKey: undefined },
    { id: "b", parentStepId: "a", branch: "yes", stepType: "condition", stepConfig: { subject: "field" }, stepKey: undefined },
    { id: "c", parentStepId: "b", branch: "no", stepType: "add_tag", stepConfig: { tag_id: "deep" }, stepKey: undefined },
    { id: "d", parentStepId: undefined, branch: undefined, stepType: "send_message", stepConfig: { text: "second root" }, stepKey: undefined },
  ];
  const tree = buildStepsTree(rows);
  expect(tree.map((n) => n.id)).toEqual(["a", "d"]);
  expect(tree[0]!.branches.yes[0]!.id).toBe("b");
  expect(tree[0]!.branches.yes[0]!.branches.no[0]!.id).toBe("c");
});

// ============================================================
// stepKey passthrough (Task 10) — buildStepsTree must carry
// StepRow.stepKey onto each output node unchanged, distinct from `id`
// (the row's real, churning `_id`), so the builder UI can round-trip it.
// ============================================================

test("buildStepsTree: carries a row's stepKey through to its node, distinct from id", () => {
  const rows: StepRow[] = [
    { id: "row-id-1", parentStepId: undefined, branch: undefined, stepType: "send_message", stepConfig: {}, stepKey: "stable-key-1" },
  ];
  const tree = buildStepsTree(rows);
  expect(tree[0]!.id).toBe("row-id-1");
  expect(tree[0]!.stepKey).toBe("stable-key-1");
});

// NOTE: "no fallback to id" is this pure function's contract, not the
// system's. The schema's documented `stepKey ?? _id` fallback for a
// pre-migration row is resolved one layer up, by `convex/automations.ts`'s
// `toStepRow`, so in practice `buildStepsTree` never sees a key-less row —
// see `StepRow.stepKey`'s comment. Don't "fix" it here too.
test("buildStepsTree: a row with no stepKey yields an undefined stepKey on its node (not a crash, not a fallback to id)", () => {
  const rows: StepRow[] = [
    { id: "row-id-1", parentStepId: undefined, branch: undefined, stepType: "send_message", stepConfig: {}, stepKey: undefined },
  ];
  const tree = buildStepsTree(rows);
  expect(tree[0]!.stepKey).toBeUndefined();
});

// ============================================================
// effectiveStepKey (Task 8 fix round) — schema.ts's own comment on
// `automationSteps.stepKey` promises readers a fallback: "Readers derive
// an effective key as `stepKey ?? _id`, so old rows keep working." The
// write side already honours this (automationsEngine.ts writes
// `automationStepStats`/`automationRuns.currentStepKey` using
// `step.stepKey ?? step._id`), but nothing on the read side computed the
// same fallback — every reader got the raw, possibly-absent `stepKey`
// and nothing else. A pre-migration step (no stored stepKey) therefore
// had no way to be looked up by the same key its own stats were written
// under.
//
// This is a NEW field, deliberately not a change to `stepKey` itself —
// the test immediately above pins that `stepKey` must stay raw/absent,
// because `stepKey` is also what `toApiSteps` (automation-builder.tsx)
// reads to decide whether a save should mint a fresh key. Folding the
// fallback into `stepKey` would silently defeat that mint-on-first-save
// behaviour (Task 10, also already documented/expected) by making a
// fabricated identity look like a real stored one.
// ============================================================

test("buildStepsTree: a row with no stepKey gets an effectiveStepKey equal to its id — the schema's stated fallback", () => {
  const rows: StepRow[] = [
    { id: "row-id-1", parentStepId: undefined, branch: undefined, stepType: "send_message", stepConfig: {}, stepKey: undefined },
  ];
  const tree = buildStepsTree(rows);
  expect(tree[0]!.effectiveStepKey).toBe("row-id-1");
});

test("buildStepsTree: a row WITH a stepKey gets that stepKey as its effectiveStepKey, not its id", () => {
  const rows: StepRow[] = [
    { id: "row-id-1", parentStepId: undefined, branch: undefined, stepType: "send_message", stepConfig: {}, stepKey: "stable-key-1" },
  ];
  const tree = buildStepsTree(rows);
  expect(tree[0]!.effectiveStepKey).toBe("stable-key-1");
});

// ============================================================
// stepsTreeEqual — fix wave (2026-08), finding 3: `automations.update`
// needs to tell "the incoming steps tree is byte-for-byte what's
// already stored" apart from "something actually changed", since the
// real builder UI resends the full tree on every save regardless of
// what the user actually edited.
// ============================================================

test("stepsTreeEqual: two structurally identical single-step trees are equal, ignoring id", () => {
  const a: BuilderStepInput[] = [{ id: "row-1", step_type: "send_message", step_config: { text: "hi" } }];
  const b: BuilderStepInput[] = [{ id: "stable-key-xyz", step_type: "send_message", step_config: { text: "hi" } }];
  expect(stepsTreeEqual(a, b)).toBe(true);
});

test("stepsTreeEqual: a different step_config value is not equal", () => {
  const a: BuilderStepInput[] = [{ step_type: "send_message", step_config: { text: "hi" } }];
  const b: BuilderStepInput[] = [{ step_type: "send_message", step_config: { text: "bye" } }];
  expect(stepsTreeEqual(a, b)).toBe(false);
});

test("stepsTreeEqual: a different step_type is not equal even with identical config", () => {
  const a: BuilderStepInput[] = [{ step_type: "send_message", step_config: {} }];
  const b: BuilderStepInput[] = [{ step_type: "send_buttons", step_config: {} }];
  expect(stepsTreeEqual(a, b)).toBe(false);
});

test("stepsTreeEqual: different lengths are not equal", () => {
  const a: BuilderStepInput[] = [{ step_type: "add_tag", step_config: { tag_id: "x" } }];
  const b: BuilderStepInput[] = [
    { step_type: "add_tag", step_config: { tag_id: "x" } },
    { step_type: "add_tag", step_config: { tag_id: "y" } },
  ];
  expect(stepsTreeEqual(a, b)).toBe(false);
});

test("stepsTreeEqual: a reorder is not equal — position matters, not just multiset membership", () => {
  const a: BuilderStepInput[] = [
    { step_type: "add_tag", step_config: { tag_id: "x" } },
    { step_type: "add_tag", step_config: { tag_id: "y" } },
  ];
  const b: BuilderStepInput[] = [
    { step_type: "add_tag", step_config: { tag_id: "y" } },
    { step_type: "add_tag", step_config: { tag_id: "x" } },
  ];
  expect(stepsTreeEqual(a, b)).toBe(false);
});

test("stepsTreeEqual: recurses into condition branches — an unchanged nested tree is equal", () => {
  const a: BuilderStepInput[] = [
    {
      step_type: "condition",
      step_config: { subject: "tag_presence", operand: "vip" },
      branches: {
        yes: [{ id: "old-yes-id", step_type: "add_tag", step_config: { tag_id: "vip" } }],
        no: [{ id: "old-no-id", step_type: "send_message", step_config: { text: "sorry" } }],
      },
    },
  ];
  const b: BuilderStepInput[] = [
    {
      id: "fresh-key",
      step_type: "condition",
      step_config: { subject: "tag_presence", operand: "vip" },
      branches: {
        yes: [{ id: "fresh-key-2", step_type: "add_tag", step_config: { tag_id: "vip" } }],
        no: [{ id: "fresh-key-3", step_type: "send_message", step_config: { text: "sorry" } }],
      },
    },
  ];
  expect(stepsTreeEqual(a, b)).toBe(true);
});

test("stepsTreeEqual: a change nested inside a branch is detected", () => {
  const a: BuilderStepInput[] = [
    {
      step_type: "condition",
      step_config: { subject: "tag_presence", operand: "vip" },
      branches: {
        yes: [{ step_type: "add_tag", step_config: { tag_id: "vip" } }],
        no: [],
      },
    },
  ];
  const b: BuilderStepInput[] = [
    {
      step_type: "condition",
      step_config: { subject: "tag_presence", operand: "vip" },
      branches: {
        yes: [{ step_type: "add_tag", step_config: { tag_id: "not-vip" } }],
        no: [],
      },
    },
  ];
  expect(stepsTreeEqual(a, b)).toBe(false);
});

test("stepsTreeEqual: a step_config key that is undefined on one side and absent on the other still counts as equal", () => {
  const a: BuilderStepInput[] = [{ step_type: "send_message", step_config: { text: "hi", header: undefined } }];
  const b: BuilderStepInput[] = [{ step_type: "send_message", step_config: { text: "hi" } }];
  expect(stepsTreeEqual(a, b)).toBe(true);
});

test("stepsTreeEqual: treats an absent branches field the same as explicit empty yes/no buckets", () => {
  const a: BuilderStepInput[] = [{ step_type: "send_message", step_config: {} }];
  const b: BuilderStepInput[] = [{ step_type: "send_message", step_config: {}, branches: { yes: [], no: [] } }];
  expect(stepsTreeEqual(a, b)).toBe(true);
});
