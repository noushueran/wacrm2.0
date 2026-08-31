# AI Spend Visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show what the AI assistant actually costs — total spend, cost per day, and a run-rate projection — on `/agents?tab=usage`, priced from admin-editable per-model rates.

**Architecture:** Cost is computed client-side in the existing `useMemo` that already aggregates raw `aiUsageLog` rows; no schema change to the usage log and no backfill. Per-model rates live in a new admin-gated `aiModelRates` Convex table, seeded from a defaults map in code and edited in a dialog on the usage card. A model with no rate anywhere contributes nothing to any total and is surfaced in an amber banner — a spend figure is never silently incomplete.

**Tech Stack:** Next.js (App Router) · Convex (self-hosted) · React · TypeScript · Vitest + convex-test · Tailwind + shadcn/ui · Tremor bar chart (vendored)

## Global Constraints

- **Read `docs/superpowers/specs/2026-07-28-ai-spend-visibility-design.md` before starting.** It carries the reasoning; this plan carries the steps.
- **Never invent a per-token price.** `DEFAULT_MODEL_RATES` ships only rates that are verified. `gpt-5.6-luna`, `gpt-5.6-terra`, and `gpt-4o-transcribe` — the three models actually billing this account's key — are deliberately **absent** and must stay absent. They are filled in by the account admin through the rate editor. A guessed rate on a spend dashboard is worse than no rate.
- **Rates are billing-class data.** Every `aiModelRates` query and mutation calls `ctx.requireRole("admin")`, matching the floor `aiUsage.summary` and `apiKeys.list` already enforce. Client-side gating alone is not acceptable — it is trivially bypassable by calling the function directly.
- **Subset invariants from `convex/schema.ts` must hold in the cost formula:** `cachedPromptTokens` is *part of* `promptTokens` (subtract, then re-add at the cache rate — never add on top); `reasoningTokens` is *part of* `completionTokens` (never billed separately).
- **Currency:** USD is primary. AED is shown alongside at the fixed peg `AED_PER_USD = 3.6725`. This is a currency-board peg, not a market rate — it is hard-coded, never fetched.
- **UI strings are literals, not i18n keys.** `messages/en.json` is the only locale file and `Agents.usage` holds only three keys (`classifyLabel`, `qualifyLabel`, `checklistLabel`) — the ones renamed for business vocabulary. Every other string on this card is already a literal; follow that.
- **Convex functions must use `accountQuery`/`accountMutation`** from `convex/lib/auth`, never raw `query`/`mutation` from `_generated/server`. That is the tenant-isolation spine.
- Run `npx tsc --noEmit` and `npx eslint` before each commit.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/ai/pricing.ts` **(create)** | Pure pricing module — `ModelRate` type, verified defaults, `rowCostUsd`, USD/AED formatters. No React, no Convex, no I/O. |
| `src/lib/ai/pricing.test.ts` **(create)** | Unit tests for the above. |
| `convex/schema.ts` **(modify)** | Add the `aiModelRates` table definition. |
| `convex/aiModelRates.ts` **(create)** | `list` + `upsert`, both admin-gated. |
| `convex/aiModelRates.test.ts` **(create)** | Role gating, upsert-then-update, validation rejection. |
| `src/components/agents/ai-usage.tsx` **(modify)** | Cost aggregation + all spend UI. |
| `src/components/agents/model-rates-dialog.tsx` **(create)** | The rate editor. |

---

### Task 1: Pricing module

Pure functions with no dependencies. Everything downstream consumes this, so it lands first and is fully tested in isolation.

**Files:**
- Create: `src/lib/ai/pricing.ts`
- Test: `src/lib/ai/pricing.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface ModelRate { inputPerMTok: number; cachedInputPerMTok: number; outputPerMTok: number }`
  - `interface UsageRowForCost { model: string; promptTokens: number; completionTokens: number; cachedPromptTokens?: number }`
  - `const AED_PER_USD: number`
  - `const DEFAULT_MODEL_RATES: Readonly<Record<string, ModelRate>>`
  - `function rowCostUsd(row: UsageRowForCost, rate: ModelRate | undefined): number | null`
  - `function formatUsd(value: number): string`
  - `function formatAed(usd: number): string`
  - `function formatUsdWithAed(usd: number): string`

- [ ] **Step 1: Write the failing test**

Create `src/lib/ai/pricing.test.ts`:

```ts
import { describe, expect, test } from 'vitest'
import {
  AED_PER_USD,
  DEFAULT_MODEL_RATES,
  formatAed,
  formatUsd,
  formatUsdWithAed,
  rowCostUsd,
  type ModelRate,
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/ai/pricing.test.ts`
Expected: FAIL — `Failed to resolve import "./pricing"`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/ai/pricing.ts`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/ai/pricing.test.ts`
Expected: PASS — 14 tests.

- [ ] **Step 5: Typecheck and lint**

Run: `npx tsc --noEmit && npx eslint src/lib/ai/pricing.ts src/lib/ai/pricing.test.ts`
Expected: no output from either.

- [ ] **Step 6: Commit**

```bash
git add src/lib/ai/pricing.ts src/lib/ai/pricing.test.ts
git commit -m "feat(usage): price a usage row, with unpriced models returning null

The cost formula honours the two subset invariants schema.ts documents:
cachedPromptTokens is part of promptTokens (subtracted then re-added at
the cache rate, not added on top), and reasoningTokens is part of
completionTokens so it is never billed twice.

DEFAULT_MODEL_RATES deliberately omits gpt-5.6-luna, gpt-5.6-terra and
gpt-4o-transcribe — the three models actually billing this key. Their
prices cannot be verified from here, and rowCostUsd returns null rather
than 0 for them so a caller cannot quietly count them as free.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: `aiModelRates` table and Convex module

**Files:**
- Modify: `convex/schema.ts` (add a table after the `aiUsageLog` definition, which ends at line 1448)
- Create: `convex/aiModelRates.ts`
- Test: `convex/aiModelRates.test.ts`

**Interfaces:**
- Consumes: `accountQuery` / `accountMutation` from `convex/lib/auth`.
- Produces:
  - `api.aiModelRates.list` — args `{}`, returns `Doc<"aiModelRates">[]` for the caller's account. Admin only.
  - `api.aiModelRates.upsert` — args `{ provider: "openai" | "anthropic", model: string, inputPerMTok: number, cachedInputPerMTok: number, outputPerMTok: number }`, returns `Id<"aiModelRates">`. Admin only.

- [ ] **Step 1: Write the failing test**

Create `convex/aiModelRates.test.ts`:

```ts
/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { AccountRole } from "./lib/roles";

const modules = import.meta.glob("/convex/**/*.ts");

/**
 * Seeds a `users` row + an `accounts`/`memberships` row for a fresh
 * account, and returns a convex-test client already authenticated as
 * that user. Duplicated per-suite rather than imported — see
 * `convex/contacts.test.ts`'s own comment on this pattern.
 */
async function seedAccountMember(
  t: ReturnType<typeof convexTest>,
  opts: { name: string; email: string; role: AccountRole },
) {
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { name: opts.name, email: opts.email }),
  );
  const accountId = await t.run(async (ctx) => {
    const id = await ctx.db.insert("accounts", {
      name: `${opts.name}'s account`,
      defaultCurrency: "USD",
      ownerUserId: userId,
    });
    await ctx.db.insert("memberships", {
      userId,
      accountId: id,
      role: opts.role,
      fullName: opts.name,
      email: opts.email,
    });
    return id;
  });
  const asUser = t.withIdentity({
    subject: `${userId}|session-${opts.name}`,
  });
  return { userId, accountId, asUser };
}

test("upsert inserts a rate, then patches the same row on a second call", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });

  await asUser.mutation(api.aiModelRates.upsert, {
    provider: "openai",
    model: "gpt-5.6-luna",
    inputPerMTok: 0.5,
    cachedInputPerMTok: 0.05,
    outputPerMTok: 2,
  });
  await asUser.mutation(api.aiModelRates.upsert, {
    provider: "openai",
    model: "gpt-5.6-luna",
    inputPerMTok: 0.6,
    cachedInputPerMTok: 0.06,
    outputPerMTok: 2.4,
  });

  const rows = await t.run((ctx) =>
    ctx.db
      .query("aiModelRates")
      .withIndex("by_account", (q) => q.eq("accountId", accountId))
      .collect(),
  );
  expect(rows).toHaveLength(1);
  expect(rows[0]!.inputPerMTok).toBe(0.6);
  expect(rows[0]!.outputPerMTok).toBe(2.4);
});

test("list returns only the caller's own account rates", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });
  const other = await seedAccountMember(t, {
    name: "Bob",
    email: "bob@example.com",
    role: "admin",
  });

  await asUser.mutation(api.aiModelRates.upsert, {
    provider: "openai",
    model: "gpt-5.6-luna",
    inputPerMTok: 0.5,
    cachedInputPerMTok: 0.05,
    outputPerMTok: 2,
  });
  await other.asUser.mutation(api.aiModelRates.upsert, {
    provider: "anthropic",
    model: "claude-opus-4-8",
    inputPerMTok: 5,
    cachedInputPerMTok: 0.5,
    outputPerMTok: 25,
  });

  const mine = await asUser.query(api.aiModelRates.list, {});
  expect(mine).toHaveLength(1);
  expect(mine[0]!.model).toBe("gpt-5.6-luna");
});

test("upsert rejects a negative rate", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });

  await expect(
    asUser.mutation(api.aiModelRates.upsert, {
      provider: "openai",
      model: "gpt-5.6-luna",
      inputPerMTok: -1,
      cachedInputPerMTok: 0,
      outputPerMTok: 0,
    }),
  ).rejects.toMatchObject({ data: { code: "INVALID_RATE" } });
});

test("upsert rejects a blank model id", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });

  await expect(
    asUser.mutation(api.aiModelRates.upsert, {
      provider: "openai",
      model: "   ",
      inputPerMTok: 1,
      cachedInputPerMTok: 0,
      outputPerMTok: 1,
    }),
  ).rejects.toMatchObject({ data: { code: "INVALID_MODEL" } });
});

// Rates are billing-class data, same trust level as `aiUsage.summary`
// and `apiKeys.list`. A client-side-only guard would be cosmetic — any
// authenticated member could call these functions directly.
test("list throws FORBIDDEN for a caller below the admin role", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });
  const supervisorId = await t.run((ctx) =>
    ctx.db.insert("users", { name: "Sam", email: "sam@example.com" }),
  );
  await t.run((ctx) =>
    ctx.db.insert("memberships", {
      userId: supervisorId,
      accountId,
      role: "supervisor",
      fullName: "Sam",
      email: "sam@example.com",
    }),
  );
  const asSupervisor = t.withIdentity({
    subject: `${supervisorId}|session-Sam`,
  });

  await expect(
    asSupervisor.query(api.aiModelRates.list, {}),
  ).rejects.toMatchObject({ data: { code: "FORBIDDEN", min: "admin" } });
});

test("upsert throws FORBIDDEN for a caller below the admin role", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });
  const supervisorId = await t.run((ctx) =>
    ctx.db.insert("users", { name: "Sam", email: "sam@example.com" }),
  );
  await t.run((ctx) =>
    ctx.db.insert("memberships", {
      userId: supervisorId,
      accountId,
      role: "supervisor",
      fullName: "Sam",
      email: "sam@example.com",
    }),
  );
  const asSupervisor = t.withIdentity({
    subject: `${supervisorId}|session-Sam`,
  });

  await expect(
    asSupervisor.mutation(api.aiModelRates.upsert, {
      provider: "openai",
      model: "gpt-5.6-luna",
      inputPerMTok: 1,
      cachedInputPerMTok: 0.1,
      outputPerMTok: 2,
    }),
  ).rejects.toMatchObject({ data: { code: "FORBIDDEN", min: "admin" } });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run convex/aiModelRates.test.ts`
Expected: FAIL — `api.aiModelRates` does not exist.

- [ ] **Step 3: Add the schema table**

In `convex/schema.ts`, immediately after the `aiUsageLog` table definition (which ends `}).index("by_account", ["accountId"]),` at line 1448), insert:

```ts
  // Per-model provider prices, one row per (account, model). Powers the
  // spend figures on the /agents usage tab — `aiUsageLog` above has
  // carried the token counts since the 2026-07-27 audit, but the repo
  // held no price, so the tab could only report volume.
  //
  // Per account rather than global because rates are a property of the
  // account's own billing arrangement with its BYO provider, not of the
  // app: two accounts on different OpenAI tiers pay differently for the
  // same model id. `src/lib/ai/pricing.ts`'s DEFAULT_MODEL_RATES is the
  // fallback when no row exists here, and deliberately omits the models
  // whose prices we cannot verify.
  //
  // Rates are billing-class data — both functions in
  // `convex/aiModelRates.ts` gate on `ctx.requireRole("admin")`, the same
  // floor `aiUsage.summary` and `apiKeys.list` enforce.
  aiModelRates: defineTable({
    accountId: v.id("accounts"),
    provider: v.union(v.literal("openai"), v.literal("anthropic")),
    // The raw provider model id exactly as it appears in
    // `aiUsageLog.model`, because that is the key the dashboard joins on.
    model: v.string(),
    // All three in USD per 1,000,000 tokens. `cachedInputPerMTok` is
    // stored explicitly rather than derived as a fraction of
    // `inputPerMTok`: the ~10% cache-read ratio is provider policy that
    // can change, and differs from the cache-WRITE multiplier.
    inputPerMTok: v.number(),
    cachedInputPerMTok: v.number(),
    outputPerMTok: v.number(),
    updatedAt: v.number(),
    updatedByUserId: v.optional(v.id("users")),
  })
    .index("by_account", ["accountId"])
    .index("by_account_model", ["accountId", "model"]),
```

- [ ] **Step 4: Write the Convex module**

Create `convex/aiModelRates.ts`:

```ts
import { accountMutation, accountQuery } from "./lib/auth";
import { v, ConvexError } from "convex/values";

// ============================================================
// Per-model provider rates (`convex/schema.ts`'s `aiModelRates`) — the
// price half of the usage dashboard. `aiUsageLog` records how many
// tokens each call burned; this records what a token costs, so
// `src/components/agents/ai-usage.tsx` can turn one into the other.
//
// Both functions are admin-gated. Rates are billing-class data, the same
// trust level `aiUsage.summary` and `apiKeys.list` already enforce — and
// for the same reason: a client-side-only restriction is cosmetic,
// because any authenticated member can call a Convex function directly.
//
// There is no `remove`. Clearing a rate would silently move a model back
// into the "unpriced" bucket and make historical spend figures drop with
// no explanation; if that is ever wanted it should be an explicit,
// separately-designed action rather than a side effect of a delete button.
// ============================================================

const providerValidator = v.union(v.literal("openai"), v.literal("anthropic"));

/**
 * Admin+ only. Every stored rate for the caller's own account.
 *
 * Returns raw rows; merging them over `src/lib/ai/pricing.ts`'s
 * `DEFAULT_MODEL_RATES` is the caller's job — the same
 * data-layer-returns-rows, caller-shapes-it split `aiUsage.summary`
 * uses for its own aggregation.
 */
export const list = accountQuery({
  args: {},
  handler: async (ctx) => {
    ctx.requireRole("admin");
    return await ctx.db
      .query("aiModelRates")
      .withIndex("by_account", (q) => q.eq("accountId", ctx.accountId))
      .collect();
  },
});

/**
 * Admin+ only. Find-or-patch-else-insert on (accountId, model) — the
 * same one-row-per-key idiom `whatsappConfig.upsert` and
 * `aiConfig.upsert` use, keyed here on the `by_account_model` index.
 *
 * Validates before writing: a negative or non-finite rate would silently
 * corrupt every historical figure on the dashboard, and a blank model id
 * would create a row that can never join to a usage row.
 */
export const upsert = accountMutation({
  args: {
    provider: providerValidator,
    model: v.string(),
    inputPerMTok: v.number(),
    cachedInputPerMTok: v.number(),
    outputPerMTok: v.number(),
  },
  handler: async (ctx, args) => {
    ctx.requireRole("admin");

    const model = args.model.trim();
    if (!model) throw new ConvexError({ code: "INVALID_MODEL" });

    for (const value of [
      args.inputPerMTok,
      args.cachedInputPerMTok,
      args.outputPerMTok,
    ]) {
      if (!Number.isFinite(value) || value < 0) {
        throw new ConvexError({ code: "INVALID_RATE" });
      }
    }

    const fields = {
      provider: args.provider,
      inputPerMTok: args.inputPerMTok,
      cachedInputPerMTok: args.cachedInputPerMTok,
      outputPerMTok: args.outputPerMTok,
      updatedAt: Date.now(),
      updatedByUserId: ctx.userId,
    };

    const existing = await ctx.db
      .query("aiModelRates")
      .withIndex("by_account_model", (q) =>
        q.eq("accountId", ctx.accountId).eq("model", model),
      )
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, fields);
      return existing._id;
    }

    return await ctx.db.insert("aiModelRates", {
      accountId: ctx.accountId,
      model,
      ...fields,
    });
  },
});
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run convex/aiModelRates.test.ts`
Expected: PASS — 6 tests.

- [ ] **Step 6: Verify nothing else broke, then typecheck**

Run: `npx vitest run convex/ && npx tsc --noEmit && npx eslint convex/aiModelRates.ts convex/aiModelRates.test.ts`
Expected: all convex suites pass; no typecheck or lint output.

- [ ] **Step 7: Commit**

```bash
git add convex/schema.ts convex/aiModelRates.ts convex/aiModelRates.test.ts
git commit -m "feat(usage): store per-model provider rates, admin-gated

Rates are per account, not global: they are a property of the account's
own billing arrangement with its BYO provider key, so two accounts on
different tiers pay differently for the same model id.

cachedInputPerMTok is stored rather than derived from inputPerMTok — the
~10% cache-read ratio is provider policy that can change, and is not the
same as the cache-write multiplier.

Both functions require admin, matching aiUsage.summary and apiKeys.list.
Tests pin that floor server-side; a client-only guard is cosmetic since
any member can call a Convex function directly.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Cost aggregation, headline tiles, and the unpriced banner

The first user-visible deliverable: the card answers "what did this cost".

**Files:**
- Modify: `src/components/agents/ai-usage.tsx`

**Interfaces:**
- Consumes: `rowCostUsd`, `formatUsd`, `formatUsdWithAed`, `DEFAULT_MODEL_RATES`, `type ModelRate` from `@/lib/ai/pricing`; `api.aiModelRates.list` from Task 2.
- Produces: inside `ai-usage.tsx`, the `UsageResponse` interface gains `totals.cost_usd: number`, `totals.unpriced_models: string[]`, `by_model[].cost_usd: number | null`, `by_mode[k].cost_usd: number | null`, and `daily[].cost_usd: number`. Tasks 4 and 5 read those fields.

- [ ] **Step 1: Add the imports and the rates query**

In `src/components/agents/ai-usage.tsx`, add to the import block (after the `formatCompactNumber` import on line 34):

```tsx
import {
  DEFAULT_MODEL_RATES,
  formatUsd,
  formatUsdWithAed,
  rowCostUsd,
  type ModelRate,
} from '@/lib/ai/pricing';
import { AlertTriangle, DollarSign, TrendingUp } from 'lucide-react';
```

Merge `AlertTriangle`, `DollarSign`, and `TrendingUp` into the existing `lucide-react` import on lines 5-15 rather than adding a second import statement from the same package.

Then, immediately after the `usageDocs` query (line 107-110), add:

```tsx
  // Stored per-account rates. Admin-gated server-side, so this is
  // skipped for the same callers `summary` is skipped for.
  const rateDocs = useQuery(
    api.aiModelRates.list,
    canView && accountId ? {} : 'skip',
  );

  // Stored rates win over the built-in defaults, which cover only the
  // models whose prices are verified (see `pricing.ts`). A model in
  // neither map is UNPRICED — it contributes nothing to any total and is
  // reported, never counted as free.
  const rates = useMemo<Record<string, ModelRate>>(() => {
    const merged: Record<string, ModelRate> = { ...DEFAULT_MODEL_RATES };
    for (const doc of rateDocs ?? []) {
      merged[doc.model] = {
        inputPerMTok: doc.inputPerMTok,
        cachedInputPerMTok: doc.cachedInputPerMTok,
        outputPerMTok: doc.outputPerMTok,
      };
    }
    return merged;
  }, [rateDocs]);
```

Update the `loading` line (111) so the card does not render prices before rates arrive:

```tsx
  const loading = canView && (usageDocs === undefined || rateDocs === undefined);
```

- [ ] **Step 2: Extend the `UsageResponse` interface**

In the `totals` block of `UsageResponse` (lines 44-59), after `reasoning_tokens: number;` add:

```tsx
    /** Window spend in USD, EXCLUDING every row whose model has no rate. */
    cost_usd: number;
    /** Models seen in this window that no rate covers, so the caller can say so. */
    unpriced_models: string[];
```

Change the `by_mode` value shape (lines 60-74) from `{ calls: number; tokens: number }` to `{ calls: number; tokens: number; cost_usd: number | null }` on every one of the nine keys. Change `by_model` (lines 75-80) to add `cost_usd: number | null;`. Change `daily` (line 81) to `{ date: string; tokens: number; calls: number; cost_usd: number }[]`.

- [ ] **Step 3: Accumulate cost in the aggregation `useMemo`**

Inside the `useMemo` starting at line 119:

Add to the accumulator declarations (after `let reasoningTokens = 0;` on line 127):

```tsx
    let costUsd = 0;
    const unpricedModels = new Set<string>();
```

Change every initialiser in the `byMode` object literal (lines 128-138) from `{ calls: 0, tokens: 0 }` to `{ calls: 0, tokens: 0, cost_usd: null as number | null }`.

Change the `modelMap` type parameter (lines 139-142) to include the cost field:

```tsx
    const modelMap = new Map<
      string,
      {
        model: string;
        provider: string;
        calls: number;
        tokens: number;
        cost_usd: number | null;
      }
    >();
```

Change the `daily` map type and its zero-fill (lines 143-146):

```tsx
    const daily = new Map<
      string,
      { date: string; tokens: number; calls: number; cost_usd: number }
    >();
    for (const key of lastNDayKeys(days)) {
      daily.set(key, { date: key, tokens: 0, calls: 0, cost_usd: 0 });
    }
```

Inside the `for (const row of usageDocs)` loop, immediately after the `reasoningTokens` line (152), add:

```tsx
      // `null` means "this model has no rate", which is a different
      // thing from "this call was free" — it is tracked separately and
      // surfaced, never folded into a total as zero.
      const rowCost = rowCostUsd(row, rates[row.model]);
      if (rowCost === null) {
        unpricedModels.add(row.model);
      } else {
        costUsd += rowCost;
      }
```

Then in the same loop, after `byMode[row.mode].tokens += row.totalTokens;` (line 164):

```tsx
      if (rowCost !== null) {
        byMode[row.mode].cost_usd = (byMode[row.mode].cost_usd ?? 0) + rowCost;
      }
```

After `m.tokens += row.totalTokens;` (line 171):

```tsx
      if (rowCost !== null) m.cost_usd = (m.cost_usd ?? 0) + rowCost;
```

And inside the `if (bucket)` block, after `bucket.calls += 1;` (line 177):

```tsx
        if (rowCost !== null) bucket.cost_usd += rowCost;
```

Change the `modelMap.get(mk) ?? {…}` fallback (lines 167-169) to seed the new field:

```tsx
      const m =
        modelMap.get(mk) ??
        {
          model: row.model,
          provider: row.provider,
          calls: 0,
          tokens: 0,
          cost_usd: null as number | null,
        };
```

In the returned object's `totals` (lines 184-192), after `reasoning_tokens: reasoningTokens,` add:

```tsx
        cost_usd: costUsd,
        unpriced_models: [...unpricedModels].sort(),
```

Finally, add `rates` to the `useMemo` dependency array on line 197: `}, [usageDocs, days, rates]);`

- [ ] **Step 4: Add the three headline tiles and the banner**

Replace the opening of the stat grid (line 249) and insert the three tiles first, so spend leads the row:

```tsx
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-7">
              <Stat
                label="Total spend"
                value={formatUsdWithAed(data.totals.cost_usd)}
                icon={DollarSign}
              />
              <Stat
                label={`Cost / day (${data.window_days}d avg)`}
                value={formatUsd(data.totals.cost_usd / data.window_days)}
              />
              <Stat
                label="30-day run rate"
                value={formatUsd(
                  (data.totals.cost_usd / data.window_days) * 30,
                )}
                icon={TrendingUp}
              />
              <Stat label="Total tokens" value={formatCompactNumber(data.totals.total_tokens)} />
```

(the `Total tokens` tile already exists on line 250 — this moves it below the three new ones rather than duplicating it; delete the original line.)

Then, immediately **before** that `<div className="grid …">`, add the banner:

```tsx
            {data.totals.unpriced_models.length > 0 && (
              <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
                <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-600" />
                <div className="min-w-0">
                  <p className="font-medium text-foreground">
                    Spend excludes {data.totals.unpriced_models.length}{' '}
                    {data.totals.unpriced_models.length === 1
                      ? 'model'
                      : 'models'}{' '}
                    with no rate set
                  </p>
                  <p className="mt-0.5 break-words text-xs text-muted-foreground">
                    {data.totals.unpriced_models.join(', ')} — these calls are
                    billed to your provider key but are not counted above. Set
                    their rates from your provider&apos;s billing page to get a
                    complete figure.
                  </p>
                </div>
              </div>
            )}
```

Update the card title and description (lines 212-217):

```tsx
              <BarChart3 className="h-4 w-4 text-primary" /> Usage &amp; spend
            </CardTitle>
            <CardDescription>
              Tokens and cost on your provider key. Spend is calculated from the
              rates you configure — it is an estimate of your bill, not the bill
              itself. No message content is stored here.
            </CardDescription>
```

Leave the empty-state block (lines 239-246) untouched. Its `hasSpend` guard already short-circuits a window with no usage, so the cost tiles are never reached with an empty dataset.

- [ ] **Step 5: Verify in the browser**

Run: `npx tsc --noEmit && npx eslint src/components/agents/ai-usage.tsx`
Expected: no output.

Then start the preview and check the page renders. Use the `preview_start` tool with `.claude/launch.json` (create it if absent, with `name: "wa-amani"`, `runtimeExecutable: "npm"`, `runtimeArgs: ["run", "dev"]`, `port: 3000`), navigate to `/agents?tab=usage`, and confirm:
- The amber banner lists `gpt-4o-transcribe, gpt-5.6-luna, gpt-5.6-terra` (no rates configured yet).
- Total spend shows only the `text-embedding-3-small` contribution, which is a small non-zero figure — **not** a fabricated total.
- `read_console_messages` reports no errors.

- [ ] **Step 6: Commit**

```bash
git add src/components/agents/ai-usage.tsx
git commit -m "feat(usage): show total spend, cost per day, and a 30-day run rate

Cost is accumulated in the same useMemo that already aggregates tokens,
so there is no schema change and no backfill — and correcting a rate
retroactively fixes history, which is what makes the run-rate projection
meaningful.

A model with no rate contributes nothing and lands in an amber banner
naming it. On this deployment that is currently three of the four models
actually billing the key, so the banner is the honest headline: the
figure above it is real but partial, and says so.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Per-model spend column and per-mode cost sub-lines

Makes the totals decomposable — which model and which mode the money goes to.

**Files:**
- Modify: `src/components/agents/ai-usage.tsx`

**Interfaces:**
- Consumes: `by_model[].cost_usd` and `by_mode[k].cost_usd` from Task 3; `formatUsd` from Task 1.
- Produces: a `sub` optional prop on the local `Stat` component — `function Stat({ label, value, icon, sub }: { label: string; value: string; icon?: typeof Bot; sub?: string })`.

- [ ] **Step 1: Add the `sub` prop to `Stat`**

Replace the `Stat` component at the bottom of the file (lines 384-404) with:

```tsx
function Stat({
  label,
  value,
  icon: Icon,
  sub,
}: {
  label: string;
  value: string;
  icon?: typeof Bot;
  /** Secondary line under the headline number — used for the cost that
   *  corresponds to a token count, so a tile ranks by money as well as
   *  volume without needing a second grid. */
  sub?: string;
}) {
  return (
    <div className="rounded-md border border-border p-3">
      <p className="flex items-center gap-1 text-xs text-muted-foreground">
        {Icon && <Icon className="h-3 w-3" />}
        {label}
      </p>
      <p className="mt-1 text-lg font-semibold tabular-nums text-foreground">
        {value}
      </p>
      {sub && (
        <p className="mt-0.5 text-xs tabular-nums text-muted-foreground">
          {sub}
        </p>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Add a cost formatter helper for possibly-unpriced values**

Immediately above the `AiUsageCard` function (before line 91), add:

```tsx
/**
 * A per-mode / per-model cost, or a dash when nothing in that bucket
 * could be priced. Rendering "$0.00" there would be a lie — the calls
 * happened and were billed, we just do not know the rate.
 */
function costLabel(cost: number | null): string {
  return cost === null ? '—' : formatUsd(cost);
}
```

- [ ] **Step 3: Add `sub` to every per-mode tile**

For each of the seven mode tiles in the stat grid, add a `sub` prop. The Auto-reply tile (lines 252-256) becomes:

```tsx
              <Stat
                label="Auto-reply"
                value={formatCompactNumber(data.by_mode.auto_reply.tokens)}
                icon={Bot}
                sub={costLabel(data.by_mode.auto_reply.cost_usd)}
              />
```

Apply the same pattern with the matching mode key to: Drafts (`draft`), the `t('classifyLabel')` tile (`classify`), the `t('qualifyLabel')` tile (`qualify`), the `t('checklistLabel')` tile (`checklist`), Lead scoring (`score`), and Embeddings (`embed`).

The Media tile sums two modes, so its `sub` sums them too — and stays `null` only when *both* are unpriced:

```tsx
              <Stat
                label="Media"
                value={formatCompactNumber(
                  data.by_mode.describe.tokens + data.by_mode.transcribe.tokens,
                )}
                icon={Image}
                sub={costLabel(
                  data.by_mode.describe.cost_usd === null &&
                    data.by_mode.transcribe.cost_usd === null
                    ? null
                    : (data.by_mode.describe.cost_usd ?? 0) +
                        (data.by_mode.transcribe.cost_usd ?? 0),
                )}
              />
```

- [ ] **Step 4: Add the spend column to the by-model list**

Replace the `<li>` body in the by-model list (lines 351-365) with:

```tsx
                    <li
                      key={`${m.provider}:${m.model}`}
                      className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
                    >
                      <span className="min-w-0 truncate">
                        <span className="text-foreground">{m.model}</span>{' '}
                        <span className="text-xs text-muted-foreground">
                          ({m.provider})
                        </span>
                      </span>
                      <span className="flex flex-shrink-0 items-center gap-3">
                        <span className="tabular-nums text-muted-foreground">
                          {formatCompactNumber(m.tokens)} tok · {m.calls}{' '}
                          {m.calls === 1 ? 'call' : 'calls'}
                        </span>
                        {m.cost_usd === null ? (
                          <span className="rounded-sm border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-xs text-amber-700 dark:text-amber-500">
                            no rate
                          </span>
                        ) : (
                          <span className="w-20 text-right font-medium tabular-nums text-foreground">
                            {formatUsd(m.cost_usd)}
                          </span>
                        )}
                      </span>
                    </li>
```

- [ ] **Step 5: Verify**

Run: `npx tsc --noEmit && npx eslint src/components/agents/ai-usage.tsx`
Expected: no output.

Reload `/agents?tab=usage` in the preview and confirm each unpriced model row shows an amber "no rate" chip rather than `$0.00`, and that `text-embedding-3-small` shows a real figure.

- [ ] **Step 6: Commit**

```bash
git add src/components/agents/ai-usage.tsx
git commit -m "feat(usage): break spend down by model and by mode

An unpriced bucket renders a dash or a 'no rate' chip, never \$0.00 —
those calls happened and were billed, we just do not know the rate, and
a zero would read as free.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Tokens ⇄ Cost toggle on the daily chart

Answers "how much do we spend a day" — the user's original question — visually.

**Files:**
- Modify: `src/components/agents/ai-usage.tsx`

**Interfaces:**
- Consumes: `daily[].cost_usd` from Task 3.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Add the metric state**

After the `const [days, setDays] = useState<number>(30);` line (line 96), add:

```tsx
  // Which series the daily chart plots. Tokens is the default because it
  // is always complete, whereas cost silently omits unpriced models.
  const [chartMetric, setChartMetric] = useState<'tokens' | 'cost'>('tokens');
```

- [ ] **Step 2: Make the chart data metric-aware**

Replace the `chartData` line (lines 201-203) with:

```tsx
  const isCostChart = chartMetric === 'cost';
  const chartData =
    data?.daily.map((d) => ({
      day: format(parseISO(d.date), 'MMM d'),
      [isCostChart ? 'Cost' : 'Tokens']: isCostChart ? d.cost_usd : d.tokens,
    })) ?? [];
```

- [ ] **Step 3: Replace the chart block with a toggled version**

Replace the whole daily-chart block (lines 328-342) with:

```tsx
            <div>
              <div className="mb-2 flex items-center justify-between gap-3">
                <p className="text-xs font-medium text-muted-foreground">
                  {isCostChart ? 'Spend per day' : 'Tokens per day'}
                </p>
                <div className="flex rounded-md border border-border p-0.5">
                  {(['tokens', 'cost'] as const).map((metric) => (
                    <button
                      key={metric}
                      type="button"
                      onClick={() => setChartMetric(metric)}
                      className={
                        chartMetric === metric
                          ? 'rounded-sm bg-primary px-2 py-1 text-xs font-medium text-primary-foreground'
                          : 'rounded-sm px-2 py-1 text-xs text-muted-foreground hover:text-foreground'
                      }
                    >
                      {metric === 'tokens' ? 'Tokens' : 'Cost'}
                    </button>
                  ))}
                </div>
              </div>
              <BarChart
                data={chartData}
                index="day"
                categories={[isCostChart ? 'Cost' : 'Tokens']}
                colors={[isCostChart ? 'emerald' : 'violet']}
                valueFormatter={(v) =>
                  isCostChart ? formatUsd(v) : formatCompactNumber(v)
                }
                showLegend={false}
                yAxisWidth={isCostChart ? 64 : 48}
                className="h-[200px]"
              />
            </div>
```

- [ ] **Step 4: Confirm the chart accepts the `emerald` colour**

Run: `grep -n "emerald" src/components/tremor/bar-chart.tsx`
Expected: at least one match in the colour map. **If there is no match**, use `'violet'` for both branches instead of `'emerald'` — a colour the vendored chart does not know will render as an unstyled bar.

- [ ] **Step 5: Verify**

Run: `npx tsc --noEmit && npx eslint src/components/agents/ai-usage.tsx`
Expected: no output.

In the preview, click the Cost toggle and confirm the bars re-render with `$` axis labels, then click Tokens and confirm it returns. Check `read_console_messages` is clean.

- [ ] **Step 6: Commit**

```bash
git add src/components/agents/ai-usage.tsx
git commit -m "feat(usage): toggle the daily chart between tokens and spend

Tokens stays the default because that series is always complete; the
cost series silently omits unpriced models, which the banner above the
chart already explains.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: Rate editor dialog

Closes the loop — the banner from Task 3 becomes actionable and the three unpriced models can be filled in.

**Files:**
- Create: `src/components/agents/model-rates-dialog.tsx`
- Modify: `src/components/agents/ai-usage.tsx`

**Interfaces:**
- Consumes: `api.aiModelRates.list` / `api.aiModelRates.upsert` from Task 2; `DEFAULT_MODEL_RATES`, `type ModelRate` from Task 1.
- Produces: `export function ModelRatesDialog({ open, onOpenChange, models }: { open: boolean; onOpenChange: (open: boolean) => void; models: { model: string; provider: 'openai' | 'anthropic' }[] })`.

- [ ] **Step 1: Confirm the dialog primitives**

Run: `sed -n '149,175p' src/components/ui/dialog.tsx`
Expected: an export list including `Dialog`, `DialogContent`, `DialogHeader`, `DialogTitle`, and `DialogDescription` — the five the next step imports. If any of those five is missing under that exact name, stop and check the file's actual export list before writing the component; do not guess a name.

- [ ] **Step 2: Write the dialog**

Create `src/components/agents/model-rates-dialog.tsx`:

```tsx
'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery } from 'convex/react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { DEFAULT_MODEL_RATES, type ModelRate } from '@/lib/ai/pricing';

import { api } from '../../../convex/_generated/api';

// ============================================================
// Per-model rate editor for the usage card. Exists because the app
// cannot know what the account pays: prices differ by provider tier and
// change without notice, and `pricing.ts` ships defaults only for models
// whose rates are verified. Everything else is entered here, read off
// the provider's own billing page — which is what the copy below says,
// because a rate typed from memory is the same failure as a rate
// hard-coded from memory.
// ============================================================

type Draft = { input: string; cached: string; output: string };

const EMPTY_DRAFT: Draft = { input: '', cached: '', output: '' };

function toDraft(rate: ModelRate | undefined): Draft {
  if (!rate) return EMPTY_DRAFT;
  return {
    input: String(rate.inputPerMTok),
    cached: String(rate.cachedInputPerMTok),
    output: String(rate.outputPerMTok),
  };
}

export function ModelRatesDialog({
  open,
  onOpenChange,
  models,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Every model to offer a row for — typically those seen in the
   *  current usage window, so the list matches what the card shows. */
  models: { model: string; provider: 'openai' | 'anthropic' }[];
}) {
  const rateDocs = useQuery(api.aiModelRates.list, open ? {} : 'skip');
  const upsert = useMutation(api.aiModelRates.upsert);

  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [saving, setSaving] = useState(false);

  // Seed the form once the stored rates arrive, and re-seed whenever the
  // dialog is reopened so a cancelled edit does not persist in state.
  useEffect(() => {
    if (!open || rateDocs === undefined) return;
    const stored = new Map(rateDocs.map((d) => [d.model, d]));
    const next: Record<string, Draft> = {};
    for (const { model } of models) {
      const doc = stored.get(model);
      next[model] = doc
        ? toDraft({
            inputPerMTok: doc.inputPerMTok,
            cachedInputPerMTok: doc.cachedInputPerMTok,
            outputPerMTok: doc.outputPerMTok,
          })
        : toDraft(DEFAULT_MODEL_RATES[model]);
    }
    setDrafts(next);
  }, [open, rateDocs, models]);

  const setField = (model: string, field: keyof Draft, value: string) => {
    setDrafts((prev) => ({
      ...prev,
      [model]: { ...(prev[model] ?? EMPTY_DRAFT), [field]: value },
    }));
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      let written = 0;
      for (const { model, provider } of models) {
        const draft = drafts[model] ?? EMPTY_DRAFT;
        // A fully blank row means "I have not filled this in yet" —
        // skip it rather than writing zeros, which would make an
        // unpriced model silently read as free.
        if (!draft.input && !draft.cached && !draft.output) continue;

        const values = {
          inputPerMTok: Number(draft.input),
          cachedInputPerMTok: Number(draft.cached),
          outputPerMTok: Number(draft.output),
        };
        if (
          Object.values(values).some((v) => !Number.isFinite(v) || v < 0)
        ) {
          toast.error(`${model}: rates must be non-negative numbers`);
          setSaving(false);
          return;
        }

        await upsert({ provider, model, ...values });
        written += 1;
      }
      toast.success(
        written === 1 ? 'Saved 1 rate' : `Saved ${written} rates`,
      );
      onOpenChange(false);
    } catch {
      toast.error('Could not save rates');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Model rates</DialogTitle>
          <DialogDescription>
            USD per 1,000,000 tokens. Take these from your provider&apos;s own
            billing or pricing page — spend on the usage tab is only as
            accurate as what you enter here. Leave a model blank to keep it
            excluded from spend rather than counted as free.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {models.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No models have been used in the selected window yet.
            </p>
          )}
          {models.map(({ model, provider }) => (
            <div key={model} className="rounded-md border border-border p-3">
              <p className="mb-2 text-sm font-medium text-foreground">
                {model}{' '}
                <span className="text-xs font-normal text-muted-foreground">
                  ({provider})
                </span>
              </p>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                {(
                  [
                    ['input', 'Input'],
                    ['cached', 'Cached input'],
                    ['output', 'Output'],
                  ] as const
                ).map(([field, label]) => (
                  <div key={field}>
                    <Label
                      htmlFor={`${model}-${field}`}
                      className="text-xs text-muted-foreground"
                    >
                      {label}
                    </Label>
                    <Input
                      id={`${model}-${field}`}
                      inputMode="decimal"
                      placeholder="0.00"
                      value={drafts[model]?.[field] ?? ''}
                      onChange={(e) => setField(model, field, e.target.value)}
                    />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? 'Saving…' : 'Save rates'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 3: Wire it into the card**

In `src/components/agents/ai-usage.tsx`, add the import:

```tsx
import { ModelRatesDialog } from '@/components/agents/model-rates-dialog';
```

Add state after the `chartMetric` state from Task 5:

```tsx
  const [ratesOpen, setRatesOpen] = useState(false);
```

Add a Rates button to the card header. Replace the entire `<Select>` block (lines 219-233) with a flex row holding both controls:

```tsx
          <div className="flex flex-shrink-0 items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setRatesOpen(true)}
            >
              Rates
            </Button>
            <Select
              value={String(days)}
              onValueChange={(v) => setDays(Number(v))}
            >
              <SelectTrigger className="w-32 flex-shrink-0">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {WINDOWS.map((w) => (
                  <SelectItem key={w} value={String(w)}>
                    Last {w} days
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
```

Add `import { Button } from '@/components/ui/button';` — this file does not currently import it.

Render the dialog just before the closing `</Card>`:

```tsx
      <ModelRatesDialog
        open={ratesOpen}
        onOpenChange={setRatesOpen}
        models={
          data?.by_model.map((m) => ({
            model: m.model,
            provider: m.provider as 'openai' | 'anthropic',
          })) ?? []
        }
      />
```

Make the banner's closing sentence actionable by replacing `Set their rates from your provider&apos;s billing page to get a complete figure.` with:

```tsx
                    <button
                      type="button"
                      onClick={() => setRatesOpen(true)}
                      className="font-medium text-foreground underline underline-offset-2"
                    >
                      Set their rates
                    </button>{' '}
                    to get a complete figure.
```

- [ ] **Step 4: Verify**

Run: `npx tsc --noEmit && npx eslint src/components/agents/ai-usage.tsx src/components/agents/model-rates-dialog.tsx`
Expected: no output.

In the preview: click **Rates**, confirm the dialog lists all four models with `text-embedding-3-small` pre-filled from defaults and the other three blank. Enter a rate for one model, save, and confirm (a) the toast fires, (b) the banner shrinks by one model, and (c) that model's row in the by-model list now shows a figure instead of the "no rate" chip.

- [ ] **Step 5: Full test suite and commit**

Run: `npx vitest run && npx tsc --noEmit && npx eslint`
Expected: all suites pass, no typecheck or lint output.

```bash
git add src/components/agents/model-rates-dialog.tsx src/components/agents/ai-usage.tsx
git commit -m "feat(usage): edit per-model rates from the usage card

The app cannot know what an account pays — prices differ by provider
tier and change without notice — so the rates come from the admin, read
off the provider's own billing page. The dialog says exactly that,
because a rate typed from memory fails the same way a hard-coded guess
does.

A blank row is skipped rather than written as zero, so 'not filled in
yet' stays distinguishable from 'free'.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Post-implementation verification

- [ ] `npx vitest run` — all suites green.
- [ ] `npx tsc --noEmit` — clean.
- [ ] `npx eslint` — clean.
- [ ] With **no** rates configured, the card shows the unpriced banner and a partial figure — never a fabricated total.
- [ ] After configuring one rate, only that model's spend appears; the banner shrinks accordingly.
- [ ] A non-admin member cannot reach `api.aiModelRates.list` or `.upsert` (covered by `convex/aiModelRates.test.ts`, no manual check needed).

## Out of scope

Confirmed non-goals for this plan, per the design doc:

- Budgets, spend alerts, or hard caps on the provider key.
- Per-conversation or per-customer cost attribution (`conversationId` is on the rows and makes this possible later — separate feature).
- Any change to how or when `aiUsage.log` is written.
- Acting on the 0% prompt-cache finding. This plan makes it **visible**; fixing it is separate work.
