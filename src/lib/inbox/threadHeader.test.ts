import { describe, it, expect } from "vitest";
import { windowPill, leadButtonLabel, initials } from "./threadHeader";

describe("windowPill", () => {
  it("renders the service segment alone when the free window is shut", () => {
    expect(
      windowPill({ sessionRemaining: "23h", sessionExpired: false, freeText: null }),
    ).toEqual([{ key: "service", text: "23h", tone: "primary" }]);
  });

  it("renders both segments when the free window is open", () => {
    expect(
      windowPill({ sessionRemaining: "23h", sessionExpired: false, freeText: "free 65h" }),
    ).toEqual([
      { key: "service", text: "23h", tone: "primary" },
      { key: "free", text: "free 65h", tone: "free" },
    ]);
  });

  it("marks an expired service window without hiding it", () => {
    expect(
      windowPill({ sessionRemaining: "Expired", sessionExpired: true, freeText: null }),
    ).toEqual([{ key: "service", text: "Expired", tone: "expired" }]);
  });

  it("keeps the free segment green while the service window is expired", () => {
    // Legitimate: the two windows are independent. The 24h window can shut
    // while the 72h free-entry window is still open.
    expect(
      windowPill({ sessionRemaining: "Expired", sessionExpired: true, freeText: "free 12h" }),
    ).toEqual([
      { key: "service", text: "Expired", tone: "expired" },
      { key: "free", text: "free 12h", tone: "free" },
    ]);
  });

  it("returns no segments when there is nothing to say", () => {
    // `sessionInfo.remaining` is "" on a conversation with no messages.
    expect(
      windowPill({ sessionRemaining: "", sessionExpired: false, freeText: null }),
    ).toEqual([]);
  });

  it("still renders the free segment when the session string is empty", () => {
    expect(
      windowPill({ sessionRemaining: "", sessionExpired: false, freeText: "free 65h" }),
    ).toEqual([{ key: "free", text: "free 65h", tone: "free" }]);
  });
});

describe("initials", () => {
  it("takes the first letter of the first two words", () => {
    expect(initials("khadeeja banu")).toBe("KB");
  });

  it("takes one letter from a single-word name", () => {
    expect(initials("Noushad")).toBe("N");
  });

  it("ignores a third word", () => {
    expect(initials("maria del carmen")).toBe("MD");
  });

  it("collapses extra whitespace", () => {
    expect(initials("  ada   lovelace  ")).toBe("AL");
  });

  it("returns an empty string for an empty name", () => {
    expect(initials("   ")).toBe("");
  });
});

describe("leadButtonLabel", () => {
  it("joins stage and assignee initials", () => {
    expect(
      leadButtonLabel({
        stageLabel: "New lead",
        assigneeName: "khadeeja banu",
        fallbackLabel: "Lead",
      }),
    ).toBe("New lead · KB");
  });

  it("shows the stage alone when unassigned", () => {
    expect(
      leadButtonLabel({ stageLabel: "Qualified", assigneeName: null, fallbackLabel: "Lead" }),
    ).toBe("Qualified");
  });

  it("falls back to the generic label when no stage is set", () => {
    expect(
      leadButtonLabel({ stageLabel: null, assigneeName: "khadeeja banu", fallbackLabel: "Lead" }),
    ).toBe("Lead · KB");
  });

  it("shows the fallback alone when neither is set", () => {
    expect(
      leadButtonLabel({ stageLabel: null, assigneeName: null, fallbackLabel: "Lead" }),
    ).toBe("Lead");
  });

  it("does not append a separator for a whitespace-only assignee name", () => {
    expect(
      leadButtonLabel({ stageLabel: "New lead", assigneeName: "  ", fallbackLabel: "Lead" }),
    ).toBe("New lead");
  });
});
