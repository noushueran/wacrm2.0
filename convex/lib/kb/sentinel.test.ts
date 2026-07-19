import { describe, expect, test } from "vitest";
import {
  parseChecklistLines, parseLegacyDocument, parseReportValue,
  renderOpsSentinel, slugify,
} from "./sentinel";

test("slugify", () => {
  expect(slugify("UAE Visa Services")).toBe("uae-visa-services");
  expect(slugify("  Flights & Hotel Bookings ")).toBe("flights-hotel-bookings");
});

describe("renderOpsSentinel", () => {
  test("qualification heading + marks lines match the engine format", () => {
    const text = renderOpsSentinel("Dubai Holiday Packages", {
      kind: "qualification",
      criteria: [
        { key: "dates", label: "Travel dates", marks: 60 },
        { key: "email", label: "Email address", marks: 40, question: "Best email?" },
      ],
    });
    expect(text).toBe([
      "QUALIFICATION CHECKLIST — Dubai Holiday Packages",
      "- Travel dates (60 marks)",
      "- Email address (40 marks) — ask: Best email?",
    ].join("\n"));
  });
  test("sales + purchase headings", () => {
    expect(renderOpsSentinel("All Services", {
      kind: "sales",
      steps: [{ key: "call", label: "Call the lead", description: "within 15 minutes" }],
    })).toBe("SALES CHECKLIST — All Services\n- Call the lead: within 15 minutes");
    expect(renderOpsSentinel("Georgia Holiday Packages", {
      kind: "purchase",
      conditions: [{ key: "budget", label: "Budget at least AED 3000 per person" }],
      reportValue: 9000, currency: "AED",
    })).toBe([
      "PURCHASE CRITERIA — Georgia Holiday Packages",
      "- Budget at least AED 3000 per person",
      "Report value: 9000 AED",
    ].join("\n"));
  });
});

describe("parseLegacyDocument", () => {
  const doc = [
    "Dubai city breaks for families and couples.",
    "Best time: October to April.",
    "",
    "QUALIFICATION CHECKLIST — Dubai Holiday Packages",
    "- Travel dates (20 marks)",
    "- Party size (20 marks)",
    "- Budget band (30 marks)",
    "- Email address (30 marks)",
    "",
    "PURCHASE CRITERIA — Dubai Holiday Packages",
    "- Budget confirmed at AED 3000+ per person",
    "Report value: 6000 AED",
  ].join("\n");
  test("splits prose from sentinel sections", () => {
    const parsed = parseLegacyDocument("KB 2 — Dubai packages", doc);
    expect(parsed.prose).toContain("city breaks");
    expect(parsed.prose).not.toContain("QUALIFICATION CHECKLIST");
    expect(parsed.sections).toHaveLength(2);
    expect(parsed.sections[0]).toMatchObject({
      kind: "qualification", serviceName: "Dubai Holiday Packages",
    });
    expect(parsed.sections[1].kind).toBe("purchase");
    expect(parsed.sections[1].raw).toContain("Report value: 6000 AED");
  });
  test("document with no sections is all prose", () => {
    const parsed = parseLegacyDocument("KB 1", "About the company.\nHours daily.");
    expect(parsed.sections).toEqual([]);
    expect(parsed.prose).toBe("About the company.\nHours daily.");
  });
});

test("parseChecklistLines + parseReportValue", () => {
  expect(parseChecklistLines("- Travel dates (20 marks)\n- Nationality\nnoise")).toEqual([
    { label: "Travel dates", marks: 20 },
    { label: "Nationality" },
  ]);
  expect(parseReportValue("stuff\nReport value: 6000 AED")).toEqual({
    reportValue: 6000, currency: "AED",
  });
  expect(parseReportValue("no value here")).toEqual({});
});

describe("parseChecklistLines marks + ask-suffix recovery", () => {
  test("plain label, no marks", () => {
    expect(parseChecklistLines("- Travel dates")).toEqual([{ label: "Travel dates" }]);
  });
  test("label with marks", () => {
    expect(parseChecklistLines("- Travel dates (20 marks)")).toEqual([
      { label: "Travel dates", marks: 20 },
    ]);
  });
  test("label with marks and a trailing ask suffix", () => {
    expect(parseChecklistLines("- Email address (40 marks) — ask: Best email?")).toEqual([
      { label: "Email address", marks: 40 },
    ]);
  });
  test("label with a trailing ask suffix but no marks", () => {
    expect(parseChecklistLines("- Nationality — ask: Which passport?")).toEqual([
      { label: "Nationality" },
    ]);
  });
});

test("parseChecklistLines round-trips renderOpsSentinel qualification output", () => {
  const rendered = renderOpsSentinel("Dubai Holiday Packages", {
    kind: "qualification",
    criteria: [
      { key: "email", label: "Email address", marks: 40, question: "Best email?" },
      { key: "nationality", label: "Nationality" },
    ],
  });
  const body = rendered.split("\n").slice(1).join("\n");
  expect(parseChecklistLines(body)).toEqual([
    { label: "Email address", marks: 40 },
    { label: "Nationality" },
  ]);
});
