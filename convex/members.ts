import { accountMutation, accountQuery } from "./lib/auth";
import { v, ConvexError } from "convex/values";
import { hasMinRole } from "./lib/roles";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";

// ============================================================
// Members — port of `supabase/migrations/018_account_member_rpcs.sql`'s
// `set_member_role`/`remove_account_member` SECURITY DEFINER RPCs.
//
// Both RPCs existed because Postgres RLS only let a user update their
// *own* profile row — an admin changing a teammate's role or moving a
// removed member to a fresh personal account needed a supervised escape
// hatch that self-checks the caller's authority first. Here,
// `accountMutation`/`accountQuery` are that supervision: `ctx.accountId`
// always comes from the caller's own `memberships` row (never a
// client-supplied arg), so every guard below only has to worry about
// the *target*, not re-deriving who the caller is.
//
// `transfer_account_ownership` (018's third RPC) is explicitly out of
// scope — every guard below that touches "owner" exists precisely to
// force ownership changes through that (not-yet-ported) endpoint
// instead.
// ============================================================

/**
 * Loads `targetUserId`'s membership within the caller's own account,
 * applying the guard common to both `setRole` and `remove`: reject a
 * caller targeting themself, and collapse "no such user" / "real user,
 * but a member of a different account" into the same `NOT_FOUND` —
 * same cross-tenant-probe defense as `contacts.ts`'s
 * `requireOwnContact` ("the same error for 'doesn't exist' and 'exists
 * but isn't yours' on purpose"), deliberately tighter than 018's own
 * SQL, which split these into two different SQLSTATEs (22023 vs
 * 42501) and so leaked the distinction.
 *
 * Does NOT apply the owner guard — `setRole`/`remove` check
 * `target.role === "owner"` themselves right after, since `setRole` has
 * a second owner-shaped guard (`args.role === "owner"`) that `remove`
 * doesn't.
 */
async function requireTargetMembership(
  ctx: {
    db: MutationCtx["db"];
    accountId: Id<"accounts">;
    userId: Id<"users">;
  },
  targetUserId: Id<"users">,
) {
  if (targetUserId === ctx.userId) {
    throw new ConvexError({ code: "CANNOT_TARGET_SELF" });
  }

  const membership = await ctx.db
    .query("memberships")
    .withIndex("by_user_account", (q) =>
      q.eq("userId", targetUserId).eq("accountId", ctx.accountId),
    )
    .first();
  if (!membership) {
    throw new ConvexError({ code: "NOT_FOUND", entity: "member" });
  }
  return membership;
}

/**
 * The caller's own account's member roster. Open to any member
 * (viewer+) — `ctx.accountId` already confines the read to the
 * caller's own tenant, so there's no need for a `requireRole` gate
 * here, only on the email field: `email` is only useful for
 * admin-facing management actions (contacting/re-inviting a teammate),
 * so it's nulled out for anyone below admin rather than gating the
 * whole list behind a role check.
 */
export const list = accountQuery({
  args: {},
  handler: async (ctx) => {
    const members = await ctx.db
      .query("memberships")
      .withIndex("by_account", (q) => q.eq("accountId", ctx.accountId))
      .collect();

    const canSeeEmail = hasMinRole(ctx.role, "admin");
    return members.map((member) => ({
      ...member,
      email: canSeeEmail ? member.email : null,
    }));
  },
});

/**
 * Port of `set_member_role` (018). Admin+ changes another member's role
 * within the caller's own account.
 */
export const setRole = accountMutation({
  args: {
    userId: v.id("users"),
    // Deliberately includes "owner" in the validator (not narrowed to
    // admin/agent/viewer) so the runtime guard below — not just the
    // arg schema — is what rejects it, mirroring `set_member_role`'s
    // own explicit `IF p_new_role = 'owner' THEN RAISE EXCEPTION` (a
    // stricter validator would silently absorb this guard into "the
    // request never type-checks", which isn't the same thing as
    // porting the SQL's own check).
    role: v.union(
      v.literal("owner"),
      v.literal("admin"),
      v.literal("agent"),
      v.literal("viewer"),
    ),
  },
  handler: async (ctx, args) => {
    ctx.requireRole("admin");
    const target = await requireTargetMembership(ctx, args.userId);

    // Owner role changes go through transfer_account_ownership
    // (out of scope here) — both directions, same as 018.
    if (target.role === "owner") {
      throw new ConvexError({ code: "TARGET_IS_OWNER" });
    }
    if (args.role === "owner") {
      throw new ConvexError({ code: "CANNOT_ASSIGN_OWNER_ROLE" });
    }

    await ctx.db.patch(target._id, { role: args.role });
  },
});

/**
 * Port of `remove_account_member` (018). Admin+ removes another member
 * from the caller's own account. The removed user is NOT deleted —
 * they keep their login/`users` row — instead they're spun up a fresh
 * personal account on the spot and reassigned to it as its owner,
 * mirroring `accounts.bootstrapAccount`'s own "one account, as owner"
 * shape. Returns the new account's id.
 */
export const remove = accountMutation({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    ctx.requireRole("admin");
    const target = await requireTargetMembership(ctx, args.userId);

    if (target.role === "owner") {
      throw new ConvexError({ code: "TARGET_IS_OWNER" });
    }

    await ctx.db.delete(target._id);

    // COALESCE(NULLIF(full_name, ''), email, 'My account') from 018 —
    // `||` (not `??`) so an empty-string name falls through to email,
    // same as SQL's NULLIF-then-COALESCE chain.
    const targetUser = await ctx.db.get(args.userId);
    const newAccountId = await ctx.db.insert("accounts", {
      name: targetUser?.name || targetUser?.email || "My account",
      defaultCurrency: "USD",
      ownerUserId: args.userId,
    });
    await ctx.db.insert("memberships", {
      userId: args.userId,
      accountId: newAccountId,
      role: "owner",
      fullName: targetUser?.name,
      email: targetUser?.email,
    });

    return newAccountId;
  },
});
