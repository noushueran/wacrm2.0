import { accountMutation, accountQuery } from "./lib/auth";
import { action } from "./_generated/server";
import { internal } from "./_generated/api";
import { getAuthUserId } from "@convex-dev/auth/server";
import { v, ConvexError } from "convex/values";
import { hasMinRole } from "./lib/roles";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";

// ============================================================
// Message reactions (Phase 2, Task 3) — one row per (message, actor)
// emoji reaction (see schema.ts's `messageReactions`). Every function
// here is built on `accountQuery`/`accountMutation` (never the raw
// `query`/`mutation`), mirroring `messages.ts`: a reaction can never be
// read or written without first proving its parent message belongs to
// the caller's own account — see `requireOwnMessage`.
// ============================================================

/**
 * Loads a message and throws `NOT_FOUND` unless it belongs to the
 * caller's own account — the same error for "doesn't exist" and
 * "exists but isn't yours" on purpose (mirrors the same treatment
 * `requireOwnConversation` gives conversations in `messages.ts`/
 * `conversations.ts`, and `requireOwnContact` gives contacts in
 * `contacts.ts`), so a cross-account probe can't distinguish the two.
 * Every reaction read/write starts by proving ownership of its parent
 * message this way.
 */
async function requireOwnMessage(
  ctx: { db: QueryCtx["db"]; accountId: Id<"accounts"> },
  messageId: Id<"messages">,
) {
  const message = await ctx.db.get(messageId);
  if (!message || message.accountId !== ctx.accountId) {
    throw new ConvexError({ code: "NOT_FOUND", entity: "message" });
  }
  return message;
}

/**
 * Loads a conversation and throws `NOT_FOUND` unless it belongs to the
 * caller's own account — the same error for "doesn't exist" and
 * "exists but isn't yours" on purpose (mirrors `requireOwnMessage`
 * above, and `messages.ts`'s own `requireOwnConversation`). Duplicated
 * here rather than imported, matching this codebase's one-helper-
 * per-file style (see `deals.ts`'s `requireOwnContact` for the same
 * reasoning). Used only by `forConversation` below, which needs to
 * prove ownership of a conversation directly rather than reaching it
 * through a message.
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
 * Finds the (message, actor) reaction row via `by_message_actor` — the
 * lookup both `set` (patch-vs-insert) and `remove` need. `actorId` is
 * optional (a reaction can be identified by `actorType` alone when no
 * finer-grained id applies — see schema.ts's own comment on why it's a
 * bare optional string); Convex supports `.eq(field, undefined)`
 * against an optional indexed field to match rows where it's genuinely
 * absent, which is exactly the lookup an actor-id-less reaction needs.
 */
async function findReaction(
  ctx: { db: QueryCtx["db"] },
  args: {
    messageId: Id<"messages">;
    actorType: Doc<"messageReactions">["actorType"];
    actorId?: Doc<"messageReactions">["actorId"];
  },
) {
  return await ctx.db
    .query("messageReactions")
    .withIndex("by_message_actor", (q) =>
      q
        .eq("messageId", args.messageId)
        .eq("actorType", args.actorType)
        .eq("actorId", args.actorId),
    )
    .first();
}

export const set = accountMutation({
  args: {
    messageId: v.id("messages"),
    emoji: v.string(),
    actorType: v.union(v.literal("customer"), v.literal("agent")),
    actorId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    ctx.requireRole("agent");
    const message = await requireOwnMessage(ctx, args.messageId);

    const existing = await findReaction(ctx, args);
    if (existing) {
      await ctx.db.patch(existing._id, { emoji: args.emoji });
      return existing._id;
    }

    return await ctx.db.insert("messageReactions", {
      accountId: ctx.accountId,
      messageId: args.messageId,
      conversationId: message.conversationId,
      actorType: args.actorType,
      actorId: args.actorId,
      emoji: args.emoji,
    });
  },
});

/**
 * Deletes the (message, actor) reaction row if one exists. Requires the
 * same "agent" role as `set` — every other mutation in this codebase
 * (`contacts.remove`/`unassignTag` included) gates its delete path
 * identically to its create path, so a lower-privileged member who
 * could never call `set` can't use `remove` to delete someone else's
 * reaction either.
 */
export const remove = accountMutation({
  args: {
    messageId: v.id("messages"),
    actorType: v.union(v.literal("customer"), v.literal("agent")),
    actorId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    ctx.requireRole("agent");
    await requireOwnMessage(ctx, args.messageId);

    const existing = await findReaction(ctx, args);
    if (existing) await ctx.db.delete(existing._id);
  },
});

export const forMessage = accountQuery({
  args: { messageId: v.id("messages") },
  handler: async (ctx, args) => {
    await requireOwnMessage(ctx, args.messageId);
    return await ctx.db
      .query("messageReactions")
      .withIndex("by_message", (q) => q.eq("messageId", args.messageId))
      .collect();
  },
});

/**
 * Bulk counterpart to `forMessage` — the inbox thread view loads every
 * reaction for the whole conversation in one round-trip rather than one
 * query per message.
 */
export const forConversation = accountQuery({
  args: { conversationId: v.id("conversations") },
  handler: async (ctx, args) => {
    await requireOwnConversation(ctx, args.conversationId);
    return await ctx.db
      .query("messageReactions")
      .withIndex("by_conversation", (q) =>
        q.eq("conversationId", args.conversationId),
      )
      .collect();
  },
});

/**
 * The authed, PUBLIC entrypoint that notifies Meta of a reaction (Phase
 * 8, Task 4) — the counterpart to `send.ts`'s `send`, built the same
 * way: `getAuthUserId` + `internal.accounts.accountContextForUser` to
 * derive a trustworthy account/role (a plain `action` has no `ctx.db`
 * to run `lib/auth.ts`'s membership lookup inline), `hasMinRole` to
 * enforce the same "agent" floor `set`/`remove` above already require,
 * then `internal.messages.getForAccount` to verify the target message
 * belongs to this account and read its Meta wamid + conversation off
 * it, before dispatching to `internal.metaSend.sendReaction`.
 *
 * Does NOT touch `messageReactions` itself — the DB row is already
 * written by the UI's own call to `set`/`remove` above; this action's
 * entire job is the Meta leg those two mutations can't do (they're
 * plain mutations, no outbound `fetch`). `emoji: ""` removes an
 * existing reaction on Meta's side, mirroring `sendReaction`'s own
 * pass-through of that convention.
 */
export const reactToMeta = action({
  args: { messageId: v.id("messages"), emoji: v.string() },
  handler: async (ctx, args): Promise<{ whatsappMessageId: string }> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new ConvexError({ code: "UNAUTHENTICATED" });

    const context = await ctx.runQuery(
      internal.accounts.accountContextForUser,
      { userId },
    );
    if (!context) throw new ConvexError({ code: "NO_ACCOUNT" });
    if (!hasMinRole(context.role, "agent")) {
      throw new ConvexError({ code: "FORBIDDEN", min: "agent" });
    }
    const { accountId } = context;

    const message = await ctx.runQuery(internal.messages.getForAccount, {
      accountId,
      messageId: args.messageId,
    });
    if (!message.messageId) {
      throw new Error(
        "Cannot react to a message that has not been sent to WhatsApp",
      );
    }

    return await ctx.runAction(internal.metaSend.sendReaction, {
      accountId,
      conversationId: message.conversationId,
      targetWhatsappMessageId: message.messageId,
      emoji: args.emoji,
    });
  },
});
