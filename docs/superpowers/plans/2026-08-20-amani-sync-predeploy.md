# Amani code sync — pre-deploy checklist

The synced tree is code only. No customer, message, contact, pipeline or
knowledge-base row is read or written by this change, and the schema is
100% additive (18 new tables; 46 new fields on existing tables, **all
optional**, none removed, none narrowed). Existing rows satisfy the new
schema unchanged, so there is no data migration.

Nothing here is optional. Each item is something that fails SILENTLY or
disruptively if skipped.

## 1. Environment — before the Convex deploy

Convex deployment variables are set with `npx convex env set NAME value`.
They do NOT come from `.env.local`. Every one below is read WITHOUT a
fallback, so an absent value throws or silently no-ops.

**New — certainly absent, must be set:**

    npx convex env set BRAND_NAME Holidayys
    npx convex env set BRAND_SITE_URL https://wa.holidayys.co

**Verify present (already required by today's code — listed so the check
is done rather than assumed):** `R2_BUCKET`, `R2_ENDPOINT`,
`R2_PUBLIC_HOST`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`,
`VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`,
`CONVEX_SITE_URL`, `WA_CONVERSION_SHARED_SECRET`.

**Optional, feature-gating (absent = that feature stays dark, no error):**
`META_ADS_ACCESS_TOKEN` (ad/campaign names never resolve),
`META_CAPI_DATASET_ID` + `META_CAPI_ACCESS_TOKEN` (conversions API).

## 2. Environment — before the Netlify deploy

`src/lib/brand.ts` THROWS on a missing value, so `next build` cannot run
without these. That is deliberate: a fallback is how this deployment would
ship wearing another company's name. A failed build is safe — Netlify keeps
serving the current version.

    NEXT_PUBLIC_BRAND_NAME=Holidayys
    NEXT_PUBLIC_BRAND_LEGAL_NAME=Holidays Tours LLC
    NEXT_PUBLIC_SITE_URL=https://wa.holidayys.co
    NEXT_PUBLIC_BRAND_WEBSITE=https://holidayys.co
    NEXT_PUBLIC_BRAND_EMAIL=hello@holidayys.co

## 3. Disarm auto-assign — before the Convex deploy

`convex/inboxChaseAssign.ts` gates on:

    if (!config || !config.enabled) continue;
    if (config.autoAssignEnabled === false) continue;

**Absent means ON.** `autoAssignEnabled` is a new optional field, so no
existing `qualificationConfigs` row has it, and qualification IS enabled
here. On first deploy the sweep runs: 50 assignments per run, every 30
minutes (~2,400/day), each firing an internal notification.

It sends nothing to customers. The harm is staff disruption — agents
arriving to months of dormant threads assigned overnight. Set
`autoAssignEnabled: false` on every `qualificationConfigs` row first, and
turn it on deliberately later while watching the first sweep.

## 4. Backfill — after the Convex deploy, before the Netlify deploy

`undefined` is not a lane. Until `conversations.awaitingReply` is
populated, a row sorts into no lane at all and the Active / Waiting /
Chasing tabs all read EMPTY — which looks like data loss rather than a
pending migration.

Run `internal.inboxBackfill.backfillAwaitingReply` until it reports
`patched: 0`, then run it once more and confirm `0` again. It is paginated
(200/batch) and idempotent per row.

**Run one at a time.** Overlapping backfill runs have inflated production
figures 1.8x on this codebase before.

## 5. Deploy order

Convex and Netlify deploy independently, which is the only lever that
restores the staging the sync collapses:

1. Set env (1, 2) and disarm auto-assign (3)
2. Deploy Convex — invisible, Netlify still serves the old frontend
3. Backfill to `patched: 0` twice (4)
4. Deploy Netlify — first user-visible change
5. Re-enable auto-assign deliberately, and watch the first sweep

Rollback is redeploying the previous Convex bundle: every new field is
optional, so the old code simply ignores rows the new features wrote.

## 6. Known gaps carried by this sync

- **Media download needs R2 CORS.** This tree ships Amani's client-side
  download path (`fetch` -> blob -> anchor), which only works where the R2
  bucket names this app's origin in its CORS policy for GET. The
  server-side route at `src/app/api/media/download/route.ts` is PRESERVED
  and still tested but is not currently wired to the UI. Either add the
  CORS entry for `https://wa.holidayys.co`, or do the R3 rewire
  (`docs/superpowers/plans/2026-08-02-media-viewer-reconciliation.md`) to
  point the lightbox back at the route.
- **`reasoning.ts` was dropped**, orphaned by Amani's provider structure.
  Amani's `supportsReasoningEffort` covers the `-chat` case but does NOT
  send `"minimal"` for the gpt-5.0 family, which reportedly rejects
  `"none"`. Confirm `aiConfigs.model` on this deployment is >= gpt-5.1
  (this repo's own notes reference `gpt-5.4-mini`, which is fine) before
  deploying.
- **The build IS verified — in CI, not locally.** The local run was
  abandoned (the machine ran out of disk), but opening the sync PR
  triggered `.github/workflows/ci.yml` and it passed: lint, typecheck,
  test and `npm run build`, green in 3m21s. Note this corrects an earlier
  reading that Actions never runs here because the repo is a fork; the
  workflow had 0 runs before 2026-08-20, but it does fire on a
  `pull_request` targeting `main`.
- **A failing Netlify deploy preview is EXPECTED until section 2 is done.**
  CI builds with brand variables supplied by the workflow; Netlify has
  none set yet, so `src/lib/brand.ts` throws and the build stops. Same
  commit, two environments, one difference. That is the design, not a
  defect — and it is safe, because a failed build means Netlify keeps
  serving the current version.
