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

export const getById = internalQuery({
  args: { campaignAdId: v.id("campaignAds") },
  handler: async (ctx, args): Promise<Doc<"campaignAds"> | null> =>
    await ctx.db.get(args.campaignAdId),
});

/**
 * Advances a campaignAds row after a `resolveAd` attempt. Only patches the
 * name fields the caller supplied (conditional spread, like
 * attribution.patchResult). `attempts` bumps only on an explicit
 * `bumpAttempts === true` (the error branch). Give-up is implicit: a row at
 * `attempts >= MAX_RESOLVE_ATTEMPTS` simply drops out of `getResolvable`.
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
  },
  handler: async (ctx, args): Promise<void> => {
    const row = await ctx.db.get(args.campaignAdId);
    if (!row) return;
    const patch: Record<string, unknown> = {
      resolveStatus: args.resolveStatus,
    };
    if (args.adName !== undefined) patch.adName = args.adName;
    if (args.adSetId !== undefined) patch.adSetId = args.adSetId;
    if (args.adSetName !== undefined) patch.adSetName = args.adSetName;
    if (args.campaignId !== undefined) patch.campaignId = args.campaignId;
    if (args.campaignName !== undefined) patch.campaignName = args.campaignName;
    if (args.lastError !== undefined) patch.lastError = args.lastError;
    if (args.resolveStatus === "resolved") patch.resolvedAt = Date.now();
    if (args.bumpAttempts === true) patch.attempts = row.attempts + 1;
    await ctx.db.patch(args.campaignAdId, patch);
  },
});

/**
 * Resolves one ad id to its ad/ad set/campaign names via the Marketing
 * API and caches them. Never throws. Dormant (no `META_ADS_ACCESS_TOKEN`)
 * → leave `pending`, no attempt bump (the retry cron resolves it once a
 * token exists). Idempotent: an already-`resolved` row is skipped.
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
    if (!token) return; // dormant

    try {
      const params = new URLSearchParams({
        fields: "name,adset{id,name},campaign{id,name}",
        access_token: token,
      });
      const url = `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(
        row.adId,
      )}?${params.toString()}`;
      const res = await fetch(url);
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Marketing API ${res.status}: ${body.slice(0, 200)}`);
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
        resolveStatus: "error",
        lastError: err instanceof Error ? err.message : String(err),
        bumpAttempts: true,
      });
    }
  },
});

/**
 * Retry candidates for the cron: `pending` OR `error` rows with
 * `attempts < MAX_RESOLVE_ATTEMPTS`, capped at 100. `pending` covers both
 * never-attempted rows and dormant ones skipped for lack of a token — so
 * once a token is configured, the cron picks them up. Each status is
 * queried through the `by_status` index (never a full scan).
 */
export const getResolvable = internalQuery({
  args: {},
  handler: async (ctx): Promise<Doc<"campaignAds">[]> => {
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
    return [...pending, ...errored].slice(0, 100);
  },
});

/**
 * Cron entry point (`convex/crons.ts`): pulls the retry batch and
 * re-schedules `resolveAd` for each. Tiny by design — all resolution
 * logic (dormant/idempotent/error) lives in `resolveAd`.
 */
export const retryResolutions = internalAction({
  args: {},
  handler: async (ctx): Promise<void> => {
    const rows = await ctx.runQuery(internal.campaignAds.getResolvable, {});
    for (const row of rows) {
      await ctx.scheduler.runAfter(0, internal.campaignAds.resolveAd, {
        campaignAdId: row._id,
      });
    }
  },
});
