import { expect, test } from "vitest";
import {
  ACTION_GROUPS,
  ACTION_KEYWORDS,
  clampHighlight,
  groupedResults,
  searchActions,
} from "./action-catalog";

const ADDABLE = [
  "send_message",
  "send_template",
  "add_tag",
  "remove_tag",
  "assign_conversation",
  "update_contact_field",
  "create_deal",
  "wait",
  "condition",
  "send_webhook",
  "close_conversation",
] as const;

test("every addable step appears in exactly one group", () => {
  const placed = ACTION_GROUPS.flatMap((g) => g.steps);
  expect([...placed].sort()).toEqual([...ADDABLE].sort());
});

test("send_buttons and send_list are NOT in the menu — they live in the composer", () => {
  const placed = ACTION_GROUPS.flatMap((g) => g.steps);
  expect(placed).not.toContain("send_buttons");
  expect(placed).not.toContain("send_list");
});

test("every addable step has search keywords", () => {
  for (const step of ADDABLE) {
    expect(ACTION_KEYWORDS[step]?.length ?? 0).toBeGreaterThan(0);
  }
});

test("an empty query returns every addable step in group order", () => {
  expect(searchActions("")).toEqual(ACTION_GROUPS.flatMap((g) => g.steps));
});

test("search matches the step type itself", () => {
  expect(searchActions("webhook")).toContain("send_webhook");
});

test("search matches a keyword the step type does not contain", () => {
  // Someone looking for buttons should land on the composer's step.
  expect(searchActions("button")).toContain("send_message");
  // "delay" is what people call a wait.
  expect(searchActions("delay")).toContain("wait");
  // "image" / "photo" should also find the send step.
  expect(searchActions("photo")).toContain("send_message");
});

test("search is case-insensitive and ignores surrounding whitespace", () => {
  expect(searchActions("  WEBHOOK ")).toContain("send_webhook");
});

test("a query matching nothing returns an empty array", () => {
  expect(searchActions("zzzzz")).toEqual([]);
});

// ============================================================
// Fix round (code review on Task 2) — the picker's own highest-risk
// logic (arrow-key clamping and the query -> non-empty-groups
// derivation) had zero test coverage, because it lived inline inside
// action-picker.tsx, a component this repo has no DOM harness to render
// (see action-picker.tsx's own top-of-file comment, and the Test
// section of the Task 2 report). Pulled both out into plain functions
// here specifically so they're testable without rendering anything.
// ============================================================

test("groupedResults('') mirrors ACTION_GROUPS exactly, in the same order", () => {
  expect(groupedResults("")).toEqual(
    ACTION_GROUPS.map((g) => ({ id: g.id, steps: [...g.steps] })),
  );
});

test("a query that empties some groups keeps only the groups with a match", () => {
  // "tag" matches add_tag and remove_tag (both "contact") and nothing
  // else — message/flow/advanced should all drop out entirely, not
  // survive as empty groups.
  expect(groupedResults("tag")).toEqual([
    { id: "contact", steps: ["add_tag", "remove_tag"] },
  ]);
});

test("a group survives with only its matching steps, not the whole group", () => {
  // "webhook" matches send_webhook but not close_conversation, so
  // "advanced" should survive with one step, not both.
  expect(groupedResults("webhook")).toEqual([
    { id: "advanced", steps: ["send_webhook"] },
  ]);
});

test("a query matching nothing returns no groups at all", () => {
  expect(groupedResults("zzzzz")).toEqual([]);
});

test("clampHighlight stays within [0, length-1] at both ends", () => {
  expect(clampHighlight(-1, 5)).toBe(0);
  expect(clampHighlight(5, 5)).toBe(4);
  expect(clampHighlight(2, 5)).toBe(2); // mid-range passes through unchanged
});

test("clampHighlight on a single-result list always lands on 0", () => {
  expect(clampHighlight(0, 1)).toBe(0);
  expect(clampHighlight(1, 1)).toBe(0);
  expect(clampHighlight(-1, 1)).toBe(0);
});

test("clampHighlight on an empty result list never goes negative", () => {
  expect(clampHighlight(0, 0)).toBe(0);
  expect(clampHighlight(1, 0)).toBe(0);
  expect(clampHighlight(-1, 0)).toBe(0);
});
