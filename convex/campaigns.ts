import { accountQuery } from "./lib/auth";
import { FUNNEL_STAGE_KEYS } from "./lib/funnel";
import type { Id } from "./_generated/dataModel";

// Rolling window for the funnel-analytics rollup. `overview` scans the
// account's `funnelTransitions` + `conversionEvents`; bounding both to a
// trailing window keeps each read from growing without limit as the account
// ages — the `new_lead` transition scan would otherwise approach one row per
// conversation ever created (the Phase-4-review scale ceiling). Analytics
// therefore reflect the trailing window, not all-time. Read-only: no write
// path changes (setStage/seedNewLead untouched), just the two new
// `by_account` indexes this query range-scans.
export const WINDOW_DAYS = 365;
const WINDOW_MS = WINDOW_DAYS * 24 * 60 * 60 * 1000;

/**
 * Funnel performance overview for the admin dashboard. Admin+ only (exposes
 * account-wide conversion/revenue aggregates — same gate as
 * `attribution.listConversions`). Read-only. Two account-scoped, window-
 * bounded index scans (was 2×7 per-stage scans) bucketed in memory:
 *  - per-stage funnel counts (distinct conversations reaching each stage)
 *    from `funnelTransitions.by_account`,
 *  - Meta delivery status counts + total purchase value from
 *    `conversionEvents.by_account`.
 *
 * `purchase.totalValue` is the sum of every purchased event's value in the
 * window, regardless of Meta delivery `status` — the card is labelled a
 * total, not "reported to Meta" (delivery may be dormant/pending).
 */
export const overview = accountQuery({
  args: {},
  handler: async (ctx) => {
    ctx.requireRole("admin");
    const account = await ctx.db.get(ctx.accountId);
    const currency = account?.defaultCurrency ?? "USD";
    const cutoff = Date.now() - WINDOW_MS;

    // Two account-scoped, window-bounded scans. `by_account` orders by
    // [accountId, _creationTime], so `.gte("_creationTime", cutoff)` is a
    // genuine range bound on the read (not a post-filter).
    const transitions = await ctx.db
      .query("funnelTransitions")
      .withIndex("by_account", (q) =>
        q.eq("accountId", ctx.accountId).gte("_creationTime", cutoff),
      )
      .collect();
    const events = await ctx.db
      .query("conversionEvents")
      .withIndex("by_account", (q) =>
        q.eq("accountId", ctx.accountId).gte("_creationTime", cutoff),
      )
      .collect();

    // Funnel: distinct conversations that reached each stage.
    const convosByStage = new Map<string, Set<Id<"conversations">>>();
    for (const tr of transitions) {
      let set = convosByStage.get(tr.stage);
      if (!set) {
        set = new Set<Id<"conversations">>();
        convosByStage.set(tr.stage, set);
      }
      set.add(tr.conversationId);
    }
    const funnel = FUNNEL_STAGE_KEYS.map((stage) => ({
      stage,
      count: convosByStage.get(stage)?.size ?? 0,
    }));
    const purchaseCount = convosByStage.get("purchased")?.size ?? 0;

    // Meta delivery status counts + total purchase value.
    const meta: Record<string, number> = { sent: 0, pending: 0, unmatched: 0, error: 0, abandoned: 0, total: 0 };
    let totalValue = 0;
    for (const ev of events) {
      if (ev.status in meta) meta[ev.status] += 1;
      meta.total += 1;
      if (ev.stage === "purchased" && ev.value !== undefined) totalValue += ev.value;
    }

    return {
      funnel,
      purchase: { count: purchaseCount, totalValue, currency },
      meta: {
        sent: meta.sent, pending: meta.pending, unmatched: meta.unmatched,
        error: meta.error, abandoned: meta.abandoned, total: meta.total,
      },
      windowDays: WINDOW_DAYS,
    };
  },
});
