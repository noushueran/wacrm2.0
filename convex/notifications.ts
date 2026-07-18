import { accountMutation, accountQuery } from "./lib/auth";
import { v, ConvexError } from "convex/values";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";

// ============================================================
// Notifications — in-app alerts for one agent (`convex/schema.ts`'s
// `notifications`). Convex counterpart to migration 027_notifications.sql:
// `list`/`markRead`/`markAllRead` are the recipient-facing read/ack
// side; `create` is the account-scoped, agent+ write side for the one
// type it accepts (below).
//
// `notifications.type` (`convex/schema.ts`) is a 3-literal union, not a
// bare string — `"conversation_assigned"` (migration 027's own
// `notify_conversation_assigned` trigger, now `conversations.assign` and
// the lead-offer-accept path in `qualificationEngine.ts`),
// `"lead_qualified"` (a lead crosses the qualification threshold, or a
// lead offer needs supervisor escalation — both in
// `qualificationEngine.ts`), and `"sla_alert"` (an assigned chat's
// reply-SLA breaches, targeting supervisors+ — `ingest.ts` and
// `aiReply.ts`). Every insert goes through `insertNotification` below —
// never a caller's own `ctx.db.insert` — so all four call sites (`create`
// here, plus those three) can never drift out of shape with the schema
// or each other; a fourth type would still be a visible, typed change in
// both places at once, not a silent widening. `create` itself stays
// scoped to `v.literal("conversation_assigned")` only — the other two
// types are system/engine-triggered (qualification, SLA breach), not
// something an agent explicitly creates via this generic mutation.
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
