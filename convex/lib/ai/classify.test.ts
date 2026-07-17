import { describe, it, expect } from "vitest";
import { parseClassification, buildClassifyPrompt, type Catalogue } from "./classify";

const CAT: Catalogue = {
  groups: [
    { id: "gP", name: "Product", selectionMode: "single", tags: [
      { id: "t_uae", name: "UAE Visa" }, { id: "t_pkg", name: "Packages" } ] },
    { id: "gD", name: "Destination", selectionMode: "multi", tags: [
      { id: "t_th", name: "Thailand" }, { id: "t_bali", name: "Bali" } ] },
  ],
};

describe("parseClassification", () => {
  it("maps valid tag names to ids and keeps a multi-group's multiple tags", () => {
    const r = parseClassification(
      '{"tags":["Packages","Thailand","Bali"],"note":"5-day Bali+Thailand for 2","confidence":"high"}', CAT);
    expect(r.tagIds.sort()).toEqual(["t_bali", "t_pkg", "t_th"].sort());
    expect(r.note).toBe("5-day Bali+Thailand for 2");
    expect(r.confidence).toBe("high");
  });

  it("drops names not in the catalogue", () => {
    const r = parseClassification('{"tags":["UAE Visa","Cruise"],"confidence":"medium"}', CAT);
    expect(r.tagIds).toEqual(["t_uae"]);
  });

  it("enforces at most one tag from a single-select group (first valid wins)", () => {
    const r = parseClassification('{"tags":["UAE Visa","Packages","Thailand"],"confidence":"high"}', CAT);
    expect(r.tagIds).toContain("t_uae");     // first product kept
    expect(r.tagIds).not.toContain("t_pkg"); // second product dropped
    expect(r.tagIds).toContain("t_th");      // multi-group unaffected
  });

  it("is case-insensitive on names", () => {
    const r = parseClassification('{"tags":["packages","BALI"],"confidence":"low"}', CAT);
    expect(r.tagIds.sort()).toEqual(["t_bali", "t_pkg"].sort());
  });

  it("tolerates prose around the JSON and a trailing note", () => {
    const r = parseClassification('Here you go:\n{"tags":["Thailand"],"note":" trip ","confidence":"high"}\nThanks', CAT);
    expect(r.tagIds).toEqual(["t_th"]);
    expect(r.note).toBe("trip");
  });

  it("falls back to low/empty on unparseable output and bad confidence", () => {
    expect(parseClassification("not json at all", CAT)).toEqual({ tagIds: [], confidence: "low" });
    const r = parseClassification('{"tags":[],"confidence":"banana"}', CAT);
    expect(r).toEqual({ tagIds: [], confidence: "low" });
  });
});

describe("buildClassifyPrompt", () => {
  it("lists every group with its options and selection mode, and asks for JSON", () => {
    const p = buildClassifyPrompt(CAT);
    expect(p).toContain("Product");
    expect(p).toContain("UAE Visa");
    expect(p).toContain("Packages");
    expect(p).toContain("Destination");
    expect(p).toContain("Thailand");
    expect(p.toLowerCase()).toContain("json");
    // single vs multi guidance is present in some form
    expect(p.toLowerCase()).toMatch(/one|single|exactly one/);
  });

  it("handles an empty catalogue without throwing", () => {
    expect(() => buildClassifyPrompt({ groups: [] })).not.toThrow();
  });
});
