import { accountMutation, accountQuery } from "./lib/auth";
import { internal } from "./_generated/api";
import { v, ConvexError } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { DatabaseReader } from "./_generated/server";
import { hasLintErrors, lintEntryInput } from "./lib/kb/lint";

// ============================================================
// Knowledge Engine v2 (Phase 1) — typed knowledge entries. One row per
// company- or service/package-scoped unit of knowledge (an overview,
// an FAQ, a policy, and so on), stored in `convex/schema.ts`'s
// `kbEntries` table. Compiled retrieval chunks (`kbChunks`, Task 8)
// are derived FROM a published entry, not kept live with it — see the
// draft/publish lifecycle below.
//
// Lifecycle rule: `save` on an EXISTING entry always demotes it to
// `status: "draft"` and bumps `version`, even when nothing but the
// title changed. This is deliberate, not an oversight — compiled
// chunks stay pinned to the last *published* version, so an in-
// progress edit never silently changes what the AI is telling
// customers mid-edit. The editor must explicitly call `publish` to
// make a change live. `publish` re-lints (an entry saved as a valid
// draft can still fail a rule added/tightened later) and schedules
// `internal.kbCompile.compileEntry` to rebuild its chunks;
// `unpublish` schedules the same action because clearing chunks for a
// no-longer-published entry is exactly what that action should do.
//
// Shape mirrors `kbServices.ts`: `list` is a plain `accountQuery`
// (member-readable reference data), `save`/`publish`/`unpublish`/
// `remove` are admin-gated writes. Convex has no foreign keys, so
// `save`'s non-company-scope existence check and `remove`'s inline
// `kbChunks` cascade are both application-level referential
// integrity — the same reasoning `kbServices.remove`'s header comment
// gives for its own in-use guard.
// ============================================================

/**
 * Every entry for the caller's own account, optionally narrowed to one
 * service via `by_account_service` (else the full `by_account` scan).
 *
 * Admin+ only, mirroring `aiKnowledge.list`'s gate: this returns full
 * entry `body` text — including `audience: "internal"` entries never
 * meant for a customer — which is the same class of content that
 * module governs, so it gets the same write-level trust rather than a
 * plain-member read. (`kbServices.list` stays member-readable: names,
 * keys and aliases are genuine reference data with nothing sensitive
 * in them.) Gating now is free because no UI binds to this yet;
 * tightening it after one does would be a breaking change.
 */
export const list = accountQuery({
  args: { serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    ctx.requireRole("admin");
    if (args.serviceKey !== undefined) {
      return await ctx.db.query("kbEntries")
        .withIndex("by_account_service", (q) =>
          q.eq("accountId", ctx.accountId).eq("serviceKey", args.serviceKey))
        .collect();
    }
    return await ctx.db.query("kbEntries")
      .withIndex("by_account", (q) => q.eq("accountId", ctx.accountId))
      .collect();
  },
});

/**
 * Loads an entry and confirms it belongs to `accountId`, throwing
 * `NOT_FOUND` otherwise — the same cross-tenant guard every mutation
 * below needs before touching a caller-supplied `entryId`.
 */
async function requireOwnEntry(
  db: DatabaseReader,
  accountId: Id<"accounts">,
  entryId: Id<"kbEntries">,
): Promise<Doc<"kbEntries">> {
  const row = await db.get(entryId);
  if (!row || row.accountId !== accountId) {
    throw new ConvexError({ code: "NOT_FOUND", entity: "entry" });
  }
  return row;
}

/**
 * Admin+ creates or edits an entry. Lint runs first (`lintEntryInput`)
 * and blocks the write on any error-level issue. A non-`company`
 * scope must name an EXISTING `kbServices` row for the caller's
 * account (`NOT_FOUND, entity: "service"`) — Convex has no foreign
 * keys, so this existence check is the only thing stopping an entry
 * from pointing at a service slug that was never created (or was
 * since deleted).
 *
 * No `entryId` inserts a fresh row at `status: "draft"`, `version: 1`.
 * An `entryId` PATCHES the existing row and — regardless of what
 * changed — always sets `status: "draft"` and `version: row.version +
 * 1`. See this module's header comment for why edits always demote:
 * compiled chunks stay pinned to the last published version until an
 * explicit `publish`.
 */
export const save = accountMutation({
  args: {
    entryId: v.optional(v.id("kbEntries")),
    scope: v.union(v.literal("company"), v.literal("service"), v.literal("package")),
    serviceKey: v.optional(v.string()),
    packageKey: v.optional(v.string()),
    type: v.union(
      v.literal("overview"),
      v.literal("faq"),
      v.literal("itinerary"),
      v.literal("requirements"),
      v.literal("policy"),
      v.literal("process"),
      v.literal("note"),
    ),
    title: v.string(),
    body: v.string(),
    audience: v.union(v.literal("customer"), v.literal("internal")),
  },
  handler: async (ctx, args) => {
    ctx.requireRole("admin");
    const issues = lintEntryInput(args);
    if (hasLintErrors(issues)) throw new ConvexError({ code: "BAD_REQUEST", issues });
    if (args.scope !== "company") {
      const service = await ctx.db.query("kbServices")
        .withIndex("by_account_key", (q) =>
          q.eq("accountId", ctx.accountId).eq("key", args.serviceKey!))
        .unique();
      if (!service) throw new ConvexError({ code: "NOT_FOUND", entity: "service" });
    }
    const fields = {
      scope: args.scope,
      serviceKey: args.scope === "company" ? undefined : args.serviceKey,
      packageKey: args.scope === "package" ? args.packageKey : undefined,
      type: args.type,
      title: args.title,
      body: args.body,
      audience: args.audience,
      updatedAt: Date.now(),
      updatedByUserId: ctx.userId,
    };
    if (args.entryId) {
      const row = await requireOwnEntry(ctx.db, ctx.accountId, args.entryId);
      await ctx.db.patch(args.entryId, {
        ...fields,
        status: "draft" as const,
        version: row.version + 1,
      });
      return args.entryId;
    }
    return await ctx.db.insert("kbEntries", {
      accountId: ctx.accountId,
      status: "draft",
      version: 1,
      ...fields,
    });
  },
});

/**
 * Admin+ publishes an entry, making its content live. Re-lints (an
 * entry saved as a valid draft can still fail a rule added or
 * tightened after the save), sets `status: "published"` +
 * `publishedAt`, then schedules `internal.kbCompile.compileEntry` to
 * rebuild the entry's `kbChunks` from this now-published version.
 */
export const publish = accountMutation({
  args: { entryId: v.id("kbEntries") },
  handler: async (ctx, args) => {
    ctx.requireRole("admin");
    const row = await requireOwnEntry(ctx.db, ctx.accountId, args.entryId);
    const issues = lintEntryInput(row);
    if (hasLintErrors(issues)) throw new ConvexError({ code: "BAD_REQUEST", issues });
    await ctx.db.patch(args.entryId, { status: "published", publishedAt: Date.now() });
    await ctx.scheduler.runAfter(0, internal.kbCompile.compileEntry, { entryId: args.entryId });
  },
});

/**
 * Admin+ takes a published entry back to `draft` without editing its
 * content. Also schedules `internal.kbCompile.compileEntry` — for a
 * non-published entry that action clears the entry's chunks, which is
 * exactly what should happen when it leaves published state.
 */
export const unpublish = accountMutation({
  args: { entryId: v.id("kbEntries") },
  handler: async (ctx, args) => {
    ctx.requireRole("admin");
    await requireOwnEntry(ctx.db, ctx.accountId, args.entryId);
    await ctx.db.patch(args.entryId, { status: "draft" });
    await ctx.scheduler.runAfter(0, internal.kbCompile.compileEntry, { entryId: args.entryId });
  },
});

/**
 * Admin+ permanently deletes an entry. Its `kbChunks` rows are deleted
 * inline via `by_entry` BEFORE the entry itself, rather than left to
 * `compileEntry`'s scheduler — a deleted row can never be compiled, so
 * nothing would ever clean up orphaned chunks otherwise.
 */
export const remove = accountMutation({
  args: { entryId: v.id("kbEntries") },
  handler: async (ctx, args) => {
    ctx.requireRole("admin");
    await requireOwnEntry(ctx.db, ctx.accountId, args.entryId);
    const chunks = await ctx.db.query("kbChunks")
      .withIndex("by_entry", (q) => q.eq("entryId", args.entryId))
      .collect();
    for (const c of chunks) await ctx.db.delete(c._id);
    await ctx.db.delete(args.entryId);
  },
});
