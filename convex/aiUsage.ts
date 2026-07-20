import { accountQuery } from "./lib/auth";
import { internalMutation } from "./_generated/server";
import { v } from "convex/values";

// ============================================================
// Per-LLM-call token usage log (`convex/schema.ts`'s `aiUsageLog`,
// Convex counterpart to migration 033 / `src/lib/ai/usage.ts`'s
// `logAiUsage`) — append-only, cost visibility on the account's BYO
// provider key. `log` is `internalMutation`, not `accountMutation`:
// there is no user session at the point a usage row is written (the
// Task-3 auto-reply/draft actions call it via
// `ctx.runMutation(internal.aiUsage.log, { accountId, ... })` after a
// provider call completes), so `accountId` is a caller-supplied arg
// here instead of derived from `ctx.accountId` — same shape as
// `automationsEngine.ts`'s `createLog`. `summary` IS `accountQuery`,
// gated `ctx.requireRole("admin")`: raw per-call provider/model/token
// rows are billing-class detail, the same trust level `apiKeys.list`
// was RAISED TO earlier in this branch (`convex/apiKeys.ts`). This
// comment used to claim parity with `apiKeys.list` back when THAT query
// was still open to viewer+ — it was never updated when `apiKeys.list`
// was tightened, so it went stale (whole-branch review Fix 2). `summary`
// now actually enforces the same admin floor server-side instead of
// relying on the client (`ai-usage.tsx`) to skip the query, which was
// UI-only and trivially bypassable by any authenticated member calling
// the query directly.
// ============================================================

/**
 * Best-effort append of one LLM-call's token usage. "Best-effort" here
 * means the one thing `logAiUsage` (the source) checks before ever
 * touching the DB: skip entirely when the provider reported no usage
 * at all (`if (!args.usage) return`) — there's nothing worth a row for.
 * Once that guard passes, this inserts unconditionally; unlike the
 * source (a raw Supabase network call wrapped in try/catch so a
 * transient DB error can't fail the reply the customer is waiting on),
 * a Convex mutation either commits or the whole transaction rolls back,
 * and containing that failure is the CALLING action's job (Task 3's
 * `dispatchInbound` wraps its `ctx.runMutation` calls so usage logging
 * can never take down a reply already sent) — not this mutation's.
 */
export const log = internalMutation({
  args: {
    accountId: v.id("accounts"),
    conversationId: v.optional(v.id("conversations")),
    mode: v.union(
      v.literal("auto_reply"),
      v.literal("draft"),
      v.literal("classify"),
      v.literal("qualify"),
      v.literal("checklist"),
    ),
    provider: v.union(v.literal("openai"), v.literal("anthropic")),
    model: v.string(),
    promptTokens: v.number(),
    completionTokens: v.number(),
    totalTokens: v.number(),
  },
  handler: async (ctx, args) => {
    if (
      args.promptTokens === 0 &&
      args.completionTokens === 0 &&
      args.totalTokens === 0
    ) {
      return;
    }

    await ctx.db.insert("aiUsageLog", {
      accountId: args.accountId,
      conversationId: args.conversationId,
      mode: args.mode,
      provider: args.provider,
      model: args.model,
      promptTokens: args.promptTokens,
      completionTokens: args.completionTokens,
      totalTokens: args.totalTokens,
    });
  },
});

/**
 * Admin+ only (billing-class per-call provider/model/token detail — see
 * the module header above). The caller's own account's usage rows
 * created at/after `sinceMs` — the same "genuine index range scan" idiom `dashboard.ts`'s
 * `conversationsSeries`/`responseTime` use
 * (`.withIndex("by_account", (q) => q.eq("accountId",
 * ctx.accountId).gte("_creationTime", sinceMs))`), relying on
 * `_creationTime` rather than a modeled `createdAt` per the Global
 * Constraints. Returns the raw matching rows (not pre-aggregated):
 * `src/app/api/ai/usage/route.ts`'s totals/by-mode/by-model/daily-
 * bucket breakdown is dashboard-rendering logic that belongs in a
 * future dashboard-integration layer, not this data-layer query —
 * mirrors how `conversationsSeries`'s own raw `messages` scan still
 * needed the SAME kind of caller-side bucketing this query leaves to
 * its own caller.
 */
export const summary = accountQuery({
  args: { sinceMs: v.number() },
  handler: async (ctx, args) => {
    ctx.requireRole("admin");
    return await ctx.db
      .query("aiUsageLog")
      .withIndex("by_account", (q) =>
        q.eq("accountId", ctx.accountId).gte("_creationTime", args.sinceMs),
      )
      .collect();
  },
});
