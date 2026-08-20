import { expect, test } from "vitest";
import { extractTemplateVariables } from "./templateVars";

test("extracts placeholders in numeric order", () => {
  expect(extractTemplateVariables("Hi {{1}}, your {{2}} is ready")).toEqual([1, 2]);
});

test("orders numerically regardless of position in the body", () => {
  expect(extractTemplateVariables("{{2}} comes after {{1}}")).toEqual([1, 2]);
});

test("sorts 10 after 2 — lexicographic sort is the bug this guards", () => {
  expect(extractTemplateVariables("{{10}} {{2}} {{1}}")).toEqual([1, 2, 10]);
});

test("de-duplicates a placeholder used twice", () => {
  expect(extractTemplateVariables("{{1}} and again {{1}}")).toEqual([1]);
});

test("ignores non-numeric placeholders", () => {
  expect(extractTemplateVariables("Hello {{name}}")).toEqual([]);
});

test("tolerates inner whitespace", () => {
  expect(extractTemplateVariables("Hi {{ 1 }}")).toEqual([1]);
});

test("returns empty for a body with no placeholders", () => {
  expect(extractTemplateVariables("No placeholders here")).toEqual([]);
});

test("returns empty for an empty body", () => {
  expect(extractTemplateVariables("")).toEqual([]);
});
