import type { Conversation, Contact, Tag } from "@/types";

/**
 * Conversation select that embeds the contact plus its tags, so the Inbox
 * can filter conversations by contact tag without a second round-trip.
 * `contact_tags(tags(*))` returns the join rows; {@link normalizeConversation}
 * flattens them onto `contact.tags`.
 */
export const CONVERSATION_SELECT =
  "*, contact:contacts(*, contact_tags(tags(*)))";

/** Raw shape returned by {@link CONVERSATION_SELECT} before flattening. */
type RawContact = Contact & { contact_tags?: { tags: Tag | null }[] };
type RawConversation = Omit<Conversation, "contact"> & {
  contact?: RawContact | null;
};

/**
 * Flatten the embedded `contact_tags(tags(*))` join into `contact.tags`.
 * Safe to call on rows fetched with {@link CONVERSATION_SELECT}; a row with
 * no contact (e.g. a freshly-inserted conversation) passes through untouched.
 */
export function normalizeConversation(raw: RawConversation): Conversation {
  const rawContact = raw.contact;
  if (!rawContact) return raw as Conversation;

  const { contact_tags, ...contact } = rawContact;
  return {
    ...raw,
    contact: {
      ...contact,
      tags: (contact_tags ?? [])
        .map((ct) => ct.tags)
        .filter((t): t is Tag => t != null),
    },
  };
}

export function normalizeConversations(
  rows: RawConversation[],
): Conversation[] {
  return rows.map(normalizeConversation);
}

export interface ContactFilters {
  /** Tag ids; a conversation matches if its contact has ANY of them (OR). */
  tagIds: string[];
  /** Exact company match, or null for no company filter. */
  company: string | null;
}

/**
 * Whether a conversation passes the contact-based Inbox filters (issue #272).
 * Empty `tagIds` and null `company` are no-ops, so the default (no filters)
 * always matches. Tags use OR logic, consistent with Broadcast audiences.
 */
export function matchesContactFilters(
  conversation: Conversation,
  { tagIds, company }: ContactFilters,
): boolean {
  if (tagIds.length > 0) {
    const contactTagIds = conversation.contact?.tags ?? [];
    if (!contactTagIds.some((t) => tagIds.includes(t.id))) return false;
  }

  if (company !== null && conversation.contact?.company?.trim() !== company) {
    return false;
  }

  return true;
}

/** How a conversation's assignee should render as a row chip in the Inbox. */
export type AssigneeDisplay =
  | { kind: "unassigned" }
  | { kind: "you" }
  | { kind: "other"; name: string; avatarUrl?: string };

/**
 * Resolves how a conversation's assignee should appear in the list row.
 * `profilesById` is keyed by `user_id` (from `api.members.list` mapped
 * through `toUiMemberProfile`). Returns `you` when the chat is assigned to
 * the current user, `unassigned` when it sits in the pool, and otherwise the
 * teammate's name/avatar — falling back to the label "Assigned" when that
 * teammate has no name or is not in the roster.
 */
export function resolveAssignee(
  conversation: Pick<Conversation, "assigned_agent_id">,
  currentUserId: string | null | undefined,
  profilesById: Map<
    string,
    { full_name: string | null; avatar_url?: string | null }
  >,
): AssigneeDisplay {
  const id = conversation.assigned_agent_id;
  if (!id) return { kind: "unassigned" };
  if (currentUserId && id === currentUserId) return { kind: "you" };
  const p = profilesById.get(id);
  return {
    kind: "other",
    name: p?.full_name ?? "Assigned",
    avatarUrl: p?.avatar_url ?? undefined,
  };
}
