import { describe, expect, test } from "vitest";
import { lintServiceInput, lintEntryInput, lintOpsBlock, hasLintErrors } from "./lint";

describe("lintServiceInput", () => {
  test("accepts a clean slug + unique key", () => {
    expect(lintServiceInput({
      key: "uae-visas", name: "UAE Visa Services", aliases: ["visa"], existingKeys: [],
    })).toEqual([]);
  });
  test("rejects bad slug, duplicate key, blank name, duplicate alias", () => {
    const issues = lintServiceInput({
      key: "UAE Visas!", name: "", aliases: ["visa", "visa", ""],
      existingKeys: ["uae-visas"],
    });
    const codes = issues.map((i) => i.code).sort();
    expect(codes).toEqual(["alias_blank", "alias_duplicate", "key_slug", "name_required"]);
    expect(hasLintErrors(issues)).toBe(true);
  });
  test("flags key collision against existingKeys", () => {
    const issues = lintServiceInput({
      key: "uae-visas", name: "UAE Visa Services", aliases: [], existingKeys: ["uae-visas"],
    });
    expect(issues.map((i) => i.code)).toEqual(["key_taken"]);
  });
  test("repeated duplicate aliases report only one alias_duplicate issue", () => {
    const issues = lintServiceInput({
      key: "uae-visas", name: "UAE Visa Services",
      aliases: ["visa", "visa", "tour", "tour"], existingKeys: [],
    });
    expect(issues.map((i) => i.code)).toEqual(["alias_duplicate"]);
    expect(issues[0].message).toContain("visa");
  });
});

describe("lintEntryInput", () => {
  test("service scope requires serviceKey", () => {
    const issues = lintEntryInput({
      scope: "service", title: "t", body: "b", audience: "customer",
    });
    expect(issues.map((i) => i.code)).toEqual(["service_key_required"]);
  });
  test("customer-safe price mention is a warning, not an error", () => {
    const issues = lintEntryInput({
      scope: "company", title: "Rates", body: "Package price AED 3000 per person",
      audience: "customer",
    });
    expect(issues).toEqual([
      expect.objectContaining({ level: "warning", code: "price_mention" }),
    ]);
    expect(hasLintErrors(issues)).toBe(false);
  });
  test("internal entries may mention prices freely", () => {
    expect(lintEntryInput({
      scope: "company", title: "Thresholds", body: "budget >= AED 3000",
      audience: "internal",
    })).toEqual([]);
  });
  test("blank title triggers title_required", () => {
    const issues = lintEntryInput({
      scope: "company", title: "   ", body: "Valid body text", audience: "internal",
    });
    expect(issues.map((i) => i.code)).toEqual(["title_required"]);
  });
  test("blank body triggers body_required", () => {
    const issues = lintEntryInput({
      scope: "company", title: "Valid title", body: "   ", audience: "internal",
    });
    expect(issues.map((i) => i.code)).toEqual(["body_required"]);
  });
});

describe("lintOpsBlock", () => {
  test("qualification marks must sum to exactly 100", () => {
    const issues = lintOpsBlock({
      kind: "qualification",
      criteria: [
        { key: "dates", label: "Travel dates", marks: 50 },
        { key: "budget", label: "Budget", marks: 40 },
      ],
    });
    expect(issues.map((i) => i.code)).toEqual(["marks_sum"]);
  });
  test("clean qualification block passes", () => {
    expect(lintOpsBlock({
      kind: "qualification",
      criteria: [
        { key: "dates", label: "Travel dates", marks: 60 },
        { key: "email", label: "Email address", marks: 40 },
      ],
    })).toEqual([]);
  });
  test("duplicate criterion keys + empty list are errors", () => {
    expect(lintOpsBlock({ kind: "qualification", criteria: [] })
      .map((i) => i.code)).toEqual(["items_required"]);
    expect(lintOpsBlock({
      kind: "sales",
      steps: [{ key: "call", label: "Call" }, { key: "call", label: "Call again" }],
    }).map((i) => i.code)).toEqual(["key_duplicate"]);
  });
  test("purchase block validates reportValue and currency", () => {
    expect(lintOpsBlock({
      kind: "purchase",
      conditions: [{ key: "budget", label: "Budget >= AED 3000/person" }],
      reportValue: -5, currency: "dirham",
    }).map((i) => i.code).sort()).toEqual(["currency_format", "report_value_positive"]);
  });
  test("blank item label triggers label_required", () => {
    const issues = lintOpsBlock({
      kind: "sales",
      steps: [{ key: "call", label: "   " }],
    });
    expect(issues.map((i) => i.code)).toEqual(["label_required"]);
  });
  test("marks_sum is skipped when any criterion is missing marks, even if given marks don't total 100", () => {
    const issues = lintOpsBlock({
      kind: "qualification",
      criteria: [
        { key: "dates", label: "Travel dates", marks: 50 },
        { key: "budget", label: "Budget" },
      ],
    });
    expect(issues.map((i) => i.code)).toEqual([]);
  });
  test("item after a key_duplicate is not checked for label_required", () => {
    const issues = lintOpsBlock({
      kind: "sales",
      steps: [
        { key: "a", label: "X" },
        { key: "a", label: "Y" },
        { key: "b", label: "" },
      ],
    });
    expect(issues.map((i) => i.code)).toEqual(["key_duplicate"]);
  });
});
