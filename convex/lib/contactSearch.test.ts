import { describe, expect, it } from "vitest";
import { matchesContactCode, matchesContactSearch } from "./contactSearch";

describe("matchesContactCode", () => {
  it("matches by bare number, padded number, and full code (any case)", () => {
    expect(matchesContactCode("HC-000042", "42")).toBe(true);
    expect(matchesContactCode("HC-000042", "000042")).toBe(true);
    expect(matchesContactCode("HC-000042", "HC-000042")).toBe(true);
    expect(matchesContactCode("HC-000042", "hc-000042")).toBe(true);
  });
  it("does not match a different number or an empty/undefined code", () => {
    expect(matchesContactCode("HC-000042", "43")).toBe(false);
    expect(matchesContactCode(undefined, "42")).toBe(false);
    expect(matchesContactCode("HC-000042", "")).toBe(false);
  });
});

describe("matchesContactSearch", () => {
  const c = {
    name: "Jonas Petraitis",
    phoneNormalized: "971501234567",
    email: "jonas@example.com",
    contactCode: "HC-000042",
  };
  it("matches name, email, phone digits, and id", () => {
    expect(matchesContactSearch(c, "jonas")).toBe(true);
    expect(matchesContactSearch(c, "EXAMPLE")).toBe(true);
    expect(matchesContactSearch(c, "50123")).toBe(true);
    expect(matchesContactSearch(c, "+971 50")).toBe(true); // non-digits ignored for phone
    expect(matchesContactSearch(c, "42")).toBe(true);
  });
  it("returns false when nothing matches", () => {
    expect(matchesContactSearch(c, "zzz")).toBe(false);
  });
});
