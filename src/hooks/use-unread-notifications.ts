"use client";

import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";

/**
 * Count of unread notifications for the current user. Used by the
 * sidebar to surface a badge on the Notifications nav entry.
 *
 * Reactive — `api.notifications.list` is a live Convex subscription
 * already scoped to the caller (`ctx.userId`/`ctx.accountId` inside the
 * query), so this recomputes on its own whenever a notification is
 * created or marked read. No realtime channel wiring needed (that was
 * the Supabase-era `postgres_changes` subscription this hook used to
 * hold open by hand).
 *
 * Returns 0 while the query is still loading, same as the old hook's
 * `useState(0)` default before its first fetch resolved.
 */
export function useUnreadNotifications(): number {
  const notifications = useQuery(api.notifications.list);
  return (notifications ?? []).filter((n) => n.readAt === undefined).length;
}
