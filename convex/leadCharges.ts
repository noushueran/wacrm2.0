import { accountQuery } from "./lib/auth";
import { v } from "convex/values";
import { hasMinRole } from "./lib/roles";
import type { Id } from "./_generated/dataModel";

/**
 * Per-agent lead-spend rollup for the Dashboard "Lead spend" card.
 * supervisor+ see every agent; an agent sees only their own row.
 * `from`/`to` (ms) filter over the charge's `_creationTime`. `enabled`
 * is false when the account has no positive lead value (feature off) —
 * the card hides itself.
 */
export const report = accountQuery({
  args: { from: v.optional(v.number()), to: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const account = await ctx.db.get(ctx.accountId);
    const leadValue = account?.leadValue ?? 0;
    const currency = account?.defaultCurrency ?? "USD";
    if (leadValue <= 0) return { enabled: false, currency, rows: [] as const };

    const seeAll = hasMinRole(ctx.role, "supervisor");

    let charges = await ctx.db
      .query("leadCharges")
      .withIndex("by_account", (q) => q.eq("accountId", ctx.accountId))
      .collect();

    if (!seeAll) charges = charges.filter((c) => c.userId === ctx.userId);
    if (args.from !== undefined) charges = charges.filter((c) => c._creationTime >= args.from!);
    if (args.to !== undefined) charges = charges.filter((c) => c._creationTime <= args.to!);

    const byUser = new Map<Id<"users">, { leadCount: number; totalSpent: number }>();
    for (const c of charges) {
      const row = byUser.get(c.userId) ?? { leadCount: 0, totalSpent: 0 };
      row.leadCount += 1;
      row.totalSpent += c.value;
      byUser.set(c.userId, row);
    }

    const rows = await Promise.all(
      [...byUser.entries()].map(async ([userId, agg]) => {
        const m = await ctx.db
          .query("memberships")
          .withIndex("by_user_account", (q) =>
            q.eq("userId", userId).eq("accountId", ctx.accountId),
          )
          .first();
        return { userId, name: m?.fullName ?? "Unknown", ...agg };
      }),
    );
    rows.sort((a, b) => b.totalSpent - a.totalSpent);
    return { enabled: true, currency, rows };
  },
});
