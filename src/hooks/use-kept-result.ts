'use client';

import { useState } from 'react';

/**
 * Hold the last resolved value of a Convex query while the next one is
 * in flight.
 *
 * Without this, server-side pagination is a visible downgrade: every
 * page turn changes the query args, `useQuery` goes back to `undefined`,
 * and the page swaps the whole board for "Loading leads…" — so paging
 * flashes the layout away and back on every click, which reads as
 * slower than the un-paginated list it replaced even though it moves a
 * twentieth of the data.
 *
 * Keeping the previous page on screen and marking the controls busy is
 * what makes a page turn feel immediate. `loading` is still reported
 * honestly, so a FIRST load (nothing kept yet) can show a real skeleton.
 *
 * The update is done during render rather than in an effect, guarded by
 * the previous result's identity — React's documented way to adjust
 * state from a prop/derived change, and the same shape `/contacts`
 * already uses to prune deleted tag filters.
 */
export function useKeptResult<T>(result: T | undefined): {
  /** The freshest value available: the new one, else the last one seen. */
  data: T | undefined;
  /** True while `result` itself is unresolved, even if `data` is populated. */
  loading: boolean;
} {
  const [kept, setKept] = useState<T | undefined>(result);

  if (result !== undefined && result !== kept) {
    setKept(result);
  }

  return { data: result ?? kept, loading: result === undefined };
}
