import { describe, it, expect } from "vitest";
import { groupTags } from "./labels";
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
});
