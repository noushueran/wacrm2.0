# R2 Media Storage — Backfill & VPS Reclaim Implementation Plan (Plan 2 of 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move every *existing* media object from Convex file storage on the VPS into Cloudflare R2, rewrite the rows that reference them, then purge Convex storage and reclaim the VPS disk.

**Architecture:** Row-driven, not object-driven — the rows are what must be rewritten, and unreferenced objects are swept at the end. A paced internal action walks each table by `.paginate()` cursor, fetches each legacy object's bytes from its still-public Convex URL, PUTs them to R2 under a freshly-minted key, and patches the key field. Purging is gated on a status query reporting zero unmigrated rows.

**Tech Stack:** Convex (self-hosted), Next.js 16, TypeScript, Vitest + convex-test, `aws4fetch`.

**Spec:** `docs/superpowers/specs/2026-07-19-cloudflare-r2-media-storage-design.md`
**Prerequisite:** Plan 1 (`2026-07-19-r2-media-write-path.md`) merged, deployed, and **live-verified** (its Task 8). Do not start this plan against an unverified Plan 1 — the backfill assumes new writes already land in R2.

## ⚠️ How to read this plan's code

Plan 1's code blocks contained a real defect in **every one of its seven tasks** — a wrong basename comparison, a server/client trailing-slash divergence, an unsigned `Content-Type`, a field on a table that has no such field, a read-site list that was half complete, and a cross-tenant hole. All were caught by review, but the lesson stands:

**Treat every code block here as a draft to verify, not as text to transcribe.** Where this plan and the actual code disagree, the code wins — say so in your report. The *contracts* and *test cases* in this plan are the load-bearing parts; the implementations are a starting point.

## Global Constraints

- 🚨 **NEVER run `npx convex dev`, `npx convex deploy`, or `npx convex codegen`.** There is exactly ONE self-hosted Convex instance (`convex-api.holidayys.co`) and it is **production** — all three push straight to it. All work is built and tested **offline**; `convex-test` needs no deployment. Deploying is an owner action.
- 🚨 **`.filter()` must never be used to find work, and a short batch must never mean "done".** `convex/automations.ts:512-523` documents why: a `.filter()` that matched nothing returns short while rows remain, and the sweep stops early leaving orphans forever. Use `.paginate()` and terminate on its `isDone`, skipping already-migrated rows in JS.
- **Only migrate URLs that are actually Convex storage URLs** (`…/api/storage/<id>`). `messageTemplates.headerMediaUrl` can hold a **user-typed external URL** (`src/components/settings/template-manager.tsx:231`), and post-Plan-1 outbound rows already hold `objs.holidayys.co` URLs. Re-hosting either would be wrong.
- **Idempotent:** a row that already has a key is skipped. Re-running the backfill must be a no-op.
- **Best-effort per row:** one object that will not fetch must not abort the sweep. Record the failure and continue.
- **Object key format is `{accountId}/{kind}/{uuid}.{ext}`**, `kind` ∈ `inbound | outbound | template | flow | avatar | ad`. Use `buildMediaKey` from `convex/lib/r2/keys.ts` — do not hand-roll.
- `convex-test` **cannot emulate `ctx.db.system`** (`convex/cronSchedules.ts:262`). Anything reading `_storage` must follow the established thin-query-shell + pure-transform pattern (`convex/lib/cronSummary.ts`) so the logic is testable.
- **New Convex *function module* ⇒ hand-edit `convex/_generated/api.d.ts`** (import line + member); `api.js` is a Proxy and needs no edit. **This plan adds a new module (`convex/r2Backfill.ts`), so this edit IS required.**
- **Stage files explicitly by path. NEVER `git add -A` or `git add .`** — untracked `.claude/worktrees/*` directories from other sessions appear in `git status`.
- Use the **Grep/Glob tools, not `grep -r` in bash** — ~23 sibling worktrees return every hit once per worktree.
- **Verification commands** (from the worktree root): `npm test`, `npm run typecheck`, `npm run build`, `npm run lint`. Lint has pre-existing debt; the gate is "no NEW lint from this diff".

## Out of scope

- **Dropping the legacy URL columns.** They stay. They are the rollback path, and they cost nothing. A separate change can drop them after a long soak.
- Edge-side inbound ingestion (a Cloudflare Worker doing Meta → R2 directly).
- Re-hosting user-typed external template URLs.

---

### Task 1: Unblock the flow validators

**This must land first.** Both validators currently hard-require a non-empty `media_url`, so the moment the backfill migrates a `send_media` node to a key-only config, every flow containing one fails validation and cannot be activated.

**Files:**
- Modify: `convex/lib/flows/validate.ts:253-276`
- Modify: `src/lib/flows/validate.ts:248-271`
- Test: `convex/lib/flows/validate.test.ts`, `src/lib/flows/validate.test.ts` (check actual filenames first)

**Interfaces:**
- Consumes: nothing.
- Produces: no new exports — behavior change only. A `send_media` node is valid when it has EITHER `media_key` or `media_url`.

- [ ] **Step 1: Write the failing tests**

In each validator's test suite, add cases asserting:
- a `send_media` node with only `media_key` set → **valid** (currently fails)
- a `send_media` node with only `media_url` set → valid (regression guard)
- a `send_media` node with both → valid
- a `send_media` node with neither → **invalid**, and the reported `field` is still `media_url` (that is what the form focuses)

Copy the surrounding arrangement from the existing `send_media` validation test in each file rather than inventing a node fixture.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run convex/lib/flows/validate.test.ts src/lib/flows/validate.test.ts`
Expected: the key-only cases FAIL with the "media required" error.

- [ ] **Step 3: Relax both guards**

In each file, replace the `if (!cfg.media_url?.trim())` guard with one that accepts either source. Add `media_key?: string;` to the local config type beside `media_url`. Keep the emitted `field: "media_url"` unchanged.

```ts
      if (!cfg.media_key?.trim() && !cfg.media_url?.trim()) {
        // …existing error push, field: "media_url" unchanged
      }
```

**Both files must change identically.** They are hand-maintained mirrors that already drifted once during Plan 1 (`convex/lib/flows/types.ts` gained `media_key`; `src/lib/flows/types.ts` did not). Add `media_key` to `src/lib/flows/types.ts` too if it is still missing.

- [ ] **Step 4: Run to verify they pass, then the full suite**

```bash
npx vitest run convex/lib/flows/validate.test.ts src/lib/flows/validate.test.ts
npm test
```

- [ ] **Step 5: Typecheck, lint, commit**

```bash
npm run typecheck && npx eslint convex/lib/flows/validate.ts src/lib/flows/validate.ts src/lib/flows/types.ts
git add convex/lib/flows/validate.ts convex/lib/flows/validate.test.ts src/lib/flows/validate.ts src/lib/flows/validate.test.ts src/lib/flows/types.ts
git commit -m "fix(flows): accept a media key or a media url on send_media nodes"
```

---

### Task 2: Legacy-URL predicate and migration status

The pure predicate the whole backfill keys on, plus the query that tells an operator how much work remains and — later — whether it is safe to purge.

**Files:**
- Modify: `convex/lib/r2/keys.ts` (add the predicate beside the existing key helpers)
- Modify: `convex/lib/r2/keys.test.ts`
- Create: `convex/r2Backfill.ts`
- Create: `convex/r2Backfill.test.ts`
- Modify: `convex/_generated/api.d.ts` (import line + member for the new module — hand-edited, see Global Constraints)

**Interfaces:**
- Consumes: `buildMediaKey`, `MediaKind` from `convex/lib/r2/keys.ts`.
- Produces:
  - `isLegacyConvexStorageUrl(url: string | null | undefined): boolean`
  - `internal.r2Backfill.status(): Promise<{ remaining: Record<string, number>; scannedAll: boolean }>`

- [ ] **Step 1: Write the failing predicate tests**

Add to `convex/lib/r2/keys.test.ts`:

```ts
test("isLegacyConvexStorageUrl matches a Convex storage URL", () => {
  expect(
    isLegacyConvexStorageUrl("https://convex-api.holidayys.co/api/storage/abc123"),
  ).toBe(true);
});

test("isLegacyConvexStorageUrl rejects an R2 public URL", () => {
  expect(
    isLegacyConvexStorageUrl("https://objs.holidayys.co/acc1/outbound/abc.png"),
  ).toBe(false);
});

test("isLegacyConvexStorageUrl rejects a user-typed external URL", () => {
  expect(isLegacyConvexStorageUrl("https://example.com/promo.png")).toBe(false);
});

test("isLegacyConvexStorageUrl rejects empty and missing values", () => {
  expect(isLegacyConvexStorageUrl("")).toBe(false);
  expect(isLegacyConvexStorageUrl(null)).toBe(false);
  expect(isLegacyConvexStorageUrl(undefined)).toBe(false);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run convex/lib/r2/keys.test.ts`
Expected: FAIL — `isLegacyConvexStorageUrl` is not exported.

- [ ] **Step 3: Implement the predicate**

```ts
/**
 * True only for a URL served by this deployment's Convex file storage —
 * the `…/api/storage/<id>` shape `ctx.storage.getUrl` produced before the
 * R2 cutover (see `convex/accounts.test.ts`'s fixtures for the literal form).
 *
 * Deliberately narrow. The same columns can also hold an R2 public URL
 * (post-cutover outbound rows carry one alongside their key) and a
 * USER-TYPED external URL (`messageTemplates.headerMediaUrl` — see
 * `src/components/settings/template-manager.tsx`). Re-hosting either would
 * be wrong, so the backfill migrates only what this returns true for.
 */
export function isLegacyConvexStorageUrl(
  url: string | null | undefined,
): boolean {
  if (!url) return false;
  return /\/api\/storage\/[^/?#]+/.test(url);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run convex/lib/r2/keys.test.ts`

- [ ] **Step 5: Write the failing status test**

In `convex/r2Backfill.test.ts`, seed a small fixture across the four tables — some rows with a legacy URL and no key, some already migrated, some with an external URL — and assert `status()` counts ONLY the first group, per table.

Use `convex/schema.test.ts`'s `insertAccount` helper and the seed shapes the existing suites use. Do not invent insert shapes — Plan 1 Task 4 lost time to exactly that.

- [ ] **Step 6: Implement `status`**

An `internalQuery` returning a per-table count of rows that (a) have a legacy Convex storage URL and (b) have no key yet. Scan by index and count in JS — **no `.filter()`**.

Tables and fields:

| Table | URL field | Key field |
|---|---|---|
| `messages` | `mediaUrl` | `mediaKey` |
| `messages` | `referral.storedImageUrl` | `referral.storedImageKey` |
| `messageTemplates` | `headerMediaUrl` | `headerMediaKey` |
| `memberships` | `avatarUrl` | `avatarKey` |
| `flowNodes` | `config.media_url` | `config.media_key` |

`messages` is the high-volume table; bound the scan and return `scannedAll: false` if the bound is hit, so an operator knows the number is a floor rather than a total. Confirm `messageTemplates` actually has an `accountId` and a usable index before relying on one.

- [ ] **Step 7: Register the module, run the suite, commit**

Hand-edit `convex/_generated/api.d.ts` — add the `r2Backfill` import line and member, in its correct alphabetical slot (Plan 1's predecessor logged a minor for getting that slot wrong). Do not touch `api.js`.

```bash
npm test && npm run typecheck
git add convex/lib/r2/keys.ts convex/lib/r2/keys.test.ts convex/r2Backfill.ts convex/r2Backfill.test.ts convex/_generated/api.d.ts
git commit -m "feat(r2): legacy-url predicate and backfill status query"
```

---

### Task 3: The backfill engine, over `messages`

The highest-volume table, and the one that carries two independent media fields per row.

**Files:**
- Modify: `convex/r2Backfill.ts`
- Modify: `convex/r2Backfill.test.ts`

**Interfaces:**
- Consumes: `isLegacyConvexStorageUrl`, `buildMediaKey` (Task 2 / Plan 1); `putObject`, `r2ConfigFromEnv` (Plan 1).
- Produces:
  - `internal.r2Backfill.pageMessages({ cursor: string | null, numItems: number })` → `{ page, continueCursor, isDone }`
  - `internal.r2Backfill.applyMessageKeys({ updates: { messageId, mediaKey?, storedImageKey? }[] })`
  - `internal.r2Backfill.runMessages({ cursor?: string | null })` — the paced action; reschedules itself until `isDone`

- [ ] **Step 1: Write the failing tests**

Assert, with `fetch` stubbed:
- a customer-sent row with a legacy `mediaUrl` and no key gets a `mediaKey` whose kind segment is `inbound`, and whose bytes were PUT to R2
- an agent-sent row gets kind `outbound` (derive from `senderType`)
- a row whose `referral.storedImageUrl` is legacy gets `referral.storedImageKey` with kind `ad`
- a row that **already has** `mediaKey` is untouched and triggers no fetch
- a row whose `mediaUrl` is an R2 public URL is untouched and triggers no fetch
- a row whose fetch **fails** leaves that row unmigrated but does NOT stop the others in the batch
- the legacy `mediaUrl` value is **left in place** (this is the rollback path)

The "no fetch" assertions matter as much as the positive ones — assert `fetchMock` was not called, the way `convex/files.test.ts` does.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run convex/r2Backfill.test.ts`

- [ ] **Step 3: Implement the three functions**

`pageMessages` — an `internalQuery` using `.paginate({ cursor, numItems })` over an existing `messages` index. Return the rows as-is; let the action decide what to migrate. **No `.filter()`.**

`applyMessageKeys` — an `internalMutation` patching a batch of rows. Patch only the key fields; never clear the legacy URL. For `referral.storedImageKey`, patch the whole nested `referral` object with the existing fields spread — a nested patch replaces the object.

`runMessages` — an `internalAction`:

```ts
const cfg = r2ConfigFromEnv();
const { page, continueCursor, isDone } = await ctx.runQuery(
  internal.r2Backfill.pageMessages,
  { cursor: args.cursor ?? null, numItems: BACKFILL_PAGE },
);

const updates = [];
for (const row of page) {
  const update = { messageId: row._id };
  // media
  if (!row.mediaKey && isLegacyConvexStorageUrl(row.mediaUrl)) {
    const key = await copyToR2(cfg, {
      url: row.mediaUrl!,
      accountId: row.accountId,
      kind: row.senderType === "customer" ? "inbound" : "outbound",
    });
    if (key) update.mediaKey = key;
  }
  // ad referral … same shape, kind "ad"
  if (update.mediaKey || update.storedImageKey) updates.push(update);
}
if (updates.length) {
  await ctx.runMutation(internal.r2Backfill.applyMessageKeys, { updates });
}

// Terminate on the paginator's own `isDone`, NEVER on a short page —
// see `convex/automations.ts:512-523` for why a short-batch termination
// silently leaves orphans behind forever.
if (!isDone) {
  await ctx.scheduler.runAfter(
    BACKFILL_PACE_MS,
    internal.r2Backfill.runMessages,
    { cursor: continueCursor },
  );
}
```

`copyToR2` is a small module-private helper: fetch the legacy URL, mint a key with `buildMediaKey`, `putObject`, return the key — or return `null` on ANY failure after logging, so one bad object cannot abort the sweep.

Export `BACKFILL_PAGE` and `BACKFILL_PACE_MS` as named constants with a comment justifying the values (they trade scheduler rows and VPS uplink pressure against wall-clock). Start conservative.

- [ ] **Step 4: Run to verify they pass, then the full suite**

```bash
npx vitest run convex/r2Backfill.test.ts && npm test
```

- [ ] **Step 5: Typecheck, lint, commit**

```bash
npm run typecheck && npx eslint convex/r2Backfill.ts convex/r2Backfill.test.ts
git add convex/r2Backfill.ts convex/r2Backfill.test.ts
git commit -m "feat(r2): paced backfill of message media into R2"
```

---

### Task 4: Backfill the remaining tables, and give templates a key writer

**Files:**
- Modify: `convex/r2Backfill.ts`, `convex/r2Backfill.test.ts`
- Modify: `convex/templates.ts` (accept and persist `headerMediaKey`)
- Modify: `src/components/settings/template-manager.tsx`
- Test: `convex/templates.test.ts`

**Interfaces:**
- Produces: `internal.r2Backfill.runTemplates`, `runMemberships`, `runFlowNodes` — same page/apply/run shape as Task 3.

- [ ] **Step 1: Close the template key gap first**

Plan 1 deliberately left `messageTemplates.headerMediaKey` with no writer, because `toUiTemplate` collapsed key and URL into one field so the edit form could not round-trip a key.

**That blocker is already gone** — verified on disk: Plan 1's final-review fix added `header_media_key: doc.headerMediaKey` at `src/lib/convex/adapters.ts:601`, with `MessageTemplate.header_media_key` declared at `src/types/index.ts:438`. So the adapter now carries the key back to the form. (`messageTemplates` also has `accountId` and a `by_account` index at `convex/schema.ts:600`, which the sweep needs.) Re-confirm both still hold, then wire the writer:

- add `headerMediaKey` to the `templates` create/update mutation args and persist it
- have `template-manager.tsx` store the key from `uploadAccountMedia` alongside the resolved URL
- confirm the edit form round-trips the key rather than blanking it on a non-re-upload edit — **this is the exact hazard that caused the deferral, so test it explicitly**: open an existing key-bearing template, change only its name, save, and assert the key survives

Without this, template rows have nothing to migrate INTO and Task 4's template sweep is pointless.

- [ ] **Step 2: Write the failing tests for the three sweeps**

Mirror Task 3's cases per table, with the right kinds:

| Sweep | Table | URL → key | Kind |
|---|---|---|---|
| `runTemplates` | `messageTemplates` | `headerMediaUrl` → `headerMediaKey` | `template` |
| `runMemberships` | `memberships` | `avatarUrl` → `avatarKey` | `avatar` |
| `runFlowNodes` | `flowNodes` | `config.media_url` → `config.media_key` | `flow` |

Include per-table:
- a legacy URL with no key → migrated
- an already-keyed row → untouched, no fetch
- an R2 public URL → untouched, no fetch

And specifically for templates: **a user-typed external URL (e.g. `https://example.com/x.png`) is left completely alone and triggers no fetch.** That is the case the predicate exists for.

And specifically for flow nodes: `config` is `v.any()`, so add cases for `config` being `undefined`, `{}`, and a shape with no `media_url` — none may throw.

- [ ] **Step 3: Run to verify they fail, then implement**

Same page/apply/run triple per table. `runFlowNodes` patches `config` as a whole object (spread the existing config, add `media_key`) since it is untyped.

- [ ] **Step 4: Run, typecheck, lint, commit**

```bash
npx vitest run convex/r2Backfill.test.ts convex/templates.test.ts && npm test
npm run typecheck && npx eslint <changed files>
git add <changed files>
git commit -m "feat(r2): backfill template, avatar and flow-node media into R2"
```

---

### Task 5: Verification and purge

**Files:**
- Modify: `convex/r2Backfill.ts`, `convex/r2Backfill.test.ts`
- Create: `convex/lib/r2/storageSweep.ts` + test (the pure transform, so the `ctx.db.system` shell stays thin)

**Interfaces:**
- Produces:
  - `internal.r2Backfill.storageUsage()` → `{ count: number; bytes: number }`
  - `internal.r2Backfill.purgeConvexStorage({ cursor?, confirm: "yes-delete-all-convex-storage" })`

- [ ] **Step 1: Storage measurement**

An `internalQuery` reading `ctx.db.system.query("_storage")`, summing `size`. **`convex-test` cannot emulate `ctx.db.system`** — put the summing logic in a pure exported function in `convex/lib/r2/storageSweep.ts`, unit-test that directly, and keep the query shell a thin pass-through. This is the pattern `convex/cronSchedules.ts:262` and `convex/lib/cronSummary.ts` already establish.

- [ ] **Step 2: The purge, gated**

`purgeConvexStorage` must **refuse to delete anything** unless `status()` reports zero remaining unmigrated rows across every table. It takes an explicit `confirm` literal so it cannot be triggered by a stray call. It pages through `_storage` and `ctx.storage.delete`s each object, rescheduling itself, terminating on the paginator's `isDone`.

Safe because after Plan 1 **nothing writes to Convex storage** — verified: `grep "ctx.storage."` across `convex/` returns no non-test hits. Re-verify that before implementing; if anything has since started writing, STOP and report.

- [ ] **Step 3: Write the tests**

- purge with a non-zero remaining count → **refuses, deletes nothing**
- purge without the exact `confirm` literal → refuses
- purge with zero remaining and the literal → deletes, and reschedules while not done
- the pure size-summing transform, tested directly

- [ ] **Step 4: Run, typecheck, lint, commit**

```bash
npm test && npm run typecheck && npx eslint <changed files>
git add <changed files>
git commit -m "feat(r2): gated purge of Convex file storage"
```

---

### Task 6: Owner runbook — execute the migration

**Files:** none. This is an operator procedure, run by the owner against production.

🚨 **Every step here is owner-only.** No implementer subagent runs any of it.

- [ ] **Step 1: Deploy the backfill code**

```bash
git fetch origin && git merge origin/main
npm test && npm run typecheck && npm run build   # all green
npx convex deploy                                 # PRODUCTION — owner only
```

- [ ] **Step 2: Measure before**

Run `status()` and `storageUsage()`. Record the per-table remaining counts and the total bytes. This is the number the reclaim is measured against, and `status()` must be re-run to zero before any purge.

- [ ] **Step 3: Run the sweeps, one table at a time**

Start with the low-volume tables (`memberships`, `messageTemplates`, `flowNodes`) — they are the cheap confidence check. Then `messages`.

After each, re-run `status()` and confirm the count for that table dropped to zero. **Spot-check in the UI**: open a pre-cutover conversation and confirm an old photo, an old voice note and an old document all still play, now served from `objs.holidayys.co`.

- [ ] **Step 4: Verify before purging**

- `status()` reports zero remaining on every table.
- Media in old conversations renders.
- An old template with a header image still sends.
- Cloudflare shows object count and bytes in `wa-holidayys` risen by roughly the `storageUsage()` figure from Step 2.

**Do not proceed until all four hold.** The purge is the one irreversible step in either plan.

- [ ] **Step 5: Purge and reclaim**

Run `purgeConvexStorage` with the confirm literal. Re-run `storageUsage()` until it reports zero. Then check actual VPS disk on `convex-wd56` — Convex may need a restart or its own compaction before the space is returned to the filesystem.

- [ ] **Step 6: Record the outcome**

Append a "backfill completed <date>" note to the spec with the bytes reclaimed and anything that failed, and update the project memory entry.

---

## Self-Review

**Spec coverage.** The spec's Migration section has five steps: measure (Task 5 Step 1 + Task 6 Step 2), backfill (Tasks 3–4), verify (Task 6 Step 4), purge (Task 5 + Task 6 Step 5), and drop legacy columns — which is deliberately **out of scope** here and stated as such at the top.

**The three known backfill blockers are all addressed:** flow validators (Task 1, deliberately first), the template key writer plus the third URL flavour (Task 4 Step 1 and the `isLegacyConvexStorageUrl` predicate), and the dead `conversations.adReferral.storedImageUrl` / vestigial `fileOwners` — which are **not** addressed here. They are inert dead surface, not migration blockers, and folding cleanup into an irreversible data migration adds risk for no benefit. They should be a separate small change.

**Known gaps, stated rather than hidden.** Several test steps say "copy the seed arrangement from the neighbouring suite" instead of reproducing it. That is deliberate — Plan 1 Task 4 lost time precisely because the plan invented insert shapes that omitted required fields. A pointer to the real fixture beats a fabricated one, but it does mean those steps need a careful reviewer.

**Type consistency.** `isLegacyConvexStorageUrl` is defined once in Task 2 and consumed in Tasks 3–4. The page/apply/run triple keeps the same shape across all four sweeps. `MediaKind` values used here (`inbound`, `outbound`, `ad`, `template`, `avatar`, `flow`) are all members of the `MEDIA_KINDS` tuple Plan 1 Task 1 defined. `status()` is defined in Task 2 and is the gate `purgeConvexStorage` consumes in Task 5.

**The riskiest thing in this plan** is not the backfill — it is Task 5's purge, the only irreversible step across both plans. It is gated three ways (zero-remaining check, explicit confirm literal, and a manual four-point verification in Task 6 Step 4), and the legacy URL columns are deliberately retained so that even after a purge, a row still records what it used to point at.
