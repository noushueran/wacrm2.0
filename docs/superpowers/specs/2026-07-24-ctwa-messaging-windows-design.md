# CTWA free entry point & messaging windows — Phase 1 foundation

**Date:** 2026-07-24
**Surface:** `convex/http.ts` (status webhook loop), `convex/lib/whatsapp/webhookParse.ts`,
new `convex/lib/whatsapp/messagingWindow.ts`, `convex/schema.ts`, `convex/ingest.ts`
**Status:** Approved design, ready for implementation planning

## Problem

The CRM runs Click-to-WhatsApp (CTWA) ads as a lead source. Meta grants a **72-hour
free entry point (FEP) window** for leads that arrive that way — during which *every*
message, including billable marketing templates, is free. Separately, Meta enforces a
**24-hour customer service window (CSW)** that governs whether free-form messages are
allowed at all.

Today the system captures CTWA referral data well but models neither window correctly:
the 72h indicator is anchored on the wrong event and omits the rule that decides whether
the window exists at all, and the 24h window is recomputed ad hoc in two places. The
result is an indicator that can tell an agent a conversation is "free" when Meta will in
fact bill it.

## How Meta actually works (research findings)

### The two-clock model

There are **two independent windows doing two different jobs**. Conflating them is the
central bug class here.

| | 24h Customer Service Window | 72h Free Entry Point window |
|---|---|---|
| Governs | *Message TYPE* — free-form vs template-only | *COST* — free vs billed |
| Starts | Each inbound **customer** message | Business replies to a CTWA/Page-CTA lead |
| Resets | On every new inbound message | Never — one window per entry |
| While open | Free-form allowed | **All** messages free, incl. templates |
| While closed | Template-only | Normal per-message pricing |

### Free entry point mechanics

Per [Meta's pricing documentation](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing/conversation-based-pricing):

1. A customer on **Android or iOS** (desktop/web not supported) messages the business via
   a Click-to-WhatsApp ad or Facebook Page CTA button. Their first inbound message carries
   a `referral` object (`ctwa_clid`, `source_id`, `source_type`, `source_url`, `headline`, `body`).
2. **If the business responds within 24 hours**, Meta opens the FEP conversation *when that
   reply is delivered*, lasting **72 hours** from delivery.
3. While open, **all messages are free**, including Marketing/Utility/Authentication templates.
4. Opening an FEP **closes all other open conversations** with that customer; no new billed
   conversation opens until it expires.
5. **If the business does not respond within 24 hours, no FEP is opened at all** — re-engagement
   then requires a billed template.

### Still current under per-message pricing

Meta moved to per-message pricing on **1 July 2025**, but the FEP rule is unchanged:
*"FEP windows remain open for 72 hours. While open, you can send any type of message to the
user at no charge."* Outside an FEP: non-template messages are free inside an open CSW,
**utility** templates are free inside an open CSW, and marketing/authentication templates are
billed per delivered message.

### Meta reports all of this on status webhooks

This is the fact that determines the architecture. Each **outbound message status webhook**
(`entry[].changes[].value.statuses[]`) carries:

```jsonc
{
  "id": "wamid...", "status": "sent", "timestamp": "...", "recipient_id": "...",
  "conversation": {
    "id": "CONVERSATION_ID",
    "expiration_timestamp": "TIMESTAMP",      // authoritative window expiry
    "origin": { "type": "referral_conversion" } // referral_conversion ⇒ FEP
  },
  "pricing": {
    "billable": true,
    "pricing_model": "CBP",                    // or "PMP" (per-message)
    "category": "referral_conversion",
    "type": "free_entry_point"                 // PMP-era field
  }
}
```

Meta is **mid-migration** between conversation-based (`CBP`) and per-message (`PMP`)
pricing, and the two eras spell things differently — `pricing.type`
(`regular` / `free_customer_service` / `free_entry_point`) exists only in the PMP shape,
while `pricing.category` and `conversation.origin.type` carry the signal in the CBP shape.
`conversation.expiration_timestamp` was added to per-message pricing webhooks in the
July 2025 update.

**We therefore do not need to guess the window — Meta tells us when it expires and whether
the message was billed.** The system currently discards all of it.

## Current state (audit)

### Already wired

- **CTWA referral capture is complete.** `webhookParse.ts` parses the full `referral` object
  including `ctwa_clid`; `ingest.ts` persists it to `conversations.adReferral`,
  `contacts.acquisitionSource`/`acquisitionAd`, and `conversations.attribution.ctwaClid`
  (`schema.ts:212-240`), plus the `adReferrals` / `campaignAds` tables.
- **A 72h indicator exists** — `src/lib/inbox/adWindow.ts` (`AD_FREE_WINDOW_MS = 72h`),
  surfaced in the inbox.
- **A 24h check exists** — computed in `message-thread.tsx:289-314` (`sessionInfo`, gates the
  composer) and again in `qualificationEngine.ts:3042` (`windowOpen`).
- **Reactive enforcement** — Meta error `131047` is treated as proof the window is shut
  (`convex/lib/whatsapp/metaApi.ts:96`).

### Missing or incorrect

1. **The 72h window is anchored on the wrong event.** `conversations.adReferral.startedAt` is
   set on the **customer's first ad message**; Meta starts the clock on the **business's
   delivered reply**.
2. **The rule that decides whether an FEP exists is absent.** Nothing models *"no reply within
   24h ⇒ no FEP."* The indicator can claim "free" on a conversation Meta will bill.
3. **`status.pricing` and `status.conversation` are discarded.** `convex/http.ts:111-130`
   forwards only `status.id` and `status.status`.
4. **No shared window state.** No `lastInboundAt`; the 24h window is recomputed in two places
   with independent logic.
5. **No free-vs-billed awareness anywhere.** No per-message pricing facts, no category.

## Phasing

This spec covers **Phase 1 only**. Later phases get their own spec each.

- **Phase 1 — Foundation (this spec).** Capture Meta's pricing/conversation data; add
  `lastInboundAt` and `firstReplyAt`; one pure resolver. **No user-visible change.**
- **Phase 2 — Agent visibility.** Inbox surfaces both windows with live countdowns, free/paid
  badges, and a "reply within 24h to unlock the free window" nudge.
- **Phase 3 — Behaviour.** Send layer, AI auto-reply, automations and broadcasts consult the
  resolver.
- **Phase 4 — Cost insight.** Aggregate captured pricing into free-vs-paid and category spend.

## Decisions (locked)

1. **Meta is the source of truth.** Capture `statuses[].pricing` and `statuses[].conversation`
   and treat them as authoritative. Client-side computation is a *fallback estimate* used only
   before Meta has spoken, and is overwritten the moment a status webhook lands.
2. **Store raw + normalized, never closed unions,** for `pricing.category`, `pricing.type` and
   `conversation.origin.type` — Meta is mid-migration and adds values; an unknown value must
   never throw or drop a webhook.
3. **Additive schema only.** Every new field optional ⇒ no migration, no backfill, consistent
   with this schema's stated additive philosophy.
4. **Phase 1 ships zero visible change.** Correctness foundation first; behaviour later.

### Rejected alternatives

- **Pure client-side estimation** (fix the anchor, skip capture). Always an approximation that
  can disagree with Meta's real billing — edge cases like the Android/iOS-only restriction, the
  ads-attribution toggle being off, or FEP closing other open conversations are unknowable from
  timestamps. It is also the status quo that produced this bug.
- **Minimal patch** (fix the anchor only). Leaves the duplicated window logic, the blind send
  layer, and zero cost visibility in place; Phase 4 would start from nothing.

## Design

### 1. Capture — `parseStatusPricing`

Add a pure function to `convex/lib/whatsapp/webhookParse.ts` (matching that file's existing
"pure, testable" convention), returning a normalized record:

```ts
{
  wamid, status,
  conversationMetaId?,   // conversation.id
  expiresAt?,            // conversation.expiration_timestamp → ms
  originType?,           // raw string, e.g. "referral_conversion"
  pricingModel?,         // raw, "CBP" | "PMP"
  pricingCategory?,      // raw
  pricingType?,          // raw, e.g. "free_entry_point"
  billable?,
}
```

Wire it into the **existing** status loop at `convex/http.ts:111` — no new endpoint, no new
webhook path. Missing `pricing` / `conversation` objects are normal and must parse to
`undefined` rather than throwing.

### 2. Persistence — schema additions

| Table | Field | Purpose |
|---|---|---|
| `messages` | `pricing?: { billable, model, category, type, capturedAt }` | Per-message billing fact; Phase 4 aggregates it |
| `conversations` | `metaWindow?: { conversationMetaId, originType, expiresAt, isFreeEntryPoint, updatedAt }` | Meta's authoritative window state |
| `conversations` | `lastInboundAt?: number` | 24h CSW anchor; set in `ingest.ts` on every inbound customer message |
| `conversations` | `firstReplyAt?: number` | Timestamp of the first outbound message sent *after* `adReferral.startedAt`; anchors the FEP *estimate*. Written once, only when unset and an `adReferral` exists |

Two rules on `metaWindow`:

- **`isFreeEntryPoint`** is derived as
  `originType === "referral_conversion" || pricingType === "free_entry_point"`,
  covering both the CBP and PMP spellings.
- **`expiresAt` only ever advances.** Status webhooks are not ordered; a late `delivered` for
  an older message must not shrink a live window. Regression is allowed only when a genuinely
  different `conversation.id` arrives.

`lastInboundAt` also removes the duplicated last-customer-message scans in
`message-thread.tsx:289` and `qualificationEngine.ts:3042`.

### 3. Resolver — `resolveWindowState`

A pure function in a new `convex/lib/whatsapp/messagingWindow.ts`, becoming the single answer
the inbox, engine and send layer all consult.

```ts
type Reason = "fep" | "customer_service_window" | "billed"

resolveWindowState({ now, lastInboundAt?, metaWindow?, adReferral?, firstReplyAt? })
  → {
      csw: { open, expiresAt?, remainingMs },
      fep: { open, expiresAt?, remainingMs, source: "meta" | "estimated" | "none" },
      canSendFreeForm,                                  // === csw.open
      cost: {
        freeForm:               { free: boolean, reason: Reason },
        templateUtility:        { free: boolean, reason: Reason },
        templateMarketing:      { free: boolean, reason: Reason },
        templateAuthentication: { free: boolean, reason: Reason },
      },
      confidence: "authoritative" | "estimated",
    }
```

`cost` is a **data map, not a predicate**, for two reasons: cost depends on *what you are about
to send* (a single boolean cannot express quadrant 3, where free-form is free while a marketing
template is billed), and a plain object serializes across a Convex query boundary where a
function would not.

**24h CSW.** `open = lastInboundAt != null && now - lastInboundAt < 24h`;
`expiresAt = lastInboundAt + 24h`; `canSendFreeForm = csw.open`. When `lastInboundAt` is absent
(pre-existing rows), the caller supplies the last customer message timestamp via the existing
`by_conversation_sender` index, so old conversations behave exactly as they do today.

**72h FEP**, authoritative first:

- `metaWindow.isFreeEntryPoint && metaWindow.expiresAt` → use Meta's value.
  `source: "meta"`, `confidence: "authoritative"`.
- No `adReferral` → `open: false`, `source: "none"`.
- `adReferral` present but **no reply within 24h** of `adReferral.startedAt` →
  `open: false`, `source: "none"`, **permanently**. *(The rule missing today.)*
- `adReferral` + reply within 24h → `expiresAt = firstReplyAt + 72h`, `source: "estimated"`.
  Meta anchors on *delivered* and we estimate from *sent* — typically seconds apart, and
  superseded as soon as the status webhook lands.

**`cost`.** Resolved per message kind, in precedence order:

- `fep.open` → **all four kinds free**, `reason: "fep"`. This is the whole point of the FEP:
  marketing and authentication templates that are normally billed are free here.
- Else `csw.open` → `freeForm` free and `templateUtility` free
  (`reason: "customer_service_window"`); `templateMarketing` and `templateAuthentication`
  **billed**.
- Else → everything `billed`, and `canSendFreeForm` is `false` so `freeForm` is not sendable
  at all (its `free` value is not meaningful; callers must check `canSendFreeForm` first).

**Repeat ad clicks.** `conversations.adReferral` is set once and never overwritten, so a customer
clicking a *second* ad later does not refresh the estimate. This is acceptable because the
authoritative path handles it: Meta reports a new `conversation.id` and `expiration_timestamp`,
and the advance-only rule adopts the newer window. The estimate covers only the first entry.

### 4. The four-quadrant matrix

The resolver must produce exactly this. Row 2 is the valuable quadrant that today's code
obscures by revealing the ad-free label only *after* the 24h window expires
(`message-thread.tsx:1090`), treating the two windows as one concept.

| CSW (24h) | FEP (72h) | Can send | Cost |
|---|---|---|---|
| open | open | anything | free |
| **closed** | **open** | **template only** | **free** |
| open | closed | anything | free-form + utility free; marketing/auth billed |
| closed | closed | template only | billed |

### 5. Consumers — Phase 1 is wiring only

Phase 1 refactors the two existing window computations (`message-thread.tsx:289`,
`qualificationEngine.ts:3042`) to call the resolver, and exposes it for later phases.
`src/lib/inbox/adWindow.ts` remains, reduced to a caller. **No user-visible behaviour changes.**

## Testing

TDD, tests first — this is billing logic, and AGENTS.md treats `*.test.ts` as the most
reliable description of a module's behaviour.

`parseStatusPricing`:
- CBP-shaped payload (`pricing_model: "CBP"`, no `pricing.type`).
- PMP-shaped payload (`pricing.type: "free_entry_point"`).
- Missing `pricing`; missing `conversation`; both missing.
- Unknown enum values — must normalize, not throw.

`resolveWindowState`:
- No referral ⇒ FEP never open.
- Referral + reply within 24h ⇒ estimated FEP for 72h from `firstReplyAt`.
- **Referral + no reply within 24h ⇒ FEP never open.**
- Meta's `expiresAt` overrides an active estimate; `confidence` flips to `authoritative`.
- Out-of-order webhook must not shrink a live window.
- Absent `lastInboundAt` ⇒ falls back without error.
- All four quadrants of the matrix above, including CSW-closed/FEP-open.
- **`cost` per message kind in every quadrant** — in particular quadrant 3, where `freeForm`
  and `templateUtility` are free while `templateMarketing` and `templateAuthentication` are
  billed. A test that only asserts a single "is it free" boolean would not catch a regression
  here.
- `canSendFreeForm === false` whenever the CSW is closed, independent of FEP state.

## Compatibility & rollout

- Every new field is optional ⇒ no migration and no backfill.
- Pre-existing conversations fall back to today's logic until their next inbound message or
  status webhook populates the new fields.
- Capture is additive at one choke point; if `parseStatusPricing` returns nothing, the existing
  `updateDeliveryStatusByWamid` / `recordRecipientStatusByWamid` calls proceed unchanged.

## Out of scope (YAGNI)

- Countdowns, badges and any inbox UI → Phase 2.
- Send-layer gating, AI auto-reply / automation / broadcast behaviour → Phase 3.
- Cost aggregation and spend reporting → Phase 4.
- Handling `message_template_quality_update` / `message_template_components_update`
  (currently received but unhandled, `http.ts:89-96`) — unrelated pre-existing gap.

## Details to confirm during implementation

These are verification steps against live data, not unresolved design questions — the design is
deliberately tolerant of all of them:

1. **Exact PMP enum spellings**, confirmed against a real status webhook from this WABA. Meta's
   public docs still show CBP examples, and this account may emit either shape. Decision 2
   (raw + normalized) means an unexpected value degrades to "unknown" rather than breaking.
2. **Which status values carry `conversation`/`pricing`** for this WABA — documentation
   indicates all of `sent`/`delivered`/`read`/`failed` may, with field variation by origin.
   The advance-only rule on `expiresAt` makes the answer non-critical.
3. **Whether ads attribution is enabled** on the WhatsApp Business account. If it is off, Meta
   omits the `referral` object entirely and no FEP signal will ever arrive — worth confirming
   before Phase 2 surfaces this to agents.
