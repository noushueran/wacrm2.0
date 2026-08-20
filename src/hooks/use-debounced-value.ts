'use client';

import { useEffect, useState } from 'react';

/**
 * `value`, but only after it has stopped changing for `delayMs`.
 *
 * Exists because search moved server-side. A Convex `useQuery` keyed on
 * the raw input opens a NEW subscription per keystroke — "dubai" is six
 * queries, five of them already stale by the time they resolve. Feeding
 * the query the debounced value collapses that to one.
 *
 * The input itself stays undebounced and controlled by its own state, so
 * typing is never laggy; only the fetch waits.
 */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(id);
  }, [value, delayMs]);

  return debounced;
}
