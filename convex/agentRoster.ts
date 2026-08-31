import { v, ConvexError } from "convex/values";
import { accountQuery } from "./lib/auth";
import {
  AGENT_REGISTRY,
  deriveAgentStatus,
  resolveAgentState,
  tallyWork,
  type AgentKey,
  type AgentStatus,
} from "./lib/agentRegistry";

// ============================================================
// The agent roster — what every AI agent on this account is, whether it
// is working, and what it has done today.
//
// Deliberately MEMBER-safe (no `ctx.requireRole`): it exposes agent
// identity, on/off state, and activity counts, the same trust level as
// `aiConfig.get`, which is member-visible so every role's inbox banner
// can reflect whether AI is on. It exposes no keys, prompts, models, or
// token counts — those stay behind the admin-gated `aiConfig.getFull`
// and `aiUsage.summary`. The `/agents` route is still admin-only, so
// this has no member-facing surface yet; built this way so a future
// inbox widget needs no re-gating.
//
// Every read is bounded. This is a live subscription over tables the
// engines write constantly — see `lib/cronSummary.ts`'s
// `SYSTEM_SCAN_WINDOW` for what the unbounded version cost this
// deployment in production on 2026-07-18. Work counts come from the
// hourly rollup rather than the raw usage log, which makes them bounded
// by the DAY (24 documents) instead of by traffic, and exact besides.
// ============================================================

interface RosterAgent {
  key: AgentKey;
  name: string;
  duty: string;
  status: AgentStatus;
  workToday: number;
  blockedReason: string | null;
  notHiredReason: string | null;
}

/**
 * Midnight UTC today. Account-local day boundaries are deliberately not
 * modeled: this is the same bound `aiUsage`'s own windows use, and the
 * roster's claim is "today's work", not "work since your local
 * midnight" — a distinction nobody reading a status board is relying on.
 *
 * It is also, conveniently, exactly an hour boundary, which is what lets
 * the `aiUsageHourlyStats` read below range on it directly with no
 * partial-hour guard — unlike `aiUsage.summary`, whose caller-supplied
 * `sinceMs` can land mid-hour and needs `hourStartMs()` first.
 */
function startOfTodayMs(now: number): number {
  return new Date(new Date(now).toISOString().slice(0, 10)).getTime();
}

/**
 * At most 24 UTC hours can start on or after midnight UTC today, so this
 * bound is exact rather than defensive. It stays a `.take()` anyway:
 * every read in this query is bounded, and here the bound documents the
 * arithmetic instead of hiding a truncation — which is what the 1024-row
 * cap it replaced had quietly become.
 */
const HOURS_PER_DAY = 24;

export const roster = accountQuery({
  args: {},
  handler: async (
    ctx,
  ): Promise<{ agents: RosterAgent[] }> => {
    const [aiConfig, qualConfig, leadConfig, revivalConfig, kbGapConfig, coachConfig] = await Promise.all([
      ctx.db
        .query("aiConfigs")
        .withIndex("by_account", (q) => q.eq("accountId", ctx.accountId))
        .first(),
      ctx.db
        .query("qualificationConfigs")
        .withIndex("by_account", (q) => q.eq("accountId", ctx.accountId))
        .first(),
      ctx.db
        .query("leadAnalysisConfigs")
        .withIndex("by_account", (q) => q.eq("accountId", ctx.accountId))
        .first(),
      ctx.db
        .query("revivalConfigs")
        .withIndex("by_account", (q) => q.eq("accountId", ctx.accountId))
        .first(),
      ctx.db
        .query("kbGapConfigs")
        .withIndex("by_account", (q) => q.eq("accountId", ctx.accountId))
        .first(),
      ctx.db
        .query("salesCoachConfigs")
        .withIndex("by_account", (q) => q.eq("accountId", ctx.accountId))
        .first(),
    ]);

    // Bounded AND exact: the rollup counted these calls at write time, so
    // today is at most 24 documents no matter how busy the account is.
    // The raw-log version this replaces needed a 1024-row cap that this
    // account tripped every morning, freezing the count on the earliest
    // quarter of the day — see
    // `docs/superpowers/specs/2026-08-09-roster-hourly-rollup-design.md`.
    const sinceMs = startOfTodayMs(Date.now());
    const hours = await ctx.db
      .query("aiUsageHourlyStats")
      .withIndex("by_account_hour", (q) =>
        q.eq("accountId", ctx.accountId).gte("hourStartMs", sinceMs),
      )
      .take(HOURS_PER_DAY);
    const work = tallyWork(hours.flatMap((h) => h.modes));

    // One single-document read per cron an agent claims — never a scan.
    const cronNames = [
      ...new Set(
        AGENT_REGISTRY.map((a) => a.cronName).filter(
          (n): n is string => n !== null,
        ),
      ),
    ];
    const lastRuns = new Map<string, "running" | "success" | "failed">();
    for (const name of cronNames) {
      const last = await ctx.db
        .query("cronRuns")
        .withIndex("by_name", (q) => q.eq("name", name))
        .order("desc")
        .first();
      if (last) lastRuns.set(name, last.status);
    }

    const adTokenMissing = !process.env.META_ADS_ACCESS_TOKEN;

    const configState = {
      aiConfigured: aiConfig !== null,
      aiActive: !!aiConfig?.isActive,
      autoReplyEnabled: !!aiConfig?.autoReplyEnabled,
      qualConfigured: qualConfig !== null,
      qualEnabled: !!qualConfig?.enabled,
      leadConfigured: leadConfig !== null,
      leadEnabled: !!leadConfig?.enabled,
      revivalConfigured: revivalConfig !== null,
      revivalEnabled: !!revivalConfig?.enabled,
      kbGapConfigured: kbGapConfig !== null,
      kbGapEnabled: !!kbGapConfig?.enabled,
      coachConfigured: coachConfig !== null,
      coachEnabled: !!coachConfig?.enabled,
      adTokenMissing,
    };

    const agents: RosterAgent[] = AGENT_REGISTRY.map((entry) => {
      // Shared with `detail` below — two copies of these rules is how a
      // board and a detail panel come to disagree.
      const { configured, enabled, blockedReason } = resolveAgentState(
        entry.key,
        configState,
      );

      const status = deriveAgentStatus({
        built: entry.built,
        configured,
        enabled,
        onDemand: entry.onDemand,
        lastRunStatus: entry.cronName
          ? (lastRuns.get(entry.cronName) ?? null)
          : null,
        blockedReason,
      });

      return {
        key: entry.key,
        name: entry.name,
        duty: entry.duty,
        status,
        workToday: work[entry.key],
        // Only surface a blocker when it is actually what is wrong: a
        // switched-off agent's blocker is noise, not news.
        blockedReason: status === "attention" ? blockedReason : null,
        notHiredReason: status === "not_hired" ? entry.notHiredReason : null,
      };
    });

    return { agents };
  },
});

/**
 * Everything the agent window shows for ONE agent.
 *
 * Member-safe like `roster`, and carrying the same trust level: registry
 * prose, live counters, and on/off state — never a key, a raw prompt, or
 * a token count.
 *
 * `enabled` is `null` rather than `false` for an agent with no switch of
 * its own. The difference is the whole point of the window's honesty
 * rule: `false` would render a toggle that, when flipped, would silently
 * write a DIFFERENT agent's setting. `null` renders `dependsOn` instead.
 */
export const detail = accountQuery({
  args: { agentKey: v.string() },
  handler: async (ctx, args) => {
    const entry = AGENT_REGISTRY.find((a) => a.key === args.agentKey);
    if (!entry) throw new ConvexError({ code: "NOT_FOUND", entity: "agent" });

    const [aiConfig, qualConfig, leadConfig, revivalConfig, kbGapConfig, coachConfig] = await Promise.all([
      ctx.db
        .query("aiConfigs")
        .withIndex("by_account", (q) => q.eq("accountId", ctx.accountId))
        .first(),
      ctx.db
        .query("qualificationConfigs")
        .withIndex("by_account", (q) => q.eq("accountId", ctx.accountId))
        .first(),
      ctx.db
        .query("leadAnalysisConfigs")
        .withIndex("by_account", (q) => q.eq("accountId", ctx.accountId))
        .first(),
      ctx.db
        .query("revivalConfigs")
        .withIndex("by_account", (q) => q.eq("accountId", ctx.accountId))
        .first(),
      ctx.db
        .query("kbGapConfigs")
        .withIndex("by_account", (q) => q.eq("accountId", ctx.accountId))
        .first(),
      ctx.db
        .query("salesCoachConfigs")
        .withIndex("by_account", (q) => q.eq("accountId", ctx.accountId))
        .first(),
    ]);

    const { configured, enabled, blockedReason } = resolveAgentState(entry.key, {
      aiConfigured: aiConfig !== null,
      aiActive: !!aiConfig?.isActive,
      autoReplyEnabled: !!aiConfig?.autoReplyEnabled,
      qualConfigured: qualConfig !== null,
      qualEnabled: !!qualConfig?.enabled,
      leadConfigured: leadConfig !== null,
      leadEnabled: !!leadConfig?.enabled,
      revivalConfigured: revivalConfig !== null,
      revivalEnabled: !!revivalConfig?.enabled,
      kbGapConfigured: kbGapConfig !== null,
      kbGapEnabled: !!kbGapConfig?.enabled,
      coachConfigured: coachConfig !== null,
      coachEnabled: !!coachConfig?.enabled,
      adTokenMissing: !process.env.META_ADS_ACCESS_TOKEN,
    });

    const lastRunRow = entry.cronName
      ? await ctx.db
          .query("cronRuns")
          .withIndex("by_name", (q) => q.eq("name", entry.cronName!))
          .order("desc")
          .first()
      : null;

    const status = deriveAgentStatus({
      built: entry.built,
      configured,
      enabled,
      onDemand: entry.onDemand,
      lastRunStatus: lastRunRow?.status ?? null,
      blockedReason,
    });

    // Same bounded, exact read as `roster` — at most 24 rollup rows. This
    // query shipped while the row-scanning version was still in `roster`
    // and inherited its 1024-row cap, so it reported the same truncated
    // count for the SAME agent the roster list was already understating.
    const sinceMs = startOfTodayMs(Date.now());
    const hours = await ctx.db
      .query("aiUsageHourlyStats")
      .withIndex("by_account_hour", (q) =>
        q.eq("accountId", ctx.accountId).gte("hourStartMs", sinceMs),
      )
      .take(HOURS_PER_DAY);

    return {
      key: entry.key,
      name: entry.name,
      duty: entry.duty,
      status,
      instructions: entry.instructions,
      trigger: entry.trigger,
      reads: entry.reads,
      writes: entry.writes,
      // Only agents that own a switch report one. See the doc comment.
      enabled: entry.configKey !== null && entry.built ? enabled : null,
      dependsOn: entry.dependsOn,
      // The window shows the instructions box only where the agent's
      // prompt actually reads it — offering one that does nothing would
      // be worse than offering none.
      supportsExtraInstructions: entry.supportsExtraInstructions,
      workToday: tallyWork(hours.flatMap((h) => h.modes))[entry.key],
      blockedReason: status === "attention" ? blockedReason : null,
      notHiredReason: status === "not_hired" ? entry.notHiredReason : null,
      lastRun: lastRunRow
        ? { status: lastRunRow.status, startedAt: lastRunRow.startedAt }
        : null,
    };
  },
});
