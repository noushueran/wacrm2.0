# Lead-routing failsafe — design

**Date:** 2026-07-19
**Status:** approved, implementation plan pending
**Branch:** `fix/lead-routing-failsafe` (from `origin/main` @ 878eee3)

## Problem

A lead the AI has fully qualified can be dropped permanently, with no error,
no log, and no notification to anyone.

`offerContext` (`convex/qualificationEngine.ts:2255`) returns a bare `null` for
**seven** distinct conditions. Three are benign no-ops:

1. auto-assign disabled, or no enabled config
2. the conversation is already assigned
3. a live `offered`/`accepted` offer already exists

Four are genuine routing failures:

4. no `tags` row whose name matches `session.serviceName` (exact string,
   case-insensitive + trimmed — so "Dubai visa" ≠ "UAE visa")
5. the tag exists but has zero `memberTags` links — and those links are
   **created manually**, while the service tag itself is auto-created by the AI
6. links exist but no linked member is an `agent`/`supervisor` with a phone
7. every candidate has already been offered the lead and declined or timed out

`startLeadOffer` (`:2358`) receives one undifferentiated `null` and does
`if (!context) return;` (`:2365`) — treating all seven identically. The
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
| `offer` | Route to this agent | existing payload + `usedFallback: boolean` |
| `noop` | Benign — cases 1–3 | — |
| `exhausted` | Candidates empty, `alreadyTried` non-empty (case 7) | — |
| `unroutable` | Candidates empty, nobody ever tried | `reason: "no_agents"` |

### Candidate selection

Unchanged for the happy path: build from `memberTags` links on the matched
service tag, ordered by fewest accepts in the last 72h.

**New:** the fallback triggers only when the link set never produced an eligible
member *at all*. Precisely:

1. Compute `eligibleLinked` — linked members with role `agent`/`supervisor` and
   a non-empty phone — **before** subtracting `alreadyTried`.
2. If `eligibleLinked` is empty (cases 4, 5, 6): fall back to every account
   membership with role `agent`/`supervisor` and a non-empty phone, set
   `usedFallback: true`, then subtract `alreadyTried`.
3. Otherwise: candidates are `eligibleLinked` minus `alreadyTried`, and
   `usedFallback` stays `false`.

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

- **`offer`** — send the WhatsApp offer exactly as today. If `usedFallback`,
  additionally alert admins that no agent is linked for *&lt;service&gt;* and the
  lead was offered to the whole team.
- **`exhausted`** — alert admins that the lead is stranded, naming customer and
  service, so a human can assign it manually.
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

- **No dedupe on the misconfiguration alert.** Each alert names a real lead that
  took the wrong path, and the volume is self-limiting: fixing the link stops it.
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

- service tag missing → `offer` with `usedFallback`, misconfiguration alert sent
- tag present but zero links → `offer` with `usedFallback`, alert sent
- links present but no eligible member (no phone / wrong role) → `offer` with
  `usedFallback`
- account has no agent or supervisor at all → `unroutable`, alert sent
- **eligible linked members exist but all already tried → `exhausted`, and the
  whole team is *not* offered** (guards the intent rule above)
- fallback pool itself exhausted → `exhausted`, alert sent
- `adminAlertPhones` empty → correct `kind`, no send attempted

Regression tests:

- each of the three benign no-ops still returns `noop` and sends nothing
- happy path (tag + eligible linked agents) selects the same agent and sends the
  same text as before
- the existing `qualificationEngine` suite passes untouched
