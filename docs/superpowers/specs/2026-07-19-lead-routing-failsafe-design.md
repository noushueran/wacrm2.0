# Lead-routing failsafe — design

**Date:** 2026-07-19
**Status:** implemented; corrected post-implementation (see "Corrections" below)
**Branch:** `fix/lead-routing-failsafe` (from `origin/main` @ 878eee3)

> **Corrections after the final whole-branch review.** Three claims in the
> original draft of this document were wrong, and are fixed in place below.
> They are listed here because each one caused real work:
> 1. The problem statement said "no notification to anyone." **Overstated** —
>    in-app `lead_qualified` notifications (`:759-769`), push (`:780`) and the
>    `pending` conversation state (`:724`) all still fire. What is actually
>    lost is **auto-assignment and the WhatsApp nudge**. The bug is real and
>    worth fixing; it is not total invisibility.
> 2. The condition enumeration was **incomplete**: it began at "auto-assign
>    disabled" and never accounted for `offerContext`'s *first* guard, which
>    also swallows a qualified session with no `serviceName`. That gap shipped
>    into the implementation as a surviving permanent silent drop and was
>    caught only by the final review. It is now condition 8.
> 3. "No dedupe on the misconfiguration alert" was justified with per-lead
>    reasoning, but the code fires **per offer attempt** — up to one alert per
>    eligible team member for a single lead. The justification was
>    arithmetically wrong; the design now dedupes.

## Problem

A lead the AI has fully qualified can be dropped permanently: never
auto-assigned, never offered to an agent over WhatsApp, and with no error, no
log, and no alert to an administrator. (In-app and push notifications do still
fire — see correction 1 above.)

`offerContext` (`convex/qualificationEngine.ts:2255`) returns a bare `null` for
**eight** distinct conditions. Three are benign no-ops:

1. auto-assign disabled, or no enabled config
2. the conversation is already assigned
3. a live `offered`/`accepted` offer already exists

Five are genuine routing failures:

4. no `tags` row whose name matches `session.serviceName` (exact string,
   case-insensitive + trimmed — so "Dubai visa" ≠ "UAE visa")
5. the tag exists but has zero `memberTags` links — and those links are
   **created manually**, while the service tag itself is auto-created by the AI
6. links exist but no linked member is an `agent`/`supervisor` with a phone
7. every candidate has already been offered the lead and declined or timed out
8. **the session qualified with no `serviceName` at all.** Added post-review —
   see correction 2. `serviceName` is only written when the analysis returns
   one, and neither the readiness gate (`:403`, `:422`) nor
   `completeQualification` (`:681`) consults it, so a session can reach
   `qualified` without one while `startLeadOffer` is still scheduled (`:793`).
   No test could reach this through the natural path, because the dry-run
   analysis stub hardcodes `service: "UAE visa"` — it needs a direct insert.

`startLeadOffer` (`:2358`) receives one undifferentiated `null` and does
`if (!context) return;` (`:2365`) — treating all eight identically. The
`console.error` at `:2391` sits in a `catch` block and never fires, because
nothing throws.

### Why it is permanent, not merely delayed

In cases 4–6 **no `leadOffers` row is ever written**. The retry cron
`sweepLeadOffers` (`:2512`) finds work via `getExpiredOffers` (`:2526`), which
queries `leadOffers` on the `by_status_offered` index. A lead that never
received its first offer has no row, so the sweep is structurally incapable of
seeing it. The conversation keeps `assignedToUserId === null` and sits in the
shared pool indefinitely.

Case 7 is a second, distinct silent death: the offer cycle completes, everyone
passes, and the lead simply stops moving with nobody informed.

**Root cause:** `offerContext` cannot express *why* it declined to act, so its
one caller cannot distinguish "nothing to do" from "cannot route this lead."

## Approach

Three options were considered.

**A. Discriminated result from `offerContext`** — *chosen*. Replace the bare
`null` with a tagged union so every exit is explicit and individually testable.
Adding a new silent exit becomes impossible without choosing a tag.

**B. Separate diagnostic query** — leave `offerContext` alone and, on `null`,
run a second query to determine why. Rejected: it re-runs the same reads and
duplicates candidate logic in a second location that will drift out of sync.
That drift is precisely how this class of bug returns.

**C. Fallback inside `offerContext` only** — widen candidates when links are
empty, with no signalling. Rejected: still returns `null` for cases 6 and 7, so
the silent-loss channel stays open. Fixes the common case and leaves the bug.

## Design

### Result shape

`offerContext` returns a discriminated union:

| `kind` | Meaning | Fields |
|---|---|---|
| `offer` | Route to this agent | existing payload + `fallback: FallbackCause \| null` + `firstAttempt: boolean` |
| `noop` | Benign — cases 1–3 only | — |
| `exhausted` | Candidates empty, `alreadyTried` non-empty (case 7) | `scope: "linked" \| "team"` |
| `unroutable` | Candidates empty, nobody ever tried | `reason: "no_agents"` |

`FallbackCause` distinguishes *why* the tag could not route the lead, because
the remedy differs and the admin alert must name the right one:

| cause | Meaning | Remedy the alert prescribes |
|---|---|---|
| `tag_unlinked` | tag exists, zero links (case 5) | link agents to that tag |
| `links_ineligible` | linked, but nobody has the role + a phone (case 6) | add a phone / fix the role |
| `tag_missing` | no tag row at all (case 4) | the tag itself does not exist |
| `no_service_name` | qualified with no service (case 8) | route manually; the AI named no service |

The original draft used a single `usedFallback: boolean` here. The final review
rejected it: one boolean collapsed three causes whose remedies differ, so the
alert told an admin to "link agents to the tag" even when agents *were* linked
and the real problem was a missing phone number, or when no such tag existed.

`scope` on `exhausted` exists for the same reason — "everyone eligible has
passed" is false on the linked path, where the rest of the team was never
asked, by design (see Candidate selection). `firstAttempt` gates the fallback
alert to one message per lead rather than one per offer attempt.

### Candidate selection

Unchanged for the happy path: build from `memberTags` links on the matched
service tag, ordered by fewest accepts in the last 72h.

**New:** the fallback triggers only when the link set never produced an eligible
member *at all*. Precisely:

1. Compute `eligibleLinked` — linked members with role `agent`/`supervisor` and
   a non-empty phone — **before** subtracting `alreadyTried`.
2. If `eligibleLinked` is empty (cases 4, 5, 6) — or the session has no
   `serviceName` to match a tag against at all (case 8) — fall back to every
   account membership with role `agent`/`supervisor` and a non-empty phone, set
   `fallback` to whichever of the four causes applies, then subtract
   `alreadyTried`.
3. Otherwise: candidates are `eligibleLinked` minus `alreadyTried`, and
   `fallback` stays `null`.

This distinction is deliberate. An empty link set means **no routing intent was
ever expressed**, so widening to the whole team is strictly better than losing
the lead. But if eligible linked members exist and have each passed, the intent
*was* expressed and honoured — those people are the designated handlers, quite
possibly for reasons of language or specialism. Widening there would silently
override a deliberate configuration, so that case becomes `exhausted` and goes
to a human instead.

If candidates are empty after this, distinguish by `alreadyTried`: non-empty →
`exhausted`; empty → `unroutable` with `reason: "no_agents"`. Ordering (fewest
accepts in the last 72h) is unchanged in every branch.

### `startLeadOffer` behaviour

- **`offer`** — send the WhatsApp offer first, exactly as today. Then, if
  `fallback` is non-null **and** `firstAttempt`, alert admins — with the message
  chosen by `fallback`, so it names the remedy that actually applies. The alert is
  strictly supplementary and must never precede or block the offer itself: an
  earlier draft awaited it first, which meant a failure in the alert leg could
  suppress the agent send while leaving an `offered` row behind, stranding the
  lead permanently. The alert action swallows its own errors for the same
  reason.
- **`exhausted`** — alert admins that the lead is stranded, naming customer and
  service, and wording it by `scope`: on `linked`, say that only the agents
  linked to that service were asked (the rest of the team was deliberately not),
  since an admin told "everyone has passed" would wrongly deprioritise it.
- **`unroutable`** — alert admins that no eligible agent exists in the account.
- **`noop`** — return silently, as today.

### Alerting

Reuse `notifyStaffText` to `config.adminAlertPhones`. Alerts are **not** gated
on `adminAlertEnabled`, mirroring the deliberate precedent of the ask-admin
protocol at `:1754`: these are operational failures ("routing is broken",
"a lead is stranded"), not routine lead notifications. Someone who muted
new-lead pings still wants to hear that leads are being dropped.

When `adminAlertPhones` is empty there is no delivery channel; the alert is
skipped. The `console.error` path remains for genuine exceptions.

### Why `exhausted` fires exactly once

It is only reachable when the last outstanding offer closes and re-triggers
`startLeadOffer`. Once that returns `exhausted`, no offer rows remain, so
`sweepLeadOffers` never revisits the session. No timer, flag, or dedupe state
is required.

## Deliberate omissions

- ~~**No dedupe on the misconfiguration alert.**~~ **Reversed — see correction 3.**
  The original reasoning was per-lead ("each alert names a real lead that took
  the wrong path, and the volume is self-limiting"). But the alert fires per
  *offer attempt*, so one lead on a six-person team could send six identical
  messages plus a seventh when the cycle exhausted — ungated WhatsApp messages
  to the owner's phone, on the very channel the failsafe depends on. The design
  now fires the fallback alert only on the first attempt for a session
  (`firstAttempt`, derived from `alreadyTried.size === 0`).
  Revisit only if lead volume per unlinked service makes this noisy.
- **No fuzzy or semantic service matching.** Once a missed match falls back to
  the whole team plus an alert, a name mismatch costs routing *precision*, not
  the lead — demoting it from a bug to an optimisation. The proper fix already
  exists in Phase 1 of Knowledge Engine v2: `kbServices` ships `aliases` and
  `routingTagName`, purpose-built for this. It belongs in the P3 serving
  cutover, not duplicated here.
- **No new config field.** Alerts are ungated, so nothing to configure.

## Compatibility and risk

- **Billing is unaffected.** `chargeLeadIfAgent` (`:1988`) fires on offer
  *acceptance*. This change alters who is offered, not how acceptance works, so
  no new assignment path is introduced and no charge is bypassed.
- **The happy path must stay byte-identical** — when a service tag exists with
  eligible linked members, selection and message text are unchanged.
- **Blast radius** is `convex/qualificationEngine.ts` only. This file is no
  longer contended: `feat/purchase-signals` merged to `origin/main` at 462a441.
- **Rollback** is a plain revert; no schema change, no migration, no new table.

## Testing

Unit tests, one per result kind:

- service tag missing → `offer` with cause `tag_missing`, alert sent
- tag present but zero links → `offer` with cause `tag_unlinked`, alert sent
- links present but no eligible member (no phone / wrong role) → `offer` with
  cause `links_ineligible`, and the alert names the *right* remedy
- **session qualified with no `serviceName` → `offer` with cause
  `no_service_name`, alert sent** (case 8; needs a direct session insert — the
  dry-run stub always supplies a service, so the natural path cannot reach it)
- account has no agent or supervisor at all → `unroutable`, alert sent
- fallback alert fires **once per lead**, not once per offer attempt
- **eligible linked members exist but all already tried → `exhausted`, and the
  whole team is *not* offered** (guards the intent rule above)
- fallback pool itself exhausted → `exhausted`, alert sent
- `adminAlertPhones` empty → correct `kind`, no send attempted

Regression tests:

- each of the three benign no-ops still returns `noop` and sends nothing
- happy path (tag + eligible linked agents) selects the same agent and sends the
  same text as before
- the existing `qualificationEngine` suite passes untouched
