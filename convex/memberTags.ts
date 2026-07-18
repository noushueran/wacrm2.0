import { accountMutation, accountQuery } from "./lib/auth";
import { v, ConvexError } from "convex/values";

// ============================================================
// Service routing links (qualification P6): which members can work
// which service tag. The offer engine walks these when a lead
// qualifies. Admin-gated both ways (routing is org structure).
// ============================================================

export const list = accountQuery({
  args: {},
  handler: async (ctx) => {
    ctx.requireRole("admin");
    return await ctx.db
      .query("memberTags")
      .withIndex("by_account", (q) => q.eq("accountId", ctx.accountId))
      .collect();
  },
});

/** Replaces the member set routed to one tag. */
export const setForTag = accountMutation({
  args: { tagId: v.id("tags"), userIds: v.array(v.id("users")) },
  handler: async (ctx, args) => {
    ctx.requireRole("admin");
    const tag = await ctx.db.get(args.tagId);
    if (!tag || tag.accountId !== ctx.accountId) {
      throw new ConvexError({ code: "NOT_FOUND", entity: "tag" });
    }
    for (const userId of args.userIds) {
      const membership = await ctx.db
        .query("memberships")
        .withIndex("by_user_account", (q) =>
          q.eq("userId", userId).eq("accountId", ctx.accountId),
        )
        .first();
      if (!membership) {
        throw new ConvexError({ code: "NOT_FOUND", entity: "member" });
      }
    }
    const existing = await ctx.db
      .query("memberTags")
      .withIndex("by_account_tag", (q) =>
        q.eq("accountId", ctx.accountId).eq("tagId", args.tagId),
      )
      .collect();
    const want = new Set(args.userIds);
    for (const row of existing) {
      if (!want.has(row.userId)) await ctx.db.delete(row._id);
      else want.delete(row.userId);
    }
    for (const userId of want) {
      await ctx.db.insert("memberTags", {
        accountId: ctx.accountId,
        userId,
        tagId: args.tagId,
      });
    }
    return null;
  },
});
