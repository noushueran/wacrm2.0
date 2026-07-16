import { afterEach, describe, expect, it, vi } from "vitest";
import { isIOS, isStandalone } from "./platform";

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

describe("isStandalone", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is false when window is undefined (node/SSR default)", () => {
    expect(isStandalone()).toBe(false);
  });

  it("is true when the display-mode: standalone media query matches", () => {
    vi.stubGlobal("window", {
      matchMedia: (query: string) => ({
        matches: query === "(display-mode: standalone)",
      }),
    });
    expect(isStandalone()).toBe(true);
  });

  it("is true when navigator.standalone is true (iOS legacy flag)", () => {
    vi.stubGlobal("window", {
      navigator: { standalone: true },
    });
    expect(isStandalone()).toBe(true);
  });
});
