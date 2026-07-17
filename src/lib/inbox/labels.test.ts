import { describe, it, expect } from "vitest";
import { groupTags, isSelected, tagChipRow } from "./labels";
import type { Tag, TagGroup } from "@/types";

const g = (id: string, position: number, mode: "single" | "multi" = "multi"): TagGroup =>
  ({ id, name: id, selection_mode: mode, position });
const t = (id: string, group_id?: string): Tag =>
  ({ id, user_id: "", name: id, color: "#000", group_id, created_at: new Date().toISOString() });

describe("groupTags", () => {
  it("orders dimensions by group position and nests their tags", () => {
    const dims = groupTags(
      [g("dest", 1), g("prod", 0)],
      [t("uae", "prod"), t("thai", "dest"), t("pkg", "prod")],
    );
    expect(dims.map((d) => d.group?.id)).toEqual(["prod", "dest"]);
    expect(dims[0].tags.map((x) => x.id)).toEqual(["uae", "pkg"]);
  });

  it("collects ungrouped tags under a trailing null dimension", () => {
    const dims = groupTags([g("prod", 0)], [t("vip"), t("uae", "prod")]);
    expect(dims.at(-1)!.group).toBeNull();
    expect(dims.at(-1)!.tags.map((x) => x.id)).toEqual(["vip"]);
  });

  it("omits the null dimension when every tag is grouped", () => {
    const dims = groupTags([g("prod", 0)], [t("uae", "prod")]);
    expect(dims.every((d) => d.group !== null)).toBe(true);
  });

  it("routes tags with dangling group_id to ungrouped dimension", () => {
    const dims = groupTags([g("prod", 0)], [t("orphan", "missing"), t("uae", "prod")]);
    expect(dims.at(-1)!.group).toBeNull();
    expect(dims.at(-1)!.tags.map((x) => x.id)).toEqual(["orphan"]);
    expect(dims[0].tags.map((x) => x.id)).toEqual(["uae"]);
  });
});

describe("isSelected", () => {
  it("returns true when tag id is in the selected set", () => {
    const tag = t("uae", "prod");
    const selected = new Set(["uae", "vip"]);
    expect(isSelected(tag, selected)).toBe(true);
  });

  it("returns false when tag id is not in the selected set", () => {
    const tag = t("uae", "prod");
    const selected = new Set(["vip", "pkg"]);
    expect(isSelected(tag, selected)).toBe(false);
  });
});

describe("tagChipRow", () => {
  it("orders by group position, caps at limit, and counts overflow", () => {
    const row = tagChipRow(
      [g("dest", 1), g("prod", 0)],
      [t("uae", "prod"), t("thai", "dest"), t("pkg", "prod"), t("bali", "dest")],
      3,
    );
    // prod (pos 0): uae, pkg ; dest (pos 1): thai, bali → flat: uae, pkg, thai, bali
    expect(row.visible.map((x) => x.id)).toEqual(["uae", "pkg", "thai"]);
    expect(row.overflow).toBe(1);
  });

  it("puts ungrouped tags last and reports zero overflow within the limit", () => {
    const row = tagChipRow([g("prod", 0)], [t("vip"), t("uae", "prod")], 5);
    expect(row.visible.map((x) => x.id)).toEqual(["uae", "vip"]);
    expect(row.overflow).toBe(0);
  });

  it("treats a dangling group_id as ungrouped (via groupTags)", () => {
    const row = tagChipRow([g("prod", 0)], [t("orphan", "missing"), t("uae", "prod")], 5);
    expect(row.visible.map((x) => x.id)).toEqual(["uae", "orphan"]);
    expect(row.overflow).toBe(0);
  });
});
