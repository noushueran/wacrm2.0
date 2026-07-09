import { ConvexError } from "convex/values";
import type { Doc } from "../../../convex/_generated/dataModel";
import type {
  Broadcast,
  BroadcastRecipient,
  Contact,
  ContactCustomValue,
  ContactNote,
  Conversation,
  CustomField,
  Deal,
  InteractiveMessagePayload,
  Message,
  MessageReaction,
  MessageTemplate,
  Pipeline,
  PipelineStage,
  Profile,
  QuickReply,
  Tag,
  TemplateButton,
  WhatsAppConfig,
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

/** Convex has no dedicated timestamp column on `pipelines` beyond
 *  `_creationTime` either — same "don't duplicate created_at" reasoning
 *  as every timestamp above. `stages` (embedded per-pipeline by
 *  `pipelines.list`, see convex/pipelines.ts) is intentionally NOT part
 *  of the `Pipeline` UI type (`src/types/index.ts` has no `stages`
 *  field) — callers map a pipeline doc's own `.stages` through
 *  `toUiPipelineStage` separately (see the pipelines page, which derives
 *  the selected pipeline's stages this way instead of a second query). */
export function toUiPipeline(doc: Doc<"pipelines">): Pipeline {
  return {
    id: doc._id,
    user_id: doc.createdByUserId ?? "",
    name: doc.name,
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
// Broadcasts vertical adapters (Phase 8, Task 3) — a bulk template send
// (`broadcasts`) and its per-contact fan-out (`broadcastRecipients`).
// Same rename + `_creationTime`/epoch-ms -> ISO-string convention as
// every adapter above.
// ============================================================

/** `Broadcast` (unlike `Conversation`/`Deal` above) has no `updated_at`
 *  field on the UI type — `convex/schema.ts`'s `broadcasts.updatedAt` is
 *  write-side bookkeeping only (`setStatus`'s own patch) that nothing in
 *  `src/types` or the broadcasts UI reads, so it's intentionally left
 *  unmapped here, same "don't add fields the type doesn't have"
 *  restraint as every other adapter. */
export function toUiBroadcast(doc: Doc<"broadcasts">): Broadcast {
  return {
    id: doc._id,
    user_id: doc.createdByUserId ?? "",
    name: doc.name,
    template_name: doc.templateName,
    template_language: doc.templateLanguage,
    template_variables: doc.templateVariables as
      | Record<string, unknown>
      | undefined,
    audience_filter: doc.audienceFilter as
      | Record<string, unknown>
      | undefined,
    scheduled_at: doc.scheduledAt
      ? new Date(doc.scheduledAt).toISOString()
      : undefined,
    status: doc.status,
    total_recipients: doc.totalRecipients,
    sent_count: doc.sentCount,
    delivered_count: doc.deliveredCount,
    read_count: doc.readCount,
    replied_count: doc.repliedCount,
    failed_count: doc.failedCount,
    created_at: new Date(doc._creationTime).toISOString(),
  };
}

/** `convex/broadcasts.ts`'s `listRecipients` returns bare
 *  `broadcastRecipients` docs with no embedded contact — unlike
 *  `conversations.list`'s `embedContact`, it does no join (see that
 *  query's handler). `contact` is therefore an optional param the
 *  caller passes in only when it has separately resolved one (e.g. the
 *  broadcast detail page's per-row `contacts.get` lookup) — this
 *  adapter never fetches anything itself, same rule every function in
 *  this file follows. */
export function toUiBroadcastRecipient(
  doc: Doc<"broadcastRecipients">,
  contact?: Contact,
): BroadcastRecipient {
  return {
    id: doc._id,
    broadcast_id: doc.broadcastId,
    contact_id: doc.contactId ?? null,
    status: doc.status,
    sent_at: doc.sentAt ? new Date(doc.sentAt).toISOString() : undefined,
    delivered_at: doc.deliveredAt
      ? new Date(doc.deliveredAt).toISOString()
      : undefined,
    read_at: doc.readAt ? new Date(doc.readAt).toISOString() : undefined,
    replied_at: doc.repliedAt
      ? new Date(doc.repliedAt).toISOString()
      : undefined,
    error_message: doc.errorMessage,
    whatsapp_message_id: doc.whatsappMessageId,
    created_at: new Date(doc._creationTime).toISOString(),
    contact,
  };
}

// ============================================================
// Quick replies + message templates vertical adapters (Phase 8, Task 3)
// — reusable inbox-composer snippets (`quickReplies`) and the local
// catalog of Meta message-template variants (`messageTemplates`). Same
// rename + `_creationTime`/epoch-ms -> ISO-string convention as every
// adapter above. Submitting to / syncing from Meta itself stays on the
// existing Supabase-backed `/api/whatsapp/templates/*` routes
// (TODO(P8-T4) in `template-manager.tsx`) — these two adapters only
// cover `templates.list`/`templates.remove` and the full
// `quickReplies.*` CRUD, neither of which has any Meta coupling.
// ============================================================

/** `MessageTemplate` (unlike `Broadcast`/`Conversation`/`Deal` above) has
 *  no `updated_at` field on the UI type at all — only `created_at` — so
 *  `messageTemplates.updatedAt` (write-side bookkeeping the Meta
 *  webhook/resubmit paths touch) is intentionally left unmapped here,
 *  same "don't add fields the type doesn't have" restraint as
 *  `toUiBroadcast` above. `buttons` is `v.optional(v.any())` on the
 *  Convex side, so it gets the same `as` cast every untyped-JSON field
 *  gets elsewhere in this file; `sampleValues`'s `{ body?, header? }`
 *  shape already matches `TemplateSampleValues` structurally, so no cast
 *  is needed there. */
export function toUiTemplate(doc: Doc<"messageTemplates">): MessageTemplate {
  return {
    id: doc._id,
    user_id: doc.createdByUserId ?? "",
    name: doc.name,
    category: doc.category,
    language: doc.language,
    header_type: doc.headerType,
    header_content: doc.headerContent,
    header_handle: doc.headerHandle,
    header_media_url: doc.headerMediaUrl,
    body_text: doc.bodyText,
    footer_text: doc.footerText,
    buttons: doc.buttons as TemplateButton[] | undefined,
    sample_values: doc.sampleValues,
    status: doc.status,
    meta_template_id: doc.metaTemplateId,
    rejection_reason: doc.rejectionReason,
    quality_score: doc.qualityScore,
    submission_error: doc.submissionError,
    last_submitted_at: doc.lastSubmittedAt
      ? new Date(doc.lastSubmittedAt).toISOString()
      : undefined,
    created_at: new Date(doc._creationTime).toISOString(),
  };
}

/** `quickReplies.updatedAt` is optional per schema but is unconditionally
 *  set by both `create` and `update` (see `convex/quickReplies.ts`) — the
 *  `_creationTime` fallback below is defensive only, same "don't trust
 *  the schema's `optional` over the write path" convention as
 *  `toUiConversation.updated_at` above. */
export function toUiQuickReply(doc: Doc<"quickReplies">): QuickReply {
  return {
    id: doc._id,
    account_id: doc.accountId,
    user_id: doc.createdByUserId ?? "",
    title: doc.title,
    kind: doc.kind,
    content_text: doc.contentText,
    interactive_payload: doc.interactivePayload as
      | InteractiveMessagePayload
      | undefined,
    created_at: new Date(doc._creationTime).toISOString(),
    updated_at: doc.updatedAt
      ? new Date(doc.updatedAt).toISOString()
      : new Date(doc._creationTime).toISOString(),
  };
}

// ============================================================
// Settings vertical adapters (Phase 8, Task 3) — WhatsApp Cloud API
// config (`whatsappConfig`) and public-API keys (`apiKeys`). Same
// rename + epoch-ms -> ISO-string convention as every adapter above.
// `webhookEndpoints` has no adapter here: nothing under
// `src/components/settings/` manages webhook endpoints today (grepped
// — the only hits are the `/api/v1/webhooks` REST route handlers and
// the delivery engine), so there is no UI shape to map to yet. Add one
// alongside a settings panel if that ever gets built.
// ============================================================

/** `whatsappConfig.get` returns the FULL raw doc — unlike `aiConfig.get`,
 *  it does not strip `accessToken` before returning (see that query's
 *  own doc comment: this module is "data layer only"). `access_token`
 *  on the mapped `WhatsAppConfig` UI type is therefore never populated
 *  from `doc.accessToken` here regardless — nothing in
 *  `whatsapp-config.tsx` reads this field for display; the form's own
 *  local input state (always masked unless actively being edited) is
 *  what renders, and an unedited save resends `doc.accessToken`
 *  verbatim by reading the raw `useQuery` result directly, not through
 *  this adapter. A fixed placeholder satisfies the (required,
 *  non-optional) UI field without ever surfacing whatever the row
 *  actually holds. */
export function toUiWhatsappConfig(doc: Doc<"whatsappConfig">): WhatsAppConfig {
  return {
    id: doc._id,
    user_id: doc.createdByUserId ?? "",
    phone_number_id: doc.phoneNumberId,
    waba_id: doc.wabaId,
    access_token: "••••••••••••••••",
    verify_token: doc.verifyToken,
    status: doc.status,
    connected_at: doc.connectedAt
      ? new Date(doc.connectedAt).toISOString()
      : undefined,
    registered_at: doc.registeredAt
      ? new Date(doc.registeredAt).toISOString()
      : undefined,
    subscribed_apps_at: doc.subscribedAppsAt
      ? new Date(doc.subscribedAppsAt).toISOString()
      : undefined,
    last_registration_error: doc.lastRegistrationError,
  };
}

/** `apiKeys.list`'s per-item shape — `Doc<"apiKeys">` minus the
 *  never-leaves-the-server `keyHash` (see that query's own doc
 *  comment). `src/types` has no `ApiKey` entry — even the pre-Convex
 *  Supabase-era `api-keys-settings.tsx` scoped an equivalent shape
 *  locally rather than adding one there — so this UI-facing type lives
 *  here instead of being imported from `@/types` like every adapter
 *  above. */
export interface ApiKeyView {
  id: string;
  name: string;
  key_prefix: string;
  scopes: string[];
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

export function toUiApiKey(doc: Omit<Doc<"apiKeys">, "keyHash">): ApiKeyView {
  return {
    id: doc._id,
    name: doc.name,
    key_prefix: doc.keyPrefix,
    scopes: doc.scopes,
    last_used_at: doc.lastUsedAt
      ? new Date(doc.lastUsedAt).toISOString()
      : null,
    expires_at: doc.expiresAt ? new Date(doc.expiresAt).toISOString() : null,
    revoked_at: doc.revokedAt ? new Date(doc.revokedAt).toISOString() : null,
    created_at: new Date(doc._creationTime).toISOString(),
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
