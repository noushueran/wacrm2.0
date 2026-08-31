import { v, ConvexError } from "convex/values";
import { accountMutation } from "./lib/auth";
import { AGENT_REGISTRY } from "./lib/agentRegistry";
import { DEFAULT_REVIVAL_CONFIG } from "./lib/revival/select";
import { DEFAULT_KB_GAP_CONFIG } from "./lib/kbGap/select";
import { DEFAULT_SALES_COACH_CONFIG } from "./lib/salesCoach/select";

// ============================================================
// One switch for every agent that owns one.
//
// The alternative — the window calling `aiConfig.upsert`,
// `qualification`'s own mutation, `leadAnalysis.updateConfig` and
// `revivalConfig.update` depending on which row it rendered — would put
// the "which config governs which agent" rules in the browser, where
// they would drift from `resolveAgentState`. The registry already knows
// via `configKey`; this dispatches on it.
//
// Admin-gated: these decide whether customers get messaged.
// ============================================================

export const setEnabled = accountMutation({
  args: { agentKey: v.string(), enabled: v.boolean() },
  handler: async (ctx, args) => {
    ctx.requireRole("admin");

    const entry = AGENT_REGISTRY.find((a) => a.key === args.agentKey);
    if (!entry) throw new ConvexError({ code: "NOT_FOUND", entity: "agent" });
    if (!entry.built) {
      throw new ConvexError({ code: "NOT_BUILT", agent: entry.key });
    }
    // The honesty rule, enforced server-side too: an agent with no
    // switch of its own must not be toggled THROUGH this endpoint into
    // silently rewriting a different agent's config.
    if (entry.configKey === null) {
      throw new ConvexError({
        code: "NO_OWN_SWITCH",
        agent: entry.key,
        controlledBy: entry.dependsOn?.label ?? null,
      });
    }

    const now = Date.now();

    switch (entry.configKey) {
      case "aiConfigs": {
        const row = await ctx.db
          .query("aiConfigs")
          .withIndex("by_account", (q) => q.eq("accountId", ctx.accountId))
          .first();
        // Cannot create one here: `aiConfigs.apiKey` is required and this
        // endpoint has no key to store. Setup owns creation.
        if (!row) throw new ConvexError({ code: "NOT_CONFIGURED", agent: entry.key });
        // Turning the reply agent OFF leaves `isActive` alone, because
        // the tag suggester rides that same flag and switching off
        // auto-reply must not silently disable a colleague's tool.
        await ctx.db.patch(row._id, {
          autoReplyEnabled: args.enabled,
          ...(args.enabled ? { isActive: true } : {}),
          updatedAt: now,
        });
        return;
      }
      case "qualificationConfigs": {
        const row = await ctx.db
          .query("qualificationConfigs")
          .withIndex("by_account", (q) => q.eq("accountId", ctx.accountId))
          .first();
        if (!row) throw new ConvexError({ code: "NOT_CONFIGURED", agent: entry.key });
        await ctx.db.patch(row._id, { enabled: args.enabled });
        return;
      }
      case "leadAnalysisConfigs": {
        const row = await ctx.db
          .query("leadAnalysisConfigs")
          .withIndex("by_account", (q) => q.eq("accountId", ctx.accountId))
          .first();
        if (!row) throw new ConvexError({ code: "NOT_CONFIGURED", agent: entry.key });
        await ctx.db.patch(row._id, { enabled: args.enabled, updatedAt: now });
        return;
      }
      case "salesCoachConfigs": {
        const row = await ctx.db
          .query("salesCoachConfigs")
          .withIndex("by_account", (q) => q.eq("accountId", ctx.accountId))
          .first();
        if (!row) {
          await ctx.db.insert("salesCoachConfigs", {
            accountId: ctx.accountId,
            ...DEFAULT_SALES_COACH_CONFIG,
            enabled: args.enabled,
            updatedAt: now,
          });
          return;
        }
        await ctx.db.patch(row._id, { enabled: args.enabled, updatedAt: now });
        return;
      }
      case "kbGapConfigs": {
        const row = await ctx.db
          .query("kbGapConfigs")
          .withIndex("by_account", (q) => q.eq("accountId", ctx.accountId))
          .first();
        // Creatable from a bare toggle: its defaults are complete and
        // safe, and it sends nothing to customers either way.
        if (!row) {
          await ctx.db.insert("kbGapConfigs", {
            accountId: ctx.accountId,
            ...DEFAULT_KB_GAP_CONFIG,
            enabled: args.enabled,
            updatedAt: now,
          });
          return;
        }
        await ctx.db.patch(row._id, { enabled: args.enabled, updatedAt: now });
        return;
      }
      case "revivalConfigs": {
        const row = await ctx.db
          .query("revivalConfigs")
          .withIndex("by_account", (q) => q.eq("accountId", ctx.accountId))
          .first();
        // This one CAN be created from a bare toggle — its defaults are
        // complete and safe, which is the point of them.
        if (!row) {
          await ctx.db.insert("revivalConfigs", {
            accountId: ctx.accountId,
            ...DEFAULT_REVIVAL_CONFIG,
            enabled: args.enabled,
            updatedAt: now,
          });
          return;
        }
        await ctx.db.patch(row._id, { enabled: args.enabled, updatedAt: now });
        return;
      }
    }
  },
});
