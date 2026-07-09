import { mutation, query } from "./_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError } from "convex/values";

/**
 * First-login bootstrap: gives the current user exactly one account (as
 * `owner`) the first time they call this, and is a no-op on every call
 * after that. Idempotency is keyed off `memberships.by_user` — a user can
 * only ever have one membership row created here, so "have I already been
 * bootstrapped" and "what's my account" are the same lookup.
 */
export const bootstrapAccount = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new ConvexError({ code: "UNAUTHENTICATED" });

    const existing = await ctx.db
      .query("memberships")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .first();
    if (existing) return existing.accountId;

    const user = await ctx.db.get(userId);
    const accountId = await ctx.db.insert("accounts", {
      name: user?.email ?? "My account",
      defaultCurrency: "USD",
      ownerUserId: userId,
    });
    await ctx.db.insert("memberships", {
      userId,
      accountId,
      role: "owner",
      fullName: user?.name,
      email: user?.email,
    });
    return accountId;
  },
});

/**
 * The authenticated user plus their (first) account membership and role.
 * `null` if unauthenticated or authenticated but not yet bootstrapped.
 */
export const currentUser = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;

    const membership = await ctx.db
      .query("memberships")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .first();
    if (!membership) return null;

    const user = await ctx.db.get(userId);
    return { user, accountId: membership.accountId, role: membership.role };
  },
});
