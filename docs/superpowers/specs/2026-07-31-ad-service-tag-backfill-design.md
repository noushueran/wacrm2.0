# Ad-service tag backfill

**Date:** 2026-07-31
**Status:** approved, implementing

## Problem

`docs/superpowers/specs/2026-07-30-ad-referral-service-tagging-design.md` shipped
ad-service tagging for *new* click-to-WhatsApp leads. It is not retroactive: the
`adReferrals` rows already in the deployment carry no `serviceMatchStatus`, and
nothing will ever revisit them, because both live passes are scheduled from
`ingest.processInbound` on an inbound message that has already been and gone.

The owner wants the existing backlog tagged too.

## Decisions (owner, 2026-07-31)

- **Rules only, no AI.** The free matcher against `kbServices` names and aliases.
  Costs nothing, runs in seconds, is fully predictable, and — unlike live traffic
  — a backlog would fire every AI call at once with no human pacing.
- **Whole history**, no time window. Tags are cheap; an old lead that resurfaces
  is still worth labelling, and the full history gives the richest alias-review
  signal.
- **Dry run is the default first step**, reporting counts before anything is
  written.

## Design

### One pass, not two

Live traffic gets two passes because at click time the landing page has not been
fetched and the customer has not spoken. History has neither problem — everything
already exists — so the backfill runs a single pass with the full signal set:

- `headline` / `body` / `sourceUrl` from the referral row;
- `campaignAds` ad/ad-set/campaign names, when a resolved row exists;
- `adLandingPages` title/description, when a cache row exists;
- the customer's first two messages after the click, via the same
  `customerMessagesSince` + `referralAnchorTime` pair the live path uses.

On historical rows the `campaignAds` and `adLandingPages` caches were frequently
never warmed, so those signals are often absent. The customer's own words, by
contrast, are always present — which live pass 1 never has. The backfill
therefore sees a *different* mix from either live pass, not a strictly better one.

The backfill performs **no network I/O**: it reads whatever caches exist and does
not warm them. Fetching landing pages for the whole backlog is a different job
with a different risk profile, and is out of scope.

### It must not close doors behind it

A miss records `serviceMatchStatus` (`unmatched` / `ambiguous`) for the alias
review, but deliberately **does not** touch `serviceMatchAttempts`. Two reasons:

1. If that customer ever messages again, the live follow-up pass still gets its
   fair try — the backfill has not silently spent the budget.
2. The owner can improve `kbServices.aliases` and **re-run the backfill**. Gating
   on the attempt counter would make the second run a no-op, which is the
   opposite of what this tool is for.

Re-runs are therefore additive only: a referral already `matched` is skipped, so
a second pass can tag more but never re-tags, overwrites, or double-tags.

### Reuse, don't reinvent

The backfill calls the same `matchService` and the same
`tagContactForService(..., source: "ad")` the live path calls. It is a different
way of reaching already-live code, not a second implementation. Where the live
orchestrator's signal-gathering can be shared without contorting it, it is shared;
where sharing would mean bending a mutation-shaped helper into a query, it is not.

### Shape

`convex/adServiceBackfill.ts`, following `convex/inboxBackfill.ts` exactly:
a paginated `internalMutation`, re-runnable, idempotent, invoked with
`npx convex run`, carrying a `DELETE THIS MODULE once the backfill has run`
banner.

```
backfillAdTags({ dryRun?: boolean, cursor?: string | null, batchSize?: number })
  → { cursor, isDone, scanned, tagged, unmatched, ambiguous, skipped,
      byService: Record<string, number> }
```

`dryRun` defaults to **true** — the safe default is the one you get by forgetting
the flag. `byService` is what makes the dry run worth reading: it names which
services would be applied and how often, so an obviously wrong alias shows up as
an implausible count before any data is touched.

Batches are paginated so a large backlog runs in chunks rather than one long
transaction, matching `inboxBackfill`'s cursor protocol.

### Undo

Every tag the backfill creates carries `source: "ad"`, so its output is
identifiable as a set. A companion `removeBackfilledTags({ dryRun })` deletes
`contactTags` rows with `source: "ad"`, so the owner is not dependent on the
author being available to reverse a bad run.

This deletes live-path tags too — `source` does not distinguish backfill from
live. That is stated plainly in the module banner rather than papered over with a
marker field: the realistic use is "the whole feature mislabelled things, take it
all off", and a backfill-only undo would leave exactly the rows the owner is
trying to be rid of.

### Multi-tenancy

The paginated scan is table-wide, so every row's own `accountId` is used for the
`kbServices` lookup and the tag write. There is no ambient account. A referral
never reaches another account's services or tags.

## Testing

`convex/adServiceBackfill.test.ts`, `convex-test`:

- a referral whose headline names a service is tagged, `source: "ad"`
- `dryRun: true` writes nothing but reports the same counts
- `dryRun` defaults to true when the flag is omitted
- re-running is additive: an already-`matched` referral is skipped, no duplicate
  `contactTags`
- a miss records `unmatched` and leaves `serviceMatchAttempts` untouched
- two services matching records `ambiguous` and tags nothing
- a contact already tagged for that service by qualification keeps `source: "ai"`
- customer messages after the click contribute; messages before it do not
- two accounts with same-named services never cross
- `byService` counts what was actually applied
- `removeBackfilledTags` deletes only `source: "ad"` rows, and honours `dryRun`

## Out of scope

- Any AI call.
- Warming `adLandingPages` or resolving `campaignAds` for historical rows.
- Changing live tagging behaviour in any way.
