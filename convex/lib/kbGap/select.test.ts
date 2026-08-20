import { expect, test } from "vitest";
import {
  DEFAULT_KB_GAP_CONFIG,
  isThinAnswer,
  type KbGapConfig,
} from "./select";

const config: KbGapConfig = DEFAULT_KB_GAP_CONFIG;

test("a real answer is not thin", () => {
  // Verbatim from production — this is exactly the knowledge worth keeping.
  expect(
    isThinAnswer("Yes , freelance visa can change to employment visa later", config),
  ).toBe(false);
  expect(
    isThinAnswer("Our office located in dubai , but we can assist him", config),
  ).toBe(false);
});

test("a bare acknowledgement is thin however it is punctuated", () => {
  // "Okay" is a real stored answer in production.
  for (const a of ["Okay", "ok", "OK.", "yes", "Yes!", "no", "done", "Noted.", "sure"]) {
    expect(isThinAnswer(a, config), `${a} should be thin`).toBe(true);
  }
});

test("an answer under the character floor is thin", () => {
  expect(isThinAnswer("Dubai", config)).toBe(true);
  expect(isThinAnswer("   ", config)).toBe(true);
  expect(isThinAnswer("", config)).toBe(true);
});

test("a leading yes does not make a substantive answer thin", () => {
  // The obvious trap: rejecting anything starting with "yes" would throw
  // away the single best answer in the production sample.
  expect(
    isThinAnswer("Yes, an Indian national can apply from inside the UAE.", config),
  ).toBe(false);
});

test("the floor is configurable", () => {
  const strict: KbGapConfig = { ...config, minAnswerChars: 200 };
  expect(isThinAnswer("Yes , freelance visa can change to employment visa later", strict)).toBe(true);
});

test("judging a long deflection is deliberately NOT this function's job", () => {
  // "Tell them our team will contact you for this solution" is long and
  // useless. Catching that needs to read meaning, so it is left to the
  // model's `worthKeeping` verdict — a keyword list here would be a
  // guess that also rejects real answers mentioning the team.
  expect(
    isThinAnswer("Tell them our team will contact you for this solution", config),
  ).toBe(false);
});

test("the defaults are switched off, with a sane floor", () => {
  expect(DEFAULT_KB_GAP_CONFIG.enabled).toBe(false);
  expect(DEFAULT_KB_GAP_CONFIG.minAnswerChars).toBeGreaterThan(5);
  expect(DEFAULT_KB_GAP_CONFIG.entriesPerRun).toBeGreaterThan(0);
});
