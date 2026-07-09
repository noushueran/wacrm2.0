import { ConvexError } from "convex/values";
import type { Doc } from "../../../convex/_generated/dataModel";
import type {
  Contact,
  ContactCustomValue,
  ContactNote,
  Conversation,
  CustomField,
  Deal,
  InteractiveMessagePayload,
  Message,
  MessageReaction,
  PipelineStage,
  Profile,
  Tag,
} from "@/types";

// ============================================================
// Shape-mapping adapters — Convex docs (camelCase, `_id`/`_creationTime`)
// -> the app's existing snake_case UI types (`src/types/index.ts`,
// `id`/`created_at`). Applied at the `useQuery`/`useMutation` boundary so
// component internals + `src/types` stay unchanged. Mirrors the
// convention `src/hooks/use-auth.tsx` established for Task 1
// (ternary-on-doc-presence, field-by-field rename) — see that file's
// `profile`/`account` construction for the original pattern.
//
// Every function here is a plain rename + `_creationTime` -> ISO string
// conversion; none of them fetch or mutate anything themselves.
//
// Legacy single-owner-era columns (`user_id` on Contact/Tag/CustomField/
// ContactNote) predate the accounts model and have no Convex equivalent
// (the Convex tables only carry an optional `createdByUserId`, and
// `tags` has no creator field at all). Mapped to `createdByUserId ?? ""`
// (or `""` for tags) rather than leaving the UI type's required `string`
// field unsatisfied — nothing in the contacts UI currently reads
// `Contact.user_id`/`Tag.user_id`/etc. for anything but display, and none
// of it displays these legacy fields.
// ============================================================

/** Convex has no `updatedAt` field on `contacts` yet — `Contact.updated_at`
 *  is required on the UI type, so it's backfilled from `_creationTime`
 *  until a real column exists. Every write path in this vertical updates
 *  reactively anyway, so no UI currently depends on this value changing
 *  independently of `created_at`. */
export function toUiTag(doc: Doc<"tags">): Tag {
  return {
    id: doc._id,
    user_id: "",
    name: doc.name,
    color: doc.color,
    created_at: new Date(doc._creationTime).toISOString(),
  };
}

export function toUiContact(
  doc: Doc<"contacts"> & { tags?: Doc<"tags">[] },
): Contact {
  const createdAt = new Date(doc._creationTime).toISOString();
  return {
    id: doc._id,
    user_id: doc.createdByUserId ?? "",
    account_id: doc.accountId,
    phone: doc.phone,
    phone_normalized: doc.phoneNormalized,
    name: doc.name,
    email: doc.email,
    company: doc.company,
    avatar_url: doc.avatarUrl,
    created_at: createdAt,
    updated_at: createdAt,
    tags: doc.tags ? doc.tags.map(toUiTag) : undefined,
  };
}

export function toUiCustomField(doc: Doc<"customFields">): CustomField {
  return {
    id: doc._id,
    user_id: doc.createdByUserId ?? "",
    account_id: doc.accountId,
    field_name: doc.fieldName,
    field_type: doc.fieldType,
    field_options: doc.fieldOptions as Record<string, unknown> | undefined,
    created_at: new Date(doc._creationTime).toISOString(),
  };
}

export function toUiContactCustomValue(
  doc: Doc<"contactCustomValues">,
): ContactCustomValue {
  return {
    id: doc._id,
    contact_id: doc.contactId,
    custom_field_id: doc.customFieldId,
    value: doc.value,
  };
}

export function toUiContactNote(doc: Doc<"contactNotes">): ContactNote {
  return {
    id: doc._id,
    contact_id: doc.contactId,
    user_id: doc.createdByUserId ?? "",
    note_text: doc.noteText,
    created_at: new Date(doc._creationTime).toISOString(),
  };
}

/** A membership row (from `api.members.list`, which appends a nullable
 *  `email` gated on the caller's role) mapped to the `Profile` shape the
 *  inbox assign-dropdown already consumes — it only reads `user_id` (to
 *  match `assigned_agent_id` + key presence dots) and `full_name`. The
 *  legacy `Profile.role` free-form string is satisfied by the typed
 *  account role; `id` carries the membership id (unused by the dropdown
 *  but required by the type). */
export function toUiMemberProfile(
  doc: Omit<Doc<"memberships">, "email"> & { email?: string | null },
): Profile {
  return {
    id: doc._id,
    user_id: doc.userId,
    full_name: doc.fullName ?? doc.email ?? "Member",
    email: doc.email ?? "",
    role: doc.role,
    account_id: doc.accountId,
    created_at: new Date(doc._creationTime).toISOString(),
  };
}

// ============================================================
// Inbox vertical adapters (Phase 8, Task 2b-2) — conversations,
// messages, reactions, deals. Same rename + `_creationTime`/epoch-ms ->
// ISO-string convention as every adapter above; field names verified
// against `convex/schema.ts` (not the task brief's paraphrase, which
// got at least one field name wrong — see `toUiContactNote`'s `add`
// caller in contact-sidebar.tsx for the same lesson: the mutation's
// arg is `body`, not `noteText`).
// ============================================================

/** Convex has no `contact` join built into `Doc<"conversations">` —
 *  callers must pass the embedded contact themselves (from
 *  `conversations.list`/`get`, both of which already embed it server-
 *  side via `embedContact`). `contact: null` maps to `undefined` (not
 *  `null`) because the UI `Conversation.contact` field is `Contact |
 *  undefined`, not `Contact | null`. */
export function toUiConversation(
  doc: Doc<"conversations"> & {
    contact: (Doc<"contacts"> & { tags?: Doc<"tags">[] }) | null;
  },
): Conversation {
  const createdAt = new Date(doc._creationTime).toISOString();
  return {
    id: doc._id,
    user_id: doc.createdByUserId ?? "",
    contact_id: doc.contactId,
    status: doc.status,
    assigned_agent_id: doc.assignedToUserId,
    last_message_text: doc.lastMessageText,
    last_message_at: doc.lastMessageAt
      ? new Date(doc.lastMessageAt).toISOString()
      : undefined,
    unread_count: doc.unreadCount,
    created_at: createdAt,
    // No on-UPDATE trigger in Convex — `updatedAt` is only set once a
    // write path (setStatus/assign/markRead's own patch, etc.) touches
    // it. Backfill from `created_at` until then, same convention as
    // `toUiContact.updated_at` above.
    updated_at: doc.updatedAt
      ? new Date(doc.updatedAt).toISOString()
      : createdAt,
    contact: doc.contact ? toUiContact(doc.contact) : undefined,
    ai_autoreply_disabled: doc.aiAutoreplyDisabled,
    ai_reply_count: doc.aiReplyCount,
    ai_handoff_summary: doc.aiHandoffSummary,
  };
}

export function toUiMessage(doc: Doc<"messages">): Message {
  return {
    id: doc._id,
    conversation_id: doc.conversationId,
    sender_type: doc.senderType,
    sender_id: doc.senderId,
    content_type: doc.contentType,
    content_text: doc.contentText,
    media_url: doc.mediaUrl,
    template_name: doc.templateName,
    // Meta wamid — the UI type names this `message_id` (there is no
    // separate `whatsapp_message_id` field on `Message`; checked
    // src/types/index.ts).
    message_id: doc.messageId,
    status: doc.status,
    // No dedicated timestamp column on `messages` (see schema.ts) —
    // `_creationTime` IS the send/receive instant, same "don't
    // duplicate created_at" reasoning as every other adapter here.
    created_at: new Date(doc._creationTime).toISOString(),
    reply_to_message_id: doc.replyToMessageId,
    interactive_reply_id: doc.interactiveReplyId,
    interactive_payload: doc.interactivePayload as
      | InteractiveMessagePayload
      | undefined,
    ai_generated: doc.aiGenerated,
  };
}

export function toUiReaction(doc: Doc<"messageReactions">): MessageReaction {
  return {
    id: doc._id,
    message_id: doc.messageId,
    conversation_id: doc.conversationId,
    actor_type: doc.actorType,
    actor_id: doc.actorId,
    emoji: doc.emoji,
    created_at: new Date(doc._creationTime).toISOString(),
  };
}

/** Convex has no `createdAt` field on `pipelineStages` either — same
 *  "don't duplicate created_at" reasoning as every timestamp above. */
export function toUiPipelineStage(doc: Doc<"pipelineStages">): PipelineStage {
  return {
    id: doc._id,
    pipeline_id: doc.pipelineId,
    name: doc.name,
    position: doc.position,
    color: doc.color,
    created_at: new Date(doc._creationTime).toISOString(),
  };
}

/** `stage` must be passed by the caller — `deals.listByContact` already
 *  embeds it server-side (one extra `ctx.db.get(deal.stageId)` per deal,
 *  same pattern as `embedContact` above), so this adapter never fetches
 *  it itself. */
export function toUiDeal(
  doc: Doc<"deals"> & { stage: Doc<"pipelineStages"> | null },
): Deal {
  const createdAt = new Date(doc._creationTime).toISOString();
  return {
    id: doc._id,
    user_id: doc.createdByUserId ?? "",
    pipeline_id: doc.pipelineId,
    stage_id: doc.stageId,
    // `Deal.contact_id` is `string | null` (not `| undefined`) —
    // migration 004 made this column nullable, and the UI type mirrors
    // that with an explicit `null` rather than optional.
    contact_id: doc.contactId ?? null,
    conversation_id: doc.conversationId,
    assigned_to: doc.assignedToUserId,
    title: doc.title,
    value: doc.value,
    currency: doc.currency,
    notes: doc.notes,
    expected_close_date: doc.expectedCloseDate
      ? new Date(doc.expectedCloseDate).toISOString()
      : undefined,
    status: doc.status,
    created_at: createdAt,
    updated_at: doc.updatedAt
      ? new Date(doc.updatedAt).toISOString()
      : createdAt,
    stage: doc.stage ? toUiPipelineStage(doc.stage) : undefined,
  };
}

// ============================================================
// ConvexError helpers — every account-scoped mutation in this codebase
// throws `new ConvexError({ code: "X", ...extra })`, so `.data` is a
// plain object (never a string) for all of contacts/tags/customFields/
// contactNotes. This consolidates the `errorMessage`/`isXError` pattern
// previously copy-pasted across `convex-demo/page.tsx`,
// `(auth)/login/page.tsx`, and `(auth)/signup/page.tsx` into one shared
// helper for the contacts vertical (and any later vertical that wants
// it) — those three call sites are untouched (out of scope here).
// ============================================================

/** The `{ code, ...extra }` payload of a ConvexError thrown by this
 *  codebase's account-scoped functions, or undefined for anything else
 *  (a plain Error, a network failure, or a string-data ConvexError like
 *  `convex/auth.ts`'s password-length check). */
export function convexErrorData(
  err: unknown,
): Record<string, unknown> | undefined {
  if (
    err instanceof ConvexError &&
    typeof err.data === "object" &&
    err.data !== null
  ) {
    return err.data as Record<string, unknown>;
  }
  return undefined;
}

/** True when `err` is a ConvexError whose `.data.code` matches `code`
 *  (e.g. `isConvexErrorCode(err, "DUPLICATE_PHONE")`). */
export function isConvexErrorCode(err: unknown, code: string): boolean {
  return convexErrorData(err)?.code === code;
}

/** Human-readable fallback for a caught error — same shape as the
 *  `errorMessage` helper in `convex-demo/page.tsx`/the auth pages. */
export function convexErrorMessage(err: unknown): string {
  if (err instanceof ConvexError) {
    return typeof err.data === "string" ? err.data : JSON.stringify(err.data);
  }
  if (err instanceof Error) return err.message;
  return "Something went wrong.";
}
