import { ConvexError } from "convex/values";
import type { Doc, Id } from "../../../convex/_generated/dataModel";
import type {
  AccountInvitation,
  AccountMember,
  Automation,
  AutomationLog,
  AutomationLogStepResult,
  AutomationTriggerConfig,
  AutomationTriggerType,
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
  Notification,
  Pipeline,
  PipelineStage,
  Profile,
  QuickReply,
  Tag,
  TemplateButton,
  WhatsAppConfig,
} from "@/types";
// Flows vertical UI types live in `src/lib/flows/types.ts`, NOT
// `@/types` — that module predates the accounts model and is still the
// single source of truth the client-side validator
// (`src/lib/flows/validate.ts`) and node-config forms type against, so
// the adapters below reuse it directly rather than duplicating a
// parallel snake_case shape into `@/types`.
import { DEFAULT_FALLBACK_POLICY } from "@/lib/flows/types";
import type {
  FlowFallbackPolicy,
  FlowNodeRow,
  FlowNodeType,
  FlowRow,
  FlowRunRow,
} from "@/lib/flows/types";

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
    alt_phone: doc.altPhone,
    address: doc.address,
    city: doc.city,
    country: doc.country,
    nationality: doc.nationality,
    preferred_destination: doc.preferredDestination,
    notes: doc.notes,
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
// Team + notifications vertical adapters (Phase 8, Task 3 / P8-T3) —
// the Settings -> Members roster (`memberships`), outstanding invite
// links (`accountInvitations`), and in-app notifications
// (`notifications`). Same rename + `_creationTime`/epoch-ms ->
// ISO-string convention as every adapter above. `AccountMember`/
// `AccountInvitation` (unlike `Profile` above) already exist in
// `src/types/index.ts` with exactly this shape — added ahead of this
// task and unused until now — so these adapters target them directly
// rather than introducing a parallel local type the way `ApiKeyView`/
// `AiConfigView` below did for shapes with no existing `src/types` entry.
// ============================================================

/** `api.members.list`'s per-item shape (a full membership doc with
 *  `email` re-nulled for non-admin callers — see that query's own doc
 *  comment) mapped to the Members-tab roster's `AccountMember`. Unlike
 *  `toUiMemberProfile` above (which targets the generic `Profile` shape
 *  for the inbox assign-dropdown), this keeps `role` as the typed
 *  `AccountRole` and adds `joined_at` — fields the roster UI reads
 *  directly that `Profile` doesn't carry. `full_name` falls back to
 *  `""` (NOT a hardcoded "Member" string like `toUiMemberProfile`
 *  above) so the roster's own `member.full_name || t('unnamed')`
 *  localized fallback still fires instead of being shadowed by an
 *  English literal from this adapter. */
export function toUiMember(
  doc: Omit<Doc<"memberships">, "email"> & { email?: string | null },
): AccountMember {
  return {
    user_id: doc.userId,
    full_name: doc.fullName ?? doc.email ?? "",
    email: doc.email ?? null,
    avatar_url: doc.avatarUrl ?? null,
    role: doc.role,
    joined_at: new Date(doc._creationTime).toISOString(),
  };
}

/** `api.invitations.list`'s per-item shape — an `accountInvitations` doc
 *  with `tokenHash` already stripped server-side (see that query's own
 *  doc comment: nothing in the UI needs it, only `peek`/`redeem` do). */
export function toUiInvitation(
  doc: Omit<Doc<"accountInvitations">, "tokenHash">,
): AccountInvitation {
  return {
    id: doc._id,
    account_id: doc.accountId,
    role: doc.role,
    created_by_user_id: doc.createdByUserId ?? null,
    label: doc.label ?? null,
    created_at: new Date(doc._creationTime).toISOString(),
    expires_at: new Date(doc.expiresAt).toISOString(),
    accepted_at: doc.acceptedAt ? new Date(doc.acceptedAt).toISOString() : null,
    accepted_by_user_id: doc.acceptedByUserId ?? null,
  };
}

/** `api.notifications.list`'s per-item shape — a raw `notifications`
 *  doc (that query does no field-stripping — see its own doc comment). */
export function toUiNotification(doc: Doc<"notifications">): Notification {
  return {
    id: doc._id,
    account_id: doc.accountId,
    user_id: doc.userId,
    type: doc.type,
    conversation_id: doc.conversationId,
    contact_id: doc.contactId,
    actor_user_id: doc.actorUserId,
    title: doc.title,
    body: doc.body,
    read_at: doc.readAt ? new Date(doc.readAt).toISOString() : undefined,
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
// AI settings vertical adapters (Phase 8, Task 3 / P8-T3) — AI
// auto-reply config (`aiConfigs`) and the RAG knowledge base
// (`aiKnowledgeDocuments`).
// ============================================================

/** `aiConfig.get`'s return shape, mapped almost unchanged — it is
 *  already a flat camelCase POJO, NOT a raw `Doc<"aiConfigs">`: that
 *  query deliberately never selects `apiKey`/`embeddingsApiKey` into
 *  its return value at all (see its own doc comment), only the derived
 *  `hasKey`/`hasEmbeddingsKey` booleans below. There is no `src/types`
 *  entry for this — the pre-Convex `AiConfig` (`src/lib/ai/types.ts`)
 *  is the server-only DECRYPTED shape with a plaintext `apiKey`, the
 *  wrong shape entirely for a UI adapter to even reference — so, like
 *  `ApiKeyView` above, this UI-facing type is declared here instead.
 *  `handoffAgentId` is narrowed to a plain `string` (not `Id<"users">`)
 *  to match every other adapter's convention of exposing id fields as
 *  plain strings on their UI-facing type (e.g. `Contact.user_id`). */
export interface AiConfigView {
  provider: "openai" | "anthropic";
  model: string;
  systemPrompt: string | null;
  isActive: boolean;
  autoReplyEnabled: boolean;
  autoReplyMaxPerConversation: number;
  handoffAgentId: string | null;
  hasKey: boolean;
  hasEmbeddingsKey: boolean;
}

export function toUiAiConfig(config: {
  provider: "openai" | "anthropic";
  model: string;
  systemPrompt: string | undefined;
  isActive: boolean;
  autoReplyEnabled: boolean;
  autoReplyMaxPerConversation: number;
  handoffAgentId: Id<"users"> | undefined;
  hasKey: boolean;
  hasEmbeddingsKey: boolean;
}): AiConfigView {
  return {
    provider: config.provider,
    model: config.model,
    systemPrompt: config.systemPrompt ?? null,
    isActive: config.isActive,
    autoReplyEnabled: config.autoReplyEnabled,
    autoReplyMaxPerConversation: config.autoReplyMaxPerConversation,
    handoffAgentId: config.handoffAgentId ?? null,
    hasKey: config.hasKey,
    hasEmbeddingsKey: config.hasEmbeddingsKey,
  };
}

/** `aiKnowledge.list`'s per-item shape — a full `Doc<"aiKnowledgeDocuments">`
 *  (that query does no field-stripping, unlike `aiConfig.get`, since the
 *  whole knowledge CRUD surface is already admin-gated end to end — see
 *  `convex/aiKnowledge.ts`'s own doc comment on `list`). `content` is
 *  included alongside `title` because the settings UI's read-only
 *  content preview reuses this same `list` result — there is no
 *  separate client-callable per-document query to fetch it from
 *  instead (`aiKnowledge.getDocument` is `internalQuery`-only, for the
 *  `ingest` action). `updated_at` falls back to `_creationTime` for the
 *  same defensive reason as `toUiQuickReply.updated_at` above (`create`
 *  always sets it, but the schema still models it `optional`). */
export interface AiKnowledgeDocView {
  id: string;
  title: string;
  content: string;
  updated_at: string;
}

export function toUiAiKnowledgeDoc(
  doc: Doc<"aiKnowledgeDocuments">,
): AiKnowledgeDocView {
  return {
    id: doc._id,
    title: doc.title,
    content: doc.content,
    updated_at: doc.updatedAt
      ? new Date(doc.updatedAt).toISOString()
      : new Date(doc._creationTime).toISOString(),
  };
}

// ============================================================
// Automations vertical adapters (Phase 8, Task 5 / P8-T5) — the
// account-scoped automation definitions (`automations`) and their
// per-execution audit rows (`automationLogs`). Same rename +
// `_creationTime`/epoch-ms -> ISO-string convention as every adapter
// above. The nested step tree itself (`automationSteps`, flattened /
// rebuilt server-side by `convex/lib/automations/stepsTree.ts`) has no
// adapter here — `automations.get`'s `steps` result (a
// `BuilderStepNode[]`) already matches the builder's own
// `ServerStepNode` shape structurally (see
// `automation-builder.tsx`'s `fromServerSteps`), so callers pass it
// straight through instead.
// ============================================================

/** `automations.list`'s per-item shape (a full automation doc plus a
 *  denormalized `stepCount` — see convex/automations.ts) and
 *  `automations.get`'s `automation` field both satisfy this same input
 *  shape (`stepCount` is optional here precisely because `get` doesn't
 *  include it, and nothing on the `Automation` UI type reads it
 *  anyway). `trigger_type`/`trigger_config` are cast to their closed UI
 *  unions the same way every other freeform-string-in-Convex column is
 *  cast elsewhere in this file — Postgres never put a CHECK on
 *  `triggerType` either (see schema.ts's own comment on this column). */
export function toUiAutomation(
  doc: Doc<"automations"> & { stepCount?: number },
): Automation {
  return {
    id: doc._id,
    account_id: doc.accountId,
    user_id: doc.createdByUserId ?? "",
    name: doc.name,
    description: doc.description,
    trigger_type: doc.triggerType as AutomationTriggerType,
    trigger_config: (doc.triggerConfig ?? {}) as AutomationTriggerConfig,
    is_active: doc.isActive,
    execution_count: doc.executionCount,
    last_executed_at: doc.lastExecutedAt
      ? new Date(doc.lastExecutedAt).toISOString()
      : null,
    created_at: new Date(doc._creationTime).toISOString(),
    updated_at: doc.updatedAt
      ? new Date(doc.updatedAt).toISOString()
      : new Date(doc._creationTime).toISOString(),
  };
}

/** `automations.logs`'s per-item shape — a bare `automationLogs` doc
 *  with no embedded contact (unlike the old Supabase `select('*,
 *  contact:contacts(id, name, phone)')` join — see that query's
 *  handler in convex/automations.ts, which never fetches one).
 *  `contact` is therefore an optional param the caller passes in only
 *  when it has separately resolved one (the logs page's own per-row
 *  `contacts.get` lookup), same convention as
 *  `toUiBroadcastRecipient` above; this adapter never fetches anything
 *  itself. */
export function toUiAutomationLog(
  doc: Doc<"automationLogs">,
  contact?: Contact,
): AutomationLog {
  return {
    id: doc._id,
    automation_id: doc.automationId,
    user_id: doc.createdByUserId ?? "",
    contact_id: doc.contactId ?? null,
    trigger_event: doc.triggerEvent,
    steps_executed: (doc.stepsExecuted ?? []) as AutomationLogStepResult[],
    status: doc.status,
    error_message: doc.errorMessage,
    created_at: new Date(doc._creationTime).toISOString(),
    contact,
  };
}

// ============================================================
// Flows vertical adapters (Phase 8, Task 5 / P8-T5) — the visual flow
// builder's definition envelope (`flows`), its graph nodes
// (`flowNodes`), and per-contact runtime state (`flowRuns` +
// `flowRunEvents`). Same rename + `_creationTime`/epoch-ms -> ISO-string
// convention as every adapter above.
// ============================================================

/** `flows.description`/`flows.entryNodeId` are both `v.optional(v.string())`
 *  on the Convex side — no `v.null()` union — so there is no way to send
 *  an explicit "clear this back to unset" value distinct from "field
 *  omitted, don't touch it" through `api.flows.update`'s validator.
 *  `flow-editor-state.tsx`'s `save()` therefore always sends a
 *  (possibly-empty) STRING for both, using `""` as the "none" sentinel
 *  for `entry_node_id`; this adapter reads it back with `||` (not `??`)
 *  so an empty string round-trips to the same `null` the rest of the
 *  flows UI already treats as "unset" (`validate.ts` and the entry-node
 *  pickers only ever do falsy checks on `entry_node_id`, never
 *  `=== null`). A freshly created flow's `fallbackPolicy` is `undefined`
 *  until the first save (the source Postgres column had a DB default;
 *  Convex has none) — backfilled from the engine's own
 *  `DEFAULT_FALLBACK_POLICY` constant, never invented here. */
export function toUiFlow(doc: Doc<"flows">): FlowRow {
  const createdAt = new Date(doc._creationTime).toISOString();
  return {
    id: doc._id,
    account_id: doc.accountId,
    user_id: doc.createdByUserId ?? "",
    name: doc.name,
    description: doc.description ?? null,
    status: doc.status,
    trigger_type: doc.triggerType,
    trigger_config: (doc.triggerConfig ?? {}) as FlowRow["trigger_config"],
    entry_node_id: doc.entryNodeId || null,
    fallback_policy: (doc.fallbackPolicy ??
      DEFAULT_FALLBACK_POLICY) as FlowFallbackPolicy,
    execution_count: doc.executionCount,
    last_executed_at: doc.lastExecutedAt
      ? new Date(doc.lastExecutedAt).toISOString()
      : null,
    created_at: createdAt,
    updated_at: doc.updatedAt
      ? new Date(doc.updatedAt).toISOString()
      : createdAt,
  };
}

/** `flowNodes.nodeType` carries an 11th literal (`http_fetch`, reserved
 *  for a not-yet-built v1.5 node type — see schema.ts's own comment on
 *  this column) that the builder's `FlowNodeType` union deliberately
 *  excludes until that node type ships a form/executor; the cast is
 *  safe because the v1 builder never reads or writes that value. */
export function toUiFlowNode(doc: Doc<"flowNodes">): FlowNodeRow {
  return {
    id: doc._id,
    flow_id: doc.flowId,
    node_key: doc.nodeKey,
    node_type: doc.nodeType as FlowNodeType,
    config: (doc.config ?? {}) as Record<string, unknown>,
    position_x: doc.positionX,
    position_y: doc.positionY,
    created_at: new Date(doc._creationTime).toISOString(),
  };
}

/** `api.flows.runs` embeds a lightweight per-run contact snapshot
 *  server-side (`{_id, name, phone}`, NOT a full `Doc<"contacts">` — see
 *  that query's handler in convex/flows.ts), so — unlike
 *  `toUiBroadcastRecipient`/`toUiAutomationLog` above, which take an
 *  optional contact the CALLER resolves separately — this adapter takes
 *  the already-joined doc directly, the same single-param convention
 *  `toUiConversation`/`toUiDeal` use for a server-side embed. Extends
 *  the engine's own `FlowRunRow` (which has no `contact` field) with
 *  that embed rather than duplicating the rest of the row's fields into
 *  a parallel local type. `started_at` is backfilled from
 *  `_creationTime` (never its own column — see schema.ts's comment on
 *  this table for why), matching the source Postgres row's own
 *  behaviour (`started_at` is set once at INSERT and never updated). */
export function toUiFlowRun(
  doc: Doc<"flowRuns"> & {
    contact: { _id: Id<"contacts">; name?: string; phone: string } | null;
  },
): FlowRunRow & {
  contact: { id: string; name: string | null; phone: string } | null;
} {
  const startedAt = new Date(doc._creationTime).toISOString();
  return {
    id: doc._id,
    flow_id: doc.flowId,
    account_id: doc.accountId,
    user_id: doc.createdByUserId ?? "",
    contact_id: doc.contactId ?? null,
    conversation_id: doc.conversationId ?? null,
    status: doc.status,
    current_node_key: doc.currentNodeKey ?? null,
    last_prompt_message_id: doc.lastPromptMessageId ?? null,
    vars: (doc.vars ?? {}) as Record<string, unknown>,
    reprompt_count: doc.repromptCount,
    started_at: startedAt,
    last_advanced_at: doc.lastAdvancedAt
      ? new Date(doc.lastAdvancedAt).toISOString()
      : startedAt,
    ended_at: doc.endedAt ? new Date(doc.endedAt).toISOString() : null,
    end_reason: doc.endReason ?? null,
    contact: doc.contact
      ? {
          id: doc.contact._id,
          name: doc.contact.name ?? null,
          phone: doc.contact.phone,
        }
      : null,
  };
}

/** `flowRunEvents` has no dedicated UI type in `src/lib/flows/types.ts`
 *  (only the runtime/engine ever read raw event rows pre-Convex) — same
 *  "no `@/types` entry, declare it here" precedent as `ApiKeyView`/
 *  `AiConfigView` above. Append-only audit trail, so (like `flowRuns`
 *  above) there is no separate timestamp column to prefer over
 *  `_creationTime`. */
export interface FlowRunEventView {
  flow_run_id: string;
  event_type: string;
  node_key: string | null;
  payload: Record<string, unknown>;
  created_at: string;
}

export function toUiFlowRunEvent(doc: Doc<"flowRunEvents">): FlowRunEventView {
  return {
    flow_run_id: doc.flowRunId,
    event_type: doc.eventType,
    node_key: doc.nodeKey ?? null,
    payload: (doc.payload ?? {}) as Record<string, unknown>,
    created_at: new Date(doc._creationTime).toISOString(),
  };
}

/** `api.flows.templates`'s per-item shape — a hand-shaped projection
 *  (slug + a few `FlowTemplate` fields), NOT a raw doc (templates are a
 *  static in-code catalog, not a table — see convex/flows.ts). No
 *  `@/types`/`src/lib/flows/types.ts` entry exists for this either, same
 *  "declare it locally" precedent as `FlowRunEventView` above. `icon` is
 *  narrowed to the flows list page's actual icon set (every registered
 *  template uses one of these three — see `FLOW_TEMPLATES` in
 *  convex/flows.ts) rather than left a bare `string`, so the list page's
 *  `TEMPLATE_ICONS` lookup keeps working with no extra cast at the call
 *  site. */
export interface FlowTemplateView {
  slug: string;
  name: string;
  description: string;
  icon: "MessageSquare" | "HelpCircle" | "UserPlus";
  trigger_type: string;
  node_count: number;
}

export function toUiFlowTemplate(tpl: {
  slug: string;
  name: string;
  description: string;
  icon: string;
  triggerType: string;
  nodeCount: number;
}): FlowTemplateView {
  return {
    slug: tpl.slug,
    name: tpl.name,
    description: tpl.description,
    icon: tpl.icon as FlowTemplateView["icon"],
    trigger_type: tpl.triggerType,
    node_count: tpl.nodeCount,
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
