"use client";

import { useQuery, usePaginatedQuery } from "@/lib/convex/cached";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { INITIAL_MESSAGE_PAGE_SIZE } from "@/lib/inbox/view";

/**
 * Invisible cache-warmer for a single conversation. The conversation list
 * renders one of these for the row the pointer is resting on, so by the
 * time the user actually clicks, that conversation's first page of
 * messages + its reactions are already in the `ConvexQueryCache` — the
 * `MessageThread` then paints from cache instead of paying a fresh
 * round-trip to the self-hosted backend (which is the bulk of the
 * open-a-chat latency).
 *
 * It subscribes through the SAME cached hooks, queries, and args the real
 * thread uses (identical cache key — note the shared
 * `INITIAL_MESSAGE_PAGE_SIZE`), so the warmed subscription is exactly the
 * one the thread reads. Both are pure reads: hovering a row triggers no
 * writes and no `markRead`. Renders nothing.
 */
export function PrefetchThread({ conversationId }: { conversationId: string }) {
  const id = conversationId as Id<"conversations">;

  usePaginatedQuery(
    api.messages.listByConversation,
    { conversationId: id },
    { initialNumItems: INITIAL_MESSAGE_PAGE_SIZE },
  );
  useQuery(api.reactions.forConversation, { conversationId: id });

  return null;
}
