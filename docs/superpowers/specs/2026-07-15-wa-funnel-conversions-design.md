# WhatsApp → Meta funnel-conversion system — design

**Date:** 2026-07-15
**Status:** Design approved (brainstorm complete); implementation pending
**Branch:** `feat/wa-funnel-conversions`
**Supersedes / absorbs:** the dormant, never-fired-in-prod conversion paths from
[`2026-07-14-ctwa-capi-measurement-design.md`](2026-07-14-ctwa-capi-measurement-design.md)
(direct CAPI) and the `attributionSignals` first-touch path from the
`wa-conversion-attribution` work. Builds on the ad-capture layer from
[`2026-07-14-ctwa-ad-inbox-design.md`](2026-07-14-ctwa-ad-inbox-design.md).

---

## 1. Goal & the three objectives

Holidays Tours runs a Meta campaign with a **Purchase** objective. Meta's
algorithm can only optimize delivery, qualify leads, and report performance if
we feed it the real sales funnel: every conversation that originates from a paid
touch should report its progression — **new lead → qualified → price quoted →
itinerary sent → invoice sent → purchased** — back to Meta, with the purchase
value.

Today the CRM has **no** per-conversation funnel and no way for an agent to
record and report these stages. This feature adds one, and unifies it with the
existing (dormant) attribution plumbing so **both** lead sources feed Meta:

1. **Keep what we have.** The website→WhatsApp attribution (a visitor on the
   Holidayys site clicks a WhatsApp link carrying an invisible `HY-XXXXXX` code;
   the CRM decodes it and reports the conversion to the website's Meta Pixel via
   **Platform A** / go-holidayys) keeps working exactly as before.
2. **Website clicks tracked fully.** That same website (code) lane now also
   carries the **full funnel** — every engagement stage plus the purchase value —
   to the website Pixel, not just the first-touch conversion.
3. **Ad clicks tracked fully.** Click-to-WhatsApp ad leads (`ctwa_clid`) report
   the **full funnel** **directly** to Meta's Conversions API for Business
   Messaging.

## 2. Verified Meta facts (official docs, 2026-07-15 — do not re-derive)

- **Conversions API for Business Messaging** (`action_source: "business_messaging"`,
  top-level `messaging_channel: "whatsapp"`). `user_data` = `whatsapp_business_account_id`
  + `ctwa_clid`. Endpoint `POST https://graph.facebook.com/{VERSION}/{DATASET_ID}/events?access_token={TOKEN}`.
  Dataset is created **from the WABA**, not the website pixel. **Current Graph API `v25.0`.**
- **Allowed `event_name` set (business_messaging)** — a fixed vocabulary, no
  documented custom names: `Purchase`, `LeadSubmitted`, `InitiateCheckout`,
  `AddToCart`, `ViewContent`, `QualifiedLead`, `OrderCreated`, `OrderShipped`,
  `OrderDelivered`, `OrderCanceled`, `OrderReturned`, `CartAbandoned`,
  `RatingProvided`, `ReviewProvided`. Our business stages **map onto** this set.
- **`Purchase`** carries `custom_data: { value, currency }`; it is the event a
  Purchase-objective (`OUTCOME_SALES`) campaign optimizes on. CAPI unlocks
  purchase optimization for click-to-WhatsApp ads.
- **Meta does NOT deduplicate** business-messaging events — the caller must. We
  key one outbox row per `(conversation, stage)`.
- **Web Pixel events differ** from the messaging set — the website (Platform A)
  lane uses web-standard events (`Lead`, `InitiateCheckout`, `AddToCart`,
  `Purchase`, `ViewContent`) or custom conversions Platform A defines.
- **`ctwa_clid` is the only attribution key for the ad lane** and is captured
  only on the inbound webhook referral of an ad-originated message. Organic
  conversations physically cannot be attributed to a Meta campaign.
- **Automatic Events API** (Meta NLP auto-detects `LeadSubmitted`/`Purchase`
  from the thread) exists but only covers those two events and needs opt-in —
  **out of scope**; noted as a possible future backstop.

## 3. Current-state analysis (what exists, and the defect we fix)

- **`main` @ 7d18cbb** has the **ad-inbox** feature: the webhook parser lifts the
  ad referral for **display** (`message.referral`, `conversation.adReferral`
  summary, ad-image re-hosting, 72h free-window). **It does not persist
  `ctwa_clid`** — display never needed it.
- The **`feat/ctwa-capi-measurement` worktree** (`.claude/worktrees/feat-ctwa-capi-measurement`,
  off older `main` 1664a42) has the **CAPI stack**: `adReferrals` (captures
  `ctwa_clid`), `campaignAds` (ad→campaign name resolution via Marketing API),
  `capiEvents` (single `LeadSubmitted` outbox), retry crons, and a Campaigns
  analytics UI. It conflicts with `main` on `convex/lib/whatsapp/webhookParse.ts`
  (both parse the referral, different shapes).
- **`main` also has the attribution path**: `ingest.processInbound`'s last
  best-effort step does `code = extractRefCode(text); identifier = code ?? extractCtwaClid(msg)`
  → `attribution.recordSignal` → `attribution.sendSignal` → POST **Platform A**.
  `attributionSignals` is one row per `(account, identifier)`. Settings→Conversions
  reads it.

### The defect
Both identifiers currently route to **Platform A**, *and* the worktree fires the
ad's `ctwa_clid` a second time **directly** to Meta CAPI. So an ad lead is wired
to fire its Lead **twice** (once via A's WABA CAPI, once direct). Both are
dormant today (Platform A is 404; CAPI env unset), so nothing double-counts in
prod **yet**, but the design has a latent double-fire. **This design fixes it by
splitting the lanes to non-overlapping backends.**

## 4. Unified architecture

Two lanes, each to its correct backend, driven by **one** funnel tracker:

```
                    INBOUND WHATSAPP MESSAGE
                              │
             classify (first identifier seen, set once) →
                    conversation.attribution { lane, code?, ctwaClid? }
        ┌─────────────────────┼─────────────────────┐
   HY- code in text      ctwa_clid referral        neither
   = WEBSITE lead        = AD lead                 = organic
   lane = "code"         lane = "ctwa"             (no attribution)
        │                     │                        │
        │   ══ agent advances FUNNEL STAGE (one inbox tracker, all leads) ══
        │   new_lead → qualified → price_quoted → itinerary_created(*) →
        │              itinerary_sent → invoice_sent → purchased
        │                     │                        │
        ▼  dispatch by lane   ▼                        ▼
  conversionEvents        conversionEvents         funnelTransitions only
  backend="platformA"     backend="capi"           (CRM record, no Meta)
        │                     │
        ▼                     ▼
  POST Platform A         POST direct Meta CAPI
  /whatsapp-conversion    business_messaging
  → website Meta Pixel    → Meta WABA dataset
    (+ Google, as before)   optimizes Purchase campaign

  (*) itinerary_created is an internal back-office stage — tracked, never sent.
```

**Principle:** one funnel, one dispatcher, one stage config, one outbox — two
delivery backends. The only genuinely different thing is the endpoint.

## 5. Data model

### 5.1 New — `conversation.attribution` (classifier)
Set the **first time** any attribution identifier is seen on an inbound message
(may be message 1 or later); never overwritten once set. Absence = organic.

```ts
attribution: v.optional(v.object({
  lane: v.union(v.literal("code"), v.literal("ctwa")), // primary; code wins if both
  code: v.optional(v.string()),      // HY-XXXXXX (uppercased) if ever seen
  ctwaClid: v.optional(v.string()),  // ad click id if ever seen
  firstSeenAt: v.number(),
})),
```
Both identifiers are retained if both appear; `lane` (code-wins) decides
dispatch, so a conversation never fires to both backends.

### 5.2 New — `conversation.funnel` (denormalized current stage)
Fast inbox render + future stage-filtering, without scanning the log.

```ts
funnel: v.optional(v.object({
  stage: FunnelStage,                    // current stage (union, see §6)
  stageUpdatedAt: v.number(),
  stageUpdatedByUserId: v.optional(v.id("users")), // absent for auto new_lead
  saleValue: v.optional(v.number()),     // captured for Purchase (pre-fillable earlier)
  saleCurrency: v.optional(v.string()),  // defaults to account.defaultCurrency
})),
```

### 5.3 New table — `funnelTransitions` (append-only progress log)
Every stage entered, for **all** conversations (incl. organic and the internal
`itinerary_created`). The stepper + audit + funnel analytics read this.

```ts
funnelTransitions: defineTable({
  accountId: v.id("accounts"),
  conversationId: v.id("conversations"),
  contactId: v.id("contacts"),
  stage: FunnelStage,
  byUserId: v.optional(v.id("users")),          // absent for the auto new_lead
  auto: v.boolean(),                            // true = ingest auto new_lead
  conversionEventId: v.optional(v.id("conversionEvents")), // link if it dispatched
})
  .index("by_conversation", ["conversationId"])
  .index("by_account_stage", ["accountId", "stage"]),
```

### 5.4 New table — `conversionEvents` (the ONE unified outbox)
Replaces the two dormant parallel paths (`attributionSignals` first-touch +
worktree `capiEvents`). One row per `(conversation, stage)` that maps to a Meta
event; `backend` discriminates delivery.

```ts
conversionEvents: defineTable({
  accountId: v.id("accounts"),
  conversationId: v.id("conversations"),
  contactId: v.id("contacts"),
  stage: FunnelStage,
  lane: v.union(v.literal("code"), v.literal("ctwa")),
  backend: v.union(v.literal("platformA"), v.literal("capi")),
  eventName: v.string(),        // resolved per lane (web-pixel name | business_messaging name)
  identifier: v.string(),       // HY-code (code lane) | ctwa_clid (ctwa lane)
  value: v.optional(v.number()),
  currency: v.optional(v.string()),
  phone: v.string(),            // Platform A contract
  waMessageId: v.string(),      // first-touch wamid — Platform A contract / debug
  firstMessageAt: v.number(),   // Platform A contract
  eventId: v.string(),          // dedup key = `${conversationId}:${stage}`
  status: v.union(
    v.literal("pending"),
    v.literal("sent"),          // CAPI 200 / Platform A matched
    v.literal("unmatched"),     // Platform A: no matching click/code (code lane)
    v.literal("skipped"),       // dormant (env unset) — recorded, never sent
    v.literal("error"),
    v.literal("abandoned"),     // retries exhausted (leaves the retry partition)
  ),
  attempts: v.number(),
  lastError: v.optional(v.string()),
  sentAt: v.optional(v.number()),
  fbTraceId: v.optional(v.string()),   // CAPI response
  matchResult: v.optional(v.string()), // Platform A response (offerSlug/reason)
})
  .index("by_conversation", ["conversationId"])
  .index("by_event_id", ["eventId"])              // dedup guard before insert
  .index("by_status", ["status"])                 // retry cron
  .index("by_account_stage", ["accountId", "stage"]), // analytics
```

### 5.5 Kept — `adReferrals`, `campaignAds` (from Phase 0)
`adReferrals` remains the **source of the `ctwa_clid`** per conversation/contact.
`campaignAds` remains ad→campaign/adset name resolution (feeds analytics).

### 5.6 Deprecated — `attributionSignals`, worktree `capiEvents`
Both are **superseded** by `conversionEvents`. Neither ever fired in prod, so
there is **no data migration**. `attributionSignals` stays defined but unwritten
until a later cleanup; Settings→Conversions re-points to `conversionEvents`. The
worktree's single-event `capiEvents` is **not landed** — the unified outbox
replaces it (see §12 phasing).

## 6. Stage configuration (fixed, one code constant)

`convex/lib/funnel.ts` — the single source of truth. Also mirrored for the UI
(shared pure module). `metaCapi` = business_messaging event (ad lane); `webPixel`
= suggested web event (website lane; Platform A may map to a custom conversion).
`null` = internal-only, never sent. **`FunnelStage`** (referenced throughout §5)
= the union of the seven `key` values below.

| key | label | `metaCapi` | `webPixel` | notes |
|---|---|---|---|---|
| `new_lead` | New lead | `LeadSubmitted` | `Lead` | **auto** on first identifier at ingest |
| `qualified` | Qualified lead | `QualifiedLead` | `Lead` | the "is this a good lead" signal |
| `price_quoted` | Price quoted | `InitiateCheckout` | `InitiateCheckout` | optional value capture |
| `itinerary_created` | Itinerary created | `null` | `null` | internal back-office only |
| `itinerary_sent` | Itinerary sent | `AddToCart` | `AddToCart` | |
| `invoice_sent` | Invoice sent | `OrderCreated` | `InitiateCheckout` | optional value capture |
| `purchased` | Purchased | `Purchase` | `Purchase` | **value required** (+ currency) |

Ordering defines the stepper. Agents may jump stages; each set fires only its
own event, at most once per conversation (dedup by `eventId`). Backward moves
update the current stage + log a transition but fire **no** new Meta event (a
conversion cannot be retracted).

## 7. The dispatcher — `deliverConversionEvent`

One `internalAction`, never throws, mirrors the existing `sendSignal`/`sendCapiEvent`
shapes. Reads the `conversionEvents` row and branches on `backend`:

- **`capi`** — dormant unless `META_CAPI_DATASET_ID` + `META_CAPI_ACCESS_TOKEN`
  set and the account has a `wabaId` (→ `skipped`/leave `pending`). POST:
  ```json
  { "data": [{
      "event_name": "<eventName>", "event_time": <firstMessageAt secs>,
      "action_source": "business_messaging", "messaging_channel": "whatsapp",
      "event_id": "<eventId>",
      "user_data": { "whatsapp_business_account_id": "<wabaId>", "ctwa_clid": "<identifier>" },
      "custom_data": { "value": <value>, "currency": "<currency>" }   // Purchase / value stages
  }], "partner_agent": "<META_CAPI_PARTNER_AGENT?>" }
  ```
  200 → `sent` + `fbTraceId`; else `error` + attempts.
- **`platformA`** — dormant unless `LANDING_CONVERSION_URL` +
  `WA_CONVERSION_SHARED_SECRET` set. POST `Authorization: Bearer <secret>`:
  ```json
  { "code": "<identifier>", "phone": "<phone>", "waMessageId": "<waMessageId>",
    "firstMessageAt": <ms>, "stage": "<stage>", "event": "<eventName>",
    "value": <value?>, "currency": "<currency?>" }
  ```
  Response `{ matched, alreadyFired, firedAt?, offerSlug?, reason? }` →
  `sent` (matched) / `unmatched` / `error`. **Backward-compat:** for `new_lead`
  the `stage`/`event`/`value` fields are still sent but Platform A treats a
  first-touch call identically to today (see §10).

**Dedup:** `by_event_id` guard before insert (one row per conversation+stage);
`status === "sent"` short-circuits re-delivery. **Retry:** one cron sweeps
`status ∈ {error, pending}` with `attempts < MAX`, capped, bounded backoff;
`patchStatus` retires to `abandoned` at the cap (leaves the retry partition —
same pattern as `attribution.patchResult`).

## 8. Ingest — classification + auto `new_lead`

Replace the current attribution best-effort step in `ingest.processInbound`
(keeps the pure `extractRefCode`/`extractCtwaClid` helpers) with:

1. `code = extractRefCode(message.text)`, `ctwaClid = extractCtwaClid(message)`.
2. If neither and no prior attribution → return (organic; nothing).
3. `classifyAttribution` mutation: if `conversation.attribution` unset, set it
   (`lane = code ? "code" : "ctwa"`, store both identifiers seen, `firstSeenAt`);
   merge in a newly-seen identifier otherwise; never change `lane`.
4. On the **transition into a lane** (first time attribution is set), enqueue the
   auto `new_lead`: set `conversation.funnel.stage = "new_lead"`, insert a
   `funnelTransitions` row (`auto: true`), and create+dispatch the `new_lead`
   `conversionEvents` row for the lane. This is the first-touch conversion — it
   preserves today's behavior for the code lane.

`ctwa_clid` continues to be captured into `adReferrals` (Phase 0) — the durable
source the funnel engine reads for the ad lane's identifier.

## 9. Funnel engine — `funnel.setStage`

`accountMutation`, same access guard as `conversations.setStatus` (viewer
blocked; agent must hold the conversation; supervisor+ bypass). Args:
`{ conversationId, stage, saleValue?, saleCurrency? }`.

1. `requireConversationAccess` (own/act mode).
2. Validate `stage` is a known key; if `stage === "purchased"` require
   `saleValue > 0` (currency defaults to `account.defaultCurrency`).
3. Patch `conversation.funnel` (stage, updatedAt, updatedByUserId, sale value).
4. Insert `funnelTransitions` (`auto: false`, `byUserId`).
5. If `conversation.attribution` set **and** the stage's per-lane event is
   non-null → dedup-check `conversionEvents by_event_id`; if absent, insert
   (`pending`) with the resolved `eventName`/`value`/`currency` and schedule
   `deliverConversionEvent`; link `conversionEventId` back onto the transition.
6. Never blocks; delivery is best-effort + dormant-safe.

Value may optionally be entered at `price_quoted`/`invoice_sent` (stored on
`conversation.funnel`, included as `custom_data.value` on those events, and
pre-fills the required Purchase amount).

## 10. Platform A extension (go-holidayys, Phase 5)

`convex/http.ts` `POST /whatsapp-conversion` (bearer-guarded) gains optional
`{ stage, event, value, currency }`:
- **No `stage`, or `stage === "new_lead"`** → behave exactly as today (fire the
  first-touch conversion against `trackingConfig`'s Meta Pixel + Google offline).
  Guarantees objective 1.
- **Other stages** → fire the mapped **web-Pixel** event (`event`, with
  `value`/`currency` for Purchase) and, for `purchased`, the Google offline
  conversion if configured.
- **Dedup** per `(identifier, stage)` on A's side (extends its existing
  `alreadyFired` first-touch dedup).
- Response shape unchanged. A only ever receives the **code** lane now
  (`ctwaClid` no longer sent to A — the double-fire fix).

Exact handler edits are scoped when Phase 5 reads the current go-holidayys
`/whatsapp-conversion` implementation and `trackingConfig` usage.

## 11. Inbox UX & analytics

- **Thread header** — a compact `Stage: <current> ▾` dropdown (mirrors the
  existing status dropdown). Choosing **Purchased** opens an amount+currency
  popover before confirming.
- **Contact sidebar** — a vertical stepper: stages done (when + who), current,
  upcoming; each with a **"Reported to Meta ✓ / –"** indicator (from
  `conversionEvents.status`) and the sale value. Organic conversations show a
  subtle "CRM only — not from an ad or tracked link, not reported to Meta" note.
- **Gating** — dropdown/stepper controls disabled for viewers and non-held
  conversations (reuse the composer's `readOnly`/`GatedButton` pattern).
- **i18n** — new `Inbox.funnel` namespace across all locale files.
- **Unified funnel analytics** — one dashboard (extends the Phase-0 Campaigns
  view) spanning **website + ad** leads, broken down by stage: counts per stage,
  total purchase value, and match rate — from `conversionEvents` +
  `funnelTransitions` (⋈ `campaignAds` for ad campaign names).

## 12. Phased plan (each phase = its own spec → plan → build, TDD, dormant-by-default)

- **Phase 0 — Foundation.** Reconcile `feat/ctwa-capi-measurement` onto `main`:
  unify `webhookParse` so one parse feeds both the display summary and the
  `ctwa_clid`; land `adReferrals` (clid capture) + `campaignAds` (ad→campaign
  resolution) + their retry cron. **Do not** land the worktree's single-event
  `capiEvents`/Campaigns query — the unified outbox/analytics replace them (its
  UI is a reference for Phase 4).
- **Phase 1 — Unified conversion outbox.** `conversationEvents` table +
  `deliverConversionEvent` dispatcher (Platform A | CAPI) + `conversation.attribution`
  classifier + stage config + retry cron. Fold the first-touch attribution into
  the `new_lead` conversionEvent (preserve A's contract). **Double-fire fix**:
  ctwa no longer POSTs Platform A.
- **Phase 2 — Funnel engine.** `funnel.setStage` + `conversation.funnel` +
  `funnelTransitions` + the ingest auto `new_lead`.
- **Phase 3 — Inbox UX.** Thread stage dropdown (+ Purchase value popover),
  sidebar stepper with per-stage reported indicator, gating, i18n.
- **Phase 4 — Unified funnel analytics.** Website + ad dashboard by stage, with
  purchase value.
- **Phase 5 — Platform A extension (go-holidayys).** Extend `/whatsapp-conversion`
  for `{ stage, event, value, currency }` → web Pixel (+ Google). Cross-repo.

## 13. Testing, build & rollout

- **TDD** throughout (project convention). `convex-test` is offline.
- **Build offline** by hand-editing `convex/_generated/` — running
  `convex dev`/`deploy`/`codegen` pushes the one live self-hosted Convex
  (`convex-api.holidayys.co`). New table = `schema.ts` only; new module = 2-line
  `api.d.ts` add.
- **Match existing file style** (convex files are double-quoted; do **not** run
  `prettier --write` broadly — it reformats whole files). Verify via `tsc` +
  `vitest` + `next build`, not prettier.
- **Dormant-by-default.** The funnel tracker records stages with no Meta env.
  Events fire only once the relevant env is set + deployed:
  - ad lane: `META_CAPI_DATASET_ID`, `META_CAPI_ACCESS_TOKEN`, `META_GRAPH_VERSION=v25.0`
    (+ `META_ADS_ACCESS_TOKEN` for campaign-name resolution).
  - website lane: `LANDING_CONVERSION_URL`, `WA_CONVERSION_SHARED_SECRET`
    (already pre-staged) + Platform A deployed with the Phase-5 extension.
- **Forward-only.** Events fire only for conversations whose identifier is
  captured **after** deploy (referral/clid isn't backfillable).
- **Deploy** is two-track and manual: `convex deploy` (backend) is separate from
  the Netlify frontend deploy; go-holidayys deploys independently for Phase 5.

## 14. Edge cases & decisions on record

- **Both identifiers present** → `code` wins for dispatch; both stored; single
  lane fires (no double-count).
- **Identifier on a later message** → attribution upgrades organic→lane on first
  sighting; stages advanced while still organic are CRM-only (not backfilled).
- **Backward stage move** → current stage updated + logged; no new Meta event.
- **Organic conversation** → funnel fully usable as a CRM tool; nothing sent to
  Meta (no attribution key exists).
- **"Keep as before" (objective 1)** is honored behaviorally: the code-lane
  `new_lead` delivers the identical first-touch call to Platform A; the internal
  rework is safe because neither dormant path ever fired in prod.

## 15. Out of scope

Meta Automatic Events API; admin-configurable stages (fixed set chosen);
retroactive backfill of pre-deploy conversations; non-WhatsApp channels.
