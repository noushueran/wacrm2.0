import { describe, expect, it } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  bucketIssuesByStepPath,
  collectStepPaths,
  StepIssues,
  unattachedIssues,
  useStepIssues,
  type StepTreeNode,
} from "./step-issues";
import type { ValidationIssue } from "../../../convex/lib/automations/validate";

/**
 * `collectStepPaths` walks the builder's step tree to produce the exact
 * same `steps[0]`, `steps[0].yes.steps[1]`, ... strings
 * `convex/lib/automations/validate.ts`'s own internal `walk()` builds —
 * see that file's `ValidationIssue.path` comment ("Dot-path for the UI to
 * highlight; stable enough to build a table"). This is a structural
 * mirror of the tree shape, not a validation rule, so it can't drift from
 * Meta's limits or validate.ts's messages the way reimplementing a check
 * would — but it DOES have to keep matching validate.ts's naming scheme
 * exactly, or `bucketIssuesByStepPath` below silently stops matching
 * anything.
 */
describe("collectStepPaths", () => {
  it("returns nothing for an empty tree", () => {
    expect(collectStepPaths([])).toEqual([]);
  });

  it("gives each flat, non-condition step its own indexed path, in order", () => {
    const steps: StepTreeNode[] = [
      { step_type: "send_message", step_config: {} },
      { step_type: "add_tag", step_config: {} },
      { step_type: "wait", step_config: {} },
    ];
    expect(collectStepPaths(steps)).toEqual(["steps[0]", "steps[1]", "steps[2]"]);
  });

  it("gives a condition step with no branches key only its own path", () => {
    const steps: StepTreeNode[] = [{ step_type: "condition", step_config: {} }];
    expect(collectStepPaths(steps)).toEqual(["steps[0]"]);
  });

  it("gives a condition step with empty yes/no arrays only its own path", () => {
    const steps: StepTreeNode[] = [
      { step_type: "condition", step_config: {}, branches: { yes: [], no: [] } },
    ];
    expect(collectStepPaths(steps)).toEqual(["steps[0]"]);
  });

  it("walks into yes and no branches with the .yes./.no. prefix validate.ts uses", () => {
    const steps: StepTreeNode[] = [
      {
        step_type: "condition",
        step_config: {},
        branches: {
          yes: [
            { step_type: "send_message", step_config: {} },
            { step_type: "add_tag", step_config: {} },
          ],
          no: [{ step_type: "wait", step_config: {} }],
        },
      },
      { step_type: "send_template", step_config: {} },
    ];
    expect(collectStepPaths(steps)).toEqual([
      "steps[0]",
      "steps[0].yes.steps[0]",
      "steps[0].yes.steps[1]",
      "steps[0].no.steps[0]",
      "steps[1]",
    ]);
  });

  it("walks multiple levels of nested conditions", () => {
    const steps: StepTreeNode[] = [
      {
        step_type: "condition",
        step_config: {},
        branches: {
          yes: [
            {
              step_type: "condition",
              step_config: {},
              branches: { yes: [{ step_type: "send_message", step_config: {} }], no: [] },
            },
          ],
          no: [],
        },
      },
    ];
    expect(collectStepPaths(steps)).toEqual([
      "steps[0]",
      "steps[0].yes.steps[0]",
      "steps[0].yes.steps[0].yes.steps[0]",
    ]);
  });
});

// ============================================================
// bucketIssuesByStepPath — the risky part per the task brief: getting the
// prefix match wrong means issues attach to the wrong card, or vanish.
// Every case below is chosen to catch one specific way that can happen.
// ============================================================

describe("bucketIssuesByStepPath", () => {
  function issue(path: string, message = "problem"): ValidationIssue {
    return { path, message };
  }

  it("returns an empty map for no issues", () => {
    expect(bucketIssuesByStepPath([], ["steps[0]"])).toEqual(new Map());
  });

  it("attaches a field-level issue to its exact step", () => {
    const result = bucketIssuesByStepPath([issue("steps[0].text")], ["steps[0]"]);
    expect(result.get("steps[0]")).toEqual([issue("steps[0].text")]);
  });

  it("attaches an issue whose path IS the step path exactly (no field suffix)", () => {
    // validate.ts's default case pushes `{ path, message: "unknown step type..." }`
    // with no field appended — the issue's path equals the step's own path.
    const result = bucketIssuesByStepPath([issue("steps[0]")], ["steps[0]"]);
    expect(result.get("steps[0]")).toEqual([issue("steps[0]")]);
  });

  it("keeps multiple issues on the same step together, in encounter order", () => {
    const a = issue("steps[0].text", "needs text");
    const b = issue("steps[0].fallback.template_name", "needs fallback");
    const result = bucketIssuesByStepPath([a, b], ["steps[0]"]);
    expect(result.get("steps[0]")).toEqual([a, b]);
  });

  it("keeps issues on different steps in separate buckets", () => {
    const a = issue("steps[0].tag_id");
    const b = issue("steps[1].url");
    const result = bucketIssuesByStepPath([a, b], ["steps[0]", "steps[1]"]);
    expect(result.get("steps[0]")).toEqual([a]);
    expect(result.get("steps[1]")).toEqual([b]);
  });

  it("BRANCH-NESTED: a nested step's issue attaches ONLY to that nested step, not to the ancestor condition card too", () => {
    // steps[0] is a condition; steps[0].yes.steps[1] is a real send_message
    // nested inside its "yes" branch. Both "steps[0]" and
    // "steps[0].yes.steps[1]" are valid string prefixes of the issue's
    // path — the bucket must pick the longer (more specific) one only.
    const deep = issue("steps[0].yes.steps[1].text", "needs text");
    const stepPaths = ["steps[0]", "steps[0].yes.steps[0]", "steps[0].yes.steps[1]"];
    const result = bucketIssuesByStepPath([deep], stepPaths);
    expect(result.get("steps[0].yes.steps[1]")).toEqual([deep]);
    // The critical negative assertion: it must NOT also show up on the
    // condition step wrapping it.
    expect(result.has("steps[0]")).toBe(false);
    expect(result.get("steps[0].yes.steps[0]")).toBeUndefined();
  });

  it("disambiguates sibling branches at the same index — a 'no' issue never lands on the 'yes' step", () => {
    const yesIssue = issue("steps[0].yes.steps[0].text", "yes side");
    const noIssue = issue("steps[0].no.steps[0].text", "no side");
    const stepPaths = ["steps[0]", "steps[0].yes.steps[0]", "steps[0].no.steps[0]"];
    const result = bucketIssuesByStepPath([yesIssue, noIssue], stepPaths);
    expect(result.get("steps[0].yes.steps[0]")).toEqual([yesIssue]);
    expect(result.get("steps[0].no.steps[0]")).toEqual([noIssue]);
  });

  it("a path that matches no rendered step is dropped silently, not attached anywhere, and does not throw", () => {
    // Simulates a stale issue path referring to a step index that isn't
    // currently rendered (e.g. mid-edit array-length mismatch).
    const stale = issue("steps[5].text");
    const result = bucketIssuesByStepPath([stale], ["steps[0]", "steps[1]"]);
    expect(result.size).toBe(0);
  });

  it("the zero-steps top-level issue (path 'steps', no rendered steps at all) matches nothing", () => {
    const noSteps = issue("steps", "active automations need at least one step");
    const result = bucketIssuesByStepPath([noSteps], []);
    expect(result.size).toBe(0);
  });

  it("a longer numeric index does not falsely prefix-match a shorter one (steps[1] vs steps[10])", () => {
    const onTen = issue("steps[10].text");
    const result = bucketIssuesByStepPath([onTen], ["steps[1]", "steps[10]"]);
    expect(result.get("steps[10]")).toEqual([onTen]);
    expect(result.has("steps[1]")).toBe(false);
  });

  it("an unrelated field name that happens to start with another step's path text still resolves to the longest real match", () => {
    // steps[0].yesish is NOT a branch marker (it's ".yesish", not
    // ".yes."), so it must stay owned by steps[0] itself, not be
    // mistaken for something under a "yes" branch.
    const weird = issue("steps[0].yesish", "made up field");
    const result = bucketIssuesByStepPath([weird], ["steps[0]"]);
    expect(result.get("steps[0]")).toEqual([weird]);
  });
});

// ============================================================
// unattachedIssues — I-3 fix. bucketIssuesByStepPath correctly DROPS an
// issue with no owning step (see its own comment), which means today
// that issue is counted in the top-level total and gates Save, but is
// rendered on no card, no tooltip, no badge — the only escape route is
// undoing whatever caused it, with no clue what that even is. This is the
// pure "which issues got dropped" complement to bucketIssuesByStepPath,
// so the badge (or any other caller) can surface their `message` text
// verbatim instead of silently discarding them.
// ============================================================

describe("unattachedIssues", () => {
  function issue(path: string, message = "problem"): ValidationIssue {
    return { path, message };
  }

  it("returns nothing when every issue has an owning step", () => {
    const a = issue("steps[0].tag_id");
    const byPath = bucketIssuesByStepPath([a], ["steps[0]"]);
    expect(unattachedIssues([a], byPath)).toEqual([]);
  });

  it("returns the zero-steps issue — bucketIssuesByStepPath drops it because no card exists to own it", () => {
    const noSteps = issue("steps", "active automations need at least one step");
    const byPath = bucketIssuesByStepPath([noSteps], []);
    expect(unattachedIssues([noSteps], byPath)).toEqual([noSteps]);
  });

  it("returns a stale issue whose path matches no rendered step, the same way it treats the zero-steps case", () => {
    const stale = issue("steps[5].text");
    const byPath = bucketIssuesByStepPath([stale], ["steps[0]", "steps[1]"]);
    expect(unattachedIssues([stale], byPath)).toEqual([stale]);
  });

  it("separates attached from unattached when both are present in the same call, preserving order", () => {
    const attached = issue("steps[0].tag_id", "attached");
    const stale = issue("steps[5].text", "stale");
    const byPath = bucketIssuesByStepPath([attached, stale], ["steps[0]"]);
    expect(unattachedIssues([attached, stale], byPath)).toEqual([stale]);
  });

  it("returns an empty array, not undefined, for no issues at all", () => {
    expect(unattachedIssues([], new Map())).toEqual([]);
  });
});

// ============================================================
// <StepIssues> — compact amber strip. Static-render tests matching this
// repo's other component tests (message-preview.test.tsx, run-stats-bar.test.tsx):
// no jsdom/Testing Library here, so these assert on markup via
// renderToStaticMarkup. No NextIntlClientProvider is needed — the strip
// echoes validate.ts's own `issue.message` verbatim and does not call
// useTranslations itself (see step-issues.tsx's header comment on why:
// restating those messages through next-intl risks the two drifting).
// ============================================================

function renderIssues(issues: ValidationIssue[]) {
  return renderToStaticMarkup(React.createElement(StepIssues, { issues }));
}

describe("StepIssues", () => {
  it("renders nothing when issues is empty", () => {
    expect(renderIssues([])).toBe("");
  });

  it("renders each issue's message verbatim, unaltered", () => {
    const html = renderIssues([
      { path: "steps[0].text", message: "a send step needs text, media or buttons" },
    ]);
    expect(html).toContain("a send step needs text, media or buttons");
  });

  it("renders one line per issue when a step has more than one", () => {
    const html = renderIssues([
      { path: "steps[0].text", message: "first problem" },
      { path: "steps[0].fallback.template_name", message: "second problem" },
    ]);
    expect(html).toContain("first problem");
    expect(html).toContain("second problem");
  });

  it("uses amber styling, not destructive/red — a draft note, not an error on something broken", () => {
    const html = renderIssues([{ path: "steps[0].text", message: "x" }]);
    expect(html).toMatch(/amber/);
    expect(html).not.toMatch(/destructive/);
  });
});

// ============================================================
// useStepIssues — thin useMemo composition of validateStepsForActivation
// + collectStepPaths + bucketIssuesByStepPath. The three pieces it wires
// together already have direct coverage above; this one harness render
// proves the SEAM: that a real BuilderStep-shaped tree flows through
// validateStepsForActivation without a runtime mismatch, and that the
// resulting bucket actually reaches <StepIssues> for the right step.
// ============================================================

function Harness({ steps, path }: { steps: StepTreeNode[]; path: string }) {
  const { issues, byPath, unattached } = useStepIssues(steps);
  return React.createElement(
    "div",
    null,
    `total:${issues.length} unattached:${unattached.length}`,
    React.createElement(StepIssues, { issues: byPath.get(path) ?? [] }),
  );
}

describe("useStepIssues integration", () => {
  it("surfaces a real send_message step's empty-config issue under its own path only", () => {
    const steps: StepTreeNode[] = [
      { step_type: "send_message", step_config: {} },
      { step_type: "add_tag", step_config: { tag_id: "t1" } },
    ];
    const html = renderToStaticMarkup(
      React.createElement(Harness, { steps, path: "steps[0]" }),
    );
    expect(html).toContain("total:1");
    expect(html).toContain("a send step needs text, media or buttons");
  });

  it("a fully valid tree produces zero issues and an empty strip", () => {
    const steps: StepTreeNode[] = [{ step_type: "send_message", step_config: { text: "hi" } }];
    const html = renderToStaticMarkup(
      React.createElement(Harness, { steps, path: "steps[0]" }),
    );
    expect(html).toBe("<div>total:0 unattached:0</div>");
  });

  it("the zero-steps tree surfaces its single issue as unattached — I-3's whole failure mode", () => {
    const html = renderToStaticMarkup(React.createElement(Harness, { steps: [], path: "steps[0]" }));
    expect(html).toContain("total:1");
    expect(html).toContain("unattached:1");
  });
});
