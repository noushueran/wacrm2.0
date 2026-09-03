import { describe, it, expect } from "vitest";
import {
  DISMISS_TTL_MS,
  MIN_VISITS_BEFORE_OFFER,
  parseDismissedAt,
  parseVisits,
  shouldOfferInstall,
} from "./install-offer";

const NOW = 1_700_000_000_000;

describe("shouldOfferInstall", () => {
  it("never asks an app that is already installed", () => {
    expect(
      shouldOfferInstall({
        installed: true,
        visits: 99,
        dismissedAt: null,
        now: NOW,
      }),
    ).toBe(false);
  });

  it("stays quiet on a first visit — nobody installs what they haven't used", () => {
    expect(
      shouldOfferInstall({ installed: false, visits: 1, dismissedAt: null, now: NOW }),
    ).toBe(false);
  });

  it("offers once the visitor has actually used the product", () => {
    expect(
      shouldOfferInstall({
        installed: false,
        visits: MIN_VISITS_BEFORE_OFFER,
        dismissedAt: null,
        now: NOW,
      }),
    ).toBe(true);
  });

  it("respects a recent dismissal", () => {
    expect(
      shouldOfferInstall({
        installed: false,
        visits: 10,
        dismissedAt: NOW - 1000,
        now: NOW,
      }),
    ).toBe(false);
  });

  it("asks again once the dismissal has expired — 'not now' is not 'never'", () => {
    expect(
      shouldOfferInstall({
        installed: false,
        visits: 10,
        dismissedAt: NOW - DISMISS_TTL_MS,
        now: NOW,
      }),
    ).toBe(true);
  });

  it("does not ask a second early", () => {
    expect(
      shouldOfferInstall({
        installed: false,
        visits: 10,
        dismissedAt: NOW - DISMISS_TTL_MS + 1,
        now: NOW,
      }),
    ).toBe(false);
  });
});

describe("parseVisits", () => {
  it("starts at zero for anything unusable", () => {
    for (const raw of [null, "", "abc", "-3", "NaN"]) {
      expect(parseVisits(raw)).toBe(0);
    }
  });

  it("reads a stored count", () => {
    expect(parseVisits("4")).toBe(4);
    expect(parseVisits("4.7")).toBe(4);
  });
});

describe("parseDismissedAt", () => {
  it("reads a stored timestamp", () => {
    expect(parseDismissedAt(String(NOW), null)).toBe(NOW);
  });

  it("treats a corrupt timestamp as no dismissal rather than a permanent one", () => {
    expect(parseDismissedAt("not-a-number", null)).toBe(null);
  });

  it("lets the legacy permanent flag expire, so old dismissals are asked once more", () => {
    // The old version wrote `"true"` with no timestamp, which meant
    // "never ask again on this device". There is no way to date it, and
    // the point of this change is that a dismissal stops being forever.
    expect(parseDismissedAt(null, "true")).toBe(null);
    expect(
      shouldOfferInstall({
        installed: false,
        visits: 10,
        dismissedAt: parseDismissedAt(null, "true"),
        now: NOW,
      }),
    ).toBe(true);
  });

  it("a fresh device with nothing stored is not treated as dismissed", () => {
    expect(parseDismissedAt(null, null)).toBe(null);
  });
});
