import { expect, test } from "vitest";
import { normalizePhone } from "./phone";

test("normalizePhone strips every non-digit character", () => {
  expect(normalizePhone("+370 63949836")).toBe("37063949836");
  expect(normalizePhone("(555) 123-4567")).toBe("5551234567");
  expect(normalizePhone("370-63-949-836")).toBe("37063949836");
  expect(normalizePhone("")).toBe("");
});
