import { expect, test } from "vitest";
import { extractRefCode, extractCtwaClid, decodeHidden } from "./attribution";

// Mirror the landing-side encoder (go-holidayys src/lib/tracking/hidden-code.ts) so
// these tests also prove the two sides agree on the exact COMPACT wire format:
// 6 base32 chars → 5 bits each → 30 zero-width chars.
const ALPHABET = "0123456789ABCDEFGHJKLMNPQRSTVWXYZ".replace(/[ILOU]/g, "");
function encodeHidden(code: string): string {
  let out = "";
  for (const ch of code) {
    const bits = ALPHABET.indexOf(ch).toString(2).padStart(5, "0");
    for (const b of bits) out += b === "0" ? "​" : "‌";
  }
  return out;
}

test("extractCtwaClid reads a flattened ctwaClid", () => {
  expect(extractCtwaClid({ ctwaClid: "abc123" })).toBe("abc123");
  expect(extractCtwaClid({})).toBeNull();
});

test("extractRefCode decodes the INVISIBLE compact code anchored after the greeting", () => {
  const body = "Hi," + encodeHidden("K3M9ZQ") + " I need a UAE visa.";
  // Stripping the zero-width chars leaves a plain message — the code is invisible.
  expect(body.replace(/[​‌]/g, "")).toBe("Hi, I need a UAE visa.");
  expect(extractRefCode(body)).toBe("K3M9ZQ");
});

test("extractRefCode reads an invisible code with no visible text at all", () => {
  expect(extractRefCode(encodeHidden("ABCDEF"))).toBe("ABCDEF");
});

test("extractRefCode ignores trailing stray zero-width chars", () => {
  expect(extractRefCode("Hi" + encodeHidden("K3M9ZQ") + " there​‌")).toBe("K3M9ZQ");
});

test("extractRefCode has NO visible fallback — a plain 'HY-...' string is not a code", () => {
  expect(extractRefCode("book now HY-ABCDEF please")).toBeNull();
  expect(extractRefCode("just a normal message")).toBeNull();
});

test("decodeHidden returns null without a full hidden code", () => {
  expect(decodeHidden("just a normal message")).toBeNull();
  expect(decodeHidden("a​‌b")).toBeNull(); // only 2 hidden bits
});

test("extractRefCode null / empty input", () => {
  expect(extractRefCode(null)).toBeNull();
  expect(extractRefCode(undefined)).toBeNull();
  expect(extractRefCode("")).toBeNull();
});
