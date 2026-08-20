import { expect, test } from "vitest";
import {
  SESSION_COOKIE_MAX_AGE_SECONDS,
  SESSION_INACTIVE_DURATION_MS,
  SESSION_TOTAL_DURATION_MS,
} from "./sessionDuration";

const DAY_MS = 1000 * 60 * 60 * 24;

test("the sliding window is 30 days and the absolute cap is a year", () => {
  expect(SESSION_INACTIVE_DURATION_MS).toBe(30 * DAY_MS);
  expect(SESSION_TOTAL_DURATION_MS).toBe(365 * DAY_MS);
});

test("the absolute cap exceeds the sliding window", () => {
  // If the cap were the shorter of the two it would silently truncate
  // the sliding window, and users would be signed out on a schedule
  // nothing in the cookie layer explains.
  expect(SESSION_TOTAL_DURATION_MS).toBeGreaterThan(
    SESSION_INACTIVE_DURATION_MS,
  );
});

test("the cookie Max-Age matches the refresh-token window exactly", () => {
  // A cookie shorter than its refresh token logs the user out while the
  // server-side session is still valid — the exact bug this work fixes.
  // A longer one presents a token the server has already expired.
  expect(SESSION_COOKIE_MAX_AGE_SECONDS * 1000).toBe(
    SESSION_INACTIVE_DURATION_MS,
  );
});

test("the cookie Max-Age is a positive integer", () => {
  // `Set-Cookie: Max-Age=` must be an integer number of seconds; a
  // fractional value is not a valid cookie attribute.
  expect(Number.isInteger(SESSION_COOKIE_MAX_AGE_SECONDS)).toBe(true);
  expect(SESSION_COOKIE_MAX_AGE_SECONDS).toBeGreaterThan(0);
});
