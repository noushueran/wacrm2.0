import { accountMutation, accountQuery } from "./lib/auth";
import { internal } from "./_generated/api";
import { v, ConvexError } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { DatabaseReader } from "./_generated/server";
import { hasLintErrors, lintOpsBlock } from "./lib/kb/lint";
import type { OpsBlockInput, OpsKind } from "./lib/kb/types";

// ============================================================
// Knowledge Engine v2 (Phase 1) — structured operational blocks. One
// row per (service, kind) pair in `convex/schema.ts`'s `kbOpsBlocks`
// table: a qualification checklist (weighted criteria), a sales
// checklist (ordered steps), or a purchase-criteria block (conditions
// plus an optional report value/currency). These are the instructions
// live AI engines act on directly — not reference prose like
// `kbEntries` — which is why publishing them is gated harder.
//
// Split lint gate (the rule that distinguishes this module from
// `kbEntries.ts`): `lintOpsBlock` reports both SHAPE problems
// (`label_required`, `key_duplicate`) and COMPLETENESS problems
// (`items_required`, `marks_sum`). `save` only blocks on the shape
// subset (`SHAPE_ERROR_CODES`) so an admin can save a half-finished
// checklist as a draft and come back to it later; `publish` blocks on
// every error-level issue via `hasLintErrors`, because completeness —
// e.g. qualification marks summing to exactly 100 — is exactly what
// must hold before the block goes live to the AI engines.
//
// Identity mirrors `kbServices.ts`'s key-based upsert, but keyed on
// the PAIR `(serviceKey, kind)` via `by_account_service_kind`: there is
// at most one block of each kind per service, so `save` never takes a
// client-supplied row id. `save` always writes `status: "draft"` and
// bumps `version` on an existing row — same rationale as
// `kbEntries.save`: compiled chunks stay pinned to the last published
// version until an explicit `publish`. `publish`/`unpublish` both
// schedule `internal.kbCompile.compileOps`, matching `kbEntries.ts`'s
// own publish/unpublish pairing with `compileEntry`.
// ============================================================

const kindValidator = v.union(
  v.literal("qualification"), v.literal("sales"), v.literal("purchase"));
const criteriaValidator = v.array(v.object({
  key: v.string(), label: v.string(),
  question: v.optional(v.string()), marks: v.optional(v.number()),
}));
const stepsValidator = v.array(v.object({
  key: v.string(), label: v.string(), description: v.optional(v.string()),
}));
const conditionsValidator = v.array(v.object({ key: v.string(), label: v.string() }));

// Shape problems block `save`; completeness problems (items_required,
// marks_sum, …) only block `publish`, so half-finished drafts can save.
const SHAPE_ERROR_CODES = new Set(["label_required", "key_duplicate"]);

function toOpsInput(row: {
  kind: OpsKind;
  criteria?: Doc<"kbOpsBlocks">["criteria"];
  steps?: Doc<"kbOpsBlocks">["steps"];
  conditions?: Doc<"kbOpsBlocks">["conditions"];
  reportValue?: number;
  currency?: string;
}): OpsBlockInput {
  return {
    kind: row.kind, criteria: row.criteria, steps: row.steps,
    conditions: row.conditions, reportValue: row.reportValue, currency: row.currency,
  };
}

/**
 * Loads the (at most one) ops block for a `(serviceKey, kind)` pair,
 * scoped to `accountId` via `by_account_service_kind` — the identity
 * every export below keys off instead of a client-suppliable row id.
 */
async function loadOps(
  db: DatabaseReader,
  accountId: Id<"accounts">,
  serviceKey: string,
  kind: OpsKind,
): Promise<Doc<"kbOpsBlocks"> | null> {
  return await db
    .query("kbOpsBlocks")
    .withIndex("by_account_service_kind", (q) =>
      q.eq("accountId", accountId).eq("serviceKey", serviceKey).eq("kind", kind))
    .unique();
}

/**
 * The ops block for one `(serviceKey, kind)` pair, or `null` if none
 * has been saved yet.
 *
 * Admin+ only, mirroring `aiKnowledge.list`'s gate: ops blocks carry
 * purchase criteria and `reportValue` — internal commercial thresholds
 * in the same class of content that module governs, not the reference
 * data `kbServices.list` exposes. Gating now is free because no UI
 * binds to this yet; tightening it after one does would be a breaking
 * change.
 */
export const get = accountQuery({
  args: { serviceKey: v.string(), kind: kindValidator },
  handler: async (ctx, args) => {
    ctx.requireRole("admin");
    return await loadOps(ctx.db, ctx.accountId, args.serviceKey, args.kind);
  },
});

/**
 * Every ops row for the caller's own account, regardless of service or
 * kind — feeds the Phase-2 service health matrix (which services are
 * missing which block kinds, and which are still draft). Admin+ for the
 * same reason as `get` above: same rows, same purchase criteria and
 * `reportValue`, just unfiltered.
 */
export const listForAccount = accountQuery({
  args: {},
  handler: async (ctx) => {
    ctx.requireRole("admin");
    return await ctx.db
      .query("kbOpsBlocks")
      .withIndex("by_account", (q) => q.eq("accountId", ctx.accountId))
      .collect();
  },
});

/**
 * Admin+ creates or edits the ops block for a `(serviceKey, kind)`
 * pair. `serviceKey` must name an EXISTING `kbServices` row for the
 * caller's account (`NOT_FOUND, entity: "service"`) — Convex has no
 * foreign keys, so this existence check is the only thing stopping an
 * ops block from pointing at a service slug that was never created (or
 * was since deleted).
 *
 * Lint gate here is SHAPE-only (see this module's header comment):
 * `lintOpsBlock` runs, but only its `label_required`/`key_duplicate`
 * error-level issues block the write, via `SHAPE_ERROR_CODES`.
 * Completeness issues (`items_required`, `marks_sum`) are left for
 * `publish` to catch, so a half-finished checklist can be saved as a
 * draft. Always writes `status: "draft"`; an existing row's `version`
 * is bumped by one — same rationale as `kbEntries.save`: compiled
 * chunks stay pinned to the last published version until an explicit
 * `publish`.
 */
export const save = accountMutation({
  args: {
    serviceKey: v.string(),
    kind: kindValidator,
    criteria: v.optional(criteriaValidator),
    steps: v.optional(stepsValidator),
    conditions: v.optional(conditionsValidator),
    reportValue: v.optional(v.number()),
    currency: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    ctx.requireRole("admin");
    const service = await ctx.db
      .query("kbServices")
      .withIndex("by_account_key", (q) =>
        q.eq("accountId", ctx.accountId).eq("key", args.serviceKey))
      .unique();
    if (!service) throw new ConvexError({ code: "NOT_FOUND", entity: "service" });
    const shapeIssues = lintOpsBlock(toOpsInput(args)).filter(
      (i) => i.level === "error" && SHAPE_ERROR_CODES.has(i.code));
    if (shapeIssues.length > 0) {
      throw new ConvexError({ code: "BAD_REQUEST", issues: shapeIssues });
    }
    const existing = await loadOps(ctx.db, ctx.accountId, args.serviceKey, args.kind);
    const fields = {
      criteria: args.criteria,
      steps: args.steps,
      conditions: args.conditions,
      reportValue: args.reportValue,
      currency: args.currency,
      status: "draft" as const,
      updatedAt: Date.now(),
      updatedByUserId: ctx.userId,
    };
    if (existing) {
      await ctx.db.patch(existing._id, { ...fields, version: existing.version + 1 });
      return existing._id;
    }
    return await ctx.db.insert("kbOpsBlocks", {
      accountId: ctx.accountId,
      serviceKey: args.serviceKey,
      kind: args.kind,
      version: 1,
      ...fields,
    });
  },
});

/**
 * Admin+ publishes the ops block for a `(serviceKey, kind)` pair,
 * making it live to the AI engines. Full `lintOpsBlock` gate via
 * `hasLintErrors` — unlike `save`, every error-level issue blocks here
 * (including `items_required`/`marks_sum`), since completeness is
 * exactly what must hold before this becomes live instructions. Sets
 * `status: "published"` + `publishedAt`, then schedules
 * `internal.kbCompile.compileOps` to rebuild the block's `kbChunks`
 * from this now-published version.
 */
export const publish = accountMutation({
  args: { serviceKey: v.string(), kind: kindValidator },
  handler: async (ctx, args) => {
    ctx.requireRole("admin");
    const row = await loadOps(ctx.db, ctx.accountId, args.serviceKey, args.kind);
    if (!row) throw new ConvexError({ code: "NOT_FOUND", entity: "opsBlock" });
    const issues = lintOpsBlock(toOpsInput(row));
    if (hasLintErrors(issues)) throw new ConvexError({ code: "BAD_REQUEST", issues });
    await ctx.db.patch(row._id, { status: "published", publishedAt: Date.now() });
    await ctx.scheduler.runAfter(0, internal.kbCompile.compileOps, { opsBlockId: row._id });
  },
});

/**
 * Admin+ takes a published ops block back to `draft` without editing
 * its content. Also schedules `internal.kbCompile.compileOps` — for a
 * non-published block that action clears the block's chunks, which is
 * exactly what should happen when it leaves published state.
 */
export const unpublish = accountMutation({
  args: { serviceKey: v.string(), kind: kindValidator },
  handler: async (ctx, args) => {
    ctx.requireRole("admin");
    const row = await loadOps(ctx.db, ctx.accountId, args.serviceKey, args.kind);
    if (!row) throw new ConvexError({ code: "NOT_FOUND", entity: "opsBlock" });
    await ctx.db.patch(row._id, { status: "draft" });
    await ctx.scheduler.runAfter(0, internal.kbCompile.compileOps, { opsBlockId: row._id });
  },
});
