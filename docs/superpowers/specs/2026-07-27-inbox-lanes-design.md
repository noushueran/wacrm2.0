# Inbox Lanes — Design

**Date:** 2026-07-27
**Status:** Draft, awaiting owner review
**Revision:** v3 — rewritten after auditing every cron and follow-up engine. Chasing is now
time-derived rather than sequence-derived; the `conversations.chasing` mirror is gone. See
§Revision history.

**Parents (both implemented on `main`):**
- `docs/superpowers/specs/2026-07-26-lead-analysis-design.md` — lanes, scoring, bands
- `docs/superpowers/specs/2026-07-27-lead-analysis-p2-design.md` — archive & restore

## Problem

The Inbox is one recency-ordered list and every way of narrowing it is a lie.

`conversations.list` filters server-side on two axes — assignment, and (since P2) archived.
The Unread / Open / Pending / Closed dropdown, the tag picker, the company picker and the
search box all still run in `useMemo` over the ~30 rows already paginated into the client
(`src/components/inbox/conversation-list.tsx:152`). "Show me Pending" means "show me pending
among the thirty most recent". At this account's volume that is not a filter.

Three populations sit in one undifferentiated pile: someone who wrote nine minutes ago and is
waiting on us; someone we answered yesterday who has not replied; someone who went quiet
three weeks ago. Nothing distinguishes them, so the agent re-reads all of them daily.

### The 72-hour cliff

`qualificationSessions` runs a complete follow-up engine — cron `qualification-follow-ups`
every 5 minutes, ladder `[60, 180, 720, 1440]` minutes, `maxFollowUps: 4`, clamped to Mon–Sat
10:00–21:00 Dubai, free text inside Meta's 24h window and the `qualification_followup`
template outside it (`convex/lib/qualification/defaults.ts:60`).

It has two hard boundaries: it runs **only** while `status === "collecting"`, and at
`sessionWindowHours: 72` the session expires, `nextFollowUpAt` is cleared, and nothing touches
that lead again. Qualified-but-not-purchased leads leave `collecting` too, so they get the same
treatment.

**Every lead is worked hard for three days and then dropped, silently, into the flat list.**
That is the pile, and it is a lead-leakage problem wearing a tidiness problem's clothes.

### What is already solved

| Concern | Where it lives now |
|---|---|
| 1–10 AI score, hot/warm/cold band | `leadAnalyses.score` / `.band` — cron `lead-scoring` |
| Reversible shelf | `conversations.archivedAt` + `leadAnalyses.archived` mirror |
| Inbox excludes archived; Archived tab | `conversations.list`'s `archived` arg, all plans |
| Inbound resurrects a shelved thread | `conversations.unarchiveOnInbound`, transactional |
| Automated template nudges | `leadAnalyses.sequenceStatus`, cron `lead-sequence` |
| The two follow-up engines not colliding | `lib/leadAnalysis/eligibility.ts` tier 2 — `qualification_owns` |

**One gap remains and it is the whole of this spec: none of it reaches the Inbox.** Every lane
distinction the last three phases built is visible only on the `/lead-analysis` board. The
engine exists; the steering wheel does not.

## Principle

**The lane is a view, never a mechanism.**

This spec adds no sender and no new lifecycle. It denormalizes one fact that already exists —
the direction of the last message — so it can be indexed, derives the rest from timestamps,
and adds tabs that range on them.

Two safety properties govern everything:

> **A conversation whose last message is the customer's appears in Active.** Nothing may
> relocate it. Automation may act on such a thread; no automation may hide it.

> **Chasing begins exactly where the qualification engine gives up.** Both boundaries are
> times, not states, so the handoff needs no coordination between the two subsystems and
> cannot desynchronise.

## Scope

**In scope.** One denormalized field (`awaitingReply`) and its backfill; one config value
(`chasingAfterDays`); two indexes; a `lane` argument on `conversations.list`; lane tabs; one
amendment to P2's archive RBAC; and auto-assignment of unowned Chasing threads, behind its own
cron and flag.

**Out of scope.** Any change to either follow-up engine's cadence, sending, gating or band
config. Ordering Active by AI band. The existing client-side status/tag/company/search filters.
`/leads`, `/pipelines`, deals, funnel stages.

## The four lanes

| Lane | Meaning | Condition |
|---|---|---|
| **Active** | we owe a reply | not archived, `awaitingReply === true` |
| **Waiting** | they owe a reply, recently | not archived, `awaitingReply === false`, `lastMessageAt` newer than the cutoff |
| **Chasing** | quiet past the cutoff | not archived, `awaitingReply === false`, `lastMessageAt` at or older than the cutoff |
| **Dormant** | shelved | `archivedAt` present — P2, unchanged |

`cutoff = now - chasingAfterDays days`. Waiting and Chasing are **complementary ranges on the
same index key**, so they are provably disjoint and exhaustive without any coordinating state.

### Why time-derived and not sequence-derived

v2 defined Chasing as `leadAnalyses.sequenceStatus ∈ {running, exhausted}`, mirrored onto
`conversations`. Auditing the engines killed that design for a decisive reason:

`armOnOutbound` arms a sequence only when `leadAnalysisConfigs.enabled`, the row has a scored
band, and that band's `steps` array is non-empty. The seeded bands carry
`templateName: ""` — the explicit "not configured yet" marker
(`convex/lib/leadAnalysis/defaults.ts:9`) — and tier 4's `template_unavailable` gate then
**stops** the sequence. So until approved templates are configured per band,
`sequenceStatus` never sustains `running`, and a sequence-derived Chasing lane is
**permanently empty**. Lanes would have shipped as three lanes with the 72h cliff still
unfixed — the actual problem this spec exists to solve.

Time-derivation also removes, rather than mitigates, three whole risk classes: a mirror that
can drift from its source, a correctness write sitting in `ingest`'s best-effort fan-out, and
an assignment side effect re-entering the message-insert transaction through `armOnOutbound`.
All three were live defects in v2.

`sequenceStatus` still surfaces — as row detail and the *Needs your decision* badge (§UI) —
but as **information about** a Chasing thread, never its definition.

### Precedence

**archived > awaitingReply**, expressed by index key order. There is no third dimension to
rank: Waiting and Chasing are one field's range, not two states.

## Data model

### `conversations.awaitingReply`

```ts
awaitingReply: v.optional(v.boolean()),   // true = the customer spoke last, OR no messages yet
```

The lane derives from whether the last message was inbound — knowable from
`lastInboundAt === lastMessageAt`, but Convex cannot index a comparison between two fields, and
a post-index `.filter()` is the trap `conversations.list` documents at length: the traversal
does not narrow, `.paginate()` reads until `numItems` *matches* accumulate, and every scanned
document counts against the 4096 read limit. The pathological case is ordinary — an agent
opening Waiting on a day the team has answered everything.

**Both values are written explicitly**, unlike `leadAnalyses.archived` (true-or-absent). That
rule guards an accumulating set whose complement must never read past it; this is a genuine
two-way partition where both sides are bounded and both need an exact range. `undefined` is
not a third lane — it is a pre-backfill row, eliminated before any tab ships (§Rollout).

**A conversation with no messages holds `true`.** An agent who created a thread to write into
owes it its first message, so Active is the honest lane. It also preserves today's placement:
`lastMessageAt` is absent, Convex sorts missing before every present value, and Active applies
no range to that key — so the row sorts last in `.order("desc")`, exactly where
`by_account_last_message` puts it now.

Written in `insertMessageAndUpdateConversation` (`convex/messages.ts:176`) — inbound `true`,
any other sender `false`. That is the single `insert("messages")` in the backend, which is why
`recordMessageInHourlyStats` and `armOnOutbound` already hook there: the one place guaranteed
to see every message regardless of entry point, so the field cannot drift.

### `qualificationConfigs.chasingAfterDays`

```ts
chasingAfterDays: v.optional(v.number()),   // absent = sessionWindowHours / 24
```

Lives beside `sessionWindowHours` because that is the number it must agree with. **Absent means
"exactly where the qualification engine gives up"** — read as `sessionWindowHours / 24`, so out
of the box (72h) Chasing begins at day 3 with no configuration and no possibility of a gap or
an overlap between the two. Set it explicitly only to give agents longer before a thread is
called stale.

Deliberately not in `leadAnalysisConfigs`: that row is gated on its own `enabled` flag, and
the lane boundary must work whether or not Lead Analysis is on.

### Two indexes

```ts
.index("by_account_lane_last_message",
       ["accountId", "archivedAt", "awaitingReply", "lastMessageAt"])
.index("by_account_assigned_lane_last_message",
       ["accountId", "archivedAt", "assignedToUserId", "awaitingReply", "lastMessageAt"])
```

Two, not one, for the reason the shipped archive pair documents: `conversations.list` has two
distinct indexable plans — `any` needs global recency order, `eq` binds the assignee first —
and no single index serves both.

Every key before `lastMessageAt` is bound by equality, including `archivedAt`
(`eq(undefined)`), leaving that final key free for both the range and the ordering. Ranges:

| Lane | Range on `lastMessageAt` | Order |
|---|---|---|
| Active | none | `desc` — newest first |
| Waiting | `gt(cutoff)` | `desc` — newest first |
| Chasing | `gt(0).lte(cutoff)` | `asc` — longest-neglected first |

Chasing's `gt(0)` is the "field present" idiom `qualificationEngine.getDueSessions` already
uses. It excludes message-less conversations, which would otherwise fall into Chasing because
`undefined` sorts before every number. Belt and braces given that `awaitingReply === false`
already implies at least one message, and cheap enough to keep rather than reason about twice.

Chasing orders **ascending** — the opposite of every other lane, and correct: it is a neglect
queue, not a message list, so the thread longest without contact belongs at the top.

Lanes are not offered on the Archived tab. There `archivedAt` is ranged (`gt(0)`), and Convex
leaves index keys after a range key unordered — the same constraint the shipped code hit with
`assignedToUserId` in its archived branch, and the same answer: Dormant is a flat,
most-recently-archived-first review queue, which is what a graveyard should be.

`meOrPool` keeps a `.filter()` for assignment, exactly as it does today, and for the reason
that file records: an OR across disjoint ranges no single `.paginate()` cursor can express,
benign because the predicate matches a large share of rows near the front.

## Queries

`conversations.list` gains one argument alongside the shipped `archived`:

```ts
lane: v.optional(v.union(v.literal("active"), v.literal("waiting"), v.literal("chasing"))),
```

| Plan | Lane handling |
|---|---|
| `eq` (single assignee) | `by_account_assigned_lane_last_message` |
| `any` (supervisor+, no tab) | `by_account_lane_last_message` |
| `meOrPool` (agent default) | lane bound on `by_account_lane_last_message`; assignment stays a `.filter()` |
| `empty` (viewer on "Mine") | unchanged — answers without a read |

`lane` combined with `archived: true` is a validation error, not a silent drop, so a UI bug
surfaces as a failure rather than a quietly wrong list. Absent `lane` reproduces today's
behaviour exactly, so every existing caller — the deep-link path, `unreadTotal`, the
dashboard — is untouched.

**What this makes redundant.** The client-side Open / Pending / Closed dropdown was standing in
for precisely this distinction, over 30 rows. Left in place rather than widening scope, but it
is the obvious next deletion and its strings should not be re-translated meanwhile.

## RBAC — this spec amends P2

P2 shipped archive at supervisor+ (`convex/leadAnalysis.ts:826`, `:891`). **This spec lowers
`archive` and `restore` to agent+** (owner decision, 2026-07-27), with the sequence's manual
stop at the same level.

At supervisor+, Active is unclearable by the people who look at it: an agent who opens a wrong
number or a spam message must escalate to dispose of it, so in practice they will not, and
Active — the one count this design asks the team to drive to zero — fills with threads that
need no work.

The blast radius is small and already instrumented: `archivedByUserId` records who,
`archivedReason` why, Restore is one click, nothing leaves the database. Viewers stay excluded.
`archiveAutomated` is an `internalMutation` and is unaffected. Bulk actions remain supervisor+
whenever they land — that is where a mistake scales.

## Chasing ownership — auto-assign

An unassigned thread in Chasing belongs to nobody: it is nudged by whatever automation applies
and, if it ends as a hot lead needing a decision, that decision lands in no one's queue. **An
unowned Chasing thread is assigned** (owner decision, 2026-07-27).

### Not the consent-offer flow

Reusing P6's `leadOffers` machinery does not work here, for three structural reasons:

1. **`leadOffers.sessionId` is a required `Id<"qualificationSessions">`.** A Chasing thread may
   have no session at all, so no row can be written without inventing one.
2. **`offerContext` subtracts `alreadyTried`.** The commonest route into
   Chasing-while-unassigned is "qualified, everyone declined or timed out" — where re-entering
   the offer flow returns `exhausted` immediately. A no-op in exactly the case this exists for.
3. **Consent implies decline, and decline recreates the orphan.**

So: a direct assignment. No consent round-trip, no WhatsApp message to the agent, no
`leadOffers` row.

### It needs its own cron, and that is the honest cost

Time-derived Chasing has no entry *event* — a thread ages in. There is nothing to hook:

- the `lead-sequence` sweep ranges `by_sequence_due`, which is empty on a config with no
  approved templates — the very condition that made v2's design unshippable;
- `qualification-follow-ups` ranges `by_due` over `collecting` sessions, and a Chasing thread's
  session has expired;
- scheduling per outbound message would create one scheduled job per send.

So **one new cron, `inbox-chase-assign`, every 30 minutes**, bringing the deployment to eight.
Folding it into an unrelated sweep to protect the cron count would trade clarity for a number.
It sends nothing, is bounded by a per-run cap, and is inert unless
`qualificationConfigs.autoAssignEnabled` is on.

### One routing rule, two callers

The routing decision — eligible members (role `agent`/`supervisor`, has a phone) narrowed by
the service tag's `memberTags` links, widening to the whole team under the four documented
`FallbackCause` values — is currently inlined in `qualificationEngine.offerContext`. It is
extracted to a shared module so both callers use one rule. Two copies would drift, and those
four causes exist precisely because naming the wrong one costs an admin a pointless hunt.

The extraction must be behaviour-preserving with the existing `qualificationEngine` tests as
the gate. It is the one genuinely risky edit in this spec.

### Load ranking

`offerContext` ranks by fewest recent `leadOffers` accepts — blind to direct assignments, so on
its own it would stack the entire first sweep onto whoever has fewest accepts.

Chasing ranks by **count of currently-assigned Chasing threads, ascending**, ties broken by the
existing accepts rule. That count is a bounded range on
`by_account_assigned_lane_last_message`, which this spec already adds.

### Gate, failure, and non-goals

- **Gated on `qualificationConfigs.autoAssignEnabled`** — the switch already set for
  qualification. A separate flag is one field away if independent control is wanted.
- **Never reassigns.** Only fires when `assignedToUserId` is absent.
- **Zero eligible agents** → the thread stays in the pool and one `chase_unassigned`
  notification goes to the supervisor pool. Additive union literal, the `lead_returned`
  precedent. Silence would recreate the invisible-orphan problem one level up.
- **Does not charge.** `conversations.assign` calls `chargeLeadIfAgent`, idempotent per
  *(agent, conversation)* — so a **different** agent picking up a stale thread would incur
  their own lead charge. Billing someone for an unresponsive lead they did not choose is a
  fairness question, not a technical one, and not-charging is reversible in the cheap
  direction. The sweep patches `assignedToUserId` directly rather than calling the `assign`
  mutation, and omits `chargeLeadIfAgent`. One line to reverse.

## UI

**Lane tabs** across the conversation list: **Active · Waiting · Chasing · Archived**. A second
axis from the existing Mine / Unassigned tabs, not a replacement — the two compose, which is
what makes "my Chasing queue" work with no per-agent state. Archived is P2's tab, moved into
this row rather than added twice.

Active is the default landing tab.

**Per-tab counts are NOT built** (deferred, 2026-07-27). Earlier drafts of this section said
"with counts" and called Active's count "the number the team drives to zero"; no task ever
implemented them and the omission was only caught at final review. A count per tab means four
more paginated reads, or four `.collect()`s over ranges that grow without bound — the exact
failure this spec's index design exists to avoid. Doing it properly needs its own decision
about how the count is bounded (a capped "99+", or a maintained counter), so it is a separate
change rather than a line item here.

**Chasing rows** show neglect rather than a snippet timestamp — "quiet 9 days" — plus, when a
`leadAnalyses` row exists, the sequence's state: nudges sent, and a *Needs your decision* badge
when `sequenceStatus === "exhausted"`. That join is per page and only on the Chasing lane, so
no other lane pays for it.

**Thread header** gains a lane indicator, and for agent+ a **Stop chasing** control calling the
existing sequence-stop path. This is the owner's "clock sweeps by default, agent overrides"
requirement.

**As built, Stop chasing only appears on a thread opened FROM the Chasing tab**, because
`conversations.get` does not join `leadAnalyses` and so has no `sequenceStatus` to gate on —
only `list` carries it, and only for that lane. Narrow in practice (you notice a chase from the
Chasing tab) but this section reads as an unconditional promise, so: the honest scope is
Chasing-tab-only, and the fix, if it turns out to matter, is joining `leadAnalyses` in
`conversations.get` the same way `list` does.

Note also that a manual stop is **permanent**: `leadAnalysisEngine.armOnOutbound` deliberately
refuses to re-arm a row whose `stoppedReason` is `"manual"`, and a later `"replied"` stop never
overwrites `"manual"`. There is no undo beyond an admin re-arming the row directly.

## Module layout

| File | Change |
|---|---|
| `convex/schema.ts` | `awaitingReply`, two indexes, `chasingAfterDays`, `chase_unassigned` notification literal |
| `convex/messages.ts` | `awaitingReply` in `insertMessageAndUpdateConversation` |
| `convex/conversations.ts` | `lane` argument across `list`'s plans |
| `convex/leadAnalysis.ts` | `archive` / `restore` / manual stop drop to `requireRole("agent")` |
| `convex/lib/inbox/lanes.ts` | **new** — pure cutoff arithmetic |
| `convex/lib/qualification/routing.ts` | **new** — the routing rule extracted from `offerContext` |
| `convex/inboxChaseAssign.ts` | **new** — the auto-assign sweep |
| `convex/crons.ts`, `convex/cronSchedules.ts` | register `inbox-chase-assign` |
| `convex/inboxBackfill.ts` | **new** — one-shot `awaitingReply` backfill, deleted after use |
| `src/components/inbox/conversation-list.tsx` | lane tabs, Chasing row rendering |
| `src/components/inbox/message-thread.tsx` | lane indicator, Stop chasing |
| `messages/en.json` | new strings |

No new sender. One new cron, which does not send.

## Testing

**Unit** (`convex/lib/inbox/lanes.ts`, no database): the cutoff falls back to
`sessionWindowHours / 24` when `chasingAfterDays` is absent; an explicit value wins; the
Waiting and Chasing boundaries meet exactly at the cutoff with no gap and no overlap.

**Convex-test:**

- each lane returns exactly its own set; the four are disjoint, and Active ∪ Waiting ∪ Chasing
  is every non-archived conversation
- a conversation exactly at the cutoff lands in exactly one lane
- all four `list` plans assert lane handling separately — `eq`, `any`, `meOrPool`, `empty`
- `lane` with `archived: true` is a validation error
- **safety property one:** a conversation whose last message is inbound appears in Active at
  every age, for every plan and role that can see it
- **safety property two:** with `chasingAfterDays` absent, the Chasing boundary equals
  `sessionWindowHours`, so no thread is in Chasing while its session could still be `collecting`
- `insertMessageAndUpdateConversation` sets `awaitingReply` true on inbound and false for every
  non-customer sender, through at least two distinct send entry points
- a message-less conversation is Active and sorts last
- an archived conversation appears in no lane regardless of `awaitingReply` or age
- the backfill is idempotent and derives what a live write would
- auto-assign: assigns an unowned Chasing thread to a routed agent; never reassigns; leaves it
  unassigned and notifies on zero candidates; skipped when `autoAssignEnabled` is false; never
  charges
- RBAC: an agent can archive, restore and stop chasing; a viewer none; none crosses accounts

**Component:** each lane tab renders its own empty state; a Chasing row renders neglect and,
when exhausted, the badge. Static-render assertions per this repo's convention — there is no
jsdom and no Testing Library (`src/components/inbox/conversation-list.test.tsx`).

## Rollout

Owner-run throughout; no agent session runs `convex deploy`.

1. **Deploy schema + indexes.** Inert: no caller passes `lane`.
2. **Ship the `awaitingReply` write path.** Still invisible.
3. **Backfill**, oldest-first, paginated, re-runnable. Must reach `patched: 0` before step 4,
   or Waiting silently swallows every un-backfilled thread.
4. **Ship the read side and the RBAC change.**
5. **Ship the tabs.** First user-visible change, purely additive.
6. **Ship auto-assign last**, on its own, and watch the first sweep. It is the only part of
   this work that changes who owns a conversation.

Chasing is populated from the moment step 5 lands — it depends on timestamps the database
already holds, not on any engine being configured. The first view of it will be large: that is
the 72h-cliff backlog becoming visible, not a new problem.

## Risks

| Risk | Mitigation |
|---|---|
| A thread the customer is waiting on is swept out of Active | `awaitingReply === true` is Active unconditionally, with no time component; asserted as a named test |
| Chasing overlaps the qualification engine's own window | The cutoff defaults to `sessionWindowHours / 24`, so the boundaries are the same number by construction; asserted directly |
| `awaitingReply` drifts from the real last-message direction | Written in the single `insert("messages")` choke point; absent is treated as Active, the fail-safe direction; the backfill is re-runnable |
| Tabs ship before the backfill and Waiting swallows everything | Ordered rollout, step 3 before 5; backfill re-runnable and idempotent |
| Message-less conversations fall into Chasing | `gt(lastMessageAt, 0)` in the Chasing range, plus `awaitingReply: true` for such rows |
| Extracting the routing rule breaks live lead assignment | Behaviour-preserving move gated on the existing `qualificationEngine` test count; its own task |
| Auto-assign dumps the whole backlog on one agent | Ranked by current Chasing load, not historical accepts; per-run cap |
| Auto-assign silently bills agents for stale leads | `chargeLeadIfAgent` deliberately not called; §Chasing ownership records how to reverse |
| An eighth cron adds to an already busy deployment | It sends nothing, is bounded, is inert unless `autoAssignEnabled`, and is registered through `cronSchedules.ts` so it appears in the Settings panel like every other |
| Chasing becomes the new pile | Bounded below by P2's archive, which agents can now reach; Active, not total volume, is the number the team drives |

## Revision history

**v1** designed a standalone chase clock (`chaseDueAt` / `chaseCount` / `chaseEnteredAt`), an
`inbox-chase` cron, and its own ladder arithmetic, on a tree where P2 and P3 were specified but
unbuilt. Both landed mid-design, making all of it redundant.

**v1's central argument** — that Chasing should be a human queue rather than automated template
sends, because Chasing sits outside Meta's 24h window and the account has one approved English
template against multilingual leads — was neither accepted nor rejected. It was **overtaken**:
P3 shipped the automated sequence while the spec was being written. The concern is unaddressed
rather than resolved, and now belongs to the sequence engine's template configuration. Recorded
so it is not lost.

**v2** made Chasing a mirror of `leadAnalyses.sequenceStatus`. An audit of all seven crons and
every follow-up engine found three defects, all removed by v3's time-derivation:

1. **The lane would always be empty.** No approved band templates means `sequenceStatus` never
   sustains `running`. The feature would have shipped without fixing the cliff.
2. **A correctness write in a best-effort path.** Clearing the mirror on inbound depended on
   `stopOnInbound`, which runs in `ingest`'s best-effort fan-out (`convex/ingest.ts:720`) and
   swallows failures by design — so one swallowed failure would park a replying customer
   outside Active permanently and silently.
3. **Assignment re-entering the message transaction.** `setChasing(true)` was called from
   `armOnOutbound`, itself inside `insertMessageAndUpdateConversation` — so sending a message
   could silently reassign the conversation, and run a candidate-ranking loop, inside the
   message-insert transaction.

**v2 also carried a concern that was simply wrong** and is retracted here: that a new Chasing
mechanism could collide with the qualification engine. `lib/leadAnalysis/eligibility.ts` is a
12-gate, 4-tier chain whose tier 2 contains `qualification_owns`; the two customer-facing
engines were already mutually exclusive by design, with the tier ordering documented as
load-bearing. There was no collision to prevent.

Retained across all three revisions: `awaitingReply`, the lane tabs, the archive-RBAC
amendment, and the deferral of permanent dismiss.

## Deferred

- **Ordering Active by AI band.** Needs `leadAnalyses.band` denormalized onto `conversations` —
  a mirror with its own sync invariant, which v3 otherwise avoids entirely. Active should also
  be short once lanes work. Its own spec.
- **A fifth "Needs decision" lane** for exhausted hot leads. A badge inside Chasing for now.
- **A permanent dismiss for nuisance contacts** (owner decision, 2026-07-27). Unconditional
  return-on-reply is what makes archive safe; an escape hatch is a way for threads to get
  buried. Revisit with real numbers. Until then, re-archiving is the answer.
- **Retiring the client-side Open / Pending / Closed filter.** §Queries.
- **Bulk lane actions.** P2 defers bulk archive to P4; this joins it.
