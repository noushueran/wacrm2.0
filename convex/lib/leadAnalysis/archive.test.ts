import { expect, test } from "vitest";
import {
  ARCHIVE_REASONS,
  isArchiveReason,
  normalizeArchiveNote,
  ARCHIVE_REASON_MAX_NOTE,
} from "./archive";

test("the vocabulary is exactly the four supported reasons", () => {
  expect([...ARCHIVE_REASONS]).toEqual([
    "manual",
    "no_response",
    "aged_out",
    "not_a_lead",
  ]);
});

test("isArchiveReason accepts every member of the vocabulary", () => {
  for (const r of ARCHIVE_REASONS) expect(isArchiveReason(r)).toBe(true);
});

test("isArchiveReason rejects anything outside it", () => {
  expect(isArchiveReason("spam")).toBe(false);
  expect(isArchiveReason("")).toBe(false);
  expect(isArchiveReason(null)).toBe(false);
  expect(isArchiveReason(undefined)).toBe(false);
  expect(isArchiveReason(7)).toBe(false);
  expect(isArchiveReason({ reason: "manual" })).toBe(false);
});

test("normalizeArchiveNote trims and keeps real text", () => {
  expect(normalizeArchiveNote("  went quiet  ")).toBe("went quiet");
});

test("normalizeArchiveNote returns undefined for empty or non-string input", () => {
  expect(normalizeArchiveNote("")).toBeUndefined();
  expect(normalizeArchiveNote("   ")).toBeUndefined();
  expect(normalizeArchiveNote(undefined)).toBeUndefined();
  expect(normalizeArchiveNote(null)).toBeUndefined();
  expect(normalizeArchiveNote(42)).toBeUndefined();
});

test("normalizeArchiveNote truncates an overlong note", () => {
  const note = normalizeArchiveNote("x".repeat(500));
  expect(note!.length).toBe(ARCHIVE_REASON_MAX_NOTE);
});
