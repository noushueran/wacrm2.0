import { accountMutation, accountQuery } from "./lib/auth";
import { v, ConvexError } from "convex/values";
import type { Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";

// ============================================================
// Deals — the *operational* (agent+) counterpart to `pipelines.ts`'s
// admin-gated structure. Built on `accountQuery`/`accountMutation`
// (never the raw `query`/`mutation`), mirroring `contacts.ts`/
// `conversations.ts`: `ctx.accountId` always comes from the caller's
// own `memberships` row, never a client-supplied argument. Every write
// re-asserts ownership of every id it's handed — `dealId`, `pipelineId`,
// `stageId`, `contactId` — before touching or referencing it, so a
// cross-account probe can't smuggle another account's row into this
// account's data by supplying its raw id.
// ============================================================

/**
 * Loads a deal and throws `NOT_FOUND` unless it belongs to the
 * caller's own account — same error for "doesn't exist" and "exists
 * but isn't yours" on purpose (mirrors `contacts.ts`'s
 * `requireOwnContact`), so a cross-account probe can't distinguish the
 * two.
 */
async function requireOwnDeal(
  ctx: { db: QueryCtx["db"]; accountId: Id<"accounts"> },
  dealId: Id<"deals">,
) {
  const deal = await ctx.db.get(dealId);
  if (!deal || deal.accountId !== ctx.accountId) {
    throw new ConvexError({ code: "NOT_FOUND", entity: "deal" });
  }
  return deal;
}

/**
 * Loads a pipeline and throws `NOT_FOUND` unless it belongs to the
 * caller's own account. Duplicated from `pipelines.ts` rather than
 * imported, matching this codebase's one-helper-per-file style (see
 * `messages.ts`'s own comment on its `requireOwnConversation` for the
 * same reasoning).
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
 * the caller's own account. Duplicated from `pipelines.ts` — see
 * `requireOwnPipeline` above.
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

/**
 * Throws `NOT_FOUND` unless `contactId` belongs to the caller's own
 * account. Inlined rather than importing `contacts.ts`'s
 * `requireOwnContact` (private/unexported there) — same one-helper-
 * per-file style as every duplicated helper above.
 */
async function requireOwnContact(
  ctx: { db: QueryCtx["db"]; accountId: Id<"accounts"> },
  contactId: Id<"contacts">,
) {
  const contact = await ctx.db.get(contactId);
  if (!contact || contact.accountId !== ctx.accountId) {
    throw new ConvexError({ code: "NOT_FOUND", entity: "contact" });
  }
  return contact;
}

export const listByPipeline = accountQuery({
  args: { pipelineId: v.id("pipelines") },
  handler: async (ctx, args) => {
    await requireOwnPipeline(ctx, args.pipelineId);

    // `by_pipeline` isn't itself account-scoped (see schema.ts), so the
    // match is additionally filtered to `ctx.accountId` — defense-in-
    // depth that doesn't actually change behavior today (the ownership
    // check above already proves `pipelineId` is this caller's own, so
    // no other account's deal could share it), matching
    // `conversations.ts`'s `findOrCreateForContact` treatment of its
    // own non-account-scoped `by_contact` index.
    return await ctx.db
      .query("deals")
      .withIndex("by_pipeline", (q) => q.eq("pipelineId", args.pipelineId))
      .order("desc")
      .filter((q) => q.eq(q.field("accountId"), ctx.accountId))
      .collect();
  },
});

export const create = accountMutation({
  args: {
    title: v.string(),
    value: v.number(),
    currency: v.optional(v.string()),
    contactId: v.optional(v.id("contacts")),
    pipelineId: v.id("pipelines"),
    stageId: v.id("pipelineStages"),
    assignedToUserId: v.optional(v.id("users")),
    notes: v.optional(v.string()),
    expectedCloseDate: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    ctx.requireRole("agent");
    await requireOwnPipeline(ctx, args.pipelineId);
    const stage = await requireOwnStage(ctx, args.stageId);
    // Owning the stage and owning the pipeline are each necessary but
    // not sufficient — a stage from a sibling pipeline in the same
    // account would otherwise pass both individual checks above.
    if (stage.pipelineId !== args.pipelineId) {
      throw new ConvexError({ code: "NOT_FOUND", entity: "stage" });
    }
    if (args.contactId !== undefined) {
      await requireOwnContact(ctx, args.contactId);
    }

    return await ctx.db.insert("deals", {
      accountId: ctx.accountId,
      createdByUserId: ctx.userId,
      pipelineId: args.pipelineId,
      stageId: args.stageId,
      contactId: args.contactId,
      title: args.title,
      value: args.value,
      currency: args.currency,
      notes: args.notes,
      expectedCloseDate: args.expectedCloseDate,
      status: "open",
      assignedToUserId: args.assignedToUserId,
      updatedAt: Date.now(),
    });
  },
});

export const move = accountMutation({
  args: { dealId: v.id("deals"), stageId: v.id("pipelineStages") },
  handler: async (ctx, args) => {
    ctx.requireRole("agent");
    const deal = await requireOwnDeal(ctx, args.dealId);
    const stage = await requireOwnStage(ctx, args.stageId);
    // Reject a stage belonging to a different pipeline than the deal
    // is already in. This also covers a stage from a different
    // account, which `requireOwnStage` above already rejected anyway.
    if (stage.pipelineId !== deal.pipelineId) {
      throw new ConvexError({ code: "NOT_FOUND", entity: "stage" });
    }

    await ctx.db.patch(args.dealId, {
      stageId: args.stageId,
      updatedAt: Date.now(),
    });
    return args.dealId;
  },
});

export const update = accountMutation({
  args: {
    dealId: v.id("deals"),
    title: v.optional(v.string()),
    value: v.optional(v.number()),
    currency: v.optional(v.string()),
    contactId: v.optional(v.id("contacts")),
    assignedToUserId: v.optional(v.id("users")),
    notes: v.optional(v.string()),
    expectedCloseDate: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    ctx.requireRole("agent");
    const { dealId, contactId, ...rest } = args;
    await requireOwnDeal(ctx, dealId);

    // Stage/pipeline changes are intentionally not patchable here —
    // that requires the cross-pipeline-consistency check `move` does;
    // exposing `stageId` in this generic patch would bypass it.
    const patch: Partial<{
      title: string;
      value: number;
      currency: string;
      contactId: Id<"contacts">;
      assignedToUserId: Id<"users">;
      notes: string;
      expectedCloseDate: number;
      updatedAt: number;
    }> = { ...rest };

    if (contactId !== undefined) {
      await requireOwnContact(ctx, contactId);
      patch.contactId = contactId;
    }
    patch.updatedAt = Date.now();

    await ctx.db.patch(dealId, patch);
    return dealId;
  },
});

export const setStatus = accountMutation({
  args: {
    dealId: v.id("deals"),
    status: v.union(v.literal("open"), v.literal("won"), v.literal("lost")),
  },
  handler: async (ctx, args) => {
    ctx.requireRole("agent");
    await requireOwnDeal(ctx, args.dealId);
    await ctx.db.patch(args.dealId, {
      status: args.status,
      updatedAt: Date.now(),
    });
    return args.dealId;
  },
});

export const remove = accountMutation({
  args: { dealId: v.id("deals") },
  handler: async (ctx, args) => {
    ctx.requireRole("agent");
    await requireOwnDeal(ctx, args.dealId);
    await ctx.db.delete(args.dealId);
  },
});
