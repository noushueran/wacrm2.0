import { expect, test } from "vitest";
import { adFreeWindowRemainingMs, AD_FREE_WINDOW_MS } from "./adWindow";

const HOUR = 60 * 60 * 1000;

test("full window remaining at the moment it starts", () => {
  expect(adFreeWindowRemainingMs(1_000, 1_000)).toBe(AD_FREE_WINDOW_MS);
});

test("about one hour remaining near the end", () => {
  const started = 0;
  const now = AD_FREE_WINDOW_MS - HOUR;
  expect(adFreeWindowRemainingMs(started, now)).toBe(HOUR);
});

test("clamps to 0 once the 72h have elapsed", () => {
  expect(adFreeWindowRemainingMs(0, AD_FREE_WINDOW_MS + HOUR)).toBe(0);
});
