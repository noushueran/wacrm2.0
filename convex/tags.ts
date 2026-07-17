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
  args: {
    name: v.string(),
    color: v.string(),
    groupId: v.optional(v.id("tagGroups")),
    position: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    ctx.requireRole("supervisor");
    if (args.groupId) {
      const group = await ctx.db.get(args.groupId);
      if (!group || group.accountId !== ctx.accountId) {
        throw new ConvexError({ code: "NOT_FOUND", entity: "tagGroup" });
      }
    }
    return await ctx.db.insert("tags", {
      accountId: ctx.accountId,
      name: args.name,
      color: args.color,
      groupId: args.groupId,
      position: args.position,
    });
  },
});

export const update = accountMutation({
  args: {
    tagId: v.id("tags"),
    name: v.optional(v.string()),
    color: v.optional(v.string()),
    groupId: v.optional(v.id("tagGroups")),
    position: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    ctx.requireRole("supervisor");
    const tag = await ctx.db.get(args.tagId);
    if (!tag || tag.accountId !== ctx.accountId) {
      throw new ConvexError({ code: "NOT_FOUND", entity: "tag" });
    }
    if (args.groupId) {
      const group = await ctx.db.get(args.groupId);
      if (!group || group.accountId !== ctx.accountId) {
        throw new ConvexError({ code: "NOT_FOUND", entity: "tagGroup" });
      }
    }
    const patch: Record<string, unknown> = {};
    if (args.name !== undefined) patch.name = args.name;
    if (args.color !== undefined) patch.color = args.color;
    if (args.groupId !== undefined) patch.groupId = args.groupId;
    if (args.position !== undefined) patch.position = args.position;
    await ctx.db.patch(args.tagId, patch);
    return args.tagId;
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
    ctx.requireRole("supervisor");
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
