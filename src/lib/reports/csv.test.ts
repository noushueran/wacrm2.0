import { describe, expect, it } from "vitest";
import { toCsv } from "./csv";

describe("toCsv", () => {
  it("prefixes the output with a UTF-8 BOM", () => {
    const csv = toCsv(["a"], [["1"]]);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv.startsWith("\uFEFF")).toBe(true);
  });

  it("joins the header and each row with commas, and rows with CRLF", () => {
    const csv = toCsv(
      ["period", "count"],
      [
        ["2026-01-01", 3],
        ["2026-01-02", 5],
      ],
    );
    expect(csv).toBe("\uFEFFperiod,count\r\n2026-01-01,3\r\n2026-01-02,5");
  });

  it("passes plain numbers and strings through unquoted", () => {
    const csv = toCsv(["a", "b"], [[42, "plain"]]);
    expect(csv).toBe("\uFEFFa,b\r\n42,plain");
  });

  it("renders null as an empty, unquoted field", () => {
    const csv = toCsv(["name", "note"], [["Bob", null]]);
    expect(csv).toBe("\uFEFFname,note\r\nBob,");
  });

  it("renders a header-only table (no rows) with no trailing separator", () => {
    const csv = toCsv(["a", "b"], []);
    expect(csv).toBe("\uFEFFa,b");
  });

  it("quotes a value containing the delimiter", () => {
    const csv = toCsv(["ad"], [["Buy One, Get One"]]);
    expect(csv).toBe('\uFEFFad\r\n"Buy One, Get One"');
  });

  it("quotes a value containing a double quote and doubles the embedded quote", () => {
    const csv = toCsv(["ad"], [['Say "Hi"']]);
    expect(csv).toBe('\uFEFFad\r\n"Say ""Hi"""');
  });

  it("quotes a value containing an embedded newline", () => {
    const csv = toCsv(["note"], [["line one\nline two"]]);
    expect(csv).toBe('\uFEFFnote\r\n"line one\nline two"');
  });

  it("quotes a value containing an embedded CRLF", () => {
    const csv = toCsv(["note"], [["line one\r\nline two"]]);
    expect(csv).toBe('\uFEFFnote\r\n"line one\r\nline two"');
  });

  it("quotes a value that has both a comma and embedded quotes, doubling only the quotes", () => {
    const csv = toCsv(["ad"], [['Bob, "The Builder"']]);
    expect(csv).toBe('\uFEFFad\r\n"Bob, ""The Builder"""');
  });

  it("does not quote a value that merely LOOKS quoted-worthy but has no special characters", () => {
    const csv = toCsv(["ad"], [["Plain ad name - no punctuation"]]);
    expect(csv).toBe("\uFEFFad\r\nPlain ad name - no punctuation");
  });

  it("passes non-ASCII text through unchanged, after the BOM", () => {
    // Regression guard for the exact defect the BOM exists to prevent:
    // Excel mangling non-ASCII ad names into mojibake without it. This
    // only proves the BOM is present and the text itself round-trips
    // unmodified — actual Excel rendering is outside what a unit test
    // can observe.
    const csv = toCsv(["name"], [["دبي مول"]]);
    expect(csv).toBe("\uFEFFname\r\nدبي مول");
  });

  it("carries an UNKNOWN Meta count out as an empty cell, never 0 and never \"null\"", () => {
    // The Events tab's one rule — a null `recorded` is unknown and must
    // not become a zero — has exactly one unguarded hop left, and it is
    // this one: the moment the table leaves the screen for a spreadsheet.
    // A row shaped like the Events export (`events-panel.tsx`), with both
    // Meta-side cells unknown.
    const csv = toCsv(
      ["milestone", "event", "reached", "delivered", "recorded", "delta"],
      [["Qualified lead", "QualifiedLead", 9, 8, null, null]],
    );
    expect(csv).toBe(
      "\uFEFFmilestone,event,reached,delivered,recorded,delta\r\n" +
        "Qualified lead,QualifiedLead,9,8,,",
    );
    // Spelled out, because both wrong answers are silently plausible in a
    // spreadsheet: "8,0," would allege Meta recorded none, and "null"
    // would be read as text.
    expect(csv).not.toContain("8,0");
    expect(csv).not.toContain("null");
  });

  it("quotes independently per cell — one dirty cell does not affect its row-mates", () => {
    const csv = toCsv(
      ["a", "b", "c"],
      [["clean", "has,comma", "clean-again"]],
    );
    expect(csv).toBe('\uFEFFa,b,c\r\nclean,"has,comma",clean-again');
  });
});
