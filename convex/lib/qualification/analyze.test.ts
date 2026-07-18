import { expect, test } from "vitest";
import {
  buildAnalysisPrompt,
  parseAnalysis,
  mergeFields,
  countAnswered,
  type SessionField,
} from "./analyze";
import { holidayysDefaultConfig } from "./defaults";

test("buildAnalysisPrompt embeds checklist excerpts, known fields and the JSON contract", () => {
  const prompt = buildAnalysisPrompt({
    checklistExcerpts: ["QUALIFICATION CHECKLIST — UAE visa\n1. nationality — ask their nationality [required, 20 marks]"],
    basicFields: holidayysDefaultConfig().basicFields,
    knownFields: [{ key: "nationality", value: "Indian" }],
  });
  expect(prompt).toContain("QUALIFICATION CHECKLIST — UAE visa");
  expect(prompt).toContain("nationality: Indian"); // known answers listed
  expect(prompt).toContain('"checklistSatisfied"'); // JSON contract
  expect(prompt).toContain('"intent"');
  expect(prompt).toContain("travel_dates"); // fallback basics offered
});

test("parseAnalysis handles a clean payload and clamps/caps", () => {
  const raw = JSON.stringify({
    service: "UAE visa",
    fields: [
      { key: "nationality", label: "Nationality", value: "Indian", confidence: "high" },
      { key: "bad", value: 42, confidence: "high" }, // non-string value dropped
    ],
    score: 250, // clamped to 100
    scoreBreakdown: [{ criterion: "nationality", marks: 20, maxMarks: 20 }],
    checklistSatisfied: true,
    expectedCount: 0, // floored to 1
    nextQuestion: { key: "dates", text: "When?", alternates: ["a", "b", "c", "d"] }, // capped at 3
    intent: "none",
    summary: "  Indian national, 60-day visa  ",
  });
  const parsed = parseAnalysis(raw)!;
  expect(parsed.serviceName).toBe("UAE visa");
  expect(parsed.fields).toHaveLength(1);
  expect(parsed.score).toBe(100);
  expect(parsed.expectedCount).toBe(1);
  expect(parsed.nextQuestion?.alternates).toHaveLength(3);
  expect(parsed.summary).toBe("Indian national, 60-day visa");
  expect(parsed.checklistSatisfied).toBe(true);
});

test("parseAnalysis survives fenced/prose-wrapped output and defaults missing keys", () => {
  const raw = 'Sure! Here you go:\n```json\n{"fields": [], "score": -5}\n```';
  const parsed = parseAnalysis(raw)!;
  expect(parsed.score).toBe(0);
  expect(parsed.intent).toBe("none");
  expect(parsed.checklistSatisfied).toBe(false);
  expect(parsed.nextQuestion).toBeNull();
  expect(parsed.serviceName).toBeNull();
  expect(parsed.expectedCount).toBe(1);
});

test("parseAnalysis returns null on garbage and rejects invalid intents", () => {
  expect(parseAnalysis("no json here")).toBeNull();
  const parsed = parseAnalysis('{"intent": "explode"}')!;
  expect(parsed.intent).toBe("none");
});

test("mergeFields: high/medium overwrite, low only fills blanks; countAnswered ignores low", () => {
  const existing: SessionField[] = [
    { key: "destination", value: "Bali", confidence: "high", updatedAt: 1 },
    { key: "email", value: "old@x.com", confidence: "medium", updatedAt: 1 },
  ];
  const merged = mergeFields(
    existing,
    [
      { key: "destination", value: "Maldives", confidence: "low" }, // must NOT overwrite
      { key: "email", value: "new@x.com", confidence: "high" }, // overwrites
      { key: "travelers", value: "2 adults", confidence: "low" }, // fills blank
    ],
    99,
  );
  const byKey = Object.fromEntries(merged.map((f) => [f.key, f]));
  expect(byKey.destination.value).toBe("Bali");
  expect(byKey.email.value).toBe("new@x.com");
  expect(byKey.email.updatedAt).toBe(99);
  expect(byKey.travelers.value).toBe("2 adults");
  expect(countAnswered(merged)).toBe(2); // travelers is low-confidence
});
