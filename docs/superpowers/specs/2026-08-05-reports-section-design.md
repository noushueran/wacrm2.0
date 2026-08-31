# Reports Section — Design

**Date:** 2026-08-05
**Status:** Draft, awaiting owner review
**Scope:** A dedicated `/reports` section covering conversation volume, ad performance, response
time/SLA, funnel, and Meta billing — backed by an extension of the existing `messageHourlyStats`
write-time rollup.

## Problem

The app captures far more analytical data than it shows.

`/dashboard` answers "what is happening right now" — today's counters, a messages-per-day chart, a
week-over-week response average, an activity feed. `/campaigns` adds 365-day funnel counts and
Meta conversion-event delivery status. Between them they surface a fraction of what is stored.

Four datasets are written on every relevant event and read by nothing:

| Table / field | Written by | Read by |
|---|---|---|
| `adReferrals` (adId, first-touch, matched service) | `adReferrals.record` on every CTWA click | nothing in the UI |
| `campaignAds` (adId → ad / ad set / campaign name) | `campaignAds.resolveAd` via Marketing API | nothing in the UI |
| `messages.pricing` (Meta billing outcome per message) | `messages.applyStatusPricing` | nothing |
| `conversations.metaWindow` (billable conversation, free-entry-point) | `messages.applyStatusPricing` | send-window checks only |

`schema.ts` line 634 states the intent plainly for one of them: *"Phase 4 aggregates this for spend
reporting."* Phase 4 was never built.

There is also no answer at all to two questions the owner asks directly: **how many conversations
started per day**, and **per week**. Neither figure exists anywhere in the app — `/dashboard`'s
chart counts *messages*, and its "active conversations" tile is a current-state count explicitly
capped at 500.

## Constraint that shapes everything

Convex caps a transaction at 4096 document reads. This codebase has been broken by that ceiling
**twice in production**, both times on `/dashboard`, both times because an analytics query used an
unbounded `.collect()`.

`lib/messageStats.ts` documents the first:

> `dashboard.conversationsSeries` used to `.collect()` every message in the requested window. That
> is bounded by the WINDOW but not by traffic, so against Convex's 4096-document read ceiling it
> broke at roughly 137 msg/day on the default 30-day view and 45 msg/day on the 90-day one.

`convex/dashboard.ts` documents the second, on `responseTime`: *"after this one kept crashing
/dashboard in production ('too many system operations')."*

The fix in both cases was the same: stop reading raw rows, accumulate counts at write time into
`messageHourlyStats`, and make the read a function of the *window* rather than of traffic.

A report cannot be rescued by a `.take()`. A truncated chart is silently wrong, which is worse than
a slow one. So every new time series in this design reads a rollup, and every scan of a raw table
is justified individually below.

## Decisions taken

Recorded because each closed off a materially different project:

1. **First-party data only.** No Meta Marketing API insights pull. Cost-per-lead and ROAS are
   therefore out of scope — they require spend, which only that API has.
2. **Extend `messageHourlyStats`** rather than adding a nightly cron-built daily table. A cron that
   scans a day of raw messages reproduces the exact unbounded read this rollup exists to remove,
   and a day-keyed row forces a timezone choice at write time — the thing hourly-UTC bucketing was
   designed to avoid.
3. **`/campaigns` is folded in** and redirects to `/reports?tab=funnel`. Its numbers should not
   exist in two places and drift.
4. **Per-agent SLA breakdown is deferred** to a final, separable phase. It is the only panel
   needing a second rollup table (`(accountId, userId, hourStartMs)`); everything else reuses one.

## Architecture

### Route and navigation

New route `/reports` with five tabs, selected by `?tab=`, and a range picker at `?range=7|30|90`
(default 30). Both live in the URL so any view is linkable.

| Tab | Question it answers |
|---|---|
| `conversations` | How much is happening? |
| `ads` | Which ads actually work? |
| `response` | How fast are we, and when are we slow? |
| `funnel` | Where do leads fall out? *(moved from `/campaigns`)* |
| `billing` | What is Meta billing us for, and what did we report back? |

`SUPERVISOR_NAV` in `src/lib/auth/roles.ts` swaps `/campaigns` → `/reports`. The sidebar entry
replaces "Campaigns" in the same slot, so nav length is unchanged. `/campaigns` becomes a redirect to
`/reports?tab=funnel`, and `/campaigns` is **removed** from `SUPERVISOR_NAV` rather than joined by
`/reports` — that array is an allowlist by deliberate design, so adding an entry must be a conscious
act. The `Campaigns` i18n namespace and the `Sidebar.campaigns` label have no consumers after this
and can be deleted once the redirect is confirmed in production.

### Access control

Supervisor+ for the entire section, matching `/campaigns` today. Every query returns aggregates
only — no phone numbers, no per-contact rows — so this grants a supervisor nothing they cannot
already reach (`conversationScope("supervisor") === "all"`, `canSeeContactPhone(...) === true`).

Each query calls `ctx.requireRole("supervisor")`. The page gates every `useQuery` behind
`canAccessNav(accountRole, '/reports')` with the `'skip'` sentinel, the same idiom
`campaigns/page.tsx` uses. This is not redundant: `useQuery` re-throws `FORBIDDEN` synchronously
during render, and the app has no Error Boundary, so an ungated query below the role floor crashes
the route rather than showing nothing.

### Rollup extension

`messageHourlyStats` gains six optional fields. All optional, all "absent means zero" — the
convention `responseCount`/`responseTotalMs` already established — so no existing row needs
touching and no deploy step is observable.

| Field | Written at | Dedup mechanism |
|---|---|---|
| `conversationsStarted` | `conversations.insertConversation` | single choke point; every creation path already routes through it |
| `conversationsStartedAd` | `adReferrals.recordAdReferral` | only when *this conversation* has no prior `adReferrals` row, **and** `sourceType === "ad"` |
| `responseBuckets` | `messages.recordResponseSample` | one sample per pairing, unchanged from today |
| `metaConversations` | `messages.applyStatusPricing` | only on the `!prev \|\| differentConversation` branch |
| `freeEntryPointConversations` | `messages.applyStatusPricing` | same branch, when `isFreeEntryPoint` |
| `billedMessagesByCategory` | `messages.applyStatusPricing` | only when `message.pricing` was previously `undefined` |

Two of these patch a bucket in the *past*, not the current hour:

- `conversationsStartedAd` keys off the conversation's `_creationTime`, because a referral can be
  recorded after the conversation row exists.
- `metaConversations` and the category counters key off the message's hour, because a status
  callback arrives after the message was sent.

**`metaConversations` is deliberately not called `billableConversations`.** It counts every distinct
Meta conversation window observed, and free-entry-point windows are among them — so
`freeEntryPointConversations` is a *subset*, not a sibling. A panel that renders `metaConversations`
under the label "Billable" overstates Meta's charge by exactly the free count. A billable figure, if
the UI wants one, is `metaConversations - freeEntryPointConversations` and must be labelled as
derived.

**`conversationsStartedAd` also gates on `sourceType === "ad"`.** Meta sends `"ad"` or `"post"`, and
a `"post"` is an organic Facebook/Instagram tap, not a paid ad; the `ctwa_clid`-only shape carries no
`sourceType` at all. Both are excluded, matching how `campaignAds` resolution already gates. The
consequence the UI must handle: organic post-tap conversations fall on the **direct** side of the
ad-vs-direct split, being neither paid-ad nor genuinely direct. A third bucket is out of scope for
v1.

Both are the pattern `recordResponseSample` already uses and documents: *"unlike
`recordMessageInHourlyStats` this usually patches an hour in the past... It is still a single point
lookup on `by_account_hour`, so the cost is the same."*

`conversationsStartedAd`'s guard is written **per-conversation** rather than reusing
`adReferrals.record`'s existing `isFirstTouch`, which is per-*contact*. Correction to an earlier
draft of this document, which claimed the two differ: **they do not**. Every conversation-creating
path in this repo is find-or-create *by contact* with no status or archived filter (`ingest.ts`,
`conversations.findOrCreateForContact` and its server-only twin, `qualificationEngine.ts`), so a
contact has exactly one conversation, forever — a returning customer who clicks a second ad lands
back in the same thread and is not counted again, exactly as `isFirstTouch` would have behaved.

Two consequences follow, and the UI must be built with them in mind:

- `conversationsStarted` counts a contact's *first* conversation — a **first-engagement** count, not
  a measure of repeat engagement. (Not strictly a new-*contact* count either: a contact can be
  created without a conversation, e.g. by import.)
- `conversationsStartedAd` is capped at one per contact ever, so a retargeting campaign that
  re-engages known contacts contributes **zero** to it.

**Owner decision (2026-08-05): relabel rather than re-measure.** The Conversations tab leads with
this figure under the label **"New conversations"**, with a subtitle stating that a contact opens
exactly one conversation. It is not called "Conversations started per day", which would read as
thread activity and is not what it measures.

An "active conversations" metric — threads that received at least one message in the period, which
is what most people mean by conversation volume — would need a seventh counter, its own write-path
hook and a third backfill. Explicitly deferred, not overlooked. If it is added later it goes
*beside* this figure, never replacing it, since the two answer different questions.

The guard stays per-conversation because that is the semantics its name claims, it matches what the
backfill computes over history, and it keeps the counter correct with no migration if
one-conversation-per-contact ever stops holding. Future-proofing, not a difference that exists
today.

#### Week boundaries

Weekly buckets start **Monday**, matching `localMondayIndexFromMs` in `lib/dashboardDate.ts`, which
`dashboard.responseTime` already uses for its week-over-week figures. A partial leading or trailing
week in the selected range is reported as-is and labelled partial, rather than being dropped or
silently compared against a full week.

#### Why `responseBuckets` is a histogram, not a threshold counter

A single `responseWithinTarget` counter bakes one SLA threshold in at write time. Changing the
target from 5 minutes to 15 would make all accumulated history meaningless, with no way to
recompute it — the raw latencies are gone.

Six bucket counters cost the same single patch:

```
responseBuckets: { m1, m5, m15, m60, m240, over }
```

Any threshold on a bucket edge becomes exact, the target becomes a UI control instead of a
constant, and p50/p90 become derivable by interpolation. Percentiles are labelled as a range
(e.g. "p90: 15–60 min"), never as a false-precision figure.

The current SLA target is a hardcoded `thresholdMinutes = 5` default in
`response-performance.tsx`. It stays the default; the histogram is what makes it adjustable.

### Every query takes a window bounded at BOTH ends

**Correction to an earlier draft, which specified only `sinceMs`.** Every query takes
`sinceMs` *and* `untilMs`. `untilMs` is the exclusive end of the window.

- On `messageHourlyStats` the range is `.gte(hourStartMs(sinceMs)).lt("hourStartMs", untilMs)` — the
  lower edge is rounded down to the containing hour so the first partial hour is not dropped; the
  upper edge is **not** rounded, or the final partial hour would be.
- On raw tables the range is `.gte("_creationTime", sinceMs).lt("_creationTime", untilMs)`, unrounded
  at both edges, because those are row timestamps rather than bucket keys.

The upper bound is load-bearing, not tidiness. This document previously claimed *"extra hours at the
edges are harmless — every fold discards keys it was not asked for."* **That is false.**
`foldHoursIntoHourOfDay`, and `responsePerformance`'s equivalent hour-of-day pass, take no `keys` and
fold every row handed to them. Without an upper bound, any window not ending at "now" renders a
per-hour chart pooled over a wider span than the series beside it — two numbers on one panel computed
over different periods, with nothing to reveal it.

`src/lib/reports/types.ts`'s `reportWindow()` must therefore return `untilMs` as well.
`conversationStatusMix` and `awaitingReplyAges` are current-state and take no window at all.

### Reads that scan raw tables

Three panels scan raw tables rather than the rollup. Each is justified separately:

| Scan | Bound | Why it is safe |
|---|---|---|
| `adReferrals.by_account` ≥ cutoff | window | per-*conversation*, not per-message — one to two orders of magnitude smaller than `messages` |
| `funnelTransitions.by_account` ≥ cutoff | window | `campaigns.overview` already does exactly this over 365 days |
| `conversionEvents.by_account` ≥ cutoff | window | same, same query |
| `campaignAds.by_account` | table | one row per ad ever seen; a resolution cache, not an event log |
| conversation status mix | capped take per status | same `ACTIVE_CONVERSATIONS_CAP` pattern, reports `capped` |
| awaiting-reply backlog | capped take | ranges `awaitingReply` on `by_account_lane_last_message`, reports `capped` |

The Ads panel is the one read that grows with volume rather than being pinned by the window alone.
Mitigation is a window bound plus an explicit `truncated` flag at 100 ads — never a silent cut. The
documented escape hatch, if measurement shows it is needed, is a per-`(account, adId, day)` rollup.
It is not built speculatively.

## Panels

### 1 · Conversations

One query returns everything from a single `by_account_hour` index read: daily series, weekly
series, a 7×24 hour-of-day heatmap, and range totals.

- **New conversations** per day and per week, split ad vs direct. Labelled "New conversations", not
  "Conversations started" — see the owner decision above; a contact opens exactly one conversation,
  so this is first engagement, not thread activity. Partial leading and trailing weeks are marked as
  such, in the chart and in the CSV, because the trailing week is always partial unless today is a
  Sunday and an unmarked short bar reads as a collapse in volume.
- Messages in vs out per day
- Range totals: total started, avg/day, % from ads, total sent, total received
- Hour-of-day heatmap of inbound volume

A second small query returns the current open/pending/closed/archived mix via capped takes.

### 2 · Ads

Three window-bounded scans joined in memory. One row per ad:

campaign › ad set › ad · conversations · first-touch leads · qualified · purchased · sale
value · matched service

#### Three ways to count an ad conversation, and none is a subtotal of another

This is the highest-risk part of the feature and the UI must not obscure it. The same underlying
traffic is counted three different ways, all deliberate:

| Figure | Unit | Rule |
|---|---|---|
| `conversationsStartedAd` (Conversations tab) | per conversation | counts once, and only if the conversation's *earliest* referral was an ad |
| `adPerformance.conversations` (Ads tab) | per ad | one conversation counts under *every* ad that touched it |
| `firstTouchLeads` (Ads tab) | per **contact** | the contact's first-ever ad referral |

`adPerformance` deliberately omits the earliest-referral guard so an ad that re-engaged an existing
thread still gets credit for it. So `sum(rows.conversations)` and `conversationsStartedAd` are not
reconcilable in either direction — an `"ad"` referral carrying no `adId` (a Status placement) even
bumps the counter while being skipped by the Ads table entirely.

**Consequences for the UI:** do not place these figures where they read as cross-checkable, do not
present one as a subtotal of another, and do not label `firstTouchLeads` simply "Leads" — it is a
per-contact figure sitting in a per-ad row, and the plain label invites reading it as a funnel step
between conversations and qualified. It is not.

Sorting is client-side over the returned rows. The server always truncates by **conversations
started, descending**, so the 100 rows returned are the 100 largest by volume regardless of how the
table is then sorted — re-sorting by sale value cannot surface a 101st ad that was never sent. The
`truncated` flag says how many ads were dropped, so the table never implies it is exhaustive.

Ads whose `campaignAds` row has not
resolved show the raw ad id, plus a banner counting `pending` / `dormant` / `abandoned`
resolutions — that is ops information about the resolver, not an error to hide.

Expanding a row shows its funnel bar, matched service and landing URL from data already fetched, so
the drill-in costs no additional read.

**Deliberately absent:** average response time per ad. The rollup has no ad dimension, and a
plausible-looking number that cannot be computed exactly is worse than no column.

### 3 · Response

From the rollup:

- Avg first reply per day across the range
- % within target, with the target selectable (1 / 5 / 15 / 60 min) and exact at every bucket edge
- p50 / p90 as interpolated ranges
- Avg by hour-of-day, to expose which hours drag

Plus a live backlog from a capped take: threads still awaiting a reply, bucketed by age of
`pendingCustomerAtMs` (<1h, 1–4h, 4–24h, >24h).

### 4 · Funnel

`campaigns.overview` re-homed, with one change: the range picker replaces its hardcoded
`WINDOW_DAYS = 365`. Stage-by-stage counts, purchase count, recorded value.

The existing distinction is preserved and re-stated in the UI copy: recorded value comes from
`funnelTransitions.saleValue` (which exists for organic conversations too), not from
`conversionEvents` (which exists only for attributed ones). It is "recorded value", not "reported
to Meta".

### 5 · Billing & conversions

From the rollup: total Meta conversations per day, free-entry-point conversations, and billed
messages by category (marketing / utility / service / authentication / free / other).

A *billable* figure is rendered as a derived tile — `metaConversations − freeEntryPointConversations`
— explicitly labelled as derived, with each tile's subtitle naming its inputs. `metaConversations`
is never labelled "Billable" on its own: free-entry-point windows are a subset of it, so that label
would overstate Meta's charge by exactly the free count.

Conversion events by delivery status live on the **Funnel** tab, alongside the stage counts they
belong with — not here.

**Forward-only:** the three billing counters have no backfill, so any range extending back before
the write path deployed shows real zeros for those periods. The panel surfaces a note whenever the
range's earliest period has no billing data, not only when the whole range is empty — otherwise the
day-one state of every account is a chart ramping from zero with nothing to explain it.

**Honesty constraint:** Meta's webhooks carry billing *categories and counts*, never rate-card
amounts. This panel reports volumes by category and says so in its subtitle. It will not display a
currency figure it cannot know. Real spend in dirhams requires the Marketing API pull that was
scoped out of v1.

### Export

Every panel offers CSV export of exactly what is on screen, serialized client-side from data
already loaded. No new queries, no server-side export path.

## Testing

Every `convex/` module here has a paired `*.test.ts`, and per `AGENTS.md` that test is the most
reliable description of the module's behaviour. Beyond per-query coverage, four tests pin the
things that would silently corrupt numbers rather than fail loudly:

1. A repeated `sent` → `delivered` → `read` callback sequence increments the pricing counters
   **exactly once** (the `message.pricing === undefined` guard).
2. A second `adReferral` on a conversation that already has one does **not** re-count it as a new
   ad-sourced conversation.
3. Each backfill is idempotent and resumable — running it twice produces identical totals.
4. Every query throws `FORBIDDEN` below supervisor, and the page skips rather than fires.

Bucketing logic (day, week, hour-of-day, percentile interpolation) lives in `lib/messageStats.ts`
as pure functions and is tested there, without a database.

## Rollout

Order matters, and the UI is last — **which means the backend deploys before the branch merges**,
not after. Netlify builds production from `main`, so merging publishes the frontend immediately. Merge
first and `/reports` fires queries the deployed backend does not have; `useQuery` re-throws
synchronously during render, and with no Error Boundary the route crashes — while `/campaigns` has
already been redirected away. That is an availability failure, not a cosmetic one.

Deploying the backend ahead of the merge is safe precisely because steps 1 and 2 below are
unobservable: optional additive fields, and queries nothing calls yet.

Order:

1. **Schema counters.** All optional, all absent-means-zero. Nothing observable changes.
2. **Write paths.** Counters begin accumulating.
3. **Backfills.** One-shot internal mutations over history, following the existing
   `backfillMessageHourlyStats` / `backfillResponseHourlyStats` paginated, resumable shape. Run one
   chain at a time and let it finish: they are idempotent per chain but **not** concurrency-safe —
   two overlapping runs each SET the same buckets, and a bucket measured from a partial view is
   written as if complete.
4. **UI.**

Shipping the UI before step 3 would render a chart ramping from zero on deploy day, which reads as
"we had no traffic last month" — a confidently wrong report is worse than a missing one.

**Only two of the six counters are backfilled.** `conversationsStarted` / `conversationsStartedAd`
rebuild exactly; `responseBuckets` rebuilds *approximately* (the raw latencies are gone, so an
historical hour's whole sample count is placed in the bucket its stored mean falls into, and hours
already carrying an exact histogram are skipped). **The three billing counters have no backfill at
all** and are forward-only by design — billing history reads zero for every period before deploy
day, and the panel must say so rather than letting "not collected" and "nothing happened" render
identically.

**Two deploy-window artefacts, both self-healing, both worth handling in the UI:**

- Between the write-path deploy and backfill completion, an ad referral landing on a pre-deploy
  conversation produces an hour with `conversationsStartedAd > conversationsStarted` — i.e. a
  negative "direct" bar if the UI computes `started - ad`. Clamp with `Math.max(0, …)`.
- `responsePerformance.samples` is histogram-derived while `series[].samples` is `responseCount`-
  derived. They disagree for every row predating the write path, and permanently for the single hour
  straddling the deploy, since `backfillResponseBuckets` skips any row that already has a histogram.

**Operational note.** This adds functions to `convex/_generated/api.d.ts` and therefore needs
codegen and a deploy. Per the owner's standing rule, `convex deploy` / `dev` / codegen are not run
unprompted; they remain the owner's call, from a clean `origin/main` worktree. The backfills are
one-shot internal mutations triggered deliberately, not crons.

## Risks

**New counters land on the app's hottest mutation.** Each is an additional field on a patch that
already happens — no extra read, no extra document, no extra index lookup. Per-message cost is
unchanged. Stated explicitly because this is the exact code path behind two production incidents.

**The Ads panel is the one read that grows with volume.** Window bound plus an honest truncation
flag is the v1 answer, with a per-ad-per-day rollup as the documented escape hatch. Measure before
building it.

**Half-hour timezone offsets** (India +05:30, Nepal +05:45) can misplace up to one hour of traffic
across a local midnight. This is pre-existing, documented in `lib/messageStats.ts`, and exact for
Asia/Dubai (UTC+04:00) where this CRM runs. The new panels inherit the caveat rather than
introducing it.

**Backfill over a large `messages` table.** Mitigated by the paginated, resumable precedent already
in `messages.ts`, and by the fact that a partially-completed backfill under-counts old days rather
than erroring — readers treat absent as zero.

## Out of scope

- Meta Marketing API spend, impressions, clicks; therefore cost-per-lead and ROAS.
- Per-agent SLA breakdown (deferred to a final separable phase; needs a second rollup table).
- Scheduled or emailed report delivery.
- Currency figures in the billing panel.
- Per-ad response time.
