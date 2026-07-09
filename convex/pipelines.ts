import { accountMutation, accountQuery } from "./lib/auth";
import { v, ConvexError } from "convex/values";
import type { Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";

// ============================================================
// Pipelines + stages — the deal board's *structure*. Every mutation
// here is `requireRole("admin")` (changing a pipeline's shape is a
// settings-tier action); the *operational* deal writes agent+ callers
// make against that structure live in `deals.ts`. Built on
// `accountQuery`/`accountMutation` (never the raw `query`/`mutation`),
// mirroring `contacts.ts`: `ctx.accountId` always comes from the
// caller's own `memberships` row, never a client-supplied argument
// (there is no `accountId` field in any args validator below). Every
// write additionally re-checks the target row's own `accountId` before
// mutating it — defense-in-depth that doesn't rely solely on "the
// index we queried by happened to be account-scoped" (matches
// `contacts.ts`'s stated philosophy).
// ============================================================

// Spec-defined seed, ported byte-for-byte (name/color/position) from
// `src/app/(dashboard)/pipelines/page.tsx`'s `SPEC_DEFAULT_STAGES` —
// every new pipeline gets these five stages.
const SPEC_DEFAULT_STAGES = [
  { name: "New Lead", color: "#3b82f6", position: 0 }, // blue
  { name: "Qualified", color: "#eab308", position: 1 }, // yellow
  { name: "Proposal Sent", color: "#f97316", position: 2 }, // orange
  { name: "Negotiation", color: "#8b5cf6", position: 3 }, // purple
  { name: "Won", color: "#22c55e", position: 4 }, // green
];

/**
 * Loads a pipeline and throws `NOT_FOUND` unless it belongs to the
 * caller's own account — the same error for "doesn't exist" and
 * "exists but isn't yours" on purpose (mirrors `contacts.ts`'s
 * `requireOwnContact`), so a cross-account probe can't distinguish the
 * two.
 */
async function requireOwnPipeline(
  ctx: { db: QueryCtx["db"]; accountId: Id<"accounts"> },
  pipelineId: Id<"pipelines">,
) {
  const pipeline = await ctx.db.get(pipelineId);
  if (!pipeline || pipeline.accountId !== ctx.accountId) {
    throw new ConvexError({ code: "NOT_FOUND", entity: "pipeline" });
  }
  return pipeline;
}

/**
 * Loads a pipeline stage and throws `NOT_FOUND` unless it belongs to
 * the caller's own account. `pipelineStages.accountId` is denormalized
 * off `pipelineId` (see schema.ts) specifically so this check never
 * needs a second lookup into `pipelines` — mirrors `requireOwnPipeline`
 * above.
 */
async function requireOwnStage(
  ctx: { db: QueryCtx["db"]; accountId: Id<"accounts"> },
  stageId: Id<"pipelineStages">,
) {
  const stage = await ctx.db.get(stageId);
  if (!stage || stage.accountId !== ctx.accountId) {
    throw new ConvexError({ code: "NOT_FOUND", entity: "stage" });
  }
  return stage;
}

export const list = accountQuery({
  args: {},
  handler: async (ctx) => {
    const pipelines = await ctx.db
      .query("pipelines")
      .withIndex("by_account", (q) => q.eq("accountId", ctx.accountId))
      .collect();

    return await Promise.all(
      pipelines.map(async (pipeline) => {
        const stages = await ctx.db
          .query("pipelineStages")
          .withIndex("by_pipeline", (q) => q.eq("pipelineId", pipeline._id))
          .collect();
        stages.sort((a, b) => a.position - b.position);
        return { ...pipeline, stages };
      }),
    );
  },
});

export const create = accountMutation({
  args: { name: v.string() },
  handler: async (ctx, args) => {
    ctx.requireRole("admin");

    const pipelineId = await ctx.db.insert("pipelines", {
      accountId: ctx.accountId,
      createdByUserId: ctx.userId,
      name: args.name,
    });

    for (const stage of SPEC_DEFAULT_STAGES) {
      await ctx.db.insert("pipelineStages", {
        accountId: ctx.accountId,
        pipelineId,
        name: stage.name,
        color: stage.color,
        position: stage.position,
      });
    }

    return pipelineId;
  },
});

export const addStage = accountMutation({
  args: {
    pipelineId: v.id("pipelines"),
    name: v.string(),
    color: v.string(),
  },
  handler: async (ctx, args) => {
    ctx.requireRole("admin");
    await requireOwnPipeline(ctx, args.pipelineId);

    // Append at max(position)+1 rather than at `existing.length` — a
    // prior `deleteStage` can leave a gap (e.g. 0,1,3,4), and count-
    // based positioning would then collide with a stage that already
    // occupies that position.
    const existing = await ctx.db
      .query("pipelineStages")
      .withIndex("by_pipeline", (q) => q.eq("pipelineId", args.pipelineId))
      .collect();
    const nextPosition =
      existing.length === 0
        ? 0
        : Math.max(...existing.map((s) => s.position)) + 1;

    return await ctx.db.insert("pipelineStages", {
      accountId: ctx.accountId,
      pipelineId: args.pipelineId,
      name: args.name,
      color: args.color,
      position: nextPosition,
    });
  },
});

export const renameStage = accountMutation({
  args: {
    stageId: v.id("pipelineStages"),
    name: v.string(),
    color: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    ctx.requireRole("admin");
    await requireOwnStage(ctx, args.stageId);

    const patch: Partial<{ name: string; color: string }> = {
      name: args.name,
    };
    if (args.color !== undefined) patch.color = args.color;

    await ctx.db.patch(args.stageId, patch);
    return args.stageId;
  },
});

export const reorderStages = accountMutation({
  args: { stageIds: v.array(v.id("pipelineStages")) },
  handler: async (ctx, args) => {
    ctx.requireRole("admin");

    // Validate every id belongs to this account *before* patching any
    // of them — a foreign id partway through the array must leave
    // every stage's position untouched, not partially reordered.
    for (const stageId of args.stageIds) {
      await requireOwnStage(ctx, stageId);
    }
    for (const [index, stageId] of args.stageIds.entries()) {
      await ctx.db.patch(stageId, { position: index });
    }
  },
});

export const deleteStage = accountMutation({
  args: { stageId: v.id("pipelineStages") },
  handler: async (ctx, args) => {
    ctx.requireRole("admin");
    await requireOwnStage(ctx, args.stageId);
    await ctx.db.delete(args.stageId);
  },
});
