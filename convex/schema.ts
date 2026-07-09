import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { authTables } from "@convex-dev/auth/server";

export default defineSchema({
  ...authTables,

  // A tenant / workspace. Every account-scoped table below carries an
  // `accountId` and an index to filter by it.
  accounts: defineTable({
    name: v.string(),
    defaultCurrency: v.string(), // ISO-4217, default "USD"
    ownerUserId: v.id("users"),
  }).index("by_owner", ["ownerUserId"]),

  // Join table between `users` and `accounts`. A user's role within a
  // given account. `fullName`/`email`/`avatarUrl` are a denormalized
  // snapshot for display without joining back to `users`.
  memberships: defineTable({
    userId: v.id("users"),
    accountId: v.id("accounts"),
    role: v.union(
      v.literal("owner"),
      v.literal("admin"),
      v.literal("agent"),
      v.literal("viewer"),
    ),
    fullName: v.optional(v.string()),
    email: v.optional(v.string()),
    avatarUrl: v.optional(v.string()),
  })
    .index("by_user", ["userId"])
    .index("by_account", ["accountId"])
    .index("by_user_account", ["userId", "accountId"]),

  // A person reachable over WhatsApp, scoped to an account. `phoneNormalized`
  // (digits-only) is set in the mutation layer and used for exact-match
  // lookups; `search_name` only covers `name` — phone/email search is
  // handled in `contacts.list` via a `by_account` scan + startsWith fallback.
  contacts: defineTable({
    accountId: v.id("accounts"),
    createdByUserId: v.optional(v.id("users")),
    phone: v.string(),
    phoneNormalized: v.string(), // digits-only; set in mutation
    name: v.optional(v.string()),
    email: v.optional(v.string()),
    company: v.optional(v.string()),
    avatarUrl: v.optional(v.string()),
  })
    .index("by_account", ["accountId"])
    .index("by_account_phone", ["accountId", "phoneNormalized"])
    .searchIndex("search_name", {
      searchField: "name",
      filterFields: ["accountId"],
    }),

  // A label defined per-account and attached to contacts via `contactTags`.
  tags: defineTable({
    accountId: v.id("accounts"),
    name: v.string(),
    color: v.string(),
  }).index("by_account", ["accountId"]),

  // Join table between `contacts` and `tags`.
  contactTags: defineTable({
    accountId: v.id("accounts"),
    contactId: v.id("contacts"),
    tagId: v.id("tags"),
  })
    .index("by_contact", ["contactId"])
    .index("by_tag", ["tagId"])
    .index("by_contact_tag", ["contactId", "tagId"]),

  // ============================================================
  // Inbox + CRM (Phase 1, Task 1). Source: supabase/migrations
  // 001_initial_schema.sql, 002_pipelines_enhancements.sql,
  // 009_message_actions.sql, 035_interactive_messages.sql, plus the
  // `account_id` backfill from 017_account_sharing.sql.
  // ============================================================

  // A WhatsApp thread with one contact. `contactId`/`status` were NOT NULL
  // in Postgres; `assignedToUserId` mirrors `assigned_agent_id`, which had
  // no DB-level FK in Postgres but is always a user id in practice (same
  // treatment as `deals.assignedToUserId` below). `lastMessageText`/
  // `lastMessageAt` are denormalized so the inbox list never joins into
  // `messages` just to render a preview.
  conversations: defineTable({
    accountId: v.id("accounts"),
    createdByUserId: v.optional(v.id("users")),
    contactId: v.id("contacts"),
    status: v.union(
      v.literal("open"),
      v.literal("pending"),
      v.literal("closed"),
    ),
    assignedToUserId: v.optional(v.id("users")),
    lastMessageText: v.optional(v.string()),
    lastMessageAt: v.optional(v.number()),
    unreadCount: v.number(),
    // AI auto-reply control (migrations 029 + 033). In Postgres these were
    // NOT NULL DEFAULT false / NOT NULL DEFAULT 0 / nullable text. Convex
    // has no column defaults, and all three were added by later migrations
    // to a table with pre-existing rows, so they're optional here (the
    // writing mutation supplies false/0; `aiHandoffSummary` was nullable).
    aiAutoreplyDisabled: v.optional(v.boolean()),
    aiReplyCount: v.optional(v.number()),
    aiHandoffSummary: v.optional(v.string()),
  })
    .index("by_account", ["accountId"])
    .index("by_contact", ["contactId"]),

  // A single WhatsApp message within a `conversations` thread. Postgres
  // never gave `messages` its own `account_id` (tenancy was transitive via
  // `conversation_id` -> `conversations.account_id`); it's denormalized
  // here so this high-volume table gets a direct `by_account` index.
  // `senderId` stays an untyped optional string: it was a bare, FK-less
  // UUID in Postgres that no current write path actually populates (see
  // `src/types/index.ts`'s `Message.sender_id?: string`). `contentType`
  // includes `"interactive"` and `interactiveReplyId` exists because
  // migration 035's own header comment documents both as already applied
  // by migration 010 ("Migration 010 already added 'interactive' to the
  // content_type CHECK and the inbound interactive_reply_id column").
  messages: defineTable({
    accountId: v.id("accounts"),
    conversationId: v.id("conversations"),
    senderType: v.union(
      v.literal("customer"),
      v.literal("agent"),
      v.literal("bot"),
    ),
    senderId: v.optional(v.string()),
    contentType: v.union(
      v.literal("text"),
      v.literal("image"),
      v.literal("document"),
      v.literal("audio"),
      v.literal("video"),
      v.literal("location"),
      v.literal("template"),
      v.literal("interactive"),
    ),
    contentText: v.optional(v.string()),
    mediaUrl: v.optional(v.string()),
    templateName: v.optional(v.string()),
    messageId: v.optional(v.string()), // Meta wamid
    status: v.union(
      v.literal("sending"),
      v.literal("sent"),
      v.literal("delivered"),
      v.literal("read"),
      v.literal("failed"),
    ),
    replyToMessageId: v.optional(v.id("messages")),
    interactivePayload: v.optional(v.any()),
    interactiveReplyId: v.optional(v.string()),
    // True when the AI auto-reply bot generated this message (migration
    // 033). Postgres: NOT NULL DEFAULT false; optional here for the same
    // reason as the conversations AI columns (late addition, no Convex
    // default). Already surfaced optional in `src/types/index.ts`
    // (`Message.ai_generated?: boolean`).
    aiGenerated: v.optional(v.boolean()),
  })
    .index("by_conversation", ["conversationId"])
    .index("by_message_id", ["messageId"])
    .index("by_account", ["accountId"]),

  // One row per (message, actor) reaction. `conversationId` is denormalized
  // here exactly like Postgres denormalized it (migration 009: "so Supabase
  // Realtime can filter on it with a plain eq"). `actorId` is a bare,
  // FK-less identifier in Postgres and is genuinely polymorphic in the
  // app: a `users` id when `actorType === "agent"` (`/api/whatsapp/react`)
  // or a `contacts` id when `actorType === "customer"` (the inbound
  // webhook) — so it stays an untyped optional string rather than a
  // `v.id(...)` of either table.
  messageReactions: defineTable({
    messageId: v.id("messages"),
    conversationId: v.id("conversations"),
    actorType: v.union(v.literal("customer"), v.literal("agent")),
    actorId: v.optional(v.string()),
    emoji: v.string(),
  })
    .index("by_message_actor", ["messageId", "actorType", "actorId"])
    .index("by_message", ["messageId"])
    .index("by_conversation", ["conversationId"]),

  // A named deal pipeline (e.g. "Sales"), owned by an account.
  pipelines: defineTable({
    accountId: v.id("accounts"),
    createdByUserId: v.optional(v.id("users")),
    name: v.string(),
  }).index("by_account", ["accountId"]),

  // An ordered stage within a pipeline (e.g. "Qualified", "Won").
  pipelineStages: defineTable({
    pipelineId: v.id("pipelines"),
    name: v.string(),
    position: v.number(),
    color: v.string(),
  }).index("by_pipeline", ["pipelineId"]),

  // A deal/opportunity tracked against a pipeline stage. `assignedToUserId`
  // is the old `assigned_to` column (migration 002) — it referenced
  // `profiles(id)` in Postgres, not `auth.users(id)` directly, but
  // conceptually (like `conversations.assignedToUserId`) it names the
  // assigned user. `contactId` is optional: migration 004
  // (contact_delete_set_null) dropped its NOT NULL and made the FK
  // ON DELETE SET NULL, so a deal survives its contact being deleted.
  deals: defineTable({
    accountId: v.id("accounts"),
    createdByUserId: v.optional(v.id("users")),
    pipelineId: v.id("pipelines"),
    stageId: v.id("pipelineStages"),
    contactId: v.optional(v.id("contacts")),
    conversationId: v.optional(v.id("conversations")),
    title: v.string(),
    value: v.number(),
    currency: v.optional(v.string()),
    notes: v.optional(v.string()),
    expectedCloseDate: v.optional(v.number()),
    status: v.union(v.literal("open"), v.literal("won"), v.literal("lost")),
    assignedToUserId: v.optional(v.id("users")),
  })
    .index("by_account", ["accountId"])
    .index("by_pipeline", ["pipelineId"])
    .index("by_stage", ["stageId"])
    .index("by_contact", ["contactId"]),

  // A custom field definition (e.g. "Birthday") an account can attach
  // values of to any contact via `contactCustomValues`.
  customFields: defineTable({
    accountId: v.id("accounts"),
    createdByUserId: v.optional(v.id("users")),
    fieldName: v.string(),
    fieldType: v.string(), // freeform in Postgres too — no CHECK constraint
    fieldOptions: v.optional(v.any()),
  }).index("by_account", ["accountId"]),

  // One value of one custom field on one contact.
  contactCustomValues: defineTable({
    contactId: v.id("contacts"),
    customFieldId: v.id("customFields"),
    value: v.optional(v.string()),
  })
    .index("by_contact_field", ["contactId", "customFieldId"])
    .index("by_contact", ["contactId"]),

  // A free-text note an account member left on a contact.
  contactNotes: defineTable({
    accountId: v.id("accounts"),
    contactId: v.id("contacts"),
    createdByUserId: v.optional(v.id("users")),
    noteText: v.string(),
  })
    .index("by_contact", ["contactId"])
    .index("by_account", ["accountId"]),

  // ============================================================
  // Messaging + Settings (Phase 1, Task 2). Source: supabase/migrations
  // 001_initial_schema.sql, 003_broadcast_recipient_wamid.sql,
  // 004_contact_delete_set_null.sql, 005_broadcast_counts_incremental.sql,
  // 013_whatsapp_config_phone_number_id_unique.sql,
  // 014_message_templates_meta_integration.sql,
  // 015_whatsapp_config_registration.sql, 017_account_sharing.sql,
  // 019_invitation_rpcs.sql (RPCs only — no schema change),
  // 024_member_presence.sql, 026_api_keys.sql, 027_notifications.sql,
  // 028_webhook_endpoints.sql, 035_interactive_messages.sql. Every one
  // of these 10 tables was swept across all 35 migrations (grep "ALTER
  // TABLE <table>") rather than just the named ones above, precisely
  // because Task 1 found late migrations (029/033) adding columns to a
  // table outside its named set — see the task report for what that
  // sweep changed here.
  // ============================================================

  // A local catalog row for one Meta message-template (language)
  // variant. `status` started as a TitleCase 4-value enum (001) and was
  // swapped for the raw Meta enum by migration 014, which also added
  // every Meta-integration column below (`sampleValues` through
  // `lastSubmittedAt`). `language`/`status` are optional because neither
  // was ever declared NOT NULL in Postgres (only `category`/`bodyText`
  // were) — `headerMediaUrl` is a sweep addition: 014's own header
  // comment documents it (URL fallback for media headers) right next to
  // `headerHandle`, but the task brief's tricky-notes list named only
  // the latter.
  messageTemplates: defineTable({
    accountId: v.id("accounts"),
    createdByUserId: v.optional(v.id("users")),
    name: v.string(),
    category: v.union(
      v.literal("Marketing"),
      v.literal("Utility"),
      v.literal("Authentication"),
    ),
    language: v.optional(v.string()), // default "en_US"
    headerType: v.optional(
      v.union(
        v.literal("text"),
        v.literal("image"),
        v.literal("video"),
        v.literal("document"),
      ),
    ),
    headerContent: v.optional(v.string()),
    bodyText: v.string(),
    footerText: v.optional(v.string()),
    buttons: v.optional(v.any()),
    // Raw Meta enum — migration 014 dropped the earlier TitleCase set.
    status: v.optional(
      v.union(
        v.literal("DRAFT"),
        v.literal("PENDING"),
        v.literal("APPROVED"),
        v.literal("REJECTED"),
        v.literal("PAUSED"),
        v.literal("DISABLED"),
        v.literal("IN_APPEAL"),
        v.literal("PENDING_DELETION"),
      ),
    ),
    sampleValues: v.optional(
      v.object({
        body: v.optional(v.array(v.string())),
        header: v.optional(v.array(v.string())),
      }),
    ),
    metaTemplateId: v.optional(v.string()),
    rejectionReason: v.optional(v.string()),
    qualityScore: v.optional(
      v.union(v.literal("GREEN"), v.literal("YELLOW"), v.literal("RED")),
    ),
    headerHandle: v.optional(v.string()),
    headerMediaUrl: v.optional(v.string()),
    submissionError: v.optional(v.string()),
    lastSubmittedAt: v.optional(v.number()),
  })
    .index("by_account", ["accountId"])
    .index("by_account_name_lang", ["accountId", "name", "language"])
    // Webhook status updates identify templates by meta_template_id
    // (migration 014's own `idx_message_templates_meta_template_id`).
    .index("by_meta_template_id", ["metaTemplateId"]),

  // A scheduled/sent bulk send of one template to a filtered audience.
  // Counters (`sentCount` etc.) are `v.number()`, not optional — like
  // `conversations.unreadCount` in Task 1, Postgres never marked them
  // NOT NULL either, but every insert supplies 0 and migration 005's
  // incremental trigger only ever adjusts from there.
  broadcasts: defineTable({
    accountId: v.id("accounts"),
    createdByUserId: v.optional(v.id("users")),
    name: v.string(),
    templateName: v.string(),
    templateLanguage: v.string(), // NOT NULL DEFAULT 'en_US'
    templateVariables: v.optional(v.any()),
    audienceFilter: v.optional(v.any()),
    scheduledAt: v.optional(v.number()),
    status: v.union(
      v.literal("draft"),
      v.literal("scheduled"),
      v.literal("sending"),
      v.literal("sent"),
      v.literal("failed"),
    ),
    totalRecipients: v.number(),
    sentCount: v.number(),
    deliveredCount: v.number(),
    readCount: v.number(),
    repliedCount: v.number(),
    failedCount: v.number(),
  }).index("by_account", ["accountId"]),

  // One row per (broadcast, contact) send. `contactId` is optional:
  // migration 004 dropped its NOT NULL and made the FK ON DELETE SET
  // NULL so history survives contact deletion — the same reasoning
  // Task 1 used for `deals.contactId`, except 004 is inside *this*
  // task's swept migration set, so (unlike the open question Task 1
  // flagged for `deals`) there's no ambiguity here: `contactId` is
  // optional. `accountId` is denormalized — Postgres never had one on
  // this table (tenancy was transitive via `broadcast_id`) — because
  // the brief calls for a direct `by_account` index, the same treatment
  // Task 1 gave the high-volume `messages` table.
  broadcastRecipients: defineTable({
    accountId: v.id("accounts"),
    broadcastId: v.id("broadcasts"),
    contactId: v.optional(v.id("contacts")),
    status: v.union(
      v.literal("pending"),
      v.literal("sent"),
      v.literal("delivered"),
      v.literal("read"),
      v.literal("replied"),
      v.literal("failed"),
    ),
    sentAt: v.optional(v.number()),
    deliveredAt: v.optional(v.number()),
    readAt: v.optional(v.number()),
    repliedAt: v.optional(v.number()),
    errorMessage: v.optional(v.string()),
    whatsappMessageId: v.optional(v.string()), // Meta wamid (migration 003)
  })
    .index("by_broadcast", ["broadcastId"])
    .index("by_account", ["accountId"])
    .index("by_wamid", ["whatsappMessageId"]),

  // A reusable inbox-composer snippet — either plain text or a saved
  // interactive (buttons/list) payload. `createdByUserId` is author/
  // audit only, same as everywhere else (never used for tenancy).
  quickReplies: defineTable({
    accountId: v.id("accounts"),
    createdByUserId: v.optional(v.id("users")),
    title: v.string(),
    kind: v.union(v.literal("text"), v.literal("interactive")),
    contentText: v.optional(v.string()),
    interactivePayload: v.optional(v.any()),
  }).index("by_account", ["accountId"]),

  // One WhatsApp Cloud API connection per account. `createdByUserId`
  // (Postgres `user_id`) predates multi-tenant accounts — migration 017
  // dropped its UNIQUE constraint in favor of UNIQUE(account_id), but
  // never dropped the column itself, so it stays as audit metadata like
  // every other former-owner column in this file. `accessToken` is
  // encrypted at rest by the application layer (see 028/029's header
  // comments, which reuse the same `encrypt()`/`decrypt()` helper), so
  // it stays a plain `v.string()` rather than a structured type.
  whatsappConfig: defineTable({
    accountId: v.id("accounts"),
    createdByUserId: v.optional(v.id("users")),
    phoneNumberId: v.string(),
    wabaId: v.optional(v.string()),
    accessToken: v.string(),
    verifyToken: v.optional(v.string()),
    status: v.union(v.literal("connected"), v.literal("disconnected")),
    connectedAt: v.optional(v.number()),
    // Meta Cloud API registration state (migration 015).
    registeredAt: v.optional(v.number()),
    subscribedAppsAt: v.optional(v.number()),
    lastRegistrationError: v.optional(v.string()),
  })
    .index("by_account", ["accountId"])
    .index("by_phone_number_id", ["phoneNumberId"]),

  // One outstanding invite link. `tokenHash` is a SHA-256 digest, never
  // the plaintext token (same pattern as `apiKeys.keyHash` below).
  // `role` excludes "owner" — migration 017's CHECK (role <> 'owner')
  // means an invite can only ever grant admin/agent/viewer.
  accountInvitations: defineTable({
    accountId: v.id("accounts"),
    tokenHash: v.string(),
    role: v.union(v.literal("admin"), v.literal("agent"), v.literal("viewer")),
    createdByUserId: v.optional(v.id("users")),
    label: v.optional(v.string()),
    expiresAt: v.number(),
    acceptedAt: v.optional(v.number()),
    acceptedByUserId: v.optional(v.id("users")),
  })
    .index("by_account", ["accountId"])
    .index("by_token_hash", ["tokenHash"]),

  // A machine credential for the public REST API. Only `keyHash` (SHA-
  // 256 of the plaintext) is stored, never the key itself; `keyPrefix`
  // is a non-secret display string. `scopes` stays a plain string array
  // — migration 026's header comment: "a future scope is a code change,
  // not a migration" — so the vocabulary is enforced in the app layer.
  apiKeys: defineTable({
    accountId: v.id("accounts"),
    createdByUserId: v.optional(v.id("users")),
    name: v.string(),
    keyPrefix: v.string(),
    keyHash: v.string(),
    scopes: v.array(v.string()),
    lastUsedAt: v.optional(v.number()),
    expiresAt: v.optional(v.number()),
    revokedAt: v.optional(v.number()),
  })
    .index("by_account", ["accountId"])
    .index("by_key_hash", ["keyHash"]),

  // An account-registered HTTPS endpoint wacrm POSTs events to. Unlike
  // `apiKeys.keyHash` (a bearer credential the *client* presents, so we
  // only need a hash), `secret` is the HMAC key *we* sign outgoing
  // payloads with, so the plaintext is needed at delivery time — it's
  // AES-256-GCM-encrypted at rest instead of hashed.
  webhookEndpoints: defineTable({
    accountId: v.id("accounts"),
    createdByUserId: v.optional(v.id("users")),
    url: v.string(),
    secret: v.string(),
    events: v.array(v.string()),
    isActive: v.boolean(),
    lastDeliveryAt: v.optional(v.number()),
    failureCount: v.number(),
  }).index("by_account", ["accountId"]),

  // An in-app notification for one agent. `userId` is the recipient —
  // unlike every other `*UserId` field in this file, it is NOT an audit
  // column. `type` has exactly one CHECK-allowed value today
  // ("conversation_assigned"); modeled as a one-literal union rather
  // than a bare string so a second notification type later is a visible,
  // typed change instead of a silent widening.
  notifications: defineTable({
    accountId: v.id("accounts"),
    userId: v.id("users"),
    type: v.union(v.literal("conversation_assigned")),
    conversationId: v.optional(v.id("conversations")),
    contactId: v.optional(v.id("contacts")),
    // Who triggered it; NULL means an automation/system action.
    actorUserId: v.optional(v.id("users")),
    title: v.string(),
    body: v.optional(v.string()),
    readAt: v.optional(v.number()),
  })
    .index("by_account", ["accountId"])
    .index("by_user", ["userId"]),

  // Lightweight online/away heartbeat, one row per user. Postgres's
  // primary key WAS `user_id` (a genuine one-row-per-user constraint);
  // here that becomes a plain field plus an enforcing `by_user` index
  // the future `touchPresence` mutation checks before upserting.
  memberPresence: defineTable({
    userId: v.id("users"),
    accountId: v.id("accounts"),
    status: v.union(v.literal("online"), v.literal("away")),
    lastSeenAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_account", ["accountId"]),

  // (other tables added in later Phase 1 tasks: automations + flows
  // [Task 3], AI [Task 4])
});
