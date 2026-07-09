import { accountMutation, accountQuery } from "./lib/auth";
import { v, ConvexError } from "convex/values";
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
