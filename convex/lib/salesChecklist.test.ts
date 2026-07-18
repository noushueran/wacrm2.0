import { describe, expect, test } from "vitest";
import {
  DEFAULT_SALES_CHECKLIST,
  LOSS_CATEGORIES,
  allItemsDone,
  isLossCategory,
  parseChecklistGeneration,
} from "./salesChecklist";

describe("DEFAULT_SALES_CHECKLIST", () => {
  test("has the 6 owner-mandated steps in working order", () => {
    expect(DEFAULT_SALES_CHECKLIST.map((i) => i.key)).toEqual([
      "call",
      "pitch",
      "price",
      "negotiate",
      "follow_up",
      "objection",
    ]);
    for (const item of DEFAULT_SALES_CHECKLIST) {
      expect(item.title.length).toBeGreaterThan(0);
      expect((item.description ?? "").length).toBeGreaterThan(0);
    }
  });
});

describe("LOSS_CATEGORIES", () => {
  test("fixed vocabulary + guard", () => {
    expect(LOSS_CATEGORIES).toContain("price");
    expect(LOSS_CATEGORIES).toContain("other");
    expect(isLossCategory("price")).toBe(true);
    expect(isLossCategory("vibes")).toBe(false);
  });
});

describe("parseChecklistGeneration", () => {
  test("parses a plain JSON array of tasks", () => {
    const raw = JSON.stringify([
      { title: "Call the lead", description: "Real call, not chat" },
      { title: "Send the pitch deck" },
    ]);
    const items = parseChecklistGeneration(raw);
    expect(items).not.toBeNull();
    expect(items!).toHaveLength(2);
    expect(items![0]).toEqual({
      key: "call-the-lead",
      title: "Call the lead",
      description: "Real call, not chat",
    });
    expect(items![1].key).toBe("send-the-pitch-deck");
    expect(items![1].description).toBeUndefined();
  });

  test("extracts from a ```json fence and tolerates surrounding prose", () => {
    const raw =
      'Here is the checklist:\n```json\n[{"title":"Call"},{"title":"Quote price"}]\n```\nDone.';
    const items = parseChecklistGeneration(raw);
    expect(items!.map((i) => i.title)).toEqual(["Call", "Quote price"]);
  });

  test("dedupes slug collisions and clamps to 12 items / 120-char titles", () => {
    const raw = JSON.stringify(
      Array.from({ length: 20 }, (_, i) => ({
        title: i < 2 ? "Same Title!" : `Task ${i} ${"x".repeat(200)}`,
      })),
    );
    const items = parseChecklistGeneration(raw);
    expect(items!).toHaveLength(12);
    expect(items![0].key).toBe("same-title");
    expect(items![1].key).toBe("same-title-2");
    expect(items![2].title.length).toBeLessThanOrEqual(120);
  });

  test("rejects garbage, non-arrays, and fewer than 2 usable items", () => {
    expect(parseChecklistGeneration("not json at all")).toBeNull();
    expect(parseChecklistGeneration('{"title":"one object"}')).toBeNull();
    expect(parseChecklistGeneration('[{"title":"only one"}]')).toBeNull();
    expect(parseChecklistGeneration('[{"nope":1},{"nah":2}]')).toBeNull();
    expect(parseChecklistGeneration("[]")).toBeNull();
  });
});

describe("allItemsDone", () => {
  test("true only for a non-empty fully-done list", () => {
    expect(allItemsDone([])).toBe(false);
    expect(allItemsDone([{ done: true }, { done: false }])).toBe(false);
    expect(allItemsDone([{ done: true }, { done: true }])).toBe(true);
  });
});
