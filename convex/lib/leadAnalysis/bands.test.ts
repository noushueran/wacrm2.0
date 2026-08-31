import { expect, test } from "vitest";
import { bandForScore, bandsMissingTemplate, clampScore, type BandRule } from "./bands";

const BANDS: BandRule[] = [
  { key: "hot", minScore: 8, maxScore: 10, autoArchive: false, steps: [] },
  { key: "warm", minScore: 4, maxScore: 7, autoArchive: true, steps: [] },
  { key: "cold", minScore: 1, maxScore: 3, autoArchive: true, steps: [] },
];

test("clampScore rounds to an integer", () => {
  expect(clampScore(7.4)).toBe(7);
  expect(clampScore(7.5)).toBe(8);
});

test("clampScore pins out-of-range values into 1..10", () => {
  expect(clampScore(0)).toBe(1);
  expect(clampScore(-3)).toBe(1);
  expect(clampScore(11)).toBe(10);
  expect(clampScore(99)).toBe(10);
});

test("clampScore rejects non-finite input by returning the floor", () => {
  expect(clampScore(Number.NaN)).toBe(1);
  expect(clampScore(Number.POSITIVE_INFINITY)).toBe(10);
});

test("bandForScore maps each band's interior", () => {
  expect(bandForScore(9, BANDS)).toBe("hot");
  expect(bandForScore(5, BANDS)).toBe("warm");
  expect(bandForScore(2, BANDS)).toBe("cold");
});

test("bandForScore is inclusive at both boundaries", () => {
  expect(bandForScore(8, BANDS)).toBe("hot");
  expect(bandForScore(10, BANDS)).toBe("hot");
  expect(bandForScore(7, BANDS)).toBe("warm");
  expect(bandForScore(4, BANDS)).toBe("warm");
  expect(bandForScore(3, BANDS)).toBe("cold");
  expect(bandForScore(1, BANDS)).toBe("cold");
});

test("bandForScore returns null when no rule covers the score", () => {
  expect(bandForScore(5, [BANDS[0]])).toBeNull();
});

test("bandsMissingTemplate is false when every step has a template", () => {
  const bands: BandRule[] = [
    { key: "hot", minScore: 8, maxScore: 10, autoArchive: false, steps: [
      { delayDays: 2, templateName: "welcome_back" },
    ] },
    { key: "warm", minScore: 4, maxScore: 7, autoArchive: true, steps: [
      { delayDays: 3, templateName: "check_in" },
    ] },
  ];
  expect(bandsMissingTemplate(bands)).toBe(false);
});

test("bandsMissingTemplate is true when a step's templateName is empty", () => {
  const bands: BandRule[] = [
    { key: "hot", minScore: 8, maxScore: 10, autoArchive: false, steps: [
      { delayDays: 2, templateName: "welcome_back" },
      { delayDays: 5, templateName: "" },
    ] },
  ];
  expect(bandsMissingTemplate(bands)).toBe(true);
});

test("bandsMissingTemplate is true when a step's templateName is only whitespace", () => {
  const bands: BandRule[] = [
    { key: "cold", minScore: 1, maxScore: 3, autoArchive: true, steps: [
      { delayDays: 5, templateName: "   " },
    ] },
  ];
  expect(bandsMissingTemplate(bands)).toBe(true);
});

test("bandsMissingTemplate is false for a band with no steps at all", () => {
  const bands: BandRule[] = [
    { key: "hot", minScore: 8, maxScore: 10, autoArchive: false, steps: [] },
  ];
  expect(bandsMissingTemplate(bands)).toBe(false);
});
