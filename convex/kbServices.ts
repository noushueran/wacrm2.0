import { accountMutation, accountQuery } from "./lib/auth";
import { v, ConvexError } from "convex/values";
import { hasLintErrors, lintServiceInput } from "./lib/kb/lint";

// ============================================================
// Knowledge Engine v2 (Phase 1) — service registry. One row per
// service line the business sells (e.g. "UAE Visa Services"), each
// with an immutable `key` slug, a display `name`, and free-text
// `aliases` the retrieval/routing layer matches against. `convex/
// schema.ts`'s `kbServices` table; sibling tables `kbEntries` and
// `kbOpsBlocks` reference a service by its `key` (a string, not a
// Convex `Id`, since services are looked up by slug from outside the
// DB — e.g. an LLM prompt or an inbound routing tag).
//
// Shape: `list` is a plain `accountQuery` (any member may read — it's
// reference data the UI needs everywhere, not sensitive), while
// `upsert`/`remove` are admin-gated, matching `aiKnowledge.ts`'s own
// split between read and write trust levels for knowledge-base
// content.
// ============================================================

/**
 * Every service for the caller's own account, sorted by `sortOrder`
 * (ties broken alphabetically by `name`) — the display order the
 * settings UI and any service picker should use. Any account member
 * may read this; it's reference data, not sensitive configuration.
 */
export const list = accountQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("kbServices")
      .withIndex("by_account", (q) => q.eq("accountId", ctx.accountId))
      .collect();
    return rows.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
  },
});

/**
 * Admin+ creates or edits a service. `key` is the service's immutable
 * identity: when a row with this `key` already exists (scoped to the
 * caller's account via `by_account_key`), this PATCHES it — `key`
 * itself is never rewritten, only `name`/`aliases`/etc; when it
 * doesn't exist yet, this INSERTs a new row. Lint runs either way
 * (`lintServiceInput`), with `existingKeys` deliberately excluding the
 * row being patched (`existing ? [] : siblings.map(...)`) so a save
 * that doesn't touch `key` never gets rejected for colliding with
 * itself.
 */
export const upsert = accountMutation({
  args: {
    key: v.string(),
    name: v.string(),
    aliases: v.array(v.string()),
    routingTagName: v.optional(v.string()),
    relatedServiceKeys: v.optional(v.array(v.string())),
    status: v.optional(v.union(v.literal("active"), v.literal("paused"))),
    sortOrder: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    ctx.requireRole("admin");
    const existing = await ctx.db
      .query("kbServices")
      .withIndex("by_account_key", (q) => q.eq("accountId", ctx.accountId).eq("key", args.key))
      .unique();
    const siblings = await ctx.db
      .query("kbServices")
      .withIndex("by_account", (q) => q.eq("accountId", ctx.accountId))
      .collect();
    const issues = lintServiceInput({
      key: args.key,
      name: args.name,
      aliases: args.aliases,
      existingKeys: existing ? [] : siblings.map((s) => s.key),
    });
    if (hasLintErrors(issues)) throw new ConvexError({ code: "BAD_REQUEST", issues });
    const fields = {
      name: args.name,
      aliases: args.aliases,
      routingTagName: args.routingTagName,
      relatedServiceKeys: args.relatedServiceKeys,
      status: args.status ?? ("active" as const),
      sortOrder: args.sortOrder ?? existing?.sortOrder ?? siblings.length,
      updatedAt: Date.now(),
    };
    if (existing) {
      await ctx.db.patch(existing._id, fields);
      return existing._id;
    }
    return await ctx.db.insert("kbServices", {
      accountId: ctx.accountId,
      key: args.key,
      createdByUserId: ctx.userId,
      ...fields,
    });
  },
});

/**
 * Admin+ deletes a service, but only once nothing still references its
 * `key` — Convex has no foreign keys, so referential integrity across
 * `kbEntries`/`kbOpsBlocks` is enforced here in application code. A
 * single `.first()` probe per table is enough: existence, not count,
 * is all `remove` needs to decide.
 */
export const remove = accountMutation({
  args: { key: v.string() },
  handler: async (ctx, args) => {
    ctx.requireRole("admin");
    const row = await ctx.db
      .query("kbServices")
      .withIndex("by_account_key", (q) => q.eq("accountId", ctx.accountId).eq("key", args.key))
      .unique();
    if (!row) throw new ConvexError({ code: "NOT_FOUND", entity: "service" });
    const entry = await ctx.db
      .query("kbEntries")
      .withIndex("by_account_service", (q) =>
        q.eq("accountId", ctx.accountId).eq("serviceKey", args.key))
      .first();
    const ops = await ctx.db
      .query("kbOpsBlocks")
      .withIndex("by_account_service_kind", (q) =>
        q.eq("accountId", ctx.accountId).eq("serviceKey", args.key))
      .first();
    if (entry || ops) throw new ConvexError({ code: "BAD_REQUEST", reason: "service_in_use" });
    await ctx.db.delete(row._id);
  },
});
