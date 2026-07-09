import { expect, test } from "vitest";
import { buildStepsTree, seedsToTree, type StepRow } from "./stepsTree";

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
    { id: "1", parentStepId: undefined, branch: undefined, stepType: "send_message", stepConfig: { text: "hi" } },
    { id: "2", parentStepId: null, branch: null, stepType: "add_tag", stepConfig: { tag_id: "t1" } },
  ];
  const tree = buildStepsTree(rows);
  expect(tree.map((n) => n.id)).toEqual(["1", "2"]);
  expect(tree[0]!.step_type).toBe("send_message");
  expect(tree[0]!.step_config).toEqual({ text: "hi" });
  expect(tree[0]!.branches).toEqual({ yes: [], no: [] });
});

test("buildStepsTree: nests a child under its parent's yes/no branch by parentStepId", () => {
  const rows: StepRow[] = [
    { id: "root", parentStepId: undefined, branch: undefined, stepType: "condition", stepConfig: { subject: "tag" } },
    { id: "child-yes", parentStepId: "root", branch: "yes", stepType: "add_tag", stepConfig: { tag_id: "vip" } },
    { id: "child-no", parentStepId: "root", branch: "no", stepType: "send_message", stepConfig: { text: "sorry" } },
  ];
  const tree = buildStepsTree(rows);
  expect(tree).toHaveLength(1);
  expect(tree[0]!.id).toBe("root");
  expect(tree[0]!.branches.yes.map((n) => n.id)).toEqual(["child-yes"]);
  expect(tree[0]!.branches.no.map((n) => n.id)).toEqual(["child-no"]);
});

test("buildStepsTree: defaults a child row with no branch to the 'yes' bucket", () => {
  const rows: StepRow[] = [
    { id: "root", parentStepId: undefined, branch: undefined, stepType: "condition", stepConfig: {} },
    { id: "child", parentStepId: "root", branch: undefined, stepType: "add_tag", stepConfig: {} },
  ];
  const tree = buildStepsTree(rows);
  expect(tree[0]!.branches.yes.map((n) => n.id)).toEqual(["child"]);
  expect(tree[0]!.branches.no).toEqual([]);
});

test("buildStepsTree: a row whose stepConfig is null/undefined falls back to {}", () => {
  const rows: StepRow[] = [
    { id: "1", parentStepId: undefined, branch: undefined, stepType: "close_conversation", stepConfig: undefined },
  ];
  const tree = buildStepsTree(rows);
  expect(tree[0]!.step_config).toEqual({});
});

test("buildStepsTree: silently drops a row whose parentStepId doesn't resolve (dangling reference)", () => {
  const rows: StepRow[] = [
    { id: "orphan", parentStepId: "missing-parent", branch: "yes", stepType: "add_tag", stepConfig: {} },
  ];
  const tree = buildStepsTree(rows);
  // Matches the original loadStepsTree's own `if (parent) { ... }` guard:
  // an unresolvable parent means the child is neither a root nor nested
  // anywhere — it's dropped, not crashed on.
  expect(tree).toEqual([]);
});

test("buildStepsTree: reassembles a deeper multi-level tree correctly", () => {
  const rows: StepRow[] = [
    { id: "a", parentStepId: undefined, branch: undefined, stepType: "condition", stepConfig: { subject: "tag" } },
    { id: "b", parentStepId: "a", branch: "yes", stepType: "condition", stepConfig: { subject: "field" } },
    { id: "c", parentStepId: "b", branch: "no", stepType: "add_tag", stepConfig: { tag_id: "deep" } },
    { id: "d", parentStepId: undefined, branch: undefined, stepType: "send_message", stepConfig: { text: "second root" } },
  ];
  const tree = buildStepsTree(rows);
  expect(tree.map((n) => n.id)).toEqual(["a", "d"]);
  expect(tree[0]!.branches.yes[0]!.id).toBe("b");
  expect(tree[0]!.branches.yes[0]!.branches.no[0]!.id).toBe("c");
});
