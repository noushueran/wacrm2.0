"use client";

// A fork of `usePaginatedQuery` from `convex-helpers/react/cache/hooks`
// (v0.1.120), which is itself a fork of the one in `convex/react`. Kept
// byte-close to its upstream so a dependency bump can be re-synced by
// diffing; everything this file changes is described below and marked
// `AMANI:` at the call sites.
//
// ── What's wrong upstream ───────────────────────────────────────────
// `convex/react` mints a fresh pagination `id` per reset:
//
//     function nextPaginationId() { paginationId++; return paginationId; }
//
// The `convex-helpers` cached fork replaces that with a constant:
//
//     // NOTE!: We use the same ID so it's always cached, but it can mean
//     // a split is required off the bat if it's an old stale query result.
//     function nextPaginationId(): number { return 0; }
//
// That constant is load-bearing for the cache — `id` is part of
// `paginationOpts`, so it is part of the query args, so it is part of
// the cache key. Pinning it to 0 is what lets a remount re-attach to a
// warm subscription instead of re-fetching. That's the whole reason
// `@/lib/convex/cached` exists.
//
// But it also breaks recovery. When a page comes back `InvalidCursor`,
// the hook calls `setState(createInitialState)` — during render, from
// inside the results `useMemo`. With a constant id, the state it resets
// TO is byte-identical to the state that just failed, so the very next
// render reads the same cache entry, which still holds the same Error,
// and resets again. Nothing in the loop changes, so it never settles;
// React aborts the render at 25 attempts with "Minified React error
// #301" (too many re-renders) and the route white-screens. Upstream
// `convex/react` escapes only because its incrementing id makes the
// regenerated args miss the poisoned entry.
//
// Observed on /inbox as exactly that pair, in that order:
//   usePaginatedQuery hit error, resetting pagination state:
//     [CONVEX Q(conversations:list)] Server Error
//     Uncaught ConvexError: InvalidCursor: Tried to run a query starting
//     from a cursor, but it looks like this cursor is from a different query.
//   Uncaught Error: Minified React error #301
//
// ── What this file changes ──────────────────────────────────────────
// The id becomes a per-query GENERATION rather than either a constant or
// a global counter: stable across mounts (so the cache still warms), and
// bumped only when that query actually hits an `InvalidCursor` (so the
// retry is a genuinely different query and cannot re-read the failure).
// Ordinary navigation never bumps it and so is unaffected.
//
// Note this is a client-side robustness fix. `InvalidCursor` is a normal,
// expected condition — Convex documents it as "the paginated database
// query was data-dependent and changed underneath us" — and the hook is
// supposed to absorb it silently. What was broken is the absorbing, not
// the cursor. See `convex/conversations.ts`'s `list` for why this
// particular query invalidates cursors more readily than most: it
// dispatches across two different indexes plus a filtered/unfiltered
// split, so its shape is a function of the caller's role and tab.

import type {
  PaginatedQueryArgs,
  PaginatedQueryReference,
  UsePaginatedQueryReturnType,
} from "convex/react";
import { useConvex } from "convex/react";
import type {
  FunctionReference,
  paginationOptsValidator,
  PaginationResult,
} from "convex/server";
import { getFunctionName } from "convex/server";
import { useMemo, useState } from "react";
import { useQueries } from "convex-helpers/react/cache/hooks";
import { ConvexError, convexToJson, type Infer, type Value } from "convex/values";

// ── AMANI: generation-keyed pagination ids ──────────────────────────
// Replaces upstream's `nextPaginationId()`. Module-level, matching the
// module-level `paginationId` counter it stands in for; the map is
// bounded by the number of DISTINCT (query, args) pairs the tab has
// paginated, which is the same set the query cache already holds.

const paginationGenerations = new Map<string, number>();

/**
 * Identity of a paginated query for generation purposes: the function
 * name plus its args, excluding `paginationOpts`. Mirrors the cache key
 * `convex-helpers` builds, so a generation tracks exactly one cache
 * entry family — the inbox's Mine/Unassigned/all tabs pass different
 * `assignment` args, read different indexes server-side, and so must not
 * share a generation.
 */
export function paginationCacheKey(
  queryName: string,
  // `Value | undefined`, not `Value`: an optional Convex arg is normally
  // passed as an explicit `undefined` rather than omitted — the Inbox
  // sends `{ assignment: undefined }` for its "all" tab. `convexToJson`
  // drops those keys, so the two spellings agree on one key.
  args: Record<string, Value | undefined>,
): string {
  return JSON.stringify([queryName, convexToJson(args as Value)]);
}

/**
 * The id this query should use right now. Constant unless a failure has
 * bumped it, which is what preserves the warm-subscription behaviour
 * this whole module exists for.
 */
export function currentPaginationId(key: string): number {
  return paginationGenerations.get(key) ?? 0;
}

/**
 * Advance past an id that just returned `InvalidCursor`, and return the
 * id to retry with.
 *
 * Idempotent in `failedId`: the bump happens during render, so React
 * calls it twice per failure under StrictMode, and a blind `++` would
 * hand the two renders different ids and never converge. Guarding on
 * "is the current generation still the one that failed" makes the second
 * call a no-op that agrees with the first. It also means a stale retry
 * for an old generation can't drag a recovered query backwards.
 */
export function retryPaginationId(key: string, failedId: number): number {
  const current = currentPaginationId(key);
  if (current !== failedId) return current;
  const next = current + 1;
  paginationGenerations.set(key, next);
  return next;
}

/** Test seam — module state would otherwise leak between test cases. */
export function __resetPaginationIds(): void {
  paginationGenerations.clear();
}

// ── Below: upstream, unmodified except where marked `AMANI:` ────────

// Incrementing integer for each page queried in the usePaginatedQuery hook.
type QueryPageKey = number;

type UsePaginatedQueryState = {
  query: FunctionReference<"query">;
  args: Record<string, Value>;
  id: number;
  nextPageKey: QueryPageKey;
  pageKeys: QueryPageKey[];
  queries: Record<
    QueryPageKey,
    {
      query: FunctionReference<"query">;
      // Use the validator type as a test that it matches the args
      // we generate.
      args: { paginationOpts: Infer<typeof paginationOptsValidator> };
    }
  >;
  ongoingSplits: Record<QueryPageKey, [QueryPageKey, QueryPageKey]>;
  skip: boolean;
};

const splitQuery =
  (key: QueryPageKey, splitCursor: string, continueCursor: string) =>
  (prevState: UsePaginatedQueryState) => {
    const queries = { ...prevState.queries };
    const splitKey1 = prevState.nextPageKey;
    const splitKey2 = prevState.nextPageKey + 1;
    const nextPageKey = prevState.nextPageKey + 2;
    queries[splitKey1] = {
      query: prevState.query,
      args: {
        ...prevState.args,
        paginationOpts: {
          ...prevState.queries[key]!.args.paginationOpts,
          endCursor: splitCursor,
        },
      },
    };
    queries[splitKey2] = {
      query: prevState.query,
      args: {
        ...prevState.args,
        paginationOpts: {
          ...prevState.queries[key]!.args.paginationOpts,
          cursor: splitCursor,
          endCursor: continueCursor,
        },
      },
    };
    const ongoingSplits = { ...prevState.ongoingSplits };
    ongoingSplits[key] = [splitKey1, splitKey2];
    return {
      ...prevState,
      nextPageKey,
      queries,
      ongoingSplits,
    };
  };

const completeSplitQuery =
  (key: QueryPageKey) => (prevState: UsePaginatedQueryState) => {
    const completedSplit = prevState.ongoingSplits[key];
    if (completedSplit === undefined) {
      return prevState;
    }
    const queries = { ...prevState.queries };
    delete queries[key];
    const ongoingSplits = { ...prevState.ongoingSplits };
    delete ongoingSplits[key];
    let pageKeys = prevState.pageKeys.slice();
    const pageIndex = prevState.pageKeys.findIndex((v) => v === key);
    if (pageIndex >= 0) {
      pageKeys = [
        ...prevState.pageKeys.slice(0, pageIndex),
        ...completedSplit,
        ...prevState.pageKeys.slice(pageIndex + 1),
      ];
    }
    return {
      ...prevState,
      queries,
      pageKeys,
      ongoingSplits,
    };
  };

/**
 * Load data reactively from a paginated query into a growing list.
 *
 * Drop-in for `usePaginatedQuery` from `convex/react`, backed by the
 * `<ConvexQueryCacheProvider>` so subscriptions survive unmount — see
 * the header comment for the one behavioural difference from the
 * `convex-helpers` version this forks.
 *
 * @param query - A FunctionReference to the public query function to run.
 * @param args - The arguments object for the query function, excluding
 * the `paginationOpts` property. That property is injected by this hook.
 * @param options - An object specifying the `initialNumItems` to be loaded in
 * the first page, and the `customPagination` to use.
 * @param options.customPagination - Set this to true when you are using
 * `stream` or `paginator` helpers on the server. This enables gapless
 * pagination by connecting the pages explicitly when calling `loadMore`.
 */
export function usePaginatedQuery<Query extends PaginatedQueryReference>(
  query: Query,
  args: PaginatedQueryArgs<Query> | "skip",
  options: {
    initialNumItems: number;
    /**
     * Set this to true if you are using the `stream` or `paginator` helpers.
     */
    customPagination?: boolean;
  },
): UsePaginatedQueryReturnType<Query> {
  if (
    typeof options?.initialNumItems !== "number" ||
    options.initialNumItems <= 0
  ) {
    throw new Error(
      `\`options.initialNumItems\` must be a positive number. Received \`${options?.initialNumItems}\`.`,
    );
  }
  const skip = args === "skip";
  const argsObject = skip ? {} : args;
  const queryName = getFunctionName(query);
  // Upstream inlines this `JSON.stringify` into both dependency arrays
  // below; hoisting it just lets eslint check them statically.
  const serializedArgs = JSON.stringify(convexToJson(argsObject as Value));

  // AMANI: identity the generation is tracked under. Same inputs as
  // `createInitialState`'s memo below, so it's stable alongside it.
  const generationKey = useMemo(
    () =>
      paginationCacheKey(
        queryName,
        argsObject as Record<string, Value | undefined>,
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the serialized args, not their identity
    [queryName, serializedArgs],
  );

  const createInitialState = useMemo(() => {
    return () => {
      // AMANI: was `nextPaginationId()` — a constant `0` upstream, which
      // made the InvalidCursor reset below regenerate the args that just
      // failed. Reads the generation at CALL time, so the reset picks up
      // a bump made moments earlier in the same render.
      const id = currentPaginationId(generationKey);
      return {
        query,
        args: argsObject as Record<string, Value>,
        id,
        nextPageKey: 1,
        pageKeys: skip ? [] : [0],
        queries: skip
          ? ({} as UsePaginatedQueryState["queries"])
          : {
              0: {
                query,
                args: {
                  ...argsObject,
                  paginationOpts: {
                    numItems: options.initialNumItems,
                    cursor: null,
                    id,
                  },
                },
              },
            },
        ongoingSplits: {},
        skip,
      };
    };
    // ESLint doesn't like that we're stringifying the args. We do this because
    // we want to avoid rerendering if the args are a different
    // object that serializes to the same result.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the serialized args, not their identity
  }, [serializedArgs, queryName, options.initialNumItems, skip, generationKey]);

  const [state, setState] =
    useState<UsePaginatedQueryState>(createInitialState);

  // `currState` is the state that we'll render based on.
  let currState = state;
  if (
    skip !== state.skip ||
    getFunctionName(query) !== getFunctionName(state.query) ||
    JSON.stringify(convexToJson(argsObject as Value)) !==
      JSON.stringify(convexToJson(state.args))
  ) {
    currState = createInitialState();
    setState(currState);
  }
  const convexClient = useConvex();
  const logger = convexClient.logger;

  const resultsObject = useQueries(currState.queries);

  const [results, maybeLastResult]: [
    Value[],
    undefined | PaginationResult<Value>,
  ] = useMemo(() => {
    let currResult: PaginationResult<Value> | undefined = undefined;

    const allItems: Value[] = [];
    for (const pageKey of currState.pageKeys) {
      currResult = resultsObject[pageKey];
      if (currResult === undefined) {
        break;
      }

      if (currResult instanceof Error) {
        if (
          currResult.message.includes("InvalidCursor") ||
          (currResult instanceof ConvexError &&
            typeof currResult.data === "object" &&
            currResult.data?.isConvexSystemError === true &&
            currResult.data?.paginationError === "InvalidCursor")
        ) {
          // - InvalidCursor: If the cursor is invalid, probably the paginated
          // database query was data-dependent and changed underneath us. The
          // cursor in the params or journal no longer matches the current
          // database query.

          // In all cases, we want to restart pagination to throw away all our
          // existing cursors.
          logger.warn(
            "usePaginatedQuery hit error, resetting pagination state: " +
              currResult.message,
          );
          // AMANI: retire the id that failed BEFORE resetting. Without
          // this the reset re-issues identical args, re-reads this same
          // cached Error, and resets again until React bails out at 25
          // re-renders (#301). Idempotent, which matters because this
          // runs during render and StrictMode double-invokes it.
          retryPaginationId(generationKey, currState.id);
          setState(createInitialState);
          return [[], undefined];
        } else {
          throw currResult;
        }
      }
      const ongoingSplit = currState.ongoingSplits[pageKey];
      if (ongoingSplit !== undefined) {
        if (
          resultsObject[ongoingSplit[0]] !== undefined &&
          resultsObject[ongoingSplit[1]] !== undefined
        ) {
          // Both pages of the split have results now. Swap them in.
          setState(completeSplitQuery(pageKey));
        }
      } else if (
        currResult.splitCursor &&
        (currResult.pageStatus === "SplitRecommended" ||
          currResult.pageStatus === "SplitRequired" ||
          (options.customPagination
            ? // For custom pagination, we eagerly split the page when it grows.
              currResult.page.length > options.initialNumItems
            : currResult.page.length > options.initialNumItems * 2))
      ) {
        // If a single page has more than 1.5x the expected number of items,
        // or if the server requests a split, split the page into two.
        setState(
          splitQuery(pageKey, currResult.splitCursor, currResult.continueCursor),
        );
      }
      if (currResult.pageStatus === "SplitRequired") {
        // If pageStatus is 'SplitRequired', it means the server was not able to
        // fetch the full page. So we stop results before the incomplete
        // page and return 'LoadingMore' while the page is splitting.
        return [allItems, undefined];
      }
      allItems.push(...currResult.page);
    }
    return [allItems, currResult];
    // The rule wants `options.customPagination` added. Deliberately not
    // added: this list is upstream's, and this file's whole maintenance
    // story (see the header) is staying byte-close to
    // `convex-helpers` so a version bump can be re-synced by diffing.
    // Every intentional divergence here is marked `AMANI:`; silently
    // widening a dependency array would be an unmarked one, and would
    // show up as a conflict on the next re-sync rather than as a
    // decision anyone made.
    //
    // It is also inert. `customPagination` is read only to choose a
    // branch that is constant for the lifetime of the hook — it comes
    // from the options object a call site passes literally — so adding
    // it changes no recomputation in practice while making the fork
    // harder to maintain.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    resultsObject,
    currState.pageKeys,
    currState.ongoingSplits,
    currState.id,
    options.initialNumItems,
    createInitialState,
    generationKey,
    logger,
  ]);

  const statusObject = useMemo(() => {
    if (maybeLastResult === undefined && currState.pageKeys.length <= 1) {
      return {
        status: "LoadingFirstPage",
        isLoading: true,
        loadMore: (_numItems: number) => {
          // Intentional noop.
        },
      } as const;
    } else if (
      maybeLastResult === undefined ||
      // The last page (which isn't the first page) is splitting, which is how
      // we model loading more with custom pagination.
      (options.customPagination &&
        currState.ongoingSplits[currState.pageKeys.at(-1)!] !== undefined)
    ) {
      return {
        status: "LoadingMore",
        isLoading: true,
        loadMore: (_numItems: number) => {
          // Intentional noop.
        },
      } as const;
    }
    if (maybeLastResult.isDone) {
      return {
        status: "Exhausted",
        isLoading: false,
        loadMore: (_numItems: number) => {
          // Intentional noop.
        },
      } as const;
    }
    const continueCursor = maybeLastResult.continueCursor;
    let alreadyLoadingMore = false;
    return {
      status: "CanLoadMore",
      isLoading: false,
      loadMore: (numItems: number) => {
        if (!alreadyLoadingMore) {
          alreadyLoadingMore = true;
          setState((prevState) => {
            let nextPageKey = prevState.nextPageKey;
            const queries = { ...prevState.queries };
            let ongoingSplits = prevState.ongoingSplits;
            let pageKeys = prevState.pageKeys;
            if (options.customPagination) {
              // Connect the current last page to the next page
              // by setting the endCursor of the last page to the continueCursor
              // of the next page.
              const lastPageKey = prevState.pageKeys.at(-1)!;
              const boundLastPageKey = nextPageKey;
              queries[boundLastPageKey] = {
                query: prevState.query,
                args: {
                  ...prevState.args,
                  paginationOpts: {
                    ...queries[lastPageKey]!.args.paginationOpts,
                    endCursor: continueCursor,
                  },
                },
              };
              nextPageKey++;
              ongoingSplits = {
                ...ongoingSplits,
                [lastPageKey]: [boundLastPageKey, nextPageKey],
              };
            } else {
              pageKeys = [...prevState.pageKeys, nextPageKey];
            }
            queries[nextPageKey] = {
              query: prevState.query,
              args: {
                ...prevState.args,
                paginationOpts: {
                  numItems,
                  cursor: continueCursor,
                  id: prevState.id,
                },
              },
            };
            nextPageKey++;
            return {
              ...prevState,
              pageKeys,
              nextPageKey,
              queries,
              ongoingSplits,
            };
          });
        }
      },
    } as const;
    // `alreadyLoadingMore` is captured per memo instance and is what
    // makes `loadMore` fire once per page, so this list stays exactly as
    // upstream has it — widening it would recompute the memo mid-load
    // and let a second `loadMore` through.
    //
    // That is precisely what the rule asks for here: it wants
    // `currState.ongoingSplits` and `currState.pageKeys`, both of which
    // change DURING a load. Suppressed rather than obeyed, because
    // obeying it reintroduces the double-fetch this narrow list exists to
    // prevent. Kept as a suppression with this reasoning attached, so the
    // next person sees a decision instead of a warning they might
    // "fix".
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [maybeLastResult, currState.nextPageKey, options.customPagination]);

  return {
    results,
    ...statusObject,
  };
}
