// ============================================================
// Page arithmetic, as a pure function — the shared half of the
// pagination story. `src/components/ui/pagination.tsx` renders the
// control; this decides what the control is looking at, and the Convex
// queries use the same clamping rule to turn a page number into an
// offset.
//
// Extracted rather than inlined for the reason every other pure helper
// in this repo is (`lib/leads/pipeline.ts`, `components/lead-analysis/
// lead-analysis-filter.ts`): there is no jsdom and no Testing Library
// here, so logic is only testable when it lives outside the component.
// ============================================================

export interface PageSlice<T> {
  /** The rows for the current page. */
  items: T[];
  /** The page actually shown — CLAMPED, which may differ from the one asked for. */
  page: number;
  pageCount: number;
  /** Size of the full list being paged over, not of this page. */
  total: number;
  /** 1-based inclusive bounds for a "Showing 26-50 of 312" label; both 0 when empty. */
  start: number;
  end: number;
  hasPrev: boolean;
  hasNext: boolean;
}

/**
 * How many pages `total` rows fill. Never 0 — an empty list is still
 * "page 1 of 1", so the label and the disabled arrows have something
 * coherent to render.
 */
export function pageCountFor(total: number, pageSize: number): number {
  if (pageSize <= 0) return 1;
  return Math.max(1, Math.ceil(total / pageSize));
}

/**
 * Force a page number into the range that actually exists.
 *
 * Load-bearing rather than defensive. Both boards are live Convex
 * subscriptions AND are filtered, so the row count shrinks underneath a
 * page the user is already standing on — archive the last few leads, or
 * type into the search box, and "page 5 of 10" names a page that no
 * longer exists. Without this the list renders blank with a dead Prev
 * arrow and looks like a data-loading bug.
 */
export function clampPage(page: number, total: number, pageSize: number): number {
  const last = pageCountFor(total, pageSize) - 1;
  if (!Number.isFinite(page)) return 0;
  return Math.min(Math.max(Math.trunc(page), 0), last);
}

/**
 * The offset a server-side query should read from for `page`. Shares
 * `clampPage` with the client so a page number that the browser has
 * already corrected and one the server corrects independently can never
 * disagree about which rows they mean.
 */
export function offsetFor(page: number, total: number, pageSize: number): number {
  if (pageSize <= 0) return 0;
  return clampPage(page, total, pageSize) * pageSize;
}

/**
 * Slice `items` down to one page, plus everything a pagination control
 * needs to render itself.
 *
 * A `pageSize` of 0 or less means "don't paginate" and returns the list
 * whole — the shape callers want when pagination is opt-in and the
 * caller opted out, rather than a division by zero.
 */
export function paginate<T>(items: T[], page: number, pageSize: number): PageSlice<T> {
  const total = items.length;
  const pageCount = pageCountFor(total, pageSize);
  const safePage = clampPage(page, total, pageSize);

  const sliced = pageSize <= 0 ? items.slice() : items.slice(safePage * pageSize, safePage * pageSize + pageSize);

  return {
    items: sliced,
    page: safePage,
    pageCount,
    total,
    start: total === 0 ? 0 : safePage * (pageSize <= 0 ? 0 : pageSize) + 1,
    end: total === 0 ? 0 : Math.min(safePage * (pageSize <= 0 ? total : pageSize) + sliced.length, total),
    hasPrev: safePage > 0,
    hasNext: safePage < pageCount - 1,
  };
}

/** A slot in the pagination control: a 0-based page, or a gap standing in for several. */
export type PageToken = number | "ellipsis";

/**
 * The page buttons to render, condensed with ellipses once there are more
 * pages than `maxButtons` slots.
 *
 * The first and last page always keep a button — they are the two
 * destinations people actually aim for — and the current page always
 * keeps its neighbours, so Prev/Next have a visible target either side.
 *
 * A gap is only collapsed once it hides at least TWO pages. Collapsing a
 * single page trades a usable button for an "…" that does nothing, and
 * makes the control jitter as the window slides past it.
 */
export function pageTokens(page: number, pageCount: number, maxButtons = 7): PageToken[] {
  const pages = Math.max(1, Math.trunc(pageCount));
  // Below 5 slots there is no room for first + gap + current + gap + last,
  // which is the narrowest arrangement this shape can express.
  const slots = Math.max(5, Math.trunc(maxButtons));
  const current = clampPage(page, pages, 1);

  if (pages <= slots) {
    return Array.from({ length: pages }, (_, i) => i);
  }

  const first = 0;
  const last = pages - 1;
  const leftSibling = Math.max(current - 1, first);
  const rightSibling = Math.min(current + 1, last);
  // `> 2` / `< last - 2`, not `> 1` / `< last - 1`: at exactly one page of
  // gap the ellipsis would replace the very page it is hiding.
  const gapLeft = leftSibling > first + 2;
  const gapRight = rightSibling < last - 2;

  // An edge block absorbs the slots the missing ellipsis frees up.
  const edgeBlock = slots - 2;

  if (!gapLeft && gapRight) {
    return [...Array.from({ length: edgeBlock }, (_, i) => i), "ellipsis", last];
  }
  if (gapLeft && !gapRight) {
    return [first, "ellipsis", ...Array.from({ length: edgeBlock }, (_, i) => pages - edgeBlock + i)];
  }
  return [first, "ellipsis", leftSibling, current, rightSibling, "ellipsis", last];
}
