import { expect, test } from "vitest";
import { extractRefCode, extractCtwaClid } from "./attribution";

test("extractRefCode finds our code anywhere, uppercased", () => {
  expect(extractRefCode("Hi… my enquiry ref: hy-3f9k2q")).toBe("HY-3F9K2Q");
  expect(extractRefCode("just a normal message")).toBeNull();
  expect(extractRefCode(undefined)).toBeNull();
});

test("extractCtwaClid reads a flattened ctwaClid", () => {
  expect(extractCtwaClid({ ctwaClid: "abc123" })).toBe("abc123");
  expect(extractCtwaClid({})).toBeNull();
});

test("extractRefCode embeds code mid-sentence", () => {
  expect(extractRefCode("book now HY-ABCDEF please")).toBe("HY-ABCDEF");
});

test("extractRefCode charset boundary", () => {
  expect(extractRefCode("HY-IIIIII")).toBeNull();
  expect(extractRefCode("HY-000000")).toBe("HY-000000");
  expect(extractRefCode("HY-ABCDEL")).toBeNull(); // L now excluded
});

test("extractRefCode null input", () => {
  expect(extractRefCode(null)).toBeNull();
  expect(extractRefCode("")).toBeNull(); // empty string
});
