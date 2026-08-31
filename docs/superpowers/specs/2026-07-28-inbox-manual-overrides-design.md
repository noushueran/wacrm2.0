# Inbox Manual Overrides — Snooze & Force-to-Chasing — Design

**Date:** 2026-07-28
**Status:** Draft, awaiting owner review
**Parent:** `docs/superpowers/specs/2026-07-27-inbox-lanes-design.md` (v3, shipped)

## Problem

The lanes are entirely derived — `awaitingReply` plus time — which is what makes them
impossible to desynchronise, and also what makes them impossible to override. An agent who
*knows* something the derivation cannot has no way to say it:

- **"I am not dealing with this until Tuesday."** A thread we replied to sits in Waiting for
  three days and then joins Chasing on schedule, whether or not the agent has already agreed
  with the customer to pick it up next week. There is no way to park it deliberately.
- **"This one has ghosted, I can tell."** A customer who sent one message and went silent is
  indistinguishable, for three days, from one who is actively deciding. The agent often knows
  on day one. The lane makes them wait until day three.

Reported by the owner, 2026-07-28, as "there are no options to manually move from active to
waiting, from waiting to chasing, and from chasing to archive."

**Archive is already fixed** (`f8b2213`, 2026-07-28) — it was never wired into the Inbox and
now is. This spec covers only the two that need new state.

**Active → Waiting is deliberately NOT included, and cannot be.** "Move this to Waiting"
means "I am not replying right now", which is a snooze — it is the same request, and §Snooze
is the answer to it. A literal Active→Waiting toggle would claim the customer is waiting on
us when they are not, which is exactly the lie the lane model exists to prevent.

## Principle

**An override is a fact a human knows that the derivation cannot. It is never a mirror.**

v2 of the parent spec failed because it stored a copy of another table's state, which drifts.
An override is categorically different: it *is* the truth for that thread, entered
deliberately, with an author and a timestamp. There is no second source to disagree with.

Two properties carry over unchanged and constrain everything here:

> **A conversation whose last message is the customer's appears in Active.** An override may
> park a thread we are waiting on; **no override may hide a customer waiting on us.** Any
> inbound message cancels any override, in the message transaction.

> **Every lane stays an exact index range.** No override may turn the hot path into a filter.

## Scope

**In scope.** `snoozedUntil` and `chasingForcedAt` on `conversations`; a Snoozed tab; a sweep
that wakes expired snoozes; inbound cancellation of both; agent+ controls; auto-assign and
both follow-up engines respecting a snooze.

**Out of scope.** Recurring snoozes. Per-lane snooze durations. Snoozing from the Lead
Analysis board. Any change to the grace window, the Waiting/Chasing cutoff, or either
follow-up engine's cadence.

## Snooze

### Shape

```ts
snoozedUntil: v.optional(v.number()),        // presence = snoozed; the wake time
snoozedByUserId: v.optional(v.id("users")),
snoozedReason: v.optional(v.string()),       // optional free text, shown on the row
```

**Presence means snoozed**, exactly as `archivedAt` does. That is not stylistic: it is what
lets the lane indexes bind `eq("snoozedUntil", undefined)` as a single equality and stay exact
ranges. A snoozed thread appears in **no** lane until it wakes.

### Waking

A cron (`inbox-snooze-wake`, 5 min) ranges `by_snoozed_until` on `(> 0, <= now)`, clears the
three fields, and the thread rejoins whichever lane it now derives into — which may not be the
one it left, and should not be: three days of silence while snoozed is three days of silence.

**Clearing the field is what makes the equality work.** An expired-but-uncleared row would
hold a past timestamp, not `undefined`, and would stay invisible forever. The sweep is not a
convenience; it is load-bearing, and its failure mode is silent disappearance. It gets a test
asserting a woken thread is back in a lane, and the cron is registered through
`cronSchedules.ts` so a stalled sweep is visible in Settings → Cron schedules.

### Cancellation

**Any inbound customer message clears the snooze**, in the same transaction as the message
insert — beside the existing un-archive and `awaitingReply` write, and for the identical
reason: a customer writing to us is the one signal that outranks every filing decision. A
best-effort hook would mean a snoozed customer could write and stay hidden.

An agent may also wake a thread by hand from the Snoozed tab.

### Durations

Presets, not a date picker, for the first build: **3 hours · Tomorrow 9am · Next Monday 9am ·
Custom**. "Tomorrow" and "Monday" resolve against the account's `utcOffsetMinutes` and
`workStartMinute` from `qualificationConfigs`, so a snooze lands at the start of a working day
rather than at 3am. Custom is a datetime input, floored to 5 minutes.

### The forgotten-snooze risk

A snooze that nobody remembers is a lost lead, which is the failure this whole feature set
exists to prevent. Three mitigations, all cheap:

1. **A Snoozed tab**, ranging `gt("snoozedUntil", 0)` — the complement of what the lanes bind,
   the same trick the Archived tab already uses. Ordered by wake time, soonest first.
2. **The row shows its wake time and reason**, so the tab is scannable.
3. **A snooze cannot outlive the Chasing cutoff by default.** Custom durations beyond 30 days
   are rejected in validation. A thread you want gone for longer is being archived, and should
   say so.

## Force-to-Chasing

### Shape

```ts
chasingForcedAt: v.optional(v.number()),      // presence = force this into Chasing now
chasingForcedByUserId: v.optional(v.id("users")),
```

Presence relocates the thread into Chasing regardless of age. It does not expire — the thread
leaves when it is replied to, archived, or the force is undone.

### Why this one costs a union, and why that is acceptable

Snooze is free because "not snoozed" is an equality that every lane already wants. Forcing is
not: Chasing must return `(derived Chasing) ∪ (forced)`, which is two ranges.

That union is affordable **here specifically** because it is the exact shape already built,
tested and shipped for the grace window (`conversations.ts`, 2026-07-28): the second set is
bounded by construction — only threads a human has marked — so it is one capped `.take()`
merged into page one, not a filter over the main range. Chasing is also the cold path, opened
deliberately rather than on every inbox load.

**Waiting must exclude forced rows**, or a thread appears in two lanes. That is the real cost:
`chasingForcedAt` becomes a key in both lane indexes so Waiting can bind
`eq("chasingForcedAt", undefined)`, which means **new indexes and a second backfill**. There is
no cheaper correct option — a `.filter()` on Waiting is the unbounded-scan trap this codebase
documents throughout.

### Alternative considered and rejected

A single `laneClockAt` field — defaulting to `lastMessageAt`, overridable — would make forcing
a matter of writing an older timestamp, with no union and no new index columns. It is more
elegant and it was tempting.

Rejected because it makes the lane silently disagree with the visible timestamp: the row would
read "Quiet 2h" while sitting in a lane that means "quiet for days", and every future reader
of the index would have to know that the field it ranges on is sometimes a lie. The union is
more code and less cleverness, which is the right trade for a boundary this load-bearing.

## Interaction with everything already running

| Subsystem | Behaviour |
|---|---|
| Auto-assign sweep | Skips snoozed threads — assigning an owner to a thread nobody should be looking at is noise. A **forced** thread is eligible; that is the point of forcing it. |
| Qualification follow-ups | Snooze suppresses nudges, joining the existing `aiAutoreplyDisabled` / archived guards in `followUpContext`. A deliberate park must not be talked over by a bot. |
| Lead-analysis sequence | Same, via `eligibility.ts`. Add `snoozed` to its tier-1 stop reasons — it is a fact about the lead, not about our ability to send. |
| Archive | Archiving clears both overrides. Archived outranks everything; leaving a stale snooze on a shelved thread would resurrect it into no lane. |
| Grace window | Untouched. Grace is automatic and time-derived; overrides are manual. They compose without interacting. |

**Mutual exclusivity.** A thread cannot be both snoozed and forced — the second action clears
the first, and the UI shows only the applicable control. Enforced in the mutations, asserted in
tests.

## RBAC

**Agent+** for all four actions (snooze, wake, force, unforce), matching archive/restore and
stop-chasing. Viewers excluded. The reasoning from the parent spec's §RBAC applies unchanged:
the people who read the Inbox are the people who must be able to file what is in it.

## UI

**Snoozed becomes a fifth tab**, after Archived. Five tabs plus the three assignment tabs is
the point at which the row gets crowded — see §Deferred on collapsing the assignment axis into
a dropdown, which should probably happen at the same time.

**Thread header** gains a **Snooze** split-button (default 3h, dropdown for the rest) and a
**Chase now** action beside the existing Archive and Stop chasing.

**Rows** show `Snoozed until Tue 9am` in the Snoozed tab, and a small marker on a forced
Chasing row so it is distinguishable from one that aged in naturally.

**Undo.** Both actions toast with an Undo, because both hide a thread from where the agent was
looking and a misclick is otherwise only recoverable by hunting through a tab.

## Data model summary

Five new optional fields on `conversations`, two new lane index keys, one new cron, one new
tab. Both backfills are trivial (`undefined` is the correct value for every existing row) —
unlike `awaitingReply`, absence here is genuinely meaningful, so **no backfill is required at
all**.

## Testing

- A snoozed thread appears in **no** lane, and in the Snoozed tab
- The wake sweep clears the fields and the thread rejoins its derived lane
- **An inbound message on a snoozed thread clears the snooze in the message transaction** —
  asserted without running the fan-out, the same way the archive equivalent is
- A forced thread appears in Chasing and **not** in Waiting, at any age
- Snooze and force are mutually exclusive; each clears the other
- Archiving clears both
- Neither follow-up engine sends to a snoozed thread; the auto-assign sweep skips it
- A forced thread IS eligible for auto-assign
- Custom snooze beyond 30 days is rejected
- Wake times resolve against the account's working-hours config, not UTC
- RBAC: agent can, viewer cannot, neither crosses accounts

## Rollout

1. Deploy schema + indexes (inert — no field is ever set).
2. Deploy the wake cron (inert — nothing is snoozed).
3. Ship the UI.

No backfill, no migration, and every step is reversible by not using the feature. This is a
much smaller rollout than the lanes themselves, because absence is already the correct state.

## Risks

| Risk | Mitigation |
|---|---|
| A snoozed customer writes and stays hidden | Inbound clears the snooze in the message transaction, not the fan-out — the parent spec's hardest-won lesson |
| The wake sweep stalls and threads vanish permanently | Clearing is load-bearing and tested; the cron is registered through `cronSchedules.ts` so a stall is visible; the Snoozed tab keeps the set reachable regardless |
| Snooze becomes a way to hide work | 30-day ceiling, a visible tab ordered by wake time, and `snoozedByUserId` on every row |
| Forced rows appear in two lanes | `chasingForcedAt` is an index key, so Waiting binds it by equality rather than filtering |
| The tab row becomes unusable at five plus three | Called out in §UI; collapsing the assignment axis into a dropdown should land with this |

## Deferred

- **Recurring snooze** ("every Monday until they answer"). No evidence anyone wants it.
- **Snooze from the Lead Analysis board.** The Inbox is where filing happens.
- **Collapsing Mine/Unassigned into a dropdown** to make room for five lane tabs. Should
  probably ship with this, but it is a layout decision with its own opinions.
- **A "snoozed" reason taxonomy** rather than free text. Wait and see what people type.
