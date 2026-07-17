# WA Funnel Conversions — Phase 0: Foundation (ad-capture layer) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the durable Click-to-WhatsApp capture layer on `main` — persist every inbound ad referral's `ctwa_clid` in an `adReferrals` table and resolve each ad id to its campaign/ad-set names in a `campaignAds` cache — so later phases have a reliable per-conversation ad-click identifier and campaign names.

**Architecture:** `main` already parses and threads `ctwaClid` + the full `referral` end-to-end (`webhookParse.flattenInboundMessage` → `inboundMessageValidator` → `ingest.processInbound`) for its ad-inbox *display* feature — so this phase adds **no** parser or validator changes. It adds two tables and two internal modules ported from the `feat/ctwa-capi-measurement` worktree, wires a best-effort capture step into `processInbound`, and adds a retry cron. It deliberately **omits** the worktree's single-event `capiEvents` outbox — Phase 1's unified `conversionEvents` replaces it.

**Tech Stack:** Convex (self-hosted), TypeScript, `convex-test` + Vitest, Meta Marketing Graph API v25.0.

## Global Constraints

- **Offline codegen only.** Never run `convex dev` / `convex deploy` / `convex codegen` — they push the one live self-hosted deployment (`convex-api.holidayys.co`). A **new table** needs `convex/schema.ts` **only** (the `_generated/dataModel` types derive from the schema via generics). A **new module** needs a 2-line hand-edit of `convex/_generated/api.d.ts` (an `import type` line + a member line); `api.js` is a runtime Proxy and needs no edit.
- **File style.** Convex files are double-quoted. Do **NOT** run `prettier --write` broadly (it reformats whole files). Match each file's existing style. Verify with `npm run test` + `npx tsc --noEmit`, not prettier.
- **Dormant by default.** `resolveAd` is a no-op without `META_ADS_ACCESS_TOKEN` (leaves rows `pending`; the retry cron picks them up once a token exists). Nothing calls Meta in tests (no token set).
- **Graph API version:** `process.env.META_GRAPH_VERSION || "v25.0"`.
- **TDD, frequent commits.** One deliverable per task; test-first.
- **Test harness:** every convex test uses `const t = convexTest(schema, modules)` with `const modules = import.meta.glob("/convex/**/*.ts")`; new modules are auto-discovered.

---

## File Structure

- **Create** `convex/campaignAds.ts` — ad→campaign/ad-set name resolution cache: `getById`, `patchResolution`, `resolveAd` (Marketing API), `getResolvable`, `retryResolutions`.
- **Create** `convex/campaignAds.test.ts` — resolveAd dormant/resolve/error + getResolvable.
- **Create** `convex/adReferrals.ts` — `recordAdReferral` (raw referral log + first-touch + seeds a `campaignAds` row). **No** `capiEvents` firing.
- **Create** `convex/adReferrals.test.ts` — recordAdReferral row + first-touch + campaignAds seed.
- **Modify** `convex/schema.ts` — add `adReferrals` + `campaignAds` tables.
- **Modify** `convex/_generated/api.d.ts` — register `adReferrals` + `campaignAds`.
- **Modify** `convex/crons.ts` — add the `retry-ad-resolution` interval.
- **Modify** `convex/ingest.ts` — add a best-effort `recordAdReferral` capture step in `processInbound`.
- **Modify** `convex/ingest.test.ts` — assert the capture step records an `adReferrals` row.

---

### Task 1: Schema — `adReferrals` + `campaignAds` tables

**Files:**
- Modify: `convex/schema.ts` (add two tables inside the top-level `defineSchema({ ... })` object, next to the existing `attributionSignals` table)

**Interfaces:**
- Produces: tables `adReferrals` and `campaignAds`, giving `Doc<"adReferrals">`, `Id<"adReferrals">`, `Doc<"campaignAds">`, `Id<"campaignAds">` (derived from the schema by tsc). No module functions yet.

- [ ] **Step 1: Add the two tables**

In `convex/schema.ts`, immediately after the `attributionSignals` table definition (it ends around line 1146 with its `.index(...)` chain), add:

```ts
  // ============================================================
  // CTWA ad-capture (funnel Phase 0). Raw event log: one row per
  // inbound message carrying a `referral`. `_creationTime` is the
  // received-at (codebase "rely on _creationTime" convention).
  // `ctwaClid` is the durable per-conversation ad-click id the funnel's
  // ad lane reads later. Distinct from the `conversation.adReferral`
  // display denorm (set once, for the inbox ad-preview card).
  // ============================================================
  adReferrals: defineTable({
    accountId: v.id("accounts"),
    contactId: v.id("contacts"),
    conversationId: v.id("conversations"),
    waMessageId: v.string(),
    ctwaClid: v.optional(v.string()), // omitted for Status placements
    adId: v.optional(v.string()), // referral.source_id = Meta ad id
    sourceType: v.optional(v.string()), // "ad" — resolution guards on this
    sourceUrl: v.optional(v.string()),
    headline: v.optional(v.string()),
    body: v.optional(v.string()),
    mediaType: v.optional(v.string()),
    isFirstTouch: v.boolean(), // contact's first-ever ad referral
  })
    .index("by_account", ["accountId"])
    .index("by_account_ad", ["accountId", "adId"])
    .index("by_contact", ["contactId"])
    .index("by_wamid", ["waMessageId"]),

  // Resolution cache: one row per (account, adId). Names change rarely.
  // Written `pending` at capture; resolved via Marketing API in `resolveAd`.
  campaignAds: defineTable({
    accountId: v.id("accounts"),
    adId: v.string(),
    adName: v.optional(v.string()),
    adSetId: v.optional(v.string()),
    adSetName: v.optional(v.string()),
    campaignId: v.optional(v.string()),
    campaignName: v.optional(v.string()),
    resolveStatus: v.union(
      v.literal("pending"),
      v.literal("resolved"),
      v.literal("error"),
    ),
    attempts: v.number(),
    lastError: v.optional(v.string()),
    resolvedAt: v.optional(v.number()),
  })
    .index("by_account_ad", ["accountId", "adId"])
    .index("by_account", ["accountId"])
    .index("by_status", ["resolveStatus"]),
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS (no errors). The new `Doc`/`Id` types now resolve.

- [ ] **Step 3: Commit**

```bash
git add convex/schema.ts
git commit -m "feat(funnel): add adReferrals + campaignAds tables (Phase 0)"
```

---

### Task 2: `campaignAds` module + retry cron

**Files:**
- Create: `convex/campaignAds.ts`
- Create: `convex/campaignAds.test.ts`
- Modify: `convex/_generated/api.d.ts`
- Modify: `convex/crons.ts`

**Interfaces:**
- Consumes: `campaignAds` table (Task 1).
- Produces: `internal.campaignAds.getById`, `.patchResolution`, `.resolveAd({ campaignAdId })`, `.getResolvable`, `.retryResolutions`; const `MAX_RESOLVE_ATTEMPTS = 5`. `resolveAd` is dormant without `META_ADS_ACCESS_TOKEN`.

- [ ] **Step 1: Write the failing test** — create `convex/campaignAds.test.ts`:

```ts
import { convexTest } from "convex-test";
import { expect, test, beforeEach, afterEach } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";

const modules = import.meta.glob("/convex/**/*.ts");

async function seedAccount(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {
      name: "Acme",
      email: "acme@example.com",
    });
    return await ctx.db.insert("accounts", {
      name: "Acme's account",
      defaultCurrency: "USD",
      ownerUserId: userId,
    });
  });
}

async function seedAd(
  t: ReturnType<typeof convexTest>,
  accountId: Id<"accounts">,
  attempts = 0,
  resolveStatus: "pending" | "error" = "pending",
) {
  return await t.run((ctx) =>
    ctx.db.insert("campaignAds", {
      accountId,
      adId: "AD1",
      resolveStatus,
      attempts,
    }),
  );
}

const origToken = process.env.META_ADS_ACCESS_TOKEN;
const origFetch = globalThis.fetch;
afterEach(() => {
  if (origToken === undefined) delete process.env.META_ADS_ACCESS_TOKEN;
  else process.env.META_ADS_ACCESS_TOKEN = origToken;
  globalThis.fetch = origFetch;
});

test("resolveAd is dormant without META_ADS_ACCESS_TOKEN (leaves pending, no attempt bump)", async () => {
  delete process.env.META_ADS_ACCESS_TOKEN;
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t);
  const adId = await seedAd(t, accountId);

  await t.action(internal.campaignAds.resolveAd, { campaignAdId: adId });

  const row = await t.run((ctx) => ctx.db.get(adId));
  expect(row?.resolveStatus).toBe("pending");
  expect(row?.attempts).toBe(0);
});

test("resolveAd resolves ad/adset/campaign names on a 200", async () => {
  process.env.META_ADS_ACCESS_TOKEN = "tok";
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        name: "Maldives Ad",
        adset: { id: "AS1", name: "Maldives AdSet" },
        campaign: { id: "C1", name: "Summer" },
      }),
      { status: 200 },
    )) as typeof fetch;
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t);
  const adId = await seedAd(t, accountId);

  await t.action(internal.campaignAds.resolveAd, { campaignAdId: adId });

  const row = await t.run((ctx) => ctx.db.get(adId));
  expect(row?.resolveStatus).toBe("resolved");
  expect(row?.adName).toBe("Maldives Ad");
  expect(row?.campaignName).toBe("Summer");
  expect(row?.resolvedAt).toBeGreaterThan(0);
});

test("resolveAd records error + bumps attempts on a non-200", async () => {
  process.env.META_ADS_ACCESS_TOKEN = "tok";
  globalThis.fetch = (async () =>
    new Response("nope", { status: 400 })) as typeof fetch;
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t);
  const adId = await seedAd(t, accountId);

  await t.action(internal.campaignAds.resolveAd, { campaignAdId: adId });

  const row = await t.run((ctx) => ctx.db.get(adId));
  expect(row?.resolveStatus).toBe("error");
  expect(row?.attempts).toBe(1);
});

test("getResolvable returns pending + error rows under MAX_RESOLVE_ATTEMPTS", async () => {
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t);
  await seedAd(t, accountId, 0, "pending");
  await seedAd(t, accountId, 5, "error"); // at cap — excluded

  const rows = await t.run(() =>
    t.query(internal.campaignAds.getResolvable, {}),
  );
  expect(rows).toHaveLength(1);
  expect(rows[0].resolveStatus).toBe("pending");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -- campaignAds`
Expected: FAIL — module `./campaignAds` not found (`internal.campaignAds` is undefined).

- [ ] **Step 3: Create the module** — create `convex/campaignAds.ts`:

```ts
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
```

- [ ] **Step 4: Register the module** — in `convex/_generated/api.d.ts`, add the import next to the other `import type * as ...` lines (alphabetical, near `attribution`):

```ts
import type * as campaignAds from "../campaignAds.js";
```

and add the member inside the `fullApiWithMounts` / `FullApi` object next to `attribution`:

```ts
  campaignAds: typeof campaignAds;
```

- [ ] **Step 5: Add the retry cron** — in `convex/crons.ts`, after the existing `retry-attribution-signals` block and before `export default crons;`, add:

```ts
// Retry CTWA ad->campaign name resolution (campaignAds pending/error with
// attempts < MAX). Also nudges dormant `pending` rows once a
// META_ADS_ACCESS_TOKEN is finally configured. Bounded, best-effort.
crons.interval(
  "retry-ad-resolution",
  { minutes: 60 },
  internal.campaignAds.retryResolutions,
  {},
);
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm run test -- campaignAds`
Expected: PASS (4 tests).

- [ ] **Step 7: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add convex/campaignAds.ts convex/campaignAds.test.ts convex/_generated/api.d.ts convex/crons.ts
git commit -m "feat(funnel): campaignAds ad->campaign resolution + retry cron (Phase 0)"
```

---

### Task 3: `adReferrals` module — `recordAdReferral`

**Files:**
- Create: `convex/adReferrals.ts`
- Create: `convex/adReferrals.test.ts`
- Modify: `convex/_generated/api.d.ts`

**Interfaces:**
- Consumes: `adReferrals` + `campaignAds` tables (Task 1); `internal.campaignAds.resolveAd` (Task 2).
- Produces: `internal.adReferrals.recordAdReferral(args)` where
  `args = { accountId: Id<"accounts">, contactId: Id<"contacts">, conversationId: Id<"conversations">, waMessageId: string, ctwaClid?: string, referral: AdReferralInput }`
  and `AdReferralInput` is main's `AdReferral` shape (see validator below).
  Returns `{ adReferralId, isFirstTouch, adId?, ctwaClid?, needsResolve }`.
  **NB:** this Phase-0 version does **not** create any `capiEvents`/conversion rows — Phase 1 owns first-touch firing.

- [ ] **Step 1: Write the failing test** — create `convex/adReferrals.test.ts`:

```ts
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";

const modules = import.meta.glob("/convex/**/*.ts");

async function seedAccount(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {
      name: "Acme",
      email: "acme@example.com",
    });
    return await ctx.db.insert("accounts", {
      name: "Acme's account",
      defaultCurrency: "USD",
      ownerUserId: userId,
    });
  });
}

async function seedContactAndConversation(
  t: ReturnType<typeof convexTest>,
  accountId: Id<"accounts">,
) {
  return await t.run(async (ctx) => {
    const contactId = await ctx.db.insert("contacts", {
      accountId,
      phone: "+15551230000",
      phoneNormalized: "15551230000",
    });
    const conversationId = await ctx.db.insert("conversations", {
      accountId,
      contactId,
      status: "open",
      unreadCount: 0,
    });
    return { contactId, conversationId };
  });
}

test("recordAdReferral logs the referral, marks first-touch, and seeds a pending campaignAds row", async () => {
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t);
  const { contactId, conversationId } = await seedContactAndConversation(
    t,
    accountId,
  );

  const res = await t.mutation(internal.adReferrals.recordAdReferral, {
    accountId,
    contactId,
    conversationId,
    waMessageId: "wamid.AD1",
    ctwaClid: "clid-1",
    referral: { sourceType: "ad", sourceId: "AD1", headline: "Maldives" },
  });

  expect(res.isFirstTouch).toBe(true);
  expect(res.adId).toBe("AD1");
  expect(res.ctwaClid).toBe("clid-1");
  expect(res.needsResolve).toBe(true);

  const rows = await t.run((ctx) =>
    ctx.db
      .query("adReferrals")
      .withIndex("by_account", (q) => q.eq("accountId", accountId))
      .collect(),
  );
  expect(rows).toHaveLength(1);
  expect(rows[0].isFirstTouch).toBe(true);
  expect(rows[0].ctwaClid).toBe("clid-1");
  expect(rows[0].headline).toBe("Maldives");

  const ads = await t.run((ctx) =>
    ctx.db
      .query("campaignAds")
      .withIndex("by_account_ad", (q) =>
        q.eq("accountId", accountId).eq("adId", "AD1"),
      )
      .collect(),
  );
  expect(ads).toHaveLength(1);
  expect(ads[0].resolveStatus).toBe("pending");
});

test("recordAdReferral marks isFirstTouch=false for a contact's second referral and does not re-seed the ad", async () => {
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t);
  const { contactId, conversationId } = await seedContactAndConversation(
    t,
    accountId,
  );

  const first = await t.mutation(internal.adReferrals.recordAdReferral, {
    accountId,
    contactId,
    conversationId,
    waMessageId: "wamid.AD1",
    ctwaClid: "clid-1",
    referral: { sourceType: "ad", sourceId: "AD1" },
  });
  expect(first.isFirstTouch).toBe(true);

  const second = await t.mutation(internal.adReferrals.recordAdReferral, {
    accountId,
    contactId,
    conversationId,
    waMessageId: "wamid.AD2",
    ctwaClid: "clid-2",
    referral: { sourceType: "ad", sourceId: "AD1" },
  });
  expect(second.isFirstTouch).toBe(false);
  expect(second.needsResolve).toBe(false); // AD1 already cached

  const ads = await t.run((ctx) =>
    ctx.db
      .query("campaignAds")
      .withIndex("by_account_ad", (q) =>
        q.eq("accountId", accountId).eq("adId", "AD1"),
      )
      .collect(),
  );
  expect(ads).toHaveLength(1);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -- adReferrals`
Expected: FAIL — `internal.adReferrals` is undefined (module missing).

- [ ] **Step 3: Create the module** — create `convex/adReferrals.ts`:

```ts
import { internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";

// Referral sub-object, in main's camelCase `AdReferral` shape (see
// `webhookParse.ts`'s `AdReferral` + `ingest.ts`'s `inboundMessageValidator`).
// Exported so `ingest.ts` imports one source of truth. Display-only fields
// (imageUrl/videoUrl/thumbnailUrl) are accepted but not persisted here — the
// image lives on the `conversation.adReferral` denorm, not this raw log.
export const adReferralInputValidator = v.object({
  sourceType: v.optional(v.union(v.literal("ad"), v.literal("post"))),
  sourceId: v.optional(v.string()),
  sourceUrl: v.optional(v.string()),
  headline: v.optional(v.string()),
  body: v.optional(v.string()),
  mediaType: v.optional(v.union(v.literal("image"), v.literal("video"))),
  imageUrl: v.optional(v.string()),
  videoUrl: v.optional(v.string()),
  thumbnailUrl: v.optional(v.string()),
});

/**
 * Records one inbound ad-referral (raw event log) and, for a genuine ad
 * (`sourceType === "ad"` with a `sourceId`), ensures a single `pending`
 * `campaignAds` cache row for later name resolution.
 * `isFirstTouch` = this contact has no prior `adReferrals`. Message-level
 * idempotency is the caller's concern (`processInbound` skips webhook
 * retries); this mutation additionally no-ops a duplicate `campaignAds`
 * insert. Phase 0 does NOT fire any conversion event — Phase 1 owns that.
 */
export const recordAdReferral = internalMutation({
  args: {
    accountId: v.id("accounts"),
    contactId: v.id("contacts"),
    conversationId: v.id("conversations"),
    waMessageId: v.string(),
    ctwaClid: v.optional(v.string()),
    referral: adReferralInputValidator,
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    adReferralId: Id<"adReferrals">;
    isFirstTouch: boolean;
    adId?: string;
    ctwaClid?: string;
    needsResolve: boolean;
  }> => {
    const { accountId, contactId, conversationId, waMessageId, ctwaClid, referral } =
      args;
    const adId = referral.sourceId;

    const prior = await ctx.db
      .query("adReferrals")
      .withIndex("by_contact", (q) => q.eq("contactId", contactId))
      .first();
    const isFirstTouch = prior === null;

    let needsResolve = false;
    if (referral.sourceType === "ad" && adId) {
      const existing = await ctx.db
        .query("campaignAds")
        .withIndex("by_account_ad", (q) =>
          q.eq("accountId", accountId).eq("adId", adId),
        )
        .first();
      if (!existing) {
        const campaignAdId = await ctx.db.insert("campaignAds", {
          accountId,
          adId,
          resolveStatus: "pending",
          attempts: 0,
        });
        // resolveAd is dormant without META_ADS_ACCESS_TOKEN — safe no-op.
        await ctx.scheduler.runAfter(0, internal.campaignAds.resolveAd, {
          campaignAdId,
        });
        needsResolve = true;
      }
    }

    const adReferralId = await ctx.db.insert("adReferrals", {
      accountId,
      contactId,
      conversationId,
      waMessageId,
      ctwaClid,
      adId,
      sourceType: referral.sourceType,
      sourceUrl: referral.sourceUrl,
      headline: referral.headline,
      body: referral.body,
      mediaType: referral.mediaType,
      isFirstTouch,
    });

    return { adReferralId, isFirstTouch, adId, ctwaClid, needsResolve };
  },
});
```

- [ ] **Step 4: Register the module** — in `convex/_generated/api.d.ts`, add:

```ts
import type * as adReferrals from "../adReferrals.js";
```

and the member (place it before `campaignAds`, alphabetical):

```ts
  adReferrals: typeof adReferrals;
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm run test -- adReferrals`
Expected: PASS (2 tests).

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add convex/adReferrals.ts convex/adReferrals.test.ts convex/_generated/api.d.ts
git commit -m "feat(funnel): recordAdReferral captures ctwa_clid + first-touch (Phase 0)"
```

---

### Task 4: Wire `recordAdReferral` into `ingest.processInbound`

**Files:**
- Modify: `convex/ingest.ts` (add a best-effort step in `processInbound`, after the existing attribution step ~line 709)
- Modify: `convex/ingest.test.ts` (add one test near the existing attribution tests)

**Interfaces:**
- Consumes: `internal.adReferrals.recordAdReferral` (Task 3); the `message.referral` + `message.ctwaClid` already on `processInbound`'s inbound message; `res.contactId` / `res.conversationId` (existing).

- [ ] **Step 1: Write the failing test** — in `convex/ingest.test.ts`, add near the existing `"processInbound records a ctwa-lane attribution signal..."` test:

```ts
test("processInbound captures an adReferrals row from an inbound ad referral", async () => {
  process.env.CONVEX_META_DRY_RUN = "1";
  process.env.CONVEX_AI_DRY_RUN = "1";
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Acme");
  await seedAiConfig(t, accountId);
  await seedWebhookEndpoint(t, { accountId, events: ["message.received"] });

  await t.action(internal.ingest.processInbound, {
    accountId,
    from: "15551234567",
    message: {
      type: "text",
      text: "hi",
      wamid: "wamid.AD1",
      ctwaClid: "clid-xyz789",
      referral: { sourceType: "ad", sourceId: "AD1", headline: "Maldives" },
    },
  });

  const rows = await t.run((ctx) =>
    ctx.db
      .query("adReferrals")
      .withIndex("by_account", (q) => q.eq("accountId", accountId))
      .collect(),
  );
  expect(rows).toHaveLength(1);
  expect(rows[0].ctwaClid).toBe("clid-xyz789");
  expect(rows[0].adId).toBe("AD1");
  expect(rows[0].isFirstTouch).toBe(true);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -- ingest`
Expected: FAIL — no `adReferrals` row (the capture step doesn't exist yet).

- [ ] **Step 3: Add the capture step** — in `convex/ingest.ts`, inside `processInbound`, immediately AFTER the attribution `runBestEffort("attribution.signal", ...)` block (ends ~line 709) and BEFORE `return { duplicate: false, flowConsumed };`, add:

```ts
    // ---- CTWA ad-referral capture (adReferrals + campaignAds) — OUTSIDE
    // every guard above, best-effort like the attribution signal. Records
    // the raw referral + first-touch and seeds ad->campaign resolution. The
    // `ctwa_clid` it persists is the durable per-conversation source the
    // funnel's ad lane reads later. Separate from the `conversation.adReferral`
    // display denorm written in `ingestInbound`. Never blocks the pipeline.
    if (message.referral || message.ctwaClid) {
      await runBestEffort("campaigns.recordAdReferral", () =>
        ctx.runMutation(internal.adReferrals.recordAdReferral, {
          accountId,
          contactId: res.contactId,
          conversationId: res.conversationId,
          waMessageId: message.wamid,
          ctwaClid: message.ctwaClid,
          referral: message.referral ?? {},
        }),
      );
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test -- ingest`
Expected: PASS (the new test plus all existing ingest tests).

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add convex/ingest.ts convex/ingest.test.ts
git commit -m "feat(funnel): capture adReferrals at ingest (Phase 0)"
```

---

### Task 5: Phase verification

**Files:** none (verification only).

- [ ] **Step 1: Full test suite**

Run: `npm run test`
Expected: PASS — all pre-existing tests plus the new `campaignAds` (4), `adReferrals` (2), and `ingest` capture test.

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Production build**

Run: `npm run build`
Expected: PASS (Next.js build succeeds; no route/type regressions).

- [ ] **Step 4: Confirm dormancy & no-prod-push**

Confirm by inspection: no `convex dev`/`deploy`/`codegen` was run; `resolveAd` calls Meta only when `META_ADS_ACCESS_TOKEN` is set (unset in CI/tests). `git log --oneline` shows the five Phase-0 commits.

---

## Self-Review

**Spec coverage (Phase 0 scope from §12):**
- "unify `webhookParse` so one parse feeds both the display summary and the `ctwa_clid`" → **already true on `main`** (verified: `flattenInboundMessage` + `inboundMessageValidator` thread both). No change needed; documented in Architecture.
- "land `adReferrals` (clid capture)" → Task 1 (table) + Task 3 (`recordAdReferral`) + Task 4 (ingest wiring). ✓
- "land `campaignAds` (ad→campaign resolution) + their retry cron" → Task 1 (table) + Task 2 (module + cron). ✓
- "Do not land the worktree's single-event `capiEvents`/Campaigns query" → no `capiEvents` table/module in this plan; `recordAdReferral` explicitly omits the capiEvents block (called out in Task 3 interfaces + docstring). ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code; every test step shows the assertion and the exact `npm run test -- <pattern>` command with expected pass/fail.

**Type consistency:** `recordAdReferral` returns `{ adReferralId, isFirstTouch, adId?, ctwaClid?, needsResolve }` — matched by the Task 3 assertions (`res.isFirstTouch`, `res.adId`, `res.needsResolve`). `resolveAd({ campaignAdId })`, `getResolvable`, `retryResolutions` names match Task 2 module + the cron entry (`internal.campaignAds.retryResolutions`) + `recordAdReferral`'s `internal.campaignAds.resolveAd` schedule call. `adReferralInputValidator` fields (main's `AdReferral`) accept the `referral` objects passed in every test and by the ingest step (`message.referral ?? {}`).

**Notes for the executor:** register modules in `api.d.ts` **before** running tsc in that task (tests import `internal.*`); keep `campaignAds` registered before `adReferrals`'s own scheduling reference resolves — both are registered by end of Task 3, and Task 2 (campaignAds) precedes Task 3 (adReferrals) so the `internal.campaignAds.resolveAd` reference in `recordAdReferral` type-checks.
