import { describe, expect, test } from "vitest";
import {
  PANEL_SECTION_KEYS,
  PANEL_SECTION_STORAGE_KEY,
  parseSectionState,
  resolveSectionOpen,
  serializeSectionState,
  shouldShowMarker,
} from "./panelSections";

describe("PANEL_SECTION_KEYS", () => {
  test("covers exactly the seven collapsible sections, no duplicates", () => {
    expect([...PANEL_SECTION_KEYS].sort()).toEqual(
      ["about", "acquisition", "activity", "deals", "keyFacts", "location", "travel"].sort(),
    );
    expect(new Set(PANEL_SECTION_KEYS).size).toBe(PANEL_SECTION_KEYS.length);
  });
});

describe("resolveSectionOpen", () => {
  test("uses the default when nothing is persisted", () => {
    expect(
      resolveSectionOpen({ editing: false, editable: true, persisted: undefined, defaultOpen: false }),
    ).toBe(false);
    expect(
      resolveSectionOpen({ editing: false, editable: true, persisted: undefined, defaultOpen: true }),
    ).toBe(true);
  });

  test("a persisted choice wins over the default, in both directions", () => {
    expect(
      resolveSectionOpen({ editing: false, editable: true, persisted: true, defaultOpen: false }),
    ).toBe(true);
    expect(
      resolveSectionOpen({ editing: false, editable: true, persisted: false, defaultOpen: true }),
    ).toBe(false);
  });

  test("edit mode forces an editable section open, overriding a persisted close", () => {
    expect(
      resolveSectionOpen({ editing: true, editable: true, persisted: false, defaultOpen: false }),
    ).toBe(true);
  });

  test("edit mode does NOT force open a section with no editable fields", () => {
    // Activity and Deals are read-only; forcing them open on Edit would
    // just re-crowd the panel at the moment the user needs to focus.
    expect(
      resolveSectionOpen({ editing: true, editable: false, persisted: false, defaultOpen: false }),
    ).toBe(false);
  });
});

describe("parseSectionState", () => {
  test("returns an empty state for null, invalid JSON, or a non-object", () => {
    expect(parseSectionState(null)).toEqual({});
    expect(parseSectionState("{oops")).toEqual({});
    expect(parseSectionState('"a string"')).toEqual({});
    expect(parseSectionState("[1,2]")).toEqual({});
  });

  test("keeps only known keys with boolean values", () => {
    const parsed = parseSectionState(
      JSON.stringify({ travel: true, deals: false, bogus: true, location: "yes" }),
    );
    expect(parsed).toEqual({ travel: true, deals: false });
  });

  test("round-trips through serialize", () => {
    const state = { travel: true, activity: false } as const;
    expect(parseSectionState(serializeSectionState(state))).toEqual(state);
  });
});

describe("shouldShowMarker", () => {
  test("never shows while the section is open — the content speaks for itself", () => {
    expect(shouldShowMarker({ open: true, marker: 3 })).toBe(false);
    expect(shouldShowMarker({ open: true, marker: true })).toBe(false);
  });

  test("shows a positive count, hides a zero count", () => {
    expect(shouldShowMarker({ open: false, marker: 3 })).toBe(true);
    expect(shouldShowMarker({ open: false, marker: 0 })).toBe(false);
  });

  test("shows on true, hides on false and null", () => {
    expect(shouldShowMarker({ open: false, marker: true })).toBe(true);
    expect(shouldShowMarker({ open: false, marker: false })).toBe(false);
    expect(shouldShowMarker({ open: false, marker: null })).toBe(false);
  });
});

describe("PANEL_SECTION_STORAGE_KEY", () => {
  test("is namespaced so it cannot collide with other app storage", () => {
    expect(PANEL_SECTION_STORAGE_KEY).toContain("inbox");
  });
});
