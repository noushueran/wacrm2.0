# Agents tab — leads assigned per agent, day-wise

Date: 2026-08-21
Status: approved, ready to implement

## Problem

`/reports` answers volume, ads, response time, funnel and billing. It cannot
answer the one question a supervisor asks about their team every morning:
**how many leads did each agent pick up, on each day?**

Today the only way to get that is to open the Inbox, filter by assignee, and
count by eye — which gives a current-state snapshot, not a day-by-day history,
and silently omits every thread that has since moved on to someone else.

## Data source

`conversationEvents`. Written by exactly one function — `applyAssignment` in
`convex/lib/assignment.ts` — which patches `conversations.assignedToUserId`
and inserts the event in the same step, so the field and the trail cannot
drift. Every one of the seven assignment entry points goes through it.

Each row carries `targetUserId` (who received it), `previousUserId` (who lost
it), `kind` (`assigned` / `unassigned`), `source` (`manual` / `takeover` /
`release` / `auto_assign` / `automation` / `offer_accept`) and `_creationTime`.

### History floor — 2026-08-13

The table did not exist before commit `7856d2e` (2026-08-13,
"feat(inbox): record conversation assignment handovers"). Production held 341
rows across 7 days when this was designed.

This is load-bearing for the UI, not a footnote. On the 30- and 90-day ranges
the window reaches back past the floor, and a run of empty bars there reads as
"the team assigned nothing for three weeks" — which is false. **Whenever
`sinceMs` predates the floor, the panel must say so on screen.** The bars are
correct; their absence is not.

The range picker default stays at 30 days, matching every other tab. The floor
note carries the explanation instead of a per-tab default the user would have
to un-learn once history catches up.

### What is NOT used, and why

`conversations.assignedToUserId` has no `assignedAt` companion, so
current-state reads cannot date an assignment at all. Bucketing conversations
by their own creation date and crediting the current owner would give full
history, but answers a different question ("where did last month's leads end
up") and lets a reassignment today silently rewrite a count from six weeks
ago. Rejected.

## Semantics

One cell of the grid is:

> **(local day × agent) → the number of DISTINCT conversations that became
> that agent's on that day.**

- A thread assigned to the same agent twice in one day (assigned, released,
  re-assigned) counts **once** for them. The question is "how many leads did
  they work", not "how much churn was there".
- A takeover credits the **receiving** agent, on the day it happened. The
  agent who lost the thread is not debited.
- A thread assigned to A in the morning and B in the afternoon counts once for
  A and once for B. Both genuinely picked it up that day.
- `kind: "unassigned"` events feed a separate per-day **Released** row —
  distinct conversations dropped back to the pool — attributed to no agent. A
  day where work was abandoned rather than distributed has to be visible, and
  folding releases into an agent's count would inflate exactly the number a
  supervisor is trying to read.

Days are the **caller's local** calendar days. A Convex function always runs in
UTC, so the offset arrives as `tzOffsetMinutes` (already carried by
`ReportWindow`) and bucketing goes through `convex/lib/dashboardDate.ts`'s
`localDayKeyFromMs`, exactly as the other windowed panels do.

## Backend

### Schema

`conversationEvents` gains one index:

```ts
.index("by_account", ["accountId"])
```

Convex appends `_creationTime` to every index, so
`eq("accountId", …).gte("_creationTime", sinceMs).lt("_creationTime", untilMs)`
is a real single range over exactly the window. Purely additive: no existing
index is touched, no field changes, no backfill.

### `reports.assignmentsByAgent`

New `accountQuery` in `convex/reports.ts` — supervisor+, like every query in
that file, and for the same reason: it returns aggregates only, no phone
numbers and no per-contact rows, and a supervisor already sees strictly more
in the Inbox.

Args: `{ sinceMs, untilMs, tzOffsetMinutes }`.

Both window edges are bound on the index. This matters for the same reason
`readHours` documents on its own upper edge: the fold pools every row it is
handed with no further per-row filter, so an unbounded read would not merely
cost extra reads, it would corrupt the counts.

### Read bound

This query's cost grows with assignment **volume** inside the window, not with
window length — the `adPerformance` shape, not the `volume` shape. So it takes
the same treatment: an `ASSIGNMENT_ROW_LIMIT` cap.

The read is `.order("desc").take(LIMIT)` — **newest first, deliberately**. An
ascending take would truncate the most recent days, which are the ones anyone
is actually looking at, and would do it silently. Descending truncates the
oldest instead, and the query reports `truncated` plus `earliestCoveredDay`
(the local day of the oldest row actually read) so the panel can mark the
incomplete edge rather than under-report it as fact.

At production's ~90 events/day a 90-day window is ~8k rows; the cap sits above
that with headroom. If the SCAN itself ever becomes the problem rather than the
row count, the documented escape hatch is a per-(account, day, agent) rollup —
the same shape as `messageHourlyStats`.

### Return shape

```ts
{
  days: Array<{
    dayKey: string                         // local YYYY-MM-DD
    byAgent: Record<string, number>        // userId -> distinct conversations
    released: number                       // distinct conversations released
  }>
  agents: Array<{ userId: string; name: string; total: number }>
  truncated: boolean
  earliestCoveredDay: string | null
}
```

`agents` is sorted by `total` descending and includes only agents with at
least one assignment in the window — a roster of twenty with three active
would otherwise render seventeen empty rows.

Names resolve from `memberships.fullName`, which is account-scoped, so no
`users` read is needed. An assignee with no membership row — someone who has
since left the team — renders as "Former member" rather than being dropped:
their leads still happened, and dropping them would make the per-day totals
disagree with the columns above them.

### Pure fold

The grouping (dedupe by `(dayKey, agent, conversationId)`, the released set,
the agent totals) lives in `convex/lib/reportStats.ts` as a total function
over plain rows, per that file's header. It is where this feature would
produce *wrong* numbers rather than *failing*, so it has to be testable
without a Convex harness.

`ASSIGNMENT_ROW_LIMIT` lives there too, not in `reports.ts`: the panel needs
the number verbatim for its truncation copy, and importing it from `reports.ts`
would ship the entire backend module to the browser — a confirmed past leak
documented in that file's own header.

## Frontend

### Tab registration

`REPORT_TABS` in `src/lib/reports/types.ts` gains `'agents'`, positioned
**before** `'activity'`. `activity` sits last deliberately as the only
non-windowed tab; `agents` is windowed and belongs with the other five.

### `src/components/reports/agents-panel.tsx`

A standard `ReportPanelProps` panel.

- **Stacked bar chart** — recharts `BarChart` with a shared `stackId`, one bar
  per day, one colour per agent, drawn from the vendored
  `AvailableChartColors`. That palette has 9 entries; past 8 agents the chart
  shows the top 8 plus a grey "Other" band, while the table below still lists
  everyone by name. The chart is for shape; the table is the record.
- **Grid** — agents down, days across, per-agent totals in a trailing column,
  per-day totals in a trailing row, and the Released row beneath. `tabular-nums`
  throughout, horizontally scrollable inside its own container at 90 days.
- **CSV export** — the on-screen grid verbatim, per the section's "every panel
  exports exactly what is on screen" rule.
- **Empty state** — `EmptyState` when the window holds no assignment events at
  all.
- **History-floor note** — shown whenever `sinceMs` predates 2026-08-13. See
  "History floor" above for why this is required rather than optional.
- **Truncation note** — shown when `truncated`, naming `earliestCoveredDay` as
  the first day that may be incomplete.

### Copy

New `Reports.agents.*` keys in `messages/en.json`, plus the
`Reports.tabs.agents` label.

## Testing

`convex/reports.test.ts`:

- distinct-per-agent-per-day: one conversation assigned to the same agent
  three times in a day counts once
- a takeover credits the receiver, not the releaser
- one conversation assigned to two different agents on the same day counts
  once for each
- `kind: "unassigned"` lands in `released` and in no agent's count
- local-day bucketing across a midnight boundary at a non-zero
  `tzOffsetMinutes` (with `TZ` pinned — this repo's edge-runtime test env
  inherits the host timezone)
- both window edges exclude out-of-range events
- truncation reports `truncated` and `earliestCoveredDay` rather than silently
  short counts
- an assignee with no membership row renders as "Former member" and still
  counts toward the day total

Pure-fold cases go against the `reportStats.ts` helper directly, with no `ctx`.

## Deploy

One schema change (an index). Requires `npx convex deploy`, run by the owner,
from a clean `origin/main` worktree per the repo's deploy runbook. Nothing
here is destructive and nothing needs a backfill.

Adding an export to the existing `convex/reports.ts` and an index to an
existing table both avoid the codegen drift guard — `_generated/api.d.ts`
types each module as `typeof import("../reports.js")`, and index types come
from `schema.ts` directly. No `convex codegen` run is needed.

## Out of scope

- Source split (manual / takeover / auto) per agent — considered and cut. The
  takeover rate is interesting, but it is a second question and it doubles the
  grid.
- Per-agent share-of-day percentages — the totals column answers this well
  enough by eye.
- Attributing releases to the agent who let go of the thread.
- Any per-contact or per-conversation drill-down. This file returns aggregates
  only; that is what makes supervisor the right role floor.
