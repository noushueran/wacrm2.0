import { accountQuery } from "./lib/auth";
import { v, ConvexError } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import type { Doc } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";

// ============================================================
// Conversation queries — the Inbox list + single-thread read. Every
// function here is built on `accountQuery` (never the raw `query`),
// mirroring the account-isolation pattern `contacts.ts` establishes:
// `ctx.accountId` always comes from the caller's own `memberships`
// row, never a client-supplied argument (there is no `accountId`
// field in either args validator below).
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
