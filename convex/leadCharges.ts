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

    // Supervisor+ needs every agent's rows, so it scans the whole
    // account via `by_account`; an agent only ever needs their own rows,
    // so it queries directly via the `(userId, accountId)` `by_user_account`
    // index instead of collecting the whole account and filtering in JS
    // (lead-value fix wave — final review, Fix 5).
    let charges = seeAll
      ? await ctx.db
          .query("leadCharges")
          .withIndex("by_account", (q) => q.eq("accountId", ctx.accountId))
          .collect()
      : await ctx.db
          .query("leadCharges")
          .withIndex("by_user_account", (q) =>
            q.eq("userId", ctx.userId).eq("accountId", ctx.accountId),
          )
          .collect();

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
        // Two-level name fallback, mirroring `accounts.me`'s own
        // `membership.fullName ?? user?.name ?? ...` (lead-value fix
        // wave — final review, Fix 4): the denormalized membership
        // snapshot is preferred, but a removed/nameless agent's
        // historical spend still resolves a real name off `users`
        // rather than immediately falling back to "Unknown".
        const [m, user] = await Promise.all([
          ctx.db
            .query("memberships")
            .withIndex("by_user_account", (q) =>
              q.eq("userId", userId).eq("accountId", ctx.accountId),
            )
            .first(),
          ctx.db.get(userId),
        ]);
        return { userId, name: m?.fullName ?? user?.name ?? "Unknown", ...agg };
      }),
    );
    rows.sort((a, b) => b.totalSpent - a.totalSpent);
    return { enabled: true, currency, rows };
  },
});
