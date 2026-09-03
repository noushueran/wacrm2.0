# Meta Custom Audience sync

Reconciles CRM contacts against the Meta customer-list audience named by
`META_CUSTOM_AUDIENCE_ID` once a day. The cron (`meta-audience-sync`, runs
every 1440 minutes) calls `internal.metaAudienceSync.syncAudience`.

The audience ID and ad account are per-deployment configuration and appear
nowhere in the code — set them per "Turning it on" below. The verification
recorded next was performed on the Amani deployment, which is where this
code was written; the wire format it settles is the same everywhere, the
account facts it reports are that deployment's.

## Verified against live Meta on 2026-09-03

The wire format in `sendAudienceDelta` (`convex/metaAudienceSync.ts`) has
been exercised against the real Graph API using the Amani deployment's
`META_ADS_ACCESS_TOKEN`. A digest of a text string — which can match no
real phone number, so no one's ad targeting moved — was added to that
deployment's audience and then removed:

| Call | Result |
| --- | --- |
| `POST /{id}/users` | HTTP 200, `num_received: 1`, `num_invalid_entries: 0` |
| `DELETE /{id}/users` | HTTP 200, `num_received: 1`, `num_invalid_entries: 0` |

Both previously-unproven specifics hold: **DELETE with a JSON body works**
(Meta does not drop the body), and **`access_token` in the JSON body is
accepted** for this endpoint. If you are ever tempted to "fix" the REMOVE
path into a POST, or move the token to the query string, don't — the
current shape is the observed-working one.

The successful write also proves what the read probe could not: that ad
account had accepted Meta's Custom Audience Terms, and the token held
asset-level permission on it. Neither carries over — both are facts about
an account, and this deployment has to satisfy them for its own (see the
prerequisites below).

That token was a non-expiring `SYSTEM_USER` token carrying
`ads_management`, with `expires_at` and `data_access_expires_at` both `0`.
Use the same kind here: there is then no renewal date to diary, but note
that a revoked or rotated token fails silently in the sense that the
audience simply stops changing. See "If the sync looks stuck" below.

What is still untested: a **multi-row** batch (the probe sent one row) and
behaviour at the 300-row batch boundary. The first production run is the
first test of those.

## Turning it on

Both env vars must be set on the Convex deployment. With either missing,
`syncAudience` returns immediately with `skipped: true` and touches
nothing — same posture as the conversion-delivery lanes.

    npx convex env set META_CUSTOM_AUDIENCE_ID <customer-list audience id>
    npx convex env set META_ADS_ACCESS_TOKEN <token with ads_management>

Prerequisites on the token/account side, both required and neither
optional:

- The token needs `ads_management` on the ad account that owns the
  audience.
- That ad account must have accepted Meta's Custom Audience Terms of
  Service. This is a one-time click in Ads Manager — it cannot be done
  over the API, and the sync will fail (or silently do nothing useful)
  until someone has clicked it.

Example manual probe against the Graph API (uses `v25.0`, matching
`META_GRAPH_VERSION`'s default in `convex/conversionEvents.ts` — the same
version `metaAudienceSync.ts` derives for itself):

    curl -X GET "https://graph.facebook.com/v25.0/<audience id>?fields=name,approximate_count_lower_bound&access_token=<token>"

A successful response here is evidence the token and audience ID are
valid; it does not exercise the ADD/REMOVE endpoints or their body-format
risks above.

## Who is in the audience

Membership is computed in `convex/lib/metaAudience.ts` (`shouldBeMember`).

**In:** a contact whose normalized phone has at least 7 digits (i.e. could
plausibly carry a country code), that is not flagged do-not-contact, and
that has no conversation whose funnel stage is `purchased`.

**Out:** any of — do-not-contact set, a conversation at stage `purchased`,
or a phone too short to be usable.

`lost` leads deliberately **stay in**. `lost` is a terminal exit in the
funnel, but a lost lead did not buy — they're exactly who retargeting
exists for. `EXCLUDED_STAGES` in `convex/lib/metaAudience.ts` currently
contains only `purchased`; if someone "fixes" this later by adding `lost`
to it, that is undoing an intentional decision, not a bug fix.

## Reading the sync result

`syncAudience` returns:

    { skipped, added, removed, unchanged, failedBatches, invalid }

Three counting gotchas to know before you read these numbers on a bad night:

- **`added`/`removed` count contacts Meta ACCEPTED, not contacts whose
  mirror row was written.** A contact touched by a failed batch is counted
  in neither. But a contact whose ADD batch succeeded and whose sibling
  REMOVE batch (same pass, e.g. a phone change) failed IS counted in
  `added` even though its mirror write is deliberately skipped — the mirror
  must stay untouched for that contact so the next pass retries the failed
  half. Do not treat `added + removed` as "rows now correct in the mirror."
- **`added` and `removed` count contacts. `failedBatches` counts
  batches.** Each Graph call carries up to `GRAPH_BATCH` = 300 contacts.
  `failedBatches: 2` can mean anywhere from 1 to 600 people who did not
  get synced tonight — do not read it as "2 contacts failed."
- **A batch only counts as successful when Meta returns `ok: true` AND
  `received === batch.length`.** A 2xx response with a short or unparsable
  body is treated as a failure, not a success, because Meta's audience API
  is write-only — nothing can read membership back later to catch a false
  positive. If the mirror ever wrongly records success, no later pass can
  detect or repair it.

The consequence of that strict check, and why it's not a problem: a failed
batch leaves `metaAudienceMembers` (the local mirror) untouched for exactly
those contacts. The next night's pass recomputes desired state from
scratch, sees the same contacts still needing a change, and retries them.
**Transient Graph failures self-heal with no manual intervention.** There
is deliberately no retry loop inside a single run — a Graph outage should
cost one quiet night, not a storm of retried requests.

### If you see `invalid > 0`

Meta reports invalid rows **inside** `num_received` (a batch with 299 good
rows and 1 bad one reports `received: 300`) and never says which row was
bad. The code can't subtract it out without endlessly re-retrying the 299
good rows, so `invalid` is surfaced purely for visibility — a
`console.warn` per batch, plus the running total in the return value.

There is nothing automatic to fix here. A nonzero `invalid` count means
some rows we uploaded were malformed in Meta's eyes (most likely a
hash Meta doesn't recognize as a phone-shaped value), and the local mirror
may now believe more contacts are audience members than Meta actually
holds. If you see this, it's a signal to investigate the shape of the data
going in — not something the next nightly pass corrects on its own.

## If the mirror drifts

`metaAudienceMembers` records what we *believe* Meta holds. Meta's API
gives no way to read actual membership back, so there is no way to
directly detect drift — only to suspect it (e.g. ad performance implies
the audience is smaller or larger than the mirror claims, or `invalid` has
been nonzero for a while).

The repair, if you decide the mirror is wrong: delete that account's rows
from `metaAudienceMembers` and let the next nightly pass re-add everyone
it currently believes belongs. This is safe — adding a contact Meta
already holds is a no-op on Meta's side — so a full re-add costs nothing
but a bigger batch of ADD calls for one night.

## Scan limits

`SCAN_CAP` = 20,000 contacts per account, per pass (`convex/metaAudienceSync.ts`).
Production held 2,778 contacts as of 2026-09-03 — about 7x headroom.

If the contacts table ever approaches this number, the fix is **cursor
pagination across passes, not a bigger cap**. `.take()` reads in index
order, so silently raising the number just delays the problem — once the
real count exceeds whatever the cap is, the same tail of contacts falls out
of `desired` on every single night's sync. That is not a harmless skip: any
of those contacts already believed to be an audience member gets **actively
removed** from the Meta audience by `diffMembership`'s orphan-cleanup loop,
permanently, with no error and no failing test to catch it.

A related, smaller cap: `CONVERSATIONS_PER_CONTACT_CAP` = 200 conversations
read per contact when determining funnel stage. Production is close to a
1:1 contact:conversation ratio today, so this is headroom, not a limit
anyone is near. If a contact ever has a `purchased` conversation that
falls outside this window, `shouldBeMember` won't see it and that
converted customer will quietly stay in the retargeting audience.

## Where to look when it misbehaves

Settings → Cron schedules, row `meta-audience-sync`. A failed run is
recorded there with its error. Check the returned counts (`added`,
`removed`, `unchanged`, `failedBatches`, `invalid`) against the notes above
before assuming something is broken — a nonzero `failedBatches` on one
night is expected to self-heal; `skipped: true` means the env vars aren't
both set, not that something crashed.
