import { v, ConvexError } from "convex/values";
import { accountQuery, accountMutation, } from "./lib/auth";
import { internalQuery } from "./_generated/server";
import { AGENT_REGISTRY, EXTRA_INSTRUCTIONS_MAX } from "./lib/agentRegistry";

// ============================================================
// An account's own extra instructions for one agent, appended to that
// agent's prompt by `withExtraInstructions`.
//
// Admin-gated on write: this changes what customers are told. Readable
// by any member, like the rest of the agent window — knowing what an
// agent has been asked to do is not privileged, changing it is.
// ============================================================

export const get = accountQuery({
  args: { agentKey: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("agentInstructions")
      .withIndex("by_account_agent", (q) =>
        q.eq("accountId", ctx.accountId).eq("agentKey", args.agentKey),
      )
      .first();
    return {
      extraInstructions: row?.extraInstructions ?? "",
      updatedAt: row?.updatedAt ?? null,
      max: EXTRA_INSTRUCTIONS_MAX,
    };
  },
});

/** Server-only read for the engines, which have no user session. */
export const forAgent = internalQuery({
  args: { accountId: v.id("accounts"), agentKey: v.string() },
  handler: async (ctx, args): Promise<string | null> => {
    const row = await ctx.db
      .query("agentInstructions")
      .withIndex("by_account_agent", (q) =>
        q.eq("accountId", args.accountId).eq("agentKey", args.agentKey),
      )
      .first();
    const text = row?.extraInstructions?.trim() ?? "";
    return text ? text : null;
  },
});

export const set = accountMutation({
  args: { agentKey: v.string(), extraInstructions: v.string() },
  handler: async (ctx, args) => {
    ctx.requireRole("admin");

    const entry = AGENT_REGISTRY.find((a) => a.key === args.agentKey);
    if (!entry) throw new ConvexError({ code: "NOT_FOUND", entity: "agent" });
    // Storing instructions for an agent that does not read them would be
    // a promise the product cannot keep.
    if (!entry.supportsExtraInstructions) {
      throw new ConvexError({ code: "NOT_SUPPORTED", agent: entry.key });
    }

    const text = args.extraInstructions.trim();
    if (text.length > EXTRA_INSTRUCTIONS_MAX) {
      throw new ConvexError({
        code: "BAD_REQUEST",
        reason: `Instructions must be ${EXTRA_INSTRUCTIONS_MAX} characters or fewer`,
      });
    }

    const existing = await ctx.db
      .query("agentInstructions")
      .withIndex("by_account_agent", (q) =>
        q.eq("accountId", ctx.accountId).eq("agentKey", args.agentKey),
      )
      .first();

    // Clearing the box removes the row rather than storing "", so an
    // agent returns to a byte-identical prompt instead of carrying an
    // empty customisation forever.
    if (!text) {
      if (existing) await ctx.db.delete(existing._id);
      return;
    }

    if (existing) {
      await ctx.db.patch(existing._id, {
        extraInstructions: text,
        updatedByUserId: ctx.userId,
        updatedAt: Date.now(),
      });
      return;
    }

    await ctx.db.insert("agentInstructions", {
      accountId: ctx.accountId,
      agentKey: args.agentKey,
      extraInstructions: text,
      updatedByUserId: ctx.userId,
      updatedAt: Date.now(),
    });
  },
});
