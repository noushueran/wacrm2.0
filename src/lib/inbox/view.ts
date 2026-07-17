// Pure helpers for the inbox view. Kept dependency-free (no React, no
// Convex) so they're unit-testable in the plain-node vitest project and
// shared by the page, the message thread, and the hover-prefetcher.

/**
 * First-page size for a conversation's messages. The thread
 * (`usePaginatedQuery`) and the hover-prefetcher MUST request the same
 * size, or their cache keys diverge and the prefetch is wasted.
 */
export const INITIAL_MESSAGE_PAGE_SIZE = 30;

/**
 * Deep-link URL for the inbox reflecting the active conversation. Fed to
 * `window.history.replaceState` on select (Next 16 syncs `useSearchParams`
 * with native history, so no server navigation / middleware runs) and to
 * the clear-selection path.
 */
export function inboxUrl(conversationId: string | null | undefined): string {
  return conversationId ? `/inbox?c=${conversationId}` : "/inbox";
}

/** Convex `usePaginatedQuery` status values (mirrored locally to keep this
 *  module free of a Convex import). */
type PaginatedStatus =
  | "LoadingFirstPage"
  | "CanLoadMore"
  | "LoadingMore"
  | "Exhausted";

export type MessageAreaState = "loading" | "empty" | "list";

/**
 * What the thread's message area should render:
 *  - "loading" — first page still in flight (show a skeleton). With the
 *    query cache, a re-visited conversation skips this entirely.
 *  - "empty"   — first page loaded, conversation has no messages.
 *  - "list"    — messages exist; keep showing them even while an OLDER
 *    page is loading, so "Load older" never blanks the thread.
 */
export function messageAreaState(
  status: PaginatedStatus,
  messageCount: number,
): MessageAreaState {
  if (status === "LoadingFirstPage") return "loading";
  if (messageCount === 0) return "empty";
  return "list";
}

/**
 * What a Convex-`useQuery`-backed list section (deals, notes, …) should
 * render. A reactive query is `undefined` while its first result is in
 * flight and an array once loaded. Callers that write `docs ?? []`
 * collapse those two states, so a still-loading section wrongly asserts
 * its empty message (e.g. "No deals yet") for the whole cold round-trip.
 * Feed the RAW query result here to keep "loading" distinct from "empty".
 */
export function listSectionState(
  docs: readonly unknown[] | undefined,
): MessageAreaState {
  if (docs === undefined) return "loading";
  if (docs.length === 0) return "empty";
  return "list";
}
