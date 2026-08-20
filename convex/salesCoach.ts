import { v, ConvexError } from "convex/values";
import { accountQuery } from "./lib/auth";
import { hasMinRole } from "./lib/roles";

// ============================================================
// Reading coaching.
//
// The visibility rule, enforced here rather than in the UI: a person may
// always read their OWN coaching, and only a supervisor or above may
// read a colleague's. Coaching someone without letting them see it is
// surveillance; letting the whole team read each other's is a different
// product than the one that was asked for.
// ============================================================

const LIMIT = 50;

async function shape(
  ctx: { db: { get: (id: never) => Promise<unknown> } },
  rows: Array<{
    _id: unknown;
    conversationId: unknown;
    subjectUserId: unknown;
    observations: unknown;
    strengths: unknown;
    firstResponseMinutes?: number;
    createdAt: number;
  }>,
) {
  return rows.map((r) => ({
    id: r._id,
    conversationId: r.conversationId,
    subjectUserId: r.subjectUserId,
    observations: r.observations,
    strengths: r.strengths,
    firstResponseMinutes: r.firstResponseMinutes ?? null,
    createdAt: r.createdAt,
  }));
}

/** Your own coaching. Any member may read this — about themselves. */
export const forMe = accountQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("salesCoachNotes")
      .withIndex("by_subject", (q) => q.eq("subjectUserId", ctx.userId))
      .order("desc")
      .take(LIMIT);
    // Belt and braces: the index is on the user, but an account check
    // costs nothing and stops a shared user id crossing tenants.
    const own = rows.filter((r) => r.accountId === ctx.accountId);
    return { notes: await shape(ctx as never, own) };
  },
});

/** Everyone's coaching. Supervisor and above only. */
export const forTeam = accountQuery({
  args: { subjectUserId: v.optional(v.id("users")) },
  handler: async (ctx, args) => {
    if (!hasMinRole(ctx.role, "supervisor")) {
      throw new ConvexError({ code: "FORBIDDEN", min: "supervisor" });
    }

    const rows = args.subjectUserId
      ? await ctx.db
          .query("salesCoachNotes")
          .withIndex("by_subject", (q) => q.eq("subjectUserId", args.subjectUserId!))
          .order("desc")
          .take(LIMIT)
      : await ctx.db
          .query("salesCoachNotes")
          .withIndex("by_account", (q) => q.eq("accountId", ctx.accountId))
          .order("desc")
          .take(LIMIT);

    const scoped = rows.filter((r) => r.accountId === ctx.accountId);

    // Per-person totals, deliberately NOT a score or a ranking: counts
    // of observations by dimension, so a supervisor can see where help
    // is needed without the tool handing out grades.
    const byPerson = new Map<string, { userId: string; reviews: number; observations: number }>();
    for (const r of scoped) {
      const key = r.subjectUserId as unknown as string;
      const cur = byPerson.get(key) ?? { userId: key, reviews: 0, observations: 0 };
      cur.reviews += 1;
      cur.observations += r.observations.length;
      byPerson.set(key, cur);
    }

    return {
      notes: await shape(ctx as never, scoped),
      byPerson: [...byPerson.values()],
    };
  },
});
