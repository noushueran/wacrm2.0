# AI agent roster dashboard — design

Date: 2026-08-08
Status: approved for implementation

## Problem

The platform runs six LLM-backed agents and ten scheduled robots. Exactly one of
them is visible as a thing that exists: the reply agent, via `/agents`. The rest
work invisibly. Nobody — owner included — can answer "which of my robots is
working right now, and is any of them broken?"

Two costs follow from that. Operationally, a dead agent is silent: the ad matcher
has never resolved a single campaign name because `META_ADS_ACCESS_TOKEN` is
unset, and nothing surfaces that. Perceptually, work the platform genuinely does
reads as nothing happening, because it happens without a face.

## Goal

One page that presents every agent as a member of staff: name, duty, current
status, and what it has done today. Status must be **derived from data the system
already writes** — never hand-maintained, never decorative.

Non-goal: building new agents. This spec covers the roster only. The four planned
agents appear on the board as "not hired" placeholders and are specified
separately.

## The roster

Ten agents. Six exist and work today; four are placeholders.

### Working

| Key | Name | Duty | Trigger | Enabled by |
|---|---|---|---|---|
| `reply` | Reply agent | Answers customer questions from the KB in their own language; escalates what it cannot answer | every inbound message | `aiConfigs.isActive && autoReplyEnabled` |
| `qualify` | Qualification agent | Asks the trip questions, extracts destination/dates/pax/budget, detects purchase intent, closes the session | every inbound message on a live session | `qualificationConfigs.enabled` |
| `score` | Lead scorer | Scores each lead 0–100, assigns a band | `lead-scoring` cron, 5 min | `leadAnalysisConfigs.enabled` |
| `checklist` | Checklist writer | Writes the salesperson's task list from the KB when a lead qualifies | on qualification complete | follows `qualificationConfigs.enabled` |
| `tags` | Tag suggester | Reads a thread and proposes tags from the account catalogue | human request only | `aiConfigs.isActive` |
| `admatch` | Ad matcher | Matches each click-to-WhatsApp referral to the service it advertised | on ad referral arrival | `META_ADS_ACCESS_TOKEN` present |

### Not hired

| Key | Name | Duty | Blocker |
|---|---|---|---|
| `revival` | Revival agent | Decides which quiet leads deserve a chase, writes the message, picks the moment, stops on its own rules | not built |
| `kbgap` | Knowledge gap agent | Mines the admin Q&A relay for unanswered questions, clusters them, drafts KB entries for approval | not built |
| `coach` | Sales coach | Reviews handled threads against the checklist, coaches each salesperson, digests to the owner | not built |
| `quote` | Quote drafter | Drafts itinerary, inclusions, exclusions, visa notes | `kbServices` carries no pricing catalogue |

The roster is a **static registry in code** (`convex/lib/agentRegistry.ts`), not a
table. Agents are software, not user data; a registry keeps identity, duty text,
and status-derivation rules in one reviewable place, and mirrors the existing
`CRON_REGISTRY` precedent in `convex/lib/cronSummary.ts`.

## Status model

| Status | Derivation |
|---|---|
| `working` | a run is in flight — `cronRuns.status === "running"` for the agent's cron, or an in-progress `_scheduled_functions` row |
| `on_duty` | enabled, and the most recent run did not fail |
| `on_call` | enabled but acts only on human request (`tags` only) |
| `attention` | enabled but the most recent run failed, or a declared blocker is present |
| `off_duty` | config row exists, toggle is off |
| `not_hired` | no config row, or agent not built |

`attention` outranks `working`: a failing agent that happens to be mid-run must
read as broken, not busy.

Each registry entry declares an optional `blockedReason` probe — the ad matcher's
is "`META_ADS_ACCESS_TOKEN` unset". A declared blocker forces `attention` with the
reason shown inline, which is what makes the currently-silent ad matcher failure
visible on day one.

## Backend

New module `convex/agentRoster.ts`, one `accountQuery` named `roster`.

Returns per agent: `key`, `status`, `lastActiveAt`, `workToday`,
`workTodayOverflow`, `blockedReason`.

### Read bounds

This query is a live subscription over tables the engines write constantly, so
every read is bounded. `convex/lib/cronSummary.ts`'s `SYSTEM_SCAN_WINDOW` comment
records what unbounded reads cost here: a `.filter()` scan over
`_scheduled_functions` tripped Convex's 4,096-document read limit and took the
cron panel down in production on 2026-07-18. That failure mode governs this
design.

- **Work counts.** `aiUsageLog` grouped by `mode` over today only, via
  `by_account` with a `_creationTime` lower bound — the same index-range idiom as
  `aiUsage.summary`. Bounded by `ROSTER_SCAN_WINDOW` (1024) with `.take()`; on
  overflow the count renders as "1024+" rather than a wrong exact number. Do
  **not** reuse `aiUsage.summary`: it `.collect()`s a 30-day window and is
  admin-gated, and both properties are wrong here.
- **Cron state.** One `.withIndex("by_name").order("desc").first()` per cron —
  nine single-document reads, no scan.

### Mode collision

`aiUsageLog.mode` has no value for the ad matcher: `convex/adServiceTagging.ts:583`
logs `mode: "classify"`, the same value `convex/aiTagging.ts` uses. Two distinct
agents currently share one timesheet entry, so neither can be counted correctly.

Fix: widen the `mode` union in `convex/schema.ts` and in `aiUsage.log`'s own args
validator (these are separate literal unions and have drifted before — see the
`score` comment at `convex/aiUsage.ts:51`) with `match_service`, and update
`adServiceTagging.ts` to log it.

Historical rows stay `classify` and are attributed to the tag suggester. That is
a known, bounded inaccuracy affecting only pre-migration days; the roster shows
today's counts, so it self-corrects within 24 hours of deploy. No backfill.

## Frontend

A `roster` tab on the existing `/agents` page, made the default landing tab for
configured accounts (first-time users still land on `setup`). New component
`src/components/agents/agent-roster.tsx`.

Layout, per the mockup: four metric tiles (on duty / working now / needs
attention / not hired), then the agent list as bordered rows — icon, name, duty,
status pill, and today's work.

The tiles are not a partition and must not be read as one. "On duty" counts every
agent that is enabled and healthy, including those currently `working` and
`on_call`; "working now" is a subset of it. "Needs attention" and "not hired" are
disjoint from both. Only "not hired" plus the enabled agents sum to ten. Not-hired agents render dimmed with a dashed
avatar. Below, a collapsed "Background jobs" section over the ten scheduled
robots, reusing `cronSchedules.overview`.

Page header copy changes: "Your bring-your-own-key AI agent" is singular and now
wrong. It becomes a line about the team.

Status pills use the existing semantic tokens — no new colour vocabulary.

## Access control

`roster` is member-visible. It exposes agent identity, on/off state, and activity
counts — the same trust level as `aiConfig.get`, which is deliberately member-safe
so every role's inbox banner can reflect whether AI is on. It exposes **no**
prompts, keys, models, or token counts; those stay behind the admin-gated
`aiConfig.getFull` and `aiUsage.summary`.

Note the consequence: `/agents` is currently an admin/owner-only route, so
member visibility of the query has no UI surface yet. The query is built
member-safe so a future inbox or dashboard widget needs no re-gating; the route
itself stays admin-only in this change.

## Testing

`convex/agentRoster.test.ts`, following the convex-test patterns already used by
`cronSchedules.test.ts`:

- each status derives correctly from its inputs, including `attention`
  outranking `working`
- a declared blocker forces `attention` and surfaces its reason
- `not_hired` when no config row exists
- work counts bucket by mode, and overflow sets `workTodayOverflow`
- `match_service` rows count to the ad matcher, not the tag suggester

Status derivation lives in a pure helper in `convex/lib/agentRegistry.ts` so these
run without a ctx, matching how `summarizeSystemTasks` is kept pure for the same
reason.

`cronSchedules.test.ts` asserts `CRON_REGISTRY` stays in sync with `crons.ts`; add
the equivalent assertion that every registry agent claiming a cron names a real
one.

## Out of scope

- Building the four planned agents
- Pause/resume controls from the roster — read-only first; toggles stay in Setup
- Per-agent cost (tokens/AED) — the usage tab already owns that
- Backfilling historical `classify` rows
