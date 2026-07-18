# Ad-aware AI agent (CTWA landing-page context) — design

**Date:** 2026-07-18 · **Status:** approved for implementation

## Problem

Click-to-WhatsApp leads open with a throwaway greeting ("Hi") while the real
intent lives in the ad they clicked — which arrives as a `referral` payload
(headline, ad text, `source_url`) on the first inbound message. The AI
assistant never sees any of it: `buildSystemPrompt` has no lead-source input,
so the first reply is a blind "how can I help?" instead of "you're asking
about the Georgia summer package — great choice." The `source_url` (the page
the ad links to) holds the richest context — package name, itinerary,
pricing — and nothing in the system fetches it.

## Approaches considered

1. **Referral-only prompt injection** — put the stored
   `conversation.adReferral` (headline/body/link) into the system prompt.
   Zero fetching, zero latency, but ignores the landing page — thin when the
   ad creative text is short, and misses the owner's explicit "fetch from the
   link" requirement.
2. **Referral + cached landing-page fetch (CHOSEN)** — layer 1 plus a small
   fetch-and-extract pipeline for `source_url`, cached per account+URL with a
   TTL. All context the link can give, still resilient when the fetch fails
   (falls back to layer 1).
3. **Meta Marketing API creative pull** — resolve `source_id` via the Graph
   API for the full creative. Needs `META_ADS_ACCESS_TOKEN` + ad-account
   permissions, duplicates what the referral already carries, and still
   doesn't read the landing page. Deferred as a follow-up if 2 proves thin.

## Design (approach 2)

### Data

New table `adLandingPages` — one row per (account, normalized URL):
`urlKey` (normalized `source_url`: fragment + tracking params stripped),
`url`, `status: pending|ok|error`, `title`, `description`, `content`
(extracted text ≤ 4000 chars), `finalUrl`, `error`, `fetchStartedAt`
(claim clock), `fetchedAt` (freshness clock). Index
`by_account_url ["accountId","urlKey"]`. Content fields keep the last good
extraction across a failed refresh.

### Pure helpers — `convex/lib/ai/adContext.ts`

- `isFetchableLandingUrl` — http(s) only; rejects localhost / `.local` /
  `.internal` / IP-literal hosts (the Convex backend is a VPS; no SSRF
  pivots off referral-supplied URLs).
- `landingUrlKey` — cache-key normalization (drop `#…`, `utm_*`, `fbclid`,
  `gclid`, `msclkid`, `igshid`).
- `extractLandingContent` — regex-level HTML→text: og:title/og:description/
  meta-description/`<title>`, scripts/styles/comments stripped, entities
  decoded, whitespace collapsed, capped. No new dependencies.
- `AdContext` type shared by the prompt builder and `aiReply`.

### Fetcher — `convex/adLanding.ts`

`ensureFresh` (internalAction, never throws): normalize → `claimFetch`
(mutation; atomically claims when the row is missing, ok-stale > 24 h,
error-stale > 1 h, or pending-stuck > 2 min — losers no-op, so concurrent
ingests fetch once) → `fetch` (8 s timeout, redirects followed, UA set,
content-type/size guarded) → `extractLandingContent` → `storeResult`
(mutation). Under `CONVEX_AI_DRY_RUN` it stores a synthetic extraction and
skips the network — same offline-test convention as `syntheticGeneration`.

### Wiring

- **Ingest warm-up** (`convex/ingest.ts`, next to the ad-image re-host):
  every referral-carrying inbound schedules `ensureFresh(sourceUrl)` —
  fire-and-forget, so ingest latency is untouched; the 12 s reply debounce
  is the headroom that usually makes the cache ready before the first reply.
- **Reply injection** (`convex/aiReply.ts`): `dispatchInbound` and `draft`
  call a shared `loadAdContext(ctx, accountId, conversation)` — reads
  `conversation.adReferral` (already loaded; zero extra reads when absent),
  lazily re-`ensureFresh`es (covers ad threads that predate this feature),
  reads the cache row, and passes `AdContext` to `buildSystemPrompt`.
  Best-effort: any failure just drops the grounding, never the reply.
- **Prompt** (`convex/lib/ai/defaults.ts`): new optional `adContext` arg
  renders a "Lead source" section — the ad facts + landing extraction
  (injection-capped), with instructions to acknowledge the specific offer
  by name, answer what was actually asked, never mention the ad
  "attachment", and never invent details beyond the given context. The
  existing "never invent facts" scaffold rule stays authoritative.

### Error handling

Every step is best-effort and bounded: unfetchable/oversized/non-HTML pages
store an `error` row (retried after TTL), extraction that yields nothing
stores `error`, and the dispatch path catches everything — worst case the
bot replies exactly as it does today. `processInbound` wraps the warm-up in
`runBestEffort` like every other fan-out step.

### Testing

- Pure: URL guard, key normalization, HTML extraction, prompt section
  rendering (`convex/lib/ai/adContext.test.ts`).
- convex-test: `ensureFresh` dry-run row lifecycle, claim/TTL takeover
  rules, error-keeps-last-good (`convex/adLanding.test.ts`).
- Integration: dispatch on an ad-lead conversation still replies AND warms
  the landing cache lazily (`convex/aiReply.test.ts`).

### Out of scope

Marketing-API creative resolution (follow-up), qualification-analyzer
pre-fill from ad context, any UI (the inbox ad card already exists), and
non-referral link unfurling in ordinary messages.
