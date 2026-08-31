# Roster work counts from the hourly rollup — design

Date: 2026-08-09
Status: approved for implementation
Depends on: the `aiUsageHourlyStats` rollup (see Prerequisite)

## Problem

`agentRoster.roster` derives every agent's "work today" by reading today's raw
`aiUsageLog` rows and bucketing them onto the agent that owns each mode:

```ts
const usageRows = await ctx.db
  .query("aiUsageLog")
  .withIndex("by_account", (q) =>
    q.eq("accountId", ctx.accountId).gte("_creationTime", sinceMs),
  )
  .take(ROSTER_SCAN_WINDOW);          // 1024
const work = tallyWork(usageRows);
const workOverflow = usageRows.length >= ROSTER_SCAN_WINDOW;
```

Measured against production on 2026-08-09, this account logs **~4,084 AI calls
per day**:

| mode | calls/day | attributed to |
| --- | --- | --- |
| `embed` | 1,963 | nobody (shared sense) |
| `qualify` | 1,307 | Qualification agent |
| `auto_reply` | 597 | Reply agent |
| `score` | 163 | Lead scorer |
| `transcribe` | 31 | nobody (shared sense) |
| `checklist` | 19 | Checklist writer |
| `describe` | 4 | nobody (shared sense) |

The 1024-row cap is therefore hit **every single day**, on roughly the first
quarter of the day's volume. `workOverflow` is permanently true and the `+`
suffix it drives is permanently on.

Two things make this worse than "the number is a bit low":

1. **The count freezes.** `.take()` returns the *earliest* 1024 rows in index
   order, so after the cap is reached the roster stops moving for the rest of the
   day. It reports the shape of the early morning, not of today.
2. **Half the read budget buys nothing.** The shared senses — `embed`,
   `transcribe`, `describe` — are 1,998 of the 4,084 calls (~49%), and
   `tallyWork` deliberately attributes them to no agent. So ~500 of the 1024 rows
   read are rows that cannot increment any counter.

The cap was a deliberate bound, not an oversight: its comment cites what an
unbounded read over a hot table cost this deployment on 2026-07-18, and that
reasoning was correct. But a bound that trips daily has stopped protecting
anything and started silently under-reporting — the failure mode a bound is
supposed to prevent.

## Goal

Make `workToday` **exact** and **cheaper**, and delete the truncation machinery
that no longer earns its place.

## Prerequisite

This depends on `aiUsageHourlyStats` and `convex/lib/aiUsageStats.ts` existing.

As of 2026-08-09 that work is **not committed on any branch**. It lives as
uncommitted working-tree changes in a sibling worktree
(`/Volumes/CurserDisk/wa-amani-deploy-usage`, branch `fix/usage-tab-hourly-rollup`,
which is itself parked behind `main` with none of this work committed):

```
 M convex/aiUsage.ts        M convex/schema.ts   M src/components/agents/ai-usage.tsx
 M convex/aiUsage.test.ts   ?? convex/lib/aiUsageStats.ts   ?? convex/lib/aiUsageStats.test.ts
```

The agreed sequence is that the rollup lands on `main` first and this change
stacks on top of it. No part of it is duplicated into this branch — copying the
schema and `aiUsage.ts` hunks across would guarantee a conflict when both land.

`aiUsageHourlyStats` needs `_generated/dataModel` to typecheck. That worktree has
already regenerated `api.d.ts`, so if the merge carries the generated files no
codegen run is needed here. Per the standing repo rule, `npx convex
deploy`/`dev`/`codegen` is not to be run without the owner asking for it.

## The change

### 1 · Read the rollup, not the log

`aiUsageHourlyStats` carries per-mode `calls`/`tokens` per UTC hour, indexed
`by_account_hour`:

```ts
const sinceMs = startOfTodayMs(Date.now());
const hours = await ctx.db
  .query("aiUsageHourlyStats")
  .withIndex("by_account_hour", (q) =>
    q.eq("accountId", ctx.accountId).gte("hourStartMs", sinceMs),
  )
  .take(HOURS_PER_DAY);              // 24, a file-local constant in agentRoster.ts
const work = tallyWork(hours.flatMap((h) => h.modes));
```

`HOURS_PER_DAY` stays local to `agentRoster.ts` rather than joining
`lib/agentRegistry.ts` where `ROSTER_SCAN_WINDOW` lived. That constant was a
tuning knob carrying a long rationale and deserved a shared home; this one is
arithmetic with a single consumer.

**The day boundary lines up exactly, with no timezone argument.** `roster`'s
`startOfTodayMs` is midnight UTC, and midnight UTC *is* an hour boundary, so the
range covers hours `00:00`–`23:00` and nothing else. This is why `roster` needs
no equivalent of `aiUsage.summary`'s `hourStartMs(sinceMs)` guard: `summary`
takes an arbitrary `sinceMs` that can fall mid-hour and would clip its first
bucket, whereas `roster`'s never can.

`.take(24)` is therefore **exact rather than defensive** — at most 24 buckets can
match. A `.take()` is kept over `.collect()` even though ≤24 is provably safe,
because this module's header commits to every read being bounded; here the bound
documents the arithmetic instead of hiding a truncation.

Cost: **≤24 documents**, independent of traffic. Today it is 1024.

### 2 · `tallyWork` takes per-mode tallies

```ts
export function tallyWork(
  tallies: Array<{ mode: string; calls: number }>,
): Record<AgentKey, number>
```

with the body accumulating `t.calls` instead of `+= 1`. This is a strict
generalization: the current raw-row behaviour is the `calls: 1` case.

It must **accumulate, not assign** — the same mode appears once per hour bucket,
so `qualify` arrives roughly 17 times a day across 24 buckets. Assignment would
report the last hour instead of the day.

The module stays pure (no `ctx`, no `_generated` imports), per its header, and
the ownership map plus the deliberate "`embed`/`transcribe`/`describe` are
charged to nobody" rule stay in one reviewable place.

### 3 · Deletions

- `workOverflow` from the query's return type, from `RosterData` in
  `agent-roster.tsx`, and from its type plus all four fixture uses in
  `agent-roster.test.tsx`.
- The `${agent.workToday}${data.workOverflow ? '+' : ''} today` suffix at
  `agent-roster.tsx:236`, which becomes `${agent.workToday} today`.
- The `marks a capped count as approximate` UI test, which exists only to assert
  the `+`.
- `ROSTER_SCAN_WINDOW` itself, from `lib/agentRegistry.ts`. `agentRoster.ts` is
  its only consumer, so it dies with the thing it bounded. (`SYSTEM_SCAN_WINDOW`
  in `lib/cronSummary.ts` is a separate constant with its own live consumer and
  is untouched.)

The query keeps returning `{ agents }` rather than a bare array — a one-field
object is the smaller diff against the UI and leaves room for future top-level
fields.

## Rejected alternatives

**Raise `ROSTER_SCAN_WINDOW` to ~5,000.** Restores exactness today and breaks
again the moment traffic grows; it also keeps paying ~2,400 wasted reads/day on
shared-sense rows. The rollup makes the read a function of the window rather than
of volume, which is the property that stops this recurring.

**Keep a raw-log fallback when the rollup returns no rows.** Rejected. It
preserves the exact `.take()`-truncation path this change exists to delete, in
order to paper over a one-time sequencing step (below). The correct fix for an
empty rollup is to run the backfill, not to keep a wrong-by-design code path
alive forever.

## Rollout order

The rollup only knows hours it has observed. Shipping this change before the
backfill has drained would make `workToday` read *near-zero* for the pre-deploy
part of the day — strictly worse than today's truncation. Order:

1. The rollup lands on `main`.
2. It is deployed (schema + the `aiUsage.log` writer).
3. `npx convex run aiUsage:backfillAiUsageHourlyStats` is run **once** and left
   to drain fully.
4. Only then does this change ship.

Step 3 must not be started twice. `backfillAiUsageHourlyStats` is idempotent per
chain — it rebuilds whole hours by SET rather than incrementing — but it is not
concurrency-safe, and overlapping chains are what inflated a prod rollup 1.8× on
a previous backfill.

## Testing

### `convex/agentRoster.test.ts`

- The two tests that seed `aiUsageLog` (`today's usage rows count to their owning
  agent`, `one account's usage never counts toward another's roster`) seed
  `aiUsageHourlyStats` buckets instead.
- Drop `workOverflow` from `RosterShape` and its assertion.
- **New:** calls sum across multiple hour buckets. This is genuinely new
  behaviour — every row previously counted 1, and nothing until now exercised
  accumulation of a per-mode count.
- **New:** a bucket whose `hourStartMs` is before midnight UTC is excluded. This
  pins the day boundary the whole change rests on.
- The existing viewer-access test stays and becomes more load-bearing: the roster
  now reads documents that carry `promptTokens`/`totalTokens`, and that test
  asserts none of it reaches the wire.

### `convex/lib/agentRegistry.test.ts`

- The three `tallyWork` cases pass `{ mode, calls }`. The `match_service` and
  shared-senses cases keep their existing assertions — the point they make is
  about attribution, not about counting.
- **New:** duplicate entries for one mode accumulate (the multi-bucket case, at
  the unit level).

### `src/components/agents/agent-roster.test.tsx`

- The capped-count test deleted; `workOverflow` removed from the fixture type and
  from the three uses that survive that deletion.

## Out of scope

- The Usage tab and `aiUsage.summary` — that is the prerequisite's own change.
- Account-local day boundaries for the roster. `startOfTodayMs` stays midnight
  UTC, for the reason its comment already gives: the roster's claim is "today's
  work", not "work since your local midnight". Nothing here makes local days
  cheaper or more correct to add.
- Retiring `aiUsageLog`. It remains the audit trail and the source the backfill
  rebuilds buckets from.
