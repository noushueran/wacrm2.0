# WhatsApp Verified-Conversion Attribution

> **Status:** built and unit/integration-tested on `feat/wa-conversion-attribution`
> (tasks B1–B8). **DORMANT in prod** — no environment configured, not deployed.
> See [Deferred go-live steps](#deferred-go-live-steps-require-owner-action).

Holidayys runs ads (Meta click-to-WhatsApp, plus other channels via a shared
`HY-XXXXXX` code) that Platform A (the ads/landing platform, `go-track`) needs
to know actually converted into a **real WhatsApp conversation** — not just a
click — so it can fire the matching Meta/Google Ads conversion event. A click
alone is never a conversion; only a genuine inbound WhatsApp message counts.

This CRM (Platform B) is the source of truth for "did the lead actually
message us." The pipeline, end to end:

1. A lead clicks a click-to-WhatsApp ad, or types/pastes an `HY-XXXXXX` code
   Platform A gave them, then sends a WhatsApp message.
2. Meta's webhook delivers the inbound message to this CRM, carrying either a
   `referral.ctwa_clid` (ad click) or the code inside the message text.
3. This CRM detects the identifier, records it, and POSTs it to Platform A's
   `/whatsapp-conversion` endpoint.
4. Platform A looks the identifier up against its own records and fires the
   ad-platform conversion if it matches a real ad click / code issuance.

## What's built (offline, tested, dormant)

The full B1–B7 pipeline, all on `feat/wa-conversion-attribution`:

| Stage | File | What it does |
| --- | --- | --- |
| Extract | `convex/attribution.ts` — `extractRefCode` / `extractCtwaClid` | Pure functions: `HY-XXXXXX` regex match (case-insensitive, uppercased) out of message text; `ctwaClid` passthrough from an already-flattened message. |
| Parse | `convex/lib/whatsapp/webhookParse.ts` — `flattenInboundMessage` | Threads Meta's raw `referral.ctwa_clid` onto the flattened inbound-message shape `processInbound` consumes. |
| Store | `convex/schema.ts` (`attributionSignals` table) + `convex/attribution.ts` — `recordSignal` | One row per `(accountId, identifier)`, idempotent (first occurrence only, via the `by_account_identifier` index). Starts `landingResult: "pending"`, `attempts: 0`. |
| Hook | `convex/ingest.ts` — `processInbound`'s last `runBestEffort` step (~line 619) | On every inbound message, detects the identifier (an HY- code wins over a ctwa_clid if both are present), records the signal, and — only on a fresh insert — schedules `sendSignal`. Best-effort: a failure here never blocks message ingestion, flows, automations, or the AI reply. |
| Send | `convex/attribution.ts` — `sendSignal` | POSTs `{ code? \| ctwaClid?, phone, waMessageId, firstMessageAt }` to Platform A and records `matched` / `unmatched` / `error`. |
| Retry | `convex/crons.ts` (`retry-attribution-signals`) + `convex/attribution.ts` — `getPendingToRetry` / `retryPending` | Every 15 minutes, re-sends any row still `"pending"` or `"error"` with `attempts < 5` (capped at 100 rows/sweep). Rows that landed `"unmatched"` are **not** retried — only `"pending"`/`"error"` ones are. |
| View | `convex/attribution.ts` — `listConversions` + `src/components/settings/conversions-tab.tsx` | Settings → Conversions: matched leads (phone, identifier, lane, offer, timestamps), newest first, plus a funnel count (`total` / `matched` / `pending` / `unmatched` / `error`). Admin+ only. |

**It is DORMANT in prod today.** `sendSignal` checks `process.env
.LANDING_CONVERSION_URL` / `process.env.WA_CONVERSION_SHARED_SECRET` on the
Convex deployment; while either is unset it never calls Platform A at all —
it just records `landingResult: "error"` and bumps `attempts`, logging a
`console.warn`. The retry cron isn't a running schedule in prod either, since
`convex/crons.ts` only takes effect once this branch is actually deployed
(crons ship as part of a normal `convex deploy`, like any other function).

Test coverage (all offline, `convex-test` + Vitest):

- `convex/attribution.test.ts` — extractors, `recordSignal` idempotency,
  `sendSignal` (matched / unmatched / error / dormant), the retry cron,
  `listConversions` (including a cross-account denial test).
- `convex/lib/whatsapp/webhookParse.test.ts` — `flattenInboundMessage`'s
  `ctwa_clid` threading.
- `convex/ingest.test.ts` — `processInbound`'s attribution step (code / ctwa /
  both-present / neither / duplicate-wamid, `sendSignal` scheduling), plus
  (Task B8) the raw-payload integration seam described next.

## The B8 integration test

Every function above was tested in isolation, but nothing proved the
**seam**: a raw Meta webhook message flowing through the real
`flattenInboundMessage` parser into the real `processInbound` hook. Task B8
closes that gap with three tests appended to `convex/ingest.test.ts` (the
same file as the sibling `processInbound` attribution tests, reusing its
`seedAccount` / `seedAiConfig` / `seedWebhookEndpoint` / `attributionSignalsFor`
scaffolding and DRY-RUN env):

1. A raw `MetaWebhookMessage` with `referral.ctwa_clid` → `flattenInboundMessage`
   → `processInbound` → asserts a `ctwa`-lane signal row.
2. A raw message with `HY-ABCDEF` in `text.body`, no referral → flatten →
   `processInbound` → asserts a `code`-lane signal row.
3. A raw plain-text message (neither) → flatten → `processInbound` → asserts
   **no** signal row.

Each assertion runs immediately after `processInbound` resolves (before any
scheduled function drains), so every row observed is still `"pending"`. Each
test also asserts `flattened.wamid === raw.id` — a value that only appears on
the flattened result because the real parser copied it over from a
differently-named raw field — to confirm the test is exercising the actual
parser, not a hand-built stand-in shaped to match.

All three tests **passed on first run** — this is a coverage/seam test over
already-built (B1–B7) code, so that's the expected, correct outcome, not a
sign the test is weak. It genuinely exercises the two real functions in
sequence; no seam bug was found.

This offline test is a deliberate stand-in for the literal HTTP path
(`POST /whatsapp/ingest` → `convex/http.ts`'s `processChange` →
`flattenInboundMessage` → `processInbound`): **httpActions can't be invoked
under `convex-test`**, so the real end-to-end HTTP call is necessarily part
of the deferred live testing below, not something this offline suite can
cover.

## Deferred go-live steps (require owner action)

None of the steps below were run by any B-series task. They need owner
action, Platform A coordination, and/or a prod deploy — all explicitly out of
scope until authorized.

### 1. Set the Convex environment variables (prod)

These are read by `convex/attribution.ts`'s `sendSignal` — a Convex
**action** — so they must be set **on the Convex deployment itself**, not in
`.env.local` or Netlify (neither of those is visible to Convex functions):

```bash
cd wacrm2.0
npx convex env set LANDING_CONVERSION_URL <Platform A's exact /whatsapp-conversion URL>
npx convex env set WA_CONVERSION_SHARED_SECRET <the SAME secret string Platform A uses>
```

Both commands push straight to the live deployment
(`https://convex-api.holidayys.co`) the moment you run them — no separate
deploy step is needed for env vars themselves, but `sendSignal` stays dormant
until both have a real value.

### 2. Deploy

This is a **two-track** deploy — the two halves ship independently of each
other:

- **Convex functions** (this feature's actual logic, plus the retry cron):
  `npx convex deploy` (add `-y` to skip prompts) from `wacrm2.0/`, using the
  `CONVEX_SELF_HOSTED_*` credentials already in `.env.local` → pushes to
  `https://convex-api.holidayys.co`. The `retry-attribution-signals` cron
  only starts running once this happens.
- **Next app**: ships via the normal `git push origin main` → Netlify build.
  Needed for the Settings → Conversions admin UI to appear; the backend
  pipeline itself doesn't depend on it.

**Do not run either without explicit owner OK.** The schema change here is
purely additive (one new table, no altered columns on any existing table),
so this is a safe, no-migration deploy whenever it's authorized — but that
authorization hasn't happened yet.

### 3. Live integration test (before trusting real WhatsApp traffic)

Once env is set and Convex is deployed, POST a crafted Meta-shaped webhook
body directly at Convex's ingest endpoint. This intentionally bypasses Meta's
own HMAC check — that check is the Next.js proxy route's job
(`src/app/api/whatsapp/webhook/route.ts`), not this endpoint's; Convex's own
trust boundary here is only the `x-wacrm-proxy-secret` header (see
`convex/http.ts`'s header comment on `checkProxySecret`).

```bash
curl -X POST "https://convex-site.holidayys.co/whatsapp/ingest" \
  -H "x-wacrm-proxy-secret: <current WEBHOOK_PROXY_SECRET value>" \
  -H "Content-Type: application/json" \
  -d '{
    "entry": [{
      "id": "WABA_ID",
      "changes": [{
        "field": "messages",
        "value": {
          "messaging_product": "whatsapp",
          "metadata": {
            "display_phone_number": "15550009999",
            "phone_number_id": "<phoneNumberId of a whatsappConfig row on the target account>"
          },
          "contacts": [{ "profile": { "name": "Live Test" }, "wa_id": "15551230099" }],
          "messages": [{
            "id": "wamid.LIVE-TEST-CODE-1",
            "from": "15551230099",
            "timestamp": "1710000000",
            "type": "text",
            "text": { "body": "Hi, my ref HY-ABCDEF please" }
          }]
        }
      }]
    }]
  }'
```

Run it a second time with the message's `text` swapped for a plain body and a
`"referral": { "ctwa_clid": "clid-live-test-1", "source_id": "AD1" }` key
added alongside it, to exercise the ctwa lane too.

Confirm via the Convex dashboard's data browser
(`https://convex-wd56.srv1008984.hstgr.cloud` → the `attributionSignals`
table) that a row was written for each request — lane `code`/`ctwa`
respectively, `landingResult` starting `"pending"` and moving to
`"matched"` / `"unmatched"` / `"error"` within a few seconds as `sendSignal`
actually reaches Platform A. Note: Settings → Conversions' own UI only
*lists* `matched` rows in its table — a `pending` / `error` / `unmatched`
signal only shows up there in the funnel **counts**, not the row list — so
the dashboard is the more direct way to confirm the write itself.

`x-wacrm-proxy-secret` must match whatever `WEBHOOK_PROXY_SECRET` is
currently set to — it has to be identical on both the Next app
(`.env.local` / Netlify) and the Convex deployment; see
`.env.local.example`'s own comment on this pair.

### 4. Live WhatsApp E2E

Send a real WhatsApp message containing `HY-XXXXXX` (a code you know Platform
A has issued) to the connected business number. Confirm:

- the signal fires (dashboard, as above, or wait for it to reach
  `"matched"`/`"unmatched"`),
- Platform A's response reflects a real match/no-match decision, and
- if matched, the lead's phone number appears in Settings → Conversions
  (admin+ only).

Repeat by clicking an actual click-to-WhatsApp ad through to a real message,
to exercise the `ctwa_clid` lane the same way.

## Coordination / handoff items (cross-system)

- **Platform A regex parity.** This CRM's code regex is
  `/HY-[0-9A-HJKMNP-TV-Z]{6}/i` — the 32-symbol Crockford base32 alphabet
  (excludes `I`/`L`/`O`/`U`). This was corrected during development from an
  earlier draft, `/HY-[0-9A-HJ-NP-TV-Z]{6}/i`, whose character class actually
  admitted 33 symbols (it let `L` through). Ask Platform A to confirm/update
  its own regex to the same 32-symbol value for byte-exact parity —
  functionally this rarely matters in practice (a proper Crockford generator
  never emits `L` anyway), but it's worth closing the gap explicitly.
- **Endpoint host confirmation.** `LANDING_CONVERSION_URL` has no confirmed
  production value yet — planning used `https://go-track.holidayys.com/whatsapp-conversion`
  as a placeholder. Get Platform A's exact production host before running the
  `convex env set` command in step 1.
- **Shared secret.** `WA_CONVERSION_SHARED_SECRET` must be the identical
  string on both platforms — Platform A validates it as a bearer token on
  the inbound POST. Whoever generates it needs to hand it to both sides;
  there's no exchange mechanism beyond that.
- **Conversions view access.** Currently admin+ only
  (`ctx.requireRole("admin")` in `convex/attribution.ts`'s `listConversions`,
  mirrored by `"conversions"` being listed in `CRITICAL_SECTIONS` in
  `src/lib/auth/roles.ts:189`). It exposes raw, unmasked lead phone numbers,
  which is why it was scoped this tight by default. To let supervisors see it
  too, change **both** gates from admin-only to `"supervisor"` — they're
  independent checks (the settings page's route guard, and the query's own
  role check) and both need updating together, or a supervisor gets
  redirected by the page guard despite the query itself now allowing them.
- **Backend state note (transparency, no action needed).** During
  development, an exploratory `npx convex codegen` run pushed the B1+B2 code
  (the pure extractors, plus the `ctwaClid` field threading) to the live
  backend before "this one self-hosted instance IS prod — don't run
  codegen/dev/deploy" was fully internalized. This was inert: no schema
  change, only new pure helper functions and an unused optional field, so it
  had no behavioral effect on the running app. A normal deploy of this
  branch's final, merged state supersedes it entirely. Documented here for a
  clean paper trail, not because anything needs fixing.

## Contract reference (B ↔ A)

```
POST {LANDING_CONVERSION_URL}
Authorization: Bearer <WA_CONVERSION_SHARED_SECRET>
Content-Type: application/json
```

Request body — **exactly one** of `code` / `ctwaClid`, never both, and no
`text` field (the stored row doesn't retain the message body):

```jsonc
{
  "code": "HY-ABCDEF",        // present for the "code" lane...
  // "ctwaClid": "clid-xyz",  // ...OR this, for the "ctwa" lane — never both
  "phone": "15551234567",
  "waMessageId": "wamid.ABC123",
  "firstMessageAt": 1710000000000
}
```

Response:

```jsonc
{
  "matched": true,
  "alreadyFired": false,
  "firedAt": 1710000005000,     // present when matched
  "offerSlug": "summer-promo",  // present when matched, if applicable
  "reason": "code_not_found"    // present on a miss, e.g. "code_not_found" | "expired"
}
```

A non-2xx response, a network failure, or a missing env var all land the row
on `landingResult: "error"` with `attempts` incremented — the retry cron
keeps nudging it (up to 5 attempts total) until it succeeds or maxes out.

---

*Written for Task B8 (`feat/wa-conversion-attribution`). Last verified against the codebase 2026-07-12.*
