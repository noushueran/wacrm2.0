# Reports → Events tab — design

**Date:** 2026-09-03
**Status:** approved, planning

## Problem

Meta's Events Manager holds the ground truth for what dataset
`2683479032111674` ("Amani WhatsApp (CTWA) Events") actually received — on
2026-09-02 it showed 8 `QualifiedLead` events. That number lives on
facebook.com and nowhere else. Nobody on the team can answer the two
questions that matter without leaving the product:

1. **Does Meta's count match ours?** If we believe we produced 9 qualified
   leads and Meta recorded 8, one lead's quality signal never arrived —
   and Meta optimizes ad delivery on what it received, not on what we meant
   to send.
2. **When they disagree, why?** Events Manager cannot tell you. It has no
   knowledge of a lead that never generated a deliverable event.

`/reports` already carries six tabs built on our own data. It has no view of
the Meta side of the same funnel, so the CAPI integration — the mechanism the
whole lead-quality programme depends on — is unobservable from inside the app.

## Solution

A seventh tab, **Events**, that puts three counts per Meta event side by side
and explains every gap between them.

| Column | Source | Question it answers |
|---|---|---|
| **Reached** | `conversionEvents`, distinct `conversationId` | how many leads hit this milestone |
| **Delivered** | same rows, `status === "sent"` | how many we successfully posted to Meta |
| **Recorded** | `metaEventDailyStats` (new), synced from the Graph API | how many the dataset actually holds |

`Reached − Delivered` is **our** problem and is fully self-explaining: every
row that fell short carries a `status` (`unmatched`, `dormant`, `error`,
`pending`, `abandoned`) and a `lastError`.

`Delivered − Recorded` is the **boundary** problem: dedup, rejection, or
ingestion lag on Meta's side.

### Why not the alternatives

- **Mirror Events Manager only** (Meta's counts, no comparison): rejected.
  Reproduces a screen that already exists, and still cannot explain a gap.
- **CRM vs Meta, two columns**: rejected. A delta with no delivery-status
  breakdown tells you something is wrong and nothing about where, which is
  precisely the position we are in today.
- **Ads Insights `actions` instead of dataset stats**: rejected as the primary
  source. Those are *attributed*, window-bounded and Meta-deduped — a
  different population that cannot tie out to dataset totals, so presenting
  it beside our raw counts would invite a false reconciliation. Retained as a
  possible later addition on its own row, clearly labelled.

## Data model

### Reading our two columns

Both come from **one** index range over `conversionEvents`:

```ts
.withIndex("by_account", (q) =>
  q.eq("accountId", ctx.accountId)
   .gte("_creationTime", sinceMs)
   .lt("_creationTime", untilMs))
```

This is the same read `reports.funnelOverview` already performs for the Funnel
tab (measured at ~4,053 rows for a 30-day window on production), so the Events
tab introduces no new cost *shape* — only a second instance of an accepted one.
Grouping is by `eventName`, with `stage` retained for the milestone label.

`conversionEvents` is the right source rather than the `funnelHourlyStats`
rollup, for the reason `funnelOverview`'s own comment already documents: stage
transitions under-report the middle of the funnel because `neverDowngrade`
refuses out-of-order stage moves, while the event rows record every milestone
that actually occurred. The rollup's `eventsByStatus` counters are also keyed
by status alone, not by event name, so they cannot produce a per-event table.

### `metaEventDailyStats` (new)

```ts
metaEventDailyStats: defineTable({
  accountId: v.id("accounts"),
  datasetId: v.string(),      // pinned, so a dataset change cannot silently blend
  dayKey: v.string(),         // "YYYY-MM-DD" in the DATASET's timezone
  eventName: v.string(),      // Meta's wire name: LeadSubmitted, QualifiedLead, …
  count: v.number(),
  syncedAt: v.number(),
}).index("by_account_dataset_day_event",
         ["accountId", "datasetId", "dayKey", "eventName"])
```

One index, not two. With `accountId` + `datasetId` bound as equalities it
serves the windowed read as a `dayKey` range, and with `eventName` appended it
serves the upsert's point lookup — so there is no second index to keep in sync.

**Upsert, never insert.** Re-syncing a day overwrites its counters, so a
late-arriving event or a re-run corrects the number rather than doubling it.
The cron re-syncs a trailing window (default 3 days), because Meta's counts
settle after the fact.

### Timezone — the load-bearing decision

This codebase's standing convention is that day boundaries are decided at
**read** time from the viewer's `tzOffsetMinutes`, never at write time
(`schema.ts`, `messageHourlyStats` header; `reports.ts` passes
`tzOffsetMinutes` into every windowed query).

**`metaEventDailyStats` cannot follow that convention, and the reason is a
property of the source rather than a choice.** Meta returns counts already
bucketed into whole days in the dataset's own business timezone. That boundary
is baked into the numbers before we see them; it cannot be re-bucketed on read.

Therefore **the Events tab pins all three columns to the dataset's timezone**,
not the viewer's, and labels this on the panel ("days as Meta reports them —
<tz>"). Our two columns are folded with that same offset.

The alternative — our columns on the viewer's local day, Meta's on Meta's day —
produces phantom deltas at every window edge that look like delivery failures
and are not. This is the same class of error that made the 7-day Ads figure
22.7% high (`funnelOverview`'s header): a mismatched day boundary, not a
mismatched count.

The dataset's timezone is **fetched and stored**, never assumed to be UTC+4.
If it cannot be determined, the Meta column degrades (below) rather than
guessing.

## Sync

A daily cron action, `metaEventStats.syncDatasetStats`, using **the credential
path delivery already uses** — `META_CAPI_DATASET_ID` from env, WABA
system-user token from `whatsappConfig` (`process.env.META_CAPI_ACCESS_TOKEN`
honoured as the documented override). No new secret, no new settings UI: the
tab is connected the moment it ships, which is the requirement.

## Unverified dependency — RESOLVED 2026-09-03: the endpoint does not exist

**Status: the Recorded column cannot be populated from a documented public
API. Events Manager is the only surface for these counts.** The fallback
this section describes is now the permanent design, not a contingency.

Recorded below so nobody re-runs this investigation.

### What was tested, against the live dataset

`capiStatsProbe` was run against dataset `2683479032111674` with the WABA
system-user token, after deploying to production:

| Probe | Result |
|---|---|
| `GET /{id}/stats?aggregation=event` | `200 {"data": []}` |
| `GET /{id}/stats?aggregation=host` | `200 {"data": []}` |
| `GET /{id}/stats?aggregation=device_type` | `200 {"data": []}` |
| `GET /{id}/stats?aggregation=event_total_counts` | `200`, rows carrying only `aggregation` + `start_time` — no event names, no counts |
| `GET /{id}?fields=timezone_name` | `400 (#100) Tried accessing nonexisting field (timezone_name)` |
| `GET /{id}?fields=id,name,owner_business` | `200` — dataset identity confirmed |
| Graph API Explorer (User Token) | `400 (#100) Missing Permission` |

The probed window (2026-08-27 → 2026-09-03 UTC) contained 8 `QualifiedLead`
events per Events Manager, so the empty responses are not an empty dataset.

### Why it does not exist

The `/stats` edge is a **web-pixel diagnostic**. Its aggregations — `host`,
`device_type`, `url` — are web concepts, and a business-messaging dataset
does not populate it. Meta's
[Dataset Quality API](https://developers.facebook.com/docs/marketing-api/conversions-api/dataset-quality-api/)
is the closest documented alternative and is unsuitable twice over: it
returns quality *percentages* rather than raw counts, and it is explicitly
web-events-only. No Meta documentation describes a per-event read-back for
business-messaging datasets.

The Graph API Explorer cannot be used to explore this further: it issues a
User Token, and this dataset is business-owned, so permission is refused
before the aggregation is even validated. Only the system-user token
reaches it — the credential that must not be pasted into a browser.

### Two consequences worth carrying forward

**`timezone_name` is absent from both surfaces**, so the design's
"fetched, never assumed" rule has nowhere to fetch from. This is what makes
the sync fail closed today, and it is why the tab degrades rather than
inventing zeros — see below.

**The degradation ORDERING prevented a false zero, and that was luck rather
than design.** The missing timezone makes `syncDatasetStats` `fail()`
*before* it reaches the empty-`data` branch. Had `timezone_name` been
present, the observed `{"data": []}` would have taken the "a genuinely
empty `data: []` is a legitimate `available: true`" path — deliberately
treated as truthful — and reported zero recorded events against real
delivered ones: a false delivery failure on every row, which is the exact
harm this tab exists to prevent. Anyone revisiting that branch should
understand it is load-bearing and currently guarded only by an accident of
ordering.

### What remains true

- `capiStatsProbe` stays: it is how this was settled and how a future Meta
  change would be re-tested. It takes `aggregation`, `days` and `fields`.
- The **Recorded** column renders `—` with a stated reason and a link to
  Events Manager. It is never `0`.
- The tab's value is the **Reached → Delivered** gap, which we own end to
  end and which explains itself by delivery status. Only the
  Delivered → Recorded comparison is lost.

### Rejected: substituting Ads Insights

`/act_<id>/insights` with `action_type` breakdowns does return CTWA
conversion numbers, and was reconsidered here. Still rejected as a
substitute: those are *attributed*, window-bounded and Meta-deduped — a
different population that cannot tie out to what we sent. Putting it in the
Recorded column would produce a number that looks comparable and is not,
which is the failure mode this tab exists to prevent. It remains available
as a clearly-labelled separate signal if attribution data is ever wanted.

### The degraded message — fixed in the PR that follows this one

The tab used to report `unavailable — dataset timezone could not be
determined`. Accurate about the proximate cause, misleading as a standing
message: it invited a reader to hunt for a timezone setting that exists
nowhere.

The two unresolvable-offset cases now read differently, because only one is
actionable:

- **`timezone_name` absent** — the known permanent state. Reads "the dataset
  does not expose per-event counts (its /stats response carries no
  timezone_name and no event rows). Events Manager is the only source for
  these."
- **`timezone_name` present but unparseable** — a real timezone fault Meta
  could fix. Keeps the original wording, including the offending value.

Both still degrade to `—`; neither is ever a zero.

## UI

New `events` tab in `REPORT_TABS` (`src/lib/reports/types.ts`), placed between
`funnel` and `billing`: it is windowed like them, and belongs beside the funnel
it reports on rather than next to the unwindowed `activity` feed.

`src/components/reports/events-panel.tsx`, taking the standard
`ReportPanelProps`. One row per Meta event, in `FUNNEL_STAGES` order:

```
Milestone (ours)   Meta event        Reached  Delivered  Recorded   Δ
New lead           LeadSubmitted        142       118       116     −2
Qualified lead     QualifiedLead          9         8         8      0
Price quoted       InitiateCheckout       4         4         4      0
Itinerary sent     AddToCart              2         2         2      0
Invoice sent       OrderCreated           0         0         0      0
Purchased          Purchase               1         1         1      0
```

- Each row **expands** to the status breakdown behind its Reached→Delivered
  gap, with the most recent `lastError` per status.
- Internal-only milestones (`itinerary_created`, `lost`) are listed greyed as
  "not sent to Meta" rather than omitted — dropping them implies our funnel has
  six stages when it has eight.
- Header strip: dataset name, dataset ID, last successful sync, the pinned
  timezone, and a deep link to Events Manager.
- CSV export via the existing `downloadCsv`, matching the other panels.
- Constants shared with the panel live in `convex/lib/reportStats.ts`, never
  imported from `convex/reports.ts` — that module pulls `accountQuery` and the
  whole role-check machinery into the browser bundle (see `ads-panel.tsx`).

Backend query: `reports.metaEventReconciliation`, `accountQuery` +
`ctx.requireRole("supervisor")`, matching every sibling.

Copy goes in `messages/en.json` under `Reports.events.*`; `en` is the only
locale.

## Testing

`convex/lib/metaEventStats.test.ts` — pure folds, no harness, per the
`reportStats.ts` convention:

- day-key alignment: our rows and Meta's counts land in the same bucket for a
  non-UTC dataset timezone
- upsert idempotence: syncing the same day twice yields the original count
- exhaustive status fold: a status added to the schema union without being
  added to the breakdown is a compile error, not a silently uncounted row
- degradation: a Graph error yields the unavailable state, never `0`

`convex/metaEventStats.test.ts` — the sync action against a mocked Graph
response, including the unconfigured-dataset and missing-token paths.

Panel test: a row with no Meta data renders unavailable, not zero.

**Note:** new files under `convex/` fail the codegen drift guard until the
owner runs codegen. Expect that, and do not run codegen unprompted.

## Out of scope

- Backfilling Meta counts for days before the first sync. Meta's stats
  retention is unknown; the tab shows the range it has and says so.
- Any change to what we send. This spec is read-only with respect to the
  delivery path.
- Ads Insights attributed conversions (see rejected alternatives).
