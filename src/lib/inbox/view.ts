// Pure helpers for the inbox view. Kept dependency-free (no React, no
// Convex) so they're unit-testable in the plain-node vitest project and
// shared by the page, the message thread, and the hover-prefetcher.

/**
 * First-page size for a conversation's messages. The thread
 * (`usePaginatedQuery`) and the hover-prefetcher MUST request the same
 * size, or their cache keys diverge and the prefetch is wasted.
 */
export const INITIAL_MESSAGE_PAGE_SIZE = 30;

/** Which assignment bucket the conversation list shows. A SEPARATE axis
 *  from `InboxLane` — the two compose (e.g. "Chasing" + "Mine"). */
export type AssignmentTab = "all" | "mine" | "unassigned";

/** Which lane tab is showing. Server-filtered via `conversations.list`'s
 *  `lane`/`archived` args, so each tab paginates its own complete set. */
export type InboxLane = "active" | "waiting" | "chasing" | "archived" | "snoozed";

/**
 * First-page size for the conversation list. Same contract as
 * `INITIAL_MESSAGE_PAGE_SIZE` above: the list and its tab-hover
 * prefetcher MUST request the same size or their cache keys diverge and
 * the prefetch warms a subscription nobody reads.
 */
export const INITIAL_CONVERSATION_PAGE_SIZE = 30;

/** `conversations.list` args, minus `paginationOpts`. `archived` and
 *  `lane` are mutually exclusive — the query rejects the combination. */
export type ConversationListArgs = {
  assignment?: "mine" | "unassigned";
  archived?: true;
  lane?: Exclude<InboxLane, "archived">;
};

/**
 * The `conversations.list` args for a (lane, assignment) pair.
 *
 * Exists so the list and the tab-hover prefetcher cannot drift: the
 * Convex query cache keys on the SERIALIZED args, so a prefetch that
 * builds its args even slightly differently opens a second subscription
 * and the click still pays a cold round-trip. One function, two callers,
 * no way to disagree.
 *
 * "All" is the ABSENCE of `assignment` rather than `assignment: "all"` —
 * the server has no such literal; an unfiltered list is what no argument
 * means. Same for the Archived lane, which is `archived: true` with no
 * `lane` at all (lanes bind `eq("archivedAt", undefined)`, so the two
 * cannot be combined — see `convex/conversations.ts`).
 */
export function conversationListArgs(
  lane: InboxLane,
  assignment: AssignmentTab,
): ConversationListArgs {
  return {
    ...(assignment === "all" ? {} : { assignment }),
    ...(lane === "archived" ? { archived: true as const } : { lane }),
  };
}

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

/** A tab's last known rows, tagged with the tab they came from. */
export type RememberedRows<T> = { key: string; rows: readonly T[] };

/**
 * Identity of a conversation-list tab, for `conversationRowsToRender`.
 * The (lane, assignment) pair is exactly what `conversationListArgs`
 * turns into query args, so two tabs share a key iff they share a query.
 */
export function conversationTabKey(
  lane: InboxLane,
  assignment: AssignmentTab,
): string {
  return `${lane}|${assignment}`;
}

/**
 * Which rows the conversation list should show right now.
 *
 * Normally just `rows`. The exception is a tab whose first page is
 * loading again having ALREADY shown rows — then it keeps showing the
 * last set instead of collapsing to a skeleton.
 *
 * That case is not hypothetical, and it is not the cold first load.
 * `usePaginatedQuery` absorbs a Convex `InvalidCursor` by discarding all
 * pagination state and restarting from page one, which drops `results`
 * to `[]` and puts `status` back to `LoadingFirstPage` mid-session. The
 * list then flashes its skeleton over a list the user was reading. Until
 * 2026-07-30 that fired on literally every "Load more" click and every
 * archive on the Waiting/Chasing lanes (see `convex/lib/inbox/lanes.ts`
 * — the boundaries those lanes range on moved every millisecond, so
 * every cursor was stale on arrival). Quantizing the boundaries fixed
 * the cause; this fixes the symptom, so the reset stays invisible for
 * the reasons `InvalidCursor` legitimately still happens — a bucket
 * rollover, or the underlying data genuinely shifting.
 *
 * Three guards, each load-bearing:
 *  - only while `LoadingFirstPage`, so a lane that genuinely emptied
 *    (every row archived) shows its empty state the moment the query
 *    settles, rather than stale rows forever;
 *  - only when `rows` is empty, so real data always wins;
 *  - only when the remembered rows came from THIS tab, so switching
 *    Waiting -> Chasing shows a skeleton rather than Waiting's rows
 *    under Chasing's heading.
 */
export function conversationRowsToRender<T>(
  status: PaginatedStatus,
  tabKey: string,
  rows: readonly T[],
  remembered: RememberedRows<T>,
): readonly T[] {
  if (status !== "LoadingFirstPage") return rows;
  if (rows.length > 0) return rows;
  return remembered.key === tabKey ? remembered.rows : rows;
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

/** The only fields of a conversation the override controls depend on.
 *  Structural, not the whole `Conversation` type, so this module keeps
 *  its no-React/no-Convex promise. */
export type OverrideControlState = {
  snoozed_until?: string;
  archived_at?: string;
  awaiting_reply?: boolean;
};

/** Which manual-override controls the thread header may show. */
export type OverrideControls = {
  chaseNow: boolean;
  snooze: boolean;
  wake: boolean;
};

/**
 * Which of the thread header's manual-override controls to render
 * (spec 2026-07-28-inbox-manual-overrides).
 *
 * Every "false" here mirrors a rejection in `convex/inboxOverrides.ts`,
 * so the header never offers a button whose only possible outcome is an
 * error. The server is the real gate; this is the display half, extracted
 * as a pure function because the rules are the load-bearing part and
 * `message-thread.tsx` itself is not statically renderable.
 *
 *  - `chaseNow` is withheld while the CUSTOMER is waiting on us. Forcing
 *    an Active thread drops it into Chasing, which sorts ascending by
 *    `lastMessageAt` — a customer who wrote two minutes ago would sort
 *    LAST in a cold tab nobody watches. No override may hide a customer
 *    waiting on us; that is the spec's first safety property.
 *  - Both SETTING controls are withheld on an archived thread: every lane
 *    and both extra tabs bind `eq("archivedAt", undefined)`, so an
 *    override written there is invisible and permanent.
 *  - `wake` is offered even on an archived thread, and is the one control
 *    with no server-side gate: clearing state is always safe, and it is
 *    the only way back for a row carrying a stale snooze.
 *  - Snooze and Chase now are mutually exclusive at the source, so a
 *    snoozed thread shows `wake`, never `snooze`.
 */
export function overrideControls(
  canOverride: boolean,
  conversation: OverrideControlState,
): OverrideControls {
  if (!canOverride) return { chaseNow: false, snooze: false, wake: false };
  const snoozed = !!conversation.snoozed_until;
  const archived = !!conversation.archived_at;
  return {
    chaseNow: !snoozed && !archived && !conversation.awaiting_reply,
    snooze: !snoozed && !archived,
    wake: snoozed,
  };
}
