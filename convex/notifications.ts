import { accountMutation, accountQuery } from "./lib/auth";
import { v, ConvexError } from "convex/values";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";

/**
 * Ceiling on `unreadCount`'s read. Must stay >= 10 so the client's
 * `formatUnreadBadge` (`src/lib/notifications/shared.ts`) can still tell
 * "exactly 9" from "more than 9" — it renders 1-9 verbatim and anything
 * above as "9+", so a count that saturates at 10 is indistinguishable to
 * the UI from an exact one, at a bounded cost.
 */
const UNREAD_BADGE_CAP = 10;

/**
 * Hard ceiling on `listRecent`'s page. The bell only ever asks for a
 * handful, but `limit` is client-supplied and reaches `.take()`, which
 * throws on a negative value and is unbounded on a large one — so clamp
 * it to `[0, LIST_RECENT_CAP]` before the read.
 */
const LIST_RECENT_CAP = 50;

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
 * The caller's own notifications, newest-first — the `/notifications`
 * page's full history. Binds `(userId, accountId)` on
 * `by_user_account` rather than scanning `by_user` and re-filtering the
 * account in JS. That still gives the same defense-in-depth the JS
 * filter was there for — a stale row surviving an account switch, since
 * `invitations.redeem` moves a user's `memberships.accountId` in place —
 * except the excluded rows are now never read at all.
 *
 * Deliberately unbounded: this is a history view, and it is only
 * subscribed while the page is open. The header bell, which mounts on
 * every authenticated page, must use `listRecent`/`unreadCount` below.
 */
export const list = accountQuery({
  args: {},
  handler: async (ctx) => {
    return await ctx.db
      .query("notifications")
      .withIndex("by_user_account", (q) =>
        q.eq("userId", ctx.userId).eq("accountId", ctx.accountId),
      )
      .order("desc")
      .collect();
  },
});

/**
 * The newest `limit` notifications for the caller — the header bell's
 * popover rows. Same range as `list`, stopped at `limit`.
 */
export const listRecent = accountQuery({
  args: { limit: v.number() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("notifications")
      .withIndex("by_user_account", (q) =>
        q.eq("userId", ctx.userId).eq("accountId", ctx.accountId),
      )
      .order("desc")
      .take(Math.min(Math.max(0, Math.floor(args.limit)), LIST_RECENT_CAP));
  },
});

/**
 * How many unread notifications the caller has, saturating at
 * `UNREAD_BADGE_CAP`. The bell's `formatUnreadBadge` only needs exact
 * values 1-9 and renders anything above that as "9+", so stopping the
 * read at the cap costs the UI nothing and makes this query O(cap)
 * instead of O(the caller's entire notification history) — which matters
 * because the bell subscribes to it on every authenticated page.
 *
 * `readAt: undefined` is a real indexed value in Convex, so the unread
 * set is an index range here, not a post-scan filter.
 */
export const unreadCount = accountQuery({
  args: {},
  handler: async (ctx) => {
    const unread = await ctx.db
      .query("notifications")
      .withIndex("by_user_account_read", (q) =>
        q
          .eq("userId", ctx.userId)
          .eq("accountId", ctx.accountId)
          .eq("readAt", undefined),
      )
      .take(UNREAD_BADGE_CAP);
    return unread.length;
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
    // Ranges the unread set on `by_user_account_read` rather than
    // collecting the caller's whole cross-account history and narrowing
    // it in JS: the rows this patches are exactly the rows it now reads.
    const unread = await ctx.db
      .query("notifications")
      .withIndex("by_user_account_read", (q) =>
        q
          .eq("userId", ctx.userId)
          .eq("accountId", ctx.accountId)
          .eq("readAt", undefined),
      )
      .collect();

    const now = Date.now();
    await Promise.all(
      unread.map((notification) =>
        ctx.db.patch(notification._id, { readAt: now }),
      ),
    );
    return unread.length;
  },
});
