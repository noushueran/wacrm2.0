import { accountMutation, accountQuery } from "./lib/auth";
import { v, ConvexError } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";

// ============================================================
// Conversations — the Inbox list/thread read (`list`/`get`) plus the
// mutations that drive its write side (Phase 2, Task 3):
// `findOrCreateForContact`, `assign`, `setStatus`, `markRead`. Every
// function here is built on `accountQuery`/`accountMutation` (never the
// raw `query`/`mutation`), mirroring the account-isolation pattern
// `contacts.ts` establishes: `ctx.accountId` always comes from the
// caller's own `memberships` row, never a client-supplied argument
// (there is no `accountId` field in any args validator below).
// ============================================================

/**
 * Attaches this contact's `tags` (via the `contactTags` join table).
 * Mirrors `contacts.ts`'s own `embedTags` byte-for-byte — that helper
 * is private to `contacts.ts` (not exported), so it's duplicated here
 * rather than importing across verticals, matching the codebase's
 * existing one-helper-per-file style (each of `contacts.ts`/`tags.ts`
 * only ever reads its own table's shape).
 */
async function embedTags(ctx: QueryCtx, contact: Doc<"contacts">) {
  const links = await ctx.db
    .query("contactTags")
    .withIndex("by_contact", (q) => q.eq("contactId", contact._id))
    .collect();
  const tags = (
    await Promise.all(links.map((link) => ctx.db.get(link.tagId)))
  ).filter((tag): tag is Doc<"tags"> => tag !== null);
  return { ...contact, tags };
}

/**
 * Embeds a conversation's `contact` (+ that contact's `tags`) for
 * display, so the Inbox list/thread view never needs a second
 * round-trip. `contactId` has no DB-level referential integrity in
 * Convex (and `contacts.remove` has no cascade onto `conversations`
 * today), so the contact can in principle be missing — `contact: null`
 * covers that defensively rather than throwing.
 */
async function embedContact(
  ctx: QueryCtx,
  conversation: Doc<"conversations">,
) {
  const contact = await ctx.db.get(conversation.contactId);
  return {
    ...conversation,
    contact: contact ? await embedTags(ctx, contact) : null,
  };
}

export const list = accountQuery({
  args: {
    status: v.optional(
      v.union(v.literal("open"), v.literal("pending"), v.literal("closed")),
    ),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    const { status, paginationOpts } = args;

    // `by_account_last_message` ranges over every conversation in the
    // caller's own account (only `accountId` is bound in the index
    // callback below), then `.order("desc")` sorts by the index's
    // trailing field, `lastMessageAt` — see the schema comment for why
    // a conversation with no messages yet (an unset `lastMessageAt`)
    // deterministically sorts last rather than needing special-cased
    // fallback logic here.
    const ordered = ctx.db
      .query("conversations")
      .withIndex("by_account_last_message", (q) =>
        q.eq("accountId", ctx.accountId),
      )
      .order("desc");

    const result = await (
      status ? ordered.filter((q) => q.eq(q.field("status"), status)) : ordered
    ).paginate(paginationOpts);

    const page = await Promise.all(
      result.page.map((conversation) => embedContact(ctx, conversation)),
    );
    return { ...result, page };
  },
});

export const get = accountQuery({
  args: { conversationId: v.id("conversations") },
  handler: async (ctx, args) => {
    const conversation = await ctx.db.get(args.conversationId);
    // Same error for "doesn't exist" and "exists but isn't yours" on
    // purpose (mirrors `contacts.ts`'s `requireOwnContact`), so a
    // cross-account probe can't distinguish the two.
    if (!conversation || conversation.accountId !== ctx.accountId) {
      throw new ConvexError({ code: "NOT_FOUND", entity: "conversation" });
    }
    return await embedContact(ctx, conversation);
  },
});

// ============================================================
// Conversation mutations (Phase 2, Task 3) — creating a thread for a
// contact, assigning it, changing its status, and marking it read.
// Every mutation asserts ownership of its target conversation via
// `requireOwnConversation` before writing.
// ============================================================

/**
 * Loads a conversation and throws `NOT_FOUND` unless it belongs to the
 * caller's own account — the same error for "doesn't exist" and
 * "exists but isn't yours" on purpose (mirrors `get` above and
 * `messages.ts`'s own `requireOwnConversation`). Duplicated from
 * `messages.ts` rather than imported, matching this codebase's
 * one-helper-per-file style (see `embedTags`'s own comment above for
 * the same reasoning) — `messages.ts` needs this to guard message
 * reads/writes, this file needs it to guard the mutations below.
 */
async function requireOwnConversation(
  ctx: { db: QueryCtx["db"]; accountId: Id<"accounts"> },
  conversationId: Id<"conversations">,
) {
  const conversation = await ctx.db.get(conversationId);
  if (!conversation || conversation.accountId !== ctx.accountId) {
    throw new ConvexError({ code: "NOT_FOUND", entity: "conversation" });
  }
  return conversation;
}

/**
 * Returns the existing thread for a contact, or opens a new one.
 * `by_contact` isn't itself account-scoped (see schema.ts), so the
 * match is additionally filtered to `ctx.accountId` — defense-in-depth
 * that doesn't actually change behavior today (a contact only ever
 * belongs to one account, and the ownership check above already proves
 * it's this caller's own, so no other account's conversation could
 * share its `contactId`), matching `contacts.ts`'s own "re-check the
 * target row's accountId, don't rely solely on the index" philosophy.
 */
export const findOrCreateForContact = accountMutation({
  args: { contactId: v.id("contacts") },
  handler: async (ctx, args) => {
    ctx.requireRole("agent");
    const contact = await ctx.db.get(args.contactId);
    if (!contact || contact.accountId !== ctx.accountId) {
      throw new ConvexError({ code: "NOT_FOUND", entity: "contact" });
    }

    const existing = await ctx.db
      .query("conversations")
      .withIndex("by_contact", (q) => q.eq("contactId", args.contactId))
      .filter((q) => q.eq(q.field("accountId"), ctx.accountId))
      .first();
    if (existing) return existing._id;

    return await ctx.db.insert("conversations", {
      accountId: ctx.accountId,
      contactId: args.contactId,
      status: "open",
      unreadCount: 0,
    });
  },
});

/**
 * Assigns a conversation to an account teammate and bumps it to
 * "pending" — the agent now owns following up. `userId` must itself be
 * a member of this same account (checked via `by_user_account`); an
 * arbitrary/foreign user id is rejected the same way a missing/foreign
 * conversation is, so a cross-account probe can't distinguish "no such
 * user" from "not your teammate".
 */
export const assign = accountMutation({
  args: { conversationId: v.id("conversations"), userId: v.id("users") },
  handler: async (ctx, args) => {
    ctx.requireRole("agent");
    await requireOwnConversation(ctx, args.conversationId);

    const membership = await ctx.db
      .query("memberships")
      .withIndex("by_user_account", (q) =>
        q.eq("userId", args.userId).eq("accountId", ctx.accountId),
      )
      .first();
    if (!membership) {
      throw new ConvexError({ code: "NOT_FOUND", entity: "member" });
    }

    await ctx.db.patch(args.conversationId, {
      assignedToUserId: args.userId,
      status: "pending",
      updatedAt: Date.now(),
    });
    return args.conversationId;
  },
});

export const setStatus = accountMutation({
  args: {
    conversationId: v.id("conversations"),
    status: v.union(
      v.literal("open"),
      v.literal("pending"),
      v.literal("closed"),
    ),
  },
  handler: async (ctx, args) => {
    ctx.requireRole("agent");
    await requireOwnConversation(ctx, args.conversationId);
    await ctx.db.patch(args.conversationId, {
      status: args.status,
      updatedAt: Date.now(),
    });
    return args.conversationId;
  },
});

/**
 * Zeroes `unreadCount` — the Inbox calls this the moment an agent opens
 * a thread. No `updatedAt` bump here: unlike `assign`/`setStatus`,
 * reading a thread isn't a change to the conversation's own state an
 * agent would expect reflected in "last updated" (matches the task
 * brief's own spec for this mutation).
 */
export const markRead = accountMutation({
  args: { conversationId: v.id("conversations") },
  handler: async (ctx, args) => {
    ctx.requireRole("agent");
    await requireOwnConversation(ctx, args.conversationId);
    await ctx.db.patch(args.conversationId, { unreadCount: 0 });
    return args.conversationId;
  },
});
