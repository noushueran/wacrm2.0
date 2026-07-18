import { v } from "convex/values";
import type { FunctionReference } from "convex/server";
import { internalAction, internalMutation } from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { accountQuery } from "./lib/auth";
import {
  clampLimit,
  COMPLETED_CAP,
  COMPLETED_DEFAULT_LIMIT,
  CRON_REGISTRY,
  PENDING_DEFAULT_LIMIT,
  PENDING_SCAN_CAP,
  RUNS_CAP,
  RUNS_DEFAULT_LIMIT,
  summarizeSystemTasks,
  type CronName,
} from "./lib/cronSummary";

// ============================================================
// Cron run history + the Settings → Cron schedules panel.
//
// crons.ts registers the wrapper actions below instead of the targets
// directly, so every execution leaves a cronRuns row (start, finish,
// success/failed + error). The wrappers rethrow after recording — the
// Convex log/dashboard failure signal is unchanged.
//
// Reads are admin-gated: run history is deployment-global
// infrastructure, and the upcoming-work lists (follow-up nudges, lead
// offers) are scoped to the caller's account.
// ============================================================

const RUN_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const PRUNE_BATCH = 50;
const DEFAULT_OFFER_TIMEOUT_MINUTES = 10;
const ERROR_MAX_CHARS = 500;

export const recordStart = internalMutation({
  args: { name: v.string() },
  handler: async (ctx, args) => {
    // Best-effort bounded prune of this cron's old history.
    const cutoff = Date.now() - RUN_RETENTION_MS;
    const stale = await ctx.db
      .query("cronRuns")
      .withIndex("by_name", (q) =>
        q.eq("name", args.name).lt("startedAt", cutoff),
      )
      .take(PRUNE_BATCH);
    for (const row of stale) await ctx.db.delete(row._id);

    return await ctx.db.insert("cronRuns", {
      name: args.name,
      startedAt: Date.now(),
      status: "running",
    });
  },
});

export const recordResult = internalMutation({
  args: {
    runId: v.id("cronRuns"),
    ok: v.boolean(),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.runId);
    if (!row) return;
    await ctx.db.patch(args.runId, {
      finishedAt: Date.now(),
      status: args.ok ? "success" : "failed",
      ...(args.error ? { error: args.error.slice(0, ERROR_MAX_CHARS) } : {}),
    });
  },
});

// Explicit return annotations here and on the wrapper handlers break
// the self-referential type cycle (`internal.cronSchedules.*` inside
// the module that defines it) that otherwise degrades api.d.ts to any.
async function runWrapped(
  ctx: ActionCtx,
  name: CronName,
  target: FunctionReference<"action", "internal", Record<string, never>>,
): Promise<void> {
  const runId: Id<"cronRuns"> = await ctx.runMutation(
    internal.cronSchedules.recordStart,
    { name },
  );
  try {
    await ctx.runAction(target, {});
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await ctx.runMutation(internal.cronSchedules.recordResult, {
      runId,
      ok: false,
      error: message,
    });
    throw err;
  }
  await ctx.runMutation(internal.cronSchedules.recordResult, {
    runId,
    ok: true,
  });
}

export const runRetryAdResolution = internalAction({
  args: {},
  handler: (ctx): Promise<void> =>
    runWrapped(ctx, "retry-ad-resolution", internal.campaignAds.retryResolutions),
});

export const runRetryConversionEvents = internalAction({
  args: {},
  handler: (ctx): Promise<void> =>
    runWrapped(
      ctx,
      "retry-conversion-events",
      internal.conversionEvents.retryConversionEvents,
    ),
});

export const runSweepFollowUps = internalAction({
  args: {},
  handler: (ctx): Promise<void> =>
    runWrapped(
      ctx,
      "qualification-follow-ups",
      internal.qualificationEngine.sweepFollowUps,
    ),
});

export const runSweepLeadOffers = internalAction({
  args: {},
  handler: (ctx): Promise<void> =>
    runWrapped(
      ctx,
      "qualification-lead-offers",
      internal.qualificationEngine.sweepLeadOffers,
    ),
});

export const runStaffLoops = internalAction({
  args: {},
  handler: (ctx): Promise<void> =>
    runWrapped(
      ctx,
      "qualification-staff-loops",
      internal.qualificationEngine.runStaffLoops,
    ),
});

function pickRun(row: Doc<"cronRuns">) {
  return {
    id: row._id,
    name: row.name,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt ?? null,
    durationMs: row.finishedAt ? row.finishedAt - row.startedAt : null,
    status: row.status,
    error: row.error ?? null,
  };
}

export const overview = accountQuery({
  args: { runsLimit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    ctx.requireRole("admin");
    const runsLimit = clampLimit(args.runsLimit, RUNS_DEFAULT_LIMIT, RUNS_CAP);

    const crons = [];
    for (const entry of CRON_REGISTRY) {
      const last = await ctx.db
        .query("cronRuns")
        .withIndex("by_name", (q) => q.eq("name", entry.name))
        .order("desc")
        .first();
      crons.push({
        name: entry.name,
        intervalMinutes: entry.intervalMinutes,
        lastRun: last ? pickRun(last) : null,
        nextRunAt: last ? last.startedAt + entry.intervalMinutes * 60_000 : null,
      });
    }

    // limit + 1 probe row: tells the client whether "Show more" has
    // anything left to reveal without reading the whole history.
    const runRows = await ctx.db
      .query("cronRuns")
      .order("desc")
      .take(runsLimit + 1);
    const recentRuns = runRows.slice(0, runsLimit).map(pickRun);
    const recentRunsOverflow = runRows.length > runsLimit;

    const config = await ctx.db
      .query("qualificationConfigs")
      .withIndex("by_account", (q) => q.eq("accountId", ctx.accountId))
      .unique();

    // Upcoming customer nudges: collecting sessions with an armed
    // nextFollowUpAt, soonest first. Bounded read, small account scale.
    const sessions = await ctx.db
      .query("qualificationSessions")
      .withIndex("by_account_status", (q) =>
        q.eq("accountId", ctx.accountId).eq("status", "collecting"),
      )
      .take(200);
    const dueSessions = sessions
      .filter((s) => s.nextFollowUpAt !== undefined)
      .sort((a, b) => a.nextFollowUpAt! - b.nextFollowUpAt!)
      .slice(0, 20);
    const followUps = [];
    for (const s of dueSessions) {
      const contact = await ctx.db.get(s.contactId);
      followUps.push({
        sessionId: s._id,
        conversationId: s.conversationId,
        contactName: contact?.name ?? contact?.phone ?? "Unknown",
        serviceName: s.serviceName ?? null,
        nextFollowUpAt: s.nextFollowUpAt!,
        followUpsSent: s.followUpsSent,
        maxFollowUps: config?.maxFollowUps ?? 4,
      });
    }

    // Lead offers awaiting an agent's YES/NO, with their consent-window
    // expiry (the qualification-lead-offers sweep enforces it).
    const timeoutMinutes =
      config?.offerTimeoutMinutes ?? DEFAULT_OFFER_TIMEOUT_MINUTES;
    const offerRows = await ctx.db
      .query("leadOffers")
      .withIndex("by_account_status", (q) =>
        q.eq("accountId", ctx.accountId).eq("status", "offered"),
      )
      .take(20);
    const offers = [];
    for (const o of offerRows) {
      const agent = await ctx.db.get(o.agentUserId);
      const contact = await ctx.db.get(o.contactId);
      offers.push({
        offerId: o._id,
        agentName: agent?.name ?? o.agentPhone,
        contactName: contact?.name ?? contact?.phone ?? "Unknown",
        offeredAt: o.offeredAt,
        expiresAt: o.offeredAt + timeoutMinutes * 60_000,
      });
    }

    return {
      crons,
      recentRuns,
      recentRunsOverflow,
      followUps,
      offers,
      qualificationEnabled: config?.enabled ?? false,
    };
  },
});

// One-off scheduler jobs (debounced AI replies, retries, fan-outs) from
// the `_scheduled_functions` system table. Separate from `overview`
// because convex-test cannot emulate `ctx.db.system` — the transform
// lives in lib/cronSummary.ts where it is unit-tested.
export const listSystemTasks = accountQuery({
  args: {
    pendingLimit: v.optional(v.number()),
    completedLimit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    ctx.requireRole("admin");
    const pendingLimit = clampLimit(
      args.pendingLimit,
      PENDING_DEFAULT_LIMIT,
      PENDING_SCAN_CAP,
    );
    const completedLimit = clampLimit(
      args.completedLimit,
      COMPLETED_DEFAULT_LIMIT,
      COMPLETED_CAP,
    );

    // Pending/in-progress: filtered across the WHOLE table, not a
    // recency window — long-dated jobs (automation waits, flow
    // timeouts, agent-SLA checks) must never fall out of view just
    // because newer completed rows buried them. Capped at
    // PENDING_SCAN_CAP + 1 result rows so the payload stays bounded;
    // beyond the cap the panel shows "50+".
    const pendingRows = await ctx.db.system
      .query("_scheduled_functions")
      .filter((q) =>
        q.or(
          q.eq(q.field("state.kind"), "pending"),
          q.eq(q.field("state.kind"), "inProgress"),
        ),
      )
      .take(PENDING_SCAN_CAP + 1);

    // Completed: newest-first history. Completed rows dominate the
    // table, so this reads only ~limit + 1 rows before satisfying take.
    const completedRows = await ctx.db.system
      .query("_scheduled_functions")
      .order("desc")
      .filter((q) =>
        q.or(
          q.eq(q.field("state.kind"), "success"),
          q.eq(q.field("state.kind"), "failed"),
        ),
      )
      .take(completedLimit + 1);

    return summarizeSystemTasks({
      pendingRows,
      completedRows,
      pendingLimit,
      completedLimit,
    });
  },
});
