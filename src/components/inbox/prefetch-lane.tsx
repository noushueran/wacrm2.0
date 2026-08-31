"use client";

import { usePaginatedQuery } from "@/lib/convex/cached";
import { api } from "../../../convex/_generated/api";
import {
  conversationListArgs,
  INITIAL_CONVERSATION_PAGE_SIZE,
  type AssignmentTab,
  type InboxLane,
} from "@/lib/inbox/view";

/**
 * Invisible cache-warmer for ONE (lane, assignment) tab combination —
 * the list-level twin of `PrefetchThread`, and for the same reason.
 *
 * Every tab is its own server-filtered paginated query, so clicking one
 * the session has not opened yet means a cold round-trip to the
 * self-hosted backend before a single row can paint. The list renders
 * one of these for the tab the pointer is resting on, so the query is
 * already in flight (usually already settled) by the time the click
 * lands, and `ConvexQueryCacheProvider` keeps it warm for minutes
 * afterwards — so the SECOND visit to a tab is instant regardless.
 *
 * It subscribes through the same cached hook, query, and args the real
 * list uses — `conversationListArgs` + `INITIAL_CONVERSATION_PAGE_SIZE`
 * are shared with the page precisely so the cache keys are identical by
 * construction. Build the args any other way and this warms a
 * subscription nobody reads. Pure read; renders nothing.
 */
export function PrefetchLane({
  lane,
  assignment,
}: {
  lane: InboxLane;
  assignment: AssignmentTab;
}) {
  usePaginatedQuery(
    api.conversations.list,
    conversationListArgs(lane, assignment),
    { initialNumItems: INITIAL_CONVERSATION_PAGE_SIZE },
  );

  return null;
}
