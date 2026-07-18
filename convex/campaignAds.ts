import {
  internalAction,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";

const GRAPH_VERSION = process.env.META_GRAPH_VERSION || "v25.0";
export const MAX_RESOLVE_ATTEMPTS = 5;

/**
 * The transient lane's own budget + backoff — same design as
 * `conversionEvents` (see its constants for the full livelock rationale),
 * scaled to this engine's hourly cron: base one tick, cap a day, give up
 * after 10 (worst case ≈ 6.3 days of trying). Ad names are a cosmetic cache
 * and re-seedable, so a week is generous.
 */
export const MAX_TRANSIENT_RESOLVE_ATTEMPTS = 10;
const TRANSIENT_BACKOFF_BASE_MS = 60 * 60 * 1000; // one cron tick
const TRANSIENT_BACKOFF_CAP_MS = 24 * 60 * 60 * 1000;

function transientBackoffMs(transientAttempts: number): number {
  return Math.min(
    TRANSIENT_BACKOFF_BASE_MS * 2 ** (transientAttempts - 1),
    TRANSIENT_BACKOFF_CAP_MS,
  );
}

/**
 * Delay between each `resolveAd` the retry cron schedules. The cron pulls up
 * to 100 rows and every one is an external Marketing API GET; firing them all
 * at `runAfter(0)` is a 100-call burst that draws 429s from the very backend
 * we're calling. Mirrors `conversionEvents.DELIVER_STAGGER_MS` /
 * `broadcasts.ts` — Convex's scheduler already IS the queue, so a flat
 * per-row interval is all it takes.
 */
const RESOLVE_STAGGER_MS = 100;

/**
 * A 429 or 5xx is the Marketing API telling us to come back later — it says
 * nothing about the row itself, so spending an attempt on it is what would
 * let a burst of our own making walk a live ad to the terminal `"abandoned"`
 * state (its name never resolving again). Carried as its own Error subclass
 * rather than parsed back out of the message text, so the classification
 * can't drift from the status that set it.
 */
class TransientResolveError extends Error {}

/**
 * Everything else with an HTTP status (a 4xx, a malformed body) is the row's
 * own fault: it bumps `attempts` and can legitimately exhaust the budget and
 * give up. A failure with NO status (reset/timeout — the fetch itself threw)
 * is wrapped as transient at the call site, exactly as `conversionEvents`
 * does: it's the failure mode most likely to be self-inflicted by our own
 * burst.
 */
function resolveError(status: number, message: string): Error {
  return status === 429 || status >= 500
    ? new TransientResolveError(message)
    : new Error(message);
}

/** The fetch call itself threw — no HTTP status to classify on. Transient. */
function networkError(err: unknown): TransientResolveError {
  return new TransientResolveError(
    `network: ${err instanceof Error ? err.message : String(err)}`,
  );
}

/**
 * The `patchResolution` args a failed attempt should write. Transient
 * failures re-queue as `"error"` without spending `attempts`; they spend
 * `transientAttempts` instead and back off via `nextAttemptAt` (see
 * `patchResolution`), so they neither retire a live ad NOR occupy a retry
 * slot on every cron run forever.
 */
function errorPatchFor(err: unknown): {
  resolveStatus: "error";
  lastError: string;
  bumpAttempts: boolean;
  transient: boolean;
} {
  const transient = err instanceof TransientResolveError;
  return {
    resolveStatus: "error",
    lastError: err instanceof Error ? err.message : String(err),
    bumpAttempts: !transient,
    transient,
  };
}

export const getById = internalQuery({
  args: { campaignAdId: v.id("campaignAds") },
  handler: async (ctx, args): Promise<Doc<"campaignAds"> | null> =>
    await ctx.db.get(args.campaignAdId),
});

/**
 * Advances a campaignAds row after a `resolveAd` attempt. Only patches the
 * name fields the caller supplied (conditional spread, like
 * attribution.patchResult). `attempts` bumps only on an explicit
 * `bumpAttempts === true` — a transient (429/5xx) failure passes `false`
 * (see `errorPatchFor`) so it re-queues without spending budget. An
 * `"error"` bump that reaches `MAX_RESOLVE_ATTEMPTS` is retired to the
 * terminal `"abandoned"` state — the single give-up point — so dead rows
 * leave the retry cron's partition (mirrors `conversionEvents.patchStatus`
 * and `attribution.patchResult`).
 *
 * Giving up by letting the row sit at `attempts >= MAX_RESOLVE_ATTEMPTS` while
 * still tagged `"error"` would be silently unbounded: `getResolvable` reads the
 * whole `"error"` partition and filters on `attempts` afterwards, so every
 * abandoned-but-still-"error" row is re-read on every cron run, forever.
 */
export const patchResolution = internalMutation({
  args: {
    campaignAdId: v.id("campaignAds"),
    resolveStatus: v.union(v.literal("resolved"), v.literal("error")),
    adName: v.optional(v.string()),
    adSetId: v.optional(v.string()),
    adSetName: v.optional(v.string()),
    campaignId: v.optional(v.string()),
    campaignName: v.optional(v.string()),
    lastError: v.optional(v.string()),
    bumpAttempts: v.optional(v.boolean()),
    transient: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<void> => {
    const row = await ctx.db.get(args.campaignAdId);
    if (!row) return;
    const bumping = args.bumpAttempts === true;
    const transient = args.transient === true && args.resolveStatus === "error";
    const nextAttempts = row.attempts + 1;
    const nextTransientAttempts = (row.transientAttempts ?? 0) + 1;
    const resolveStatus =
      bumping &&
      args.resolveStatus === "error" &&
      nextAttempts >= MAX_RESOLVE_ATTEMPTS
        ? ("abandoned" as const)
        : transient && nextTransientAttempts >= MAX_TRANSIENT_RESOLVE_ATTEMPTS
          ? ("abandoned" as const)
          : args.resolveStatus;
    const patch: Record<string, unknown> = { resolveStatus };
    if (args.adName !== undefined) patch.adName = args.adName;
    if (args.adSetId !== undefined) patch.adSetId = args.adSetId;
    if (args.adSetName !== undefined) patch.adSetName = args.adSetName;
    if (args.campaignId !== undefined) patch.campaignId = args.campaignId;
    if (args.campaignName !== undefined) patch.campaignName = args.campaignName;
    if (args.lastError !== undefined) patch.lastError = args.lastError;
    if (args.resolveStatus === "resolved") patch.resolvedAt = Date.now();
    if (bumping) {
      patch.attempts = nextAttempts;
      // A permanent failure is immediately retryable on its own budget —
      // don't let a stale transient gate delay it.
      if (row.nextAttemptAt !== undefined) patch.nextAttemptAt = undefined;
    }
    if (transient) {
      patch.transientAttempts = nextTransientAttempts;
      if (resolveStatus === "error") {
        patch.nextAttemptAt =
          Date.now() + transientBackoffMs(nextTransientAttempts);
      }
    }
    await ctx.db.patch(args.campaignAdId, patch);
  },
});

/**
 * Retires a row that cannot be attempted at all — no `META_ADS_ACCESS_TOKEN`,
 * so there is nothing to call. Spends NO attempt: dormancy is the
 * deployment's state, not the row's fault, and burning retries on it would
 * walk a perfectly resolvable ad to `"abandoned"` the moment a token finally
 * appeared.
 *
 * Leaving such a row `"pending"` instead is what made the retry cron churn:
 * `pending`/`attempts: 0` is exactly `getResolvable`'s predicate, so every
 * run rescheduled a row that could never progress. `conversionEvents` carried
 * the same bug and it accounted for 87% of `_scheduled_functions` on
 * production (19 rows, ~250 reschedules each).
 */
export const retireDormant = internalMutation({
  args: { campaignAdId: v.id("campaignAds"), reason: v.string() },
  handler: async (ctx, args): Promise<void> => {
    const row = await ctx.db.get(args.campaignAdId);
    if (!row) return;
    if (row.resolveStatus === "resolved") return;
    await ctx.db.patch(args.campaignAdId, {
      resolveStatus: "dormant",
      lastError: `dormant: ${args.reason}`,
    });
  },
});

/**
 * Dormant rows, for the cron to revive once a token exists. An unfiltered
 * `by_status` range — no `.filter()`, so the read is bounded by `.take(100)`
 * outright rather than by how many matches happen to be near the front.
 *
 * That is the payoff of giving dormancy its own status instead of parking it
 * in `"abandoned"` alongside genuinely-given-up rows and separating them with
 * `attempts < MAX_RESOLVE_ATTEMPTS` (which is what
 * `conversionEvents.getDormantToSweep` does, and which its own comment notes
 * would be cleaner this way). Given-up rows never leave their partition, so a
 * filtered read over it degrades exactly as this table's `getResolvable` once
 * did.
 */
export const getDormantToSweep = internalQuery({
  args: {},
  handler: async (ctx): Promise<Doc<"campaignAds">[]> =>
    await ctx.db
      .query("campaignAds")
      .withIndex("by_status", (q) => q.eq("resolveStatus", "dormant"))
      .take(100),
});

/**
 * Resolves one ad id to its ad/ad set/campaign names via the Marketing
 * API and caches them. Never throws. Dormant (no `META_ADS_ACCESS_TOKEN`)
 * → `retireDormant`, which the cron re-sweeps once a token is configured.
 * Idempotent: an already-`resolved` row is skipped.
 */
export const resolveAd = internalAction({
  args: { campaignAdId: v.id("campaignAds") },
  handler: async (ctx, args): Promise<void> => {
    const row = await ctx.runQuery(internal.campaignAds.getById, {
      campaignAdId: args.campaignAdId,
    });
    if (!row) return;
    if (row.resolveStatus === "resolved") return;

    const token = process.env.META_ADS_ACCESS_TOKEN;
    if (!token) {
      await ctx.runMutation(internal.campaignAds.retireDormant, {
        campaignAdId: args.campaignAdId,
        reason: "META_ADS_ACCESS_TOKEN unset",
      });
      return;
    }

    try {
      const params = new URLSearchParams({
        fields: "name,adset{id,name},campaign{id,name}",
        access_token: token,
      });
      const url = `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(
        row.adId,
      )}?${params.toString()}`;
      let res: Response;
      try {
        res = await fetch(url);
      } catch (err) {
        throw networkError(err);
      }
      if (!res.ok) {
        const body = await res.text();
        throw resolveError(
          res.status,
          `Marketing API ${res.status}: ${body.slice(0, 200)}`,
        );
      }
      const data = (await res.json()) as {
        name?: string;
        adset?: { id?: string; name?: string };
        campaign?: { id?: string; name?: string };
      };
      await ctx.runMutation(internal.campaignAds.patchResolution, {
        campaignAdId: args.campaignAdId,
        resolveStatus: "resolved",
        adName: data.name,
        adSetId: data.adset?.id,
        adSetName: data.adset?.name,
        campaignId: data.campaign?.id,
        campaignName: data.campaign?.name,
      });
    } catch (err) {
      await ctx.runMutation(internal.campaignAds.patchResolution, {
        campaignAdId: args.campaignAdId,
        ...errorPatchFor(err),
      });
    }
  },
});

/**
 * LIVE retry candidates for the cron: `pending` OR `error` rows with
 * `attempts < MAX_RESOLVE_ATTEMPTS`, capped at 100. `pending` means
 * never-attempted only; a row skipped for lack of a token is no longer left
 * here but retired to `"dormant"` by `retireDormant` and revived through
 * `getDormantToSweep`. Leaving it here was the churn bug — the predicate
 * matched it forever while it could never progress.
 *
 * `by_status` bounds each read to one status partition, but the
 * `attempts` test below is a `.filter()`, which does NOT narrow what
 * Convex reads — `.take(100)` stops after 100 *matches*, so a partition
 * full of non-matching rows is walked end to end. What keeps these reads
 * bounded is that both partitions drain: a row that exhausts its attempts
 * is retired to `"abandoned"` by `patchResolution` (see `MAX_RESOLVE_
 * ATTEMPTS`) and so leaves the set scanned here, keeping matches common
 * and `.take(100)` satisfied early. Without that terminal state this query
 * would degrade exactly the way `cronSchedules.listSystemTasks` did.
 */
export const getResolvable = internalQuery({
  args: {},
  handler: async (ctx): Promise<Doc<"campaignAds">[]> => {
    // The `nextAttemptAt` backoff gate is applied in JS over the bounded
    // window, NOT as a query `.filter()` — that would not narrow the scan and
    // would walk the partition end-to-end whenever due rows are rare (the
    // `.filter().take()` trap). A backing-off row shrinking the batch is fine:
    // its gate expires (capped backoff) and its budget is finite, so the
    // window always drains. See `conversionEvents.getPendingToRetry`.
    const now = Date.now();
    const pending = await ctx.db
      .query("campaignAds")
      .withIndex("by_status", (q) => q.eq("resolveStatus", "pending"))
      .filter((q) => q.lt(q.field("attempts"), MAX_RESOLVE_ATTEMPTS))
      .take(100);
    const errored = await ctx.db
      .query("campaignAds")
      .withIndex("by_status", (q) => q.eq("resolveStatus", "error"))
      .filter((q) => q.lt(q.field("attempts"), MAX_RESOLVE_ATTEMPTS))
      .take(100);
    return [...pending, ...errored]
      .filter((row) => (row.nextAttemptAt ?? 0) <= now)
      .slice(0, 100);
  },
});

/**
 * Cron entry point (`convex/crons.ts`): pulls the retry batch and
 * re-schedules `resolveAd` for each. Tiny by design — all resolution
 * logic (dormant/idempotent/error) lives in `resolveAd`.
 *
 * Only an action can read `process.env`, so the dormant sweep is gated here:
 * while no token is configured there is nothing to revive, and asking for
 * the dormant set anyway would just re-retire it every run — the churn this
 * whole mechanism exists to stop. Live rows are still pulled unconditionally;
 * a `pending` row with no token reaches `resolveAd` once, retires itself, and
 * is not seen again until a token appears.
 */
export const retryResolutions = internalAction({
  args: {},
  handler: async (ctx): Promise<void> => {
    const configured = Boolean(process.env.META_ADS_ACCESS_TOKEN);

    const [live, dormant] = await Promise.all([
      ctx.runQuery(internal.campaignAds.getResolvable, {}),
      configured
        ? ctx.runQuery(internal.campaignAds.getDormantToSweep, {})
        : Promise.resolve([] as Doc<"campaignAds">[]),
    ]);

    // Live rows first: a dormant backlog must never crowd them out of the
    // 100-row budget (same ordering rule `getResolvable` applies between its
    // own two partitions, and `conversionEvents.retryConversionEvents`
    // between its).
    const batch = [...live, ...dormant].slice(0, 100);
    for (const [i, row] of batch.entries()) {
      // Staggered, not `runAfter(0)` for all: 100 simultaneous Marketing API
      // GETs is a burst that draws the 429s the transient-error path exists
      // to absorb.
      await ctx.scheduler.runAfter(
        i * RESOLVE_STAGGER_MS,
        internal.campaignAds.resolveAd,
        { campaignAdId: row._id },
      );
    }
  },
});
