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
    { sessionId: "a", conversationId: "c-a", startedAt: 1, status: "qualified", funnelStage: null },
    { sessionId: "b", conversationId: "c-b", startedAt: 2, status: "qualified", funnelStage: "price_quoted" },
    { sessionId: "c", conversationId: "c-c", startedAt: 3, status: "qualified", funnelStage: "lost" },
    { sessionId: "d", conversationId: "c-d", startedAt: 4, status: "collecting", funnelStage: null },
  ];
  const grouped = groupLeadsByStage(leads);
  expect(grouped.qualified.map((l) => l.sessionId)).toEqual(["a"]);
  expect(grouped.price_quoted.map((l) => l.sessionId)).toEqual(["b"]);
  expect(grouped.lost.map((l) => l.sessionId)).toEqual(["c"]);
  expect(grouped.purchased).toEqual([]);
});

test("groupLeadsByStage collapses re-qualified sessions of one conversation to the latest deal", () => {
  // Prod repro: one WhatsApp conversation qualified 4× (new inquiry each
  // time) → 4 sessions sharing ONE conversation.funnel.stage. The board
  // must show the single live deal (the newest qualified session — the
  // same "latest session" rule funnel.setStage's checklist gate uses),
  // otherwise dragging any card visually drags every duplicate with it.
  const leads = [
    { sessionId: "old-a", conversationId: "conv1", startedAt: 100, status: "qualified", funnelStage: "price_quoted" },
    { sessionId: "old-b", conversationId: "conv1", startedAt: 200, status: "qualified", funnelStage: "price_quoted" },
    { sessionId: "latest", conversationId: "conv1", startedAt: 400, status: "qualified", funnelStage: "price_quoted" },
    { sessionId: "old-c", conversationId: "conv1", startedAt: 300, status: "qualified", funnelStage: "price_quoted" },
    // A different conversation is a separate deal with its own card.
    { sessionId: "other", conversationId: "conv2", startedAt: 150, status: "qualified", funnelStage: null },
    // Non-qualified sessions never ride the board, even when newest.
    { sessionId: "collect", conversationId: "conv1", startedAt: 500, status: "collecting", funnelStage: null },
  ];
  const grouped = groupLeadsByStage(leads);
  expect(grouped.price_quoted.map((l) => l.sessionId)).toEqual(["latest"]);
  expect(grouped.qualified.map((l) => l.sessionId)).toEqual(["other"]);
});

test("groupLeadsByStage dedupes across columns, not per column", () => {
  // A stale duplicate must not survive by sitting in a different column
  // than the latest session — the collapse happens before grouping.
  const leads = [
    { sessionId: "stale", conversationId: "conv1", startedAt: 100, status: "qualified", funnelStage: "qualified" },
    { sessionId: "live", conversationId: "conv1", startedAt: 200, status: "qualified", funnelStage: "invoice_sent" },
  ];
  const grouped = groupLeadsByStage(leads);
  expect(grouped.qualified).toEqual([]);
  expect(grouped.invoice_sent.map((l) => l.sessionId)).toEqual(["live"]);
});

test("loss category keys mirror the server vocabulary", () => {
  expect(LOSS_CATEGORY_KEYS).toEqual([
    "price", "competitor", "budget", "timing", "unresponsive", "changed_plans", "other",
  ]);
});
