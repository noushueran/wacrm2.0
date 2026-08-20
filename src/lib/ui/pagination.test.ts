import { describe, expect, it } from "vitest";

import { pageTokens, paginate } from "./pagination";

const items = (n: number): number[] => Array.from({ length: n }, (_, i) => i + 1);

describe("paginate", () => {
  it("returns everything when the list fits on one page", () => {
    const page = paginate(items(5), 0, 25);
    expect(page.items).toEqual([1, 2, 3, 4, 5]);
    expect(page.pageCount).toBe(1);
    expect(page.hasPrev).toBe(false);
    expect(page.hasNext).toBe(false);
  });

  it("slices the first page to the page size", () => {
    const page = paginate(items(60), 0, 25);
    expect(page.items).toHaveLength(25);
    expect(page.items[0]).toBe(1);
    expect(page.items.at(-1)).toBe(25);
    expect(page.pageCount).toBe(3);
    expect(page.hasPrev).toBe(false);
    expect(page.hasNext).toBe(true);
  });

  it("gives a middle page its own slice, with both arrows live", () => {
    const page = paginate(items(60), 1, 25);
    expect(page.items[0]).toBe(26);
    expect(page.items.at(-1)).toBe(50);
    expect(page.hasPrev).toBe(true);
    expect(page.hasNext).toBe(true);
  });

  it("leaves the last page short rather than padding it", () => {
    const page = paginate(items(60), 2, 25);
    expect(page.items).toEqual([51, 52, 53, 54, 55, 56, 57, 58, 59, 60]);
    expect(page.hasNext).toBe(false);
  });

  it("does not add a trailing empty page when the total is an exact multiple", () => {
    // 50/25 is 2 pages, not 3 — an off-by-one here shows up as a page the
    // Next arrow can reach that renders nothing at all.
    expect(paginate(items(50), 0, 25).pageCount).toBe(2);
    expect(paginate(items(50), 1, 25).hasNext).toBe(false);
  });

  // The board's list is a live Convex subscription AND is filtered
  // client-side, so the item count can shrink underneath a page the user
  // is already on — archive the last few rows, or type into the search
  // box, and page 5 of 10 becomes a page that no longer exists. Clamping
  // here is what keeps that from rendering as a blank list with a dead
  // Prev arrow; every caller gets the correction for free.
  it("clamps a page past the end back onto the last real page", () => {
    const page = paginate(items(30), 9, 25);
    expect(page.page).toBe(1);
    expect(page.items).toEqual([26, 27, 28, 29, 30]);
    expect(page.hasNext).toBe(false);
    expect(page.hasPrev).toBe(true);
  });

  it("clamps a negative page to the first page", () => {
    const page = paginate(items(30), -3, 25);
    expect(page.page).toBe(0);
    expect(page.items[0]).toBe(1);
    expect(page.hasPrev).toBe(false);
  });

  it("reports a 1-based inclusive range for the 'Showing x-y of z' label", () => {
    const first = paginate(items(60), 0, 25);
    expect([first.start, first.end, first.total]).toEqual([1, 25, 60]);
    const last = paginate(items(60), 2, 25);
    expect([last.start, last.end, last.total]).toEqual([51, 60, 60]);
  });

  it("survives an empty list without claiming a first item", () => {
    const page = paginate([], 0, 25);
    expect(page.items).toEqual([]);
    expect(page.total).toBe(0);
    // Not 1 — "Showing 1-0 of 0" is the classic empty-range bug.
    expect(page.start).toBe(0);
    expect(page.end).toBe(0);
    expect(page.pageCount).toBe(1);
    expect(page.hasPrev).toBe(false);
    expect(page.hasNext).toBe(false);
  });

  it("treats a non-positive page size as unpaginated rather than dividing by zero", () => {
    const page = paginate(items(4), 0, 0);
    expect(page.items).toEqual([1, 2, 3, 4]);
    expect(page.pageCount).toBe(1);
    expect(page.hasNext).toBe(false);
  });

  it("does not mutate or re-order the list it was handed", () => {
    const source = items(30);
    const copy = [...source];
    paginate(source, 1, 25);
    expect(source).toEqual(copy);
  });
});

describe("pageTokens", () => {
  const tokens = (page: number, pageCount: number, max = 7) =>
    pageTokens(page, pageCount, max).map((t) => (t === "ellipsis" ? "…" : t + 1));

  it("lists every page when they all fit", () => {
    expect(tokens(0, 5)).toEqual([1, 2, 3, 4, 5]);
  });

  it("never emits an ellipsis that hides a single page", () => {
    // The gap between 1 and 3 is just page 2 — an "…" standing in for one
    // page is strictly worse than the page button it replaces.
    const t = tokens(0, 7, 7);
    expect(t).not.toContain("…");
  });

  it("keeps the first and last page reachable from the middle", () => {
    const t = tokens(10, 20);
    expect(t[0]).toBe(1);
    expect(t.at(-1)).toBe(20);
    expect(t).toContain(11);
  });

  it("puts an ellipsis on both sides when the current page is central", () => {
    expect(tokens(10, 20)).toEqual([1, "…", 10, 11, 12, "…", 20]);
  });

  it("only needs a trailing ellipsis near the start", () => {
    expect(tokens(1, 20)).toEqual([1, 2, 3, 4, 5, "…", 20]);
  });

  it("only needs a leading ellipsis near the end", () => {
    expect(tokens(18, 20)).toEqual([1, "…", 16, 17, 18, 19, 20]);
  });

  it("always includes the current page, wherever it sits", () => {
    for (let p = 0; p < 20; p++) {
      expect(pageTokens(p, 20, 7)).toContain(p);
    }
  });

  it("never repeats a page", () => {
    for (let p = 0; p < 20; p++) {
      const nums = pageTokens(p, 20, 7).filter((t): t is number => t !== "ellipsis");
      expect(new Set(nums).size).toBe(nums.length);
    }
  });

  it("stays in ascending order", () => {
    for (let p = 0; p < 20; p++) {
      const nums = pageTokens(p, 20, 7).filter((t): t is number => t !== "ellipsis");
      expect([...nums].sort((a, b) => a - b)).toEqual(nums);
    }
  });

  it("degenerates safely for a single page", () => {
    expect(pageTokens(0, 1, 7)).toEqual([0]);
    expect(pageTokens(0, 0, 7)).toEqual([0]);
  });
});
