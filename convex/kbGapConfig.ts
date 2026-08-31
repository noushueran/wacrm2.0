import { v, ConvexError } from "convex/values";
import { accountQuery, accountMutation } from "./lib/auth";
import { DEFAULT_KB_GAP_CONFIG } from "./lib/kbGap/select";

// ============================================================
// Knowledge gap agent configuration. Admin-gated: it decides what gets
// written into the knowledge base every other agent reads.
// ============================================================

const BOUNDS: Record<string, { min: number; max: number }> = {
  // One entry per run is pointless; a hundred would flood the KB with
  // drafts nobody reviews.
  entriesPerRun: { min: 1, max: 50 },
  // Below ~10 characters nothing is knowledge; above ~500 real answers
  // start being discarded.
  minAnswerChars: { min: 10, max: 500 },
};

export const get = accountQuery({
  args: {},
  handler: async (ctx) => {
    ctx.requireRole("admin");
    const row = await ctx.db
      .query("kbGapConfigs")
      .withIndex("by_account", (q) => q.eq("accountId", ctx.accountId))
      .first();
    if (row) {
      return {
        enabled: row.enabled,
        entriesPerRun: row.entriesPerRun,
        minAnswerChars: row.minAnswerChars,
        isPersisted: true as const,
      };
    }
    return { ...DEFAULT_KB_GAP_CONFIG, isPersisted: false as const };
  },
});

export const update = accountMutation({
  args: {
    enabled: v.optional(v.boolean()),
    entriesPerRun: v.optional(v.number()),
    minAnswerChars: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    ctx.requireRole("admin");

    for (const [key, b] of Object.entries(BOUNDS)) {
      const value = (args as Record<string, unknown>)[key];
      if (value === undefined) continue;
      if (typeof value !== "number" || !Number.isFinite(value) || value < b.min || value > b.max) {
        throw new ConvexError({
          code: "BAD_REQUEST",
          reason: `${key} must be ${b.min}–${b.max}`,
        });
      }
    }

    const patch: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(args)) if (val !== undefined) patch[k] = val;

    const existing = await ctx.db
      .query("kbGapConfigs")
      .withIndex("by_account", (q) => q.eq("accountId", ctx.accountId))
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, { ...patch, updatedAt: Date.now() });
      return existing._id;
    }
    return await ctx.db.insert("kbGapConfigs", {
      accountId: ctx.accountId,
      ...DEFAULT_KB_GAP_CONFIG,
      ...patch,
      updatedAt: Date.now(),
    });
  },
});
