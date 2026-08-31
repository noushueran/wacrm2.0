# CRM Codebase Unification — Design

**Date:** 2026-08-02
**Status:** Draft, awaiting owner review
**Scope:** Merge `amani-wa-crm` and `wacrm2.0` into one codebase serving two companies from two
independent deployments.

## Problem

There are two live WhatsApp CRMs — Amani Tourism & Travel LLC and Holidays Tours LLC — running
the same application. `wacrm2.0` was forked into `amani-wa-crm` on 2026-07-21. Since then both
have been worked on, and every improvement has to be built twice or not at all.

This is not a forecast. On **2026-08-02 the same feature was built twice, in both repos, on the
same day, with two different architectures**:

| | Amani `d770b0a` | Holidayys `416265d` |
|---|---|---|
| Commit | "view media large, and download it" | "full-screen viewer and working download for media" |
| Approach | client-side hooks + `next.config.ts` | server API route |
| `media-lightbox.tsx` | 262 lines | 109 lines |
| `lib/media/download.ts` | 207 lines | 109 lines |
| `message-bubble.tsx` | +193 | +289 |
| Unique | `use-media-download.ts`, `use-media-object-url.ts` | `app/api/media/download/route.ts` |

Two engineers-worth of work, one feature, two incompatible designs. Six files are dirty in both
working trees right now (`dashboard.ts`, `messages.ts`, `messageStats.ts`, `schema.ts`, and two
test files) — the same duplication, still in progress.

## What the fork actually was

The fork was a directory copy followed by a find-and-replace. Measured across all 595 source
files present at the fork point (`e4a5e2e`, 2026-07-21) versus Amani's root commit `a12b44c`:

| | Files |
|---|---|
| Byte-identical | **537** |
| Differ only by the brand string | 28 |
| Differ otherwise | 30 — of which **17 are test fixtures** |

Every non-test difference was read. All of them are one of four things: the brand name
(`Holidayys` / `Amani`), the legal entity (`Holidays Tours LLC` / `Amani Tourism & Travel LLC`),
one of three domains (`wa.*`, `objs.*`, the marketing site), or a UI placeholder. Representative:

```diff
- default: "Holidayys WA CRM",              - "https://wa.holidayys.co"
+ default: "Amani WA CRM",                  + "https://wa.amaniworld.com"
- Holidays Tours LLC · Internal team        - objs.holidayys.co
+ Amani Tourism & Travel LLC · Internal     + objs.amaniworld.com
```

**Not one line of logic differed at the fork.** `convex/schema.ts` was 2,118 lines on both sides
and differed by two comment lines. `package.json` still differs only by name, description,
author, homepage and one keyword — the dependency trees are identical today.

The application was already multi-tenant: `accounts` + `memberships`, `accountId` appearing 165
times in Holidayys' schema and 178 in Amani's, and `whatsappConfig.ts` resolving the tenant from
`by_phone_number_id` with a cross-account claim guard. The fork happened because copying a folder was the fastest thing to do
that day, not because the code could not host two companies.

## Principle

**The tenant is configuration, never code.**

Company identity is six values in environment variables. Company *data* — knowledge base,
WhatsApp config, accounts, pipelines, services — is already per-account rows in each Convex
deployment and is never touched by this work.

## Architecture

### 1. Brand configuration

Two modules, one per runtime, same shape:

- `src/lib/brand.ts` — reads `NEXT_PUBLIC_BRAND_NAME`, `NEXT_PUBLIC_BRAND_LEGAL_NAME`,
  `NEXT_PUBLIC_SITE_URL`, `NEXT_PUBLIC_MEDIA_HOST`, `NEXT_PUBLIC_BRAND_WEBSITE`,
  `NEXT_PUBLIC_BRAND_EMAIL`
- `convex/lib/brand.ts` — Convex-side env, needed for exactly one live value: the ad-context
  User-Agent in `adLanding.ts`

Consumers: `src/app/layout.tsx`, `src/app/join/layout.tsx`, `src/components/og/invite-card.tsx`,
and the placeholders in `src/components/settings/qualification-settings.tsx`.

**A missing variable fails loudly rather than defaulting.** `layout.tsx:33` currently falls back
to a hardcoded company URL. With one shared repo that fallback is how Holidayys ships wearing
Amani's name, so the module throws in development and CI when a variable is absent. This is the
one behavioural change the brand work introduces, and it is deliberate.

### 2. History unification

The two repos look unrelated to git — Amani's root is a fresh commit — so
`--allow-unrelated-histories` would merge with *no* base and conflict on every file. It is not
needed. `e4a5e2e` is a **verified ancestor of `wacrm2.0`'s live HEAD**, and Amani's root tree is
that same tree plus `.claude/` plus the brand substitution. Grafting Amani's root onto `e4a5e2e`
gives git a real three-way base and turns 335 commits into an ordinary branch merge.

`wacrm2.0` keeps the trunk. It holds the merge base and 1,187 commits of history; grafting
replays Amani onto it, so **only Amani's SHAs are rewritten and Holidayys' refs stay valid**.
The `amani-wa-crm` remote is archived after cutover. Renaming the surviving repo to something
tenant-neutral is optional and can happen later — GitHub redirects.

The merge base does not depend on the `_wacrm2.0-duplicate-from-wa-amani` scratch checkout
surviving; `e4a5e2e` is reachable from `origin/main`.

### 3. Deploy safety

Merging costs the accident-protection that "the folder I am standing in is the company" provided.
It is bought back explicitly:

- **Two checkouts**, one per tenant — folder still equals tenant in daily use
- **No bare `.env.local`.** `.env.holidayys` and `.env.amani`, both gitignored
- **`npm run deploy:<tenant>`** loads the matching file, prints the resolved Convex host and brand
  name, and requires typed confirmation

Nothing auto-deploys. Convex deploys stay owner-initiated, exactly as they are now. Netlify runs
two sites off the same repo and branch with different environment variables; the two Convex
deployments are pushed independently, on the owner's schedule.

Binding a checkout to a deployment is already pure environment — there is no `convex.json` in
either repo, `.gitignore` covers `.env*`, and both `src/app/ConvexClientProvider.tsx:35` and
`next.config.ts:14` read `NEXT_PUBLIC_CONVEX_URL` with a placeholder fallback. Nothing in tracked
source names a deployment.

## Rollout order

R1 and R2 below compound, so this order is not negotiable. Steps 3–6 are where this either goes
smoothly or becomes an incident.

1. **Land or reconcile the six doubly-dirty files.** Merging with uncommitted work in both trees
   invites silent loss.
2. **Apply the media-viewer decision (R3)** — Holidayys' transport, Amani's viewer, per §Decision.
   Resolved as a deliberate rewrite *before* the merge, never as conflict resolution during it.
3. **Set `autoAssignEnabled: false` on every Holidayys `qualificationConfigs` row.** Before any
   deploy. See R1 — the default is on, not off.
4. **Deploy schema + code to Holidayys.** Additive schema; expect index build time on
   `conversations`.
5. **Run `inboxBackfill.backfillAwaitingReply` to `patched: 0`.** Verify with a second pass
   returning `0`. Lane tabs are wrong until this completes.
6. **Verify lanes, then re-enable auto-assign deliberately.**

Amani deploys from the same `main` afterwards, on its own schedule. Its data already satisfies the
schema and its backfill has already run, so for Amani this is an ordinary release.

## Risk register

Severity reflects impact on **Holidayys**, which receives all 335 commits and therefore carries
essentially all production risk. Amani's exposure is process, not data.

### 🔴 R1 — `inbox-chase-assign` runs by default

`convex/crons.ts` claims the sweep is "a no-op unless `qualificationConfigs.autoAssignEnabled` is
on". The implementation says the opposite, and the code agrees with the implementation:

```js
// Runs BY DEFAULT … Absent or `true` means active;
// only an explicit `false` disables it.
if (!config || config.autoAssignEnabled === false) continue;
```
— `convex/inboxChaseAssign.ts:63-70`

`autoAssignEnabled` is a new optional field, so every existing Holidayys config row lacks it and
the sweep is **active on first deploy**. Bounded at `ASSIGN_PER_RUN = 50` every 30 minutes
(≈2,400/day), each firing a `conversation_assigned` notification; supervisors additionally receive
`chase_unassigned` notifications, which the code itself notes is "48 notifications per supervisor
per day, indefinitely".

It **sends nothing to customers** — it patches `assignedToUserId` and notifies internally. The harm
is staff disruption: agents arriving to find months of dormant threads assigned overnight.

*Mitigation:* rollout step 3. The misleading comment is being corrected separately.

### 🔴 R2 — Inbox lanes are empty until the backfill completes

> Must reach `patched: 0` BEFORE the lane tabs ship: `undefined` is not a lane, and an
> un-backfilled row would be silently swallowed by whichever range it happens to sort into.
> — `convex/inboxBackfill.ts`

Amani shipped this as a staged rollout: backfill first, lanes second. **A merge collapses both
into one deploy.** Between deploy and backfill completion every Holidayys conversation holds
`awaitingReply: undefined` and falls outside every lane range — Active, Waiting and Chasing all
read empty.

The backfill is caller-driven and paginated, **not self-scheduling**, which matters: self-scheduling
backfills on this codebase have already caused a production incident, where overlapping runs
inflated figures 1.8×. It is idempotent per row, `DEFAULT_BATCH = 200`, and performs one `messages`
query per conversation, so duration scales with the conversation table.

*Mitigation:* rollout step 5, with R1 disabled first — the moment the backfill lands, the backlog
becomes Chasing, which is precisely what R1 auto-assigns.

### 🔴 R3 — The media viewer exists twice, with incompatible designs

See §Problem. Both implementations create `media-lightbox.tsx` and `lib/media/download.ts` with
different content and both heavily rewrite `message-bubble.tsx`. Git will conflict and cannot
adjudicate between two designs.

**Resolved** — see §Decision: Holidayys' server-route transport, Amani's zoom/pan viewer, with two
of Amani's incidental fixes carried across. The residual risk is that this is a *rewrite* of
`message-bubble.tsx` (touched +193 by one side and +289 by the other) rather than a merge, so it
needs its own tests rather than inheriting either side's. Both suites' media tests are kept and
must pass against the combined result.

### 🟠 R4 — Wrong-tenant deploy

A stale or wrong env file deploys one company's schema onto the other's production data. This
failure mode does not exist today, and is created by this work. Addressed by §Deploy safety; it is
the principal ongoing cost of unification and should be treated as such.

### 🟠 R5 — Force-push blast radius

The graft rewrites all 335 Amani SHAs. Amani currently has 10 local and 6 remote branches,
including five unmerged feature branches (`feat/lead-analysis`, `feat/lead-analysis-p2`,
`feat/ai-spend-visibility`, `feat/composer-paste-attach`, `feat/dashboard-response-time`). All must
be rebased onto the unified history or abandoned; open Amani PRs will not survive. Holidayys refs
are untouched.

### 🟠 R6 — Concurrent uncommitted work

Six files dirty in both trees simultaneously. Rollout step 1.

### 🟡 R7 — Index builds on `conversations`

Five new indexes on the largest table. Convex builds them at deploy; on a large table the deploy
can appear to hang. Expect it rather than aborting.

### 🟡 R8 — `.claude/worktrees` is tracked

9,600 files / 98.8 MB at Amani's HEAD — 17 nested working copies of the repo. The `.gitignore` rule
already exists (`.gitignore:57-58`); the files were committed before it, and gitignore does not
untrack. Branch `chore/untrack-claude-worktrees` (`4a223b4`, 2026-07-27) exists and is unmerged.
Packed cost is modest — `.git` is 45 MB — so this is merge noise and checkout hygiene, not a size
crisis. Purge from Amani's history during the graft, while its SHAs are being rewritten anyway.

### 🟡 R9 — No staging Convex

There is nowhere to rehearse the schema deploy except a scratch deployment. Validate the unified
schema against a Holidayys data snapshot before step 4.

### ✅ Verified non-risks

Checked and clean — recorded so they are not re-litigated:

| Concern | Finding |
|---|---|
| Dependency drift | None. `package.json` differs only by brand fields |
| Schema deploy safety | All 13 changed shared tables add only optional fields or additive union literals. No required field added, none removed, no type narrowed |
| New tables | 3, all Amani-only (`leadAnalyses`, `leadAnalysisConfigs`, `leadSequenceSendRate`). Holidayys adds none |
| `lead-scoring` / `lead-sequence` crons | Dormant. `loadEnabledConfig` (`leadAnalysisEngine.ts:48-58`) returns null without an enabled `leadAnalysisConfigs` row, and that table is new, so Holidayys has none. `lead-sequence` is the only cron that can message customers, and it is inert |
| Test coverage | Both suites green: Amani 3,124 tests / 203 files, Holidayys 2,332 / 177, ~7s each |
| Company data | Untouched. KB, WhatsApp config, accounts, pipelines are per-account rows in two separate deployments |

## Testing

The existing suites are the gate, and they are fast enough (~7s) to run on every conflict
resolution rather than once at the end. The merged tree must reach the union of both suites passing
before any deploy.

Media tests follow the §Decision split. Kept: Holidayys' `api/media/download/route.test.ts` and
`lib/media/download.test.ts`, which cover the transport that survives. Dropped with the code they
pin: the parts of Amani's `lib/media/download.test.ts` covering `needsCacheBypass` and
`fetchMediaBlob`, which test a client fetch that no longer exists. Amani's `media-bubble.test.tsx`
is retained but rewritten — the bubble it renders is the combined one, not either original.

New tests required:

- `src/lib/brand.ts` — asserts a missing variable **throws** rather than falling back, for each of
  the six values
- `convex/lib/brand.ts` — same, for the ad-context User-Agent
- No test may hardcode either company name; the ~30 test files carrying brand fixtures move to the
  brand module's test double

Note the constraint both repos' media modules document: **this repo has no jsdom**, so component
tests are static renders and any logic worth testing must live in a pure module. The lightbox's
zoom and pan are therefore verified in a browser against a real thread, not in the suite — as they
were originally.

## What this does not change

- The knowledge base, company details, WhatsApp configuration, accounts, pipelines and services in
  either deployment. These are database rows and this work never reads or writes them.
- Deployment independence. Two Convex deployments, two Netlify sites, two WABAs. Isolation lives at
  the deploy boundary, not the repo boundary, and that boundary is unchanged.
- Deploy cadence or authority. Deploys remain manual and owner-initiated.

## Decision: the media viewer (R3)

Both implementations were read in full. They are not one feature built twice — they are **two
separable layers**, and each repo won a different one.

**Take Holidayys' transport. Take Amani's viewer.**

### Transport — Holidayys' server route

The two repos state contradictory facts about the same infrastructure:

| | Claim |
|---|---|
| Amani `lib/media/download.ts` | "R2 sends `access-control-allow-origin: https://wa.amaniworld.com`, so it works in production" |
| Holidayys `api/media/download/route.ts` | "the bucket's CORS policy does not promise [ACAO] — it covers the `PUT` upload path only" |

Both are probably right about their own bucket, and that is the problem. Amani's client-side
`fetch → blob → anchor` **only works where the R2 bucket names the app origin in its CORS policy**.
Amani's own module records the consequence: the allowlist is a single origin, so the fetch *fails
from localhost* and the hook ships a toast with an open-in-a-tab escape hatch to cover it.

Adopting that for a unified codebase means a per-tenant, per-environment bucket CORS policy is a
prerequisite for a feature working — configuration living outside the repo, differing per company,
which is precisely what this spec exists to eliminate. Holidayys' route needs none of it: the bytes
never cross an origin boundary in the browser.

The rest follows from that:

| | Amani | Holidayys |
|---|---|---|
| Requires R2 bucket CORS for GET | **yes** | no |
| Works in local development | **no** — falls back to open-in-tab | yes |
| Requires CSP `connect-src` entry | yes | no |
| Client code | fetch, blob, object URL, re-entry ref, toast fallback | one `<a href>` |
| Generated filename | `amani-<kind>-<stamp>` — **a brand string** | `whatsapp-<type>-<date>` — neutral |
| Server bandwidth | none | all media bytes |
| SSRF surface | none | yes, contained |

Amani's filename prefix would otherwise have become a seventh brand value; Holidayys' is already
tenant-neutral, so choosing it removes the problem rather than parameterising it.

The two costs of the route are real and accepted. Bandwidth: media flows through the Netlify
function, bounded by WhatsApp's own caps (≈16 MB video/document, ≈5 MB image) and streamed rather
than buffered (`new Response(upstream.body)`), so no request holds a video in server memory. SSRF:
the route fetches a caller-supplied URL, contained by requiring the caller's Convex auth token,
checking the target origin against an exact env-derived allowlist (not a prefix test), refusing to
follow redirects, and sanitising the filename. Auth is checked *before* the allowlist so an
anonymous caller learns nothing about which hosts are configured. It also already handles legacy
absolute Supabase URLs, which Amani's path does not.

### Viewer — Amani's lightbox

Amani's is 262 lines to Holidayys' 109, and the difference is the feature that motivated the work:
**click to zoom to natural size, drag to pan**, with a 4px threshold separating a shaky click from
a pan. Holidayys' viewer fits the image to the window and stops there — which does not solve "a
tall banner whose fine print is unreadable at fit size", the case both specs name.

Rewiring is small and well-bounded: Amani's lightbox takes `onDownload: () => void`; it takes
Holidayys' `downloadHref` string and an `<a download>` instead. The zoom, pan, drag-threshold and
close-on-surface-click logic is untouched.

### Carried across regardless of the above

Two findings in Amani's commit are independent of which transport wins and must not be lost:

- **CSP `media-src`.** `NEXT_PUBLIC_R2_PUBLIC_HOST` is absent from `media-src`, so `<video>` and
  `<audio>` bubbles will break when CSP flips from Report-Only to enforced — a live latent bug
  unrelated to downloads. (The `connect-src` half of that change is dropped with the client fetch.)
- **A blob leak.** In the code Amani replaced, the cleanup closed over `src` state from the render
  the effect ran in — `null` on mount — so `revokeObjectURL` never fired and every proxied image
  leaked its blob for the page's lifetime. This lives on the legacy Meta-proxy display path, which
  survives under either transport.

### Discarded

Amani's `use-media-download.ts`, `fetchMediaBlob`, `needsCacheBypass`, `triggerBlobDownload` and
the `connect-src` CSP entry. Each exists to work around the cross-origin fetch that the server
route makes unnecessary — including the `cache: "reload"` opaque-cache fix, which is a genuine and
well-diagnosed bug that simply stops existing once the fetch is same-origin.

## Open decisions

None blocking. The media-viewer question above was the last one.

## Revision history

- **v1 (2026-08-02)** — initial design. Written after measuring the fork point (`e4a5e2e`) against
  Amani's root, auditing all 13 changed shared tables, all 4 new crons, and both test suites.
