import { expect, test } from "vitest";
import {
  COACH_DIMENSIONS,
  SYNTHETIC_COACHING_RAW,
  buildCoachPrompt,
  parseCoaching,
} from "./prompt";

const base = {
  salespersonName: "Neha",
  transcript: "Customer: How much is the visa?\nAgent: Let me check.",
  outstandingChecklist: ["Send the price"],
  firstResponseMinutes: 45,
};

test("the prompt states the computed response time as fact, not a question", () => {
  const p = buildCoachPrompt(base);
  expect(p).toContain("45 minutes");
  expect(p).toContain("Neha");
  expect(p).toContain("Send the price");
});

test("no human reply is stated plainly rather than as zero", () => {
  const p = buildCoachPrompt({ ...base, firstResponseMinutes: null });
  expect(p).toContain("No human ever replied");
});

test("the prompt forbids scoring and demands evidence", () => {
  const p = buildCoachPrompt(base);
  expect(p).toContain("Do NOT score");
  expect(p).toContain("QUOTE THE THREAD");
  // And it must allow a clean thread to come back empty.
  expect(p).toContain("return no observations at all");
});

test("the prompt bars judging anything outside the thread", () => {
  // Calls and in-person meetings are invisible here; guessing at them
  // would be inventing faults about a real person.
  expect(buildCoachPrompt(base)).toContain("Never guess at what happened on");
});

test("a well-formed review parses", () => {
  const parsed = parseCoaching(SYNTHETIC_COACHING_RAW);
  expect(parsed?.observations).toHaveLength(1);
  expect(parsed?.observations[0]!.quote).toBeTruthy();
  expect(parsed?.strengths).toHaveLength(1);
});

test("an observation with no quote is DROPPED, not filed", () => {
  // The rule that matters most: criticism of a colleague without
  // evidence does not get recorded.
  const parsed = parseCoaching(
    JSON.stringify({
      observations: [
        { dimension: "tone", observation: "Seemed rude" },
        { dimension: "tone", observation: "Was curt", quote: "no." },
      ],
      strengths: [],
    }),
  );
  expect(parsed?.observations).toHaveLength(1);
  expect(parsed?.observations[0]!.observation).toBe("Was curt");
});

test("an unknown dimension is dropped rather than coerced", () => {
  const parsed = parseCoaching(
    JSON.stringify({
      observations: [{ dimension: "attitude", observation: "x", quote: "y" }],
    }),
  );
  expect(parsed?.observations).toHaveLength(0);
});

test("a clean thread parses to no observations rather than null", () => {
  const parsed = parseCoaching(JSON.stringify({ observations: [], strengths: ["Handled well"] }));
  expect(parsed).not.toBeNull();
  expect(parsed?.observations).toHaveLength(0);
  expect(parsed?.strengths).toEqual(["Handled well"]);
});

test("parsing never throws on junk", () => {
  for (const junk of ["not json", "[1]", "null", "{}"]) {
    expect(() => parseCoaching(junk)).not.toThrow();
  }
  expect(parseCoaching("not json")).toBeNull();
});

test("every dimension the prompt names is one the parser accepts", () => {
  for (const d of COACH_DIMENSIONS) {
    const parsed = parseCoaching(
      JSON.stringify({ observations: [{ dimension: d, observation: "o", quote: "q" }] }),
    );
    expect(parsed?.observations, `${d} was rejected`).toHaveLength(1);
  }
});
