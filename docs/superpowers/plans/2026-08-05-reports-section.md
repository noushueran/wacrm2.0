# Reports Section Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a dedicated `/reports` section with five tabs — conversations, ads, response/SLA, funnel, Meta billing — backed by an extension of the existing `messageHourlyStats` write-time rollup.

**Architecture:** Six optional counters are added to `messageHourlyStats` and accumulated at write time, so every time series is a single `by_account_hour` index range whose cost is a function of the requested window, never of traffic. Panels that need per-ad or per-stage detail scan `adReferrals` / `funnelTransitions` / `conversionEvents` — per-conversation tables, one to two orders of magnitude smaller than `messages` — bounded by the window and capped with an explicit `truncated` flag. All read logic that can be a pure function lives in `convex/lib/reportStats.ts` and is tested without a database.

**Tech Stack:** Convex (queries/mutations/schema), Next.js App Router, React, `recharts`, `next-intl`, `vitest` + `convex-test`.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-08-05-reports-section-design.md`. Read it before Task 1.
- **Never run `convex deploy`, `convex dev`, or `convex codegen`.** These are the owner's call, from a clean `origin/main` worktree. Do not run them even when a task's output would be easier to verify with them.
- **Do not run the backfills.** They are one-shot internal mutations the owner triggers.
- **All new `messageHourlyStats` fields are `v.optional`** and every reader treats absent as zero. No task may make an existing field required.
- **Every new Convex query calls `ctx.requireRole("supervisor")`** and is built on `accountQuery` from `./lib/auth` — never the raw `query`. No query takes an `accountId` argument.
- **Every new page-level `useQuery` is gated** behind `canAccessNav(accountRole, '/reports')` with the `'skip'` sentinel. `useQuery` re-throws `FORBIDDEN` synchronously during render and the app has no Error Boundary.
- **Test command:** `npx vitest run <path>` for one file, `npm test` for all.
- **Lint scope:** run `npx eslint` only on files you changed, never the whole repo.
- **Commit style:** conventional commits, and end every commit message body with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- **Timezone convention:** `tzOffsetMinutes` matches `Date.prototype.getTimezoneOffset()` — UTC minus local, in minutes (UTC+4 → `-240`). Never compute a local day server-side without it.
- **Week convention:** weeks start **Monday**. A week is keyed by its Monday's `YYYY-MM-DD`, not an ISO week number — this avoids ISO week-year edge cases entirely.

---

## File Structure

**Create:**
| File | Responsibility |
|---|---|
| `convex/lib/reportStats.ts` | Pure functions: response-bucket classification, pricing-category normalization, percentile interpolation, and every hour→day/week/hour-of-day fold. |
| `convex/lib/reportStats.test.ts` | Tests for the above. No database. |
| `convex/reports.ts` | All report queries. Supervisor-gated, `accountQuery`-based. |
| `convex/reports.test.ts` | `convex-test` suite for those queries. |
| `src/lib/reports/types.ts` | Shared client types + range/tab parsing. |
| `src/lib/reports/csv.ts` | Client-side CSV serialization + download. |
| `src/app/(dashboard)/reports/page.tsx` | Route shell: tab + range state from URL. |
| `src/components/reports/conversations-panel.tsx` | Tab 1. |
| `src/components/reports/ads-panel.tsx` | Tab 2. |
| `src/components/reports/response-panel.tsx` | Tab 3. |
| `src/components/reports/funnel-panel.tsx` | Tab 4. |
| `src/components/reports/billing-panel.tsx` | Tab 5. |

**Modify:**
| File | Change |
|---|---|
| `convex/schema.ts:680-709` | Six optional fields on `messageHourlyStats`. |
| `convex/lib/dashboardDate.ts` | Add `localMondayStartMsFromMs`. |
| `convex/conversations.ts:676-692` | `insertConversation` bumps `conversationsStarted`. |
| `convex/adReferrals.ts` | `record` bumps `conversationsStartedAd`. |
| `convex/messages.ts:194-230` | `recordResponseSample` also writes `responseBuckets`. |
| `convex/messages.ts:697+` | `applyStatusPricing` writes the three billing counters. |
| `convex/messages.ts` (end) | Two new backfills. |
| `src/lib/auth/roles.ts:174` | `SUPERVISOR_NAV`: `/campaigns` → `/reports`. |
| `src/components/layout/sidebar.tsx:106` | Nav entry `/campaigns` → `/reports`. |
| `src/app/(dashboard)/campaigns/page.tsx` | Replace with a redirect to `/reports?tab=funnel`. |
| `messages/en.json` | `Reports.*` namespace. |

---

# Phase 1 — Rollup foundation

### Task 1: Pure classification helpers + schema fields

**Files:**
- Create: `convex/lib/reportStats.ts`
- Create: `convex/lib/reportStats.test.ts`
- Modify: `convex/schema.ts:680-709`

**Interfaces:**
- Consumes: nothing.
- Produces: `RESPONSE_BUCKET_KEYS`, `ResponseBucketKey`, `ResponseBuckets`, `emptyResponseBuckets()`, `responseBucketFor(elapsedMs: number): ResponseBucketKey`, `addResponseBucket(a: ResponseBuckets | undefined, key: ResponseBucketKey): ResponseBuckets`, `PRICING_CATEGORY_KEYS`, `PricingCategoryKey`, `PricingCategories`, `emptyPricingCategories()`, `pricingCategoryKey(category: string | undefined, billable: boolean | undefined): PricingCategoryKey`, `addPricingCategory(a: PricingCategories | undefined, key: PricingCategoryKey): PricingCategories`.

- [ ] **Step 1: Write the failing test**

Create `convex/lib/reportStats.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  responseBucketFor,
  emptyResponseBuckets,
  addResponseBucket,
  pricingCategoryKey,
  emptyPricingCategories,
  addPricingCategory,
} from "./reportStats";

describe("responseBucketFor", () => {
  it("classifies by elapsed minutes, lower bound inclusive", () => {
    expect(responseBucketFor(0)).toBe("m1");
    expect(responseBucketFor(59_999)).toBe("m1");
    expect(responseBucketFor(60_000)).toBe("m5");
    expect(responseBucketFor(5 * 60_000 - 1)).toBe("m5");
    expect(responseBucketFor(5 * 60_000)).toBe("m15");
    expect(responseBucketFor(15 * 60_000)).toBe("m60");
    expect(responseBucketFor(60 * 60_000)).toBe("m240");
    expect(responseBucketFor(240 * 60_000)).toBe("over");
    expect(responseBucketFor(99 * 3_600_000)).toBe("over");
  });
});

describe("addResponseBucket", () => {
  it("treats an absent histogram as all-zero", () => {
    expect(addResponseBucket(undefined, "m5")).toEqual({
      ...emptyResponseBuckets(),
      m5: 1,
    });
  });

  it("increments only the named bucket", () => {
    const start = { ...emptyResponseBuckets(), m1: 2 };
    expect(addResponseBucket(start, "m1")).toEqual({
      ...emptyResponseBuckets(),
      m1: 3,
    });
  });
});

describe("pricingCategoryKey", () => {
  it("maps Meta's category spellings, case-insensitively", () => {
    expect(pricingCategoryKey("marketing", true)).toBe("marketing");
    expect(pricingCategoryKey("UTILITY", true)).toBe("utility");
    expect(pricingCategoryKey("service", true)).toBe("service");
    expect(pricingCategoryKey("authentication", true)).toBe("authentication");
    expect(pricingCategoryKey("authentication_international", true)).toBe(
      "authentication",
    );
  });

  it("treats both eras' free spellings as free", () => {
    expect(pricingCategoryKey("referral_conversion", true)).toBe("free");
    expect(pricingCategoryKey("free_entry_point", true)).toBe("free");
  });

  // `billable: false` is Meta stating the outcome directly; it outranks
  // whatever category string came alongside it.
  it("prefers an explicit billable:false over the category", () => {
    expect(pricingCategoryKey("marketing", false)).toBe("free");
  });

  // Meta is mid-migration between CBP and PMP spellings, so an unknown
  // category is expected, not exceptional. It must land in a real bucket or
  // the per-category totals would silently fail to sum to the message count.
  it("routes unknown and absent categories to `other`", () => {
    expect(pricingCategoryKey("some_future_tier", true)).toBe("other");
    expect(pricingCategoryKey(undefined, undefined)).toBe("other");
  });
});

describe("addPricingCategory", () => {
  it("treats an absent record as all-zero and increments one key", () => {
    expect(addPricingCategory(undefined, "utility")).toEqual({
      ...emptyPricingCategories(),
      utility: 1,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run convex/lib/reportStats.test.ts`
Expected: FAIL — `Failed to resolve import "./reportStats"`.

- [ ] **Step 3: Write the implementation**

Create `convex/lib/reportStats.ts`:

```ts
// ============================================================
// Pure helpers behind `convex/reports.ts`.
//
// Everything here is a total function over plain data: no database, no
// clock, no Convex ctx. That is deliberate — the fold logic is where a
// report silently produces WRONG numbers rather than failing, so it has to
// be testable without a harness. See `lib/messageStats.ts`, which
// established the pattern for the two folds that already existed.
// ============================================================

// --- Reply-latency histogram --------------------------------------------
//
// WHY A HISTOGRAM AND NOT A `withinTarget` COUNTER
//
// A single counter bakes one SLA threshold in at write time. Changing the
// target from 5 to 15 minutes would make every accumulated row meaningless,
// with no way to recompute — the raw latencies are gone by then. Six
// counters cost the same single patch, make any threshold ON A BUCKET EDGE
// exact, and let p50/p90 be interpolated as an honest RANGE.

export const RESPONSE_BUCKET_KEYS = [
  "m1",
  "m5",
  "m15",
  "m60",
  "m240",
  "over",
] as const;
export type ResponseBucketKey = (typeof RESPONSE_BUCKET_KEYS)[number];
export type ResponseBuckets = Record<ResponseBucketKey, number>;

/** Upper edge of each bucket, in minutes. `over` is unbounded. */
export const RESPONSE_BUCKET_EDGES_MINUTES: Record<ResponseBucketKey, number | null> =
  { m1: 1, m5: 5, m15: 15, m60: 60, m240: 240, over: null };

export function emptyResponseBuckets(): ResponseBuckets {
  return { m1: 0, m5: 0, m15: 0, m60: 0, m240: 0, over: 0 };
}

/** Which bucket a latency falls in. Lower bound inclusive, upper exclusive. */
export function responseBucketFor(elapsedMs: number): ResponseBucketKey {
  const minutes = elapsedMs / 60_000;
  if (minutes < 1) return "m1";
  if (minutes < 5) return "m5";
  if (minutes < 15) return "m15";
  if (minutes < 60) return "m60";
  if (minutes < 240) return "m240";
  return "over";
}

/** Non-mutating +1 on one bucket. Absent histogram reads as all-zero. */
export function addResponseBucket(
  existing: ResponseBuckets | undefined,
  key: ResponseBucketKey,
): ResponseBuckets {
  const next = { ...emptyResponseBuckets(), ...(existing ?? {}) };
  next[key] += 1;
  return next;
}

// --- Meta pricing categories ---------------------------------------------

export const PRICING_CATEGORY_KEYS = [
  "marketing",
  "utility",
  "service",
  "authentication",
  "free",
  "other",
] as const;
export type PricingCategoryKey = (typeof PRICING_CATEGORY_KEYS)[number];
export type PricingCategories = Record<PricingCategoryKey, number>;

export function emptyPricingCategories(): PricingCategories {
  return {
    marketing: 0,
    utility: 0,
    service: 0,
    authentication: 0,
    free: 0,
    other: 0,
  };
}

/**
 * Normalize Meta's raw pricing facts into one bucket.
 *
 * `billable === false` is Meta stating the outcome directly, so it outranks
 * whatever category string arrived with it.
 *
 * `other` is load-bearing, not a fallback nobody hits: schema.ts's own
 * comment notes Meta is mid-migration between conversation-based ("CBP") and
 * per-message ("PMP") pricing, "which spell categories differently". An
 * unmapped spelling must still land somewhere, or the per-category totals
 * stop summing to the message count and the panel quietly lies.
 */
export function pricingCategoryKey(
  category: string | undefined,
  billable: boolean | undefined,
): PricingCategoryKey {
  if (billable === false) return "free";
  switch ((category ?? "").toLowerCase()) {
    case "marketing":
      return "marketing";
    case "utility":
      return "utility";
    case "service":
      return "service";
    case "authentication":
    case "authentication_international":
      return "authentication";
    case "referral_conversion":
    case "free_entry_point":
      return "free";
    default:
      return "other";
  }
}

/** Non-mutating +1 on one category. Absent record reads as all-zero. */
export function addPricingCategory(
  existing: PricingCategories | undefined,
  key: PricingCategoryKey,
): PricingCategories {
  const next = { ...emptyPricingCategories(), ...(existing ?? {}) };
  next[key] += 1;
  return next;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run convex/lib/reportStats.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Add the schema fields**

In `convex/schema.ts`, replace the `messageHourlyStats` field list (currently ending at `responseTotalMs: v.optional(v.number()),` on line 705) so it reads:

```ts
    responseCount: v.optional(v.number()),
    responseTotalMs: v.optional(v.number()),

    // ---- Reports rollup (docs/superpowers/specs/2026-08-05-reports-
    // section-design.md). Every field below is optional and read as zero
    // when absent — the same convention `responseCount`/`responseTotalMs`
    // established — so this deploy changes nothing observable and no
    // existing row needs touching.

    /** Conversations created in this hour. Written at the single
     *  `conversations.insertConversation` choke point. */
    conversationsStarted: v.optional(v.number()),
    /** Of those, the ones that arrived from a Click-to-WhatsApp ad.
     *  Written by `adReferrals.record`, which patches the CONVERSATION's
     *  creation hour — the referral is recorded after the row exists, so
     *  this lands on an hour in the past exactly like
     *  `recordResponseSample` does. */
    conversationsStartedAd: v.optional(v.number()),
    /** Reply-latency histogram, alongside the existing sum+count. A single
     *  `withinTarget` counter would bake one SLA threshold in at write time
     *  and make history meaningless the day the target changes; six buckets
     *  cost the same patch, are exact at every edge, and let p50/p90 be
     *  interpolated as a range. See `lib/reportStats.ts`. */
    responseBuckets: v.optional(
      v.object({
        m1: v.number(),
        m5: v.number(),
        m15: v.number(),
        m60: v.number(),
        m240: v.number(),
        over: v.number(),
      }),
    ),
    /** Distinct Meta billable conversations opened in this hour. Written by
     *  `applyStatusPricing` on the branch that records a NEW
     *  `conversationMetaId` — that branch is the dedup, since a status
     *  callback fires repeatedly (sent → delivered → read) for one message. */
    billableConversations: v.optional(v.number()),
    /** Of those, the ones Meta flagged free-entry-point (the 72h CTWA
     *  window). Same branch, same dedup. */
    freeEntryPointConversations: v.optional(v.number()),
    /** Messages by Meta billing category. Incremented only when the message
     *  had no `pricing` yet, so repeated callbacks cannot double-count.
     *  `other` catches spellings from Meta's CBP/PMP migration that we do
     *  not map — without it the categories would stop summing to the
     *  message count. */
    billedMessagesByCategory: v.optional(
      v.object({
        marketing: v.number(),
        utility: v.number(),
        service: v.number(),
        authentication: v.number(),
        free: v.number(),
        other: v.number(),
      }),
    ),
  })
```

- [ ] **Step 6: Verify the schema still type-checks and nothing regressed**

Run: `npx vitest run convex/schema.test.ts convex/dashboard.test.ts convex/messages.test.ts`
Expected: PASS. Existing suites must be untouched by an additive optional change — if any fails, the edit changed an existing field.

- [ ] **Step 7: Lint and commit**

```bash
npx eslint convex/lib/reportStats.ts convex/lib/reportStats.test.ts convex/schema.ts
git add convex/lib/reportStats.ts convex/lib/reportStats.test.ts convex/schema.ts
git commit -m "feat(reports): add rollup counters to messageHourlyStats

Six optional fields, all absent-means-zero, plus the pure classification
helpers behind them. A histogram rather than a withinTarget counter so
changing the SLA target does not invalidate accumulated history.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Count conversations started (total and ad-sourced)

**Files:**
- Modify: `convex/conversations.ts:676-692`
- Modify: `convex/adReferrals.ts`
- Test: `convex/conversations.test.ts`, `convex/adReferrals.test.ts`

**Interfaces:**
- Consumes: `hourStartMs` from `./lib/messageStats`.
- Produces: `bumpConversationStartedStat(ctx: { db: MutationCtx["db"] }, accountId: Id<"accounts">, atMs: number, field: "conversationsStarted" | "conversationsStartedAd"): Promise<void>`, exported from `convex/messages.ts`. It lives there rather than in `lib/reportStats.ts` because it needs a `db` — `reportStats.ts` is deliberately database-free — and because `messages.ts` already holds the other two rollup writers.

- [ ] **Step 1: Write the failing tests**

Append to `convex/conversations.test.ts`:

```ts
test("insertConversation bumps conversationsStarted in the current hour", async () => {
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t);

  const contactId = await t.run(async (ctx) =>
    ctx.db.insert("contacts", { accountId, phone: "+971500000001" }),
  );
  await t.run(async (ctx) => {
    await insertConversation(ctx, { accountId, contactId });
  });

  const rows = await t.run(async (ctx) =>
    ctx.db
      .query("messageHourlyStats")
      .withIndex("by_account_hour", (q) => q.eq("accountId", accountId))
      .collect(),
  );
  expect(rows).toHaveLength(1);
  expect(rows[0]!.conversationsStarted).toBe(1);
  expect(rows[0]!.hourStartMs).toBe(hourStartMs(Date.now()));
  // The counts this row shares with the message rollup must be seeded, not
  // left undefined — the schema requires them.
  expect(rows[0]!.incoming).toBe(0);
  expect(rows[0]!.outgoing).toBe(0);
});

test("two conversations in one hour share a bucket", async () => {
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t);

  await t.run(async (ctx) => {
    for (const phone of ["+971500000002", "+971500000003"]) {
      const contactId = await ctx.db.insert("contacts", { accountId, phone });
      await insertConversation(ctx, { accountId, contactId });
    }
  });

  const rows = await t.run(async (ctx) =>
    ctx.db
      .query("messageHourlyStats")
      .withIndex("by_account_hour", (q) => q.eq("accountId", accountId))
      .collect(),
  );
  expect(rows).toHaveLength(1);
  expect(rows[0]!.conversationsStarted).toBe(2);
});
```

Add to that file's imports: `import { insertConversation } from "./conversations";` and `import { hourStartMs } from "./lib/messageStats";`. Reuse the file's existing account-seed helper; if it has none, add:

```ts
async function seedAccount(t: TestConvex<typeof schema>): Promise<Id<"accounts">> {
  return await t.run(async (ctx) =>
    ctx.db.insert("accounts", { name: "Acme", defaultCurrency: "AED" }),
  );
}
```

Append to `convex/adReferrals.test.ts`:

```ts
test("the first ad referral on a conversation counts it as ad-sourced, in the CONVERSATION's hour", async () => {
  const t = convexTest(schema, modules);
  const { accountId, contactId, conversationId, conversationHourMs } =
    await seedAdScenario(t);

  await t.mutation(internal.adReferrals.record, {
    accountId,
    contactId,
    conversationId,
    waMessageId: "wamid.1",
    adId: "120200000000000001",
    sourceType: "ad",
  });

  const row = await t.run(async (ctx) =>
    ctx.db
      .query("messageHourlyStats")
      .withIndex("by_account_hour", (q) =>
        q.eq("accountId", accountId).eq("hourStartMs", conversationHourMs),
      )
      .unique(),
  );
  expect(row?.conversationsStartedAd).toBe(1);
});

// The dedup guard is per-CONVERSATION, deliberately not `record`'s existing
// per-CONTACT `isFirstTouch`: a returning customer who clicks a second ad
// opens a second ad-sourced conversation and must be counted again, but
// `isFirstTouch` is false for that row and would silently under-count them.
test("a second referral on the SAME conversation does not double-count it", async () => {
  const t = convexTest(schema, modules);
  const { accountId, contactId, conversationId, conversationHourMs } =
    await seedAdScenario(t);

  for (const wamid of ["wamid.1", "wamid.2"]) {
    await t.mutation(internal.adReferrals.record, {
      accountId,
      contactId,
      conversationId,
      waMessageId: wamid,
      adId: "120200000000000001",
      sourceType: "ad",
    });
  }

  const row = await t.run(async (ctx) =>
    ctx.db
      .query("messageHourlyStats")
      .withIndex("by_account_hour", (q) =>
        q.eq("accountId", accountId).eq("hourStartMs", conversationHourMs),
      )
      .unique(),
  );
  expect(row?.conversationsStartedAd).toBe(1);
});

test("a returning contact's SECOND conversation is counted again", async () => {
  const t = convexTest(schema, modules);
  const { accountId, contactId, conversationId } = await seedAdScenario(t);

  await t.mutation(internal.adReferrals.record, {
    accountId, contactId, conversationId,
    waMessageId: "wamid.1", adId: "ad-1", sourceType: "ad",
  });

  const secondConversationId = await t.run(async (ctx) =>
    insertConversation(ctx, { accountId, contactId }),
  );
  await t.mutation(internal.adReferrals.record, {
    accountId, contactId, conversationId: secondConversationId,
    waMessageId: "wamid.2", adId: "ad-2", sourceType: "ad",
  });

  const total = await t.run(async (ctx) => {
    const rows = await ctx.db
      .query("messageHourlyStats")
      .withIndex("by_account_hour", (q) => q.eq("accountId", accountId))
      .collect();
    return rows.reduce((sum, r) => sum + (r.conversationsStartedAd ?? 0), 0);
  });
  expect(total).toBe(2);
});
```

Add a `seedAdScenario` helper to that file returning `{ accountId, contactId, conversationId, conversationHourMs }`, where `conversationHourMs` is `hourStartMs` of the conversation row's `_creationTime`:

```ts
async function seedAdScenario(t: TestConvex<typeof schema>) {
  const accountId = await t.run(async (ctx) =>
    ctx.db.insert("accounts", { name: "Acme", defaultCurrency: "AED" }),
  );
  const contactId = await t.run(async (ctx) =>
    ctx.db.insert("contacts", { accountId, phone: "+971500000009" }),
  );
  const conversationId = await t.run(async (ctx) =>
    insertConversation(ctx, { accountId, contactId }),
  );
  const conversationHourMs = await t.run(async (ctx) => {
    const c = await ctx.db.get(conversationId);
    return hourStartMs(c!._creationTime);
  });
  return { accountId, contactId, conversationId, conversationHourMs };
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run convex/conversations.test.ts convex/adReferrals.test.ts`
Expected: FAIL — `conversationsStarted` / `conversationsStartedAd` are `undefined`, and `rows` is empty for the conversations tests.

- [ ] **Step 3: Add the shared bumper to `convex/messages.ts`**

Beside `recordMessageInHourlyStats` (after line 175), add:

```ts
/**
 * +1 on one conversation counter in the account's hourly rollup.
 *
 * `atMs` is the CONVERSATION's creation instant, not "now": the ad-sourced
 * counter is written when a referral is recorded, which happens after the
 * conversation row exists, so it patches an hour in the past. That is the
 * same shape `recordResponseSample` uses and, like it, still a single point
 * lookup on `by_account_hour`.
 *
 * `incoming`/`outgoing` are seeded to 0 on insert because the schema
 * requires them — this may be the first write to the hour, ahead of any
 * message.
 */
export async function bumpConversationStartedStat(
  ctx: { db: MutationCtx["db"] },
  accountId: Id<"accounts">,
  atMs: number,
  field: "conversationsStarted" | "conversationsStartedAd",
): Promise<void> {
  const bucketStart = hourStartMs(atMs);
  const existing = await ctx.db
    .query("messageHourlyStats")
    .withIndex("by_account_hour", (q) =>
      q.eq("accountId", accountId).eq("hourStartMs", bucketStart),
    )
    .unique();

  if (existing) {
    await ctx.db.patch(existing._id, {
      [field]: (existing[field] ?? 0) + 1,
    });
    return;
  }

  await ctx.db.insert("messageHourlyStats", {
    accountId,
    hourStartMs: bucketStart,
    incoming: 0,
    outgoing: 0,
    [field]: 1,
  });
}
```

- [ ] **Step 4: Call it from `insertConversation`**

In `convex/conversations.ts`, change the body of `insertConversation` (line 686) to:

```ts
): Promise<Id<"conversations">> {
  const conversationId = await ctx.db.insert("conversations", {
    ...fields,
    status: "open",
    unreadCount: 0,
    awaitingReply: true,
  });
  // The reports rollup's conversations-started series. This is the single
  // choke point every creation path already routes through, so counting
  // here cannot be bypassed the way the four drifted `insert` call sites
  // this function replaced were.
  await bumpConversationStartedStat(
    ctx,
    fields.accountId,
    Date.now(),
    "conversationsStarted",
  );
  return conversationId;
}
```

Add `import { bumpConversationStartedStat } from "./messages";` to that file. If this creates a circular import (`messages.ts` already imports from `conversations.ts`), move `bumpConversationStartedStat` and `hourStartMs`'s call site into a new `convex/lib/hourlyStats.ts` that takes `{ db }` and import it from both — check with `npx vitest run convex/conversations.test.ts` and follow whichever the module graph allows.

- [ ] **Step 5: Call it from `adReferrals.record`**

In `convex/adReferrals.ts`, immediately before the existing `ctx.db.insert("adReferrals", ...)` (line 88), add:

```ts
    // Count this conversation as ad-sourced the first time a referral lands
    // on it. The guard is per-CONVERSATION, deliberately not the
    // per-CONTACT `isFirstTouch` computed above: a returning customer who
    // clicks a second ad opens a second ad-sourced conversation and must be
    // counted again, which `isFirstTouch` would suppress.
    const priorOnConversation = await ctx.db
      .query("adReferrals")
      .withIndex("by_contact", (q) => q.eq("contactId", args.contactId))
      .collect();
    const alreadyCounted = priorOnConversation.some(
      (r) => r.conversationId === args.conversationId,
    );
    if (!alreadyCounted) {
      const conversation = await ctx.db.get(args.conversationId);
      if (conversation) {
        await bumpConversationStartedStat(
          ctx,
          args.accountId,
          conversation._creationTime,
          "conversationsStartedAd",
        );
      }
    }
```

Add the import. Note `by_contact` rather than a conversation index: `adReferrals` has no `by_conversation` index, and a contact's referral count is small and already read by `record` for `isFirstTouch` — reuse that read if the existing code already performed it rather than issuing a second one.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run convex/conversations.test.ts convex/adReferrals.test.ts convex/messages.test.ts`
Expected: PASS.

- [ ] **Step 7: Lint and commit**

```bash
npx eslint convex/conversations.ts convex/adReferrals.ts convex/messages.ts convex/conversations.test.ts convex/adReferrals.test.ts
git add convex/conversations.ts convex/adReferrals.ts convex/messages.ts convex/conversations.test.ts convex/adReferrals.test.ts
git commit -m "feat(reports): count conversations started, total and ad-sourced

Ad dedup is per-conversation, not adReferrals' per-contact isFirstTouch —
a returning customer clicking a second ad must be counted again.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Reply-latency histogram

**Files:**
- Modify: `convex/messages.ts:194-230`
- Test: `convex/messages.test.ts`

**Interfaces:**
- Consumes: `responseBucketFor`, `addResponseBucket`, `emptyResponseBuckets` from `./lib/reportStats`.
- Produces: `messageHourlyStats.responseBuckets` populated alongside the existing `responseCount`/`responseTotalMs`.

- [ ] **Step 1: Write the failing test**

Append to `convex/messages.test.ts`:

```ts
test("recordResponseSample fills the histogram alongside the sum and count", async () => {
  const t = convexTest(schema, modules);
  const { accountId, conversationId } = await seedThread(t);

  // Customer asks, agent replies 3 minutes later -> the m5 bucket.
  const askedAt = Date.now();
  await t.run(async (ctx) => {
    await ctx.db.patch(conversationId, { pendingCustomerAtMs: askedAt });
  });
  vi.setSystemTime(askedAt + 3 * 60_000);
  await t.mutation(internal.messages.appendInternal, {
    accountId,
    conversationId,
    senderType: "agent",
    contentType: "text",
    contentText: "on it",
  });

  const row = await t.run(async (ctx) =>
    ctx.db
      .query("messageHourlyStats")
      .withIndex("by_account_hour", (q) =>
        q.eq("accountId", accountId).eq("hourStartMs", hourStartMs(askedAt)),
      )
      .unique(),
  );
  expect(row?.responseCount).toBe(1);
  expect(row?.responseBuckets).toEqual({ ...emptyResponseBuckets(), m5: 1 });
  // The histogram must always agree with the count it sits beside — a
  // divergence means one write path updated only half the pair.
  const histogramTotal = Object.values(row!.responseBuckets!).reduce(
    (a, b) => a + b,
    0,
  );
  expect(histogramTotal).toBe(row!.responseCount);
});
```

Import `emptyResponseBuckets` from `./lib/reportStats` and `hourStartMs` from `./lib/messageStats` in that file. Reuse its existing thread-seeding helper; the assertion, not the seed, is what this task adds.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run convex/messages.test.ts -t "fills the histogram"`
Expected: FAIL — `responseBuckets` is `undefined`.

- [ ] **Step 3: Write the implementation**

In `convex/messages.ts`, in `recordResponseSample`, change both branches:

```ts
  const bucketKey = responseBucketFor(elapsedMs);

  if (existing) {
    await ctx.db.patch(existing._id, {
      responseCount: (existing.responseCount ?? 0) + 1,
      responseTotalMs: (existing.responseTotalMs ?? 0) + elapsedMs,
      responseBuckets: addResponseBucket(existing.responseBuckets, bucketKey),
    });
    return;
  }

  await ctx.db.insert("messageHourlyStats", {
    accountId,
    hourStartMs: bucketStart,
    incoming: 0,
    outgoing: 0,
    responseCount: 1,
    responseTotalMs: elapsedMs,
    responseBuckets: addResponseBucket(undefined, bucketKey),
  });
```

Add to the function's doc comment, above the existing text:

```
 * Also fills `responseBuckets`, the histogram the reports SLA panel reads.
 * It is written in the SAME patch as the sum and count, never separately —
 * a histogram that can disagree with the count beside it is a silently
 * wrong percentile, which is the failure this whole rollup exists to avoid.
```

Add the import: `import { responseBucketFor, addResponseBucket } from "./lib/reportStats";`

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run convex/messages.test.ts convex/dashboard.test.ts`
Expected: PASS. `dashboard.responseTime` reads the same rows and must be unaffected.

- [ ] **Step 5: Lint and commit**

```bash
npx eslint convex/messages.ts convex/messages.test.ts
git add convex/messages.ts convex/messages.test.ts
git commit -m "feat(reports): record a reply-latency histogram per hour

Written in the same patch as responseCount/responseTotalMs so the two can
never disagree.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Meta billing counters

**Files:**
- Modify: `convex/messages.ts:697+` (`applyStatusPricing`)
- Test: `convex/messages.test.ts`

**Interfaces:**
- Consumes: `pricingCategoryKey`, `addPricingCategory` from `./lib/reportStats`; `hourStartMs` from `./lib/messageStats`.
- Produces: `billableConversations`, `freeEntryPointConversations`, `billedMessagesByCategory` on the rollup.

- [ ] **Step 1: Write the failing tests**

Append to `convex/messages.test.ts`:

```ts
// A status webhook fires repeatedly for one message (sent -> delivered ->
// read). Without a guard each callback would re-count the same message, and
// the billing panel would over-report by however many callbacks Meta sent —
// a wrong number that looks entirely plausible.
test("repeated status callbacks count one message exactly once", async () => {
  const t = convexTest(schema, modules);
  const { accountId, conversationId } = await seedThread(t);
  const sentAt = Date.now();

  await t.run(async (ctx) =>
    ctx.db.insert("messages", {
      accountId,
      conversationId,
      senderType: "agent",
      contentType: "text",
      status: "sent",
      messageId: "wamid.billing.1",
    }),
  );

  for (const _ of ["sent", "delivered", "read"]) {
    await t.mutation(internal.messages.applyStatusPricing, {
      wamid: "wamid.billing.1",
      accountId,
      pricing: {
        conversationMetaId: "meta-conv-1",
        pricingCategory: "marketing",
        billable: true,
        isFreeEntryPoint: false,
      },
    });
  }

  const row = await t.run(async (ctx) =>
    ctx.db
      .query("messageHourlyStats")
      .withIndex("by_account_hour", (q) =>
        q.eq("accountId", accountId).eq("hourStartMs", hourStartMs(sentAt)),
      )
      .unique(),
  );
  expect(row?.billedMessagesByCategory).toEqual({
    ...emptyPricingCategories(),
    marketing: 1,
  });
  // Same dedup, different mechanism: the conversation counter rides the
  // "new conversationMetaId" branch.
  expect(row?.billableConversations).toBe(1);
  expect(row?.freeEntryPointConversations).toBe(0);
});

test("a genuinely new Meta conversation is counted again", async () => {
  const t = convexTest(schema, modules);
  const { accountId, conversationId } = await seedThread(t);

  for (const [wamid, metaConv] of [
    ["wamid.a", "meta-conv-1"],
    ["wamid.b", "meta-conv-2"],
  ]) {
    await t.run(async (ctx) =>
      ctx.db.insert("messages", {
        accountId, conversationId, senderType: "agent",
        contentType: "text", status: "sent", messageId: wamid,
      }),
    );
    await t.mutation(internal.messages.applyStatusPricing, {
      wamid,
      accountId,
      pricing: {
        conversationMetaId: metaConv,
        pricingCategory: "service",
        billable: true,
        isFreeEntryPoint: true,
      },
    });
  }

  const total = await t.run(async (ctx) => {
    const rows = await ctx.db
      .query("messageHourlyStats")
      .withIndex("by_account_hour", (q) => q.eq("accountId", accountId))
      .collect();
    return {
      billable: rows.reduce((s, r) => s + (r.billableConversations ?? 0), 0),
      fep: rows.reduce((s, r) => s + (r.freeEntryPointConversations ?? 0), 0),
    };
  });
  expect(total).toEqual({ billable: 2, fep: 2 });
});

test("a pricing-free callback writes no billing counters", async () => {
  const t = convexTest(schema, modules);
  const { accountId, conversationId } = await seedThread(t);
  await t.run(async (ctx) =>
    ctx.db.insert("messages", {
      accountId, conversationId, senderType: "agent",
      contentType: "text", status: "sent", messageId: "wamid.empty",
    }),
  );

  await t.mutation(internal.messages.applyStatusPricing, {
    wamid: "wamid.empty",
    accountId,
    pricing: { isFreeEntryPoint: false },
  });

  const rows = await t.run(async (ctx) =>
    ctx.db
      .query("messageHourlyStats")
      .withIndex("by_account_hour", (q) => q.eq("accountId", accountId))
      .collect(),
  );
  const billed = rows.reduce(
    (s, r) => s + (r.billedMessagesByCategory?.marketing ?? 0),
    0,
  );
  expect(billed).toBe(0);
});
```

Import `emptyPricingCategories` from `./lib/reportStats`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run convex/messages.test.ts -t "status callbacks"`
Expected: FAIL — the counters are `undefined`.

- [ ] **Step 3: Write the implementation**

In `applyStatusPricing`, inside the `for (const message of owned)` loop, replace the body:

```ts
    for (const message of owned) {
      if (!hasPricingFacts) continue;
      // Count this message's billing category the FIRST time we learn it.
      // Meta fires a status callback per transition (sent -> delivered ->
      // read), each carrying the same pricing facts; without this guard the
      // panel would report one message as three.
      const isFirstPricingFact = message.pricing === undefined;
      await ctx.db.patch(message._id, {
        pricing: {
          billable: args.pricing.billable ?? message.pricing?.billable,
          model: args.pricing.pricingModel ?? message.pricing?.model,
          category: args.pricing.pricingCategory ?? message.pricing?.category,
          type: args.pricing.pricingType ?? message.pricing?.type,
          capturedAt: now,
        },
      });
      if (isFirstPricingFact) {
        await bumpBilledMessageCategory(
          ctx,
          message.accountId,
          message._creationTime,
          pricingCategoryKey(
            args.pricing.pricingCategory,
            args.pricing.billable,
          ),
        );
      }
    }
```

In the window block, on the `if (!prev || differentConversation)` branch only, after the existing `ctx.db.patch(first.conversationId, {...})` call, add:

```ts
            // This branch IS the dedup: it runs only when we are recording a
            // Meta conversation we have not seen on this thread before, so a
            // repeated callback for the same conversation falls to the merge
            // branch below and counts nothing.
            await bumpBillableConversationStats(
              ctx,
              first.accountId,
              first._creationTime,
              p.isFreeEntryPoint,
            );
```

Add both helpers beside `bumpConversationStartedStat`:

```ts
/** +1 on one billing category, in the hour the MESSAGE was created. */
async function bumpBilledMessageCategory(
  ctx: { db: MutationCtx["db"] },
  accountId: Id<"accounts">,
  messageAtMs: number,
  key: PricingCategoryKey,
): Promise<void> {
  const bucketStart = hourStartMs(messageAtMs);
  const existing = await ctx.db
    .query("messageHourlyStats")
    .withIndex("by_account_hour", (q) =>
      q.eq("accountId", accountId).eq("hourStartMs", bucketStart),
    )
    .unique();

  const next = addPricingCategory(existing?.billedMessagesByCategory, key);
  if (existing) {
    await ctx.db.patch(existing._id, { billedMessagesByCategory: next });
    return;
  }
  await ctx.db.insert("messageHourlyStats", {
    accountId,
    hourStartMs: bucketStart,
    incoming: 0,
    outgoing: 0,
    billedMessagesByCategory: next,
  });
}

/** +1 billable conversation (and free-entry-point, when flagged), in the
 *  hour the first message of the Meta conversation was created. */
async function bumpBillableConversationStats(
  ctx: { db: MutationCtx["db"] },
  accountId: Id<"accounts">,
  messageAtMs: number,
  isFreeEntryPoint: boolean,
): Promise<void> {
  const bucketStart = hourStartMs(messageAtMs);
  const existing = await ctx.db
    .query("messageHourlyStats")
    .withIndex("by_account_hour", (q) =>
      q.eq("accountId", accountId).eq("hourStartMs", bucketStart),
    )
    .unique();

  const fepDelta = isFreeEntryPoint ? 1 : 0;
  if (existing) {
    await ctx.db.patch(existing._id, {
      billableConversations: (existing.billableConversations ?? 0) + 1,
      freeEntryPointConversations:
        (existing.freeEntryPointConversations ?? 0) + fepDelta,
    });
    return;
  }
  await ctx.db.insert("messageHourlyStats", {
    accountId,
    hourStartMs: bucketStart,
    incoming: 0,
    outgoing: 0,
    billableConversations: 1,
    freeEntryPointConversations: fepDelta,
  });
}
```

Add imports: `pricingCategoryKey`, `addPricingCategory`, and the `PricingCategoryKey` type from `./lib/reportStats`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run convex/messages.test.ts`
Expected: PASS, including the pre-existing `applyStatusPricing` tests — the merge/replace branch logic must be untouched.

- [ ] **Step 5: Lint and commit**

```bash
npx eslint convex/messages.ts convex/messages.test.ts
git add convex/messages.ts convex/messages.test.ts
git commit -m "feat(reports): roll up Meta billing categories and billable conversations

Messages count once, on the first callback that carries pricing facts;
conversations count on the new-conversationMetaId branch, which is
already the dedup.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Backfills

**Files:**
- Modify: `convex/messages.ts` (end of file)
- Test: `convex/messages.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–4.
- Produces: `internal.messages.backfillConversationStartedStats`, `internal.messages.backfillResponseBuckets`.

Two backfills, not one. Conversation starts are rebuilt from the `conversations` table; the response histogram is rebuilt from `messageHourlyStats`' own `responseCount` — the raw latencies are gone, so the histogram for historical hours is reconstructed by placing that hour's whole sample count in the bucket its stored average falls into. That is an approximation and the function says so.

Billing counters are **not** backfilled: `messages.pricing` was captured per message but the hour attribution and dedup can be rebuilt from it directly, so a third backfill would be redundant with a straightforward forward-only start. State this in the panel's empty state instead (Task 15).

- [ ] **Step 1: Write the failing test**

Append to `convex/messages.test.ts`:

```ts
test("backfillConversationStartedStats is idempotent", async () => {
  const t = convexTest(schema, modules);
  const accountId = await t.run(async (ctx) =>
    ctx.db.insert("accounts", { name: "Acme", defaultCurrency: "AED" }),
  );
  // Seed three conversations directly (bypassing insertConversation, so no
  // counter is written) to simulate rows that predate the rollup.
  await t.run(async (ctx) => {
    for (let i = 0; i < 3; i++) {
      const contactId = await ctx.db.insert("contacts", {
        accountId,
        phone: `+97150000010${i}`,
      });
      await ctx.db.insert("conversations", {
        accountId, contactId, status: "open",
        unreadCount: 0, awaitingReply: true,
      });
    }
  });

  const runAll = async () => {
    await t.mutation(internal.messages.backfillConversationStartedStats, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
  };
  const total = async () =>
    await t.run(async (ctx) => {
      const rows = await ctx.db
        .query("messageHourlyStats")
        .withIndex("by_account_hour", (q) => q.eq("accountId", accountId))
        .collect();
      return rows.reduce((s, r) => s + (r.conversationsStarted ?? 0), 0);
    });

  await runAll();
  expect(await total()).toBe(3);
  // Running twice must converge, not double. This is the property that
  // makes a resumable backfill safe to re-trigger after an interruption.
  await runAll();
  expect(await total()).toBe(3);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run convex/messages.test.ts -t "backfillConversationStartedStats"`
Expected: FAIL — the function does not exist.

- [ ] **Step 3: Write the implementation**

Append to `convex/messages.ts`, following `backfillMessageHourlyStats`' exact shape (batched, self-scheduling, per-account cursor, SET-not-increment for idempotency):

```ts
// ============================================================
// One-shot backfill for `conversationsStarted` / `conversationsStartedAd`.
//
// Run manually, after the write paths deploy:
//
//   npx convex run messages:backfillConversationStartedStats
//
// IDEMPOTENT by rebuilding whole hours rather than incrementing — each pass
// SETS a bucket to the count it just measured, exactly as
// `backfillMessageHourlyStats` does and for the same reason. A batch that
// ends mid-hour withholds that partial hour and rewinds the cursor to its
// start, so an hour is only written once seen in full.
//
// NOT concurrency-safe: two overlapping runs of the same chain will each
// SET the same buckets, and a bucket measured from a partial view will be
// written as if complete. Trigger one chain and let it finish.
// ============================================================

const CONVERSATION_BACKFILL_BATCH = 500;

export const backfillConversationStartedStats = internalMutation({
  args: {
    accountId: v.optional(v.id("accounts")),
    cursorMs: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<void> => {
    const accounts = await ctx.db.query("accounts").collect();
    if (accounts.length === 0) return;

    const index = args.accountId
      ? accounts.findIndex((a) => a._id === args.accountId)
      : 0;
    if (index < 0) return;
    const account = accounts[index]!;

    const advanceToNextAccount = async () => {
      const next = accounts[index + 1];
      if (!next) return;
      await ctx.scheduler.runAfter(
        0,
        internal.messages.backfillConversationStartedStats,
        { accountId: next._id },
      );
    };

    const batch = await ctx.db
      .query("conversations")
      .withIndex("by_account", (q) =>
        args.cursorMs === undefined
          ? q.eq("accountId", account._id)
          : q.eq("accountId", account._id).gte("_creationTime", args.cursorMs),
      )
      .take(CONVERSATION_BACKFILL_BATCH);

    if (batch.length === 0) {
      await advanceToNextAccount();
      return;
    }

    // Which of these conversations came from an ad. One `by_contact` read
    // per conversation would be O(batch) reads on top of the batch itself;
    // instead read the account's referrals for the batch's time span once.
    const spanStart = hourStartMs(batch[0]!._creationTime);
    const referrals = await ctx.db
      .query("adReferrals")
      .withIndex("by_account", (q) =>
        q.eq("accountId", account._id).gte("_creationTime", spanStart),
      )
      .collect();
    const adConversationIds = new Set(referrals.map((r) => r.conversationId));

    const hours = new Map<number, { started: number; ad: number }>();
    for (const c of batch) {
      const key = hourStartMs(c._creationTime);
      const bucket = hours.get(key) ?? { started: 0, ad: 0 };
      bucket.started += 1;
      if (adConversationIds.has(c._id)) bucket.ad += 1;
      hours.set(key, bucket);
    }

    const sortedHours = [...hours.keys()].sort((a, b) => a - b);
    const isFullBatch = batch.length === CONVERSATION_BACKFILL_BATCH;
    const singleHourOverflow = isFullBatch && sortedHours.length === 1;
    const hoursToWrite =
      isFullBatch && !singleHourOverflow
        ? sortedHours.slice(0, -1)
        : sortedHours;

    if (singleHourOverflow) {
      console.warn(
        `[backfill] account ${account._id}: hour ${new Date(sortedHours[0]!).toISOString()} has more than ${CONVERSATION_BACKFILL_BATCH} conversations; its bucket may undercount`,
      );
    }

    for (const hour of hoursToWrite) {
      const totals = hours.get(hour)!;
      const existing = await ctx.db
        .query("messageHourlyStats")
        .withIndex("by_account_hour", (q) =>
          q.eq("accountId", account._id).eq("hourStartMs", hour),
        )
        .unique();
      const fields = {
        conversationsStarted: totals.started,
        conversationsStartedAd: totals.ad,
      };
      if (existing) await ctx.db.patch(existing._id, fields);
      else
        await ctx.db.insert("messageHourlyStats", {
          accountId: account._id,
          hourStartMs: hour,
          incoming: 0,
          outgoing: 0,
          ...fields,
        });
    }

    if (!isFullBatch) {
      await advanceToNextAccount();
      return;
    }

    const resumeFrom = singleHourOverflow
      ? sortedHours[0]! + HOUR_MS
      : sortedHours[sortedHours.length - 1]!;
    await ctx.scheduler.runAfter(
      0,
      internal.messages.backfillConversationStartedStats,
      { accountId: account._id, cursorMs: resumeFrom },
    );
  },
});

// ============================================================
// One-shot backfill for `responseBuckets`.
//
//   npx convex run messages:backfillResponseBuckets
//
// APPROXIMATE, and deliberately so. The raw per-reply latencies are not
// retained — only each hour's sum and count — so an historical hour's
// histogram cannot be reconstructed exactly. This places the hour's whole
// sample count in the bucket its stored MEAN falls into, which is right when
// an hour's replies were similar and wrong when they straddled a bucket
// edge. Hours written by `recordResponseSample` after deploy are exact and
// are left alone: the guard is `responseBuckets === undefined`, so a
// re-run never overwrites a real histogram with an estimate.
// ============================================================

export const backfillResponseBuckets = internalMutation({
  args: { cursorMs: v.optional(v.number()) },
  handler: async (ctx, args): Promise<void> => {
    const batch = await ctx.db
      .query("messageHourlyStats")
      .withIndex("by_account_hour", (q) =>
        args.cursorMs === undefined ? q : q.gte("hourStartMs", args.cursorMs),
      )
      .take(500);
    if (batch.length === 0) return;

    for (const row of batch) {
      const count = row.responseCount ?? 0;
      if (count <= 0) continue;
      if (row.responseBuckets !== undefined) continue; // exact already
      const meanMs = (row.responseTotalMs ?? 0) / count;
      const key = responseBucketFor(meanMs);
      await ctx.db.patch(row._id, {
        responseBuckets: { ...emptyResponseBuckets(), [key]: count },
      });
    }

    if (batch.length < 500) return;
    await ctx.scheduler.runAfter(0, internal.messages.backfillResponseBuckets, {
      cursorMs: batch[batch.length - 1]!.hourStartMs + 1,
    });
  },
});
```

Add imports for `HOUR_MS` and `emptyResponseBuckets` if not already present.

> `backfillResponseBuckets` ranges `by_account_hour` without binding
> `accountId`. That index leads with `accountId`, so this is a full-table
> ordered scan, not a range — correct for a deployment-wide one-shot, but
> keep the 500-row batch.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run convex/messages.test.ts`
Expected: PASS.

- [ ] **Step 5: Lint and commit**

```bash
npx eslint convex/messages.ts convex/messages.test.ts
git add convex/messages.ts convex/messages.test.ts
git commit -m "feat(reports): backfills for conversation-start and response-bucket counters

Conversation starts rebuild exactly. Response histograms are approximated
from each hour's stored mean — the raw latencies are gone — and never
overwrite a histogram recordResponseSample already wrote exactly.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

# Phase 2 — Read layer

### Task 6: Fold helpers

**Files:**
- Modify: `convex/lib/reportStats.ts`
- Modify: `convex/lib/reportStats.test.ts`
- Modify: `convex/lib/dashboardDate.ts`
- Modify: `convex/lib/dashboardDate.test.ts`

**Interfaces:**
- Consumes: `localDayKeyFromMs`, `localMondayIndexFromMs` from `./dashboardDate`.
- Produces:
  - `localMondayStartMsFromMs(ms: number, tzOffsetMinutes: number): number` (in `dashboardDate.ts`)
  - `localWeekKeyFromMs(ms: number, tzOffsetMinutes: number): string` — the week's Monday as `YYYY-MM-DD`
  - `type ReportHourRow` — the subset of `messageHourlyStats` every fold reads
  - `type VolumeTotals = { conversationsStarted: number; conversationsStartedAd: number; incoming: number; outgoing: number }`
  - `foldHoursIntoVolume(rows, keys, tzOffsetMinutes, granularity: "day" | "week"): Map<string, VolumeTotals>`
  - `foldHoursIntoHourOfDay(rows, tzOffsetMinutes): number[]` — 24 slots of inbound
  - `type ResponseDayPoint = { key: string; avgMinutes: number | null; samples: number }`
  - `foldHoursIntoResponseSeries(rows, keys, tzOffsetMinutes, granularity): ResponseDayPoint[]`
  - `sumResponseBuckets(rows): ResponseBuckets`
  - `percentileRange(buckets: ResponseBuckets, p: number): { lowMinutes: number; highMinutes: number | null } | null`
  - `withinTargetRatio(buckets: ResponseBuckets, targetMinutes: 1 | 5 | 15 | 60): number | null`
  - `type BillingTotals = { billableConversations: number; freeEntryPointConversations: number; categories: PricingCategories }`
  - `foldHoursIntoBilling(rows, keys, tzOffsetMinutes, granularity): Map<string, BillingTotals>`

- [ ] **Step 1: Write the failing tests**

Append to `convex/lib/reportStats.test.ts`:

```ts
import {
  localWeekKeyFromMs,
  foldHoursIntoVolume,
  foldHoursIntoHourOfDay,
  percentileRange,
  withinTargetRatio,
  sumResponseBuckets,
} from "./reportStats";

const H = (iso: string) => Date.parse(iso);

describe("localWeekKeyFromMs", () => {
  it("keys a week by its Monday", () => {
    // 2026-08-05 is a Wednesday; its Monday is 2026-08-03.
    expect(localWeekKeyFromMs(H("2026-08-05T10:00:00Z"), 0)).toBe("2026-08-03");
    expect(localWeekKeyFromMs(H("2026-08-03T00:00:00Z"), 0)).toBe("2026-08-03");
    // Sunday belongs to the week that began the previous Monday.
    expect(localWeekKeyFromMs(H("2026-08-09T23:00:00Z"), 0)).toBe("2026-08-03");
    expect(localWeekKeyFromMs(H("2026-08-10T00:00:00Z"), 0)).toBe("2026-08-10");
  });

  it("respects the caller's offset at a week boundary", () => {
    // 2026-08-10T00:30Z is Monday in UTC but still Sunday in UTC-4 (+240).
    expect(localWeekKeyFromMs(H("2026-08-10T00:30:00Z"), 240)).toBe("2026-08-03");
  });
});

describe("foldHoursIntoVolume", () => {
  const rows = [
    { hourStartMs: H("2026-08-03T08:00:00Z"), incoming: 3, outgoing: 1, conversationsStarted: 2, conversationsStartedAd: 1 },
    { hourStartMs: H("2026-08-04T09:00:00Z"), incoming: 1, outgoing: 4, conversationsStarted: 1, conversationsStartedAd: 0 },
  ];

  it("sums into local days, seeding every requested key", () => {
    const out = foldHoursIntoVolume(rows, ["2026-08-03", "2026-08-04", "2026-08-05"], 0, "day");
    expect(out.get("2026-08-03")).toEqual({ conversationsStarted: 2, conversationsStartedAd: 1, incoming: 3, outgoing: 1 });
    expect(out.get("2026-08-05")).toEqual({ conversationsStarted: 0, conversationsStartedAd: 0, incoming: 0, outgoing: 0 });
  });

  it("sums both days into one week bucket", () => {
    const out = foldHoursIntoVolume(rows, ["2026-08-03"], 0, "week");
    expect(out.get("2026-08-03")).toEqual({ conversationsStarted: 3, conversationsStartedAd: 1, incoming: 4, outgoing: 5 });
  });

  it("drops hours outside the requested keys rather than inventing keys", () => {
    const out = foldHoursIntoVolume(rows, ["2026-08-04"], 0, "day");
    expect(out.size).toBe(1);
    expect(out.get("2026-08-04")!.conversationsStarted).toBe(1);
  });

  // A row written before these counters shipped has neither field. It must
  // read as zero, not NaN — one NaN poisons the whole chart's axis.
  it("treats absent counters as zero", () => {
    const out = foldHoursIntoVolume(
      [{ hourStartMs: H("2026-08-03T08:00:00Z"), incoming: 1, outgoing: 0 }],
      ["2026-08-03"], 0, "day",
    );
    expect(out.get("2026-08-03")).toEqual({ conversationsStarted: 0, conversationsStartedAd: 0, incoming: 1, outgoing: 0 });
  });
});

describe("foldHoursIntoHourOfDay", () => {
  it("returns 24 slots keyed by local hour", () => {
    const out = foldHoursIntoHourOfDay(
      [
        { hourStartMs: H("2026-08-03T08:00:00Z"), incoming: 3, outgoing: 0 },
        { hourStartMs: H("2026-08-04T08:00:00Z"), incoming: 2, outgoing: 0 },
      ],
      -240, // UTC+4: 08:00Z is 12:00 local
    );
    expect(out).toHaveLength(24);
    expect(out[12]).toBe(5);
    expect(out[8]).toBe(0);
  });
});

describe("percentileRange", () => {
  const buckets = { m1: 10, m5: 10, m15: 10, m60: 10, m240: 10, over: 0 };

  it("returns the bucket range containing the percentile", () => {
    expect(percentileRange(buckets, 50)).toEqual({ lowMinutes: 5, highMinutes: 15 });
    expect(percentileRange(buckets, 10)).toEqual({ lowMinutes: 0, highMinutes: 1 });
  });

  it("reports an open-ended top bucket as null-high", () => {
    expect(percentileRange({ ...buckets, over: 100 }, 95)).toEqual({ lowMinutes: 240, highMinutes: null });
  });

  it("returns null with no samples, rather than a fake zero", () => {
    expect(percentileRange(emptyResponseBuckets(), 50)).toBeNull();
  });
});

describe("withinTargetRatio", () => {
  it("is exact at a bucket edge", () => {
    const buckets = { m1: 25, m5: 25, m15: 25, m60: 25, m240: 0, over: 0 };
    expect(withinTargetRatio(buckets, 5)).toBeCloseTo(0.5);
    expect(withinTargetRatio(buckets, 15)).toBeCloseTo(0.75);
    expect(withinTargetRatio(buckets, 1)).toBeCloseTo(0.25);
  });

  it("returns null with no samples", () => {
    expect(withinTargetRatio(emptyResponseBuckets(), 5)).toBeNull();
  });
});

describe("sumResponseBuckets", () => {
  it("adds histograms across hours, absent reading as zero", () => {
    const out = sumResponseBuckets([
      { hourStartMs: 0, incoming: 0, outgoing: 0, responseBuckets: { ...emptyResponseBuckets(), m5: 2 } },
      { hourStartMs: 0, incoming: 0, outgoing: 0 },
      { hourStartMs: 0, incoming: 0, outgoing: 0, responseBuckets: { ...emptyResponseBuckets(), m5: 1, over: 3 } },
    ]);
    expect(out).toEqual({ ...emptyResponseBuckets(), m5: 3, over: 3 });
  });
});
```

Append to `convex/lib/dashboardDate.test.ts`:

```ts
describe("localMondayStartMsFromMs", () => {
  it("returns local midnight of the week's Monday", () => {
    const wed = Date.parse("2026-08-05T10:00:00Z");
    expect(localMondayStartMsFromMs(wed, 0)).toBe(Date.parse("2026-08-03T00:00:00Z"));
  });

  it("is idempotent on a Monday midnight", () => {
    const mon = Date.parse("2026-08-03T00:00:00Z");
    expect(localMondayStartMsFromMs(mon, 0)).toBe(mon);
  });

  it("offsets the boundary by the caller's timezone", () => {
    // UTC+4 (-240): local Monday midnight is 2026-08-02T20:00Z.
    const wed = Date.parse("2026-08-05T10:00:00Z");
    expect(localMondayStartMsFromMs(wed, -240)).toBe(Date.parse("2026-08-02T20:00:00Z"));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run convex/lib/reportStats.test.ts convex/lib/dashboardDate.test.ts`
Expected: FAIL — the new exports do not exist.

- [ ] **Step 3: Add `localMondayStartMsFromMs`**

Append to `convex/lib/dashboardDate.ts`:

```ts
/**
 * Absolute UTC ms of local midnight on the MONDAY of the week containing
 * `ms`. The week key for every report grouping.
 *
 * Monday-start (not Sunday) matches `localMondayIndexFromMs`, which
 * `dashboard.responseTime` already uses for its week-over-week figures.
 */
export function localMondayStartMsFromMs(
  ms: number,
  tzOffsetMinutes: number,
): number {
  return localMidnightMsDaysAgo(
    ms,
    tzOffsetMinutes,
    localMondayIndexFromMs(ms, tzOffsetMinutes),
  );
}
```

- [ ] **Step 4: Add the folds**

Append to `convex/lib/reportStats.ts`:

```ts
import {
  localDayKeyFromMs,
  localMondayStartMsFromMs,
} from "./dashboardDate";

/** The `messageHourlyStats` subset every fold below reads. Every counter is
 *  optional: a row written before these fields shipped has none, and each
 *  must read as zero rather than NaN — one NaN poisons a whole chart axis. */
export type ReportHourRow = {
  hourStartMs: number;
  incoming: number;
  outgoing: number;
  conversationsStarted?: number;
  conversationsStartedAd?: number;
  responseCount?: number;
  responseTotalMs?: number;
  responseBuckets?: ResponseBuckets;
  billableConversations?: number;
  freeEntryPointConversations?: number;
  billedMessagesByCategory?: PricingCategories;
};

export type Granularity = "day" | "week";

/** Week key = the week's Monday as `YYYY-MM-DD`. Not an ISO week number,
 *  which drags in week-year edge cases (a January 1st can belong to the
 *  previous year's week 52) for no benefit here. */
export function localWeekKeyFromMs(
  ms: number,
  tzOffsetMinutes: number,
): string {
  return localDayKeyFromMs(
    localMondayStartMsFromMs(ms, tzOffsetMinutes),
    tzOffsetMinutes,
  );
}

function bucketKeyFor(
  ms: number,
  tzOffsetMinutes: number,
  granularity: Granularity,
): string {
  return granularity === "week"
    ? localWeekKeyFromMs(ms, tzOffsetMinutes)
    : localDayKeyFromMs(ms, tzOffsetMinutes);
}

export type VolumeTotals = {
  conversationsStarted: number;
  conversationsStartedAd: number;
  incoming: number;
  outgoing: number;
};

/**
 * Fold hourly rows into the caller's local days or weeks.
 *
 * Every requested key is seeded to zero so a quiet period charts as a zero
 * rather than a gap, and hours outside `keys` are dropped rather than adding
 * keys the caller did not ask for — the same contract `foldHoursIntoDays`
 * established in `messageStats.ts`.
 */
export function foldHoursIntoVolume(
  rows: readonly ReportHourRow[],
  keys: readonly string[],
  tzOffsetMinutes: number,
  granularity: Granularity,
): Map<string, VolumeTotals> {
  const out = new Map<string, VolumeTotals>();
  for (const key of keys)
    out.set(key, {
      conversationsStarted: 0,
      conversationsStartedAd: 0,
      incoming: 0,
      outgoing: 0,
    });

  for (const row of rows) {
    const bucket = out.get(
      bucketKeyFor(row.hourStartMs, tzOffsetMinutes, granularity),
    );
    if (!bucket) continue;
    bucket.conversationsStarted += row.conversationsStarted ?? 0;
    bucket.conversationsStartedAd += row.conversationsStartedAd ?? 0;
    bucket.incoming += row.incoming;
    bucket.outgoing += row.outgoing;
  }
  return out;
}

/** Inbound volume by local hour-of-day, 24 slots. Shows which hours are busy
 *  across the whole window, which is what the heatmap renders. */
export function foldHoursIntoHourOfDay(
  rows: readonly ReportHourRow[],
  tzOffsetMinutes: number,
): number[] {
  const slots = Array.from({ length: 24 }, () => 0);
  for (const row of rows) {
    const localMs = row.hourStartMs - tzOffsetMinutes * 60_000;
    const hour = new Date(localMs).getUTCHours();
    slots[hour]! += row.incoming;
  }
  return slots;
}

export type ResponseDayPoint = {
  key: string;
  avgMinutes: number | null;
  samples: number;
};

/** Average reply latency per day/week. `avgMinutes: null` for a period with
 *  no samples — distinct from zero, which would mean instant replies. */
export function foldHoursIntoResponseSeries(
  rows: readonly ReportHourRow[],
  keys: readonly string[],
  tzOffsetMinutes: number,
  granularity: Granularity,
): ResponseDayPoint[] {
  const running = new Map<string, { totalMs: number; count: number }>();
  for (const key of keys) running.set(key, { totalMs: 0, count: 0 });

  for (const row of rows) {
    const count = row.responseCount ?? 0;
    if (count <= 0) continue;
    const bucket = running.get(
      bucketKeyFor(row.hourStartMs, tzOffsetMinutes, granularity),
    );
    if (!bucket) continue;
    bucket.totalMs += row.responseTotalMs ?? 0;
    bucket.count += count;
  }

  return keys.map((key) => {
    const r = running.get(key)!;
    return {
      key,
      avgMinutes: r.count === 0 ? null : r.totalMs / r.count / 60_000,
      samples: r.count,
    };
  });
}

/** Add every row's histogram together. Absent reads as all-zero. */
export function sumResponseBuckets(
  rows: readonly ReportHourRow[],
): ResponseBuckets {
  const out = emptyResponseBuckets();
  for (const row of rows) {
    if (!row.responseBuckets) continue;
    for (const key of RESPONSE_BUCKET_KEYS)
      out[key] += row.responseBuckets[key] ?? 0;
  }
  return out;
}

/**
 * The bucket RANGE containing the p-th percentile.
 *
 * Deliberately a range and not a point. The histogram knows how many
 * replies fell between 5 and 15 minutes but nothing about their
 * distribution inside it, so interpolating to "p90 = 11.4 min" would invent
 * a precision the data does not have. The UI renders "5–15 min".
 *
 * Returns null with no samples — the honest answer, not a zero that would
 * read as "we reply instantly".
 */
export function percentileRange(
  buckets: ResponseBuckets,
  p: number,
): { lowMinutes: number; highMinutes: number | null } | null {
  const total = RESPONSE_BUCKET_KEYS.reduce((s, k) => s + buckets[k], 0);
  if (total === 0) return null;

  const threshold = (p / 100) * total;
  let cumulative = 0;
  let low = 0;
  for (const key of RESPONSE_BUCKET_KEYS) {
    cumulative += buckets[key];
    const high = RESPONSE_BUCKET_EDGES_MINUTES[key];
    if (cumulative >= threshold) return { lowMinutes: low, highMinutes: high };
    low = high ?? low;
  }
  return { lowMinutes: 240, highMinutes: null };
}

/**
 * Share of replies at or under `targetMinutes`.
 *
 * Exact ONLY because every allowed target is a bucket edge — that is the
 * whole reason the histogram's edges are 1/5/15/60/240. A target between
 * edges could not be answered without inventing a distribution, so the type
 * does not permit one.
 */
export function withinTargetRatio(
  buckets: ResponseBuckets,
  targetMinutes: 1 | 5 | 15 | 60,
): number | null {
  const total = RESPONSE_BUCKET_KEYS.reduce((s, k) => s + buckets[k], 0);
  if (total === 0) return null;
  let within = 0;
  for (const key of RESPONSE_BUCKET_KEYS) {
    const high = RESPONSE_BUCKET_EDGES_MINUTES[key];
    if (high !== null && high <= targetMinutes) within += buckets[key];
  }
  return within / total;
}

export type BillingTotals = {
  billableConversations: number;
  freeEntryPointConversations: number;
  categories: PricingCategories;
};

export function foldHoursIntoBilling(
  rows: readonly ReportHourRow[],
  keys: readonly string[],
  tzOffsetMinutes: number,
  granularity: Granularity,
): Map<string, BillingTotals> {
  const out = new Map<string, BillingTotals>();
  for (const key of keys)
    out.set(key, {
      billableConversations: 0,
      freeEntryPointConversations: 0,
      categories: emptyPricingCategories(),
    });

  for (const row of rows) {
    const bucket = out.get(
      bucketKeyFor(row.hourStartMs, tzOffsetMinutes, granularity),
    );
    if (!bucket) continue;
    bucket.billableConversations += row.billableConversations ?? 0;
    bucket.freeEntryPointConversations += row.freeEntryPointConversations ?? 0;
    for (const key of PRICING_CATEGORY_KEYS)
      bucket.categories[key] += row.billedMessagesByCategory?.[key] ?? 0;
  }
  return out;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run convex/lib/reportStats.test.ts convex/lib/dashboardDate.test.ts`
Expected: PASS.

- [ ] **Step 6: Lint and commit**

```bash
npx eslint convex/lib/reportStats.ts convex/lib/reportStats.test.ts convex/lib/dashboardDate.ts convex/lib/dashboardDate.test.ts
git add convex/lib/reportStats.ts convex/lib/reportStats.test.ts convex/lib/dashboardDate.ts convex/lib/dashboardDate.test.ts
git commit -m "feat(reports): day/week/hour folds and percentile interpolation

Percentiles are returned as bucket RANGES, never interpolated points — the
histogram does not know the distribution inside a bucket, and a precise
number would be invented.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: `reports.volume` and `reports.conversationStatusMix`

**Files:**
- Create: `convex/reports.ts`
- Create: `convex/reports.test.ts`

**Interfaces:**
- Consumes: `accountQuery` from `./lib/auth`; every fold from `./lib/reportStats`; `hourStartMs` from `./lib/messageStats`.
- Produces:
  - `api.reports.volume({ sinceMs, keys, tzOffsetMinutes, granularity })` → `{ series: Array<{ key: string } & VolumeTotals>, hourOfDay: number[], totals: VolumeTotals }`
  - `api.reports.conversationStatusMix({})` → `{ open: number; pending: number; closed: number; archived: number; capped: boolean }`
  - `export const STATUS_MIX_CAP = 1000`

- [ ] **Step 1: Write the failing test**

Create `convex/reports.test.ts` using `convex/dashboard.test.ts`'s harness verbatim — the same `import.meta.glob("/convex/**/*.ts")` modules constant, the same `makeClock` fake-clock discipline (convex-test clamps `_creationTime` forward only, so seeds must run in non-decreasing time order), and the same `beforeEach`/`afterEach` fake-timer setup. Copy that file's header comment explaining why.

```ts
test("volume folds the rollup into days and totals", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asSupervisor } = await seedAccountWithSupervisor(t);

  await t.run(async (ctx) => {
    await ctx.db.insert("messageHourlyStats", {
      accountId,
      hourStartMs: Date.parse("2026-08-03T08:00:00Z"),
      incoming: 3, outgoing: 1,
      conversationsStarted: 2, conversationsStartedAd: 1,
    });
    await ctx.db.insert("messageHourlyStats", {
      accountId,
      hourStartMs: Date.parse("2026-08-04T09:00:00Z"),
      incoming: 1, outgoing: 4,
      conversationsStarted: 1, conversationsStartedAd: 0,
    });
  });

  const out = await asSupervisor.query(api.reports.volume, {
    sinceMs: Date.parse("2026-08-03T00:00:00Z"),
    keys: ["2026-08-03", "2026-08-04"],
    tzOffsetMinutes: 0,
    granularity: "day",
  });

  expect(out.series).toEqual([
    { key: "2026-08-03", conversationsStarted: 2, conversationsStartedAd: 1, incoming: 3, outgoing: 1 },
    { key: "2026-08-04", conversationsStarted: 1, conversationsStartedAd: 0, incoming: 1, outgoing: 4 },
  ]);
  expect(out.totals.conversationsStarted).toBe(3);
  expect(out.hourOfDay[8]).toBe(3);
  expect(out.hourOfDay[9]).toBe(1);
});

test("volume is FORBIDDEN below supervisor", async () => {
  const t = convexTest(schema, modules);
  const { asAgent } = await seedAccountWithSupervisor(t);
  await expect(
    asAgent.query(api.reports.volume, {
      sinceMs: 0, keys: [], tzOffsetMinutes: 0, granularity: "day",
    }),
  ).rejects.toThrow(/FORBIDDEN/);
});

test("conversationStatusMix counts each status and reports its cap honestly", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asSupervisor } = await seedAccountWithSupervisor(t);

  await t.run(async (ctx) => {
    const mk = async (status: "open" | "pending" | "closed", archived?: number) => {
      const contactId = await ctx.db.insert("contacts", {
        accountId, phone: `+9715${Math.random().toString().slice(2, 10)}`,
      });
      await ctx.db.insert("conversations", {
        accountId, contactId, status, unreadCount: 0,
        awaitingReply: true, archivedAt: archived,
      });
    };
    await mk("open"); await mk("open"); await mk("pending");
    await mk("closed"); await mk("open", Date.now());
  });

  const mix = await asSupervisor.query(api.reports.conversationStatusMix, {});
  expect(mix).toEqual({ open: 2, pending: 1, closed: 1, archived: 1, capped: false });
});
```

Write `seedAccountWithSupervisor(t)` in this file, returning `{ accountId, asSupervisor, asAgent }`, following how `convex/dashboard.test.ts` builds its identity-bound clients (`t.withIdentity(...)` plus a `memberships` row per role).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run convex/reports.test.ts`
Expected: FAIL — `convex/reports.ts` does not exist.

- [ ] **Step 3: Write the implementation**

Create `convex/reports.ts`:

```ts
import { v } from "convex/values";
import { accountQuery } from "./lib/auth";
import { hourStartMs } from "./lib/messageStats";
import {
  foldHoursIntoVolume,
  foldHoursIntoHourOfDay,
  type Granularity,
  type ReportHourRow,
  type VolumeTotals,
} from "./lib/reportStats";

// ============================================================
// Reports section — docs/superpowers/specs/2026-08-05-reports-section-
// design.md.
//
// Every query here is supervisor+ and built on `accountQuery`, so
// `ctx.accountId` always comes from the caller's own `memberships` row and
// never from an argument. All of them return AGGREGATES — no phone numbers,
// no per-contact rows — which is what makes supervisor the right floor
// rather than admin: a supervisor already sees strictly more in the inbox
// (`conversationScope("supervisor") === "all"`).
//
// READ-BOUNDEDNESS IS THE POINT OF THIS FILE. /dashboard was taken down
// twice in production by analytics queries that `.collect()`ed a table
// bounded only by a time window — see `lib/messageStats.ts`'s header for
// the numbers (~137 msg/day broke the 30-day view). So:
//   - every time series reads `messageHourlyStats`, whose cost is 24 rows
//     per day of WINDOW regardless of traffic;
//   - every raw-table scan is on a per-CONVERSATION table, window-bounded,
//     and justified individually at its call site;
//   - nothing here `.collect()`s `messages`.
// ============================================================

const granularityValidator = v.union(v.literal("day"), v.literal("week"));

/** Reads the hour rows once for a window. `hourStartMs(sinceMs)` rather
 *  than `sinceMs`: the bucket containing `sinceMs` starts before it, so
 *  ranging on the raw value would drop the first partial hour. Extra hours
 *  at the edges are harmless — every fold discards keys it was not asked
 *  for. Same contract as `dashboard.conversationsSeries`. */
async function readHours(
  ctx: { db: any; accountId: any },
  sinceMs: number,
): Promise<ReportHourRow[]> {
  return await ctx.db
    .query("messageHourlyStats")
    .withIndex("by_account_hour", (q: any) =>
      q.eq("accountId", ctx.accountId).gte("hourStartMs", hourStartMs(sinceMs)),
    )
    .collect();
}

export const volume = accountQuery({
  args: {
    sinceMs: v.number(),
    keys: v.array(v.string()),
    tzOffsetMinutes: v.number(),
    granularity: granularityValidator,
  },
  handler: async (ctx, args) => {
    ctx.requireRole("supervisor");
    const hours = await readHours(ctx, args.sinceMs);

    const folded = foldHoursIntoVolume(
      hours,
      args.keys,
      args.tzOffsetMinutes,
      args.granularity as Granularity,
    );
    const series = args.keys.map((key) => ({
      key,
      ...(folded.get(key) ?? {
        conversationsStarted: 0,
        conversationsStartedAd: 0,
        incoming: 0,
        outgoing: 0,
      }),
    }));

    const totals: VolumeTotals = series.reduce(
      (acc, p) => ({
        conversationsStarted: acc.conversationsStarted + p.conversationsStarted,
        conversationsStartedAd:
          acc.conversationsStartedAd + p.conversationsStartedAd,
        incoming: acc.incoming + p.incoming,
        outgoing: acc.outgoing + p.outgoing,
      }),
      { conversationsStarted: 0, conversationsStartedAd: 0, incoming: 0, outgoing: 0 },
    );

    return {
      series,
      // Across the whole window, not per-key — the heatmap answers "which
      // hours are busy", which needs every day pooled.
      hourOfDay: foldHoursIntoHourOfDay(hours, args.tzOffsetMinutes),
      totals,
    };
  },
});

/**
 * Ceiling per status bucket. A current-state count, so there is no window to
 * bound it — the bound has to be a `.take()`. Every document in each range
 * is a match (the range pins `archivedAt` and `status`, so there is no
 * `.filter()` to starve), which is what makes this an honest read bound
 * rather than a scan that quietly truncates. Mirrors
 * `dashboard.ACTIVE_CONVERSATIONS_CAP`.
 */
export const STATUS_MIX_CAP = 1000;

export const conversationStatusMix = accountQuery({
  args: {},
  handler: async (ctx) => {
    ctx.requireRole("supervisor");

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

    // Archived is every status, so it cannot pin `status` in the index and
    // is counted across the archived partition instead.
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
      // True when ANY bucket hit its ceiling, so the UI renders "1000+"
      // rather than presenting a clamped figure as exact.
      capped:
        openRaw > STATUS_MIX_CAP ||
        pendingRaw > STATUS_MIX_CAP ||
        closedRaw > STATUS_MIX_CAP ||
        archivedRows.length > STATUS_MIX_CAP,
    };
  },
});
```

> **Implementer note:** `readHours`' `ctx`/`q` are typed `any` above only
> because the plan cannot name Convex's generated context type. Replace both
> with the real types — copy the signature style from
> `dashboard.conversationsSeries`, which performs the identical read — and
> confirm `npx eslint` reports no `no-explicit-any`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run convex/reports.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Lint and commit**

```bash
npx eslint convex/reports.ts convex/reports.test.ts
git add convex/reports.ts convex/reports.test.ts
git commit -m "feat(reports): volume series and conversation status mix queries

Both supervisor-gated aggregates. Status mix takes a capped read per bucket
and reports \`capped\` rather than presenting a clamped count as exact.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 8: `reports.adPerformance`

**Files:**
- Modify: `convex/reports.ts`
- Modify: `convex/reports.test.ts`

**Interfaces:**
- Consumes: `accountQuery`; `FUNNEL_STAGE_KEYS` from `./lib/funnel`.
- Produces: `api.reports.adPerformance({ sinceMs })` → `{ rows: AdRow[], truncated: number, resolution: { pending: number; dormant: number; abandoned: number }, currency: string }` where
  `AdRow = { adId: string; adName: string | null; adSetName: string | null; campaignName: string | null; conversations: number; firstTouchLeads: number; qualified: number; purchased: number; saleValue: number; serviceKeys: string[] }`
- `export const AD_ROW_LIMIT = 100`

- [ ] **Step 1: Write the failing test**

Append to `convex/reports.test.ts`:

```ts
test("adPerformance joins referrals, names and funnel outcomes per ad", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asSupervisor } = await seedAccountWithSupervisor(t);

  const { conversationId, contactId } = await t.run(async (ctx) => {
    const contactId = await ctx.db.insert("contacts", {
      accountId, phone: "+971500000200",
    });
    const conversationId = await ctx.db.insert("conversations", {
      accountId, contactId, status: "open", unreadCount: 0, awaitingReply: true,
    });
    await ctx.db.insert("adReferrals", {
      accountId, contactId, conversationId,
      waMessageId: "wamid.ad.1", adId: "ad-1", sourceType: "ad",
      isFirstTouch: true, serviceMatchKey: "visa",
    });
    await ctx.db.insert("campaignAds", {
      accountId, adId: "ad-1", adName: "Visa Promo",
      adSetName: "Gulf", campaignName: "Summer",
      resolveStatus: "resolved", attempts: 1,
    });
    await ctx.db.insert("funnelTransitions", {
      accountId, conversationId, contactId, stage: "qualified", auto: false,
    });
    await ctx.db.insert("funnelTransitions", {
      accountId, conversationId, contactId, stage: "purchased",
      auto: false, saleValue: 1200,
    });
    return { conversationId, contactId };
  });

  const out = await asSupervisor.query(api.reports.adPerformance, { sinceMs: 0 });
  expect(out.rows).toHaveLength(1);
  expect(out.rows[0]).toMatchObject({
    adId: "ad-1", adName: "Visa Promo", adSetName: "Gulf", campaignName: "Summer",
    conversations: 1, firstTouchLeads: 1, qualified: 1, purchased: 1, saleValue: 1200,
  });
  expect(out.rows[0]!.serviceKeys).toEqual(["visa"]);
  expect(out.truncated).toBe(0);
});

// Two referrals on one conversation is one conversation, not two. Counting
// referral ROWS would inflate every busy ad.
test("adPerformance counts distinct conversations, not referral rows", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asSupervisor } = await seedAccountWithSupervisor(t);

  await t.run(async (ctx) => {
    const contactId = await ctx.db.insert("contacts", {
      accountId, phone: "+971500000201",
    });
    const conversationId = await ctx.db.insert("conversations", {
      accountId, contactId, status: "open", unreadCount: 0, awaitingReply: true,
    });
    for (const wamid of ["wamid.a", "wamid.b"]) {
      await ctx.db.insert("adReferrals", {
        accountId, contactId, conversationId, waMessageId: wamid,
        adId: "ad-2", sourceType: "ad", isFirstTouch: wamid === "wamid.a",
      });
    }
  });

  const out = await asSupervisor.query(api.reports.adPerformance, { sinceMs: 0 });
  expect(out.rows[0]!.conversations).toBe(1);
  expect(out.rows[0]!.firstTouchLeads).toBe(1);
});

test("adPerformance surfaces an unresolved ad by id and counts the resolver backlog", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asSupervisor } = await seedAccountWithSupervisor(t);

  await t.run(async (ctx) => {
    const contactId = await ctx.db.insert("contacts", {
      accountId, phone: "+971500000202",
    });
    const conversationId = await ctx.db.insert("conversations", {
      accountId, contactId, status: "open", unreadCount: 0, awaitingReply: true,
    });
    await ctx.db.insert("adReferrals", {
      accountId, contactId, conversationId, waMessageId: "wamid.c",
      adId: "ad-3", sourceType: "ad", isFirstTouch: true,
    });
    await ctx.db.insert("campaignAds", {
      accountId, adId: "ad-3", resolveStatus: "dormant", attempts: 0,
    });
  });

  const out = await asSupervisor.query(api.reports.adPerformance, { sinceMs: 0 });
  expect(out.rows[0]!.adName).toBeNull();
  expect(out.rows[0]!.adId).toBe("ad-3");
  expect(out.resolution.dormant).toBe(1);
});

test("adPerformance is FORBIDDEN below supervisor", async () => {
  const t = convexTest(schema, modules);
  const { asAgent } = await seedAccountWithSupervisor(t);
  await expect(
    asAgent.query(api.reports.adPerformance, { sinceMs: 0 }),
  ).rejects.toThrow(/FORBIDDEN/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run convex/reports.test.ts -t "adPerformance"`
Expected: FAIL — `api.reports.adPerformance` does not exist.

- [ ] **Step 3: Write the implementation**

Append to `convex/reports.ts`:

```ts
/**
 * Rows returned by `adPerformance`.
 *
 * This is the one read in this file whose cost grows with VOLUME (ad clicks
 * in the window) rather than being pinned by the window alone. The window
 * plus this cap is the v1 bound; the number of ads dropped is reported as
 * `truncated`, never silently cut, so the table cannot imply it is
 * exhaustive. If measurement shows the referral scan itself is the problem,
 * the documented escape hatch is a per-(account, adId, day) rollup.
 */
export const AD_ROW_LIMIT = 100;

export const adPerformance = accountQuery({
  args: { sinceMs: v.number() },
  handler: async (ctx, args) => {
    ctx.requireRole("supervisor");
    const account = await ctx.db.get(ctx.accountId);
    const currency = account?.defaultCurrency ?? "USD";

    // Three window-bounded scans on per-CONVERSATION tables, joined in
    // memory. `campaigns.overview` already does exactly this shape over a
    // 365-day window for two of them.
    const referrals = await ctx.db
      .query("adReferrals")
      .withIndex("by_account", (q) =>
        q.eq("accountId", ctx.accountId).gte("_creationTime", args.sinceMs),
      )
      .collect();
    const transitions = await ctx.db
      .query("funnelTransitions")
      .withIndex("by_account", (q) =>
        q.eq("accountId", ctx.accountId).gte("_creationTime", args.sinceMs),
      )
      .collect();
    // Not window-bounded: a resolution CACHE with one row per ad ever seen,
    // not an event log. It is the same order of magnitude as the ad count
    // this query already returns.
    const ads = await ctx.db
      .query("campaignAds")
      .withIndex("by_account", (q) => q.eq("accountId", ctx.accountId))
      .collect();

    const adsById = new Map(ads.map((a) => [a.adId, a]));
    const resolution = { pending: 0, dormant: 0, abandoned: 0 };
    for (const ad of ads) {
      if (ad.resolveStatus === "pending") resolution.pending += 1;
      else if (ad.resolveStatus === "dormant") resolution.dormant += 1;
      else if (ad.resolveStatus === "abandoned") resolution.abandoned += 1;
    }

    // Which stages each conversation reached, and what it was worth.
    const stagesByConversation = new Map<string, Set<string>>();
    const saleByConversation = new Map<string, number>();
    for (const tr of transitions) {
      const key = tr.conversationId as unknown as string;
      let set = stagesByConversation.get(key);
      if (!set) {
        set = new Set<string>();
        stagesByConversation.set(key, set);
      }
      set.add(tr.stage);
      if (tr.stage === "purchased" && tr.saleValue !== undefined)
        saleByConversation.set(key, tr.saleValue);
    }

    type Acc = {
      conversations: Set<string>;
      firstTouchLeads: number;
      serviceKeys: Set<string>;
    };
    const byAd = new Map<string, Acc>();
    for (const ref of referrals) {
      if (!ref.adId) continue; // Status placements carry no ad id
      let acc = byAd.get(ref.adId);
      if (!acc) {
        acc = {
          conversations: new Set<string>(),
          firstTouchLeads: 0,
          serviceKeys: new Set<string>(),
        };
        byAd.set(ref.adId, acc);
      }
      // Distinct CONVERSATIONS: a thread can carry several referral rows
      // (the customer clicks twice), and counting rows would inflate every
      // busy ad.
      acc.conversations.add(ref.conversationId as unknown as string);
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

    // Truncate by CONVERSATIONS descending, always. Sorting is client-side,
    // so if the server truncated on whatever column the table happened to
    // be sorted by, re-sorting by sale value would appear to reveal an ad
    // that was never sent. Pinning the axis makes the returned set "the N
    // largest by volume" regardless of how it is then displayed.
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run convex/reports.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Lint and commit**

```bash
npx eslint convex/reports.ts convex/reports.test.ts
git add convex/reports.ts convex/reports.test.ts
git commit -m "feat(reports): per-ad performance query

Counts distinct conversations rather than referral rows, truncates on a
pinned axis so client-side re-sorting cannot imply completeness, and
reports the campaignAds resolver backlog rather than hiding unnamed ads.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 9: `reports.responsePerformance` and `reports.awaitingReplyAges`

**Files:**
- Modify: `convex/reports.ts`
- Modify: `convex/reports.test.ts`

**Interfaces:**
- Consumes: `foldHoursIntoResponseSeries`, `sumResponseBuckets`, `percentileRange`, `withinTargetRatio` from `./lib/reportStats`.
- Produces:
  - `api.reports.responsePerformance({ sinceMs, keys, tzOffsetMinutes, granularity, targetMinutes })` → `{ series: ResponseDayPoint[], buckets: ResponseBuckets, samples: number, avgMinutes: number | null, withinTarget: number | null, p50: PercentileRange, p90: PercentileRange, byHourOfDay: Array<{ hour: number; avgMinutes: number | null; samples: number }> }`
  - `api.reports.awaitingReplyAges({})` → `{ under1h: number; h1to4: number; h4to24: number; over24h: number; capped: boolean }`
  - `export const AWAITING_SAMPLE_CAP = 500`

- [ ] **Step 1: Write the failing test**

Append to `convex/reports.test.ts`:

```ts
test("responsePerformance derives averages, exact within-target and percentile ranges", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asSupervisor } = await seedAccountWithSupervisor(t);

  await t.run(async (ctx) => {
    await ctx.db.insert("messageHourlyStats", {
      accountId,
      hourStartMs: Date.parse("2026-08-03T08:00:00Z"),
      incoming: 0, outgoing: 0,
      responseCount: 4,
      responseTotalMs: 4 * 3 * 60_000, // mean 3 min
      responseBuckets: { m1: 0, m5: 2, m15: 2, m60: 0, m240: 0, over: 0 },
    });
  });

  const out = await asSupervisor.query(api.reports.responsePerformance, {
    sinceMs: Date.parse("2026-08-03T00:00:00Z"),
    keys: ["2026-08-03"],
    tzOffsetMinutes: 0,
    granularity: "day",
    targetMinutes: 5,
  });

  expect(out.samples).toBe(4);
  expect(out.avgMinutes).toBeCloseTo(3);
  // Exactly half the replies landed in the sub-5-minute bucket.
  expect(out.withinTarget).toBeCloseTo(0.5);
  expect(out.series[0]).toMatchObject({ key: "2026-08-03", samples: 4 });
  // A RANGE, never an interpolated point — the histogram does not know the
  // distribution inside a bucket.
  expect(out.p50).toEqual({ lowMinutes: 1, highMinutes: 5 });
  expect(out.byHourOfDay[8]).toMatchObject({ hour: 8, samples: 4 });
});

test("responsePerformance reports null, not zero, with no samples", async () => {
  const t = convexTest(schema, modules);
  const { asSupervisor } = await seedAccountWithSupervisor(t);
  const out = await asSupervisor.query(api.reports.responsePerformance, {
    sinceMs: 0, keys: ["2026-08-03"], tzOffsetMinutes: 0,
    granularity: "day", targetMinutes: 5,
  });
  // Zero would read as "we reply instantly", which is the opposite of true.
  expect(out.avgMinutes).toBeNull();
  expect(out.withinTarget).toBeNull();
  expect(out.p50).toBeNull();
});

test("awaitingReplyAges buckets the backlog by age", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asSupervisor } = await seedAccountWithSupervisor(t);
  const now = Date.now();

  await t.run(async (ctx) => {
    const mk = async (agoMs: number) => {
      const contactId = await ctx.db.insert("contacts", {
        accountId, phone: `+9715${Math.random().toString().slice(2, 10)}`,
      });
      await ctx.db.insert("conversations", {
        accountId, contactId, status: "open", unreadCount: 1,
        awaitingReply: true, pendingCustomerAtMs: now - agoMs,
      });
    };
    await mk(30 * 60_000);        // 30 min
    await mk(2 * 3_600_000);      // 2 h
    await mk(10 * 3_600_000);     // 10 h
    await mk(50 * 3_600_000);     // 50 h
  });

  const out = await asSupervisor.query(api.reports.awaitingReplyAges, {});
  expect(out).toEqual({ under1h: 1, h1to4: 1, h4to24: 1, over24h: 1, capped: false });
});

test("responsePerformance and awaitingReplyAges are FORBIDDEN below supervisor", async () => {
  const t = convexTest(schema, modules);
  const { asAgent } = await seedAccountWithSupervisor(t);
  await expect(
    asAgent.query(api.reports.responsePerformance, {
      sinceMs: 0, keys: [], tzOffsetMinutes: 0,
      granularity: "day", targetMinutes: 5,
    }),
  ).rejects.toThrow(/FORBIDDEN/);
  await expect(
    asAgent.query(api.reports.awaitingReplyAges, {}),
  ).rejects.toThrow(/FORBIDDEN/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run convex/reports.test.ts -t "response"`
Expected: FAIL — the queries do not exist.

- [ ] **Step 3: Write the implementation**

Append to `convex/reports.ts`:

```ts
export const responsePerformance = accountQuery({
  args: {
    sinceMs: v.number(),
    keys: v.array(v.string()),
    tzOffsetMinutes: v.number(),
    granularity: granularityValidator,
    // Constrained to the histogram's own bucket edges. A target between
    // edges cannot be answered without inventing a distribution, so the
    // validator refuses one rather than returning a plausible guess.
    targetMinutes: v.union(
      v.literal(1),
      v.literal(5),
      v.literal(15),
      v.literal(60),
    ),
  },
  handler: async (ctx, args) => {
    ctx.requireRole("supervisor");
    const hours = await readHours(ctx, args.sinceMs);

    const buckets = sumResponseBuckets(hours);
    const samples = RESPONSE_BUCKET_KEYS.reduce((s, k) => s + buckets[k], 0);
    const totalMs = hours.reduce((s, h) => s + (h.responseTotalMs ?? 0), 0);
    const totalCount = hours.reduce((s, h) => s + (h.responseCount ?? 0), 0);

    // Average by local hour-of-day, pooled across the window — this is what
    // exposes "we are slow between 2 and 5pm".
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
        args.granularity as Granularity,
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

/**
 * Ceiling on the backlog sample. Current-state again, so no window bounds
 * it. The take is on the awaiting-reply partition of
 * `by_account_lane_last_message`, which pins `archivedAt`/`awaitingReply`,
 * so every document read is a match and the bound is honest.
 */
export const AWAITING_SAMPLE_CAP = 500;

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
      // has no customer message to time from — a thread opened by us that
      // was never sent. It has no age, so it belongs in no age bucket.
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
```

Add `RESPONSE_BUCKET_KEYS`, `sumResponseBuckets`, `percentileRange`, `withinTargetRatio`, `foldHoursIntoResponseSeries` to the `./lib/reportStats` import.

> **Implementer note:** verify the exact key order of
> `by_account_lane_last_message` in `convex/schema.ts:518-525` before writing
> the `.withIndex` chain — every field preceding `awaitingReply` must be
> bound with `eq` for this to be a range rather than a scan. If the lane
> semantics make `snoozedUntil`/`chasingForcedAt` non-`undefined` for live
> rows, mirror how `convex/conversations.ts`'s Active lane binds them.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run convex/reports.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Lint and commit**

```bash
npx eslint convex/reports.ts convex/reports.test.ts
git add convex/reports.ts convex/reports.test.ts
git commit -m "feat(reports): response performance and awaiting-reply backlog queries

targetMinutes is constrained to the histogram's bucket edges so the
within-target figure is exact rather than an invented interpolation.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 10: `reports.funnelOverview` and `reports.billing`

**Files:**
- Modify: `convex/reports.ts`
- Modify: `convex/reports.test.ts`
- Modify: `convex/campaigns.ts`

**Interfaces:**
- Consumes: `foldHoursIntoBilling`; `FUNNEL_STAGE_KEYS` from `./lib/funnel`.
- Produces:
  - `api.reports.funnelOverview({ sinceMs })` → same shape as today's `campaigns.overview` but with `windowDays` replaced by the caller's window: `{ funnel: Array<{ stage: string; count: number }>, purchase: { count: number; totalValue: number; currency: string }, meta: {...} }`
  - `api.reports.billing({ sinceMs, keys, tzOffsetMinutes, granularity })` → `{ series: Array<{ key: string } & BillingTotals>, totals: BillingTotals }`

`campaigns.overview` is **kept, not deleted** — `convex/campaigns.test.ts` covers it and Task 11 only redirects the page. Delete it in a follow-up once `/reports` is verified in production; the spec's "fold in" is about the UI, and removing a working query in the same change would make a rollback harder than it needs to be. Add a deprecation comment pointing at `reports.funnelOverview`.

- [ ] **Step 1: Write the failing test**

Append to `convex/reports.test.ts`:

```ts
test("funnelOverview counts distinct conversations per stage and sums recorded value", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asSupervisor } = await seedAccountWithSupervisor(t);

  await t.run(async (ctx) => {
    const contactId = await ctx.db.insert("contacts", {
      accountId, phone: "+971500000300",
    });
    const conversationId = await ctx.db.insert("conversations", {
      accountId, contactId, status: "open", unreadCount: 0, awaitingReply: true,
    });
    // Two transitions into the same stage is ONE conversation reaching it.
    for (const _ of [0, 1]) {
      await ctx.db.insert("funnelTransitions", {
        accountId, conversationId, contactId, stage: "qualified", auto: false,
      });
    }
    await ctx.db.insert("funnelTransitions", {
      accountId, conversationId, contactId, stage: "purchased",
      auto: false, saleValue: 900,
    });
  });

  const out = await asSupervisor.query(api.reports.funnelOverview, { sinceMs: 0 });
  const byStage = Object.fromEntries(out.funnel.map((f) => [f.stage, f.count]));
  expect(byStage.qualified).toBe(1);
  expect(out.purchase).toMatchObject({ count: 1, totalValue: 900, currency: "AED" });
});

test("billing folds the rollup's Meta counters into the requested keys", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asSupervisor } = await seedAccountWithSupervisor(t);

  await t.run(async (ctx) => {
    await ctx.db.insert("messageHourlyStats", {
      accountId,
      hourStartMs: Date.parse("2026-08-03T08:00:00Z"),
      incoming: 0, outgoing: 0,
      billableConversations: 3,
      freeEntryPointConversations: 1,
      billedMessagesByCategory: {
        marketing: 5, utility: 2, service: 1,
        authentication: 0, free: 4, other: 1,
      },
    });
  });

  const out = await asSupervisor.query(api.reports.billing, {
    sinceMs: Date.parse("2026-08-03T00:00:00Z"),
    keys: ["2026-08-03"],
    tzOffsetMinutes: 0,
    granularity: "day",
  });
  expect(out.totals.billableConversations).toBe(3);
  expect(out.totals.freeEntryPointConversations).toBe(1);
  expect(out.totals.categories.marketing).toBe(5);
  expect(out.totals.categories.other).toBe(1);
  expect(out.series[0]!.key).toBe("2026-08-03");
});

test("funnelOverview and billing are FORBIDDEN below supervisor", async () => {
  const t = convexTest(schema, modules);
  const { asAgent } = await seedAccountWithSupervisor(t);
  await expect(
    asAgent.query(api.reports.funnelOverview, { sinceMs: 0 }),
  ).rejects.toThrow(/FORBIDDEN/);
  await expect(
    asAgent.query(api.reports.billing, {
      sinceMs: 0, keys: [], tzOffsetMinutes: 0, granularity: "day",
    }),
  ).rejects.toThrow(/FORBIDDEN/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run convex/reports.test.ts -t "funnelOverview"`
Expected: FAIL — the queries do not exist.

- [ ] **Step 3: Write the implementation**

Append to `convex/reports.ts`. `funnelOverview` is `campaigns.overview`'s body with `WINDOW_DAYS` replaced by the caller's `sinceMs` — copy it from `convex/campaigns.ts:47-130` including its comments about why `purchase.totalValue` reads `funnelTransitions.saleValue` rather than `conversionEvents.value`, and adapt:

```ts
export const funnelOverview = accountQuery({
  args: { sinceMs: v.number() },
  handler: async (ctx, args) => {
    ctx.requireRole("supervisor");
    const account = await ctx.db.get(ctx.accountId);
    const currency = account?.defaultCurrency ?? "USD";

    const transitions = await ctx.db
      .query("funnelTransitions")
      .withIndex("by_account", (q) =>
        q.eq("accountId", ctx.accountId).gte("_creationTime", args.sinceMs),
      )
      .collect();
    const events = await ctx.db
      .query("conversionEvents")
      .withIndex("by_account", (q) =>
        q.eq("accountId", ctx.accountId).gte("_creationTime", args.sinceMs),
      )
      .collect();

    // Distinct conversations that reached each stage — two transitions into
    // one stage is one conversation reaching it, not two.
    const convosByStage = new Map<string, Set<string>>();
    for (const tr of transitions) {
      let set = convosByStage.get(tr.stage);
      if (!set) {
        set = new Set<string>();
        convosByStage.set(tr.stage, set);
      }
      set.add(tr.conversationId as unknown as string);
    }
    const funnel = FUNNEL_STAGE_KEYS.map((stage) => ({
      stage,
      count: convosByStage.get(stage)?.size ?? 0,
    }));

    const meta = {
      sent: 0, pending: 0, dormant: 0,
      unmatched: 0, error: 0, abandoned: 0, total: 0,
    };
    for (const ev of events) {
      meta[ev.status] += 1;
      meta.total += 1;
    }

    // Recorded value, NOT "reported to Meta": `funnelTransitions.saleValue`
    // exists for organic conversations too, while `conversionEvents` rows
    // exist only for attributed ones. Summing from events silently zeroed
    // every organic purchase. The events fallback is for pre-Task-B1 rows,
    // which are the only place a legacy amount lives.
    const eventValueByKey = new Map<string, number>();
    for (const ev of events) {
      if (ev.value !== undefined)
        eventValueByKey.set(`${ev.conversationId}:${ev.stage}`, ev.value);
    }
    const valueByConversation = new Map<string, number>();
    for (const tr of transitions) {
      if (tr.stage !== "purchased") continue;
      const value =
        tr.saleValue ??
        eventValueByKey.get(`${tr.conversationId}:${tr.stage}`);
      if (value !== undefined)
        valueByConversation.set(tr.conversationId as unknown as string, value);
    }
    let totalValue = 0;
    for (const value of valueByConversation.values()) totalValue += value;

    return {
      funnel,
      purchase: {
        count: convosByStage.get("purchased")?.size ?? 0,
        totalValue,
        currency,
      },
      meta,
    };
  },
});

export const billing = accountQuery({
  args: {
    sinceMs: v.number(),
    keys: v.array(v.string()),
    tzOffsetMinutes: v.number(),
    granularity: granularityValidator,
  },
  handler: async (ctx, args) => {
    ctx.requireRole("supervisor");
    const hours = await readHours(ctx, args.sinceMs);

    const folded = foldHoursIntoBilling(
      hours,
      args.keys,
      args.tzOffsetMinutes,
      args.granularity as Granularity,
    );
    const series = args.keys.map((key) => ({
      key,
      ...(folded.get(key) ?? {
        billableConversations: 0,
        freeEntryPointConversations: 0,
        categories: emptyPricingCategories(),
      }),
    }));

    const totals = series.reduce(
      (acc, p) => {
        acc.billableConversations += p.billableConversations;
        acc.freeEntryPointConversations += p.freeEntryPointConversations;
        for (const key of PRICING_CATEGORY_KEYS)
          acc.categories[key] += p.categories[key];
        return acc;
      },
      {
        billableConversations: 0,
        freeEntryPointConversations: 0,
        categories: emptyPricingCategories(),
      },
    );

    return { series, totals };
  },
});
```

Add the needed imports (`FUNNEL_STAGE_KEYS`, `foldHoursIntoBilling`, `emptyPricingCategories`, `PRICING_CATEGORY_KEYS`).

Add above `campaigns.overview` in `convex/campaigns.ts`:

```ts
/**
 * @deprecated Superseded by `reports.funnelOverview`, which takes the
 * caller's window instead of a hardcoded 365 days. Kept until `/reports` is
 * verified in production — deleting a working query in the same change that
 * replaces its UI would make a rollback harder than it needs to be.
 */
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run convex/reports.test.ts convex/campaigns.test.ts`
Expected: PASS. `campaigns.test.ts` must be untouched.

- [ ] **Step 5: Lint and commit**

```bash
npx eslint convex/reports.ts convex/reports.test.ts convex/campaigns.ts
git add convex/reports.ts convex/reports.test.ts convex/campaigns.ts
git commit -m "feat(reports): funnel overview and Meta billing queries

funnelOverview takes the caller's window rather than campaigns.overview's
hardcoded 365 days; that query is deprecated but kept until /reports is
verified in production.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

# Phase 3 — UI

### Task 11: Route shell, navigation, redirect, i18n

**Files:**
- Create: `src/lib/reports/types.ts`
- Create: `src/app/(dashboard)/reports/page.tsx`
- Modify: `src/lib/auth/roles.ts:174`
- Modify: `src/components/layout/sidebar.tsx:106`
- Modify: `src/app/(dashboard)/campaigns/page.tsx`
- Modify: `messages/en.json`
- Test: `src/lib/auth/roles.test.ts` (or `convex/lib/roles.test.ts` — use whichever covers `canAccessNav`)

**Interfaces:**
- Produces, all from `src/lib/reports/types.ts`:
  - `REPORT_TABS`, `type ReportTab`, `RANGE_OPTIONS`, `type RangeDays = 7 | 30 | 90`
  - `parseTab(v: string | null): ReportTab`, `parseRange(v: string | null): RangeDays`
  - `reportWindow(range: RangeDays): ReportWindow`
  - `type ReportWindow = { sinceMs: number; dayKeys: string[]; weekKeys: string[]; tzOffsetMinutes: number }` — every panel takes this as its `window` prop, so Tasks 12–15 all import the type rather than re-deriving it with `ReturnType<typeof reportWindow>`.

- [ ] **Step 1: Write the failing test**

In the suite covering `canAccessNav`, add:

```ts
test("supervisors reach /reports and no longer reach /campaigns", () => {
  expect(canAccessNav("supervisor", "/reports")).toBe(true);
  expect(canAccessNav("supervisor", "/reports/anything")).toBe(true);
  expect(canAccessNav("supervisor", "/campaigns")).toBe(false);
});

test("agents and viewers do not reach /reports", () => {
  expect(canAccessNav("agent", "/reports")).toBe(false);
  expect(canAccessNav("viewer", "/reports")).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run convex/lib/roles.test.ts`
Expected: FAIL — `/reports` is not in `SUPERVISOR_NAV`.

- [ ] **Step 3: Swap the nav allowlist**

In `src/lib/auth/roles.ts`, change line 174 from `"/campaigns",` to `"/reports",`. The array is an allowlist by deliberate design (see its own comment) — adding an entry must be a conscious act, so do not add `/reports` alongside `/campaigns`; replace it.

Mirror the same change in `convex/lib/roles.ts` if that file carries its own copy of the list — check with `grep -n "campaigns" convex/lib/roles.ts src/lib/auth/roles.ts`.

- [ ] **Step 4: Write the shared client types**

Create `src/lib/reports/types.ts`:

```ts
import { daysAgoStart, lastNDayKeys, localDayKey } from '@/lib/dashboard/date-utils'

export const REPORT_TABS = ['conversations', 'ads', 'response', 'funnel', 'billing'] as const
export type ReportTab = (typeof REPORT_TABS)[number]

export const RANGE_OPTIONS = [7, 30, 90] as const
export type RangeDays = (typeof RANGE_OPTIONS)[number]

export function parseTab(value: string | null): ReportTab {
  return (REPORT_TABS as readonly string[]).includes(value ?? '')
    ? (value as ReportTab)
    : 'conversations'
}

export function parseRange(value: string | null): RangeDays {
  const n = Number(value)
  return (RANGE_OPTIONS as readonly number[]).includes(n) ? (n as RangeDays) : 30
}

/**
 * Day keys and week keys for a range, plus the window start.
 *
 * Local-day boundaries are the CALLER's-timezone concept and a Convex
 * function always runs in UTC, so they are computed here and passed as
 * arguments — the same split `convex/dashboard.ts` documents. Week keys are
 * each week's Monday, matching `localWeekKeyFromMs` server-side.
 */
export type ReportWindow = {
  sinceMs: number
  dayKeys: string[]
  weekKeys: string[]
  tzOffsetMinutes: number
}

export function reportWindow(range: RangeDays): ReportWindow {
  const sinceMs = daysAgoStart(range - 1).getTime()
  const dayKeys = lastNDayKeys(range)
  const weekKeys = [...new Set(dayKeys.map(mondayKeyOf))]
  return {
    sinceMs,
    dayKeys,
    weekKeys,
    tzOffsetMinutes: new Date().getTimezoneOffset(),
  }
}

/** Every panel's props. Declared once here so the five panels cannot drift. */
export type ReportPanelProps = { window: ReportWindow; canRead: boolean }

/** The Monday (as YYYY-MM-DD) of the week containing a YYYY-MM-DD day key. */
function mondayKeyOf(dayKey: string): string {
  const [y, m, d] = dayKey.split('-').map(Number)
  const date = new Date(Date.UTC(y!, m! - 1, d!))
  const mondayIndex = (date.getUTCDay() + 6) % 7
  date.setUTCDate(date.getUTCDate() - mondayIndex)
  return localDayKey(date)
}
```

Check `src/lib/dashboard/date-utils.ts` for the actual exported name of the `YYYY-MM-DD` formatter before importing `localDayKey`; if it differs, use the real name or format inline with `toISOString().slice(0, 10)`.

- [ ] **Step 5: Write the route shell**

Create `src/app/(dashboard)/reports/page.tsx`:

```tsx
'use client'

import { useMemo } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { useAuth } from '@/hooks/use-auth'
import { canAccessNav } from '@/lib/auth/roles'
import {
  REPORT_TABS, RANGE_OPTIONS, parseTab, parseRange, reportWindow,
} from '@/lib/reports/types'
import { cn } from '@/lib/utils'
import { ConversationsPanel } from '@/components/reports/conversations-panel'
import { AdsPanel } from '@/components/reports/ads-panel'
import { ResponsePanel } from '@/components/reports/response-panel'
import { FunnelPanel } from '@/components/reports/funnel-panel'
import { BillingPanel } from '@/components/reports/billing-panel'

export default function ReportsPage() {
  const t = useTranslations('Reports')
  const router = useRouter()
  const params = useSearchParams()
  const { accountId, accountRole } = useAuth()

  const tab = parseTab(params.get('tab'))
  const range = parseRange(params.get('range'))
  const window = useMemo(() => reportWindow(range), [range])

  // Both the account and a SUFFICIENT role must be known before any panel
  // fires a query. `api.reports.*` is supervisor-gated server-side, and
  // `useQuery` re-throws FORBIDDEN synchronously during render — with no
  // Error Boundary in this app that crashes the route rather than showing
  // nothing. Same idiom as campaigns/page.tsx.
  const canRead = !!accountId && !!accountRole && canAccessNav(accountRole, '/reports')

  const setParam = (key: 'tab' | 'range', value: string) => {
    const next = new URLSearchParams(params.toString())
    next.set(key, value)
    router.replace(`/reports?${next.toString()}`, { scroll: false })
  }

  return (
    <div className="space-y-5 p-4 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-foreground">{t('title')}</h1>
          <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
        </div>
        <div className="flex gap-1 rounded-lg border border-border bg-card p-1">
          {RANGE_OPTIONS.map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setParam('range', String(option))}
              className={cn(
                'rounded-md px-3 py-1.5 text-sm transition-colors',
                option === range
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {t('range', { days: option })}
            </button>
          ))}
        </div>
      </div>

      <div className="flex gap-1 overflow-x-auto border-b border-border">
        {REPORT_TABS.map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => setParam('tab', key)}
            className={cn(
              'whitespace-nowrap border-b-2 px-3 py-2 text-sm transition-colors',
              key === tab
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {t(`tabs.${key}`)}
          </button>
        ))}
      </div>

      {tab === 'conversations' && <ConversationsPanel window={window} canRead={canRead} />}
      {tab === 'ads' && <AdsPanel window={window} canRead={canRead} />}
      {tab === 'response' && <ResponsePanel window={window} canRead={canRead} />}
      {tab === 'funnel' && <FunnelPanel window={window} canRead={canRead} />}
      {tab === 'billing' && <BillingPanel window={window} canRead={canRead} />}
    </div>
  )
}
```

Create the five panel files as stubs for now so the route compiles — each exporting a component taking `{ window, canRead }` and rendering `null`. Tasks 12–15 fill them in.

- [ ] **Step 6: Swap the sidebar entry and redirect `/campaigns`**

In `src/components/layout/sidebar.tsx`, change line 106 from
`{ href: "/campaigns", labelKey: "campaigns", icon: BarChart3 },` to
`{ href: "/reports", labelKey: "reports", icon: BarChart3 },`.

Replace the whole body of `src/app/(dashboard)/campaigns/page.tsx` with:

```tsx
import { redirect } from 'next/navigation'

/** `/campaigns` was folded into the Reports section. Its funnel view is now
 *  `/reports?tab=funnel`; the old URL is kept as a redirect so existing
 *  bookmarks and links keep working. */
export default function CampaignsPage() {
  redirect('/reports?tab=funnel')
}
```

- [ ] **Step 7: Add i18n keys**

In `messages/en.json`, add a `Reports` namespace beside `Campaigns`:

```json
  "Reports": {
    "title": "Reports",
    "subtitle": "Conversations, ads, response times and Meta billing.",
    "range": "{days} days",
    "tabs": {
      "conversations": "Conversations",
      "ads": "Ads",
      "response": "Response",
      "funnel": "Funnel",
      "billing": "Billing"
    },
    "empty": "No data in this range yet.",
    "exportCsv": "Export CSV"
  },
```

Also add `"reports": "Reports"` to the sidebar's nav-label namespace (find it with `grep -n '"campaigns"' messages/en.json`). Leave the existing `Campaigns` namespace in place — Task 10 kept the query, and removing copy for a page that still exists as a redirect gains nothing.

- [ ] **Step 8: Verify**

Run: `npx vitest run convex/lib/roles.test.ts && npx tsc --noEmit`
Expected: PASS, and no type errors.

Then start the dev server and confirm the route renders, the tabs and range buttons update the URL, and `/campaigns` redirects:

```bash
npm run dev
```

Visit `/reports`, click each tab and each range, then visit `/campaigns`.

- [ ] **Step 9: Lint and commit**

```bash
npx eslint src/lib/reports/types.ts "src/app/(dashboard)/reports/page.tsx" "src/app/(dashboard)/campaigns/page.tsx" src/lib/auth/roles.ts src/components/layout/sidebar.tsx
git add src/lib/reports src/app/\(dashboard\)/reports src/app/\(dashboard\)/campaigns/page.tsx src/lib/auth/roles.ts src/components/layout/sidebar.tsx src/components/reports messages/en.json convex/lib/roles.test.ts
git commit -m "feat(reports): route shell, nav swap and /campaigns redirect

SUPERVISOR_NAV is an allowlist by design, so /campaigns is replaced rather
than joined by /reports.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 12: Conversations panel

**Files:**
- Modify: `src/components/reports/conversations-panel.tsx`
- Create: `src/lib/reports/csv.ts`

**Interfaces:**
- Consumes: `api.reports.volume`, `api.reports.conversationStatusMix`.
- Produces: `downloadCsv(filename: string, headers: string[], rows: (string | number)[][]): void` in `src/lib/reports/csv.ts`, used by every later panel.

- [ ] **Step 1: Write the CSV helper**

Create `src/lib/reports/csv.ts`:

```ts
/**
 * Serialize and download a table client-side, from data already loaded.
 *
 * No server-side export path: every panel's query already returns exactly
 * what is on screen, so a second round trip would only create a way for the
 * file and the page to disagree.
 */
export function downloadCsv(
  filename: string,
  headers: readonly string[],
  rows: readonly (readonly (string | number | null)[])[],
): void {
  const escape = (value: string | number | null): string => {
    const text = value === null ? '' : String(value)
    // Quote when the value contains a delimiter, a quote or a newline;
    // double any embedded quotes. This is the whole of RFC 4180 that
    // matters here, and ad names genuinely contain commas.
    return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
  }

  const csv = [headers, ...rows]
    .map((row) => row.map(escape).join(','))
    .join('\r\n')

  const blob = new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}
```

The leading BOM is deliberate: without it Excel renders non-ASCII ad names as mojibake.

- [ ] **Step 2: Write the panel**

Replace `src/components/reports/conversations-panel.tsx`:

```tsx
'use client'

import { useState } from 'react'
import { useQuery } from '@/lib/convex/cached'
import { api } from '../../../convex/_generated/api'
import { useTranslations } from 'next-intl'
import { MessageSquare, Users, Megaphone, Send } from 'lucide-react'
import { MetricCard } from '@/components/dashboard/metric-card'
import { SkeletonCard } from '@/components/dashboard/skeleton'
import { downloadCsv } from '@/lib/reports/csv'
import type { ReportPanelProps } from '@/lib/reports/types'

export function ConversationsPanel({ window, canRead }: ReportPanelProps) {
  const t = useTranslations('Reports')
  const [granularity, setGranularity] = useState<'day' | 'week'>('day')

  const keys = granularity === 'day' ? window.dayKeys : window.weekKeys
  const data = useQuery(
    api.reports.volume,
    canRead
      ? {
          sinceMs: window.sinceMs,
          keys,
          tzOffsetMinutes: window.tzOffsetMinutes,
          granularity,
        }
      : 'skip',
  )
  const mix = useQuery(api.reports.conversationStatusMix, canRead ? {} : 'skip')
  const loading = data === undefined

  if (loading) {
    return (
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => <SkeletonCard key={i} />)}
      </div>
    )
  }

  const adShare =
    data.totals.conversationsStarted === 0
      ? 0
      : data.totals.conversationsStartedAd / data.totals.conversationsStarted
  const peakHour = data.hourOfDay.indexOf(Math.max(...data.hourOfDay))

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard
          title={t('conversations.started')}
          value={data.totals.conversationsStarted.toLocaleString()}
          icon={MessageSquare}
          subtitle={t('conversations.perDay', {
            n: (data.totals.conversationsStarted / window.dayKeys.length).toFixed(1),
          })}
        />
        <MetricCard
          title={t('conversations.fromAds')}
          value={data.totals.conversationsStartedAd.toLocaleString()}
          icon={Megaphone}
          subtitle={t('conversations.adShare', { pct: Math.round(adShare * 100) })}
        />
        <MetricCard
          title={t('conversations.received')}
          value={data.totals.incoming.toLocaleString()}
          icon={Users}
        />
        <MetricCard
          title={t('conversations.sent')}
          value={data.totals.outgoing.toLocaleString()}
          icon={Send}
        />
      </div>

      <div className="rounded-xl border border-border bg-card p-5">
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="text-sm font-medium text-foreground">
            {t('conversations.chartTitle')}
          </h2>
          <div className="flex items-center gap-2">
            <div className="flex gap-1 rounded-lg border border-border p-1">
              {(['day', 'week'] as const).map((g) => (
                <button
                  key={g}
                  type="button"
                  onClick={() => setGranularity(g)}
                  className={
                    g === granularity
                      ? 'rounded-md bg-primary px-2.5 py-1 text-xs text-primary-foreground'
                      : 'rounded-md px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground'
                  }
                >
                  {t(`conversations.${g}`)}
                </button>
              ))}
            </div>
            <button
              type="button"
              className="rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground"
              onClick={() =>
                downloadCsv(
                  `conversations-${granularity}.csv`,
                  ['period', 'conversations_started', 'from_ads', 'messages_in', 'messages_out'],
                  data.series.map((p) => [
                    p.key, p.conversationsStarted, p.conversationsStartedAd, p.incoming, p.outgoing,
                  ]),
                )
              }
            >
              {t('exportCsv')}
            </button>
          </div>
        </div>

        {data.totals.conversationsStarted === 0 &&
        data.totals.incoming === 0 &&
        data.totals.outgoing === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">{t('empty')}</p>
        ) : (
          <VolumeChart points={data.series} />
        )}
      </div>

      <div className="rounded-xl border border-border bg-card p-5">
        <h2 className="mb-3 text-sm font-medium text-foreground">
          {t('conversations.hourTitle', { hour: peakHour })}
        </h2>
        <HourHeatmap slots={data.hourOfDay} />
      </div>

      {mix && (
        <div className="rounded-xl border border-border bg-card p-5">
          <h2 className="mb-3 text-sm font-medium text-foreground">
            {t('conversations.mixTitle')}
          </h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {(['open', 'pending', 'closed', 'archived'] as const).map((k) => (
              <div key={k} className="rounded-lg border border-border bg-background p-3">
                <p className="text-xs text-muted-foreground">{t(`conversations.status.${k}`)}</p>
                <p className="mt-1 text-lg font-semibold tabular-nums text-foreground">
                  {/* `capped` means the backend stopped counting at its
                      ceiling, so the real figure is higher — render "1000+"
                      rather than a clamped number that reads as exact. */}
                  {mix[k].toLocaleString()}{mix.capped ? '+' : ''}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
```

Add the two subcomponents to the same file:

```tsx
import {
  Bar, BarChart, CartesianGrid, Legend, Line, ComposedChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'

type VolumePoint = {
  key: string
  conversationsStarted: number
  conversationsStartedAd: number
  incoming: number
  outgoing: number
}

function VolumeChart({ points }: { points: VolumePoint[] }) {
  const t = useTranslations('Reports')
  return (
    <ResponsiveContainer width="100%" height={280}>
      <ComposedChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
        <XAxis
          dataKey="key"
          tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
          tickLine={false}
          axisLine={false}
          // A 90-day range has more labels than fit; recharts thins them
          // itself when given a numeric interval, which beats truncating
          // the series.
          interval="preserveStartEnd"
          minTickGap={24}
        />
        <YAxis
          tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
          tickLine={false}
          axisLine={false}
          allowDecimals={false}
        />
        <Tooltip
          contentStyle={{
            background: 'hsl(var(--card))',
            border: '1px solid hsl(var(--border))',
            borderRadius: 8,
            fontSize: 12,
          }}
        />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        {/* Ad-sourced is a SUBSET of started, so the two bars are stacked
            into one column rather than sitting side by side — side-by-side
            would read as two independent totals. */}
        <Bar
          stackId="starts"
          dataKey="conversationsStartedAd"
          name={t('conversations.fromAds')}
          fill="hsl(var(--primary))"
          radius={[0, 0, 0, 0]}
        />
        <Bar
          stackId="starts"
          dataKey="conversationsStartedDirect"
          name={t('conversations.direct')}
          fill="hsl(var(--muted-foreground))"
          radius={[4, 4, 0, 0]}
        />
        <Line
          type="monotone"
          dataKey="incoming"
          name={t('conversations.received')}
          stroke="hsl(var(--chart-2, var(--primary)))"
          dot={false}
          strokeWidth={2}
        />
        <Line
          type="monotone"
          dataKey="outgoing"
          name={t('conversations.sent')}
          stroke="hsl(var(--chart-3, var(--muted-foreground)))"
          dot={false}
          strokeWidth={2}
        />
      </ComposedChart>
    </ResponsiveContainer>
  )
}

function HourHeatmap({ slots }: { slots: number[] }) {
  const t = useTranslations('Reports')
  const max = Math.max(1, ...slots)
  return (
    <div className="grid grid-cols-12 gap-1 sm:grid-cols-24">
      {slots.map((count, hour) => (
        <div key={hour} className="flex flex-col items-center gap-1">
          <div
            className="h-10 w-full rounded bg-primary"
            // Opacity floor of 0.06 so an empty hour is still a visible
            // cell rather than a hole in the grid.
            style={{ opacity: count === 0 ? 0.06 : 0.15 + (count / max) * 0.85 }}
            title={t('conversations.hourTooltip', { hour, count })}
          />
          <span className="text-[10px] tabular-nums text-muted-foreground">
            {hour % 3 === 0 ? hour : ''}
          </span>
        </div>
      ))}
    </div>
  )
}
```

`VolumeChart` reads a `conversationsStartedDirect` key the query does not return — derive it where the chart is rendered, since it is presentation, not a new server field:

```tsx
<VolumeChart
  points={data.series.map((p) => ({
    ...p,
    conversationsStartedDirect: p.conversationsStarted - p.conversationsStartedAd,
  }))}
/>
```

Add the `Reports.conversations.*` i18n keys:

```json
    "conversations": {
      "started": "Conversations started",
      "fromAds": "From ads",
      "direct": "Direct",
      "received": "Messages received",
      "sent": "Messages sent",
      "perDay": "{n} per day",
      "adShare": "{pct}% of all new conversations",
      "chartTitle": "Volume over time",
      "day": "Daily",
      "week": "Weekly",
      "hourTitle": "Busiest hour: {hour}:00",
      "hourTooltip": "{hour}:00 — {count} messages received",
      "mixTitle": "Current conversations by status",
      "status": {
        "open": "Open",
        "pending": "Pending",
        "closed": "Closed",
        "archived": "Archived"
      }
    },
```

- [ ] **Step 3: Verify in the browser**

```bash
npm run dev
```

Visit `/reports?tab=conversations`. Confirm: the four tiles show numbers, switching day/week re-renders the chart with the right number of bars, the heatmap highlights a plausible peak hour, and Export CSV downloads a file whose rows match the chart. Check the browser console for errors.

- [ ] **Step 4: Lint and commit**

```bash
npx eslint src/components/reports/conversations-panel.tsx src/lib/reports/csv.ts
git add src/components/reports/conversations-panel.tsx src/lib/reports/csv.ts messages/en.json
git commit -m "feat(reports): conversations panel with day/week toggle and hour heatmap

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 13: Ads panel

**Files:**
- Modify: `src/components/reports/ads-panel.tsx`

**Interfaces:**
- Consumes: `api.reports.adPerformance`, `downloadCsv`, `formatCurrency` from `@/lib/currency`.

- [ ] **Step 1: Write the panel**

Replace `src/components/reports/ads-panel.tsx`:

```tsx
'use client'

import { useMemo, useState } from 'react'
import { useQuery } from '@/lib/convex/cached'
import { api } from '../../../convex/_generated/api'
import { useTranslations } from 'next-intl'
import { ChevronDown } from 'lucide-react'
import { Skeleton } from '@/components/dashboard/skeleton'
import { formatCurrency } from '@/lib/currency'
import { downloadCsv } from '@/lib/reports/csv'
import { cn } from '@/lib/utils'
import type { ReportPanelProps } from '@/lib/reports/types'

type SortKey =
  | 'conversations' | 'firstTouchLeads' | 'qualified' | 'purchased' | 'saleValue'

const COLUMNS: { key: SortKey; labelKey: string }[] = [
  { key: 'conversations', labelKey: 'ads.conversations' },
  { key: 'firstTouchLeads', labelKey: 'ads.leads' },
  { key: 'qualified', labelKey: 'ads.qualified' },
  { key: 'purchased', labelKey: 'ads.purchased' },
  { key: 'saleValue', labelKey: 'ads.value' },
]

export function AdsPanel({ window, canRead }: ReportPanelProps) {
  const t = useTranslations('Reports')
  const [sortKey, setSortKey] = useState<SortKey>('conversations')
  const [expanded, setExpanded] = useState<string | null>(null)

  const data = useQuery(
    api.reports.adPerformance,
    canRead ? { sinceMs: window.sinceMs } : 'skip',
  )

  // Sorting is purely client-side over what the server already truncated by
  // conversations descending — see `AD_ROW_LIMIT`'s comment. Re-sorting can
  // reorder these rows but can never surface an ad outside the returned set.
  const rows = useMemo(
    () => [...(data?.rows ?? [])].sort((a, b) => b[sortKey] - a[sortKey]),
    [data?.rows, sortKey],
  )

  if (data === undefined) return <Skeleton className="h-64 w-full rounded-xl" />

  const resolutionBacklog =
    data.resolution.pending + data.resolution.dormant + data.resolution.abandoned

  if (rows.length === 0) {
    return (
      <div className="rounded-xl border border-border bg-card p-8 text-center">
        <p className="text-sm text-muted-foreground">{t('empty')}</p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {resolutionBacklog > 0 && (
        <div className="rounded-lg border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
          {/* Unnamed ads are the resolver's state, not an error. Surfacing
              the counts explains WHY some rows show a bare id. */}
          {t('ads.resolutionBacklog', {
            pending: data.resolution.pending,
            dormant: data.resolution.dormant,
            abandoned: data.resolution.abandoned,
          })}
        </div>
      )}

      <div className="overflow-hidden rounded-xl border border-border bg-card">
        <div className="flex items-center justify-between gap-3 border-b border-border p-4">
          <h2 className="text-sm font-medium text-foreground">{t('ads.title')}</h2>
          <button
            type="button"
            className="rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground"
            onClick={() =>
              downloadCsv(
                'ads.csv',
                ['campaign', 'ad_set', 'ad', 'ad_id', 'conversations', 'leads', 'qualified', 'purchased', 'value', 'services'],
                rows.map((r) => [
                  r.campaignName, r.adSetName, r.adName, r.adId,
                  r.conversations, r.firstTouchLeads, r.qualified,
                  r.purchased, r.saleValue, r.serviceKeys.join(' | '),
                ]),
              )
            }
          >
            {t('exportCsv')}
          </button>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-xs text-muted-foreground">
                <th className="px-4 py-2 text-left font-medium">{t('ads.ad')}</th>
                {COLUMNS.map((col) => (
                  <th key={col.key} className="px-4 py-2 text-right font-medium">
                    <button
                      type="button"
                      onClick={() => setSortKey(col.key)}
                      className={cn(
                        'hover:text-foreground',
                        col.key === sortKey && 'text-foreground',
                      )}
                    >
                      {t(col.labelKey)}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const isOpen = expanded === row.adId
                return (
                  <>
                    <tr
                      key={row.adId}
                      onClick={() => setExpanded(isOpen ? null : row.adId)}
                      className="cursor-pointer border-b border-border last:border-0 hover:bg-muted/40"
                    >
                      <td className="px-4 py-2">
                        <div className="flex items-center gap-2">
                          <ChevronDown
                            className={cn(
                              'h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform',
                              isOpen && 'rotate-180',
                            )}
                          />
                          <div className="min-w-0">
                            {row.adName ? (
                              <p className="truncate text-foreground">{row.adName}</p>
                            ) : (
                              // The name has not resolved. Show the real id
                              // rather than a placeholder — an operator can
                              // look that up in Meta; "Unknown ad" helps
                              // nobody.
                              <p
                                className="truncate font-mono text-xs text-muted-foreground"
                                title={t('ads.unresolved')}
                              >
                                {row.adId}
                              </p>
                            )}
                            <p className="truncate text-xs text-muted-foreground">
                              {[row.campaignName, row.adSetName]
                                .filter(Boolean)
                                .join(' › ') || '—'}
                            </p>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums">{row.conversations}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{row.firstTouchLeads}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{row.qualified}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{row.purchased}</td>
                      <td className="px-4 py-2 text-right tabular-nums">
                        {formatCurrency(row.saleValue, data.currency)}
                      </td>
                    </tr>
                    {isOpen && (
                      <tr key={`${row.adId}-detail`} className="border-b border-border bg-muted/20">
                        <td colSpan={COLUMNS.length + 1} className="px-4 py-3">
                          {/* Built entirely from the row already fetched, so
                              expanding costs no additional read. */}
                          <div className="space-y-2">
                            {([
                              ['ads.conversations', row.conversations],
                              ['ads.qualified', row.qualified],
                              ['ads.purchased', row.purchased],
                            ] as const).map(([labelKey, count]) => (
                              <div key={labelKey} className="flex items-center gap-3">
                                <span className="w-28 shrink-0 text-xs text-muted-foreground">
                                  {t(labelKey)}
                                </span>
                                <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                                  <div
                                    className="h-full rounded-full bg-primary"
                                    style={{
                                      width: `${
                                        row.conversations === 0
                                          ? 0
                                          : (count / row.conversations) * 100
                                      }%`,
                                    }}
                                  />
                                </div>
                                <span className="w-8 shrink-0 text-right text-xs tabular-nums">
                                  {count}
                                </span>
                              </div>
                            ))}
                            <p className="pt-1 text-xs text-muted-foreground">
                              {t('ads.service')}:{' '}
                              {row.serviceKeys.length > 0 ? row.serviceKeys.join(', ') : '—'}
                            </p>
                          </div>
                        </td>
                      </tr>
                    )}
                  </>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      {data.truncated > 0 && (
        <p className="text-xs text-muted-foreground">
          {/* The table is capped server-side by conversations descending.
              Saying so is the difference between a top-100 view and one
              that silently implies it is exhaustive. */}
          {t('ads.truncated', { n: data.truncated })}
        </p>
      )}
    </div>
  )
}
```

React requires a `key` on each element of the fragment pair above; if the
`<>...</>` wrapper trips the lint rule, swap it for
`<Fragment key={row.adId}>` imported from `react`.

i18n keys to add:

```json
    "ads": {
      "title": "Ad performance",
      "campaign": "Campaign",
      "adSet": "Ad set",
      "ad": "Ad",
      "conversations": "Conversations",
      "leads": "Leads",
      "qualified": "Qualified",
      "purchased": "Purchased",
      "value": "Value",
      "service": "Service",
      "unresolved": "This ad's name has not been resolved from Meta yet.",
      "truncated": "Showing the top 100 ads by conversations. {n} more are not shown.",
      "resolutionBacklog": "Ad names still resolving: {pending} pending, {dormant} waiting on a Meta access token, {abandoned} gave up."
    },
```

- [ ] **Step 2: Verify in the browser**

```bash
npm run dev
```

Visit `/reports?tab=ads`. Confirm: rows appear with campaign/ad-set names where resolved and bare ids where not; clicking a column header re-sorts; clicking a row expands it; CSV matches the table. If the account has no ad referrals in the range, confirm the empty state renders rather than an empty table.

- [ ] **Step 3: Lint and commit**

```bash
npx eslint src/components/reports/ads-panel.tsx
git add src/components/reports/ads-panel.tsx messages/en.json
git commit -m "feat(reports): per-ad performance table

Surfaces the truncation count and the campaignAds resolver backlog rather
than presenting a capped table as complete.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 14: Response panel

**Files:**
- Modify: `src/components/reports/response-panel.tsx`

**Interfaces:**
- Consumes: `api.reports.responsePerformance`, `api.reports.awaitingReplyAges`, `downloadCsv`.

- [ ] **Step 1: Write the panel**

Replace `src/components/reports/response-panel.tsx`:

```tsx
'use client'

import { useState } from 'react'
import { useQuery } from '@/lib/convex/cached'
import { api } from '../../../convex/_generated/api'
import { useTranslations } from 'next-intl'
import {
  Bar, BarChart, CartesianGrid, Line, LineChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import { Clock, Target, Gauge, TrendingUp } from 'lucide-react'
import { MetricCard } from '@/components/dashboard/metric-card'
import { SkeletonCard } from '@/components/dashboard/skeleton'
import { downloadCsv } from '@/lib/reports/csv'
import { cn } from '@/lib/utils'
import type { ReportPanelProps } from '@/lib/reports/types'

const TARGETS = [1, 5, 15, 60] as const
type Target = (typeof TARGETS)[number]

const AXIS = { fontSize: 11, fill: 'hsl(var(--muted-foreground))' } as const
const TOOLTIP_STYLE = {
  background: 'hsl(var(--card))',
  border: '1px solid hsl(var(--border))',
  borderRadius: 8,
  fontSize: 12,
} as const

export function ResponsePanel({ window, canRead }: ReportPanelProps) {
  const t = useTranslations('Reports')
  // 5 minutes matches the existing hardcoded default in
  // `dashboard/response-performance.tsx`, so the two pages agree on day one.
  const [target, setTarget] = useState<Target>(5)

  const data = useQuery(
    api.reports.responsePerformance,
    canRead
      ? {
          sinceMs: window.sinceMs,
          keys: window.dayKeys,
          tzOffsetMinutes: window.tzOffsetMinutes,
          granularity: 'day' as const,
          targetMinutes: target,
        }
      : 'skip',
  )
  const backlog = useQuery(api.reports.awaitingReplyAges, canRead ? {} : 'skip')

  if (data === undefined) {
    return (
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => <SkeletonCard key={i} />)}
      </div>
    )
  }

  // `null` means NO SAMPLES, which is not the same as a zero-minute
  // average. Rendering 0 would claim instant replies on a range with no
  // data — never collapse these to `?? 0`.
  const fmtMinutes = (m: number | null) => (m === null ? '—' : `${m.toFixed(1)} min`)

  // A percentile is a bucket RANGE. The histogram knows how many replies
  // fell between 5 and 15 minutes but nothing about where inside it, so a
  // single number would be precision we do not have.
  const fmtPercentile = (
    p: { lowMinutes: number; highMinutes: number | null } | null,
  ) =>
    p === null
      ? '—'
      : p.highMinutes === null
        ? t('response.overMinutes', { n: p.lowMinutes })
        : t('response.betweenMinutes', { low: p.lowMinutes, high: p.highMinutes })

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard
          title={t('response.avg')}
          value={fmtMinutes(data.avgMinutes)}
          icon={Clock}
          subtitle={t('response.samples', { n: data.samples })}
        />
        <MetricCard
          title={t('response.withinTarget', { n: target })}
          value={
            data.withinTarget === null
              ? '—'
              : `${Math.round(data.withinTarget * 100)}%`
          }
          icon={Target}
        />
        <MetricCard title={t('response.p50')} value={fmtPercentile(data.p50)} icon={Gauge} />
        <MetricCard title={t('response.p90')} value={fmtPercentile(data.p90)} icon={TrendingUp} />
      </div>

      <div className="rounded-xl border border-border bg-card p-5">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-medium text-foreground">{t('response.trendTitle')}</h2>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">{t('response.target')}</span>
            <div className="flex gap-1 rounded-lg border border-border p-1">
              {TARGETS.map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => setTarget(option)}
                  className={cn(
                    'rounded-md px-2.5 py-1 text-xs transition-colors',
                    option === target
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {t('response.minutes', { n: option })}
                </button>
              ))}
            </div>
            <button
              type="button"
              className="rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground"
              onClick={() =>
                downloadCsv(
                  'response.csv',
                  ['period', 'avg_minutes', 'samples'],
                  data.series.map((p) => [p.key, p.avgMinutes ?? '', p.samples]),
                )
              }
            >
              {t('exportCsv')}
            </button>
          </div>
        </div>

        {data.samples === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">{t('empty')}</p>
        ) : (
          <ResponsiveContainer width="100%" height={240}>
            <LineChart data={data.series} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
              <XAxis dataKey="key" tick={AXIS} tickLine={false} axisLine={false} minTickGap={24} />
              <YAxis tick={AXIS} tickLine={false} axisLine={false} unit="m" />
              <Tooltip contentStyle={TOOLTIP_STYLE} />
              {/* `connectNulls={false}` on purpose: a day with no samples is
                  a GAP, and bridging it would draw a trend line through
                  data that does not exist. */}
              <Line
                type="monotone"
                dataKey="avgMinutes"
                name={t('response.avg')}
                stroke="hsl(var(--primary))"
                strokeWidth={2}
                dot={false}
                connectNulls={false}
              />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>

      <div className="rounded-xl border border-border bg-card p-5">
        <h2 className="mb-4 text-sm font-medium text-foreground">{t('response.hourTitle')}</h2>
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={data.byHourOfDay} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
            <XAxis dataKey="hour" tick={AXIS} tickLine={false} axisLine={false} interval={2} />
            <YAxis tick={AXIS} tickLine={false} axisLine={false} unit="m" />
            <Tooltip contentStyle={TOOLTIP_STYLE} />
            <Bar dataKey="avgMinutes" name={t('response.avg')} fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>

      {backlog && (
        <div className="rounded-xl border border-border bg-card p-5">
          <h2 className="mb-3 text-sm font-medium text-foreground">
            {t('response.backlogTitle')}
          </h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {(['under1h', 'h1to4', 'h4to24', 'over24h'] as const).map((k) => (
              <div key={k} className="rounded-lg border border-border bg-background p-3">
                <p className="text-xs text-muted-foreground">{t(`response.backlog.${k}`)}</p>
                <p className="mt-1 text-lg font-semibold tabular-nums text-foreground">
                  {backlog[k].toLocaleString()}
                </p>
              </div>
            ))}
          </div>
          {backlog.capped && (
            <p className="mt-3 text-xs text-muted-foreground">{t('response.backlogCapped')}</p>
          )}
        </div>
      )}
    </div>
  )
}
```

i18n keys:

```json
    "response": {
      "avg": "Average first reply",
      "withinTarget": "Within {n} min",
      "p50": "Median (p50)",
      "p90": "p90",
      "target": "Target",
      "minutes": "{n} min",
      "samples": "{n} replies measured",
      "trendTitle": "Average reply time",
      "hourTitle": "Average reply time by hour of day",
      "backlogTitle": "Still awaiting a reply",
      "backlogCapped": "Sampled the 500 oldest waiting threads; the real backlog is larger.",
      "betweenMinutes": "{low}–{high} min",
      "overMinutes": "Over {n} min",
      "backlog": {
        "under1h": "Under 1 hour",
        "h1to4": "1–4 hours",
        "h4to24": "4–24 hours",
        "over24h": "Over 24 hours"
      }
    },
```

- [ ] **Step 2: Verify in the browser**

```bash
npm run dev
```

Visit `/reports?tab=response`. Confirm: changing the target re-queries and the % changes; the percentile tiles show ranges like "5–15 min", never a single number; a range with no samples shows "—" rather than "0.0 min"; the backlog buckets sum to something plausible against the sidebar's unread badge.

- [ ] **Step 3: Lint and commit**

```bash
npx eslint src/components/reports/response-panel.tsx
git add src/components/reports/response-panel.tsx messages/en.json
git commit -m "feat(reports): response and SLA panel

Percentiles render as bucket ranges and empty ranges render as em-dash —
a zero would claim instant replies where there is simply no data.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 15: Funnel and billing panels

**Files:**
- Modify: `src/components/reports/funnel-panel.tsx`
- Modify: `src/components/reports/billing-panel.tsx`

**Interfaces:**
- Consumes: `api.reports.funnelOverview`, `api.reports.billing`, `UI_FUNNEL_STAGE_KEYS` from `@/lib/inbox/funnel`, `formatCurrency`, `downloadCsv`.

- [ ] **Step 1: Write the funnel panel**

Port `src/app/(dashboard)/campaigns/page.tsx`'s markup (as it was before Task 11's redirect — recover it with `git show HEAD~1:src/app/\(dashboard\)/campaigns/page.tsx`) into `funnel-panel.tsx`, with three changes:

1. Query `api.reports.funnelOverview` with `{ sinceMs: window.sinceMs }` instead of `api.campaigns.overview` with `{}`.
2. Drop the `window` days line — the shell's range picker now says it.
3. Label the purchase-value tile "Recorded value" and add the subtitle `t('funnel.recordedValueNote')`, because the figure includes organic purchases never reported to Meta:

```json
      "recordedValueNote": "Includes organic purchases that were never reported to Meta.",
```

Keep the Meta delivery-status tiles exactly as they are, including the seven-column desktop grid.

- [ ] **Step 2: Write the billing panel**

Replace `src/components/reports/billing-panel.tsx`:

```tsx
'use client'

import { useQuery } from '@/lib/convex/cached'
import { api } from '../../../convex/_generated/api'
import { useTranslations } from 'next-intl'
import {
  Bar, BarChart, CartesianGrid, Legend,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import { Receipt, Gift } from 'lucide-react'
import { MetricCard } from '@/components/dashboard/metric-card'
import { SkeletonCard } from '@/components/dashboard/skeleton'
import { downloadCsv } from '@/lib/reports/csv'
import type { ReportPanelProps } from '@/lib/reports/types'

const CATEGORIES = [
  'marketing', 'utility', 'service', 'authentication', 'free', 'other',
] as const

// Deliberately theme tokens with plain-color fallbacks rather than six
// hardcoded hexes, so the stack stays legible in both light and dark.
const CATEGORY_FILL: Record<(typeof CATEGORIES)[number], string> = {
  marketing: 'hsl(var(--chart-1, var(--primary)))',
  utility: 'hsl(var(--chart-2, var(--primary)))',
  service: 'hsl(var(--chart-3, var(--muted-foreground)))',
  authentication: 'hsl(var(--chart-4, var(--muted-foreground)))',
  free: 'hsl(var(--chart-5, var(--border)))',
  other: 'hsl(var(--muted-foreground))',
}

export function BillingPanel({ window, canRead }: ReportPanelProps) {
  const t = useTranslations('Reports')

  const data = useQuery(
    api.reports.billing,
    canRead
      ? {
          sinceMs: window.sinceMs,
          keys: window.dayKeys,
          tzOffsetMinutes: window.tzOffsetMinutes,
          granularity: 'day' as const,
        }
      : 'skip',
  )

  if (data === undefined) {
    return (
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <SkeletonCard />
        <SkeletonCard />
      </div>
    )
  }

  const categoryTotal = CATEGORIES.reduce(
    (sum, key) => sum + data.totals.categories[key],
    0,
  )
  const isEmpty = data.totals.billableConversations === 0 && categoryTotal === 0

  // Flatten `categories` up one level so recharts can address each as a
  // dataKey.
  const chartData = data.series.map((p) => ({ key: p.key, ...p.categories }))

  return (
    <div className="space-y-5">
      {/* Not decoration. Meta's webhooks carry billing CATEGORIES and
          COUNTS, never rate-card amounts, so this panel must never be read
          as spend. Saying it in-product is the only way that survives
          someone screenshotting a tile. */}
      <p className="rounded-lg border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
        {t('billing.note')}
      </p>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <MetricCard
          title={t('billing.billableConversations')}
          value={data.totals.billableConversations.toLocaleString()}
          icon={Receipt}
        />
        <MetricCard
          title={t('billing.freeEntryPoint')}
          value={data.totals.freeEntryPointConversations.toLocaleString()}
          icon={Gift}
        />
      </div>

      <div className="rounded-xl border border-border bg-card p-5">
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="text-sm font-medium text-foreground">
            {t('billing.categoriesTitle')}
          </h2>
          <button
            type="button"
            className="rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground"
            onClick={() =>
              downloadCsv(
                'billing.csv',
                ['period', 'billable_conversations', 'free_entry_point', ...CATEGORIES],
                data.series.map((p) => [
                  p.key,
                  p.billableConversations,
                  p.freeEntryPointConversations,
                  ...CATEGORIES.map((c) => p.categories[c]),
                ]),
              )
            }
          >
            {t('exportCsv')}
          </button>
        </div>

        {isEmpty ? (
          <div className="space-y-2 py-8 text-center">
            <p className="text-sm text-muted-foreground">{t('empty')}</p>
            {/* The billing counters are forward-only by design — there is no
                backfill (see the plan's Task 5). An empty older range means
                "not collected", not "nothing happened", and the panel must
                not let those two read the same. */}
            <p className="text-xs text-muted-foreground">{t('billing.backfillNote')}</p>
          </div>
        ) : (
          <>
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                <XAxis
                  dataKey="key"
                  tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
                  tickLine={false}
                  axisLine={false}
                  minTickGap={24}
                />
                <YAxis
                  tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
                  tickLine={false}
                  axisLine={false}
                  allowDecimals={false}
                />
                <Tooltip
                  contentStyle={{
                    background: 'hsl(var(--card))',
                    border: '1px solid hsl(var(--border))',
                    borderRadius: 8,
                    fontSize: 12,
                  }}
                />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                {CATEGORIES.map((key, i) => (
                  <Bar
                    key={key}
                    stackId="categories"
                    dataKey={key}
                    name={t(`billing.category.${key}`)}
                    fill={CATEGORY_FILL[key]}
                    radius={i === CATEGORIES.length - 1 ? [4, 4, 0, 0] : undefined}
                  />
                ))}
              </BarChart>
            </ResponsiveContainer>

            <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
              {CATEGORIES.map((key) => (
                <div key={key} className="rounded-lg border border-border bg-background p-3">
                  <p className="text-xs text-muted-foreground">
                    {t(`billing.category.${key}`)}
                  </p>
                  <p className="mt-1 text-lg font-semibold tabular-nums text-foreground">
                    {data.totals.categories[key].toLocaleString()}
                  </p>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
```

The copy below is the constraint the spec requires, stated in the product:

```json
    "billing": {
      "title": "Meta billing",
      "note": "Meta reports billing categories and counts, not amounts. These are message and conversation volumes, not spend.",
      "billableConversations": "Billable conversations",
      "freeEntryPoint": "Free entry point (from ads)",
      "categoriesTitle": "Messages by billing category",
      "backfillNote": "Billing figures start from when this report shipped; earlier periods show zero.",
      "category": {
        "marketing": "Marketing",
        "utility": "Utility",
        "service": "Service",
        "authentication": "Authentication",
        "free": "Free",
        "other": "Other"
      }
    }
```

Render `backfillNote` whenever the range's totals are all zero — the billing counters are forward-only by design (Task 5), so an empty older range means "not collected", not "nothing happened", and the panel must not let those read the same.

- [ ] **Step 3: Verify in the browser**

```bash
npm run dev
```

Visit `/reports?tab=funnel` and `/reports?tab=billing`. Confirm the funnel bars match what `/campaigns` used to show for a 90-day range, the billing note is visible, and the backfill note appears on a range with no billing data.

- [ ] **Step 4: Run the full suite and commit**

Run: `npm test && npx tsc --noEmit`
Expected: PASS, no type errors.

```bash
npx eslint src/components/reports/funnel-panel.tsx src/components/reports/billing-panel.tsx
git add src/components/reports/funnel-panel.tsx src/components/reports/billing-panel.tsx messages/en.json
git commit -m "feat(reports): funnel and Meta billing panels

The billing panel states in-product that Meta reports categories and
counts, not amounts — these are volumes, not spend.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Handoff to the owner

After Task 15, the branch is complete but **not deployed**. The remaining steps are the owner's, in this order:

1. Review and merge.
2. Run codegen and deploy the schema + write paths.
3. Trigger the backfills, one chain at a time, and let each finish before starting the next:
   ```
   npx convex run messages:backfillConversationStartedStats
   npx convex run messages:backfillResponseBuckets
   ```
   These are **not** concurrency-safe — overlapping runs of the same chain will each SET the same buckets from partial views.
4. Verify `/reports` against known figures before announcing it.

Billing counters are forward-only and have no backfill, so the billing panel is correct from deploy day onward and shows zeros before it. The panel says so.
