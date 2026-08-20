import { describe, it, expect, beforeEach } from "vitest";

import {
  paginationCacheKey,
  currentPaginationId,
  retryPaginationId,
  __resetPaginationIds,
} from "./paginated";

/**
 * These cover the one property that separates our `usePaginatedQuery`
 * from the `convex-helpers` cached one it forks: that recovering from an
 * `InvalidCursor` produces query args which DIFFER from the args that
 * just failed.
 *
 * Why that property is load-bearing: the cached hook's recovery path is
 * `setState(createInitialState)` called *during render*, and the query
 * cache is keyed on `[queryName, args]` — with the failed result, error
 * included, still sitting in it. Upstream `convex/react` escapes because
 * its `nextPaginationId()` increments, so the regenerated page-0 args
 * carry a new `id` and miss the poisoned cache entry. The cached fork
 * hardcodes `nextPaginationId()` to `0` (deliberately — a constant id is
 * what lets a remount reuse a warm subscription), which makes the
 * regenerated args byte-identical, so the reset re-reads the same cached
 * Error and resets again, forever. React gives up at 25 re-renders:
 * "Minified React error #301", and the whole /inbox route white-screens.
 *
 * So we need both behaviours at once — a stable id for the ordinary
 * mount/unmount/remount path (cache warmth), and a moving one for the
 * recovery path (convergence). That is exactly the split these tests pin
 * down. There is no jsdom or Testing Library in this repo (`src` tests
 * run in the plain "node" env against `renderToStaticMarkup`), so the
 * re-render loop itself isn't reproducible here; the id logic it hinges
 * on is pure, and is.
 */

const KEY = paginationCacheKey("conversations:list", { assignment: undefined });

beforeEach(() => {
  __resetPaginationIds();
});

describe("paginationCacheKey", () => {
  it("ignores arg identity, so a remount with equal args reuses the entry", () => {
    expect(paginationCacheKey("conversations:list", { assignment: "mine" })).toBe(
      paginationCacheKey("conversations:list", { assignment: "mine" }),
    );
  });

  it("separates the inbox's tabs, which are genuinely different queries", () => {
    // `assignment` picks the index `conversations.list` reads — the
    // Mine/Unassigned tabs range `by_account_assigned_last_message`,
    // "all" scans `by_account_last_message`. A cursor from one is not
    // valid for another, so their generations must not be shared.
    expect(
      paginationCacheKey("conversations:list", { assignment: "mine" }),
    ).not.toBe(paginationCacheKey("conversations:list", { assignment: undefined }));
  });
});

describe("currentPaginationId", () => {
  it("starts at 0 and stays there, so remounts hit the warm subscription", () => {
    expect(currentPaginationId(KEY)).toBe(0);
    expect(currentPaginationId(KEY)).toBe(0);
  });
});

describe("retryPaginationId", () => {
  it("returns an id different from the one that failed", () => {
    // The whole fix: the retry must not re-issue the args that just
    // errored, or it re-reads the cached Error and loops.
    const failed = currentPaginationId(KEY);
    expect(retryPaginationId(KEY, failed)).not.toBe(failed);
  });

  it("is idempotent for a given failed id", () => {
    // The bump happens during render (inside the results `useMemo`), so
    // StrictMode's double-render calls it twice for the same failure.
    // Two calls must agree, or the second render would already be
    // querying a third id and never settle.
    const failed = currentPaginationId(KEY);
    expect(retryPaginationId(KEY, failed)).toBe(retryPaginationId(KEY, failed));
  });

  it("advances the id a later remount will use", () => {
    // Not just a one-shot: the recovered generation has to stick, or the
    // next mount would go straight back to the poisoned entry.
    const recovered = retryPaginationId(KEY, currentPaginationId(KEY));
    expect(currentPaginationId(KEY)).toBe(recovered);
  });

  it("keeps advancing when the retry itself fails", () => {
    const first = retryPaginationId(KEY, currentPaginationId(KEY));
    const second = retryPaginationId(KEY, first);
    expect(second).not.toBe(first);
  });

  it("scopes a failure to its own query, leaving other tabs warm", () => {
    const other = paginationCacheKey("conversations:list", {
      assignment: "mine",
    });
    retryPaginationId(KEY, currentPaginationId(KEY));
    expect(currentPaginationId(other)).toBe(0);
  });
});

/**
 * The property the two id strategies actually differ on: whether the
 * reset cycle TERMINATES.
 *
 * This models the one external fact that makes the difference matter —
 * a failed query result is sticky. It stays in the query cache under its
 * own `[queryName, args]` key, error and all, so re-issuing identical
 * args re-reads the same Error rather than retrying against the server.
 * The hook's recovery is "reset to page 0 and re-render", so recovery
 * only escapes if the reset changes the key it lands on.
 *
 * Running the same loop under both strategies is what shows the fix is
 * the id and not something incidental.
 */
describe("reset convergence", () => {
  const MAX_RENDERS = 25; // React's own ceiling before it throws #301.

  /** Cache keys holding a sticky InvalidCursor, keyed by pagination id. */
  function runResetCycle(
    poisoned: Set<number>,
    nextId: (failedId: number) => number,
  ): number | "never settled" {
    let id = currentPaginationId(KEY);
    for (let render = 0; render < MAX_RENDERS; render++) {
      if (!poisoned.has(id)) return render;
      id = nextId(id);
    }
    return "never settled";
  }

  it("settles on the first render whose id is not poisoned", () => {
    // Only the id that failed is poisoned; one bump is enough.
    expect(
      runResetCycle(new Set([0]), (failed) => retryPaginationId(KEY, failed)),
    ).toBe(1);
  });

  it("still settles when several ids in a row are poisoned", () => {
    expect(
      runResetCycle(new Set([0, 1, 2]), (failed) =>
        retryPaginationId(KEY, failed),
      ),
    ).toBe(3);
  });

  it("never settles with a constant id — the upstream bug", () => {
    // `convex-helpers`' `nextPaginationId()` is `() => 0`. The reset
    // regenerates the args that just failed, re-reads the same cached
    // Error, and resets again; React aborts at 25 renders with #301.
    expect(runResetCycle(new Set([0]), () => 0)).toBe("never settled");
  });
});
