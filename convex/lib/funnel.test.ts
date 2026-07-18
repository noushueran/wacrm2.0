import { expect, test } from "vitest";
import {
  FUNNEL_STAGES,
  FUNNEL_STAGE_KEYS,
  getStage,
  resolveEventName,
  backendForLane,
} from "./funnel";

test("stages run new_lead → purchased with the terminal lost appended last", () => {
  expect(FUNNEL_STAGE_KEYS).toEqual([
    "new_lead",
    "qualified",
    "price_quoted",
    "itinerary_created",
    "itinerary_sent",
    "invoice_sent",
    "purchased",
    // LAST on purpose: neverDowngrade index math means the engine can
    // never pull a lost deal back into the working stages.
    "lost",
  ]);
});

test("lost is internal-only on both lanes (Meta has no lost event)", () => {
  expect(resolveEventName("ctwa", "lost")).toBeNull();
  expect(resolveEventName("code", "lost")).toBeNull();
});

test("only new_lead is auto; only purchased needs a value", () => {
  expect(FUNNEL_STAGES.filter((s) => s.auto).map((s) => s.key)).toEqual([
    "new_lead",
  ]);
  expect(FUNNEL_STAGES.filter((s) => s.needsValue).map((s) => s.key)).toEqual([
    "purchased",
  ]);
});

test("resolveEventName maps each lane to its event, null for internal-only", () => {
  expect(resolveEventName("ctwa", "new_lead")).toBe("LeadSubmitted");
  expect(resolveEventName("code", "new_lead")).toBe("Lead");
  expect(resolveEventName("ctwa", "purchased")).toBe("Purchase");
  expect(resolveEventName("code", "purchased")).toBe("Purchase");
  expect(resolveEventName("ctwa", "invoice_sent")).toBe("OrderCreated");
  expect(resolveEventName("code", "invoice_sent")).toBe("InitiateCheckout");
  // itinerary_created is internal-only on BOTH lanes
  expect(resolveEventName("ctwa", "itinerary_created")).toBeNull();
  expect(resolveEventName("code", "itinerary_created")).toBeNull();
});

test("backendForLane routes code→platformA, ctwa→capi", () => {
  expect(backendForLane("code")).toBe("platformA");
  expect(backendForLane("ctwa")).toBe("capi");
});

test("getStage returns the stage record by key", () => {
  expect(getStage("qualified").metaCapi).toBe("QualifiedLead");
  expect(getStage("price_quoted").webPixel).toBe("InitiateCheckout");
});
