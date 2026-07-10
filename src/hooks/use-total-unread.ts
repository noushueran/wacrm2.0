"use client";

import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";

/**
 * Count of conversations with at least one unread inbound message for
 * the current user's account. Used by the sidebar to surface a green dot
 * on the Inbox nav entry when the user is elsewhere in the app.
 *
 * Backed by the reactive `api.conversations.unreadTotal` query (Convex
 * counterpart to the Supabase realtime-channel mirror this hook used to
 * maintain by hand) — any conversation's `unreadCount` changing anywhere
 * in the app updates this value automatically, with no
 * subscribe/mirror/recompute machinery to own here anymore.
 */
export function useTotalUnread(): number {
  const total = useQuery(api.conversations.unreadTotal);
  return total ?? 0;
}
