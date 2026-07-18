import { expect, test } from "vitest";
import {
  LOSS_CATEGORY_KEYS,
  PIPELINE_STAGE_KEYS,
  effectivePipelineStage,
  groupLeadsByStage,
} from "./pipeline";

test("PIPELINE_STAGE_KEYS runs qualified → purchased → lost", () => {
  expect(PIPELINE_STAGE_KEYS[0]).toBe("qualified");
  expect(PIPELINE_STAGE_KEYS).toContain("purchased");
  expect(PIPELINE_STAGE_KEYS[PIPELINE_STAGE_KEYS.length - 1]).toBe("lost");
  expect(PIPELINE_STAGE_KEYS).not.toContain("new_lead");
});

test("effectivePipelineStage clamps pre-deal funnel stages to qualified and excludes non-qualified sessions", () => {
  expect(effectivePipelineStage({ status: "qualified", funnelStage: null })).toBe("qualified");
  expect(effectivePipelineStage({ status: "qualified", funnelStage: "new_lead" })).toBe("qualified");
  expect(effectivePipelineStage({ status: "qualified", funnelStage: "invoice_sent" })).toBe("invoice_sent");
  expect(effectivePipelineStage({ status: "qualified", funnelStage: "lost" })).toBe("lost");
  expect(effectivePipelineStage({ status: "collecting", funnelStage: "price_quoted" })).toBeNull();
  expect(effectivePipelineStage({ status: "expired", funnelStage: null })).toBeNull();
});

test("groupLeadsByStage buckets qualified sessions by effective stage", () => {
  const leads = [
    { sessionId: "a", status: "qualified", funnelStage: null },
    { sessionId: "b", status: "qualified", funnelStage: "price_quoted" },
    { sessionId: "c", status: "qualified", funnelStage: "lost" },
    { sessionId: "d", status: "collecting", funnelStage: null },
  ];
  const grouped = groupLeadsByStage(leads);
  expect(grouped.qualified.map((l) => l.sessionId)).toEqual(["a"]);
  expect(grouped.price_quoted.map((l) => l.sessionId)).toEqual(["b"]);
  expect(grouped.lost.map((l) => l.sessionId)).toEqual(["c"]);
  expect(grouped.purchased).toEqual([]);
});

test("loss category keys mirror the server vocabulary", () => {
  expect(LOSS_CATEGORY_KEYS).toEqual([
    "price", "competitor", "budget", "timing", "unresponsive", "changed_plans", "other",
  ]);
});
