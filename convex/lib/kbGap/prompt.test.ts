import { expect, test } from "vitest";
import {
  DRAFTABLE_TYPES,
  SYNTHETIC_CLUSTER_RAW,
  SYNTHETIC_ENTRY_RAW,
  buildClusterPrompt,
  buildEntryPrompt,
  parseClusters,
  parseEntryDraft,
} from "./prompt";

const REAL = {
  question: "Can an Indian applicant later change from the 2-year freelance visa to a company visa?",
  answer: "Yes , freelance visa can change to employment visa later",
  serviceName: "Freelance Visa",
};

test("the entry prompt carries the exchange and forbids adding facts", () => {
  const p = buildEntryPrompt({ ...REAL });
  expect(p).toContain(REAL.question);
  expect(p).toContain(REAL.answer);
  expect(p).toContain("Freelance Visa");
  // The load-bearing rule: it rewrites, it does not research.
  expect(p).toContain("Never add a fact it does not contain");
});

test("the cluster prompt refuses to answer, in as many words", () => {
  const p = buildClusterPrompt({ questions: ["Do you do Schengen visas?", "Schengen cost?"] });
  expect(p).toContain("DO NOT ANSWER");
  expect(p).toContain("1. Do you do Schengen visas?");
  expect(p).toContain("2. Schengen cost?");
});

test("a drafted entry parses into something publishable", () => {
  const parsed = parseEntryDraft(SYNTHETIC_ENTRY_RAW);
  expect(parsed?.worthKeeping).toBe(true);
  expect(parsed?.title).toBeTruthy();
  expect(parsed?.body).toBeTruthy();
  expect(DRAFTABLE_TYPES).toContain(parsed!.type);
});

test("a rejection is a complete answer and needs no title or body", () => {
  const parsed = parseEntryDraft(
    JSON.stringify({ worthKeeping: false, reason: "A deflection, not knowledge" }),
  );
  expect(parsed?.worthKeeping).toBe(false);
  expect(parsed?.reason).toContain("deflection");
});

test("keeping something with no body is refused rather than filed empty", () => {
  expect(parseEntryDraft(JSON.stringify({ worthKeeping: true, title: "T" }))).toBeNull();
  expect(parseEntryDraft(JSON.stringify({ worthKeeping: true, body: "B" }))).toBeNull();
});

test("an unknown type degrades to faq rather than writing a bad enum", () => {
  const parsed = parseEntryDraft(
    JSON.stringify({ worthKeeping: true, title: "T", body: "B", type: "itinerary-ish" }),
  );
  expect(parsed?.type).toBe("faq");
});

test("entry parsing never throws on junk", () => {
  for (const junk of ["not json", "{}", "[1,2]", "null", '{"worthKeeping":true}']) {
    expect(() => parseEntryDraft(junk)).not.toThrow();
  }
  expect(parseEntryDraft("not json")).toBeNull();
});

test("clusters map back to the right questions, biggest theme first", () => {
  const themes = parseClusters(
    JSON.stringify({
      themes: [
        { theme: "Cost", questions: [3] },
        { theme: "Schengen", questions: [1, 2] },
      ],
    }),
    3,
  );
  expect(themes[0]!.theme).toBe("Schengen");
  expect(themes[0]!.indexes).toEqual([0, 1]);
  expect(themes[1]!.indexes).toEqual([2]);
});

test("out-of-range and duplicate numbers are dropped, not trusted", () => {
  // The model is 1-based and enthusiastic; an index off the end would
  // read someone else's question into a theme.
  const themes = parseClusters(
    JSON.stringify({
      themes: [
        { theme: "A", questions: [1, 99, -4, 1] },
        { theme: "B", questions: [1] },
      ],
    }),
    2,
  );
  expect(themes).toHaveLength(1);
  expect(themes[0]!.indexes).toEqual([0]);
});

test("a theme with no valid questions is discarded entirely", () => {
  expect(parseClusters(JSON.stringify({ themes: [{ theme: "X", questions: [42] }] }), 2)).toEqual([]);
  expect(parseClusters("junk", 5)).toEqual([]);
});

test("the synthetic cluster parses, so dry-run exercises the real path", () => {
  expect(parseClusters(SYNTHETIC_CLUSTER_RAW, 1)).toHaveLength(1);
});
