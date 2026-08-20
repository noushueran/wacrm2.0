import type { AutomationStepType } from "@/types";

export type ActionGroupId = "message" | "contact" | "flow" | "advanced";

export interface ActionGroup {
  id: ActionGroupId;
  steps: readonly AutomationStepType[];
}

/**
 * The add menu, grouped. `send_buttons` and `send_list` are deliberately
 * absent: they are a toggle inside the send composer now, not separate
 * actions. Their STEP_META entries survive so stored steps still render.
 *
 * Order is the order shown. Message first because it is what almost every
 * automation starts with; Advanced last because those two actions are
 * rarely what someone is looking for and were previously mixed in with
 * everything else in one flat scrolling list.
 */
export const ACTION_GROUPS: readonly ActionGroup[] = [
  { id: "message", steps: ["send_message", "send_template"] },
  {
    id: "contact",
    steps: [
      "add_tag",
      "remove_tag",
      "update_contact_field",
      "create_deal",
      "assign_conversation",
    ],
  },
  { id: "flow", steps: ["wait", "condition"] },
  { id: "advanced", steps: ["send_webhook", "close_conversation"] },
] as const;

/**
 * Words someone might type looking for each action, beyond the step type
 * itself. "button"/"image" point at `send_message` because the composer
 * absorbed those capabilities — without them, searching "buttons" would
 * return nothing, which is exactly the discovery failure this fixes.
 */
export const ACTION_KEYWORDS: Record<AutomationStepType, readonly string[]> = {
  send_message: [
    "text",
    "reply",
    "message",
    "button",
    "buttons",
    "list",
    "quick reply",
    "media",
    "image",
    "photo",
    "video",
    "audio",
    "voice",
    "document",
    "pdf",
    "attachment",
    "caption",
  ],
  send_template: [
    "template",
    "approved",
    "hsm",
    "re-engage",
    "reengage",
    "outside window",
  ],
  add_tag: ["tag", "label", "mark"],
  remove_tag: ["tag", "label", "untag"],
  update_contact_field: [
    "field",
    "custom field",
    "property",
    "attribute",
    "name",
    "email",
  ],
  create_deal: ["deal", "pipeline", "opportunity", "sale"],
  assign_conversation: ["assign", "agent", "owner", "route", "round robin"],
  wait: ["wait", "delay", "pause", "sleep", "later"],
  condition: ["condition", "if", "else", "branch", "split", "window", "24 hour"],
  send_webhook: ["webhook", "http", "post", "api", "integration", "zapier"],
  close_conversation: ["close", "resolve", "archive", "done"],
  // Present so the record stays exhaustive over AutomationStepType; never
  // shown, because neither appears in ACTION_GROUPS.
  send_buttons: [],
  send_list: [],
};

/** Group-ordered, filtered by a free-text query. Empty query = everything. */
export function searchActions(query: string): AutomationStepType[] {
  const all = ACTION_GROUPS.flatMap((g) => g.steps);
  const q = query.trim().toLowerCase();
  if (!q) return [...all];
  return all.filter(
    (step) =>
      step.replace(/_/g, " ").includes(q) ||
      ACTION_KEYWORDS[step].some((k) => k.includes(q))
  );
}

export interface GroupedResult {
  id: ActionGroupId;
  steps: AutomationStepType[];
}

/**
 * `searchActions(query)`, regrouped under ACTION_GROUPS, with any group
 * left with zero matching steps dropped entirely — the exact shape
 * action-picker.tsx renders (its `groups` derivation used to be inline;
 * pulled out here so the "which groups survive a query" logic — new in
 * Task 2, not covered by Task 1's tests above — is unit-testable without
 * rendering anything). A group can survive with only SOME of its steps:
 * see the "webhook" test below, where "advanced" keeps send_webhook but
 * drops close_conversation.
 */
export function groupedResults(query: string): GroupedResult[] {
  const matched = new Set(searchActions(query));
  return ACTION_GROUPS.map((group) => ({
    id: group.id,
    steps: group.steps.filter((step) => matched.has(step)),
  })).filter((group) => group.steps.length > 0);
}

/**
 * Clamps an arrow-key move into the valid index range for a
 * `results.length`-long flat list — the picker's highlight arithmetic,
 * pulled out of action-picker.tsx's `handleKeyDown` so the group-boundary
 * off-by-one the Task 2 brief specifically named as the likely defect is
 * covered without rendering anything. Symmetric in both directions
 * (over-shooting past either end lands on that end, not past it) and
 * safe for `length === 0` (the empty-query-match state): every case
 * returns 0 rather than a `-1` a plain `Math.min(index, length - 1)`
 * would produce there. That -1 was harmless in practice (nothing renders
 * to look up at an out-of-range index, and `handleKeyDown`'s own
 * `results[highlight]` guard no-ops on it), but a function that hands
 * back a negative "array index" is wrong on its own terms, not just
 * wrong when nothing happens to be looking.
 */
export function clampHighlight(index: number, length: number): number {
  if (length <= 0) return 0;
  return Math.min(Math.max(index, 0), length - 1);
}
