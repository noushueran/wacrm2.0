import { accountMutation, accountQuery } from "./lib/auth";
import { v, ConvexError } from "convex/values";

// ============================================================
// Tag CRUD. Every function is account-scoped through
// `accountQuery`/`accountMutation` (`./lib/auth.ts`) — never the raw
// `query`/`mutation` — the same isolation model `contacts.ts` uses.
// ============================================================

export const list = accountQuery({
  args: {},
  handler: async (ctx) => {
    return await ctx.db
      .query("tags")
      .withIndex("by_account", (q) => q.eq("accountId", ctx.accountId))
      .collect();
  },
});

export const create = accountMutation({
  args: { name: v.string(), color: v.string() },
  handler: async (ctx, args) => {
    ctx.requireRole("agent");
    return await ctx.db.insert("tags", {
      accountId: ctx.accountId,
      name: args.name,
      color: args.color,
    });
  },
});

/**
 * Deletes a tag and cascades: every `contactTags` row referencing it is
 * removed first (mirrors `contacts.remove`'s explicit-cascade
 * pattern). `NOT_FOUND` covers both "doesn't exist" and "exists but
 * belongs to another account" on purpose — the same signal for both
 * cases means a cross-account probe can't tell them apart.
 */
export const remove = accountMutation({
  args: { tagId: v.id("tags") },
  handler: async (ctx, args) => {
    ctx.requireRole("agent");
    const tag = await ctx.db.get(args.tagId);
    if (!tag || tag.accountId !== ctx.accountId) {
      throw new ConvexError({ code: "NOT_FOUND", entity: "tag" });
    }

    const links = await ctx.db
      .query("contactTags")
      .withIndex("by_tag", (q) => q.eq("tagId", args.tagId))
      .collect();
    for (const link of links) {
      await ctx.db.delete(link._id);
    }
    await ctx.db.delete(args.tagId);
  },
});
