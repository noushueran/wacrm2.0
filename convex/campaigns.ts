import { accountQuery } from "./lib/auth";
import { FUNNEL_STAGE_KEYS } from "./lib/funnel";
import type { Id } from "./_generated/dataModel";

/**
 * Funnel performance overview for the admin dashboard. Admin+ only (exposes
 * account-wide conversion/revenue aggregates — same gate as
 * `attribution.listConversions`). Read-only, account-scoped index scans:
 *  - per-stage funnel counts (distinct conversations reaching each stage) via
 *    `funnelTransitions.by_account_stage`,
 *  - Meta delivery status counts + reported purchase value via
 *    `conversionEvents.by_account_stage`.
 */
export const overview = accountQuery({
  args: {},
  handler: async (ctx) => {
    ctx.requireRole("admin");
    const account = await ctx.db.get(ctx.accountId);
    const currency = account?.defaultCurrency ?? "USD";

    const funnel: { stage: string; count: number }[] = [];
    const meta: Record<string, number> = { sent: 0, pending: 0, unmatched: 0, error: 0, abandoned: 0, total: 0 };
    let purchaseCount = 0;
    let reportedValue = 0;

    for (const stage of FUNNEL_STAGE_KEYS) {
      // Distinct conversations that reached this stage.
      const transitions = await ctx.db
        .query("funnelTransitions")
        .withIndex("by_account_stage", (q) =>
          q.eq("accountId", ctx.accountId).eq("stage", stage),
        )
        .collect();
      const convos = new Set<Id<"conversations">>(transitions.map((t) => t.conversationId));
      funnel.push({ stage, count: convos.size });
      if (stage === "purchased") purchaseCount = convos.size;

      // Meta events seeded for this stage.
      const events = await ctx.db
        .query("conversionEvents")
        .withIndex("by_account_stage", (q) =>
          q.eq("accountId", ctx.accountId).eq("stage", stage),
        )
        .collect();
      for (const ev of events) {
        if (ev.status in meta) meta[ev.status] += 1;
        meta.total += 1;
        if (stage === "purchased" && ev.value !== undefined) reportedValue += ev.value;
      }
    }

    return {
      funnel,
      purchase: { count: purchaseCount, reportedValue, currency },
      meta: {
        sent: meta.sent, pending: meta.pending, unmatched: meta.unmatched,
        error: meta.error, abandoned: meta.abandoned, total: meta.total,
      },
    };
  },
});
