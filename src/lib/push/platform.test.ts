import { describe, it, expect } from "vitest";
import { isIOS } from "./platform";

describe("isIOS", () => {
  it("detects iPhone", () => {
    expect(isIOS("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)")).toBe(true);
  });
  it("detects iPad on iPadOS (reports as Macintosh + touch)", () => {
    expect(isIOS("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) Version/17 Safari", 5)).toBe(true);
  });
  it("is false for Android", () => {
    expect(isIOS("Mozilla/5.0 (Linux; Android 14)")).toBe(false);
  });
  it("is false for desktop Chrome", () => {
    expect(isIOS("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) Chrome/120", 0)).toBe(false);
  });
});
