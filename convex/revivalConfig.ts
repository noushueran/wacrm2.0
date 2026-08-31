import { v, ConvexError } from "convex/values";
import { accountQuery, accountMutation } from "./lib/auth";
import {
  DEFAULT_REVIVAL_CONFIG,
  configPatchError,
} from "./lib/revival/select";

// ============================================================
// Revival agent configuration — one row per account, created on first
// save (the `aiConfigs`/`leadAnalysisConfigs` find-or-patch-else-insert
// idiom). Admin+ only: these numbers decide who gets messaged and how
// often, which is business policy, not an operator preference.
//
// Until a row exists the agent is OFF, because `DEFAULT_REVIVAL_CONFIG
// .enabled` is false and `revivalEngine.enabledAccounts` only returns
// accounts whose stored row says otherwise.
// ============================================================

export const get = accountQuery({
  args: {},
  handler: async (ctx) => {
    ctx.requireRole("admin");
    const row = await ctx.db
      .query("revivalConfigs")
      .withIndex("by_account", (q) => q.eq("accountId", ctx.accountId))
      .unique();
    if (row) {
      return {
        enabled: row.enabled,
        minQuietMinutes: row.minQuietMinutes,
        windowSafetyMinutes: row.windowSafetyMinutes,
        cooldownHours: row.cooldownHours,
        draftsPerRun: row.draftsPerRun,
        dailyDraftCap: row.dailyDraftCap,
        minLeadScore: row.minLeadScore,
        isPersisted: true as const,
      };
    }
    // Never configured: report the defaults so the form has something to
    // render, flagged so the UI can say "not set up yet" honestly.
    return { ...DEFAULT_REVIVAL_CONFIG, isPersisted: false as const };
  },
});

export const update = accountMutation({
  args: {
    enabled: v.optional(v.boolean()),
    minQuietMinutes: v.optional(v.number()),
    windowSafetyMinutes: v.optional(v.number()),
    cooldownHours: v.optional(v.number()),
    draftsPerRun: v.optional(v.number()),
    dailyDraftCap: v.optional(v.number()),
    minLeadScore: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    ctx.requireRole("admin");

    // Bounds live in `lib/revival/select.ts` beside the logic that
    // consumes them, and are enforced HERE rather than in the form: a
    // client-side check is advisory, and these numbers decide who gets
    // a message.
    const bad = configPatchError(args as Record<string, unknown>);
    if (bad) {
      throw new ConvexError({
        code: "BAD_REQUEST",
        reason: `${bad.key} must be ${bad.min}–${bad.max}`,
      });
    }

    const existing = await ctx.db
      .query("revivalConfigs")
      .withIndex("by_account", (q) => q.eq("accountId", ctx.accountId))
      .unique();

    // Only what was actually supplied is written, so toggling `enabled`
    // never silently resets someone's tuned thresholds.
    const patch: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(args)) {
      if (value !== undefined) patch[key] = value;
    }

    if (existing) {
      await ctx.db.patch(existing._id, { ...patch, updatedAt: Date.now() });
      return existing._id;
    }

    return await ctx.db.insert("revivalConfigs", {
      accountId: ctx.accountId,
      ...DEFAULT_REVIVAL_CONFIG,
      ...patch,
      updatedAt: Date.now(),
    });
  },
});
