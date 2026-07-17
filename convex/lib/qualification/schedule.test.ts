import { expect, test } from "vitest";
import {
  clampToWorkingHours,
  computeNextFollowUpAt,
  isSessionExpired,
  withinServiceWindow,
  pickFollowUpText,
  type WorkingHoursConfig,
} from "./schedule";
import { holidayysDefaultConfig } from "./defaults";

// Dubai (+240): Mon 2026-07-20 12:00 GST == 08:00 UTC.
const DUBAI: WorkingHoursConfig = {
  utcOffsetMinutes: 240,
  workStartMinute: 10 * 60,
  workEndMinute: 21 * 60,
  workDays: [1, 2, 3, 4, 5, 6], // closed Sunday
};
const MON_NOON_GST = Date.UTC(2026, 6, 20, 8, 0); // Mon 12:00 local

test("clampToWorkingHours: inside the window is returned unchanged", () => {
  expect(clampToWorkingHours(MON_NOON_GST, DUBAI)).toBe(MON_NOON_GST);
});

test("clampToWorkingHours: before opening rolls to the same day's start", () => {
  const monEarly = Date.UTC(2026, 6, 20, 3, 0); // Mon 07:00 local
  const clamped = clampToWorkingHours(monEarly, DUBAI);
  expect(clamped).toBe(Date.UTC(2026, 6, 20, 6, 0)); // Mon 10:00 local
});

test("clampToWorkingHours: after closing rolls to the next working day's start", () => {
  const monLate = Date.UTC(2026, 6, 20, 18, 30); // Mon 22:30 local
  const clamped = clampToWorkingHours(monLate, DUBAI);
  expect(clamped).toBe(Date.UTC(2026, 6, 21, 6, 0)); // Tue 10:00 local
});

test("clampToWorkingHours: Sunday (closed) rolls to Monday opening", () => {
  const sunNoon = Date.UTC(2026, 6, 19, 8, 0); // Sun 12:00 local
  const clamped = clampToWorkingHours(sunNoon, DUBAI);
  expect(clamped).toBe(Date.UTC(2026, 6, 20, 6, 0)); // Mon 10:00 local
});

test("clampToWorkingHours: Saturday after close skips Sunday to Monday", () => {
  const satLate = Date.UTC(2026, 6, 18, 18, 0); // Sat 22:00 local
  const clamped = clampToWorkingHours(satLate, DUBAI);
  expect(clamped).toBe(Date.UTC(2026, 6, 20, 6, 0)); // Mon 10:00 local
});

test("computeNextFollowUpAt walks the ladder, clamps, and returns null past the cap", () => {
  const config = { ...holidayysDefaultConfig(), ...DUBAI };
  // attempt 0 → +60min from Mon noon → still in window
  expect(computeNextFollowUpAt(config, 0, MON_NOON_GST)).toBe(MON_NOON_GST + 60 * 60_000);
  // ladder shorter than attempts → last delay reused (attempt 10 < maxFollowUps? no —)
  expect(computeNextFollowUpAt(config, config.maxFollowUps, MON_NOON_GST)).toBeNull();
  // +720min from Mon noon = Tue 00:00 local → clamped to Tue 10:00
  const third = computeNextFollowUpAt(config, 2, MON_NOON_GST);
  expect(third).toBe(Date.UTC(2026, 6, 21, 6, 0));
});

test("isSessionExpired honours the 72h window; withinServiceWindow the 24h one", () => {
  const base = MON_NOON_GST;
  expect(isSessionExpired(base, base + 71 * 3_600_000, 72)).toBe(false);
  expect(isSessionExpired(base, base + 72 * 3_600_000, 72)).toBe(true);
  expect(withinServiceWindow(base, base + 23 * 3_600_000)).toBe(true);
  expect(withinServiceWindow(base, base + 24 * 3_600_000)).toBe(false);
});

test("pickFollowUpText rotates pendingQuestion + alternates, falling back to basic-field phrasings", () => {
  const config = holidayysDefaultConfig();
  const session = {
    phrasingCursor: 0,
    pendingQuestion: {
      key: "travel_dates",
      text: "When are you planning to travel?",
      alternates: ["Rough month works too — when?"],
    },
    fields: [],
  };
  const first = pickFollowUpText(session, config);
  expect(first.text).toBe("When are you planning to travel?");
  const second = pickFollowUpText({ ...session, phrasingCursor: first.nextCursor }, config);
  expect(second.text).toBe("Rough month works too — when?");
  const third = pickFollowUpText({ ...session, phrasingCursor: second.nextCursor }, config);
  expect(third.text).toBe("When are you planning to travel?"); // wrapped

  // no pendingQuestion → first unanswered required basic field's phrasings rotate
  const fallback = pickFollowUpText(
    {
      phrasingCursor: 1,
      pendingQuestion: undefined,
      fields: [{ key: "looking_for", value: "Bali", confidence: "high" as const, updatedAt: 1 }],
    },
    config,
  );
  expect(config.basicFields[1].phrasings).toContain(fallback.text); // travel_dates variant
});
