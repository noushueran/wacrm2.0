import {
  AlarmClock,
  ArchiveRestore,
  BadgeCheck,
  BadgeDollarSign,
  UserPlus,
  UserX,
} from "lucide-react";

import type { Notification, NotificationType } from "@/types";

/**
 * Icon per notification type. Shared by the full notifications page and
 * the header notification bell so the two can never drift on iconography.
 *
 * This `Record<NotificationType, ...>` is exhaustive: it is the hand-
 * maintained counterpart of the `notifications.type` union in
 * `convex/schema.ts`. Widening that schema union without adding an entry
 * here fails to compile — that's the intended guardrail, so the next
 * person widening the schema union knows to come here too.
 */
export const TYPE_ICON: Record<NotificationType, typeof UserPlus> = {
  conversation_assigned: UserPlus,
  lead_qualified: BadgeCheck,
  sla_alert: AlarmClock,
  purchase_signal: BadgeDollarSign,
  // An archived conversation came back — the customer replied
  // (spec 2026-07-26 §"Stopping and returning").
  lead_returned: ArchiveRestore,
  // The auto-assign sweep reached an unowned Chasing thread with no
  // eligible agent to give it to (spec 2026-07-27-inbox-lanes).
  chase_unassigned: UserX,
};

/**
 * Where clicking a notification should take the user, or `null` when the
 * notification has no linked conversation (nothing to open). Shared by the
 * page and the bell so click-through targets the same place from both.
 */
export function notificationHref(n: Notification): string | null {
  return n.conversation_id ? `/inbox?c=${n.conversation_id}` : null;
}

/**
 * The text to show on the bell's unread badge, or `null` when the badge
 * should be hidden (no unread). Counts above nine collapse to "9+" so the
 * badge stays a single, compact glyph.
 */
export function formatUnreadBadge(count: number): string | null {
  if (count <= 0) return null;
  return count > 9 ? "9+" : String(count);
}
