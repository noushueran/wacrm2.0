import { expect, test } from "vitest";
import {
  buildAnalysisPrompt,
  parseAnalysis,
  mergeFields,
  countAnswered,
  isNonAnswer,
  type SessionField,
} from "./analyze";
import { defaultQualificationConfig } from "./defaults";

test("buildAnalysisPrompt embeds checklist excerpts, known fields and the JSON contract", () => {
  const prompt = buildAnalysisPrompt({
    checklistExcerpts: ["QUALIFICATION CHECKLIST — UAE visa\n1. nationality — ask their nationality [required, 20 marks]"],
    basicFields: defaultQualificationConfig().basicFields,
    knownFields: [{ key: "nationality", value: "Indian" }],
  });
  expect(prompt).toContain("QUALIFICATION CHECKLIST — UAE visa");
  expect(prompt).toContain("nationality: Indian"); // known answers listed
  expect(prompt).toContain('"checklistSatisfied"'); // JSON contract
  expect(prompt).toContain('"intent"');
  expect(prompt).toContain("travel_dates"); // fallback basics offered
  // The JSON example must never re-anchor the model on the inside/outside
  // question: it pulled the model back to asking it even after the
  // checklist dropped it (spec 2026-07-25-uae-visa-flow-simplification).
  expect(prompt).not.toContain("inside the UAE");
  expect(prompt).toContain("Never propose a question the customer");
  expect(prompt).toContain("documents, photos, or ID copies");
  expect(prompt).toContain('still return it in "fields"');
  // A lead the BUSINESS declined is disqualified however keen the
  // customer still is. Reported 2026-07-30: an agent wrote "sorry sir
  // pakistan nationality we are not doing" and the follow-up ladder
  // nudged the thread for two more days.
  expect(prompt).toContain("the business has already told the customer it cannot serve them");
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

test("isNonAnswer recognises placeholders without eating real answers", () => {
  for (const v of [
    "Not provided",
    "not provided.",
    "Not provided by the customer",
    "not specified",
    "Not mentioned",
    "N/A",
    "n/a",
    "unknown",
    "TBD",
    "to be confirmed",
    "-",
    "—",
    "?",
    "   ",
  ]) {
    expect(isNonAnswer(v), v).toBe(true);
  }
  // Legitimate customer answers that merely LOOK negative.
  for (const v of ["no", "none", "no children", "0", "Nairobi", "Nauru", "Nathan"]) {
    expect(isNonAnswer(v), v).toBe(false);
  }
});

test("parseAnalysis drops placeholder field values instead of storing them", () => {
  const raw = JSON.stringify({
    service: "UAE visa",
    fields: [
      { key: "nationality", value: "Pakistani", confidence: "high" },
      { key: "email", value: "Not provided", confidence: "low" },
      { key: "travel_dates", value: "N/A", confidence: "low" },
    ],
    intent: "none",
  });
  const parsed = parseAnalysis(raw)!;
  expect(parsed.fields.map((f) => f.key)).toEqual(["nationality"]);
});

test("mergeFields retires placeholder rows already stored on a session", () => {
  // A session polluted before `isNonAnswer` shipped: the stale rows must
  // not survive into `knownFields`, where they read as "already
  // collected — email: Not provided" on every future analysis pass.
  const existing: SessionField[] = [
    { key: "nationality", value: "Pakistani", confidence: "high", updatedAt: 1 },
    { key: "email", value: "Not provided", confidence: "low", updatedAt: 1 },
  ];
  const merged = mergeFields(existing, [], 99);
  expect(merged.map((f) => f.key)).toEqual(["nationality"]);
});
