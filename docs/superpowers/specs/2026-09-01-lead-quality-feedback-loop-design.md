# Lead-quality feedback loop — design

**Date:** 2026-09-01
**Status:** approved, implementing

## Problem

The Meta CAPI lifecycle integration (`convex/conversionEvents.ts`) reports
`LeadSubmitted` / `QualifiedLead` / `InitiateCheckout` / `Purchase` — but only
`LeadSubmitted` ever fires automatically. The other three depend on an agent
moving the conversation through the CRM funnel, and **no one does**.

The control is not missing. `LeadPopover` in the thread header already opens a
stage picker wired to `funnel.setStage`. An audit of why it goes unused
established the cause: **staff do not know it exists.** It is a silent icon in
a crowded header, labelled in pipeline vocabulary ("Price quoted", "Itinerary
created") rather than in terms an agent thinks in mid-conversation.

So Meta receives raw lead volume and nothing about lead *quality* — which is
the entire point of the integration.

## Solution

An inline **lead-quality card** in the message thread that asks one plain
question at a time, and converts a positive answer into the funnel transition
that already produces the Meta event.

The card is the discoverable front door. The event machinery underneath is
unchanged.

### Why not the alternatives

- **Parallel event path** (card emits conversion events directly): rejected.
  Duplicates the dedup/retry/rollup logic in `conversionEvents.ts` and yields
  two systems that can disagree about what an MQL is.
- **Reuse `funnel.setStage` verbatim**: rejected. Inherits the UI gates
  (sales-checklist on `purchased`, mandatory loss reason) that contribute to
  the friction being fixed.
- **Chosen — capture separately, converge on one event path**: a new
  `leadQuality` module owns the questions and the answer log; positive answers
  call `applyStageTransition` directly, so every Meta event still flows through
  the single outbox.

## Question flow

A three-step progressive state machine. One question at a time, each arriving
when it is actually answerable — asking "did they pay?" on day one is fiction.

```
no answers yet   → "Is this a real customer?"
  yes → stage qualified      → QualifiedLead   (MQL)
  no  → logged with reason; card retires permanently. Nothing to Meta.

genuine = yes    → "Serious about booking?"
  yes → stage price_quoted   → InitiateCheckout (SQL)
  no  → logged; card sleeps 3 days, then re-asks

intent = yes     → "Payment received?" + amount
  yes → stage purchased      → Purchase        (CONVERTED, carries value)
  no  → logged; card sleeps 3 days, then re-asks
```

`dismissed` (the card's `×`) is a third answer value: logged, sleeps 1 day.
It is real signal — it says an agent saw the question and dodged it.

### Implied answers from the current stage

The machine seeds itself from `conversation.funnel.stage` as well as from
logged answers, so it never asks about a milestone the CRM already passed. A
lead manually moved to `price_quoted` is treated as having answered `genuine`
and `intent` yes, and is asked only about payment.

`lost` is excluded from this mapping — it is a terminal exit, not progression.
A lost conversation retires the card.

Because the card only ever asks about steps that are *not* already implied,
every transition it applies is forward. `neverDowngrade: true` is passed
regardless, as a second line of defence.

## The "only if good" rule

Structural, not a conditional. A `no` answer writes its row and returns; there
is no code path from a negative answer to `applyStageTransition`. The same
holds for organic conversations: the card is shown only where
`conversation.attribution` exists, which is exactly the set that can produce a
Meta event at all.

Bad leads are still **captured** — that is the feedback loop the business
asked for. They live in `leadQualityAnswers` and feed reporting; they simply
never reach Meta.

## Data model

New table `leadQualityAnswers`, one row per answer (append-only — a re-answer
adds a row rather than editing one, so the trail shows what changed and when):

| field | notes |
| --- | --- |
| `accountId`, `conversationId`, `contactId` | scoping |
| `step` | `genuine` \| `intent` \| `payment` |
| `answer` | `yes` \| `no` \| `dismissed` |
| `reason` | optional; the `no` reason code |
| `value`, `currency` | payment step only |
| `byUserId` | who answered |
| `conversionEventId` | optional. Set only when the answer seeded a Meta event — the audit proving a `no` never did. |

Indexes: `by_conversation` (the card's own read), `by_account` (reporting).

## Access

Mirrors `funnel.setStage`: `requireRole("agent")` plus
`requireConversationAccess(..., "own")`. Viewers cannot answer; agents may only
answer on threads assigned to them; supervisors+ on any.

## The checklist bypass

`funnel.setStage` refuses `purchased` while the sales checklist is incomplete.
The card **bypasses that gate** (approved 2026-09-01): it records that money
arrived, which is a fact, not a certification of deal hygiene. Blocking the
single most valuable question behind a checklist is how this data goes
uncollected. The card still requires a positive amount — `purchased` without a
value is refused by `seedStageConversionEvent`'s payment guard regardless of
caller.

## UI

- `src/components/inbox/lead-quality-card.tsx` — compact inline card rendered
  below the last message in `message-thread.tsx`.
- One question, two buttons. `no` reveals a reason select; `payment` reveals an
  amount input. `×` dismisses.
- `src/lib/inbox/lead-quality.ts` — UI mirror of the step definitions, matching
  the existing `src/lib/inbox/funnel.ts` convention that the frontend never
  imports across the `convex/` boundary.
- The header `LeadPopover` is untouched. This adds a front door; it does not
  remove the existing one.

## Testing

- **Pure state machine**: exhaustive table over (answers × current stage × now)
  — including that `genuine: no` retires permanently, that cooldowns expire,
  and that `lost` retires the card.
- **Mutation**: each `yes` seeds exactly one event of the right stage; each
  `no`/`dismissed` seeds none; re-answering does not double-send; organic
  conversations log but never seed.
- **Access**: viewer refused, unassigned agent refused, supervisor allowed.
- **Payment**: a zero/absent amount is refused.

## Consequence to flag

Adding `convex/leadQuality.ts` is a new Convex module, so
`convex/generatedApi.test.ts` (the codegen drift guard) fails until
`npx convex codegen` runs. `convex deploy` runs codegen as a step, so a
deployment resolves it; a local test run before that will show one failure.
