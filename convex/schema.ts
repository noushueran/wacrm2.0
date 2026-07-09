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

  // (other tables added in later Phase 0 tasks)
});
