# WhatsApp Verified-Conversion Attribution

> **Status:** LIVE in production on both lanes. Last verified against the
> codebase and the running deployment **2026-09-01**.
>
> This document was rewritten on 2026-09-01. The previous version described
> the `attributionSignals` design that shipped in July 2026 and was replaced
> by the funnel/`conversionEvents` rewrite. It had become actively
> misleading — it documented a deleted module, a removed cron, a visible
> `HY-XXXXXX` code that is now invisible, and a "dormant, not deployed"
> status that stopped being true months ago. The superseded design is
> summarised in [What changed](#what-changed-from-the-2026-07-design) rather
> than deleted, because the migration notes still matter.

## The problem

We run ads (Meta click-to-WhatsApp, plus other channels carrying a shared
reference code) and need Meta to learn which of them produced **real,
qualified, paying customers** — not merely clicks. A click is never a
conversion; only a genuine inbound WhatsApp conversation is, and only the
CRM knows what became of it.

This CRM is the source of truth for "did the lead actually message us, and
how far did they get."

## Two lanes, two destinations

The lane is decided per conversation, once, from the identifiers on the
first inbound message. **Each lane reports to exactly one destination** —
this is the single most important property of the design, and the reason
the earlier version was replaced:

```
                  inbound WhatsApp message
                             │
              ┌──────────────┴──────────────┐
      zero-width code                referral.ctwa_clid
      (website / "code" lane)        (ad / "ctwa" lane)
              │                              │
      backend "platformA"             backend "capi"
              │                              │
   POST LANDING_CONVERSION_URL      POST graph.facebook.com
   Bearer WA_CONVERSION_SHARED_     /<version>/<dataset>/events
   SECRET                           action_source:
              │                       business_messaging
   Platform A owns the ORIGINAL      messaging_channel: whatsapp
   browser session (fbp/fbc)                  │
   → IT fires the Meta Pixel /       Meta receives it server-to-
     Google Ads conversion           server. No Pixel involved.
```

`ingest.ts` states the rule directly: *"`code` → Platform A only, `ctwa` →
direct CAPI only (no more double-fire)."* A conversation is never reported
down both paths, so there is no Pixel/CAPI duplicate pair to deduplicate.

If a message carries **both** identifiers, `code` wins. Both are retained on
`conversation.attribution`, which is written once and never overwritten.

## The invisible reference code

The website lane's bridge from a browser session to a WhatsApp conversation.

The landing site embeds a **6-character Crockford base32 code** into the
pre-filled WhatsApp message as **zero-width characters** — 30 bits, 5 bits
per character, MSB first, `ZWSP (U+200B) = 0` / `ZWNJ (U+200C) = 1`,
anchored right after the first word. The lead never sees it. Survival
through WhatsApp → Meta Cloud API → this CRM was verified live 2026-07-13.

Codec: `convex/lib/attribution.ts` (`decodeHidden` / `extractRefCode`).
The landing site (`go-amani`, `src/lib/tracking/hidden-code.ts`) keeps an
identical copy — **the two must stay byte-compatible.**

> There is no visible `HY-XXXXXX` form and no regex any more. The old ASCII
> code needed 72 hidden characters; this needs 30, so far less is lost to
> message editing. Only ZWSP/ZWNJ are used — the two most universally
> preserved zero-width characters.

## The pipeline

| Stage | Where | What happens |
| --- | --- | --- |
| Extract | `convex/lib/attribution.ts` | `extractRefCode` (zero-width decode) and `extractCtwaClid` (passthrough). |
| Parse | `convex/lib/whatsapp/webhookParse.ts` | `flattenInboundMessage` threads Meta's `referral.ctwa_clid` onto the flattened shape. |
| First touch | `convex/ingest.ts` → `conversionEvents.seedNewLead` | Classifies the lane, sets `conversation.attribution` once, seeds the ONE `new_lead` event, advances the funnel to `new_lead`. Best-effort: never blocks ingestion, flows, automations or the AI reply. |
| Milestones | `convex/funnel.ts` → `seedStageConversionEvent` | Every later stage seeds its own deduped row, from `funnel.setStage` (agent) or the qualification engine (auto). |
| Store | `conversionEvents` table | One row per `(conversation, stage)`. `eventId = "<conversationId>:<stage>"` is the dedup key and the retry identity. |
| Deliver | `conversionEvents.deliverConversionEvent` | Scheduled immediately on seed; retried by cron. Never throws. |
| Retry | `convex/crons.ts` → `retry-conversion-events`, every 15 min | Up to 100 rows/tick, staggered 100 ms apart. |
| View | `conversionEvents.listRecent` + `deliveryHealth` → Settings → Conversions | Recent rows of every status, plus a banner naming any lane that is holding events and why. Admin+ only. |

### Statuses

`pending` → `sent` · `unmatched` · `error` · `abandoned` · `dormant`

- **`unmatched`** (website lane only) — Platform A answered, but the code
  matched no real ad click. Terminal; never retried.
- **`error`** — retryable. Two independent budgets: permanent failures
  (4xx, malformed) spend `attempts` and give up at
  `MAX_DELIVER_ATTEMPTS` (5); transient ones (429/5xx/network) spend
  `transientAttempts` and back off exponentially, giving up at
  `MAX_TRANSIENT_DELIVER_ATTEMPTS` (20). A provider outage can therefore
  never retire a live conversion.
- **`dormant`** — the lane's env was unset, so nothing was attempted and no
  attempt was spent. Swept back into delivery once configured, subject to
  `CONVERSION_DELIVERY_START_MS`.
- **`abandoned`** — genuinely gave up. Terminal.

Retries reuse the same `eventId` **and** the same `event_time` (derived from
the row's `_creationTime`), so a retry is never a second event and never
re-dates the milestone.

## Configuration

All of these are **Convex** environment variables — Convex cannot see
`.env.local` or Netlify. See `.env.local.example` for the annotated list.

| Variable | Lane | Notes |
| --- | --- | --- |
| `META_CAPI_DATASET_ID` | ctwa | Required for the CAPI lane. |
| `META_CAPI_ACCESS_TOKEN` | ctwa | **Optional override.** Unset, delivery uses the account's own WhatsApp system-user token, which carries `whatsapp_business_manage_events` and does not expire. |
| `META_CAPI_TEST_EVENT_CODE` | ctwa | Routes to Events Manager → Test Events. **Unset it before going live.** |
| `META_GRAPH_VERSION` | ctwa | Defaults to `v25.0`. |
| `LANDING_CONVERSION_URL` | code | Platform A's endpoint. |
| `WA_CONVERSION_SHARED_SECRET` | code | Bearer token; identical string on both sides. |
| `CONVERSION_DELIVERY_START_MS` | both | Earliest `_creationTime` the **dormant** sweep will deliver. Gates the backlog only — live rows retry regardless. Malformed values fail closed. |

See `META_MANUAL_SETUP.md` for the Meta-side (Events Manager) steps and the
lifecycle→event-name mapping.

## Contract reference (this CRM → Platform A)

Website (`code`) lane only. **`ctwaClid` is never sent to Platform A** — ad
leads go straight to Meta's CAPI.

```
POST {LANDING_CONVERSION_URL}
Authorization: Bearer <WA_CONVERSION_SHARED_SECRET>
Content-Type: application/json
```

```jsonc
{
  "code": "A3F9K2",              // the 6-char decoded reference code
  "phone": "971585824488",       // digits only
  "waMessageId": "wamid.ABC123",
  "firstMessageAt": 1710000000000,
  "stage": "qualified",          // CRM funnel stage — the lifecycle milestone
  "event": "Lead",               // the web-Pixel event name for that stage
  "value": 2499,                 // present only on `purchased`
  "currency": "AED"              // present only alongside `value`
}
```

`stage` and `event` are the fields the 2026-07 contract did not have, and
they are what makes lifecycle reporting possible: Platform A receives one
POST per **milestone**, not one per lead.

Response:

```jsonc
{
  "matched": true,
  "firedAt": 1710000005000,
  "offerSlug": "summer-promo",   // stored on the row as `matchResult`
  "reason": "code_not_found"     // on a miss
}
```

`matched: true` → `sent`. `matched: false` → `unmatched` (terminal). A
non-2xx or a network failure → `error`, retried per the budgets above.

> ⚠️ **`stage` and `event` are the open coordination item.** Platform A
> currently fires the same Pixel event name for `new_lead` and `qualified`
> (both map to `Lead`), so the website lane carries no distinct MQL signal.
> Platform A *does* receive `stage`, so it has everything it needs to
> distinguish them — the fix is on its side. Tracked in
> `META_MANUAL_SETUP.md` §8 and pinned by the `KNOWN GAP` test in
> `convex/conversionLifecycle.test.ts`.

## Diagnostics

- **Settings → Conversions** — recent rows and the per-lane hold banner.
- **Reports → Funnel** — stage counts and delivery-status totals.
- **Convex logs** — one structured `[conversionEvents]` line per delivery
  attempt: `crmLeadId`, `eventId`, `eventName`, `leadStage`, `outcome`,
  `httpStatus`, `fbTraceId`, `eventsReceived`, `errorCategory`. Never a
  token, a raw phone, a `ctwa_clid`, or a payload body.
- **`conversionEvents.capiProbe`** — credentials/connectivity only. **A
  successful run returns HTTP 400**, because Meta validates `ctwa_clid`
  against real click records and the probe sends a synthetic one. Read that
  function's own doc comment before interpreting its result.
- **`conversionEvents.capiProbeMatrix`** — can send a *valid* `ctwa_clid`,
  but only by borrowing a real lead's identity, which attributes a synthetic
  event to an actual customer in the production dataset. Ask first; not a
  routine health check.

## What changed from the 2026-07 design

| Then (`attributionSignals`) | Now (`conversionEvents`) |
| --- | --- |
| Both lanes POSTed to Platform A | `code` → Platform A, `ctwa` → Meta CAPI direct. No double-fire. |
| One signal per lead (first touch only) | One event per **milestone** — the whole lifecycle. |
| Visible `HY-XXXXXX`, matched by regex | Invisible 30-bit zero-width code, no prefix, no regex. |
| `convex/attribution.ts` (`recordSignal`, `sendSignal`, `getPendingToRetry`, `retryPending`, `listConversions`) | Deleted. Pure helpers survive in `convex/lib/attribution.ts`. |
| `retry-attribution-signals` cron | `retry-conversion-events` cron. |
| `landingResult` field | `status` field, plus `dormant` and the split retry budgets. |
| One retry budget (5) | Permanent (5) + transient (20) with exponential backoff. |

The `attributionSignals` table still exists in `convex/schema.ts` with **no
remaining writers**. It holds frozen historical rows and is safe to drop
whenever someone wants to; nothing reads it.

### Historical note (kept for the paper trail)

During the original July 2026 development, an exploratory `npx convex
codegen` run pushed early code to the live backend before "this
self-hosted instance IS prod" was fully internalised. It was inert — new
pure helpers and one unused optional field, no schema change. Recorded
because `convex codegen` genuinely does upload functions to whatever
deployment is configured; it is not a local-only command.

---

*Rewritten 2026-09-01. Verified against the codebase and the running
Holidayys deployment on that date.*
