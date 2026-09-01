import { v } from "convex/values";
import { accountQuery } from "./lib/auth";
import { hourStartMs } from "./lib/messageStats";
import { FUNNEL_STAGE_KEYS } from "./lib/funnel";
import {
  foldHoursIntoVolume,
  foldHoursIntoHourOfDay,
  foldHoursIntoResponseSeries,
  foldHoursIntoBilling,
  sumResponseBuckets,
  percentileRange,
  withinTargetRatio,
  emptyPricingCategories,
  PRICING_CATEGORY_KEYS,
  RESPONSE_BUCKET_KEYS,
  STATUS_MIX_CAP,
  AD_ROW_LIMIT,
  AWAITING_SAMPLE_CAP,
  type ReportHourRow,
  type VolumeTotals,
  type BillingTotals,
  emptyStageCounts,
  emptyEventStatusCounts,
  EVENT_STATUS_KEYS,
  ASSIGNMENT_ROW_LIMIT,
  foldAssignmentEvents,
  lifecycleFunnel,
} from "./lib/reportStats";
import { localDayKeyFromMs } from "./lib/dashboardDate";
import type { Id } from "./_generated/dataModel";
import type { DatabaseReader } from "./_generated/server";

// ============================================================
// Reports section — docs/superpowers/specs/2026-08-05-reports-section-
// design.md.
//
// Every query here is supervisor+ and built on `accountQuery` (never the
// raw `query` from `_generated/server` — see that file's own header for
// the three guarantees this buys: UNAUTHENTICATED / NO_ACCOUNT / a
// trustworthy `ctx.accountId`), so `ctx.accountId` always comes from the
// caller's own `memberships` row and never from a client-supplied
// argument — there is no `accountId` field in any args validator below.
// Every query returns AGGREGATES — no phone numbers, no per-contact rows
// — which is what makes supervisor the right floor rather than admin: a
// supervisor already sees strictly more in the inbox
// (`conversationScope("supervisor") === "all"`), the same rationale
// `campaigns.overview`'s doc comment gives for its own supervisor gate.
//
// READ-BOUNDEDNESS IS THE POINT OF THIS FILE. `/dashboard` was taken down
// twice in production by analytics queries that `.collect()`ed a table
// bounded only by a time window — see `lib/messageStats.ts`'s header for
// the numbers (a `.collect()` over the message window broke at ~137
// msg/day on the default 30-day view, ~45 msg/day on the 90-day one). So:
//   - `volume` reads `messageHourlyStats` only, never raw `messages` — its
//     cost is 24 rows per day of WINDOW regardless of traffic;
//   - `conversationStatusMix` is a current-state count with no window to
//     bound it, so its bound is a `.take()` per bucket instead — each one
//     verified below (and in `reports.test.ts`) to be a genuine bound
//     rather than a filter that can silently starve;
//   - `adPerformance` window-bounds its two event-log scans (`adReferrals`,
//     `funnelTransitions`) on both edges, same as `readHours` below — but
//     is the one query in this file whose read cost grows with ad-click
//     VOLUME within that window rather than being pinned by the window
//     alone. The `AD_ROW_LIMIT` cap on its OUTPUT (not the read itself) is
//     the accepted v1 bound — see that constant's own doc comment;
//   - `responsePerformance` reads `messageHourlyStats` only, exactly like
//     `volume` — the same table, the same `readHours` window bound on
//     BOTH edges, so its cost is pinned by WINDOW length, not by reply
//     traffic. `byHourOfDay` pools every row `readHours` returns with no
//     further `keys` restriction, same shape as `volume`'s `hourOfDay`, so
//     it depends on that same upper bound for the same reason — see
//     `readHours`'s own doc comment;
//   - `awaitingReplyAges` is a current-state count, like
//     `conversationStatusMix`, so its bound is a `.take()` instead of a
//     window — on `by_account_lane_last_message`'s awaiting-reply
//     partition, verified below (and in `reports.test.ts`) to be a
//     genuine range rather than a filter that can silently starve;
//   - `funnelOverview` window-bounds its two event-log scans
//     (`funnelTransitions`, `conversionEvents`) on both edges, the same
//     shape `adPerformance` uses for its own two — and for the same
//     reason: both scans bucket EVERY row they are handed straight into
//     `funnel`/`meta` with no further `keys`-style filter, so an
//     unbounded upper read would corrupt those counts, not just cost
//     extra reads. See `adPerformance`'s own doc comment;
//   - `billing` reads `messageHourlyStats` only, exactly like `volume`/
//     `responsePerformance` — the same table, the same `readHours` window
//     bound on both edges, so its cost is pinned by WINDOW length, not by
//     message traffic;
//   - nothing in this file `.collect()`s `messages`, or an unbounded
//     partition of `conversations`.
// ============================================================

const granularityValidator = v.union(v.literal("day"), v.literal("week"));

/**
 * Reads the hourly rollup for the window `[sinceMs, untilMs)`. The two edges
 * are bound differently, for different reasons:
 *
 * - Lower edge — `hourStartMs(sinceMs)`, not the raw `sinceMs`: the bucket
 *   containing `sinceMs` starts before it, so ranging on the raw value would
 *   drop the first partial hour. This deliberately over-reads by at most
 *   one hour; `foldHoursIntoVolume`'s `keys` discard whatever of that
 *   spillover falls outside the requested window.
 * - Upper edge — `untilMs` itself, UNROUNDED: the exclusive end of the
 *   window (the local-midnight instant after the last requested day). An
 *   hour bucket belongs to the window if its START is before `untilMs`, so
 *   `.lt("hourStartMs", untilMs)` is exactly right and no `hourStartMs()`
 *   rounding belongs on this edge.
 *
 * The upper bound is load-bearing, not defensive. `foldHoursIntoVolume`
 * would silently correct an unbounded read on its own (its `keys` discard
 * anything past the window), but `foldHoursIntoHourOfDay` takes no `keys`
 * and pools every row it is handed — for any window that does not end at
 * the newest row in the table (a previous-period comparison, a historical
 * range), an unbounded upper read would pool hours past `untilMs` into
 * `hourOfDay` while `series`/`totals` beside it stayed correctly windowed.
 * It also costs real reads: without this bound, the query's cost is a
 * function of "`sinceMs` to now", not of the requested window, defeating
 * the read-boundedness this whole file exists for — see `reports.test.ts`'s
 * "volume bounds hourOfDay to the window" test, which fails without it.
 *
 * Takes `db`/`accountId` as plain arguments rather than an `accountQuery`
 * `ctx` object — the shape `kbImport.loadPlan`/`kbOps.loadOps` already use
 * for a helper called from inside a handler. The composed handler ctx type
 * (`QueryCtx` merged with `lib/auth.ts`'s `customCtx` additions) is built by
 * `convex-helpers`' generic `customQuery` machinery and has no name to
 * import without reaching into its internals; `DatabaseReader` and
 * `Id<"accounts">`, by contrast, are both exported directly off generated
 * code, so this stays fully and precisely typed with nothing inferred (or
 * annotated) as `any`.
 */
async function readHours(
  db: DatabaseReader,
  accountId: Id<"accounts">,
  sinceMs: number,
  untilMs: number,
): Promise<ReportHourRow[]> {
  return await db
    .query("messageHourlyStats")
    .withIndex("by_account_hour", (q) =>
      q
        .eq("accountId", accountId)
        .gte("hourStartMs", hourStartMs(sinceMs))
        .lt("hourStartMs", untilMs),
    )
    .collect();
}

export const volume = accountQuery({
  args: {
    sinceMs: v.number(),
    untilMs: v.number(),
    keys: v.array(v.string()),
    tzOffsetMinutes: v.number(),
    granularity: granularityValidator,
  },
  handler: async (ctx, args) => {
    ctx.requireRole("supervisor");
    const hours = await readHours(
      ctx.db,
      ctx.accountId,
      args.sinceMs,
      args.untilMs,
    );

    const folded = foldHoursIntoVolume(
      hours,
      args.keys,
      args.tzOffsetMinutes,
      args.granularity,
    );
    const series = args.keys.map((key) => ({
      key,
      ...(folded.get(key) ?? {
        conversationsStarted: 0,
        conversationsStartedAd: 0,
        incoming: 0,
        outgoing: 0,
        activeConversations: 0,
      }),
    }));

    // `activeConversations` is the one field below that is NOT safe to sum
    // across periods — see `VolumeTotals.activeConversations`'s own doc
    // comment in `lib/reportStats.ts`. Each `p.activeConversations` is
    // already a per-period distinct count (or, at week granularity, itself
    // a sum of daily distinct counts), so adding it across every period in
    // `series` turns `totals.activeConversations` into conversation-DAYS/
    // -PERIODS for the whole range, never a range-wide distinct count.
    // Every consumer of this total must divide by the period count it was
    // summed over — `conversations-panel.tsx`'s tile and CSV export both
    // do.
    const totals: VolumeTotals = series.reduce(
      (acc, p) => ({
        conversationsStarted: acc.conversationsStarted + p.conversationsStarted,
        conversationsStartedAd:
          acc.conversationsStartedAd + p.conversationsStartedAd,
        incoming: acc.incoming + p.incoming,
        outgoing: acc.outgoing + p.outgoing,
        activeConversations: acc.activeConversations + p.activeConversations,
      }),
      { conversationsStarted: 0, conversationsStartedAd: 0, incoming: 0, outgoing: 0, activeConversations: 0 },
    );

    return {
      series,
      // Across the whole window, not per-key — the heatmap answers "which
      // hours are busy", pooling every requested day/week into 24 slots
      // rather than splitting one heatmap per key.
      hourOfDay: foldHoursIntoHourOfDay(hours, args.tzOffsetMinutes),
      totals,
    };
  },
});

// `STATUS_MIX_CAP` is defined in `./lib/reportStats` (imported above), not
// here — that module is database-free (no `ctx`, no `db`, no
// `_generated/server`; its only dependency is `./dashboardDate`), which
// makes it safe for a `'use client'` report panel to import directly.
// Importing the constant from THIS file instead ships the whole module —
// every handler below, every `ctx.db.query()` call, the `accountQuery`/
// `requireRole` machinery — into the browser bundle to obtain one integer;
// confirmed by inspecting the built /reports client chunk. Re-exported here
// so `reports.test.ts`'s existing `import { STATUS_MIX_CAP } from
// "./reports"` keeps working. See `reportStats.ts`'s own doc comment on the
// constant for the full cap-sizing rationale.
export { STATUS_MIX_CAP };

export const conversationStatusMix = accountQuery({
  args: {},
  handler: async (ctx) => {
    ctx.requireRole("supervisor");

    // open/pending/closed: every key in `by_account_archived_status`
    // (accountId, archivedAt, status) is bound by EQUALITY — including
    // `archivedAt` as `eq(undefined)`, the same "active set" idiom
    // `dashboard.metrics`'s `openSample` uses on this identical index — so
    // every row this walks already matches the bucket exactly. There is no
    // `.filter()` layered on top that could starve the `.take()`.
    const countStatus = async (status: "open" | "pending" | "closed") => {
      const rows = await ctx.db
        .query("conversations")
        .withIndex("by_account_archived_status", (q) =>
          q
            .eq("accountId", ctx.accountId)
            .eq("archivedAt", undefined)
            .eq("status", status),
        )
        .take(STATUS_MIX_CAP + 1);
      return rows.length;
    };

    const [openRaw, pendingRaw, closedRaw] = await Promise.all([
      countStatus("open"),
      countStatus("pending"),
      countStatus("closed"),
    ]);

    // Archived is every status, so `status` is deliberately left unbound —
    // once a range clause (`.gt`) applies to `archivedAt`, the index API
    // does not allow constraining `status` after it anyway. `archivedAt >
    // 0` is the "field present" idiom already used for this same index
    // (see schema.ts's `by_account_archived_last_message` comment): it
    // matches "archived, any status" EXACTLY, not approximately, so there
    // is still no `.filter()` needed and the take stays a genuine bound.
    const archivedRows = await ctx.db
      .query("conversations")
      .withIndex("by_account_archived_status", (q) =>
        q.eq("accountId", ctx.accountId).gt("archivedAt", 0),
      )
      .take(STATUS_MIX_CAP + 1);

    const clamp = (n: number) => Math.min(n, STATUS_MIX_CAP);
    return {
      open: clamp(openRaw),
      pending: clamp(pendingRaw),
      closed: clamp(closedRaw),
      archived: clamp(archivedRows.length),
      // True the moment ANY bucket hits its ceiling, so the UI can render
      // "500+" rather than presenting a clamped figure as an exact count.
      capped:
        openRaw > STATUS_MIX_CAP ||
        pendingRaw > STATUS_MIX_CAP ||
        closedRaw > STATUS_MIX_CAP ||
        archivedRows.length > STATUS_MIX_CAP,
    };
  },
});

// `AD_ROW_LIMIT` is defined in `./lib/reportStats` (imported above), not
// here — same database-free reasoning as `STATUS_MIX_CAP` above: the
// `'use client'` Ads panel needs this number verbatim for its truncation
// copy, and importing it from THIS file would ship every handler below,
// every `ctx.db.query()` call, and the whole `accountQuery`/`requireRole`
// machinery into the browser bundle to obtain one integer. Re-exported here
// so `reports.test.ts`'s existing `import { AD_ROW_LIMIT } from
// "./reports"` keeps working. See `reportStats.ts`'s own doc comment on the
// constant for the full sizing rationale.
export { AD_ROW_LIMIT };

/**
 * Per-ad performance for the /reports Ads tab: which ads brought
 * conversations in `[sinceMs, untilMs)`, and what those conversations went
 * on to do. Three account-scoped scans joined in memory — the same shape
 * `campaigns.overview` uses for its two:
 *   - `adReferrals` — which conversation came from which ad;
 *   - `funnelTransitions` — what each of those conversations went on to do;
 *   - `campaignAds` — the ad-id → name/set/campaign resolution cache.
 *
 * The two event-log scans are bound on BOTH `_creationTime` edges —
 * `.gte(sinceMs).lt(untilMs)`, no rounding on either edge, since these range
 * directly on the row timestamp rather than a bucket key like `volume`'s
 * `hourStartMs`. The upper bound is load-bearing, not defensive, for
 * exactly the reason `readHours`'s own doc comment gives for `volume`: for
 * any window that does not end at "now" (a previous-period comparison, a
 * historical range), an unbounded upper read would silently pull in every
 * referral/transition newer than the window while still looking, from the
 * caller's side, like a correctly scoped result.
 */
/** The only funnel stages `adPerformance` inspects. Named rather than
 *  inlined so the index ranges it reads and the `stages.has(...)` checks
 *  that consume them cannot drift apart — adding a third stage to one
 *  without the other would silently under- or over-fetch. */
const AD_STAGES_OF_INTEREST = ["qualified", "purchased"] as const;

export const adPerformance = accountQuery({
  args: { sinceMs: v.number(), untilMs: v.number() },
  handler: async (ctx, args) => {
    ctx.requireRole("supervisor");
    const account = await ctx.db.get(ctx.accountId);
    const currency = account?.defaultCurrency ?? "USD";

    const referrals = await ctx.db
      .query("adReferrals")
      .withIndex("by_account", (q) =>
        q
          .eq("accountId", ctx.accountId)
          .gte("_creationTime", args.sinceMs)
          .lt("_creationTime", args.untilMs),
      )
      .collect();
    // ONLY the two stages this query asks about. It reads
    // `stages.has("qualified")` and `stages.has("purchased")` below and
    // nothing else, but used to fetch every stage through `by_account`:
    // measured on production at 2,029 rows for a 30-day window, of which
    // 1,838 were `new_lead` it discarded. Ranging `stage` in the index
    // reads only the two partitions in use — a ~10x cut that changes no
    // number this query returns, since the discarded rows never reached an
    // output. Two ranges rather than one because a Convex index range binds
    // an equality key, not a set; they are independent, so they run as one
    // parallel wave.
    const transitions = (
      await Promise.all(
        AD_STAGES_OF_INTEREST.map((stage) =>
          ctx.db
            .query("funnelTransitions")
            .withIndex("by_account_stage", (q) =>
              q
                .eq("accountId", ctx.accountId)
                .eq("stage", stage)
                .gte("_creationTime", args.sinceMs)
                .lt("_creationTime", args.untilMs),
            )
            .collect(),
        ),
      )
    ).flat();
    // NOT window-bounded: a resolution CACHE with one row per ad ever
    // seen, not an event log — its size is the same order of magnitude as
    // the ad count this query already returns, not of account activity.
    const ads = await ctx.db
      .query("campaignAds")
      .withIndex("by_account", (q) => q.eq("accountId", ctx.accountId))
      .collect();

    const adsById = new Map(ads.map((ad) => [ad.adId, ad]));
    // Backlog visibility for the rows below whose `adName` comes back
    // null. Deliberately over ALL of the account's `campaignAds` (not just
    // ads referenced within the window) — same as the `ads` read itself,
    // this is a cache-wide count, not a windowed one. Only the three
    // statuses that explain a missing name are broken out: "resolved" ads
    // already have one, and "error" is a still-retrying working state the
    // UI does not need surfaced here.
    const resolution = { pending: 0, dormant: 0, abandoned: 0 };
    for (const ad of ads) {
      if (ad.resolveStatus === "pending") resolution.pending += 1;
      else if (ad.resolveStatus === "dormant") resolution.dormant += 1;
      else if (ad.resolveStatus === "abandoned") resolution.abandoned += 1;
    }

    // Which stages each conversation reached in the window, and what its
    // purchase (if any) was worth.
    const stagesByConversation = new Map<Id<"conversations">, Set<string>>();
    const saleByConversation = new Map<Id<"conversations">, number>();
    for (const tr of transitions) {
      let stages = stagesByConversation.get(tr.conversationId);
      if (!stages) {
        stages = new Set<string>();
        stagesByConversation.set(tr.conversationId, stages);
      }
      stages.add(tr.stage);
      if (tr.stage === "purchased" && tr.saleValue !== undefined) {
        saleByConversation.set(tr.conversationId, tr.saleValue);
      }
    }

    type AdAcc = {
      conversations: Set<Id<"conversations">>;
      firstTouchLeads: number;
      serviceKeys: Set<string>;
    };
    const byAd = new Map<string, AdAcc>();
    for (const ref of referrals) {
      // Organic Facebook/Instagram POST taps, not paid ads — the same
      // per-referral gate `adReferrals.recordAdReferral` checks before
      // bumping `conversationsStartedAd` (convex/adReferrals.ts:118). A
      // "post"'s `source_id` is a POST id, not an ad id, so admitting it
      // here would put an unresolvable id in a table titled "Ad
      // performance" next to a `campaignAds` resolver that will never name
      // it.
      //
      // That match is only PARTIAL, deliberately, and the two figures do
      // NOT reconcile. `conversationsStartedAd` additionally requires the
      // ad referral to be the conversation's EARLIEST referral of any
      // type — built from `priorReferrals`, collected UNFILTERED by
      // sourceType (convex/adReferrals.ts:75), and consulted
      // (convex/adReferrals.ts:124) as "has ANY prior referral already
      // landed on this conversation", not "was a prior AD referral already
      // counted". This query applies no such guard: it credits every ad
      // referral in the window, including one that re-engages a
      // conversation whose earliest referral was something else. That is
      // intended — an ad that revives an existing thread should get
      // credit for it here even though it did not start a NEW conversation
      // for the rollup. Two consequences, both intended:
      //   - a conversation whose earliest referral is a post, later
      //     re-engaged by a genuine ad, appears in this table but
      //     contributes 0 to `conversationsStartedAd`;
      //   - a conversation touched by two different ads is ONE
      //     `conversationsStartedAd` but one row under EACH ad here.
      // Both of those push `sum(rows.conversations)` ABOVE
      // `conversationsStartedAd`. The inequality is still not structural,
      // because one exclusion pushes the other way: a referral with
      // `sourceType === "ad"` but NO `adId` (a Status placement) bumps
      // `conversationsStartedAd` — that counter gates on `sourceType`
      // alone (convex/adReferrals.ts:118) — while the `!ref.adId` guard
      // just below drops it from this table, since there is no ad to group
      // it under. Enough such referrals and the inequality inverts. So the
      // honest statement is only that the two figures are NOT
      // reconcilable in either direction: they count different things over
      // different subsets. Do not "fix" this by adding the
      // earliest-referral guard here, which would gut the table's purpose
      // (which ads drove A conversation, not just which ad drove its
      // first-ever touch).
      // No other column reconciles either: `firstTouchLeads` below comes
      // from `isFirstTouch`, which is per-CONTACT — "this contact has no
      // prior adReferrals" (convex/adReferrals.ts:79) — not
      // per-conversation, despite reading like it should tie to
      // `conversationsStartedAd` too.
      if (ref.sourceType !== "ad") continue;
      // A referral with no adId cannot be grouped by ad — skip it (Status
      // placements carry no `adId`).
      if (!ref.adId) continue;

      let acc = byAd.get(ref.adId);
      if (!acc) {
        acc = {
          conversations: new Set<Id<"conversations">>(),
          firstTouchLeads: 0,
          serviceKeys: new Set<string>(),
        };
        byAd.set(ref.adId, acc);
      }
      // Distinct CONVERSATIONS, not referral rows: a thread can carry
      // several referrals (the customer clicks twice), and counting rows
      // would inflate every busy ad.
      acc.conversations.add(ref.conversationId);
      if (ref.isFirstTouch) acc.firstTouchLeads += 1;
      if (ref.serviceMatchKey) acc.serviceKeys.add(ref.serviceMatchKey);
    }

    const rows = [...byAd.entries()].map(([adId, acc]) => {
      let qualified = 0;
      let purchased = 0;
      let saleValue = 0;
      for (const conversationId of acc.conversations) {
        const stages = stagesByConversation.get(conversationId);
        if (!stages) continue;
        if (stages.has("qualified")) qualified += 1;
        if (stages.has("purchased")) {
          purchased += 1;
          saleValue += saleByConversation.get(conversationId) ?? 0;
        }
      }
      const ad = adsById.get(adId);
      return {
        adId,
        adName: ad?.adName ?? null,
        adSetName: ad?.adSetName ?? null,
        campaignName: ad?.campaignName ?? null,
        conversations: acc.conversations.size,
        firstTouchLeads: acc.firstTouchLeads,
        qualified,
        purchased,
        saleValue,
        serviceKeys: [...acc.serviceKeys].sort(),
      };
    });

    // Truncate by CONVERSATIONS descending, ALWAYS — regardless of how the
    // UI later sorts the table. Sorting is client-side, so if the server
    // instead truncated on whatever column happened to be sorted,
    // re-sorting by e.g. sale value would appear to reveal an ad that was
    // never sent to the browser. Pinning the axis here makes the returned
    // set "the N largest by volume", full stop, regardless of display.
    rows.sort((a, b) => b.conversations - a.conversations);
    const truncated = Math.max(0, rows.length - AD_ROW_LIMIT);

    return {
      rows: rows.slice(0, AD_ROW_LIMIT),
      truncated,
      resolution,
      currency,
    };
  },
});

/**
 * Reply-latency SLA panel: the series/histogram/percentile/hour-of-day view
 * over `messageHourlyStats`'s reply-latency rollup, for `[sinceMs, untilMs)`.
 *
 * Correction over the original task-9 brief, which gave this query only
 * `sinceMs`: `readHours` requires both edges (see its own doc comment), and
 * an unbounded upper read would silently pool hours past `untilMs` into
 * `byHourOfDay` — which, like `foldHoursIntoHourOfDay`, pools every row it
 * is handed with no `keys` restriction — while `series` beside it stayed
 * correctly windowed via `keys`. Same defect `adPerformance` was fixed for
 * in task 8; see `reports.test.ts`'s "volume bounds hourOfDay to the
 * window" test for the shape of the regression this guards against.
 *
 * `avgMinutes` is derived from `responseTotalMs / responseCount` — the
 * EXACT sum+count the rollup stores — never from the histogram, which only
 * knows buckets and would turn an exact mean into an estimate. `null`
 * (never `0`) whenever there is nothing to average: a `0` would read as
 * "we reply instantly", the opposite of "no data".
 *
 * TWO DIFFERENT SAMPLE COUNTS, and they can disagree. The top-level
 * `samples` is HISTOGRAM-derived (the sum of `buckets`), because it is the
 * denominator `withinTarget`/`p50`/`p90` are computed against and must
 * match them exactly. `series[].samples` and `byHourOfDay[].samples` are
 * `responseCount`-derived, matching the `avgMinutes` beside each of them.
 * Every hour written by the task-3 path carries both, so they agree — but
 * `responseCount`/`responseTotalMs` shipped long before `responseBuckets`,
 * so every hour predating it has a count and NO histogram. Over such a
 * window this query returns `samples: 0` next to a non-null `avgMinutes`,
 * and null percentiles next to a populated series. That is not a bug and
 * must not be "fixed" by deriving one from the other; it resolves when the
 * owner runs `messages.backfillResponseBuckets`, which is exactly why the
 * spec puts the backfills before the UI in the rollout order.
 */
export const responsePerformance = accountQuery({
  args: {
    sinceMs: v.number(),
    untilMs: v.number(),
    keys: v.array(v.string()),
    tzOffsetMinutes: v.number(),
    granularity: granularityValidator,
    // Constrained to the histogram's own bucket edges. A target between
    // edges cannot be answered without inventing a distribution, so the
    // validator refuses one rather than returning a plausible guess — see
    // `withinTargetRatio`'s own doc comment in `lib/reportStats.ts`.
    targetMinutes: v.union(
      v.literal(1),
      v.literal(5),
      v.literal(15),
      v.literal(60),
    ),
  },
  handler: async (ctx, args) => {
    ctx.requireRole("supervisor");
    const hours = await readHours(
      ctx.db,
      ctx.accountId,
      args.sinceMs,
      args.untilMs,
    );

    const buckets = sumResponseBuckets(hours);
    // HISTOGRAM-derived, unlike `series[].samples`/`byHourOfDay[].samples`
    // below, which are `responseCount`-derived. This one is the denominator
    // `withinTarget`/`p50`/`p90` use, so it has to be the histogram's own
    // total. The two converge only once `backfillResponseBuckets` has run
    // — see this query's doc comment.
    const samples = RESPONSE_BUCKET_KEYS.reduce((s, k) => s + buckets[k], 0);
    const totalMs = hours.reduce((s, h) => s + (h.responseTotalMs ?? 0), 0);
    const totalCount = hours.reduce((s, h) => s + (h.responseCount ?? 0), 0);

    // Average by local hour-of-day, pooled across the (already bounded)
    // window — this is what exposes "we are slow between 2 and 5pm". Reads
    // only `hours`, which `readHours` already restricted to
    // `[sinceMs, untilMs)`, so this pooling cannot reach past the window.
    const hourly = Array.from({ length: 24 }, () => ({ totalMs: 0, count: 0 }));
    for (const row of hours) {
      const count = row.responseCount ?? 0;
      if (count <= 0) continue;
      const localMs = row.hourStartMs - args.tzOffsetMinutes * 60_000;
      const slot = hourly[new Date(localMs).getUTCHours()]!;
      slot.totalMs += row.responseTotalMs ?? 0;
      slot.count += count;
    }

    return {
      series: foldHoursIntoResponseSeries(
        hours,
        args.keys,
        args.tzOffsetMinutes,
        args.granularity,
      ),
      buckets,
      samples,
      avgMinutes: totalCount === 0 ? null : totalMs / totalCount / 60_000,
      withinTarget: withinTargetRatio(buckets, args.targetMinutes),
      p50: percentileRange(buckets, 50),
      p90: percentileRange(buckets, 90),
      byHourOfDay: hourly.map((slot, hour) => ({
        hour,
        avgMinutes: slot.count === 0 ? null : slot.totalMs / slot.count / 60_000,
        samples: slot.count,
      })),
    };
  },
});

// `AWAITING_SAMPLE_CAP` is defined in `./lib/reportStats` (imported above),
// not here — same database-free reasoning as `STATUS_MIX_CAP`/`AD_ROW_LIMIT`
// above: the `'use client'` Response panel needs this number verbatim for
// its capped-backlog copy, and importing it from THIS file would ship every
// handler below, every `ctx.db.query()` call, and the whole `accountQuery`/
// `requireRole` machinery into the browser bundle to obtain one integer.
// Re-exported here so `reports.test.ts`'s existing `import {
// AWAITING_SAMPLE_CAP } from "./reports"` keeps working. See
// `reportStats.ts`'s own doc comment on the constant for the full
// sizing/take-bound rationale.
export { AWAITING_SAMPLE_CAP };

/**
 * Live reply-backlog age histogram for the /reports SLA panel — "how many
 * threads are we currently sitting on, and for how long." Current-state,
 * not windowed: there is no `sinceMs`/`untilMs` because there is no event
 * to range over, only conversations' present `awaitingReply` state.
 */
export const awaitingReplyAges = accountQuery({
  args: {},
  handler: async (ctx) => {
    ctx.requireRole("supervisor");

    const rows = await ctx.db
      .query("conversations")
      .withIndex("by_account_lane_last_message", (q) =>
        q
          .eq("accountId", ctx.accountId)
          .eq("archivedAt", undefined)
          .eq("snoozedUntil", undefined)
          .eq("chasingForcedAt", undefined)
          .eq("awaitingReply", true),
      )
      .take(AWAITING_SAMPLE_CAP + 1);

    const capped = rows.length > AWAITING_SAMPLE_CAP;
    const sample = capped ? rows.slice(0, AWAITING_SAMPLE_CAP) : rows;

    const now = Date.now();
    const out = { under1h: 0, h1to4: 0, h4to24: 0, over24h: 0, capped };
    for (const c of sample) {
      // No `pendingCustomerAtMs` means the thread is awaiting a reply but
      // has no customer message to time from — an agent-created
      // conversation with no messages yet owes the FIRST message (see
      // schema.ts's `awaitingReply` comment), not a reply to one. It has
      // no age, so it belongs in no age bucket rather than bucketing as
      // zero-age.
      if (c.pendingCustomerAtMs === undefined) continue;
      const ageMs = now - c.pendingCustomerAtMs;
      if (ageMs < 3_600_000) out.under1h += 1;
      else if (ageMs < 4 * 3_600_000) out.h1to4 += 1;
      else if (ageMs < 24 * 3_600_000) out.h4to24 += 1;
      else out.over24h += 1;
    }
    return out;
  },
});

/**
 * Funnel performance overview for the /reports Funnel tab — `campaigns.
 * overview`'s body re-homed off that query's fixed `WINDOW_DAYS` (365 days)
 * onto the caller's own `[sinceMs, untilMs)`; see `campaigns.overview`'s own
 * (now `@deprecated`) doc comment for the supervisor-gate rationale, which
 * carries over unchanged. Same two account-scoped index scans bucketed in
 * memory:
 *  - per-stage funnel counts (distinct conversations reaching each stage)
 *    from `funnelTransitions.by_account`,
 *  - Meta delivery status counts from `conversionEvents.by_account`.
 *
 * Correction over the original task-10 brief, which gave this query only
 * `sinceMs`: both scans are bound on BOTH `_creationTime` edges —
 * `.gte(sinceMs).lt(untilMs)`, no rounding on either edge, since these range
 * directly on the row timestamp rather than a bucket key like `readHours`'s
 * `hourStartMs`. Same shape (and same reason) as `adPerformance`'s two
 * scans, fixed for the identical defect in task 8: `transitions`/`events`
 * are bucketed straight into `funnel`/`meta` below with no further
 * `keys`-style filter protecting them, so an unbounded upper read would
 * silently corrupt those counts — not just cost extra reads — for any
 * window that does not end at "now" (a previous-period comparison, a
 * historical range). See `reports.test.ts`'s "funnelOverview bounds both
 * scans to the window" test for the shape of the regression this guards
 * against.
 *
 * `purchase.totalValue` is read off `funnelTransitions`' own `saleValue`
 * (Task B1), NOT `conversionEvents` — `conversionEvents` rows exist ONLY for
 * ATTRIBUTED (ad/website) conversations, while `funnelTransitions` rows
 * exist for every conversation including organic ones. Summing from events
 * silently zeroed every organic purchase's contribution even though
 * `purchase.count` (transitions-derived) counted it. A transition written
 * before Task B1 carries no `saleValue`; it falls back to the value on its
 * matching `conversionEvents` row (joined on the same `conversationId:stage`
 * key that row's own dedup `eventId` uses) — the only place a legacy
 * amount lives. "Recorded value", not "reported to Meta" (delivery may be
 * dormant/pending, and organic conversations are never reported at all).
 * This is a CURRENCY figure (recorded sale value) — distinct from
 * `billing` below, whose counters are Meta-billing VOLUMES and carry no
 * money at all.
 *
 * NOTE: `adPerformance` (task 8) deliberately does NOT apply the legacy
 * `conversionEvents` fallback above — it reads `tr.saleValue` alone. So
 * `funnelOverview.purchase.totalValue` and `sum(adPerformance.rows.
 * saleValue)` can disagree on a pre-Task-B1 row. Known, tracked, not
 * silently reconciled here.
 */
export const funnelOverview = accountQuery({
  args: { sinceMs: v.number(), untilMs: v.number() },
  handler: async (ctx, args) => {
    ctx.requireRole("supervisor");
    const account = await ctx.db.get(ctx.accountId);
    const currency = account?.defaultCurrency ?? "USD";

    // ONE index range over the hourly rollup — ~464 rows for a 30-day
    // window on production — in place of the two event-log collects this
    // used to run (4,053 documents over the same window, growing with
    // traffic rather than with the window).
    //
    // HOURLY, not daily, and that is a correctness requirement rather than
    // a preference: `reportWindow` builds `sinceMs` from a LOCAL midnight,
    // which for this UTC+4 account is 20 hours after the UTC midnight a
    // daily bucket would round down to. A daily version of this rollup
    // shipped first and over-reported the 7-day figure by 22.7% for exactly
    // that reason. `hourStartMs(sinceMs)` rounds down by at most 59
    // minutes, and only for a window that does not begin on the hour —
    // which `reportWindow` never produces. See `funnelHourlyStats` in
    // schema.ts.
    const hours = await ctx.db
      .query("funnelHourlyStats")
      .withIndex("by_account_hour", (q) =>
        q
          .eq("accountId", ctx.accountId)
          .gte("hourStartMs", hourStartMs(args.sinceMs))
          .lt("hourStartMs", args.untilMs),
      )
      .collect();

    // Summing `stageFirstReached` across days IS a distinct-conversation
    // count, which is the whole reason that counter is defined as
    // first-arrival rather than arrival — see `funnelDailyStats` in
    // schema.ts. Summing a plain "reached this stage" counter here would
    // yield conversation-DAYS and could exceed the account's conversation
    // count.
    const totals = emptyStageCounts();
    const meta = emptyEventStatusCounts();
    let totalValue = 0;
    for (const hour of hours) {
      for (const stage of FUNNEL_STAGE_KEYS) {
        totals[stage] += hour.stageFirstReached[stage];
      }
      for (const status of EVENT_STATUS_KEYS) {
        meta[status] += hour.eventsByStatus[status];
      }
      totalValue += hour.purchaseValueTotal;
    }

    const funnel = FUNNEL_STAGE_KEYS.map((stage) => ({
      stage,
      count: totals[stage],
    }));

    // The 4-stage lead-quality funnel the Meta integration reports, and
    // its rates (CAPI lifecycle spec §19). Derived from the SAME
    // first-arrival counters as `funnel` above and the same stage→label
    // mapping the outbox uses, so the report and the wire can never
    // disagree about what an MQL is.
    const lifecycle = lifecycleFunnel({
      lead: totals.new_lead,
      mql: totals.qualified,
      sql: totals.price_quoted,
      converted: totals.purchased,
    });

    return {
      funnel,
      lifecycle,
      purchase: { count: totals.purchased, totalValue, currency },
      meta: {
        sent: meta.sent,
        pending: meta.pending,
        dormant: meta.dormant,
        unmatched: meta.unmatched,
        error: meta.error,
        abandoned: meta.abandoned,
        total: EVENT_STATUS_KEYS.reduce((n, k) => n + meta[k], 0),
      },
    };
  },
});

/**
 * Meta billing-volume rollup for the /reports Billing tab: which pricing
 * categories drove message volume in `[sinceMs, untilMs)`, and how many
 * distinct Meta conversation windows opened, folded into the caller's local
 * days/weeks. Reads `messageHourlyStats` only,
 * exactly like `volume`/`responsePerformance` — the same table, the same
 * `readHours` window bound on both edges (see that helper's own doc
 * comment for why the upper bound matters), so its cost is pinned by WINDOW
 * length, not by message traffic.
 *
 * VOLUMES, not money: Meta's webhooks carry billing categories and message
 * counts, never rate-card amounts, so nothing this query returns is (or
 * implies) a currency figure. That is a deliberate contrast with
 * `funnelOverview.purchase.totalValue` above, which IS a currency figure —
 * but recorded SALE value, not Meta ad/messaging spend. The two must stay
 * visibly distinct rather than blended into one "revenue" number.
 *
 * `metaConversations` is NOT a billable count and must not be labelled one.
 * The write path (`messages.bumpMetaConversationStats`) fires on every
 * newly-seen `conversationMetaId` with no billability test, so
 * free-entry-point windows are inside it — `freeEntryPointConversations` is
 * a SUBSET, not a sibling. A tile reading "Billable conversations: N" off
 * this field would overstate Meta's charge by exactly the free count; the
 * billable figure is `metaConversations - freeEntryPointConversations`, and
 * this query deliberately returns the two inputs rather than a derived
 * number, so the subtraction is visible wherever it is made.
 */
export const billing = accountQuery({
  args: {
    sinceMs: v.number(),
    untilMs: v.number(),
    keys: v.array(v.string()),
    tzOffsetMinutes: v.number(),
    granularity: granularityValidator,
  },
  handler: async (ctx, args) => {
    ctx.requireRole("supervisor");
    const hours = await readHours(
      ctx.db,
      ctx.accountId,
      args.sinceMs,
      args.untilMs,
    );

    const folded = foldHoursIntoBilling(
      hours,
      args.keys,
      args.tzOffsetMinutes,
      args.granularity,
    );
    const series = args.keys.map((key) => ({
      key,
      ...(folded.get(key) ?? {
        metaConversations: 0,
        freeEntryPointConversations: 0,
        categories: emptyPricingCategories(),
      }),
    }));

    const totals: BillingTotals = series.reduce(
      (acc, p) => {
        acc.metaConversations += p.metaConversations;
        acc.freeEntryPointConversations += p.freeEntryPointConversations;
        for (const key of PRICING_CATEGORY_KEYS)
          acc.categories[key] += p.categories[key];
        return acc;
      },
      {
        metaConversations: 0,
        freeEntryPointConversations: 0,
        categories: emptyPricingCategories(),
      },
    );

    return { series, totals };
  },
});

// `ASSIGNMENT_ROW_LIMIT` is defined in `./lib/reportStats` (imported above),
// not here — same database-free reasoning as `STATUS_MIX_CAP`/`AD_ROW_LIMIT`/
// `AWAITING_SAMPLE_CAP`: the Agents panel is a `'use client'` component and
// importing the constant from this module would ship the whole backend file
// to the browser. Re-exported so `reports.test.ts` can keep importing every
// cap in this file from one place.
export { ASSIGNMENT_ROW_LIMIT };

/**
 * Leads assigned per agent, per local day — the /reports Agents tab. See
 * docs/superpowers/specs/2026-08-21-agents-assignment-report-design.md.
 *
 * Reads `conversationEvents`, the handover trail written by the single
 * `applyAssignment` in `lib/assignment.ts`. Because that one function both
 * patches `conversations.assignedToUserId` and inserts the event, the trail
 * cannot drift from the field, and all seven assignment entry points are
 * covered without this query knowing about any of them.
 *
 * A cell counts DISTINCT CONVERSATIONS, not events — see
 * `foldAssignmentEvents`, which owns that rule and is tested against it
 * directly.
 *
 * READ BOUNDEDNESS. Both window edges are bound on `by_account`, which Convex
 * stores as `["accountId", "_creationTime"]`, so the range covers exactly
 * `[sinceMs, untilMs)` and every document read is a match — there is no
 * `.filter()` layered on top that could starve the take. Unlike `volume` /
 * `responsePerformance` / `billing`, whose cost is pinned by WINDOW length
 * because they read an hourly rollup, this query's cost grows with handover
 * VOLUME inside the window. That is the `adPerformance` shape, and it gets
 * `adPerformance`'s answer: an explicit cap, `ASSIGNMENT_ROW_LIMIT`.
 *
 * The take is DESCENDING, and that is load-bearing rather than stylistic. An
 * ascending take would truncate the NEWEST days — the ones anyone is actually
 * looking at — and the panel would render a confident, wrong, short bar for
 * today. Descending truncates the oldest instead, and `truncated` /
 * `earliestCoveredDay` hand the panel enough to label the incomplete edge. A
 * capped read that cannot say WHERE it was capped is how a report states a
 * number it has not earned.
 *
 * `earliestCoveredDay` is the local day of the oldest row actually read, so it
 * names the first day that may be short — not the first day that is missing.
 * It is null when nothing was truncated.
 *
 * Names come from `memberships` (account-scoped, so no `users` read, and no
 * cross-tenant reach). An assignee with no membership row — someone who has
 * since left the team — is kept under a null `name` for the client to label,
 * NOT dropped: their leads really happened, and dropping them would make each
 * day's total disagree with the per-agent column beside it. Returned as
 * aggregates only, like every query in this file, which is what makes
 * supervisor the right floor rather than admin.
 */
export const assignmentsByAgent = accountQuery({
  args: {
    sinceMs: v.number(),
    untilMs: v.number(),
    dayKeys: v.array(v.string()),
    tzOffsetMinutes: v.number(),
  },
  handler: async (ctx, args) => {
    ctx.requireRole("supervisor");

    // `take(CAP + 1)`, not `take(CAP)` — the `awaitingReplyAges` pattern.
    // Reading exactly the cap cannot distinguish "capped" from "there were
    // precisely CAP rows", and that off-by-one would put a truncation warning
    // on a complete report.
    const rows = await ctx.db
      .query("conversationEvents")
      .withIndex("by_account", (q) =>
        q
          .eq("accountId", ctx.accountId)
          .gte("_creationTime", args.sinceMs)
          .lt("_creationTime", args.untilMs),
      )
      .order("desc")
      .take(ASSIGNMENT_ROW_LIMIT + 1);

    const truncated = rows.length > ASSIGNMENT_ROW_LIMIT;
    const events = truncated ? rows.slice(0, ASSIGNMENT_ROW_LIMIT) : rows;
    // `order("desc")` means the LAST row read is the oldest one, so this is
    // the earliest day the window actually covers in full-or-part. Only
    // meaningful when the take hit its cap; otherwise the window's own
    // `sinceMs` is the honest floor and there is nothing to flag.
    const oldest = events[events.length - 1];
    const earliestCoveredDay =
      truncated && oldest
        ? localDayKeyFromMs(oldest._creationTime, args.tzOffsetMinutes)
        : null;

    const { days, agentTotals } = foldAssignmentEvents(
      events.map((event) => ({
        conversationId: event.conversationId,
        kind: event.kind,
        targetUserId: event.targetUserId,
        creationTimeMs: event._creationTime,
      })),
      args.dayKeys,
      args.tzOffsetMinutes,
    );

    // The roster is read ONLY for the agents that actually appear, but it is
    // fetched in one indexed pass rather than per-agent: a member count is
    // small and bounded, while N point lookups would scale with how many
    // agents were active in the window.
    const memberships = await ctx.db
      .query("memberships")
      .withIndex("by_account", (q) => q.eq("accountId", ctx.accountId))
      .collect();
    const nameByUserId = new Map(
      memberships.map((member) => [member.userId as string, member.fullName]),
    );

    const agents = Object.entries(agentTotals)
      .map(([userId, total]) => ({
        userId,
        name: nameByUserId.get(userId) ?? null,
        total,
      }))
      // Busiest first. `userId` breaks ties so the row order is stable across
      // refetches — otherwise two agents on equal totals can swap places on
      // every poll, which reads as the table flickering.
      .sort((a, b) => b.total - a.total || a.userId.localeCompare(b.userId));

    return { days, agents, truncated, earliestCoveredDay };
  },
});
