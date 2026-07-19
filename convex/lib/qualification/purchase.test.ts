import { expect, test } from "vitest";
import {
  buildPurchasePrompt,
  parsePurchaseVerdict,
  syntheticPurchaseRaw,
  MIN_PURCHASE_CONFIDENCE,
  PURCHASE_EVAL_WINDOW_MS,
  PURCHASE_EVAL_DEBOUNCE_MS,
} from "./purchase";

test("buildPurchasePrompt embeds criteria excerpts, lead state, media count and the JSON contract", () => {
  const args = {
    criteriaExcerpts: [
      "PURCHASE CRITERIA — Georgia Packages\n- Budget of AED 2,500 or more PER PERSON.\nReport value: 3000 AED per person.",
    ],
    serviceName: "Georgia Packages",
    fields: [
      { key: "budget_per_person", label: "Budget per person", value: "AED 3,000" },
      { key: "travelers", value: "2 adults" },
    ],
    score: 85,
    summary: "Couple, Georgia in August",
    customerMediaCount: 2,
  };
  const prompt = buildPurchasePrompt(args);
  expect(prompt).toContain("PURCHASE CRITERIA — Georgia Packages");
  expect(prompt).toContain("Budget per person: AED 3,000");
  expect(prompt).toContain("travelers: 2 adults");
  expect(prompt).toContain("85/100");
  expect(prompt).toContain("Couple, Georgia in August");
  expect(prompt).toContain("2 media message(s)"); // deterministic docs-received signal
  expect(prompt).toContain('"met"'); // JSON contract
  expect(prompt).toContain('"criteriaFound"');
  expect(prompt).toContain('"confidence"');
  // Deterministic: same input, same prompt.
  expect(buildPurchasePrompt(args)).toBe(prompt);
});

test("buildPurchasePrompt degrades gracefully with nothing known", () => {
  const prompt = buildPurchasePrompt({
    criteriaExcerpts: [],
    serviceName: null,
    fields: [],
    score: null,
    summary: null,
    customerMediaCount: 0,
  });
  expect(prompt).toContain("(no knowledge-base excerpts retrieved)");
  expect(prompt).toContain("(unknown service)");
});

test("parsePurchaseVerdict handles a clean payload", () => {
  const parsed = parsePurchaseVerdict(
    JSON.stringify({
      met: true,
      confidence: 88,
      reasons: ["Budget AED 3,000/person confirmed", "Email collected"],
      value: 9000,
      currency: "aed",
      criteriaFound: true,
    }),
  )!;
  expect(parsed.met).toBe(true);
  expect(parsed.confidence).toBe(88);
  expect(parsed.reasons).toEqual([
    "Budget AED 3,000/person confirmed",
    "Email collected",
  ]);
  expect(parsed.value).toBe(9000);
  expect(parsed.currency).toBe("AED"); // uppercased
  expect(parsed.criteriaFound).toBe(true);
});

test("parsePurchaseVerdict clamps, drops junk values and survives prose wrapping", () => {
  const parsed = parsePurchaseVerdict(
    'Verdict:\n```json\n{"met": true, "confidence": 900, "reasons": ["ok", 42], "value": -50, "currency": "dirhams", "criteriaFound": true}\n```',
  )!;
  expect(parsed.confidence).toBe(100); // clamped
  expect(parsed.reasons).toEqual(["ok"]); // non-strings dropped
  expect(parsed.value).toBeNull(); // non-positive dropped
  expect(parsed.currency).toBeNull(); // not a 3-letter code
});

test("parsePurchaseVerdict defaults missing keys safely and never throws on garbage", () => {
  const parsed = parsePurchaseVerdict("{}")!;
  expect(parsed.met).toBe(false);
  expect(parsed.confidence).toBe(0);
  expect(parsed.reasons).toEqual([]);
  expect(parsed.value).toBeNull();
  expect(parsed.currency).toBeNull();
  expect(parsed.criteriaFound).toBe(false);

  expect(parsePurchaseVerdict("no json here at all")).toBeNull();
  expect(parsePurchaseVerdict("")).toBeNull();
});

test("syntheticPurchaseRaw marker matrix drives every branch", () => {
  // No marker → not met.
  const none = parsePurchaseVerdict(syntheticPurchaseRaw("hello there"))!;
  expect(none.met).toBe(false);
  expect(none.confidence).toBeLessThan(MIN_PURCHASE_CONFIDENCE);

  // [[PURCHASE]] → met at firing confidence.
  const met = parsePurchaseVerdict(syntheticPurchaseRaw("field:budget=3000; [[PURCHASE]]"))!;
  expect(met.met).toBe(true);
  expect(met.confidence).toBeGreaterThanOrEqual(MIN_PURCHASE_CONFIDENCE);
  expect(met.criteriaFound).toBe(true);

  // Value/currency markers ride along.
  const valued = parsePurchaseVerdict(
    syntheticPurchaseRaw("[[PURCHASE]] pvalue:9000; pcurrency:AED;"),
  )!;
  expect(valued.value).toBe(9000);
  expect(valued.currency).toBe("AED");

  // [[NOPURCHASE]] wins over [[PURCHASE]].
  const refused = parsePurchaseVerdict(
    syntheticPurchaseRaw("[[PURCHASE]] [[NOPURCHASE]]"),
  )!;
  expect(refused.met).toBe(false);
});

test("constants are wired as specced", () => {
  expect(MIN_PURCHASE_CONFIDENCE).toBe(70);
  expect(PURCHASE_EVAL_WINDOW_MS).toBe(7 * 24 * 3_600_000);
  expect(PURCHASE_EVAL_DEBOUNCE_MS).toBe(10_000);
});
