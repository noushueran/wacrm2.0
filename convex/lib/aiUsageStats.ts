// ============================================================
// Hourly AI-usage rollup — the read-bounded source for the /agents Usage
// tab.
//
// `aiUsage.summary` used to `.collect()` every `aiUsageLog` row in the
// requested window and let the client aggregate them. That is bounded by
// the WINDOW but not by traffic, which is the exact failure
// `lib/messageStats.ts` was written to fix for the dashboard's charts —
// and it broke the same way, with the same error: `Your request timed out
// performing too many system operations`. At the ~4,000 calls/day this
// deployment logs (mostly `embed` and `qualify`), the DEFAULT 30-day view
// asked for ~120,000 documents and the 90-day one ~360,000, so no window
// the picker offered could ever load.
//
// A chart cannot be rescued by a read bound: `.take()` returns a partial,
// silently WRONG total, which is worse than a slow one. So the counters
// are accumulated at write time instead, in `aiUsageHourlyStats`, at the
// single `insert("aiUsageLog")` choke point in `aiUsage.log`.
//
// WHY HOURLY, AND WHY UTC
//
// Identical reasoning to `lib/messageStats.ts`, which established this
// pattern — see its header for the full argument. In short: the day
// boundaries belong to the VIEWER (`tzOffsetMinutes` arrives per request),
// so a day-keyed rollup would have to choose a timezone at write time.
// Hourly UTC buckets are timezone-neutral on write and re-bucket into
// correct local days on read, making the read a function of the window
// (24 rows/day, ~2160 for 90 days) rather than of call volume.
//
// Inherits that module's KNOWN LIMIT verbatim: an offset that is not a
// whole number of hours (India +05:30) can misplace an hour straddling
// local midnight. Asia/Dubai, where this CRM runs, is UTC+04:00, so the
// numbers are exact there.
// ============================================================

import { localDayKeyFromMs } from "./dashboardDate";

/**
 * Every mode a logged provider call can carry, in one place.
 *
 * This list is the SINGLE source for all three copies that used to be
 * written out by hand — `schema.ts`'s `aiUsageLog.mode`, `aiUsage.log`'s
 * own args validator, and the rollup below. Those first two are separate
 * literal unions that drifted twice before (see the `score` and
 * `match_service` comments they carry), each time silently rejecting a
 * write the schema allowed. Deriving all of them from this array makes
 * that class of drift unrepresentable: adding a mode here widens the
 * table, the validator, and the rollup together.
 */
export const AI_USAGE_MODES = [
  "auto_reply",
  "draft",
  /** The tag suggester. */
  "classify",
  /**
   * The ad matcher. Split from `classify` (2026-08-08): it shared that
   * value with the tag suggester, so two distinct agents wrote one
   * timesheet line and neither could be counted. Rows written before the
   * split stay `classify` and are attributed to the tag suggester — a
   * bounded inaccuracy that ages out within a day, since the roster
   * reports today's work only.
   */
  "match_service",
  /**
   * The knowledge gap agent (spec 2026-08-09). Covers both of its jobs —
   * drafting a knowledge-base entry from an answered inquiry, and
   * clustering the ones nobody answered.
   */
  "kb_gap",
  /** The sales coach (spec 2026-08-09). Reviews of handled threads. */
  "coach",
  /**
   * The revival agent (spec 2026-08-09). Its own mode so the roster can
   * report what it drafted today, separately from replies.
   */
  "revive",
  "qualify",
  "checklist",
  /** Lead Analysis scoring (spec 2026-07-26-lead-analysis). */
  "score",
  // Media understanding + retrieval embeddings (token audit 2026-07-27).
  // These provider calls have ALWAYS been billed to the account's key and
  // were never logged, so the usage page's own "tokens spent on your
  // provider key" claim was false: it showed chat calls only.
  /** Speech-to-text on a voice note. */
  "transcribe",
  /** The vision pass over an image or PDF — the priciest per call, since
   *  a multi-page document is billed per rendered page. */
  "describe",
  /** The query embedding every KB retrieval makes. */
  "embed",
] as const;

export type AiUsageMode = (typeof AI_USAGE_MODES)[number];

export const AI_USAGE_PROVIDERS = ["openai", "anthropic"] as const;
export type AiUsageProvider = (typeof AI_USAGE_PROVIDERS)[number];

/** Token counters, summed. Shared by an hour bucket and a window total. */
export interface UsageCounters {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Prompt tokens served from the provider's prefix cache. Subset of
   *  `promptTokens`, billed at ~10% of the input rate. */
  cachedPromptTokens: number;
  /** Prompt tokens on calls that actually REPORTED a cache figure, so the
   *  hit rate is not diluted by rows predating the telemetry or by
   *  endpoints (embeddings) that have no cache at all. `undefined` on a
   *  sample means "not measured", which is NOT a measured zero — keeping
   *  the two apart is the whole reason this counter exists alongside
   *  `promptTokens`. */
  cacheablePromptTokens: number;
  /** Reasoning tokens, billed at the output rate. Subset of
   *  `completionTokens`. */
  reasoningTokens: number;
}

export interface ModeTally {
  mode: AiUsageMode;
  calls: number;
  tokens: number;
}

export interface ModelTally {
  provider: AiUsageProvider;
  model: string;
  calls: number;
  tokens: number;
  // The three-way token split, per model, because THAT is what a price
  // applies to: `src/lib/ai/pricing.ts` bills prompt, cached-prompt and
  // completion tokens at three different rates, so `tokens` (the sum)
  // cannot be priced at all. Splitting only at the bucket level — which
  // is all this carried until 2026-08-17 — prices nothing, because a
  // bucket mixes models whose rates differ by two orders of magnitude
  // (embeddings at $0.02/MTok against a chat model at $5).
  //
  // OPTIONAL because buckets written before that date have no split. An
  // ABSENT figure is not a zero: the reader must exclude the model from
  // spend and say so, not price it as free. Re-running
  // `aiUsage.backfillAiUsageHourlyStats` rebuilds history from
  // `aiUsageLog` (which has always carried the split per row) through
  // this same fold, at which point the field is present throughout.
  promptTokens?: number;
  completionTokens?: number;
  /** Subset of `promptTokens`, billed at the cache rate. */
  cachedPromptTokens?: number;
}

/**
 * One hour bucket as stored. `modes`/`models` are arrays rather than
 * records because the mode list is closed but small (11) and the model
 * list is open-ended: a column per mode would need a schema migration
 * every time a model string appears, and `v.record` is used nowhere else
 * in this schema.
 */
export interface UsageHourBucket extends UsageCounters {
  hourStartMs: number;
  modes: ModeTally[];
  models: ModelTally[];
}

/** One provider call's usage, as handed to `aiUsage.log`. */
export interface UsageSample {
  mode: AiUsageMode;
  provider: AiUsageProvider;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedPromptTokens?: number;
  reasoningTokens?: number;
}

export function emptyCounters(): UsageCounters {
  return {
    calls: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cachedPromptTokens: 0,
    cacheablePromptTokens: 0,
    reasoningTokens: 0,
  };
}

export function emptyBucket(hourStartMs: number): UsageHourBucket {
  return { hourStartMs, ...emptyCounters(), modes: [], models: [] };
}

/**
 * Fold one call into a bucket, in place.
 *
 * Used by BOTH the live write (`aiUsage.log`) and the backfill, so the two
 * can never disagree about what a bucket means — the divergence that would
 * otherwise only show up as a step in the chart at the deploy boundary.
 */
export function addSample(bucket: UsageHourBucket, sample: UsageSample): void {
  bucket.calls += 1;
  bucket.promptTokens += sample.promptTokens;
  bucket.completionTokens += sample.completionTokens;
  bucket.totalTokens += sample.totalTokens;
  bucket.reasoningTokens += sample.reasoningTokens ?? 0;
  // Only a call that reported a figure counts toward the cache rate — see
  // `cacheablePromptTokens` above.
  if (sample.cachedPromptTokens !== undefined) {
    bucket.cachedPromptTokens += sample.cachedPromptTokens;
    bucket.cacheablePromptTokens += sample.promptTokens;
  }

  const mode = bucket.modes.find((m) => m.mode === sample.mode);
  if (mode) {
    mode.calls += 1;
    mode.tokens += sample.totalTokens;
  } else {
    bucket.modes.push({ mode: sample.mode, calls: 1, tokens: sample.totalTokens });
  }

  const model = bucket.models.find(
    (m) => m.model === sample.model && m.provider === sample.provider,
  );
  if (model) {
    model.calls += 1;
    model.tokens += sample.totalTokens;
    // `?? 0` seeds the split onto a tally read back from a pre-split
    // bucket. That undercounts rather than corrupting: the figure then
    // covers this run's samples only, and the reader still sees a
    // present-but-low number instead of an absent one. The backfill
    // rewrites whole hours from scratch, so it never lands here.
    model.promptTokens = (model.promptTokens ?? 0) + sample.promptTokens;
    model.completionTokens =
      (model.completionTokens ?? 0) + sample.completionTokens;
    model.cachedPromptTokens =
      (model.cachedPromptTokens ?? 0) + (sample.cachedPromptTokens ?? 0);
  } else {
    bucket.models.push({
      provider: sample.provider,
      model: sample.model,
      calls: 1,
      tokens: sample.totalTokens,
      promptTokens: sample.promptTokens,
      completionTokens: sample.completionTokens,
      cachedPromptTokens: sample.cachedPromptTokens ?? 0,
    });
  }
}

export type ModeTotals = Record<AiUsageMode, { calls: number; tokens: number }>;

export interface UsageSummary {
  windowDays: number;
  totals: UsageCounters;
  byMode: ModeTotals;
  /** Descending by tokens — the order the "By model" list renders in. */
  byModel: ModelTally[];
  /** One entry per requested day key, in the order given, zero-filled. */
  daily: { date: string; tokens: number; calls: number }[];
}

function emptyModeTotals(): ModeTotals {
  return Object.fromEntries(
    AI_USAGE_MODES.map((m) => [m, { calls: 0, tokens: 0 }]),
  ) as ModeTotals;
}

/**
 * Fold hourly UTC buckets into the caller's local calendar days, plus the
 * window's totals and its by-mode / by-model breakdowns.
 *
 * Every key in `dayKeys` is seeded to zero so a quiet day charts as a zero
 * rather than a gap, and an hour falling outside that range is dropped
 * rather than adding a key the caller did not ask for — the same contract
 * `foldHoursIntoDays` has.
 *
 * TOTALS COVER EXACTLY THE CHARTED DAYS. An hour outside `dayKeys` is
 * excluded from the tiles as well as the bars, so "Total tokens" always
 * reconciles with the chart beneath it and with the per-mode tiles. The
 * read deliberately over-fetches at both edges (`hourStartMs(sinceMs)`
 * starts before `sinceMs`), and counting those spill-over hours in the
 * tiles but not the chart is precisely how a dashboard ends up with
 * numbers that do not add up.
 */
export function foldHoursIntoUsageSummary(
  rows: readonly UsageHourBucket[],
  dayKeys: readonly string[],
  tzOffsetMinutes: number,
): UsageSummary {
  const daily = new Map<string, { date: string; tokens: number; calls: number }>();
  for (const key of dayKeys) daily.set(key, { date: key, tokens: 0, calls: 0 });

  const totals = emptyCounters();
  const byMode = emptyModeTotals();
  const byModel = new Map<string, ModelTally>();
  const modelsMissingSplit = new Set<string>();

  for (const row of rows) {
    // Keyed off the hour's START. With a whole-hour offset every call in
    // the bucket shares that local day, which is what makes the re-bucket
    // exact (see KNOWN LIMIT in the header).
    const day = daily.get(localDayKeyFromMs(row.hourStartMs, tzOffsetMinutes));
    if (!day) continue;

    day.tokens += row.totalTokens;
    day.calls += row.calls;

    totals.calls += row.calls;
    totals.promptTokens += row.promptTokens;
    totals.completionTokens += row.completionTokens;
    totals.totalTokens += row.totalTokens;
    totals.cachedPromptTokens += row.cachedPromptTokens;
    totals.cacheablePromptTokens += row.cacheablePromptTokens;
    totals.reasoningTokens += row.reasoningTokens;

    for (const m of row.modes) {
      // A mode retired from `AI_USAGE_MODES` would leave rows behind that
      // no longer have a slot. Skipping beats crashing the whole card, and
      // beats `byMode[m.mode].calls += 1` on `undefined` — the shape the
      // client-side version had, which would have taken the page down.
      const slot = byMode[m.mode];
      if (!slot) continue;
      slot.calls += m.calls;
      slot.tokens += m.tokens;
    }

    for (const m of row.models) {
      const key = `${m.provider}:${m.model}`;
      // One pre-split hour anywhere in the window makes the whole
      // window's split for that model wrong-by-omission, so the flag is
      // sticky: a model is priceable only if EVERY hour contributing to
      // it carried the split. Summing the hours that happen to have it
      // would report a confident number covering an unknown fraction of
      // the window — the exact failure `rowCostUsd` returns `null` to
      // prevent, reintroduced one level up.
      if (m.promptTokens === undefined) modelsMissingSplit.add(key);

      const slot = byModel.get(key);
      if (slot) {
        slot.calls += m.calls;
        slot.tokens += m.tokens;
        slot.promptTokens = (slot.promptTokens ?? 0) + (m.promptTokens ?? 0);
        slot.completionTokens =
          (slot.completionTokens ?? 0) + (m.completionTokens ?? 0);
        slot.cachedPromptTokens =
          (slot.cachedPromptTokens ?? 0) + (m.cachedPromptTokens ?? 0);
      } else {
        byModel.set(key, {
          ...m,
          promptTokens: m.promptTokens ?? 0,
          completionTokens: m.completionTokens ?? 0,
          cachedPromptTokens: m.cachedPromptTokens ?? 0,
        });
      }
    }
  }

  // Strip the split back off wherever it is incomplete, so `undefined`
  // means the same thing on the way out as it did on the way in.
  for (const key of modelsMissingSplit) {
    const slot = byModel.get(key);
    if (!slot) continue;
    delete slot.promptTokens;
    delete slot.completionTokens;
    delete slot.cachedPromptTokens;
  }

  return {
    windowDays: dayKeys.length,
    totals,
    byMode,
    byModel: [...byModel.values()].sort((a, b) => b.tokens - a.tokens),
    daily: dayKeys.map((key) => daily.get(key)!),
  };
}
