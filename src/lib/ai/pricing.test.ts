import { describe, expect, test } from 'vitest'
import {
  AED_PER_USD,
  DEFAULT_MODEL_RATES,
  formatAed,
  formatUsd,
  formatUsdWithAed,
  mergeRates,
  rowCostUsd,
  summarizeSpend,
  type ModelRate,
  type ModelTallyForCost,
} from './pricing'

const RATE: ModelRate = {
  inputPerMTok: 10,
  cachedInputPerMTok: 1,
  outputPerMTok: 30,
}

describe('rowCostUsd', () => {
  test('prices uncached prompt tokens and completion tokens', () => {
    // 1,000,000 prompt @ $10 + 1,000,000 completion @ $30 = $40
    const cost = rowCostUsd(
      { model: 'm', promptTokens: 1_000_000, completionTokens: 1_000_000 },
      RATE,
    )
    expect(cost).toBeCloseTo(40, 10)
  })

  test('cachedPromptTokens is a SUBSET of promptTokens, not an addition', () => {
    // 1,000,000 prompt of which 400,000 cached:
    //   600,000 @ $10/M = $6.00
    // + 400,000 @  $1/M = $0.40
    // = $6.40. Adding the cache on top would give $6.40 + $4.00.
    const cost = rowCostUsd(
      {
        model: 'm',
        promptTokens: 1_000_000,
        completionTokens: 0,
        cachedPromptTokens: 400_000,
      },
      RATE,
    )
    expect(cost).toBeCloseTo(6.4, 10)
  })

  test('treats a missing cachedPromptTokens as zero cached', () => {
    const withUndefined = rowCostUsd(
      { model: 'm', promptTokens: 1_000_000, completionTokens: 0 },
      RATE,
    )
    const withZero = rowCostUsd(
      {
        model: 'm',
        promptTokens: 1_000_000,
        completionTokens: 0,
        cachedPromptTokens: 0,
      },
      RATE,
    )
    expect(withUndefined).toBeCloseTo(10, 10)
    expect(withZero).toBeCloseTo(10, 10)
  })

  test('returns null — not 0 — when the model has no rate', () => {
    const cost = rowCostUsd(
      { model: 'gpt-5.6-luna', promptTokens: 1_000, completionTokens: 500 },
      undefined,
    )
    expect(cost).toBeNull()
  })

  test('a priced row with no tokens costs exactly zero', () => {
    // The empty-window case at module level. The component's own empty
    // window never reaches cost display — the existing `hasSpend` guard
    // renders the empty state first.
    const cost = rowCostUsd(
      { model: 'm', promptTokens: 0, completionTokens: 0 },
      RATE,
    )
    expect(cost).toBe(0)
  })

  test('clamps a cached count that exceeds the prompt count to zero uncached', () => {
    // Defensive: a malformed row must never produce negative spend.
    const cost = rowCostUsd(
      {
        model: 'm',
        promptTokens: 100_000,
        completionTokens: 0,
        cachedPromptTokens: 500_000,
      },
      RATE,
    )
    expect(cost).toBeGreaterThanOrEqual(0)
  })
})

describe('DEFAULT_MODEL_RATES', () => {
  test('ships no rate for the unverified gpt-5.6 tier or gpt-4o-transcribe', () => {
    // These three models bill this account's key today, but their prices
    // cannot be verified from inside this repo. They MUST stay absent so
    // the UI reports them as unpriced instead of showing a fabricated
    // number. See the design doc's "Constraint that drives the design".
    expect(DEFAULT_MODEL_RATES['gpt-5.6-luna']).toBeUndefined()
    expect(DEFAULT_MODEL_RATES['gpt-5.6-terra']).toBeUndefined()
    expect(DEFAULT_MODEL_RATES['gpt-4o-transcribe']).toBeUndefined()
  })

  test('every shipped rate is non-negative and finite', () => {
    for (const [model, rate] of Object.entries(DEFAULT_MODEL_RATES)) {
      for (const key of [
        'inputPerMTok',
        'cachedInputPerMTok',
        'outputPerMTok',
      ] as const) {
        expect(Number.isFinite(rate[key]), `${model}.${key}`).toBe(true)
        expect(rate[key], `${model}.${key}`).toBeGreaterThanOrEqual(0)
      }
    }
  })

  test('prices Claude Haiku 4.5 at its published rate', () => {
    expect(DEFAULT_MODEL_RATES['claude-haiku-4-5']).toEqual({
      inputPerMTok: 1,
      cachedInputPerMTok: 0.1,
      outputPerMTok: 5,
    })
  })
})

describe('formatting', () => {
  test('shows cents for ordinary amounts', () => {
    expect(formatUsd(12.3456)).toBe('$12.35')
    expect(formatUsd(0.5)).toBe('$0.50')
  })

  test('shows four decimals for sub-cent amounts so they never read as zero', () => {
    expect(formatUsd(0.0042)).toBe('$0.0042')
  })

  test('renders an exact zero plainly', () => {
    expect(formatUsd(0)).toBe('$0.00')
  })

  test('converts to AED at the fixed peg', () => {
    expect(AED_PER_USD).toBe(3.6725)
    expect(formatAed(10)).toBe('د.إ 36.73')
  })

  test('renders the combined USD · AED form', () => {
    expect(formatUsdWithAed(10)).toBe('$10.00 · د.إ 36.73')
  })
})

describe('mergeRates', () => {
  test('the account row beats the built-in default', () => {
    const merged = mergeRates([
      {
        model: 'claude-haiku-4-5',
        inputPerMTok: 9,
        cachedInputPerMTok: 0.9,
        outputPerMTok: 45,
      },
    ])
    expect(merged['claude-haiku-4-5']).toEqual({
      inputPerMTok: 9,
      cachedInputPerMTok: 0.9,
      outputPerMTok: 45,
    })
    // Defaults for other models survive the merge.
    expect(merged['text-embedding-3-small']?.inputPerMTok).toBe(0.02)
  })

  test('a model with no stored row keeps its default', () => {
    expect(mergeRates([])['claude-sonnet-4-6']?.outputPerMTok).toBe(15)
  })
})

describe('summarizeSpend', () => {
  function tally(over: Partial<ModelTallyForCost> = {}): ModelTallyForCost {
    return {
      provider: 'openai',
      model: 'text-embedding-3-small',
      calls: 1,
      tokens: 1_000_000,
      promptTokens: 1_000_000,
      completionTokens: 0,
      cachedPromptTokens: 0,
      ...over,
    }
  }

  test('totals only the models it could price', () => {
    const out = summarizeSpend(
      [tally(), tally({ model: 'gpt-5.6-luna', tokens: 500 })],
      mergeRates([]),
    )
    // 1M embedding tokens at $0.02/MTok. The unpriced model adds nothing.
    expect(out.totalUsd).toBeCloseTo(0.02, 10)
    expect(out.needRates).toEqual(['gpt-5.6-luna'])
    expect(out.complete).toBe(false)
  })

  test('an unpriced model is reported, never priced as free', () => {
    const out = summarizeSpend([tally({ model: 'gpt-5.6-luna' })], mergeRates([]))
    expect(out.totalUsd).toBe(0)
    expect(out.models[0]?.costUsd).toBeNull()
    expect(out.models[0]?.unpricedReason).toBe('no-rate')
  })

  test('a rate the admin entered prices a model the defaults refuse to', () => {
    const out = summarizeSpend(
      [tally({ model: 'gpt-5.6-luna', promptTokens: 1_000_000 })],
      mergeRates([
        {
          model: 'gpt-5.6-luna',
          inputPerMTok: 2,
          cachedInputPerMTok: 0.2,
          outputPerMTok: 8,
        },
      ]),
    )
    expect(out.totalUsd).toBeCloseTo(2, 10)
    expect(out.complete).toBe(true)
  })

  // The distinction the two buckets exist for: entering a rate cannot fix
  // a missing split, so the two must not be reported as one problem.
  test('a model with no token split needs a backfill, not a rate', () => {
    const out = summarizeSpend(
      [
        {
          provider: 'openai',
          model: 'text-embedding-3-small',
          calls: 1,
          tokens: 100,
        },
      ],
      mergeRates([]),
    )
    expect(out.models[0]?.unpricedReason).toBe('no-split')
    expect(out.needBackfill).toEqual(['text-embedding-3-small'])
    // It has a perfectly good rate — that is not what is missing.
    expect(out.needRates).toEqual([])
  })

  test('an empty window is complete, not broken', () => {
    const out = summarizeSpend([], mergeRates([]))
    expect(out).toMatchObject({ totalUsd: 0, complete: true })
  })

  test('cached prompt tokens bill at the cache rate, not the input rate', () => {
    const rates = mergeRates([
      { model: 'm', inputPerMTok: 10, cachedInputPerMTok: 1, outputPerMTok: 0 },
    ])
    const out = summarizeSpend(
      [
        tally({
          model: 'm',
          promptTokens: 1_000_000,
          cachedPromptTokens: 900_000,
          completionTokens: 0,
        }),
      ],
      rates,
    )
    // 100k at $10/MTok + 900k at $1/MTok = $1.00 + $0.90.
    expect(out.totalUsd).toBeCloseTo(1.9, 10)
  })
})
