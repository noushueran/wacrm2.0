import { v, ConvexError } from "convex/values";
import { accountQuery, accountMutation } from "./lib/auth";
import { DEFAULT_SALES_COACH_CONFIG } from "./lib/salesCoach/select";

// Admin-gated: this decides whether colleagues get written about.
const BOUNDS: Record<string, { min: number; max: number }> = {
  threadsPerRun: { min: 1, max: 100 },
  // Below 3 messages there is no handling to judge.
  minMessages: { min: 3, max: 100 },
  lookbackDays: { min: 1, max: 180 },
};

export const get = accountQuery({
  args: {},
  handler: async (ctx) => {
    ctx.requireRole("admin");
    const row = await ctx.db
      .query("salesCoachConfigs")
      .withIndex("by_account", (q) => q.eq("accountId", ctx.accountId))
      .first();
    if (row) {
      return {
        enabled: row.enabled,
        threadsPerRun: row.threadsPerRun,
        minMessages: row.minMessages,
        lookbackDays: row.lookbackDays,
        isPersisted: true as const,
      };
    }
    return { ...DEFAULT_SALES_COACH_CONFIG, isPersisted: false as const };
  },
});

export const update = accountMutation({
  args: {
    enabled: v.optional(v.boolean()),
    threadsPerRun: v.optional(v.number()),
    minMessages: v.optional(v.number()),
    lookbackDays: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    ctx.requireRole("admin");
    for (const [key, b] of Object.entries(BOUNDS)) {
      const value = (args as Record<string, unknown>)[key];
      if (value === undefined) continue;
      if (typeof value !== "number" || !Number.isFinite(value) || value < b.min || value > b.max) {
        throw new ConvexError({ code: "BAD_REQUEST", reason: `${key} must be ${b.min}–${b.max}` });
      }
    }
    const patch: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(args)) if (val !== undefined) patch[k] = val;

    const existing = await ctx.db
      .query("salesCoachConfigs")
      .withIndex("by_account", (q) => q.eq("accountId", ctx.accountId))
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, { ...patch, updatedAt: Date.now() });
      return existing._id;
    }
    return await ctx.db.insert("salesCoachConfigs", {
      accountId: ctx.accountId,
      ...DEFAULT_SALES_COACH_CONFIG,
      ...patch,
      updatedAt: Date.now(),
    });
  },
});
