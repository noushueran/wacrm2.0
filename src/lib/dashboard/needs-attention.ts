// Pure selection + formatting for the dashboard "Needs attention" queue.
//
// The queue is built on the already-deployed `conversations.list` query
// (role-scoped, `embedContact`-enriched). This module holds the client-side
// shaping so it can be unit-tested without Convex: keep only the rows that are
// actually waiting on us (`unreadCount > 0`), oldest first, and render how long
// each has waited.

/** The subset of a `conversations.list` row this queue reads. */
export interface WaitingConversation {
  _id: string;
  unreadCount: number;
  lastMessageAt?: number;
  lastMessageText?: string;
  assignedToUserId?: string;
  adReferral?: unknown;
  contact: { name?: string; phone?: string; avatarUrl?: string } | null;
}

/**
 * Keep conversations with unread (customer) messages — i.e. awaiting our
 * reply — sorted oldest-waiting first. A missing `lastMessageAt` sorts last
 * (it has no age to rank on).
 */
export function selectWaiting<T extends WaitingConversation>(rows: T[]): T[] {
  return rows
    .filter((r) => r.unreadCount > 0)
    .slice()
    .sort(
      (a, b) => (a.lastMessageAt ?? Infinity) - (b.lastMessageAt ?? Infinity),
    );
}

/**
 * Compact "waited for" label: `"48m"`, `"2h 14m"`, `"3h"`, `"3d"`. Empty
 * string when the anchor timestamp is unknown.
 */
export function formatWaiting(
  sinceMs: number | undefined,
  nowMs: number,
): string {
  if (sinceMs == null) return "";
  const mins = Math.max(0, Math.floor((nowMs - sinceMs) / 60_000));
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) {
    const rem = mins % 60;
    return rem ? `${hrs}h ${rem}m` : `${hrs}h`;
  }
  return `${Math.floor(hrs / 24)}d`;
}
