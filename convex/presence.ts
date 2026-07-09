import { accountMutation, accountQuery } from "./lib/auth";
import { v } from "convex/values";

// ============================================================
// Presence — lightweight online/away heartbeat, one row per user
// (`convex/schema.ts`'s `memberPresence`). Convex counterpart to
// migration 024_member_presence.sql's `touch_presence` RPC: `touch`
// upserts the caller's own row (found via the schema's "enforcing"
// `by_user` index — see its own comment), `list` reads every row for
// the account. "Offline" is never itself stored — the Team roster /
// inbox Assign dropdown derive it client-side from `lastSeenAt`
// staleness, exactly like migration 024's own design note and
// `src/components/presence/presence-heartbeat.tsx`'s heartbeat client.
// ============================================================

/**
 * Any signed-in member heartbeats their OWN presence — no
 * `requireRole` gate, matching migration 024's `touch_presence`: every
 * account member (not just agent+) may write their own row, and there's
 * no coarser action here to gate beyond "you are who `accountMutation`
 * says you are". Finds the caller's existing row via `by_user` (one row
 * per user, per the schema comment) and patches it in place; inserts a
 * fresh row on the caller's first-ever heartbeat.
 *
 * Also re-patches `accountId` on an existing row (not just
 * `status`/`lastSeenAt`) — mirrors migration 024's own `ON CONFLICT (
 * user_id) DO UPDATE SET ... account_id = excluded.account_id`. Without
 * this, a member who changes accounts (`invitations.redeem`) would keep
 * heartbeating a presence row still tagged with their OLD account,
 * which would never show up in their new teammates' `list` and would
 * wrongly keep showing them online to their old ones.
 */
export const touch = accountMutation({
  args: {
    status: v.union(v.literal("online"), v.literal("away")),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("memberPresence")
      .withIndex("by_user", (q) => q.eq("userId", ctx.userId))
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        accountId: ctx.accountId,
        status: args.status,
        lastSeenAt: Date.now(),
      });
      return existing._id;
    }

    return await ctx.db.insert("memberPresence", {
      userId: ctx.userId,
      accountId: ctx.accountId,
      status: args.status,
      lastSeenAt: Date.now(),
    });
  },
});

/**
 * Every presence row for the caller's own account — the Team roster /
 * inbox Assign dropdown render online/away/offline (offline derived
 * client-side from `lastSeenAt` staleness) from this list. Same
 * visibility as migration 024's `member_presence_select` RLS policy:
 * any account member may read every row for their account.
 */
export const list = accountQuery({
  args: {},
  handler: async (ctx) => {
    return await ctx.db
      .query("memberPresence")
      .withIndex("by_account", (q) => q.eq("accountId", ctx.accountId))
      .collect();
  },
});
