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
  // assigned user.
  deals: defineTable({
    accountId: v.id("accounts"),
    createdByUserId: v.optional(v.id("users")),
    pipelineId: v.id("pipelines"),
    stageId: v.id("pipelineStages"),
    contactId: v.id("contacts"),
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

  // (other tables added in later Phase 1 tasks)
});
