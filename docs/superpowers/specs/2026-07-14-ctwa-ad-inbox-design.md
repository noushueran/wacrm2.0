# Click-to-WhatsApp (CTWA) ad handling in the inbox

- **Date:** 2026-07-14
- **Branch:** `feat/ctwa-ad-inbox` (off `main` @ `1664a42`)
- **Status:** Design — approved in brainstorming, pending spec review
- **Related (distinct) effort:** `feat/ctwa-capi-measurement` — captures the same
  referral but for *conversion measurement back to Meta*. This spec is display +
  windowing only and is built so that effort can reuse the referral capture.

## 1. Problem

When a customer clicks a **Click-to-WhatsApp ad** and messages the business, two
things should happen that don't today:

1. **The ad preview ("banner") should render above the first message** — the ad
   image, headline, and body — the way WhatsApp itself stacks it. Today only the
   text shows.
2. **The conversation should be marked as an ad lead**, and the agent should see
   that ad leads get a longer, free re-engagement window.

### Root cause of #1

The inbound webhook carries a `referral` object on the first message with the full
ad creative. Our parser (`convex/lib/whatsapp/webhookParse.ts`) lifts **only**
`referral.ctwa_clid` and discards the rest, and nothing is stored — so there is
literally no data to render.

## 2. Meta facts (researched — these drive the design)

### 2.1 The `referral` object (inbound message from a CTWA ad)

| Field | Meaning |
|---|---|
| `source_url` | URL of the ad/post |
| `source_id` | the ad id |
| `source_type` | `"ad"` or `"post"` |
| `headline` | ad headline |
| `body` | ad body text |
| `media_type` | `"image"` or `"video"` |
| `image_url` | ad image (the banner) |
| `video_url` | ad video |
| `thumbnail_url` | video thumbnail |
| `ctwa_clid` | click id (attribution) |

Sources: [Meta messages webhook reference](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages),
[Sinch: Click to WhatsApp](https://community.sinch.com/t5/WhatsApp/What-is-Click-to-WhatsApp-and-how-does-it-integrate-with-the/ta-p/15320).

### 2.2 The window — 72 hours, but only for *cost*, not for free-form

This is the critical, non-obvious rule and it shapes the whole window design:

- **The 24-hour customer service window governs whether you may send a *free-form*
  (non-template) message.** This is a hard Meta rule and it does **not** change for
  ad leads. After 24h of customer silence, free-form is rejected; you must use an
  approved template.
- **The 72-hour "free entry point" (FEP) window governs *cost*.** Because the lead
  came from an ad and the business replied within 24h, all messages within 72h —
  including templates sent in hours 24–72 — are **free of charge**.

> "if the 24h Customer Service Window closes and you're beyond 24h from the user's
> last message, you can only send template messages — though they are still free
> within the 72h FEP window."
> — [DoubleTick: 72-hour free window](https://learn.doubletick.io/click-to-whatsapp-ctwa/understanding-the-72-hour-free-messaging-window-for-ctwa-leads)

So the real benefit of an ad lead is **free template re-engagement for 72h**, not
free-form for 72h. Extending the composer's free-form gate to 72h would produce
Meta API rejections in hours 24–72 — we deliberately do **not** do that.

Sources also: [SleekFlow](https://help.sleekflow.io/en_US/whatsapp/understanding-click-to-whatsapp-ads-ctwa-and-the-72-hour-free-window),
[Helpscout / Mastermind KB](https://mastermind.helpscoutdocs.com/article/1222-managing-whatsapp-conversations-a-guide-to-categories-duration-and-free-entry-point-conversations),
[Meta pricing](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing).

## 3. Decisions (locked with the user)

1. **Window behavior:** keep the 24h free-form gate unchanged; for ad leads, once
   past 24h, replace the plain "session expired" state with a **"Free window ·
   templates free for Xh"** 72h indicator. (Not "unlock free-form to 72h".)
2. **Ad-lead scope:** flag the **conversation** (badge + timer) **and** persist on
   the **contact** that they were acquired via an ad (shown in the contact panel).
3. **Ad image:** **download it into Convex storage at ingest** (durable), mirroring
   the existing inbound-media path — not hot-linked from Meta's CDN (which expires,
   reintroducing the exact "banner missing" bug).

## 4. Current state (files this touches)

- `convex/lib/whatsapp/webhookParse.ts` — `MetaWebhookMessage.referral` (only
  `ctwa_clid`/`source_id`), `FlattenedInboundMessage`, `flattenInboundMessage`.
- `convex/http.ts` — passes `flattened` to `internal.ingest.processInbound`.
- `convex/ingest.ts` — `processInbound` (action) persists via `ingestInbound`
  mutation, then (post-dedup) resolves media through
  `internal.whatsappConfig.resolveInboundMedia` → `internal.messages.setMediaUrl`.
  `appendArgs` is built ~L231.
- `convex/messages.ts` — `insertMessageAndUpdateConversation`, `AppendMessageArgs`,
  `setMediaUrl`.
- `convex/schema.ts` — `messages` (L176), `conversations` (L127), `contacts` (L58).
- `src/types/index.ts` — `Message`, `Conversation`, `Contact`.
- `src/lib/convex/adapters.ts` — `toUiMessage` (L288), `toUiConversation` (L255),
  `toUiContact` (L84).
- `src/components/inbox/message-bubble.tsx` — `MessageContent` switch, `MessageBubble`.
- `src/components/inbox/message-thread.tsx` — `sessionInfo` memo (L213), header.
- `src/components/inbox/message-composer.tsx` — `sessionExpired` prop, `inputsDisabled`
  (L202), expired banner (L555), send gate (L763).
- `src/components/inbox/contact-panel-drawer.tsx` / `contact-sidebar.tsx` — contact panel.

## 5. Design

### 5.1 Capture the referral (parse)

Widen `MetaWebhookMessage.referral` and add an `AdReferral` shape to
`FlattenedInboundMessage`. `flattenInboundMessage` lifts the whole referral (not
just `ctwa_clid`); a `null` (reaction/skip) result still stays `null`.

```ts
export interface AdReferral {
  sourceType?: "ad" | "post";
  sourceId?: string;
  sourceUrl?: string;
  headline?: string;
  body?: string;
  mediaType?: "image" | "video";
  imageUrl?: string;       // Meta CDN — may expire
  videoUrl?: string;
  thumbnailUrl?: string;
  ctwaClid?: string;
}
// FlattenedInboundMessage gains:  referral?: AdReferral
```

Back-compat: `ctwaClid` stays a top-level field on `FlattenedInboundMessage` (the
dormant attribution POST reads it); `referral` is additive.

### 5.2 Persist + denormalize (ingest)

In `ingestInbound` (mutation), extend `AppendMessageArgs` /
`insertMessageAndUpdateConversation` so that when `message.referral` is present:

1. **Message row:** store `referral` (typed optional object) on the inserted
   `messages` row — it belongs to that specific first message.
2. **Conversation denorm:** if the conversation has no `adReferral` yet, set a
   compact summary: `{ headline, body, storedImageUrl?, imageUrl?, sourceUrl,
   sourceType }`. Presence of `conversations.adReferral` **is** the "is ad lead"
   flag — the inbox list and thread header read it without scanning messages
   (mirrors the existing `lastMessageText` denorm).
3. **Contact acquisition (set once):** if `contact.acquisitionSource` is unset, set
   `acquisitionSource: "ad"` and `acquisitionAd: { headline, sourceId, sourceUrl,
   firstSeenAt: now }`.

Then, in `processInbound` (action), **after the dedup check** — same placement and
best-effort discipline as the existing media resolution — download the ad image:

```
if (referral?.imageUrl || referral?.thumbnailUrl) {
  // NEW action: internal.whatsappConfig.storeAdImage  (fetch CDN url -> ctx.storage.store)
  // then internal.messages.setAdReferralImage(messageId, storedUrl)
  //   which patches messages.referral.storedImageUrl AND the conversation denorm.
}
```

Unlike inbound media, the referral gives a **direct CDN URL** (not a Meta
`mediaId`), so no signed Graph resolve is needed — a plain `fetch()` →
`ctx.storage.store(blob)` → `ctx.storage.getUrl(id)`. Best-effort: on failure we
keep `imageUrl` (Meta CDN) as a fallback so the card still tries to render.

### 5.3 Schema (all additive / optional → no migration)

- `messages`: `referral: v.optional(<AdReferral validator + storedImageUrl>)`.
- `conversations`: `adReferral: v.optional(v.object({ headline, body,
  storedImageUrl?, imageUrl?, sourceUrl?, sourceType? }))`.
- `contacts`: `acquisitionSource: v.optional(v.literal("ad"))`,
  `acquisitionAd: v.optional(v.object({ headline?, sourceId?, sourceUrl?,
  firstSeenAt: v.number() }))`.

Built offline by hand-editing `convex/_generated/` (any `convex dev/deploy/codegen`
pushes to live prod). New fields on existing tables → `schema.ts` only.

### 5.4 Types + adapters

Add `referral?: AdReferral & { stored_image_url?: string }` to `Message`,
`ad_referral?` to `Conversation`, and `acquisition_source?` / `acquisition_ad?` to
`Contact` in `src/types/index.ts`; surface them in `toUiMessage` /
`toUiConversation` / `toUiContact`.

### 5.5 Ad preview card (the #1 ask)

New `src/components/inbox/ad-referral-card.tsx`, rendered at the **top of the
message bubble** (inside `MessageContent`, before the type switch) whenever
`message.referral` is set:

```
┌───────────────────────────────┐
│ 📣 From an ad                  │
│ ┌───────┐  Dubai 5N/6D Package │  headline (semibold, 1-line clamp)
│ │ [img] │  Starting AED 1,499… │  body (2-line clamp)
│ └───────┘  View ad ↗           │  link -> source_url (new tab, rel=noopener)
├───────────────────────────────┤
│ Hello, how can I get more      │  the actual message content
│ information about this?         │
└───────────────────────────────┘
```

- Image source: `stored_image_url ?? image_url ?? thumbnail_url`; video ads use the
  thumbnail; text-only ads render with no image block.
- Themed for light/dark; image lazy-loaded; graceful when the image 404s.

### 5.6 Thread header "Ad lead" badge

In `message-thread.tsx`, render an `Ad lead` `<Badge>` (megaphone icon) next to the
contact name when `conversation.ad_referral` is present.

### 5.7 Window logic (the #2 ask)

Extend the `sessionInfo` memo in `message-thread.tsx`. The 24h free-form gate
(`sessionExpired`) is **unchanged**. Add, for ad leads only, a derived
`freeWindow`:

- `freeUntil` = (first outbound message with `created_at >=` the referral message's
  `created_at`).`created_at` + 72h; fallback to the referral message's own time if
  no reply yet.
- When `sessionExpired` **and** `now < freeUntil`: show **"Free window · templates
  free for Xh"** instead of the plain expired copy, in both the thread banner and
  the composer's `sessionExpired` banner (`message-composer.tsx` L555). The composer
  stays gated to templates (correct — free-form is still closed).
- When `now >= freeUntil`: current behavior (plain "session expired → templates").

This is a **client-side approximation** — Meta does not webhook FEP open/close, so
we anchor to the first agent reply. It is intentionally conservative (never claims
"free" past a plausible 72h). Documented as such.

### 5.8 Contact panel

In the contact panel, an **"Acquired via ad"** row (ad headline + `View ad ↗` link)
when `contact.acquisition_source === "ad"`.

## 6. Testing (TDD)

Convex tests are offline (`convex-test`); write tests first:

- **Parse:** `flattenInboundMessage` lifts the full referral; still returns `null`
  for reactions; a message with no referral is unchanged.
- **Ingest:** an inbound with a referral → message row has `referral`; conversation
  gets `adReferral` once (a second ad message does not overwrite it); contact gets
  `acquisitionSource/acquisitionAd` once; a non-ad inbound sets none of them; dedup
  (Meta retry) does not double-store the image.
- **Window:** a pure helper `computeFreeWindow(messages, adReferralAt, now)` unit-
  tested for: within 24h (normal), 24–72h with a reply (free-window shown), >72h
  (expired), no reply yet, non-ad conversation (no free window).
- Extract window math into `src/lib/inbox/` as a pure function (matches the existing
  `src/lib/inbox/view.ts` pattern) so it's testable without React.

## 7. Non-goals / scope boundaries

- **No Meta CAPI / conversion events.** Firing `LeadSubmitted` back to Meta is the
  separate `feat/ctwa-capi-measurement` effort. This spec only *captures* the
  referral (which that effort also needs) — no attribution POST changes here.
- **No inbox "ad leads" filter tab** in this pass (possible later extension on top
  of `conversations.adReferral`).
- **Forward-only.** Existing conversations (incl. the user's earlier test click) had
  their referral discarded and cannot be backfilled — verification requires a fresh
  ad click after deploy.

## 8. Guardrails

- Additive optional schema, no migration; build `_generated/` by hand (codegen
  pushes prod).
- Per `AGENTS.md`: this is a modified Next.js — consult `node_modules/next/dist/docs/`
  before any routing/framework-level code (this feature is mostly components +
  Convex, minimal framework surface).
- Enablement needs the owner's `convex deploy` + Netlify build of this branch.

## 9. Verification plan

1. Offline: `tsc`, lint, `convex-test` suite, `next build`.
2. After deploy: click the live CTWA ad, message the number, confirm (a) the ad card
   renders above the first message, (b) the thread + inbox show the `Ad lead` badge,
   (c) the contact panel shows "Acquired via ad", (d) after 24h the composer shows
   the free-window template hint.
