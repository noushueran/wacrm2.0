import { expect, test } from "vitest";
import { planEntryChunks, planOpsChunks } from "./compilePure";

test("entry chunks get a grounding header naming service and title", () => {
  const plans = planEntryChunks({
    serviceName: "Georgia Holiday Packages", title: "Visa requirements",
    body: "Passport valid 6 months.\n\nNo visa needed for UAE residents.",
  });
  expect(plans).toHaveLength(1);
  expect(plans[0].content.startsWith(
    "[Georgia Holiday Packages — Visa requirements]\n")).toBe(true);
  expect(plans[0].chunkIndex).toBe(0);
});

test("company-scope entries use the Company header", () => {
  const [plan] = planEntryChunks({ serviceName: null, title: "Office hours", body: "Daily 10-21." });
  expect(plan.content).toBe("[Company — Office hours]\nDaily 10-21.");
});

test("long bodies split into multiple chunks, each with the header", () => {
  const para = "A".repeat(900);
  const plans = planEntryChunks({
    serviceName: null, title: "Long", body: `${para}\n\n${para}\n\n${para}`,
  });
  expect(plans.length).toBeGreaterThan(1);
  for (const [i, p] of plans.entries()) {
    expect(p.chunkIndex).toBe(i);
    expect(p.content.startsWith("[Company — Long]\n")).toBe(true);
  }
});

test("ops blocks compile to exactly one sentinel chunk, never split", () => {
  const plans = planOpsChunks("UAE Visa Services", {
    kind: "qualification",
    criteria: Array.from({ length: 40 }, (_, i) => ({
      key: `c${i}`, label: `Criterion number ${i} with a fairly long label`, marks: undefined,
    })),
  });
  expect(plans).toHaveLength(1);
  expect(plans[0].content).toContain("QUALIFICATION CHECKLIST — UAE Visa Services");
});

test("empty body/ops produce no chunks", () => {
  expect(planEntryChunks({ serviceName: null, title: "x", body: "   " })).toEqual([]);
  expect(planOpsChunks("X", { kind: "sales", steps: [] })).toEqual([
    { chunkIndex: 0, content: "SALES CHECKLIST — X" },
  ]);
});
