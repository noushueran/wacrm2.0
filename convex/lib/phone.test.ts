import { expect, test } from "vitest";
import { normalizePhone, isValidE164 } from "./phone";

test("normalizePhone strips every non-digit character", () => {
  expect(normalizePhone("+370 63949836")).toBe("37063949836");
  expect(normalizePhone("(555) 123-4567")).toBe("5551234567");
  expect(normalizePhone("370-63-949-836")).toBe("37063949836");
  expect(normalizePhone("")).toBe("");
});

test("isValidE164 accepts 7-15 digits with no leading zero", () => {
  expect(isValidE164("14155550123")).toBe(true);
  expect(isValidE164("+14155550123")).toBe(true);
  expect(isValidE164("3706394")).toBe(true);
});

test("isValidE164 rejects a leading zero, too-short, too-long, or empty input", () => {
  expect(isValidE164("0145550123")).toBe(false);
  expect(isValidE164("123456")).toBe(false);
  expect(isValidE164("1234567890123456")).toBe(false);
  expect(isValidE164("")).toBe(false);
});
