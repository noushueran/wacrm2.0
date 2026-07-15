import { expect, test } from "vitest";
import { buildFunnelSteps } from "./funnelView";

const base = { attributed: true, lane: "ctwa" as const, currentStage: null as string | null, reachedAt: {}, metaStatus: {} };

test("marks reached stages done, the current stage current, the rest upcoming", () => {
  const steps = buildFunnelSteps({
    ...base,
    currentStage: "price_quoted",
    reachedAt: { new_lead: 10, qualified: 20, price_quoted: 30 },
    metaStatus: { new_lead: "sent", price_quoted: "pending" },
  });
  const byKey = Object.fromEntries(steps.map((s) => [s.key, s]));
  expect(byKey.new_lead.done).toBe(true);
  expect(byKey.price_quoted.current).toBe(true);
  expect(byKey.itinerary_sent.upcoming).toBe(true);
  expect(byKey.new_lead.metaStatus).toBe("sent");
  expect(byKey.price_quoted.reportsToMeta).toBe(true);
  expect(byKey.itinerary_created.reportsToMeta).toBe(false); // internal-only
});

test("an organic funnel reports no stage as reporting to Meta", () => {
  const steps = buildFunnelSteps({ ...base, attributed: false, lane: null, currentStage: "qualified", reachedAt: { qualified: 5 } });
  expect(steps.every((s) => s.reportsToMeta === false)).toBe(true);
});
