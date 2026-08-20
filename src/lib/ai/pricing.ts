// ============================================================
// Pricing for the AI usage dashboard (`src/components/agents/ai-usage.tsx`).
//
// `aiUsageLog` has carried per-call provider/model/token counts since the
// 2026-07-27 token audit, but the repo has never held a price, so the
// usage tab could only ever report volume. This module is the missing
// half: it turns a usage row into money.
//
// THE RULE THIS MODULE EXISTS TO ENFORCE: never invent a price. The map
// below ships only rates that are verified. Every other model — including
// the three that actually bill this account's key today — resolves to
// `undefined`, `rowCostUsd` returns `null` rather than 0, and the UI
// reports it as unpriced. A dashboard whose whole job is telling you what
// you spend must not display a number it made up.
// ============================================================

export interface ModelRate {
  /** USD per 1,000,000 prompt tokens billed at the full input rate. */
  inputPerMTok: number
  /** USD per 1,000,000 prompt tokens served from the provider's prefix cache. */
  cachedInputPerMTok: number
  /** USD per 1,000,000 completion tokens. */
  outputPerMTok: number
}

/** The subset of an `aiUsageLog` row that pricing depends on. */
export interface UsageRowForCost {
  model: string
  promptTokens: number
  completionTokens: number
  /** A SUBSET of `promptTokens` — see `rowCostUsd`. */
  cachedPromptTokens?: number
}

/**
 * AED is pegged to the dollar by the UAE central bank at a fixed rate —
 * it is a currency board, not a float — so this is hard-coded rather than
 * fetched. If the peg is ever changed, this constant changes with it.
 */
export const AED_PER_USD = 3.6725

/**
 * Built-in rates, used to seed the editor and as the fallback when the
 * account has stored no rate for a model.
 *
 * ⚠️ DELIBERATELY INCOMPLETE. `gpt-5.6-luna`, `gpt-5.6-terra`, and
 * `gpt-4o-transcribe` are the highest-volume models on this deployment
 * and are ABSENT ON PURPOSE: their per-token prices cannot be verified
 * from here, and a wrong rate would render authoritative-looking spend
 * that is off by an unknown multiple. The account admin supplies them
 * through the rate editor, read off the provider's own billing page.
 * Do not "helpfully" fill these in.
 */
export const DEFAULT_MODEL_RATES: Readonly<Record<string, ModelRate>> = {
  // OpenAI embeddings — long-published, stable.
  'text-embedding-3-small': {
    inputPerMTok: 0.02,
    cachedInputPerMTok: 0.02, // embeddings have no prefix cache
    outputPerMTok: 0, // and emit no completion tokens
  },

  // Anthropic. No rows on this deployment today, but the provider is
  // supported by `aiConfigs` and these rates are published.
  // Cache reads bill at ~10% of the input rate on both providers.
  'claude-haiku-4-5': {
    inputPerMTok: 1,
    cachedInputPerMTok: 0.1,
    outputPerMTok: 5,
  },
  'claude-haiku-4-5-20251001': {
    inputPerMTok: 1,
    cachedInputPerMTok: 0.1,
    outputPerMTok: 5,
  },
  'claude-sonnet-4-6': {
    inputPerMTok: 3,
    cachedInputPerMTok: 0.3,
    outputPerMTok: 15,
  },
  'claude-opus-4-8': {
    inputPerMTok: 5,
    cachedInputPerMTok: 0.5,
    outputPerMTok: 25,
  },
}

/**
 * Cost of one usage row in USD, or `null` when the model has no rate.
 *
 * `null` rather than `0` is load-bearing: it forces the caller to decide
 * what an unpriced row means instead of quietly folding it into a total
 * as free. `ai-usage.tsx` counts those rows into an "unpriced models" set
 * and warns.
 *
 * Two subset invariants from `convex/schema.ts` are respected here:
 *   - `cachedPromptTokens` is PART OF `promptTokens`, so it is subtracted
 *     out and re-added at the cache rate — never added on top, which
 *     would double-count the cached span.
 *   - `reasoningTokens` is PART OF `completionTokens`, so it does not
 *     appear in this formula at all.
 */
export function rowCostUsd(
  row: UsageRowForCost,
  rate: ModelRate | undefined,
): number | null {
  if (!rate) return null

  const cached = Math.max(0, row.cachedPromptTokens ?? 0)
  // `Math.max(0, …)` guards a malformed row where the reported cache
  // exceeds the prompt count, which would otherwise produce negative spend.
  const uncached = Math.max(0, row.promptTokens - cached)

  return (
    (uncached / 1_000_000) * rate.inputPerMTok +
    (Math.min(cached, row.promptTokens) / 1_000_000) * rate.cachedInputPerMTok +
    (row.completionTokens / 1_000_000) * rate.outputPerMTok
  )
}

/**
 * USD with enough precision to stay honest at AI-call scale: two decimals
 * normally, four for sub-cent amounts so a real cost never renders as
 * "$0.00" and reads as free.
 */
export function formatUsd(value: number): string {
  const v = Number(value) || 0
  const decimals = v !== 0 && Math.abs(v) < 0.01 ? 4 : 2
  return `$${v.toFixed(decimals)}`
}

/** The same amount converted at the peg, for reading against AED books. */
export function formatAed(usd: number): string {
  const v = (Number(usd) || 0) * AED_PER_USD
  const decimals = v !== 0 && Math.abs(v) < 0.01 ? 4 : 2
  return `د.إ ${v.toFixed(decimals)}`
}

/** `"$12.34 · د.إ 45.32"` — USD is the source of truth, AED is the gloss. */
export function formatUsdWithAed(usd: number): string {
  return `${formatUsd(usd)} · ${formatAed(usd)}`
}

// ============================================================
// Window spend, from the hourly rollup's per-model tallies.
//
// Everything below exists to keep ONE promise: the total shown is the
// sum of the models it could actually price, and every model it could
// not is named. A spend dashboard that silently drops a model is worse
// than one that shows nothing, because it looks complete.
// ============================================================

/** The `ModelTally` fields this needs — structurally, so `convex/` types
 *  do not have to be imported into the client bundle. */
export interface ModelTallyForCost {
  provider: 'openai' | 'anthropic'
  model: string
  calls: number
  tokens: number
  /** Absent on hours rolled up before the per-model split shipped. */
  promptTokens?: number
  completionTokens?: number
  cachedPromptTokens?: number
}

/** Why a model contributed nothing to the total. */
export type UnpricedReason =
  /** No rate: neither a built-in default nor one the admin entered. */
  | 'no-rate'
  /** Rolled up before the per-model token split existed, so the inputs
   *  a price applies to are unknown. Fixed by re-running
   *  `aiUsage.backfillAiUsageHourlyStats`, not by entering a rate. */
  | 'no-split'

export interface PricedModel extends ModelTallyForCost {
  /** `null` exactly when `unpricedReason` is set. */
  costUsd: number | null
  unpricedReason?: UnpricedReason
}

export interface SpendBreakdown {
  /** Sum over the models that priced. Never includes a guess. */
  totalUsd: number
  /** Every model in the window, priced or not, input order preserved. */
  models: PricedModel[]
  /** Models excluded for want of a rate — the admin can fix these. */
  needRates: string[]
  /** Models excluded for want of a token split — a backfill fixes these. */
  needBackfill: string[]
  /** True when every model in the window priced, so the total is the
   *  whole (logged) window rather than a floor. */
  complete: boolean
}

/**
 * Account rates layered over the built-in defaults, keyed by model id.
 *
 * The account's own row wins: `DEFAULT_MODEL_RATES` is a convenience for
 * models with published prices, but the account is the authority on what
 * it actually pays.
 */
export function mergeRates(
  stored: readonly {
    model: string
    inputPerMTok: number
    cachedInputPerMTok: number
    outputPerMTok: number
  }[],
): Record<string, ModelRate> {
  const merged: Record<string, ModelRate> = { ...DEFAULT_MODEL_RATES }
  for (const row of stored) {
    merged[row.model] = {
      inputPerMTok: row.inputPerMTok,
      cachedInputPerMTok: row.cachedInputPerMTok,
      outputPerMTok: row.outputPerMTok,
    }
  }
  return merged
}

/**
 * Price a window's per-model tallies.
 *
 * The two exclusion reasons are kept apart because they need different
 * actions from the reader — one is "type in a rate", the other is "re-run
 * the backfill" — and collapsing them into a single "unpriced" count is
 * how a dashboard tells someone to fix the wrong thing.
 */
export function summarizeSpend(
  byModel: readonly ModelTallyForCost[],
  rates: Record<string, ModelRate>,
): SpendBreakdown {
  const models: PricedModel[] = []
  const needRates: string[] = []
  const needBackfill: string[] = []
  let totalUsd = 0

  for (const tally of byModel) {
    // Split first: without it there is nothing for a rate to apply to,
    // so reporting "no rate" would send the admin to the editor to fix
    // something the editor cannot fix.
    if (tally.promptTokens === undefined || tally.completionTokens === undefined) {
      models.push({ ...tally, costUsd: null, unpricedReason: 'no-split' })
      needBackfill.push(tally.model)
      continue
    }

    const cost = rowCostUsd(
      {
        model: tally.model,
        promptTokens: tally.promptTokens,
        completionTokens: tally.completionTokens,
        cachedPromptTokens: tally.cachedPromptTokens,
      },
      rates[tally.model],
    )

    if (cost === null) {
      models.push({ ...tally, costUsd: null, unpricedReason: 'no-rate' })
      needRates.push(tally.model)
      continue
    }

    models.push({ ...tally, costUsd: cost })
    totalUsd += cost
  }

  return {
    totalUsd,
    models,
    needRates,
    needBackfill,
    complete: needRates.length === 0 && needBackfill.length === 0,
  }
}
