# AI spend visibility — design

**Status:** approved · **Date:** 2026-07-28

## Problem

`/agents?tab=usage` reports tokens and call counts only. It answers "how much
did the assistant work" but not "how much did that cost" — no daily spend, no
total, no run-rate. Every number on the page is a proxy for money that the page
refuses to name.

The data to compute it is already there. `aiUsageLog` (`convex/schema.ts`) has
carried `provider`, `model`, `promptTokens`, `completionTokens`,
`cachedPromptTokens`, and `reasoningTokens` per call since the 2026-07-27 token
audit. What is missing is **price**: the repo contains no pricing constant of
any kind.

## What is actually billing the key

Sampled 4,000 rows from the production deployment (`convex-api.amaniworld.com`)
on 2026-07-28. Four models, all OpenAI; zero Anthropic rows despite the schema
supporting the provider:

| Model | Rows | Role |
|---|---:|---|
| `text-embedding-3-small` | 1,902 | KB retrieval query embeddings (`embed`) |
| `gpt-5.6-luna` | 1,523 | chat — `auto_reply`, `draft`, `qualify`, `checklist`, `score` |
| `gpt-5.6-terra` | 556 | vision over images/PDFs (`describe`) |
| `gpt-4o-transcribe` | 19 | voice-note speech-to-text (`transcribe`) |

Two observations that shape the design:

1. **Embeddings are the highest-volume model by row count** and are invisible in
   any cost intuition the team currently has. They were only logged at all from
   2026-07-27.
2. **Every chat row carries `cachedPromptTokens: 0`.** The prompt-cache hit rate
   is zero. The reply prompt is dominated by a static ~3.9k-token prefix, so this
   is likely the single largest lever on the bill — and it is exactly what a
   spend view makes visible.

## Constraint that drives the design

Per-token prices for `gpt-5.6-luna`, `gpt-5.6-terra`, and `gpt-4o-transcribe`
cannot be verified from inside this repo or from the assistant's knowledge.
Hard-coding a guess would make the page display authoritative-looking money that
is wrong by an unknown multiple — strictly worse than showing nothing.

**Therefore rates are a first-class, user-owned input**, stored per account and
edited in the app. Code ships defaults only for models whose price is known;
everything else is explicitly *unpriced* and says so.

## Architecture

### Cost is computed at render, not stored at log time

`convex/aiUsage.ts`'s `summary` query keeps returning raw rows; the existing
`useMemo` in `src/components/agents/ai-usage.tsx` gains cost accumulation
alongside its current token accumulation.

Rejected alternative: writing a `costUsd` field on each `aiUsageLog` row at
insert time. It freezes the price at the moment of the call (historically
faithful) but requires a schema change, a backfill of existing rows, and makes a
rate correction unable to fix history. Render-time computation needs neither,
and answers the more useful question — *what does this workload cost at current
rates* — which is what a run-rate projection depends on.

Consequence, stated plainly: correcting a rate retroactively changes every
historical figure on the page. That is intended.

### Rate storage

New Convex table, one row per (account, model):

```
aiModelRates: defineTable({
  accountId:          v.id("accounts"),
  provider:           v.union(v.literal("openai"), v.literal("anthropic")),
  model:              v.string(),
  inputPerMTok:       v.number(),   // USD per 1,000,000 prompt tokens
  cachedInputPerMTok: v.number(),   // USD per 1,000,000 cache-read prompt tokens
  outputPerMTok:      v.number(),   // USD per 1,000,000 completion tokens
  updatedAt:          v.number(),
  updatedByUserId:    v.optional(v.id("users")),
}).index("by_account", ["accountId"])
  .index("by_account_model", ["accountId", "model"])
```

Rates are billing-class data. Read and write are both `accountQuery` /
`accountMutation` gated `ctx.requireRole("admin")`, matching the floor
`aiUsage.summary` and `apiKeys.list` already enforce.

A built-in defaults map lives in `src/lib/ai/pricing.ts`, keyed by model id. It
seeds the editor and acts as the fallback when no stored row exists. It ships
**only** entries whose price is known with confidence; a model absent from both
the table and the defaults is unpriced.

### Cost formula

Per usage row:

```
uncachedPromptTokens = promptTokens − (cachedPromptTokens ?? 0)

costUsd = uncachedPromptTokens  / 1e6 × inputPerMTok
        + (cachedPromptTokens ?? 0) / 1e6 × cachedInputPerMTok
        + completionTokens      / 1e6 × outputPerMTok
```

Two subset invariants from `schema.ts` are respected:

- `cachedPromptTokens` is **part of** `promptTokens` — it is subtracted out and
  re-added at the cache rate, never added on top.
- `reasoningTokens` is **part of** `completionTokens` — it is not billed
  separately. It stays a display-only stat.

Cache-read pricing is ~10% of the input rate on both providers, but the rate is
stored explicitly rather than derived, because the ratio is a provider policy
that can change and differs for cache *writes*.

### Unpriced models are surfaced, never zeroed

A row whose model resolves to no rate contributes **nothing** to any cost total
and is counted into an `unpricedModels` set. If that set is non-empty for the
window, the card shows an amber banner naming the models and linking to the rate
editor. A spend figure is never silently incomplete.

## UI

The card in `src/components/agents/ai-usage.tsx` is retitled **Usage & spend**.
Everything below is additive; no existing stat is removed.

**Stat tiles** — three new tiles lead the row:

- **Total spend** — window total
- **Cost / day** — window total ÷ the window's full day count (7, 30, or 90),
  *not* days since first usage. A window with only three active days averages
  across all thirty; that is the honest reading of "spend per day over the last
  30 days" and keeps the figure comparable when the window is changed.
- **30-day run rate** — cost/day × 30, labelled as a projection

Each existing per-mode tile (Auto-reply, Drafts, Classify, Qualify, Checklist,
Lead scoring, Media, Embeddings) gains a small cost sub-line under its token
count, so the modes rank by money as well as volume.

**Daily chart** — a Tokens ⇄ Cost segmented toggle above the bar chart. Same
bars, same `BarChart` component, swapped series and value formatter.

**By-model list** — gains a spend column per model. A model with no rate renders
an amber "no rate" chip in place of a figure, and the row links to the editor.

**Currency** — USD is primary (that is what the provider invoices). AED is shown
alongside at the fixed peg **3.6725 AED = 1 USD**, hard-coded as a peg rather
than fetched: it is a currency board rate, not a floating one. Rendered as
`$42.10 · د.إ 154.61`. `src/lib/currency.ts` already carries an AED entry in
`CURRENCIES`; the formatter is reused.

**Rate editor** — a dialog opened from the card header, admin only. Lists every
model seen in the current window plus every model with a stored rate, each with
three numeric inputs (input / cached input / output, USD per million tokens).
Rows seeded from `pricing.ts` defaults are marked as defaults until saved.
Saving writes `aiModelRates`. Copy on the dialog states plainly that the numbers
should come from the provider's own billing page.

## Scope boundaries

In scope: the usage tab, the rate table, and the editor.

Explicitly **not** in scope:

- Budgets, spend alerts, or hard caps on the provider key
- Per-conversation or per-customer cost attribution (`conversationId` is on the
  rows and makes this possible later, but it is a separate feature)
- Any change to how or when `aiUsage.log` is written
- Acting on the 0% cache-hit finding — this design only makes it visible

## Verification

- Unit tests over the cost reducer: subset invariants (cached ⊂ prompt,
  reasoning ⊂ completion), unpriced-model exclusion, empty-window zero case,
  and a hand-computed fixture.
- `convex/aiModelRates.test.ts` for the admin role floor on both read and write,
  mirroring the existing `aiUsage.test.ts` gating tests.
- Manual: load `/agents?tab=usage` against the live deployment with no rates
  configured and confirm the page shows the unpriced banner and zero spend
  rather than a fabricated number; then set one rate and confirm only that
  model's spend appears.
