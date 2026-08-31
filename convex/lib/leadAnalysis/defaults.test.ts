import { expect, test } from "vitest";
import { defaultLeadAnalysisConfig } from "./defaults";
import { bandForScore } from "./bands";

test("ships dormant", () => {
  expect(defaultLeadAnalysisConfig().enabled).toBe(false);
});

test("carries the approved scoring defaults", () => {
  const c = defaultLeadAnalysisConfig();
  expect(c.rescoreDebounceMinutes).toBe(10);
  expect(c.scorePerRun).toBe(25);
  expect(c.backfillEnabled).toBe(true);
  expect(c.backfillPerRun).toBe(10);
});

test("carries the approved sequence defaults", () => {
  const c = defaultLeadAnalysisConfig();
  expect(c.idleDaysBeforeSequence).toBe(3);
  expect(c.humanQuietHours).toBe(24);
  expect(c.dailySendCap).toBe(100);
  expect(c.agedOutDays).toBe(120);
});

test("every score in 1..10 maps to exactly one default band", () => {
  const { bands } = defaultLeadAnalysisConfig();
  for (let s = 1; s <= 10; s++) {
    expect(bandForScore(s, bands)).not.toBeNull();
  }
});

test("default step counts match the approved cadence", () => {
  const { bands } = defaultLeadAnalysisConfig();
  const byKey = Object.fromEntries(bands.map((b) => [b.key, b]));
  expect(byKey.hot.steps.map((s) => s.delayDays)).toEqual([2, 5, 10]);
  expect(byKey.warm.steps.map((s) => s.delayDays)).toEqual([3, 7]);
  expect(byKey.cold.steps.map((s) => s.delayDays)).toEqual([5]);
});

test("hot leads are never auto-archived", () => {
  const { bands } = defaultLeadAnalysisConfig();
  const byKey = Object.fromEntries(bands.map((b) => [b.key, b]));
  expect(byKey.hot.autoArchive).toBe(false);
  expect(byKey.warm.autoArchive).toBe(true);
  expect(byKey.cold.autoArchive).toBe(true);
});
