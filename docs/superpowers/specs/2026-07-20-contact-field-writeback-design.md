# Qualification field write-back to the contact — design

**Date:** 2026-07-20
**Status:** approved, implementation plan pending
**Branch:** `feat/contact-field-writeback` (from `origin/main` @ 5979d03)

## Problem

The qualification engine extracts structured facts from the conversation —
destination, nationality, travel dates, travellers, budget, email — and stores
them in `qualificationSessions.fields[]` as
`{ key, label?, value, confidence, updatedAt }`.

**None of it ever reaches the contact record.** Verified against `origin/main`:
`convex/qualificationEngine.ts` patches `qualificationSessions`,
`conversations`, `leadOffers` and `inquiries` — and never `contacts`. So a rep
opening the contact panel sees empty fields and hand-types values the AI
already captured minutes earlier.

This is item 1 of the 2026-07-19 AI-opportunity audit's "plumb what's already
bought": value available with **no new model calls**.

## What is actually collected

Established by reading the shipped config and the KB content rather than
assuming. Two sources feed `fields[]`:

1. `qualificationConfigs.basicFields` — the **off-topic fallback** only. The
   shipped default (`convex/lib/qualification/defaults.ts`) is four keys:
   `looking_for`, `travel_dates`, `travelers`, `email`.
2. Per-service `QUALIFICATION CHECKLIST` sections in the KB documents, which
   are where the real questions live. Their recurring items are: destination /
   destination country, nationality, travel dates, travellers (adults + child
   ages), budget per person, email, and visa type/duration.

Against `contacts`' existing columns, only **three** of those have a home:
`email`, `nationality`, `preferredDestination`.

**Travel dates, travellers and budget — the fields reps most often re-type —
have no column at all.** An earlier draft of this design mapped only to
existing columns; it would have addressed the easy third of the complaint and
left the substance of it untouched.

## Design

### 1. Three new contact columns

`contacts` already carries a block commented *"Extended CRM detail — all
optional, edited from the inbox contact panel. Additive/backward-compatible;
no migration"* (`convex/schema.ts:80-87`). Three more join it:

```ts
travelDates: v.optional(v.string()),
travelers:   v.optional(v.string()),
budget:      v.optional(v.string()),
```

All three are **free-text**, deliberately. The extractor returns prose — "mid
December", "2 adults + 1 child aged 9", "around AED 3,000 per person" — and
parsing that into structured dates or numbers is a separate problem with its
own failure modes. Storing what the customer said, verbatim, is both honest
and immediately useful to a human reading it.

They follow every existing extended field end to end: mutation arg → adapter →
client type → contact sidebar → i18n label. A rep can edit them by hand
whether or not the AI ever fills them.

### 2. A pure mapping library

`convex/lib/qualification/contactFields.ts` exports:

```ts
mapFieldsToContact(
  fields: { key: string; label?: string; value: string; confidence: "high"|"medium"|"low" }[],
  contact: Doc<"contacts">,
): Partial<Doc<"contacts">>
```

Pure — no `ctx`, no I/O — so the whole mapping is unit-testable without
convex-test. It returns **only the patch to apply**, empty when there is
nothing to write.

**Matching.** Both the field's `key` and its `label` are normalised (lowercased,
non-alphanumerics stripped) and looked up in an alias table:

| Column | Aliases |
|---|---|
| `email` | email, emailaddress |
| `nationality` | nationality, citizenship |
| `preferredDestination` | destination, destinationcountry, preferreddestination, travellingto |
| `travelDates` | traveldates, dates, travelmonth |
| `travelers` | travelers, travellers, pax, passengers, numberoftravelers |
| `budget` | budget, budgetperperson, perpersonbudget, tripbudget |

Matching on the label as well as the key matters: checklist keys are
`slugify(label)`-derived and vary per service, but the labels are close to
natural language and far more stable.

**Two precedence rules, because both cases are reachable and silence here
would produce two different implementations:**

1. **Key beats label.** Try the normalised `key` first; consult `label` only
   when the key matches nothing. The key is the extractor's own identifier,
   the label is human prose that may coincidentally contain another field's
   alias ("Travel dates and destination", say).
2. **First write wins per column.** If two *different* keys resolve to the same
   column — `destination` and `destination_country`, say — keep the first and
   ignore the rest. Do not concatenate, and do not let the last one overwrite.

   The ordering this relies on is worth stating precisely, because
   `mergeFields` (`lib/qualification/analyze.ts:255`) is subtler than it looks:
   it keys a `Map` off the field key seeded from the existing array, so a field
   holds its **first-seen position** while its **value is refreshed to the
   latest extraction**. So `fields[]` is ordered by first appearance, not by
   recency of value. "First wins" therefore means *the key that appeared
   earliest in the conversation*, carrying its most recent value — which is
   both deterministic and the sensible reading.

**The table is a conservative allowlist, and that is the point.** Because the
mapper only ever fills blanks, a wrong write is **permanent** — nothing later
corrects it. An unmapped field is therefore strictly better than a mis-mapped
one: it simply stays in the session, where the rep can still read it. Two
entries from the first draft — `when` for `travelDates` and `mail` for `email`
— were removed in review on exactly this ground: both are generic English
words absent from the documented checklist vocabulary, and a visa-approval
deadline extracted as `when`, or a physical mailing address as `mail`, would
have been misfiled forever.

**`country` is deliberately unmapped.** In a travel CRM "country" reads as the
destination at least as often as the customer's residence. Guessing wrong
writes a permanent wrong value into a blank field that nothing will ever
correct — see the overwrite rule below. Better unmapped than confidently wrong.

**`looking_for` is deliberately unmapped.** It identifies the *service*, which
already lands on `session.serviceName` and drives tag routing.

### 3. Write rules

- **Fill blanks only — never overwrite.** A value already present was typed by
  a rep or written by an earlier extraction, and a human's correction must
  outrank a fresh guess. This makes the feature purely additive: it cannot
  destroy data.
- **Skip `low` confidence.** Matches the existing convention — the engine
  already filters `f.confidence !== "low"` when building summaries and admin
  alerts (`qualificationEngine.ts:627`, `:643`, `:716`).
- **Skip blank values**, and skip writing entirely when the patch is empty.

### 4. When it runs

**Once, at `completeQualification`** — not on every analysis pass.

**Scoped to the write, never gating the pipeline.** The contact load must not
be allowed to abort completion. `conversations.contactId` can dangle after a
contact delete — `convex/contacts.ts:550-561` documents this and notes the read
layer tolerates it on purpose, and `adminAlertContext` handles it by no-opping
inside its own scope rather than returning from its caller. An early
`if (!contact) return;` in `completeQualification` would skip the session
status patch, the funnel transition, the Meta conversion event and the
notifications — turning "we cannot fill a contact that no longer exists" into a
silently, permanently lost qualified lead. The first implementation did exactly
that and it was caught in review; the write is now wrapped in `if (contact)`
with a regression test pinning that a session whose contact is gone still
reaches `qualified`.

This follows from the overwrite rule, and the interaction is the reason it is
worth stating: with fill-blanks-only, whatever lands *first* wins permanently.
Writing on every pass would let an early medium-confidence guess lock out a
later high-confidence correction of the same field. Writing once, when the
values have settled, avoids that entirely.

## Testing

- **Pure mapper** (`contactFields.test.ts`): alias hits by key and by label,
  normalisation, `low` confidence excluded, blank values skipped, already-filled
  columns left untouched, unknown keys ignored, empty patch when nothing applies.
- **Engine integration** (convex-test): a session that qualifies lands the
  values on the contact, and a contact with a pre-filled column keeps its own
  value.
- **Sidebar**: the mutation round-trip is covered by a convex-test against
  `contacts.update`. The *component* itself is *not* unit-tested — the sidebar
  is a client component wired to `useTranslations` and Convex hooks, and this
  repo has no jsdom or Testing Library to render it with. Stated rather than
  implied: the three `<Field>`s are copies of an established pattern in the same
  section, so the risk is a visible typo rather than broken behaviour, and the
  browser check in the deploy runbook is what actually covers it.

## Risk and rollout

- **Additive only.** No migration; every existing contact simply has three more
  empty optional columns.
- **Cannot destroy data** by construction — it only ever writes into blanks.
- 🚨 **This one DOES need `npx convex deploy`**, unlike a purely client-side
  change: the deployed schema must accept the new columns before any write
  containing them succeeds. Owner-gated, and the backend must be deployed
  **before** the Netlify build that ships the sidebar UI.
- **Collision watch:** `feat/r2-media-storage` also edits `convex/schema.ts`
  (dormant media key fields) and `src/lib/convex/adapters.ts`. Different tables
  and different adapter functions, so conflicts should be textual rather than
  semantic — but the second of the two to merge must re-run the suite, not just
  accept the merge.

## Deliberate omissions

- **No parsing of dates, counts or amounts** into structured types. Free text is
  what the extractor produces and what a human can read; structuring it is a
  separate change with its own failure modes.
- **No auto-created custom fields.** With native columns for the recurring set,
  the remaining unmapped keys (visa type/duration, inside-or-outside UAE) are
  service-specific and belong to the KB, not the contact record.
- **No backfill** of contacts from historical sessions. The rules are
  fill-blanks-only, so a backfill is safe in principle and can be a separate,
  reviewable change with its own dry-run.
- **No provenance tracking** (which values the AI wrote vs a human). It would
  allow smarter overwriting later, but nothing records it today and adding it
  touches every contact edit path.
