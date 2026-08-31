# Active Conversations Metric — Design

**Date:** 2026-08-06
**Status:** Draft, awaiting owner review
**Scope:** A seventh counter on `messageHourlyStats` measuring how many distinct conversations saw
traffic in a period, plus its tile and chart on the Reports Conversations tab.

## Problem

`/reports` ships with `conversationsStarted`, which counts a contact's *first* conversation. That
figure is correct and honestly labelled "New conversations", but it does not answer the question
people actually ask of a CRM: **how many conversations were happening?**

It cannot, because every conversation-creating path in this repo is find-or-create *by contact*
(`ingest.ts`, `conversations.findOrCreateForContact` and its server-only twin,
`qualificationEngine.ts`). A contact has exactly one conversation, forever. So
`conversationsStarted` measures lead acquisition, and a busy month of replies to existing customers
moves it not at all.

The 2026-08-05 reports spec recorded this metric as explicitly deferred rather than overlooked, and
recorded that if added it must sit *beside* the existing figure, never replace it — the two answer
different questions and neither is a subtotal of the other.

## Decision taken

**"Active" means any message, inbound or outbound.** A thread counts for a period if it saw any
traffic at all — customer message, agent reply, or bot reply.

Rejected: counting only threads where the customer wrote. That is arguably the truer engagement
measure, but it reads lower than anyone expects and does not reflect the workload the team actually
carried. Rejected too: shipping both as separate counters — two fields, two write hooks and two
backfills for a distinction nobody asked for. YAGNI.

## Architecture

### The counting problem, and the constraint that shapes everything

A plain counter would count **messages**, not distinct conversations. A thread that receives twenty
messages must contribute one, not twenty.

That much is easy. The hard part, and the thing an earlier draft of this document got wrong:
**distinct counts are not additive across time buckets.** Deduping per hour and folding hours into a
day *sums* them, so a thread active at 9am and again at 3pm contributes 2 to that day. The result
would be conversation-*hours*, and on a busy day it can exceed the account's total conversation
count — a number a reader spots as wrong immediately.

The consequence is unavoidable and worth stating plainly: **the metric is exact only at the
granularity it is deduped at.** Everything below follows from choosing that granularity.

Three ways to get distinctness:

| Approach | Cost | Verdict |
|---|---|---|
| **`lastActiveDayMs` on `conversations`** | zero extra reads, zero extra documents | **chosen** |
| A `conversationActivity` table, one row per (conversation, day) | one row per thread per active day, growing without bound | rejected |
| Compute at read time from `messages` | unbounded read | rejected — this is what took `/dashboard` down twice |

### Why the UTC day, and not the local day

The dedup granularity is the **UTC day**. Deduping per *local* day is what a reader would naively
want, and it is not available: a Convex function runs in UTC and the viewer's offset arrives per
request, so a local-day dedup would have to pick a timezone at write time. That is exactly the
constraint that made the whole rollup hourly-UTC in the first place.

The resulting error is bounded and small in practice. A UTC+4 local day spans UTC 20:00 (previous
day) through 19:59, i.e. two UTC days. A thread counts twice within one local day only if it was
active both **before roughly 04:00 local** and again later that day. Traffic inside normal business
hours — 09:00 to 18:00 local, which is 05:00 to 14:00 UTC — falls entirely within one UTC day and
counts exactly once. Overnight-then-daytime threads over-count by one.

This is the same class of caveat, with the same reasoning, as the half-hour-offset note already
documented in `lib/messageStats.ts`, and it is exact nowhere except by accident. It is documented
here and surfaced in the tile's own copy rather than left for someone to discover.

### The chosen mechanism

`conversations` gains one optional field:

```
lastActiveDayMs: v.optional(v.number())   // UTC midnight of the day last counted
```

`insertMessageAndUpdateConversation` — the single `insert("messages")` choke point in the backend —
already holds the conversation document and already builds a `patch` object for it
(`lastMessageText`, `lastMessageAt`, `awaitingReply`, and more). So the hook is:

1. Compute `day = utcDayStartMs(now)` and `hour = hourStartMs(now)`.
2. If `conversation.lastActiveDayMs !== day`, bump `activeConversations` on the **hour** bucket's
   `messageHourlyStats` row — the hour containing this message, which is this conversation's first
   message of that UTC day.
3. Set `lastActiveDayMs: day` in the patch that is already being written.

Deduping per day while *storing* per hour is deliberate. The rollup stays hourly, so the existing
window read and the local-day fold both work unchanged; each increment simply means "one
conversation's first activity of a UTC day landed in this hour". Summing hours into a local day then
yields the local day's distinct count, exact except for the boundary case above.

No extra read **of the conversation** — that document is already in hand, and the dedup is a field
comparison on it, not a lookup. No extra document — one more field on an existing patch, one more
counter on an existing rollup row. The comparison *is* the dedup, in the same way
`applyStatusPricing`'s `!prev || differentConversation` branch is.

To be precise, since read cost is this codebase's sore spot: the bump itself does perform one
indexed `by_account_hour` point lookup on `messageHourlyStats`, and only on a conversation's **first
message of a UTC day**. Every subsequent message that day skips it on the field comparison alone.

`messageHourlyStats` gains a seventh optional counter:

```
activeConversations: v.optional(v.number())
```

Optional and absent-means-zero, matching the six that shipped on 2026-08-05, so deploying the schema
changes nothing observable.

### Why this hooks the message insert and not the conversation patch

`insertMessageAndUpdateConversation` is the one site that both writes a message and holds its
conversation. `recordMessageInHourlyStats` and `recordResponseSample` already hook there for exactly
this reason — every send path funnels through it, so a rollup cannot drift from the raw rows unless
someone adds a second insert site without one. This counter inherits that guarantee.

### Read path

`reports.volume` gains `activeConversations` in its series and totals. It reads the same
`messageHourlyStats` rows it already reads for the window — **no additional read**, since the counter
rides a row already being fetched. `foldHoursIntoVolume` in `convex/lib/reportStats.ts` gains the
field alongside the four it already folds.

### Backfill

Rebuilt from `messages`, grouping by `(conversationId, utcDay)` and attributing each distinct pair to
the hour of that pair's **earliest** message — mirroring exactly what the live path writes.

The batching is the subtle part. `backfillMessageHourlyStats` withholds the final partial hour of a
batch and rewinds its cursor to that hour's start, which guarantees an *hour* never straddles two
batches. It does **not** guarantee that about a *day*, and this backfill needs day-level
distinctness. So it withholds the final partial **UTC day** instead, resuming at that day's start —
the same idea one unit coarser.

That raises the batch's worst case from one hour of messages to one day of messages, so the batch
size is chosen against a day of traffic rather than an hour. The single-unit-overflow guard is
retained in the same shape: a batch entirely within one UTC day writes what it measured, warns, and
steps past, rather than rewinding to where it already was and looping forever.

Like its siblings it is idempotent per chain — each pass SETs a bucket to what it measured — and
**not** concurrency-safe: run one chain and let it finish.

`lastActiveDayMs` itself needs no backfill. It is a forward-looking dedup marker; an absent value
simply means the next message counts its day, which is correct.

## UI

Conversations tab, in this order:

- A **fifth** tile, placed **last** in the row, titled **"Conversations with activity"**. Its
  subtitle names the definition — any message in or out — because "active" is the kind of word every
  reader defines slightly differently.
- A separate compact chart below the volume chart, plotting the metric per day.

**The tile is an AVERAGE PER DAY, not a range total** — rendered as e.g. `8.0 avg/day`. The backend's
`totals.activeConversations` is a sum of per-period distinct counts, which is conversation-*days*,
not distinct conversations; presenting it raw would show ten threads active daily over thirty days as
**300**. Dividing by the range's day count is the honest figure, and the unit belongs in the value
because the four sibling tiles are all range totals and a bare `8.0` beside `240` reads as a
contradiction.

**Not titled "Active conversations".** `/dashboard` already ships a tile with that exact title for a
completely different metric — a live count of currently-*open* threads, capped at 500. A state, not a
flow. Two tiles, one label, two meanings, both visible to the same supervisor, is the confusion this
whole feature exists to avoid.

**At weekly granularity the chart shows AVERAGE DAILY ACTIVE, not a weekly total.** Summing a week's
daily counts would repeat, one level up, exactly the bug this design was rewritten to avoid: a thread
active on Monday and Thursday would contribute 2 to the week. The average is the honest figure the
stored data actually supports, and a week-only chart legend carries a static "avg/day" alongside the
tooltip, so the number is never read as a weekly distinct count. For a partial week the denominator
is the days of that week actually inside the range, which the panel already tracks for its
partial-week marking.

**The CSV exports the raw per-period count plus a `days_in_period` column.** The count alone would be
the same non-additivity in a spreadsheet — and unrecoverable, since every range has two partial weeks
whose denominator is not 7. Exporting numerator and denominator lets the reader compute the average
correctly for any period.

Deliberately **not** a fifth series on the existing volume chart. That chart already carries stacked
ad/direct bars plus incoming and outgoing lines; a third line past that stops being readable, and
this is the series most worth looking at on its own.

The tile and chart honour the conventions the other four panels established: `null`/absent reads as
zero rather than `NaN`, an empty range renders the shared `EmptyState` rather than a chart of zeros,
partial weeks stay marked at weekly granularity, and the CSV export gains an
`active_conversations` column.

**The two figures must not read as reconcilable.** `activeConversations` and `conversationsStarted`
overlap — a brand-new conversation is also an active one — but neither contains the other across a
window, since an old thread can be active without being new. No total row, no derived percentage
between them, and the tile subtitles say what each counts.

## Testing

Four tests carry the design; the rest is ordinary coverage.

1. **A thread messaged many times across many hours of one UTC day counts exactly once.** This is the
   property the whole rewrite exists for. Verify it fails under a per-hour dedup, not just under a
   naive per-message increment — a per-hour version passes the trivial "twice in one hour" test and
   is still wrong.
2. **The same thread messaged again the next UTC day counts again**, so the dedup marker does not
   latch permanently.
3. **The backfill is idempotent** — running the full chain twice converges rather than doubling — and
   its per-day distinctness survives a chain that spans several batches, which is what the
   withheld-partial-day logic exists to guarantee.
4. **The backfill's counts equal what the live write path produces for identical traffic.** This is
   the divergence class that bit `conversationsStartedAd` on the previous branch, where the live rule
   and the rebuild rule quietly disagreed and both looked plausible.

Plus: pure fold tests including absent-counter-reads-as-zero and a non-zero `tzOffsetMinutes`;
weekly granularity returning an average rather than a sum; and `reports.volume` returning the new
field while still throwing `FORBIDDEN` below supervisor.

## Rollout

Same order the reports section established, and for the same reason:

1. Schema — optional, additive, unobservable.
2. Write path — the counter begins accumulating.
3. Backfill — one chain, let it finish.
4. UI.

**Deploy the backend before merging.** Netlify builds production from `main`, so merging publishes
the frontend immediately; the UI must not reach production ahead of a query that returns the field.

## Risks

**The hot path gains one comparison and one field.** No extra read, no extra document, and the patch
it joins already happens on every message. Stated explicitly because this is the same code path
behind two prior production incidents.

**`lastActiveDayMs` adds a field to `conversations`**, not to a rollup table. That table is read by
the Inbox on every list render. The field is optional and nothing reads it except this hook, so no
index and no query changes — but it is the first counter-support field to live outside
`messageHourlyStats`, which is a precedent worth noting rather than repeating casually.

**The metric over-counts a thread active both before ~04:00 local and later the same day**, because a
UTC+4 local day spans two UTC days. Bounded at one extra per thread per day, invisible for
business-hours traffic, and surfaced in the tile's copy rather than hidden.

**Half-hour timezone offsets** can misplace one hour of traffic across local midnight — pre-existing,
documented in `lib/messageStats.ts`, exact for Asia/Dubai where this runs.

**The backfill's batch now spans a UTC day rather than an hour**, so its worst-case read is a day of
messages rather than an hour of them. Sized accordingly, with the overflow guard retained — but it is
a real increase over the sibling backfills and the reason the batch size is not simply copied from
them.

## Out of scope

- A separate "engaged conversations" counter for customer-authored traffic only.
- Per-agent activity breakdown.
- Backfilling `lastActiveDayMs`.
- An exact weekly distinct count. The stored data cannot support one; the weekly view shows average
  daily active instead.
- Any change to `conversationsStarted`, which stays exactly as it is.
