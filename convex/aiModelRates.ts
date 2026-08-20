import { accountMutation, accountQuery } from "./lib/auth";
import { v, ConvexError } from "convex/values";

// ============================================================
// Per-model provider rates (`convex/schema.ts`'s `aiModelRates`) — the
// price half of the usage dashboard. `aiUsageLog` records how many
// tokens each call burned; this records what a token costs, so
// `src/components/agents/ai-usage.tsx` can turn one into the other.
//
// Both functions are admin-gated. Rates are billing-class data, the same
// trust level `aiUsage.summary` and `apiKeys.list` already enforce — and
// for the same reason: a client-side-only restriction is cosmetic,
// because any authenticated member can call a Convex function directly.
//
// There is no `remove`. Clearing a rate would silently move a model back
// into the "unpriced" bucket and make historical spend figures drop with
// no explanation; if that is ever wanted it should be an explicit,
// separately-designed action rather than a side effect of a delete button.
// ============================================================

const providerValidator = v.union(v.literal("openai"), v.literal("anthropic"));

/**
 * Admin+ only. Every stored rate for the caller's own account.
 *
 * Returns raw rows; merging them over `src/lib/ai/pricing.ts`'s
 * `DEFAULT_MODEL_RATES` is the caller's job — the same
 * data-layer-returns-rows, caller-shapes-it split `aiUsage.summary`
 * uses for its own aggregation.
 */
export const list = accountQuery({
  args: {},
  handler: async (ctx) => {
    ctx.requireRole("admin");
    return await ctx.db
      .query("aiModelRates")
      .withIndex("by_account", (q) => q.eq("accountId", ctx.accountId))
      .collect();
  },
});

/**
 * Admin+ only. Find-or-patch-else-insert on (accountId, model) — the
 * same one-row-per-key idiom `whatsappConfig.upsert` and
 * `aiConfig.upsert` use, keyed here on the `by_account_model` index.
 *
 * Validates before writing: a negative or non-finite rate would silently
 * corrupt every historical figure on the dashboard, and a blank model id
 * would create a row that can never join to a usage row.
 */
export const upsert = accountMutation({
  args: {
    provider: providerValidator,
    model: v.string(),
    inputPerMTok: v.number(),
    cachedInputPerMTok: v.number(),
    outputPerMTok: v.number(),
  },
  handler: async (ctx, args) => {
    ctx.requireRole("admin");

    const model = args.model.trim();
    if (!model) throw new ConvexError({ code: "INVALID_MODEL" });

    for (const value of [
      args.inputPerMTok,
      args.cachedInputPerMTok,
      args.outputPerMTok,
    ]) {
      if (!Number.isFinite(value) || value < 0) {
        throw new ConvexError({ code: "INVALID_RATE" });
      }
    }

    const fields = {
      provider: args.provider,
      inputPerMTok: args.inputPerMTok,
      cachedInputPerMTok: args.cachedInputPerMTok,
      outputPerMTok: args.outputPerMTok,
      updatedAt: Date.now(),
      updatedByUserId: ctx.userId,
    };

    const existing = await ctx.db
      .query("aiModelRates")
      .withIndex("by_account_model", (q) =>
        q.eq("accountId", ctx.accountId).eq("model", model),
      )
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, fields);
      return existing._id;
    }

    return await ctx.db.insert("aiModelRates", {
      accountId: ctx.accountId,
      model,
      ...fields,
    });
  },
});
