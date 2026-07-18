import { accountMutation, accountQuery } from "./lib/auth";
import { v, ConvexError } from "convex/values";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";

// ============================================================
// Notifications — in-app alerts for one agent (`convex/schema.ts`'s
// `notifications`). Convex counterpart to migration 027_notifications.sql:
// `list`/`markRead`/`markAllRead` are the recipient-facing read/ack
// side; `create` is the account-scoped, agent+ write side; `conversations
// .assign` (in `convex/conversations.ts`) also creates a notification —
// the "you were assigned a conversation" case migration 027's own
// `notify_conversation_assigned` trigger handled automatically.
//
// `type` is typed as the single literal the schema itself allows today
// (`convex/schema.ts`'s `notifications.type` is
// `v.union(v.literal("conversation_assigned"))`) rather than a bare
// string, so a second notification type later is a visible, typed
// change in both places at once, not a silent widening.
// ============================================================

/**
 * The one place a `notifications` row gets its shape — both `create`
 * below and `conversations.assign` call this directly (not
 * `ctx.db.insert` independently), so the two insert paths (an explicit
 * agent-triggered notification vs. the automatic assignment one) can
 * never drift out of shape with each other or with the schema. Takes a
 * bare `{ db }` rather than the full `MutationCtx`/`accountMutation` ctx
 * so it's callable from any mutation's ctx, not just this file's own.
 */
export async function insertNotification(
  ctx: { db: MutationCtx["db"] },
  args: {
    accountId: Id<"accounts">;
    userId: Id<"users">;
    type: "conversation_assigned" | "lead_qualified" | "sla_alert";
    conversationId?: Id<"conversations">;
    contactId?: Id<"contacts">;
    actorUserId?: Id<"users">;
    title: string;
    body?: string;
  },
) {
  return await ctx.db.insert("notifications", args);
}

/**
 * Agent+ creates a notification for a fellow account member.
 * `requireRole("agent")` mirrors every other write-side, teammate-
 * facing mutation in this codebase (e.g. `conversations.assign`).
 * `userId` must itself be a member of this same account (checked via
 * `by_user_account`, exactly like `conversations.assign`'s own teammate
 * check) — an arbitrary/foreign user id is rejected the same way, so a
 * cross-account probe can't distinguish "no such user" from "not your
 * teammate".
 */
export const create = accountMutation({
  args: {
    userId: v.id("users"),
    type: v.literal("conversation_assigned"),
    conversationId: v.optional(v.id("conversations")),
    contactId: v.optional(v.id("contacts")),
    actorUserId: v.optional(v.id("users")),
    title: v.string(),
    body: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    ctx.requireRole("agent");

    const membership = await ctx.db
      .query("memberships")
      .withIndex("by_user_account", (q) =>
        q.eq("userId", args.userId).eq("accountId", ctx.accountId),
      )
      .first();
    if (!membership) {
      throw new ConvexError({ code: "NOT_FOUND", entity: "member" });
    }

    return await insertNotification(ctx, {
      accountId: ctx.accountId,
      ...args,
    });
  },
});

/**
 * The caller's own notifications, newest-first. Scoped to `ctx.userId`
 * (the recipient) via `by_user`, then re-filtered in plain JS to
 * `ctx.accountId` (mirrors `contacts.filterByTags`'s own "collect, then
 * filter in memory" style for a query with no dedicated composite
 * index) — defense-in-depth against a stale row surviving an account
 * switch: `invitations.redeem` moves a user's `memberships.accountId` in
 * place, which would otherwise leave an old notification from their
 * PREVIOUS account visible under their new one.
 */
export const list = accountQuery({
  args: {},
  handler: async (ctx) => {
    const mine = await ctx.db
      .query("notifications")
      .withIndex("by_user", (q) => q.eq("userId", ctx.userId))
      .order("desc")
      .collect();

    return mine.filter((notification) => notification.accountId === ctx.accountId);
  },
});

/**
 * Loads a notification and throws `NOT_FOUND` unless it belongs to both
 * the caller's own account AND the caller themself is its recipient —
 * the same "same error for doesn't-exist and isn't-yours" pattern as
 * `contacts.ts`'s `requireOwnContact`, doubled up because a
 * notification has two different ownership axes (its account, and its
 * specific recipient within that account).
 */
async function requireOwnNotification(
  ctx: { db: MutationCtx["db"]; accountId: Id<"accounts">; userId: Id<"users"> },
  notificationId: Id<"notifications">,
) {
  const notification = await ctx.db.get(notificationId);
  if (
    !notification ||
    notification.accountId !== ctx.accountId ||
    notification.userId !== ctx.userId
  ) {
    throw new ConvexError({ code: "NOT_FOUND", entity: "notification" });
  }
  return notification;
}

/** Marks one of the caller's own notifications read. */
export const markRead = accountMutation({
  args: { notificationId: v.id("notifications") },
  handler: async (ctx, args) => {
    await requireOwnNotification(ctx, args.notificationId);
    await ctx.db.patch(args.notificationId, { readAt: Date.now() });
    return args.notificationId;
  },
});

/** Marks every one of the caller's own currently-unread notifications read. */
export const markAllRead = accountMutation({
  args: {},
  handler: async (ctx) => {
    const mine = await ctx.db
      .query("notifications")
      .withIndex("by_user", (q) => q.eq("userId", ctx.userId))
      .collect();

    const unread = mine.filter(
      (notification) =>
        notification.accountId === ctx.accountId &&
        notification.readAt === undefined,
    );

    const now = Date.now();
    await Promise.all(
      unread.map((notification) =>
        ctx.db.patch(notification._id, { readAt: now }),
      ),
    );
    return unread.length;
  },
});
