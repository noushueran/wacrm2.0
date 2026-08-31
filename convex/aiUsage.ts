import { accountQuery } from "./lib/auth";
import { internal } from "./_generated/api";
import { internalMutation, type MutationCtx } from "./_generated/server";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
// `hourStartMs` is shared with the message rollup rather than redefined:
// both tables bucket on the same UTC hour, and two definitions of "which
// hour is this" is exactly the drift that would put the two charts on
// different boundaries.
import { HOUR_MS, hourStartMs } from "./lib/messageStats";
import {
  AI_USAGE_MODES,
  AI_USAGE_PROVIDERS,
  addSample,
  emptyBucket,
  foldHoursIntoUsageSummary,
  type UsageHourBucket,
  type UsageSample,
  type UsageSummary,
} from "./lib/aiUsageStats";

// ============================================================
// Per-LLM-call token usage log (`convex/schema.ts`'s `aiUsageLog`,
// Convex counterpart to migration 033 / `src/lib/ai/usage.ts`'s
// `logAiUsage`) — append-only, cost visibility on the account's BYO
// provider key. `log` is `internalMutation`, not `accountMutation`:
// there is no user session at the point a usage row is written (the
// Task-3 auto-reply/draft actions call it via
// `ctx.runMutation(internal.aiUsage.log, { accountId, ... })` after a
// provider call completes), so `accountId` is a caller-supplied arg
// here instead of derived from `ctx.accountId` — same shape as
// `automationsEngine.ts`'s `createLog`. `summary` IS `accountQuery`,
// gated `ctx.requireRole("admin")`: raw per-call provider/model/token
// rows are billing-class detail, the same trust level `apiKeys.list`
// was RAISED TO earlier in this branch (`convex/apiKeys.ts`). This
// comment used to claim parity with `apiKeys.list` back when THAT query
// was still open to viewer+ — it was never updated when `apiKeys.list`
// was tightened, so it went stale (whole-branch review Fix 2). `summary`
// now actually enforces the same admin floor server-side instead of
// relying on the client (`ai-usage.tsx`) to skip the query, which was
// UI-only and trivially bypassable by any authenticated member calling
// the query directly.
//
// Every call is written TWICE: once as a raw `aiUsageLog` row (the audit
// trail) and once folded into that hour's `aiUsageHourlyStats` bucket
// (what the Usage tab reads). See `lib/aiUsageStats.ts` for why the card
// cannot read the raw rows.
// ============================================================

const modeValidator = v.union(...AI_USAGE_MODES.map((mode) => v.literal(mode)));
const providerValidator = v.union(
  ...AI_USAGE_PROVIDERS.map((p) => v.literal(p)),
);

/**
 * Fold one call into the account's hourly rollup, the read-bounded source
 * for the Usage tab (see `lib/aiUsageStats.ts` and the
 * `aiUsageHourlyStats` comment in schema.ts).
 *
 * PATCHes an open bucket rather than inserting per call — a row per call
 * would just reproduce the unbounded read this exists to remove. Same
 * shape as `messages.ts`'s `recordMessageInHourlyStats`, including its
 * `Date.now()` keying: the row's `_creationTime` is not known until after
 * the insert and would cost a read-back, and the two differ by
 * microseconds.
 *
 * Concurrent calls in the same hour contend on this one document. Convex
 * retries a mutation that loses the OCC race, and it retries the whole
 * transaction — the raw insert included — so a retry can neither
 * double-count the bucket nor duplicate the ledger row.
 */
async function recordUsageInHourlyStats(
  ctx: { db: MutationCtx["db"] },
  accountId: Id<"accounts">,
  sample: UsageSample,
): Promise<void> {
  const bucketStart = hourStartMs(Date.now());

  const existing = await ctx.db
    .query("aiUsageHourlyStats")
    .withIndex("by_account_hour", (q) =>
      q.eq("accountId", accountId).eq("hourStartMs", bucketStart),
    )
    .unique();

  const bucket: UsageHourBucket = existing
    ? {
        hourStartMs: existing.hourStartMs,
        calls: existing.calls,
        promptTokens: existing.promptTokens,
        completionTokens: existing.completionTokens,
        totalTokens: existing.totalTokens,
        cachedPromptTokens: existing.cachedPromptTokens,
        cacheablePromptTokens: existing.cacheablePromptTokens,
        reasoningTokens: existing.reasoningTokens,
        modes: existing.modes.map((m) => ({ ...m })),
        models: existing.models.map((m) => ({ ...m })),
      }
    : emptyBucket(bucketStart);

  addSample(bucket, sample);

  const { hourStartMs: _hour, ...counters } = bucket;
  if (existing) {
    await ctx.db.patch(existing._id, counters);
    return;
  }
  await ctx.db.insert("aiUsageHourlyStats", { accountId, ...bucket });
}

/**
 * Best-effort append of one LLM-call's token usage. "Best-effort" here
 * means the one thing `logAiUsage` (the source) checks before ever
 * touching the DB: skip entirely when the provider reported no usage
 * at all (`if (!args.usage) return`) — there's nothing worth a row for.
 * Once that guard passes, this inserts unconditionally; unlike the
 * source (a raw Supabase network call wrapped in try/catch so a
 * transient DB error can't fail the reply the customer is waiting on),
 * a Convex mutation either commits or the whole transaction rolls back,
 * and containing that failure is the CALLING action's job (Task 3's
 * `dispatchInbound` wraps its `ctx.runMutation` calls so usage logging
 * can never take down a reply already sent) — not this mutation's.
 */
export const log = internalMutation({
  args: {
    accountId: v.id("accounts"),
    conversationId: v.optional(v.id("conversations")),
    // Both unions are derived from `lib/aiUsageStats.ts`, the same source
    // schema.ts's table uses. They used to be hand-written copies of it
    // and drifted twice (`score`, `match_service`), each time rejecting a
    // write the table would have accepted.
    mode: modeValidator,
    provider: providerValidator,
    model: v.string(),
    promptTokens: v.number(),
    completionTokens: v.number(),
    totalTokens: v.number(),
    cachedPromptTokens: v.optional(v.number()),
    reasoningTokens: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    if (
      args.promptTokens === 0 &&
      args.completionTokens === 0 &&
      args.totalTokens === 0
    ) {
      return;
    }

    await ctx.db.insert("aiUsageLog", {
      accountId: args.accountId,
      conversationId: args.conversationId,
      mode: args.mode,
      provider: args.provider,
      model: args.model,
      promptTokens: args.promptTokens,
      completionTokens: args.completionTokens,
      totalTokens: args.totalTokens,
      // Written only when the caller actually has a number, so a row
      // from a provider/endpoint that reports neither stays byte-shaped
      // exactly as before rather than gaining two zeroes that would read
      // as "measured, and it was zero" — the usage page's cache-hit rate
      // divides by rows that HAVE a value, so the distinction matters.
      ...(args.cachedPromptTokens !== undefined
        ? { cachedPromptTokens: args.cachedPromptTokens }
        : {}),
      ...(args.reasoningTokens !== undefined
        ? { reasoningTokens: args.reasoningTokens }
        : {}),
    });

    // Same transaction as the insert above, so the rollup and the ledger
    // commit together or not at all.
    await recordUsageInHourlyStats(ctx, args.accountId, {
      mode: args.mode,
      provider: args.provider,
      model: args.model,
      promptTokens: args.promptTokens,
      completionTokens: args.completionTokens,
      totalTokens: args.totalTokens,
      cachedPromptTokens: args.cachedPromptTokens,
      reasoningTokens: args.reasoningTokens,
    });
  },
});

/**
 * No offered window can reach this: the picker's widest is 90 days
 * (2,160 hours). It bounds a caller who asks for an absurd `sinceMs`
 * rather than the traffic in a normal one — the read is already a
 * function of the WINDOW, which is the whole point of the rollup.
 */
const MAX_HOURS = 24 * 400;

/**
 * Admin+ only (billing-class per-call provider/model/token detail — see
 * the module header above). The account's token spend over the window,
 * aggregated server-side.
 *
 * Reads `aiUsageHourlyStats`, NOT the raw log. Collecting the raw rows
 * was bounded by the window but not by traffic: at ~4,000 calls/day it
 * asked for ~120,000 documents on the default 30-day view and ~360,000 on
 * the 90-day one, and Convex killed it (`Your request timed out
 * performing too many system operations`) — so the card showed a skeleton
 * forever, at every window offered. The rollup makes the read a function
 * of the window alone (24 rows per day) no matter how busy the account
 * gets.
 *
 * Returns the finished breakdown rather than rows for the client to fold.
 * The old shape shipped the aggregation to `ai-usage.tsx`, which is what
 * forced the raw rows over the wire in the first place; `dashboard.ts`'s
 * `conversationsSeries` already established that the day fold belongs
 * here, next to the read that bounds it.
 *
 * `dayKeys` + `tzOffsetMinutes` come from the caller for the same reason
 * they do there: a Convex function runs in UTC, so only the browser knows
 * which local days it is asking about.
 */
export const summary = accountQuery({
  args: {
    sinceMs: v.number(),
    dayKeys: v.array(v.string()),
    tzOffsetMinutes: v.number(),
  },
  handler: async (ctx, args): Promise<UsageSummary> => {
    ctx.requireRole("admin");

    // `hourStartMs(sinceMs)` rather than `sinceMs`: the bucket containing
    // `sinceMs` starts before it, so ranging on the raw value would drop
    // the first partial hour. Extra hours at the edges are harmless —
    // `foldHoursIntoUsageSummary` discards anything outside `dayKeys`,
    // from the totals as well as the chart.
    const hours = await ctx.db
      .query("aiUsageHourlyStats")
      .withIndex("by_account_hour", (q) =>
        q
          .eq("accountId", ctx.accountId)
          .gte("hourStartMs", hourStartMs(args.sinceMs)),
      )
      .take(MAX_HOURS);

    return foldHoursIntoUsageSummary(hours, args.dayKeys, args.tzOffsetMinutes);
  },
});

// ============================================================
// One-shot backfill for `aiUsageHourlyStats`.
//
// The rollup is maintained going forward by `recordUsageInHourlyStats`,
// so without this the Usage tab is empty for everything logged before
// deploy — which, on this deployment, is every row there has ever been.
// Run manually:
//
//   npx convex run aiUsage:backfillAiUsageHourlyStats
//
// Batched, because `.collect()` over `aiUsageLog` is the very thing this
// whole change exists to avoid — it reschedules itself until every
// account is done.
//
// IDEMPOTENT, by rebuilding whole hours rather than incrementing: each
// pass SETS a bucket to the totals it just measured. A batch that ends
// mid-hour drops that partial hour and rewinds the cursor to its start,
// so an hour is only written once it has been seen in full. Re-running
// the whole backfill therefore converges on the same numbers instead of
// doubling them, which an increment-based version would not.
//
// It is idempotent per CHAIN, not concurrency-safe: two chains running at
// once can interleave a rewind with a write and inflate a bucket. Start
// it once and let it drain — the same rule every other backfill in this
// repo carries.
// ============================================================

/** Rows read per batch. Comfortably under the read limit while leaving
 *  room for the bucket upserts in the same mutation. */
const BACKFILL_BATCH = 2000;

/**
 * Cap on the re-read of a single hour that filled a whole batch.
 *
 * `messages.ts`'s backfill, which this one is modelled on, handles that
 * case by writing what it measured and stepping past — its comment argues
 * a >500-row hour needs >12k messages/day and is "far beyond this
 * deployment". That reasoning does NOT carry over: AI calls are ~4,000 a
 * day against a fraction of the messages, and the FIRST run of this
 * backfill undercounted the two busiest days (Jul 27 by 107 calls, Aug 7
 * by 21) because their peak hours cleared the old 500 bound. Silently
 * short bars on exactly the days worth looking at is the failure this
 * whole change exists to prevent, so an overflowing hour is re-read in
 * full instead of truncated.
 */
const MAX_HOUR_ROWS = 12_000;

export const backfillAiUsageHourlyStats = internalMutation({
  args: {
    // Absent = start at the first account. Threaded by the self-schedule.
    accountId: v.optional(v.id("accounts")),
    cursorMs: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<void> => {
    const accounts = await ctx.db.query("accounts").collect();
    if (accounts.length === 0) return;

    const index = args.accountId
      ? accounts.findIndex((a) => a._id === args.accountId)
      : 0;
    if (index < 0) return; // account vanished mid-backfill; nothing to resume
    const account = accounts[index]!;

    const advanceToNextAccount = async () => {
      const next = accounts[index + 1];
      if (!next) return; // all accounts done
      await ctx.scheduler.runAfter(
        0,
        internal.aiUsage.backfillAiUsageHourlyStats,
        { accountId: next._id },
      );
    };

    const batch = await ctx.db
      .query("aiUsageLog")
      .withIndex("by_account", (q) =>
        args.cursorMs === undefined
          ? q.eq("accountId", account._id)
          : q.eq("accountId", account._id).gte("_creationTime", args.cursorMs),
      )
      .take(BACKFILL_BATCH);

    if (batch.length === 0) {
      await advanceToNextAccount();
      return;
    }

    // Group this batch into hour buckets, through the SAME fold the live
    // write uses — a second implementation here is how a backfilled hour
    // and a live one end up disagreeing.
    const hours = new Map<number, UsageHourBucket>();
    for (const row of batch) {
      const key = hourStartMs(row._creationTime);
      let bucket = hours.get(key);
      if (!bucket) {
        bucket = emptyBucket(key);
        hours.set(key, bucket);
      }
      addSample(bucket, {
        mode: row.mode,
        provider: row.provider,
        model: row.model,
        promptTokens: row.promptTokens,
        completionTokens: row.completionTokens,
        totalTokens: row.totalTokens,
        cachedPromptTokens: row.cachedPromptTokens,
        reasoningTokens: row.reasoningTokens,
      });
    }

    const sortedHours = [...hours.keys()].sort((a, b) => a - b);
    const isFullBatch = batch.length === BACKFILL_BATCH;

    // A full batch almost certainly stops mid-hour. Withhold that last
    // hour and resume from its start so it is written only once it has
    // been observed end-to-end — that is what keeps SET idempotent.
    //
    // Unless the whole batch is ONE hour: withholding it would rewind the
    // cursor to where it already is and loop forever. Re-read that hour in
    // full and SET it from everything it contains, so the bound on a batch
    // never becomes a bound on an hour's COUNT. Still one whole hour
    // written at once, so idempotency is untouched.
    const singleHourOverflow = isFullBatch && sortedHours.length === 1;
    const hoursToWrite =
      isFullBatch && !singleHourOverflow ? sortedHours.slice(0, -1) : sortedHours;

    if (singleHourOverflow) {
      const hour = sortedHours[0]!;
      const whole = await ctx.db
        .query("aiUsageLog")
        .withIndex("by_account", (q) =>
          q
            .eq("accountId", account._id)
            .gte("_creationTime", hour)
            .lt("_creationTime", hour + HOUR_MS),
        )
        .take(MAX_HOUR_ROWS);
      const rebuilt = emptyBucket(hour);
      for (const row of whole) {
        addSample(rebuilt, {
          mode: row.mode,
          provider: row.provider,
          model: row.model,
          promptTokens: row.promptTokens,
          completionTokens: row.completionTokens,
          totalTokens: row.totalTokens,
          cachedPromptTokens: row.cachedPromptTokens,
          reasoningTokens: row.reasoningTokens,
        });
      }
      hours.set(hour, rebuilt);
      // Only now is an undercount possible, and only past MAX_HOUR_ROWS
      // calls in one hour — 3x the busiest DAY this deployment has logged.
      if (whole.length >= MAX_HOUR_ROWS) {
        console.warn(
          `[backfill] account ${account._id}: hour ${new Date(hour).toISOString()} has at least ${MAX_HOUR_ROWS} calls; its usage bucket undercounts`,
        );
      }
    }

    for (const hour of hoursToWrite) {
      const { hourStartMs: _hour, ...counters } = hours.get(hour)!;
      const existing = await ctx.db
        .query("aiUsageHourlyStats")
        .withIndex("by_account_hour", (q) =>
          q.eq("accountId", account._id).eq("hourStartMs", hour),
        )
        .unique();
      if (existing) await ctx.db.patch(existing._id, counters);
      else
        await ctx.db.insert("aiUsageHourlyStats", {
          accountId: account._id,
          hourStartMs: hour,
          ...counters,
        });
    }

    if (!isFullBatch) {
      await advanceToNextAccount();
      return;
    }

    const nextCursor = singleHourOverflow
      ? sortedHours[0]! + HOUR_MS // step past the oversized hour
      : sortedHours[sortedHours.length - 1]!; // rewind to the withheld hour
    await ctx.scheduler.runAfter(
      0,
      internal.aiUsage.backfillAiUsageHourlyStats,
      { accountId: account._id, cursorMs: nextCursor },
    );
  },
});
