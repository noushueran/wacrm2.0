import { accountMutation, accountQuery } from "./lib/auth";
import { v, ConvexError } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import type { Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";

// ============================================================
// Messages — the Inbox thread view (`listByConversation`) plus the
// single write path every inbound/outbound/bot message goes through
// (`append`). Every function here is built on `accountQuery`/
// `accountMutation` (never the raw `query`/`mutation`), mirroring
// `conversations.ts`/`contacts.ts`: `ctx.accountId` always comes from
// the caller's own `memberships` row, never a client-supplied argument
// (there is no `accountId` field in either args validator below). A
// message can never be read or written without first proving its
// parent conversation belongs to the caller's own account — see
// `requireOwnConversation`.
// ============================================================

/**
 * Loads a conversation and throws `NOT_FOUND` unless it belongs to the
 * caller's own account — the same error for "doesn't exist" and
 * "exists but isn't yours" on purpose (mirrors `contacts.ts`'s
 * `requireOwnContact` and `conversations.ts`'s `get`), so a
 * cross-account probe can't distinguish the two. Shared by both
 * `listByConversation` and `append` below, since every message
 * read/write starts by proving ownership of its parent conversation.
 * Typed to accept either an `accountQuery` or `accountMutation` ctx
 * (only `db.get` is used), same treatment as `contacts.ts`'s
 * `requireOwnContact`.
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

export const listByConversation = accountQuery({
  args: {
    conversationId: v.id("conversations"),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    await requireOwnConversation(ctx, args.conversationId);

    // `by_conversation` binds its only field via `.eq` below, so the
    // sole remaining sort key is the implicit `_creationTime` —
    // `.order("desc")` gives newest-first without needing a separate
    // timestamp field on `messages` (there isn't one; see schema.ts).
    return await ctx.db
      .query("messages")
      .withIndex("by_conversation", (q) =>
        q.eq("conversationId", args.conversationId),
      )
      .order("desc")
      .paginate(args.paginationOpts);
  },
});

export const append = accountMutation({
  args: {
    conversationId: v.id("conversations"),
    senderType: v.union(
      v.literal("customer"),
      v.literal("agent"),
      v.literal("bot"),
    ),
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
    messageId: v.optional(v.string()),
    interactivePayload: v.optional(v.any()),
    aiGenerated: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    ctx.requireRole("agent");
    const {
      conversationId,
      senderType,
      contentType,
      contentText,
      mediaUrl,
      templateName,
      messageId,
      interactivePayload,
      aiGenerated,
    } = args;
    const conversation = await requireOwnConversation(ctx, conversationId);

    const newMessageId = await ctx.db.insert("messages", {
      accountId: ctx.accountId,
      conversationId,
      senderType,
      contentType,
      contentText,
      mediaUrl,
      templateName,
      messageId,
      interactivePayload,
      aiGenerated,
      status: "sent",
    });

    // Denormalized preview fields the Inbox list reads directly off
    // `conversations` (see `conversations.ts`'s `list`) so it never has
    // to join into `messages` just to render a snippet. `unreadCount`
    // only climbs for inbound (`"customer"`) messages — an agent/bot
    // message is one the account itself just sent, not one waiting to
    // be read.
    const patch: Partial<{
      lastMessageText: string;
      lastMessageAt: number;
      updatedAt: number;
      unreadCount: number;
    }> = {
      lastMessageText: contentText ?? `[${contentType}]`,
      lastMessageAt: Date.now(),
      updatedAt: Date.now(),
    };
    if (senderType === "customer") {
      patch.unreadCount = conversation.unreadCount + 1;
    }
    await ctx.db.patch(conversationId, patch);

    return newMessageId;
  },
});
