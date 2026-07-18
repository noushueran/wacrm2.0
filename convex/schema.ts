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
    leadValue: v.optional(v.number()), // flat per-lead charge; unset/<=0 = feature OFF
    suppressBotHandledPush: v.optional(v.boolean()), // opt-in: skip push when a flow fully handled the inbound message
  }).index("by_owner", ["ownerUserId"]),

  // Append-only spend ledger — one row = one agent charged once for one
  // conversation. Never updated/deleted in normal operation. `value`/
  // `currency` are snapshots of the account rate at charge time so later
  // rate changes don't rewrite history. `by_user_conversation` backs the
  // once-per-(agent,conversation) idempotency check.
  leadCharges: defineTable({
    accountId: v.id("accounts"),
    userId: v.id("users"),
    conversationId: v.id("conversations"),
    value: v.number(),
    currency: v.string(),
  })
    .index("by_account", ["accountId"])
    .index("by_user_account", ["userId", "accountId"])
    .index("by_user_conversation", ["userId", "conversationId"]),

  // Join table between `users` and `accounts`. A user's role within a
  // given account. `fullName`/`email`/`avatarUrl` are a denormalized
  // snapshot for display without joining back to `users`.
  memberships: defineTable({
    userId: v.id("users"),
    accountId: v.id("accounts"),
    role: v.union(
      v.literal("owner"),
      v.literal("admin"),
      v.literal("supervisor"),
      v.literal("agent"),
      v.literal("viewer"),
    ),
    fullName: v.optional(v.string()),
    email: v.optional(v.string()),
    avatarUrl: v.optional(v.string()),
    // v4 (qualification): the member's own WhatsApp number — the channel
    // the AI uses to reach agents (lead offers, questions) when they're
    // away from the desktop. Set by admin+ in Settings → Team members.
    phone: v.optional(v.string()),
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
    // Human-readable per-account identifier, e.g. "HC-000123". Optional in
    // the schema so pre-backfill rows validate, but written on every new
    // insert via `allocateContactCode`.
    contactCode: v.optional(v.string()),
    // Extended CRM detail — all optional, edited from the inbox contact
    // panel. Additive/backward-compatible; no migration.
    altPhone: v.optional(v.string()),
    address: v.optional(v.string()),
    city: v.optional(v.string()),
    country: v.optional(v.string()),
    nationality: v.optional(v.string()),
    preferredDestination: v.optional(v.string()),
    notes: v.optional(v.string()),
    // Lead-acquisition provenance. Set ONCE, the first time a contact
    // arrives via a Click-to-WhatsApp ad referral; never overwritten.
    acquisitionSource: v.optional(v.literal("ad")),
    acquisitionAd: v.optional(
      v.object({
        headline: v.optional(v.string()),
        sourceId: v.optional(v.string()),
        sourceUrl: v.optional(v.string()),
        firstSeenAt: v.number(),
      }),
    ),
  })
    .index("by_account", ["accountId"])
    .index("by_account_phone", ["accountId", "phoneNormalized"])
    .searchIndex("search_name", {
      searchField: "name",
      filterFields: ["accountId"],
    }),

  // A label defined per-account and attached to contacts via `contactTags`.
  // Optionally belongs to a `tagGroups` dimension (Product, Destination, …);
  // ungrouped tags (groupId unset) remain valid — pre-grouping tags stay usable.
  tags: defineTable({
    accountId: v.id("accounts"),
    name: v.string(),
    color: v.string(),
    groupId: v.optional(v.id("tagGroups")),
    position: v.optional(v.number()),
  })
    .index("by_account", ["accountId"])
    .index("by_group", ["groupId"]),

  // A dimension that tags are organised under. `selectionMode: "single"`
  // means a contact holds at most one tag from this group (e.g. Priority);
  // "multi" allows several (e.g. Destination). `position` orders groups
  // in the UI.
  tagGroups: defineTable({
    accountId: v.id("accounts"),
    name: v.string(),
    color: v.optional(v.string()),
    selectionMode: v.union(v.literal("single"), v.literal("multi")),
    position: v.number(),
  }).index("by_account", ["accountId"]),

  // Join table between `contacts` and `tags`.
  contactTags: defineTable({
    accountId: v.id("accounts"),
    contactId: v.id("contacts"),
    tagId: v.id("tags"),
    source: v.optional(v.union(v.literal("ai"), v.literal("manual"))), // unset = manual (backward-compatible)
  })
    .index("by_contact", ["contactId"])
    .index("by_tag", ["tagId"])
    .index("by_contact_tag", ["contactId", "tagId"]),

  // Per-account monotonic counters for human-readable sequential codes
  // (e.g. `("contacts")` backs the HC-000123 contact code). One row per
  // (accountId, name); `value` is the last number allocated (0 = none yet).
  counters: defineTable({
    accountId: v.id("accounts"),
    name: v.string(),
    value: v.number(),
  }).index("by_account_name", ["accountId", "name"]),

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
    // Postgres maintains this via an on-UPDATE trigger; added here for
    // uniform trigger parity across every such table (P1 review) — the
    // dashboard's inbox sort and the v1 API contract both expose it.
    updatedAt: v.optional(v.number()),
    // Denormalized Click-to-WhatsApp ad summary — presence flags this
    // conversation as an "ad lead" for the inbox badge without scanning
    // messages. `startedAt` anchors the 72h free-entry-point indicator
    // (set once, on the first ad message).
    adReferral: v.optional(
      v.object({
        headline: v.optional(v.string()),
        body: v.optional(v.string()),
        sourceUrl: v.optional(v.string()),
        sourceType: v.optional(v.union(v.literal("ad"), v.literal("post"))),
        imageUrl: v.optional(v.string()),
        storedImageUrl: v.optional(v.string()),
        startedAt: v.number(),
      }),
    ),
    // Lead-source classifier for the conversion funnel. Set ONCE, the first
    // time an attribution identifier is seen on an inbound message (the HY-
    // zero-width code → website lane, or the Meta `ctwa_clid` → ad lane);
    // never overwritten. Both identifiers are retained if both ever appear;
    // `lane` (code-wins) decides which backend the funnel dispatches to, so a
    // conversation never double-fires. Absent = organic (never reported).
    attribution: v.optional(
      v.object({
        lane: v.union(v.literal("code"), v.literal("ctwa")),
        code: v.optional(v.string()),
        ctwaClid: v.optional(v.string()),
        firstSeenAt: v.number(),
      }),
    ),
    // Denormalized CURRENT funnel stage for fast inbox render + future
    // stage-filtering, without scanning `funnelTransitions`. `saleValue`/
    // `saleCurrency` are captured at the Purchased stage (and optionally at
    // quote/invoice). The full progress history lives in `funnelTransitions`.
    funnel: v.optional(
      v.object({
        stage: v.union(
          v.literal("new_lead"),
          v.literal("qualified"),
          v.literal("price_quoted"),
          v.literal("itinerary_created"),
          v.literal("itinerary_sent"),
          v.literal("invoice_sent"),
          v.literal("purchased"),
          v.literal("lost"),
        ),
        stageUpdatedAt: v.number(),
        stageUpdatedByUserId: v.optional(v.id("users")),
        saleValue: v.optional(v.number()),
        saleCurrency: v.optional(v.string()),
      }),
    ),
  })
    .index("by_account", ["accountId"])
    .index("by_contact", ["contactId"])
    // Phase 2, Task 1: the Inbox list orders conversations by recency of
    // activity, not creation time — Convex indexes order by the indexed
    // field(s) then `_creationTime`, so a plain `by_account` scan can't
    // give `lastMessageAt`-desc ordering on its own. `lastMessageAt` is
    // optional (a brand new conversation with no messages yet has none);
    // Convex sorts a missing field before every present value, so in
    // `.order("desc")` those rows deterministically fall to the end of
    // the page rather than scattering randomly or erroring.
    .index("by_account_last_message", ["accountId", "lastMessageAt"])
    // `unreadTotal` (the app-wide sidebar badge) counts this account's
    // conversations with `unreadCount > 0`. Ranging that test on the
    // index instead of filtering in JS bounds both the read set and —
    // because a Convex subscription re-runs when any document it read
    // changes — the invalidation set: without it, the `lastMessageAt`
    // patch every message writes re-runs a full-account scan for every
    // connected client. Deliberately NOT a prefix of `by_account`:
    // Convex appends `_creationTime` to each index, so `by_account` is
    // `["accountId", "_creationTime"]` and cannot express this range.
    .index("by_account_unread", ["accountId", "unreadCount"]),

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
    // AI transcription of an inbound voice note / vision description of
    // an inbound image (aiReply media understanding, 2026-07-18) —
    // rendered into the assistant's transcript so replies address the
    // actual content.
    aiTranscription: v.optional(v.string()),
    // True when the AI auto-reply bot generated this message (migration
    // 033). Postgres: NOT NULL DEFAULT false; optional here for the same
    // reason as the conversations AI columns (late addition, no Convex
    // default). Already surfaced optional in `src/types/index.ts`
    // (`Message.ai_generated?: boolean`).
    aiGenerated: v.optional(v.boolean()),
    // The full Click-to-WhatsApp ad referral, on the FIRST inbound message
    // that carried it. `storedImageUrl` is the durable Convex-storage copy
    // of the ad image (Task 3), patched in after ingest.
    referral: v.optional(
      v.object({
        sourceType: v.optional(v.union(v.literal("ad"), v.literal("post"))),
        sourceId: v.optional(v.string()),
        sourceUrl: v.optional(v.string()),
        headline: v.optional(v.string()),
        body: v.optional(v.string()),
        mediaType: v.optional(v.union(v.literal("image"), v.literal("video"))),
        imageUrl: v.optional(v.string()),
        videoUrl: v.optional(v.string()),
        thumbnailUrl: v.optional(v.string()),
        storedImageUrl: v.optional(v.string()),
      }),
    ),
  })
    .index("by_conversation", ["conversationId"])
    .index("by_message_id", ["messageId"])
    .index("by_account", ["accountId"]),

  // One row per (message, actor) reaction. `conversationId` is denormalized
  // here exactly like Postgres denormalized it (migration 009: "so Supabase
  // Realtime can filter on it with a plain eq"). `accountId` is likewise
  // denormalized off `messageId`/`conversationId` (P1 review — not a
  // Postgres column) for the same uniform account-scoping reason as
  // `pipelineStages` below. `actorId` is a bare,
  // FK-less identifier in Postgres and is genuinely polymorphic in the
  // app: a `users` id when `actorType === "agent"` (`/api/whatsapp/react`)
  // or a `contacts` id when `actorType === "customer"` (the inbound
  // webhook) — so it stays an untyped optional string rather than a
  // `v.id(...)` of either table.
  messageReactions: defineTable({
    accountId: v.id("accounts"),
    messageId: v.id("messages"),
    conversationId: v.id("conversations"),
    actorType: v.union(v.literal("customer"), v.literal("agent")),
    actorId: v.optional(v.string()),
    emoji: v.string(),
  })
    .index("by_message_actor", ["messageId", "actorType", "actorId"])
    .index("by_message", ["messageId"])
    .index("by_conversation", ["conversationId"])
    .index("by_account", ["accountId"]),

  // A named deal pipeline (e.g. "Sales"), owned by an account.
  pipelines: defineTable({
    accountId: v.id("accounts"),
    createdByUserId: v.optional(v.id("users")),
    name: v.string(),
  }).index("by_account", ["accountId"]),

  // An ordered stage within a pipeline (e.g. "Qualified", "Won").
  // `accountId` is denormalized off `pipelineId` (P1 review) — Postgres
  // itself never had this column (tenancy was transitive via
  // `pipeline_id`), but it's added here for the same uniform
  // account-scoped querying every other table gets (matches
  // `messages`/`contactTags`/`broadcastRecipients`).
  pipelineStages: defineTable({
    accountId: v.id("accounts"),
    pipelineId: v.id("pipelines"),
    name: v.string(),
    position: v.number(),
    color: v.string(),
  })
    .index("by_pipeline", ["pipelineId"])
    .index("by_account", ["accountId"]),

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
    // Same on-UPDATE-trigger parity as `conversations.updatedAt` above
    // (P1 review) — the deals board sorts on it too.
    updatedAt: v.optional(v.number()),
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

  // One value of one custom field on one contact. `accountId` is
  // denormalized off `contactId` (P1 review) for the same uniform
  // account-scoping reason as `pipelineStages` above.
  contactCustomValues: defineTable({
    accountId: v.id("accounts"),
    contactId: v.id("contacts"),
    customFieldId: v.id("customFields"),
    value: v.optional(v.string()),
  })
    .index("by_contact_field", ["contactId", "customFieldId"])
    .index("by_contact", ["contactId"])
    .index("by_account", ["accountId"])
    // `contacts.byCustomFieldValue` (the broadcast composer's audience
    // filter) and `customFields.remove`'s cascade both want one field's
    // value rows across every contact. `by_contact_field` cannot serve that
    // — its prefix is `contactId`, so it can only answer "this contact's
    // value for this field", not "every contact's value for this field".
    // On `by_account` the `customFieldId` test was a `.filter()`, i.e. a
    // scan of every custom value in the account. Grows with contacts ×
    // fields.
    .index("by_account_field", ["accountId", "customFieldId"]),

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
    // Same on-UPDATE-trigger parity as `conversations.updatedAt` (P1 review).
    updatedAt: v.optional(v.number()),
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
    // Same on-UPDATE-trigger parity as `conversations.updatedAt` (P1 review).
    updatedAt: v.optional(v.number()),
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
    // `maybeFinalizeBroadcast` runs once per delivered recipient and asks
    // "is any recipient still pending?". `.filter()` runs *after* the
    // index scan, so on `by_broadcast` alone each probe walked past the
    // already-resolved recipients piling up at the front of the range —
    // O(N^2) reads to finalize an N-recipient broadcast. Binding `status`
    // makes that probe O(1); `startSendingInternal`'s pending set uses
    // the same range.
    .index("by_broadcast_status", ["broadcastId", "status"])
    .index("by_account", ["accountId"])
    // `contacts.remove`'s SET NULL cascade wants one contact's recipient
    // rows. On `by_account` alone that read the account's ENTIRE broadcast
    // history and narrowed it with a `.filter()`, which does not narrow what
    // Convex reads. This table is the spikiest in the schema — one send
    // inserts a row per recipient at once — so the scan a single contact
    // deletion pays grows with total broadcast volume, not with that
    // contact's. `contactId` is optional (this cascade is what clears it);
    // Convex sorts missing values before all present ones, so a `.eq` range
    // on a present id is unaffected.
    .index("by_account_contact", ["accountId", "contactId"])
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
    // Same on-UPDATE-trigger parity as `conversations.updatedAt` (P1 review).
    updatedAt: v.optional(v.number()),
  }).index("by_account", ["accountId"]),

  // One WhatsApp Cloud API connection per account. `createdByUserId`
  // (Postgres `user_id`) predates multi-tenant accounts — migration 017
  // dropped its UNIQUE constraint in favor of UNIQUE(account_id), but
  // never dropped the column itself, so it stays as audit metadata like
  // every other former-owner column in this file. `accessToken` is
  // encrypted at rest by `whatsappConfig.upsert` itself (Phase 8 Task 3
  // moved this off the Next.js app layer and onto the same inline
  // `encrypt()`/`decrypt()` helper `aiConfigs.apiKey` below already
  // uses), so it stays a plain `v.string()` rather than a structured
  // type.
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
    // Same on-UPDATE-trigger parity as `conversations.updatedAt` (P1 review).
    updatedAt: v.optional(v.number()),
  })
    .index("by_account", ["accountId"])
    .index("by_phone_number_id", ["phoneNumberId"])
    // `matchVerifyToken` runs on every Meta webhook GET handshake and used
    // to scan this whole table. Indexable precisely BECAUSE `verifyToken` is
    // stored as plain text (see `upsert` — only `accessToken` is encrypted),
    // so the value arriving in `hub.verify_token` is the stored key itself.
    // The index therefore holds no secret the document did not already hold
    // in the clear. If `verifyToken` is ever encrypted to match
    // `accessToken` — the open question `matchVerifyToken`'s own comment
    // raises — this index stops working and the lookup has to move to a
    // stored hash of the token, not ciphertext (which is per-row salted and
    // so not equality-comparable).
    .index("by_verify_token", ["verifyToken"]),

  // One outstanding invite link. `tokenHash` is a SHA-256 digest, never
  // the plaintext token (same pattern as `apiKeys.keyHash` below).
  // `role` excludes "owner" — migration 017's CHECK (role <> 'owner')
  // means an invite can only ever grant admin/agent/viewer.
  accountInvitations: defineTable({
    accountId: v.id("accounts"),
    tokenHash: v.string(),
    role: v.union(v.literal("admin"), v.literal("supervisor"), v.literal("agent"), v.literal("viewer")),
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

  // An account-registered HTTPS endpoint Holidayys WA CRM POSTs events to. Unlike
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
    type: v.union(
      v.literal("conversation_assigned"),
      v.literal("lead_qualified"),
      // Assigned-agent reply-SLA breach (customer waiting on a taken
      // chat) — targets supervisors+.
      v.literal("sla_alert"),
    ),
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

  // One Web Push subscription = one browser/device for one user. A user
  // may have several (phone + laptop). `by_endpoint` is the upsert/prune
  // key; `by_user` loads a recipient's devices when sending.
  pushSubscriptions: defineTable({
    accountId: v.id("accounts"),
    userId: v.id("users"),
    endpoint: v.string(),
    p256dh: v.string(),
    auth: v.string(),
    userAgent: v.optional(v.string()),
    createdAt: v.number(),
    lastSeenAt: v.number(),
  })
    .index("by_endpoint", ["endpoint"])
    .index("by_user", ["userId"])
    .index("by_account", ["accountId"]),

  // Per-user, per-account notification preferences. An absent row means
  // defaults (push enabled, message preview shown).
  notificationPreferences: defineTable({
    accountId: v.id("accounts"),
    userId: v.id("users"),
    pushEnabled: v.boolean(),
    hidePreview: v.boolean(),
  }).index("by_user_account", ["userId", "accountId"]),

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

  // ============================================================
  // Automations + Flows (Phase 1, Task 3). Source: supabase/migrations
  // 006_automations.sql, 007_automations_increment_counter.sql (RPC
  // only — no schema change), 010_flows.sql,
  // 012_flows_increment_counter.sql (RPC only), 016_flow_media.sql,
  // 017_account_sharing.sql, 020_account_sharing_followups.sql
  // (indexes only). All 8 tables were swept across every migration
  // (grep "ALTER TABLE <table>"), not just the named set, per Task
  // 1/2's own precedent of late migrations touching tables outside
  // their named source list. Two real findings from that sweep:
  //   - Migration 017 added `account_id` (NOT NULL) to `automations`,
  //     `automationLogs`, `automationPendingExecutions`, `flows`, and
  //     `flowRuns` — but NOT to `automationSteps`, `flowNodes`, or
  //     `flowRunEvents` in Postgres, which stayed tenant-scoped only
  //     transitively via their parent FK (same pattern as
  //     `pipelineStages`/`contactCustomValues` in Task 1). The Phase 1
  //     final review denormalizes `accountId` onto all five of those
  //     tables in Convex anyway (see each table below), matching the
  //     direct-index treatment already given to `messages`/`contactTags`/
  //     `broadcastRecipients`. Migration 017 also swapped `flowRuns`'s
  //     "one active run per contact" partial unique index from
  //     `(user_id, contact_id)` to `(account_id, contact_id)`.
  //   - Migration 016 widened `flow_nodes.node_type`'s CHECK to add
  //     `'send_media'` — this task's own tricky-notes list enumerates
  //     only 10 of the resulting 11 values; the 11th (`send_media`)
  //     only turns up by actually reading migration 016, which is why
  //     it's included in the union below.
  // Every `user_id` FK to auth.users on these tables stays audit/
  // assignment metadata post-017 (migration 017's own header: "no
  // longer used for tenancy isolation") — mapped to `createdByUserId`
  // like every other bare `user_id` column in this file.
  // ============================================================

  // The definition envelope for one automation ("when X happens, do
  // Y"). `triggerType` stays a plain string, not a union: unlike
  // `flows.triggerType` below, Postgres never put a CHECK on this
  // column (the closed `AutomationTriggerType` set in
  // src/types/index.ts is enforced only at the app layer) — same
  // reasoning Task 1 used for `customFields.fieldType`. `updatedAt` is
  // new: Postgres maintains it with an on-UPDATE trigger (Convex has
  // none), but the app reads it (`select('*')` plus the
  // `Automation.updated_at` type) the same way `flows.updatedAt`
  // below is both read and explicitly written by the flow-edit route,
  // so it's modeled here too rather than silently dropped.
  automations: defineTable({
    accountId: v.id("accounts"),
    createdByUserId: v.optional(v.id("users")),
    name: v.string(),
    description: v.optional(v.string()),
    triggerType: v.string(),
    triggerConfig: v.optional(v.any()),
    isActive: v.boolean(),
    executionCount: v.number(),
    lastExecutedAt: v.optional(v.number()),
    updatedAt: v.optional(v.number()),
  }).index("by_account", ["accountId"]),

  // One node in an automation's step tree. `parentStepId`/`branch` are
  // both unset for root-level steps; a Condition step's 'yes'/'no'
  // children set both. `stepType` has no DB-level CHECK in Postgres
  // (unlike `flowNodes.nodeType` below) but the brief calls for a
  // union anyway — cross-checked against the exhaustive `switch
  // (step.step_type)` in src/lib/automations/engine.ts (13 cases) and
  // the `AutomationStepType` closed set in src/types/index.ts; both
  // agree on exactly these 13 values, so there's no hidden 14th like
  // `flowNodes.nodeType` had with `send_media`.
  automationSteps: defineTable({
    // Denormalized off `automationId` (P1 review) — see the section
    // header comment above for why Postgres never had this column.
    accountId: v.id("accounts"),
    automationId: v.id("automations"),
    parentStepId: v.optional(v.id("automationSteps")),
    branch: v.optional(v.union(v.literal("yes"), v.literal("no"))),
    stepType: v.union(
      v.literal("send_message"),
      v.literal("send_buttons"),
      v.literal("send_list"),
      v.literal("send_template"),
      v.literal("add_tag"),
      v.literal("remove_tag"),
      v.literal("assign_conversation"),
      v.literal("update_contact_field"),
      v.literal("create_deal"),
      v.literal("wait"),
      v.literal("condition"),
      v.literal("send_webhook"),
      v.literal("close_conversation"),
    ),
    stepConfig: v.optional(v.any()),
    position: v.number(),
  })
    .index("by_automation", ["automationId"])
    .index("by_account", ["accountId"]),

  // An audit row written once per automation execution (one per
  // triggering event, not per step — `stepsExecuted` is the per-step
  // detail array). `contactId` is nullable / ON DELETE SET NULL so
  // history survives contact deletion (mirrors migration 004's
  // pattern Task 1 already used for `deals.contactId`).
  automationLogs: defineTable({
    accountId: v.id("accounts"),
    createdByUserId: v.optional(v.id("users")),
    automationId: v.id("automations"),
    contactId: v.optional(v.id("contacts")),
    triggerEvent: v.string(),
    stepsExecuted: v.optional(v.any()),
    status: v.union(
      v.literal("success"),
      v.literal("partial"),
      v.literal("failed"),
    ),
    errorMessage: v.optional(v.string()),
  })
    .index("by_account", ["accountId"])
    // `logs` (filtered by automation) and `remove`'s cascade both want one
    // automation's rows. On `by_account` alone that is a scan of the
    // account's ENTIRE log history with an `automationId` `.filter()`
    // applied afterwards — and a Convex `.filter()` does not narrow what is
    // read. This table grows with every automation execution, so it is the
    // fastest-growing per-account table once automations see real use.
    // Keeping `accountId` as the prefix leaves tenancy enforced by the index
    // itself rather than by a post-scan predicate, so a foreign
    // `automationId` still yields nothing.
    .index("by_account_automation", ["accountId", "automationId"]),

  // A queued resume point created when a running automation hits a
  // `wait` step. The cron endpoint (`/api/automations/cron`) drains
  // rows where `status === "pending"` and `runAt <= now`, via the
  // `by_status_runat` index below — this is the row this Phase 1 plan
  // explicitly foreshadows for `ctx.scheduler` in a later
  // function-phase. `runAt` is `NOT NULL` with no default in Postgres
  // (the engine always supplies it when scheduling the wait), so
  // unlike most other domain timestamps in this file it's a required
  // `v.number()`, not optional — same treatment Task 2 gave
  // `accountInvitations.expiresAt`.
  automationPendingExecutions: defineTable({
    accountId: v.id("accounts"),
    createdByUserId: v.optional(v.id("users")),
    automationId: v.id("automations"),
    contactId: v.optional(v.id("contacts")),
    logId: v.optional(v.id("automationLogs")),
    parentStepId: v.optional(v.id("automationSteps")),
    branch: v.optional(v.union(v.literal("yes"), v.literal("no"))),
    nextStepPosition: v.number(),
    context: v.optional(v.any()),
    status: v.union(
      v.literal("pending"),
      v.literal("running"),
      v.literal("done"),
      v.literal("failed"),
    ),
    runAt: v.number(),
  })
    .index("by_account", ["accountId"])
    .index("by_status_runat", ["status", "runAt"]),

  // The definition envelope for one conversational flow (bot). Mirrors
  // `automations` above but for the graph-based engine. `entryNodeId`
  // references `flowNodes.nodeKey` (a stable string the migration's
  // own comment calls out as deliberately NOT the row's UUID — see
  // `flowNodes` below), so it stays `v.optional(v.string())`, never a
  // `v.id(...)`. `updatedAt`: same reasoning as `automations` above,
  // except here there's direct proof the app writes it by hand —
  // `src/app/api/flows/[id]/route.ts`'s PATCH handler sets
  // `updated_at: new Date().toISOString()` itself rather than relying
  // solely on the (Convex-less) DB trigger.
  flows: defineTable({
    accountId: v.id("accounts"),
    createdByUserId: v.optional(v.id("users")),
    name: v.string(),
    description: v.optional(v.string()),
    status: v.union(
      v.literal("draft"),
      v.literal("active"),
      v.literal("archived"),
    ),
    triggerType: v.union(
      v.literal("keyword"),
      v.literal("first_inbound_message"),
      v.literal("manual"),
    ),
    triggerConfig: v.optional(v.any()),
    entryNodeId: v.optional(v.string()),
    fallbackPolicy: v.optional(v.any()),
    executionCount: v.number(),
    lastExecutedAt: v.optional(v.number()),
    updatedAt: v.optional(v.number()),
  }).index("by_account", ["accountId"]),

  // One node in a flow's graph. Edges live inside `config` (e.g. each
  // button carries its own next-node key) rather than a separate edge
  // table — see migration 010's header for why. `nodeKey` is a stable
  // string, not the row id, so edges/`entryNodeId` survive a clone
  // without UUID rewriting. `nodeType`'s union has 11 values, not the
  // 10 this task's tricky-notes list literally enumerates: migration
  // 016 (named in this task's source list) widened the CHECK to add
  // `'send_media'` after 010 shipped the original 10 — caught by
  // reading 016 directly rather than trusting the summarized list.
  // `positionX`/`positionY` are reserved for the not-yet-built v2
  // react-flow canvas (migration 010's own comment); the v1 list
  // editor always writes 0.
  flowNodes: defineTable({
    // Denormalized off `flowId` (P1 review) — see the section header
    // comment above for why Postgres never had this column.
    accountId: v.id("accounts"),
    flowId: v.id("flows"),
    nodeKey: v.string(),
    nodeType: v.union(
      v.literal("start"),
      v.literal("send_buttons"),
      v.literal("send_list"),
      v.literal("send_message"),
      v.literal("send_media"),
      v.literal("collect_input"),
      v.literal("condition"),
      v.literal("set_tag"),
      v.literal("handoff"),
      v.literal("http_fetch"),
      v.literal("end"),
    ),
    config: v.optional(v.any()),
    positionX: v.number(),
    positionY: v.number(),
  })
    .index("by_flow_node_key", ["flowId", "nodeKey"])
    .index("by_account", ["accountId"]),

  // Per-contact runtime state machine for a flow. Postgres's
  // `started_at` (`NOT NULL DEFAULT NOW()`, never subsequently
  // updated) is deliberately NOT modeled as its own field — it's set
  // at the same instant the row is created and nothing ever changes
  // it, so it's exactly what `_creationTime` already gives for free
  // (the same "don't duplicate created_at" reasoning the Global
  // Constraints spell out, just under a different column name).
  // `lastAdvancedAt` IS modeled: unlike `startedAt` it's genuinely
  // mutated every time the runner advances the state machine, and the
  // cron sweep (`idx_flow_runs_active_advanced`) queries it directly.
  // `contactId`/`conversationId` are nullable / ON DELETE SET NULL so
  // history survives contact deletion (same pattern as
  // `automationLogs.contactId` above). The "one active run per
  // account+contact" partial UNIQUE from migration 017 (originally
  // per-user from 010) becomes the plain `by_account_contact` index —
  // Convex has no partial indexes, so the actual one-active-run
  // invariant is enforced in the future engine mutation, not the
  // schema (same deferral the brief calls out).
  flowRuns: defineTable({
    accountId: v.id("accounts"),
    createdByUserId: v.optional(v.id("users")),
    flowId: v.id("flows"),
    contactId: v.optional(v.id("contacts")),
    conversationId: v.optional(v.id("conversations")),
    status: v.union(
      v.literal("active"),
      v.literal("completed"),
      v.literal("handed_off"),
      v.literal("timed_out"),
      v.literal("paused_by_agent"),
      v.literal("failed"),
    ),
    currentNodeKey: v.optional(v.string()),
    lastPromptMessageId: v.optional(v.id("messages")),
    vars: v.optional(v.any()),
    repromptCount: v.number(),
    lastAdvancedAt: v.optional(v.number()),
    endedAt: v.optional(v.number()),
    endReason: v.optional(v.string()),
    // Phase 6, Task 4 addition — no Postgres counterpart (the original
    // stale-run cutoff was computed on the fly by a cron sweep,
    // `/api/flows/cron`, comparing `last_advanced_at` against
    // `fallback_policy.on_timeout_hours` on every poll). The Convex
    // engine has no cron: each active run instead gets its OWN
    // `ctx.scheduler.runAfter(...)` callback (`flowsEngine.timeout`)
    // scheduled directly, and this field is the id of that pending
    // scheduled function — needed so the engine can `ctx.scheduler.cancel`
    // the stale one before scheduling a fresh one on every genuine
    // advance (otherwise a customer who replies quickly would still get
    // timed out later by the ORIGINAL schedule). Cleared (patched to
    // `undefined`) whenever the run ends for any reason.
    fallbackTimeoutId: v.optional(v.id("_scheduled_functions")),
  })
    .index("by_account_contact", ["accountId", "contactId"])
    .index("by_flow", ["flowId"])
    .index("by_status", ["status"]),

  // Append-only audit trail for a flow run — used by the runner for
  // idempotency (never advance twice on the same inbound message) and
  // the future run-history viewer. `eventType`'s 9-value union comes
  // straight off the CHECK in migration 010; no later migration alters
  // it (unlike `flowNodes.nodeType`).
  flowRunEvents: defineTable({
    // Denormalized off `flowRunId` (P1 review) — see the section header
    // comment above for why Postgres never had this column.
    accountId: v.id("accounts"),
    flowRunId: v.id("flowRuns"),
    eventType: v.union(
      v.literal("started"),
      v.literal("node_entered"),
      v.literal("message_sent"),
      v.literal("reply_received"),
      v.literal("fallback_fired"),
      v.literal("handoff"),
      v.literal("timeout"),
      v.literal("error"),
      v.literal("completed"),
    ),
    nodeKey: v.optional(v.string()),
    payload: v.optional(v.any()),
  })
    .index("by_run", ["flowRunId"])
    .index("by_account", ["accountId"]),

  // ============================================================
  // AI (Phase 1, Task 4 — final schema task). Source: supabase/migrations
  // 029_ai_reply.sql (ai_configs create), 030_ai_knowledge.sql
  // (ai_knowledge_documents + ai_knowledge_chunks create, plus
  // ai_configs.embeddings_api_key), 031_ai_reply_slot_grant.sql (GRANT
  // only — no schema change), 032_fix_ai_knowledge_membership.sql
  // (SECURITY DEFINER -> INVOKER on the two match_ai_knowledge_* RPCs
  // only — no schema change), 033_ai_reply_polish.sql
  // (ai_configs.handoff_agent_id, ai_usage_log create; also
  // messages.aiGenerated/conversations.aiHandoffSummary+aiAutoreply
  // Disabled+aiReplyCount, which land on Task 1's tables and are already
  // in schema.ts from that task, not repeated here). All four tables
  // were swept across every migration (grep "ALTER TABLE
  // ai_configs|ai_usage_log|ai_knowledge_documents|ai_knowledge_chunks")
  // per Tasks 1-3's own precedent — beyond `ENABLE ROW LEVEL SECURITY`,
  // the only real hits were the two `ai_configs` column adds (030, 033)
  // already folded in below.
  // ============================================================

  // The account's AI reply assistant setup (bring-your-own-key), one row
  // per account. UNIQUE(account_id) in Postgres -> `by_account` doubles
  // as the enforcing index (same treatment as `whatsappConfig` in Task
  // 2). `apiKey`/`embeddingsApiKey` are AES-256-GCM-encrypted ciphertext
  // at rest, encrypted inline by this table's own `upsert` mutation
  // (the same `encrypt()`/`decrypt()` helper `whatsappConfig.accessToken`
  // now also uses), so they stay plain `v.string()`/optional rather
  // than a structured type.
  // `autoReplyMaxPerConversation`'s Postgres CHECK (BETWEEN 1 AND 20)
  // has no Convex equivalent — enforced in the future settings mutation
  // instead. `updatedAt` WAS deliberately left unmodeled in the original
  // Task 4 pass (no route or component selected/ordered by it — checked
  // src/lib/ai/config.ts, src/app/api/ai/config/route.ts,
  // src/components/settings/ai-config.tsx). The Phase 1 final review
  // overrides that: every table with a Postgres on-UPDATE trigger now
  // gets `updatedAt` in Convex for uniform parity, so it's added below
  // alongside `whatsappConfig`/`quickReplies`/etc.
  aiConfigs: defineTable({
    accountId: v.id("accounts"),
    createdByUserId: v.optional(v.id("users")),
    provider: v.union(v.literal("openai"), v.literal("anthropic")),
    model: v.string(),
    apiKey: v.string(), // AES-256-GCM-encrypted BYO provider key
    systemPrompt: v.optional(v.string()),
    isActive: v.boolean(),
    autoReplyEnabled: v.boolean(),
    // DEPRECATED (owner decision 2026-07-18): there is NO reply cap —
    // the bot answers every message until a human takes the chat from
    // the dashboard. Optional so existing rows stay valid; nothing
    // reads it anymore.
    autoReplyMaxPerConversation: v.optional(v.number()),
    // Migration 030: optional OpenAI-compatible embeddings key —
    // encrypted like `apiKey`; its presence turns on semantic KB
    // retrieval (else lexical-only).
    embeddingsApiKey: v.optional(v.string()),
    // Migration 033: where auto-reply hands a conversation off when the
    // model bails. Unset/null leaves it unassigned (shared queue).
    handoffAgentId: v.optional(v.id("users")),
    updatedAt: v.optional(v.number()),
  }).index("by_account", ["accountId"]),

  // Append-only per-LLM-call token usage log (cost visibility on the
  // account's BYO key). Source: migration 033. `conversationId` is
  // nullable — Postgres: `REFERENCES conversations(id) ON DELETE SET
  // NULL` — a draft not tied to one thread, or the conversation was
  // deleted between generation and logging (src/lib/ai/usage.ts's own
  // `LogAiUsageArgs.conversationId` comment). Dashboard reads are
  // "by account, newest-first" (Postgres's own composite index was
  // `(account_id, created_at DESC)`) — here that's `by_account` plus the
  // default `_creationTime` ordering, per the Global Constraints' "rely
  // on _creationTime" rule. Token counters are `v.number()`, not
  // optional: NOT NULL DEFAULT 0 in Postgres and every insert supplies a
  // real value (same treatment as `broadcasts`'s counters in Task 2).
  aiUsageLog: defineTable({
    accountId: v.id("accounts"),
    conversationId: v.optional(v.id("conversations")),
    mode: v.union(
      v.literal("auto_reply"),
      v.literal("draft"),
      v.literal("classify"),
      v.literal("qualify"),
      v.literal("checklist"),
    ),
    provider: v.union(v.literal("openai"), v.literal("anthropic")),
    model: v.string(),
    promptTokens: v.number(),
    completionTokens: v.number(),
    totalTokens: v.number(),
  }).index("by_account", ["accountId"]),

  // One knowledge-base entry (title + body text) an account pastes in
  // to ground the AI assistant's drafts/auto-replies. Source: migration
  // 030. `updatedAt` IS modeled here (unlike `aiConfigs` above): the
  // list/detail routes actually select + `order by` it
  // (src/app/api/ai/knowledge/route.ts and .../[id]/route.ts) and the
  // settings component types it as an always-present field.
  aiKnowledgeDocuments: defineTable({
    accountId: v.id("accounts"),
    createdByUserId: v.optional(v.id("users")),
    title: v.string(),
    content: v.string(),
    updatedAt: v.optional(v.number()),
  }).index("by_account", ["accountId"]),

  // A retrieval unit chunked from one `aiKnowledgeDocuments` row.
  // `accountId` is denormalized off the document exactly as Postgres
  // denormalized it ("so the match RPCs and RLS filter without a
  // join") — the same reasoning Task 1 gave `messages.accountId`.
  // `chunkIndex` is `v.number()`, not optional (NOT NULL DEFAULT 0,
  // every insert supplies a real index — same treatment as
  // `aiUsageLog`'s counters above).
  //
  // Two Postgres constructs have no direct Convex equivalent:
  //   - The generated `fts tsvector GENERATED ALWAYS AS
  //     (to_tsvector('simple', content)) STORED` column is DROPPED
  //     entirely per the Global Constraints ("Generated columns: omit
  //     them... use a `.searchIndex` on `content` instead") — replaced
  //     by the `search_content` search index below, which will back a
  //     `ctx.db.query(...).withSearchIndex(...)` in this table's own
  //     function-phase (replacing the `match_ai_knowledge_fts` RPC).
  //   - The pgvector `embedding vector(1536)` column becomes an
  //     optional float array + the `by_embedding` vector index below,
  //     replacing the `match_ai_knowledge_semantic` RPC (migrations 030
  //     + 032 — 032 only changed the RPCs' SECURITY mode, not the
  //     table). `embedding` stays optional: a chunk only gets one when
  //     the account has an embeddings key configured (lexical-only
  //     accounts leave every chunk's embedding unset, same as Postgres
  //     leaving it NULL).
  // Both new indexes only fully validate on `convex dev`'s deploy step
  // (not this task's offline `vitest`/`tsc` pass) — see the task report.
  aiKnowledgeChunks: defineTable({
    documentId: v.id("aiKnowledgeDocuments"),
    accountId: v.id("accounts"),
    chunkIndex: v.number(),
    content: v.string(),
    embedding: v.optional(v.array(v.float64())),
  })
    .index("by_document", ["documentId"])
    .index("by_account", ["accountId"])
    .searchIndex("search_content", {
      searchField: "content",
      filterFields: ["accountId"],
    })
    .vectorIndex("by_embedding", {
      vectorField: "embedding",
      dimensions: 1536,
      filterFields: ["accountId"],
    }),

  // One AI classification of a conversation into the account's tag
  // catalogue. `suggestedTagIds` is group-generic (a flat validated list
  // across all tag groups — respects each group's single/multi mode);
  // the UI renders it grouped. `status` tracks the review lifecycle.
  tagSuggestions: defineTable({
    accountId: v.id("accounts"),
    conversationId: v.id("conversations"),
    contactId: v.id("contacts"),
    suggestedTagIds: v.array(v.id("tags")),
    note: v.optional(v.string()),
    confidence: v.union(v.literal("high"), v.literal("medium"), v.literal("low")),
    status: v.union(
      v.literal("auto_applied"),
      v.literal("pending"),
      v.literal("accepted"),
      v.literal("dismissed"),
    ),
    model: v.string(),
    reviewedByUserId: v.optional(v.id("users")),
  })
    .index("by_account_status", ["accountId", "status"])
    .index("by_conversation", ["conversationId"]),

  // Ownership record tying a client-uploaded Convex storage object to the
  // account that minted it. Convex `_storage` carries no `accountId` of
  // its own — a storage id, once minted, resolves for anyone holding it —
  // so this table is the ONLY place a storage id is bound to a tenant.
  // `files.getUrl`/`files.remove` consult it (via `by_storage`) so one
  // account can't resolve or delete another's uploads;
  // `files.registerUpload` writes the row right after the client-upload
  // POST hands back a storage id. `by_account` follows the section
  // convention (every account-scoped table carries an accountId index)
  // and supports future per-account storage GC.
  fileOwners: defineTable({
    accountId: v.id("accounts"),
    storageId: v.id("_storage"),
  })
    .index("by_storage", ["storageId"])
    .index("by_account", ["accountId"]),

  // ============================================================
  // WA conversion attribution (Task B3). One row per detected
  // attribution identifier (an `HY-XXXXXX` ref code or a Meta
  // `ctwa_clid`) seen on an inbound WhatsApp message — written by
  // `attribution.recordSignal` and later updated by the outbound
  // partner-signal action as it lands. `by_account_identifier` backs
  // `recordSignal`'s own idempotent first-occurrence-only insert (one
  // row per account+identifier, ever); `by_account_result` supports a
  // future dashboard filtering by landing outcome; `by_result` (Task
  // B6) is the GLOBAL (non-account-scoped) counterpart that backs the
  // retry cron's `getPendingToRetry` — it has no account context, so it
  // needs a `landingResult`-only index to find retry candidates across
  // every account without a full table scan.
  // ============================================================
  attributionSignals: defineTable({
    accountId: v.id("accounts"),
    identifier: v.string(), // the HY-code (uppercased) OR the ctwa_clid
    lane: v.union(v.literal("code"), v.literal("ctwa")),
    phone: v.string(), // sender phone as supplied by the caller (E.164 in prod; stored verbatim)
    waMessageId: v.string(),
    contactId: v.id("contacts"),
    conversationId: v.id("conversations"),
    firstMessageAt: v.number(),
    landingResult: v.union(
      v.literal("pending"),
      v.literal("matched"),
      v.literal("unmatched"),
      v.literal("error"),
      // Terminal give-up state: a row whose retries hit `attempts` ==
      // `MAX_ATTEMPTS` is retired here (by `attribution.patchResult`) so
      // it leaves the `"error"` partition the retry cron's
      // `getPendingToRetry` scans — see that function's own comment.
      v.literal("abandoned"),
    ),
    offerSlug: v.optional(v.string()),
    firedAt: v.optional(v.number()),
    attempts: v.number(),
  })
    .index("by_account_identifier", ["accountId", "identifier"])
    // Reserved wamid lookup/dedup/debug index — not queried by the
    // B-tasks yet (mirrors the existing `broadcastRecipients.by_wamid`
    // precedent above).
    .index("by_wamid", ["waMessageId"])
    .index("by_account_result", ["accountId", "landingResult"])
    .index("by_result", ["landingResult"]),

  // ============================================================
  // Unified conversion outbox (funnel Phase 1). One row per
  // (conversation, stage) that maps to a Meta event. `backend`
  // discriminates delivery: "platformA" (website/code lane → web Pixel via
  // go-holidayys) or "capi" (ad/ctwa lane → direct Meta CAPI). `eventId`
  // (= `${conversationId}:${stage}`) is our dedup key — Meta does not dedupe
  // business-messaging events. Dormant rows stay `pending` (no attempt bump)
  // until env is configured; the retry cron resends them.
  // ============================================================
  conversionEvents: defineTable({
    accountId: v.id("accounts"),
    conversationId: v.id("conversations"),
    contactId: v.id("contacts"),
    stage: v.union(
      v.literal("new_lead"),
      v.literal("qualified"),
      v.literal("price_quoted"),
      v.literal("itinerary_created"),
      v.literal("itinerary_sent"),
      v.literal("invoice_sent"),
      v.literal("purchased"),
    ),
    lane: v.union(v.literal("code"), v.literal("ctwa")),
    backend: v.union(v.literal("platformA"), v.literal("capi")),
    eventName: v.string(), // resolved per lane (web-pixel name | business_messaging name)
    identifier: v.string(), // HY-code (code lane) | ctwa_clid (ctwa lane)
    value: v.optional(v.number()),
    currency: v.optional(v.string()),
    phone: v.string(),
    waMessageId: v.string(),
    firstMessageAt: v.number(),
    eventId: v.string(), // `${conversationId}:${stage}` — dedup
    status: v.union(
      v.literal("pending"),
      v.literal("sent"),
      v.literal("unmatched"),
      v.literal("error"),
      v.literal("abandoned"),
    ),
    attempts: v.number(),
    lastError: v.optional(v.string()),
    sentAt: v.optional(v.number()),
    fbTraceId: v.optional(v.string()),
    matchResult: v.optional(v.string()),
  })
    .index("by_conversation", ["conversationId"])
    .index("by_event_id", ["eventId"])
    .index("by_status", ["status"])
    // Account-scoped, `_creationTime`-ordered scan for the funnel-analytics
    // rollup (campaigns.overview), window-bounded via `.gte("_creationTime")`.
    .index("by_account", ["accountId"]),

  // Append-only funnel progress log (funnel Phase 2). One row per stage
  // ENTERED, for every conversation (incl. organic and the internal
  // `itinerary_created` stage). Powers the stepper (Phase 3) + funnel
  // analytics (Phase 4). Links to the fired `conversionEvents` row when one
  // was seeded. `auto` = the ingest-seeded first-touch (Phase 1 seeds the
  // new_lead conversionEvent; a matching `auto` transition may be backfilled
  // later — this phase writes only agent-driven `auto:false` rows).
  funnelTransitions: defineTable({
    accountId: v.id("accounts"),
    conversationId: v.id("conversations"),
    contactId: v.id("contacts"),
    stage: v.union(
      v.literal("new_lead"),
      v.literal("qualified"),
      v.literal("price_quoted"),
      v.literal("itinerary_created"),
      v.literal("itinerary_sent"),
      v.literal("invoice_sent"),
      v.literal("purchased"),
      v.literal("lost"),
    ),
    byUserId: v.optional(v.id("users")),
    auto: v.boolean(),
    conversionEventId: v.optional(v.id("conversionEvents")),
    // Set only on `lost` transitions — the exact why, for the audit trail
    // and downstream AI analysis (category from a fixed list + free text).
    lossCategory: v.optional(v.string()),
    lossDetail: v.optional(v.string()),
  })
    .index("by_conversation", ["conversationId"])
    // Account-scoped, `_creationTime`-ordered scan for the funnel-analytics
    // rollup (campaigns.overview), window-bounded via `.gte("_creationTime")`.
    .index("by_account", ["accountId"]),

  // ============================================================
  // CTWA ad-capture (funnel Phase 0). Raw event log: one row per
  // inbound message carrying a `referral`. `_creationTime` is the
  // received-at (codebase "rely on _creationTime" convention).
  // `ctwaClid` is the durable per-conversation ad-click id the funnel's
  // ad lane reads later. Distinct from the `conversation.adReferral`
  // display denorm (set once, for the inbox ad-preview card).
  // ============================================================
  adReferrals: defineTable({
    accountId: v.id("accounts"),
    contactId: v.id("contacts"),
    conversationId: v.id("conversations"),
    waMessageId: v.string(),
    ctwaClid: v.optional(v.string()), // omitted for Status placements
    adId: v.optional(v.string()), // referral.source_id = Meta ad id
    sourceType: v.optional(v.string()), // "ad" — resolution guards on this
    sourceUrl: v.optional(v.string()),
    headline: v.optional(v.string()),
    body: v.optional(v.string()),
    mediaType: v.optional(v.string()),
    isFirstTouch: v.boolean(), // contact's first-ever ad referral
  })
    .index("by_account", ["accountId"])
    .index("by_account_ad", ["accountId", "adId"])
    .index("by_contact", ["contactId"])
    .index("by_wamid", ["waMessageId"]),

  // Resolution cache: one row per (account, adId). Names change rarely.
  // Written `pending` at capture; resolved via Marketing API in `resolveAd`.
  campaignAds: defineTable({
    accountId: v.id("accounts"),
    adId: v.string(),
    adName: v.optional(v.string()),
    adSetId: v.optional(v.string()),
    adSetName: v.optional(v.string()),
    campaignId: v.optional(v.string()),
    campaignName: v.optional(v.string()),
    // "abandoned" is terminal: the give-up state for a row that exhausted
    // MAX_RESOLVE_ATTEMPTS. It exists so dead rows LEAVE the "error"
    // partition — `getResolvable` reads that partition through `by_status`
    // and `.filter()`s on `attempts`, and a Convex `.filter()` does not
    // narrow what is read. Rows that gave up while still tagged "error"
    // would accumulate there forever, matching nothing, growing the cron's
    // scan without bound. Mirrors conversionEvents.status and
    // attributionSignals.landingResult, which retire the same way.
    resolveStatus: v.union(
      v.literal("pending"),
      v.literal("resolved"),
      v.literal("error"),
      v.literal("abandoned"),
    ),
    attempts: v.number(),
    lastError: v.optional(v.string()),
    resolvedAt: v.optional(v.number()),
  })
    .index("by_account_ad", ["accountId", "adId"])
    .index("by_account", ["accountId"])
    .index("by_status", ["resolveStatus"]),

  // ============================================================
  // Lead qualification (spec: docs/superpowers/specs/
  // 2026-07-18-lead-qualification-followup-design.md §5). Per-account
  // config, one row (mirrors `aiConfigs` — `by_account` doubles as the
  // enforcing unique index). DORMANT until `enabled`: every engine hook
  // gates on it, so deploying this schema changes nothing user-visible.
  // Working hours are ACCOUNT-LOCAL minutes-of-day against a FIXED UTC
  // offset (Gulf/India have no DST; pure arithmetic, unit-testable) —
  // `timezoneLabel` is display-only. `basicFields` is the fallback
  // question set for off-topic inquiries; per-service questions live in
  // the AI knowledge-base docs (QUALIFICATION CHECKLIST sections), not
  // here. `adminAlertPhones` also drives the engine's loop guard (no
  // sessions/AI on the alert channel itself).
  // ============================================================
  qualificationConfigs: defineTable({
    accountId: v.id("accounts"),
    enabled: v.boolean(),
    basicFields: v.array(v.object({
      key: v.string(),
      label: v.string(),
      required: v.boolean(),
      phrasings: v.array(v.string()),
    })),
    qualifyThresholdScore: v.number(),
    timezoneLabel: v.string(),
    utcOffsetMinutes: v.number(),
    workStartMinute: v.number(),
    workEndMinute: v.number(),
    workDays: v.array(v.number()),
    followUpDelaysMinutes: v.array(v.number()),
    maxFollowUps: v.number(),
    sessionWindowHours: v.number(),
    reengagementTemplateName: v.optional(v.string()),
    reengagementTemplateLanguage: v.optional(v.string()),
    closingMessage: v.string(),
    adminAlertEnabled: v.boolean(),
    adminAlertPhones: v.array(v.string()),
    adminAlertTemplateName: v.optional(v.string()),
    adminAlertTemplateLanguage: v.optional(v.string()),
    // Phase 6 — consent-based auto-assignment + staff keepalive.
    autoAssignEnabled: v.optional(v.boolean()),      // default true
    offerTimeoutMinutes: v.optional(v.number()),     // default 10
    staffCheckinTemplateName: v.optional(v.string()),
    staffCheckinTemplateLanguage: v.optional(v.string()),
    outboundNudgesEnabled: v.boolean(),
    updatedAt: v.optional(v.number()),
  }).index("by_account", ["accountId"]),

  // ============================================================
  // Admin Q&A relay (qualification v3): when the assistant lacks an
  // answer it tells the customer "let me check with my team", records
  // the question here, and WhatsApps it to the admin numbers as a plain
  // message (the admin channel's window never closes — owner-stated
  // operating assumption). The admin's next reply answers the LATEST
  // pending inquiry and is relayed back to the customer by the
  // assistant. `delivered` = the answer reached the customer chat.
  // ============================================================
  adminInquiries: defineTable({
    accountId: v.id("accounts"),
    conversationId: v.id("conversations"), // the CUSTOMER thread
    contactId: v.id("contacts"),
    question: v.string(),
    customerName: v.string(),
    customerPhone: v.string(),
    status: v.union(
      v.literal("pending"),
      v.literal("answered"),
      v.literal("delivered"),
      v.literal("expired"),
    ),
    answer: v.optional(v.string()),
    askedAt: v.number(),
    answeredAt: v.optional(v.number()),
  })
    .index("by_account_status", ["accountId", "status"])
    .index("by_conversation", ["conversationId"]),

  // ============================================================
  // Phase 6 — agent orchestration over WhatsApp.
  // ============================================================

  // One consent-based lead offer to one agent. The offer engine walks
  // eligible agents (memberTags ∩ the lead's service tag, fewest recent
  // accepts first): offered → accepted (assign + announce + contact
  // card) | declined | timed_out (10 min default → next agent) |
  // cancelled (someone assigned manually meanwhile). Accepted offers
  // also carry the feedback-reminder state for the assigned lead.
  leadOffers: defineTable({
    accountId: v.id("accounts"),
    sessionId: v.id("qualificationSessions"),
    conversationId: v.id("conversations"), // the CUSTOMER thread
    contactId: v.id("contacts"),
    agentUserId: v.id("users"),
    agentPhone: v.string(),
    status: v.union(
      v.literal("offered"),
      v.literal("accepted"),
      v.literal("declined"),
      v.literal("timed_out"),
      v.literal("cancelled"),
    ),
    offeredAt: v.number(),
    respondedAt: v.optional(v.number()),
    // Feedback loop (accepted offers only)
    feedback: v.optional(v.string()),
    feedbackAt: v.optional(v.number()),
    lastReminderAt: v.optional(v.number()),
    remindersSent: v.optional(v.number()),
    escalatedAt: v.optional(v.number()),
  })
    .index("by_session", ["sessionId"])
    .index("by_account_status", ["accountId", "status"])
    .index("by_agent_status", ["agentUserId", "status"])
    .index("by_status_offered", ["status", "offeredAt"]),

  // Service routing: which members can work which service tag. One row
  // per (member, tag) link; the Settings → Services card manages them.
  memberTags: defineTable({
    accountId: v.id("accounts"),
    userId: v.id("users"),
    tagId: v.id("tags"),
  })
    .index("by_account", ["accountId"])
    .index("by_user", ["userId"])
    .index("by_account_tag", ["accountId", "tagId"]),

  // Staff window keepalive state, one row per staff phone (admin alert
  // numbers + member numbers). Tracks when we last nudged so the daily
  // check-in never spams.
  staffCheckins: defineTable({
    accountId: v.id("accounts"),
    phoneNormalized: v.string(),
    lastCheckinSentAt: v.number(),
  }).index("by_account_phone", ["accountId", "phoneNormalized"]),

  // One qualification session per conversation — this row IS the lead
  // the sales team works from (spec §5; no separate leads table).
  // `by_conversation` doubles as the 1:1 enforcing index (ensureSession
  // is the only insert path). Keys in `fields` are DYNAMIC — whatever
  // the matched service doc's checklist asks — so `key` is a plain
  // string, not a union. `score`/`scoreBreakdown` are the analysis
  // engine's marks (P1); `pendingQuestion` is the LLM-prewritten next
  // ask the follow-up cron rotates through WITHOUT its own LLM call
  // (P3); `by_due` partitions the cron sweep (status = "collecting",
  // nextFollowUpAt <= now), mirroring conversionEvents.by_status.
  qualificationSessions: defineTable({
    accountId: v.id("accounts"),
    conversationId: v.id("conversations"),
    contactId: v.id("contacts"),
    status: v.union(
      v.literal("collecting"),
      v.literal("qualified"),
      v.literal("expired"),
      v.literal("opted_out"),
      v.literal("disqualified"),
    ),
    origin: v.union(v.literal("inbound"), v.literal("outbound")),
    serviceName: v.optional(v.string()),
    fields: v.array(v.object({
      key: v.string(),
      label: v.optional(v.string()),
      value: v.string(),
      confidence: v.union(v.literal("high"), v.literal("medium"), v.literal("low")),
      updatedAt: v.number(),
      // v3 multi-lead: true when this value was carried over from the
      // contact's previous session — the assistant reconfirms it
      // casually instead of re-asking (or treating it as brand new).
      carried: v.optional(v.boolean()),
    })),
    score: v.optional(v.number()),
    scoreBreakdown: v.optional(v.array(v.object({
      criterion: v.string(),
      marks: v.number(),
      maxMarks: v.number(),
      reason: v.optional(v.string()),
    }))),
    expectedCount: v.number(),
    answeredCount: v.number(),
    // Readiness marker (P1): stamped when the doc checklist is satisfied
    // AND score >= threshold AND >= 3 answers. P2's completion pipeline
    // consumes it; status flips to "qualified" only there, so a P1-only
    // build never half-completes a lead.
    checklistSatisfiedAt: v.optional(v.number()),
    pendingQuestion: v.optional(v.object({
      key: v.string(),
      text: v.string(),
      alternates: v.array(v.string()),
    })),
    lastCustomerMessageAt: v.optional(v.number()),
    humanTouchedAt: v.optional(v.number()),
    followUpsSent: v.number(),
    phrasingCursor: v.number(),
    nextFollowUpAt: v.optional(v.number()),
    sendAttemptErrors: v.number(),
    qualifiedAt: v.optional(v.number()),
    closedReason: v.optional(v.string()),
    summary: v.optional(v.string()),
  })
    .index("by_conversation", ["conversationId"])
    .index("by_account_status", ["accountId", "status"])
    .index("by_due", ["status", "nextFollowUpAt"]),

  // The post-qualification sales checklist — one row per qualification
  // session (the session IS the lead), posted automatically when the lead
  // qualifies. Items come from the knowledge base's `SALES CHECKLIST`
  // section via the account's LLM when available, else the built-in
  // 6-step default — so every qualified lead ALWAYS gets one. Completing
  // an item requires a note (mirrored to `contactNotes`, the
  // AI-processable trail). `outcome` denormalizes the deal's terminal
  // state (won/lost + the exact loss reason) for the leads board;
  // `funnelTransitions` stays the audit source of truth.
  salesChecklists: defineTable({
    accountId: v.id("accounts"),
    sessionId: v.id("qualificationSessions"),
    conversationId: v.id("conversations"),
    contactId: v.id("contacts"),
    source: v.union(v.literal("kb"), v.literal("default")),
    items: v.array(
      v.object({
        key: v.string(),
        title: v.string(),
        description: v.optional(v.string()),
        done: v.boolean(),
        doneAt: v.optional(v.number()),
        doneByUserId: v.optional(v.id("users")),
        note: v.optional(v.string()),
      }),
    ),
    outcome: v.optional(
      v.object({
        result: v.union(v.literal("won"), v.literal("lost")),
        lossCategory: v.optional(v.string()),
        lossDetail: v.optional(v.string()),
        at: v.number(),
        byUserId: v.optional(v.id("users")),
      }),
    ),
    generatedAt: v.number(),
  })
    .index("by_session", ["sessionId"])
    .index("by_account", ["accountId"]),

  // Run history for the interval crons in crons.ts — one row per
  // execution, stamped by the wrapper actions in cronSchedules.ts.
  // Deployment-global (no accountId): crons are infrastructure, not
  // tenant data; the admin-gated Settings → Cron schedules panel is the
  // only reader. Rows older than 7 days are pruned on each start.
  cronRuns: defineTable({
    name: v.string(),
    startedAt: v.number(),
    finishedAt: v.optional(v.number()),
    status: v.union(
      v.literal("running"),
      v.literal("success"),
      v.literal("failed"),
    ),
    error: v.optional(v.string()),
  }).index("by_name", ["name", "startedAt"]),
});
