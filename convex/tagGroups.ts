import { accountMutation, accountQuery } from "./lib/auth";
import { v, ConvexError } from "convex/values";
import type { Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";

// ============================================================
// Tag groups — the account-defined dimensions tags are organised
// under (Product, Destination, Priority, …). Same account-scoping and
// supervisor role floor as `tags.ts`. Deleting a group UNGROUPS its
// tags (they survive as ungrouped) rather than cascading a delete.
// ============================================================

async function requireOwnGroup(
  ctx: { db: QueryCtx["db"]; accountId: Id<"accounts"> },
  groupId: Id<"tagGroups">,
) {
  const group = await ctx.db.get(groupId);
  if (!group || group.accountId !== ctx.accountId) {
    throw new ConvexError({ code: "NOT_FOUND", entity: "tagGroup" });
  }
  return group;
}

export const list = accountQuery({
  args: {},
  handler: async (ctx) => {
    const groups = await ctx.db
      .query("tagGroups")
      .withIndex("by_account", (q) => q.eq("accountId", ctx.accountId))
      .collect();
    return groups.sort(
      (a, b) => a.position - b.position || a._creationTime - b._creationTime,
    );
  },
});

export const create = accountMutation({
  args: {
    name: v.string(),
    color: v.optional(v.string()),
    selectionMode: v.union(v.literal("single"), v.literal("multi")),
  },
  handler: async (ctx, args) => {
    ctx.requireRole("supervisor");
    const existing = await ctx.db
      .query("tagGroups")
      .withIndex("by_account", (q) => q.eq("accountId", ctx.accountId))
      .collect();
    const position = existing.reduce((max, g) => Math.max(max, g.position + 1), 0);
    return await ctx.db.insert("tagGroups", {
      accountId: ctx.accountId,
      name: args.name,
      color: args.color,
      selectionMode: args.selectionMode,
      position,
    });
  },
});

export const update = accountMutation({
  args: {
    groupId: v.id("tagGroups"),
    name: v.optional(v.string()),
    color: v.optional(v.string()),
    selectionMode: v.optional(v.union(v.literal("single"), v.literal("multi"))),
  },
  handler: async (ctx, args) => {
    ctx.requireRole("supervisor");
    await requireOwnGroup(ctx, args.groupId);
    const patch: Record<string, unknown> = {};
    if (args.name !== undefined) patch.name = args.name;
    if (args.color !== undefined) patch.color = args.color;
    if (args.selectionMode !== undefined) patch.selectionMode = args.selectionMode;
    await ctx.db.patch(args.groupId, patch);
    return args.groupId;
  },
});

export const reorder = accountMutation({
  args: { orderedIds: v.array(v.id("tagGroups")) },
  handler: async (ctx, args) => {
    ctx.requireRole("supervisor");
    for (let i = 0; i < args.orderedIds.length; i++) {
      await requireOwnGroup(ctx, args.orderedIds[i]); // proves account ownership
      await ctx.db.patch(args.orderedIds[i], { position: i });
    }
  },
});

export const remove = accountMutation({
  args: { groupId: v.id("tagGroups") },
  handler: async (ctx, args) => {
    ctx.requireRole("supervisor");
    await requireOwnGroup(ctx, args.groupId);
    // Ungroup this group's tags (they survive as ungrouped), then delete.
    const tags = await ctx.db
      .query("tags")
      .withIndex("by_group", (q) => q.eq("groupId", args.groupId))
      .collect();
    for (const tag of tags) {
      await ctx.db.patch(tag._id, { groupId: undefined, position: undefined });
    }
    await ctx.db.delete(args.groupId);
  },
});
