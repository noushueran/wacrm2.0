# Cloudflare R2 media storage — design

**Date:** 2026-07-19
**Status:** Approved (owner, 2026-07-19)
**Branch:** `feat/r2-media-storage`

## Problem

Every byte of media in this CRM lives in Convex file storage on the self-hosted
VPS (`convex-wd56`, backing `convex-api.holidayys.co`). That is both a disk
problem and — less obviously but more importantly — a **bandwidth** problem.

Media is not only *stored* on the VPS, it is *served* from it. Three separate
classes of consumer pull those bytes back through the VPS on every access:

1. Agents' browsers rendering `<img>` / `<audio>` / `<video>` in the inbox.
2. **Meta's servers** — four call sites hand a stored URL to
   `metaSend.sendMedia` as `link:`, which places it in the Meta payload at
   `convex/metaSend.ts:340`; Meta then fetches it server-side to deliver the
   media. The callers are `convex/send.ts:151` (dashboard send),
   `convex/apiV1.ts:577` (public API), `convex/flowsEngine.ts:690`
   (`send_media` flow node) and, for template headers,
   `src/lib/whatsapp/template-send-builder.ts:106`.
3. **OpenAI** — `convex/lib/ai/media.ts:103` passes the URL as `image_url` for
   vision, and the Whisper path fetches the same URL for voice-note
   transcription.

So a single inbound voice note is written once and then re-read by the VPS for
every agent who opens the thread plus every AI transcription. Storage grows
monotonically and can never be reclaimed without deleting customer history.

## Goals

- Move all media bytes (image, audio/voice, video, document) off the VPS to the
  Cloudflare R2 bucket `wa-holidayys`.
- Serve reads from Cloudflare's edge, not the VPS.
- Migrate **existing** media, not just new writes, and reclaim the VPS disk.
- No downtime; every step independently reversible.

## Non-goals

- Changing media size limits, allowed types, or any user-visible behavior.
- Moving Convex's database, search indexes, or modules off the VPS. Files only.
- Edge-side inbound ingestion (see "Deferred" below).

## Verified findings

These were established by reading the code, not assumed. (Note: `CLAUDE.md`
mandates Augment Code for retrieval; its MCP server returned **HTTP 402 Payment
Required** on 2026-07-19, so this survey used direct search instead.)

### Every path that writes bytes

| Source | Path | URL string lands in |
|---|---|---|
| Inbound WA image/audio/video/doc | `ingest.processInbound` → `whatsappConfig.resolveInboundMedia` (`convex/whatsappConfig.ts:1083`) → `files.storeFromUrl` | `messages.mediaUrl` |
| CTWA ad-referral image | `convex/ingest.ts:621` → `files.storeFromUrl` | `messages.referral.storedImageUrl` |
| Composer attachment, agent voice note | `uploadAccountMedia` (`src/lib/storage/upload-media.ts:70`) | `messages.mediaUrl` |
| Flow `send_media` node | `uploadAccountMedia` via `src/components/flows/forms/node-config-form.tsx:912` | flow node `media_url` |
| Template header media | `uploadAccountMedia` via `src/components/settings/template-manager.tsx:480` | `templates.headerMediaUrl` |
| User avatar | `src/components/settings/profile-form.tsx:131` | `memberships.avatarUrl` |

### The core coupling problem

Rows store the **resolved absolute URL string**, not the `Id<"_storage">`. That
is why this migration requires rewriting database rows at all, and it is the
mistake this design deliberately does not repeat.

### Current URLs are public, permanent and unauthenticated

`convex/files.ts`'s header comment describes `getUrl` as returning a "signed,
time-limited" URL. **On this self-hosted deployment that is not the observable
behavior** — the URLs are permanent and unauthenticated, which is precisely why
Meta and OpenAI can fetch them at all. `convex/whatsappConfig.ts` documents the
real contract: the inbox can fetch media "directly, forever, exactly like
agent-sent (outbound) media, with no auth proxy".

Any replacement must preserve exactly that: **public, permanent, no auth**. A
15-minute signed URL stored in a row would break on first re-read.

### Inbound media has no ownership record

`files.storeFromUrl` never writes a `fileOwners` row — only client uploads do
(via `files.registerUpload`). So inbound objects are reachable *only* through
the URL string in `messages`. The backfill must therefore be driven from the
rows, not from the `_storage` table.

## Architecture

### Decision: store object keys, serve via a public custom domain

DB rows hold an R2 **object key**; a single helper resolves key → URL. Behavior
is identical to today (public, permanent, CDN-cached), but a future domain
change or a switch to signed URLs becomes a config change rather than another
row-rewriting migration.

### Config

| Setting | Value |
|---|---|
| Bucket | `wa-holidayys` |
| Account ID | `a80be7ba4a3283e02427058e9e477754` |
| S3 endpoint | `https://a80be7ba4a3283e02427058e9e477754.r2.cloudflarestorage.com` |
| Public custom domain | **`objs.holidayys.co`** |

Convex deployment env vars (owner sets these directly — secrets are never
pasted into a chat transcript or committed):

```
R2_BUCKET=wa-holidayys
R2_ENDPOINT=https://a80be7ba4a3283e02427058e9e477754.r2.cloudflarestorage.com
R2_ACCESS_KEY_ID=…
R2_SECRET_ACCESS_KEY=…
# (no R2_TOKEN — aws4fetch signs with the access key pair alone)
R2_PUBLIC_HOST=https://objs.holidayys.co
```

`R2_PUBLIC_HOST` is also needed client-side as `NEXT_PUBLIC_R2_PUBLIC_HOST`
(Netlify) for browser-side URL construction.

**`r2.dev` must not be used.** Cloudflare rate-limits it and documents it as
development-only; with Meta and OpenAI fetching these URLs, that would surface
as intermittent media failures.

### Object key convention

```
{accountId}/{kind}/{uuid}.{ext}
```

e.g. `k57abc…/inbound/9f2a…-b1c3.ogg`. `kind` ∈ `inbound | outbound | template
| flow | avatar | ad`.

Account-scoping the prefix restores something the opaque `Id<"_storage">` model
never had: per-tenant listing, GC and storage accounting. The `accountId` in the
path is an opaque Convex id, so it leaks no meaningful tenant information.

### R2 access is confined to one module

All S3/R2 interaction lives in a single internal module (`convex/lib/r2/`)
exposing exactly three operations — `putObject`, `presignPut`, `deleteObject`
— implemented with `aws4fetch` in Convex's **default** runtime (no
`"use node"`; see Risk 1). Nothing else in the codebase talks to R2, so the
transport is swappable without touching any caller.

### Byte flow

- **Client uploads** — browser PUTs directly to a signed R2 URL. The VPS never
  sees the bytes.
- **Reads** — served from Cloudflare's edge. This is the dominant traffic and
  the primary win.
- **Inbound WhatsApp media** — bytes still transit the VPS: `resolveInboundMedia`
  runs as a Convex action, so the path is Meta → action memory → R2. They never
  touch disk, and it is one transient pass instead of one write plus every
  subsequent read. Moving this to the edge is deferred (below).

## Schema changes

Additive and initially dormant. Existing URL fields are retained throughout.

| Table | New field |
|---|---|
| `messages` | `mediaKey: v.optional(v.string())` |
| `messages.referral` | `storedImageKey: v.optional(v.string())` |
| `templates` | `headerMediaKey: v.optional(v.string())` |
| `memberships` | `avatarKey: v.optional(v.string())` |

NOT `users` — that table is spread verbatim from `@convex-dev/auth`'s
`authTables` and has no `avatarUrl`, only an auth-provider-written `image`.
The app's avatar is the denormalized per-account snapshot on `memberships`
(`convex/accounts.ts` `updateProfile`/`me`). Corrected during Task 4.
`contacts.avatarUrl` is deliberately excluded — it is Meta's profile-picture
URL, never written through our upload path.

Flow nodes need **no schema change**: `flowNodes.config` is `v.optional(v.any())`
and the media URL lives inside it as the untyped `config.media_url`
(written at `src/components/flows/forms/node-config-form.tsx:916`, read at
`convex/flowsEngine.ts:690`). The key goes in as `config.media_key` alongside it.
Because that blob is unvalidated, the backfill must tolerate flow nodes whose
`config` is malformed or missing the field entirely rather than assuming shape.

Reads resolve `key ?? url`, so rollback at any point is simply "stop reading
`mediaKey`". The old URL columns are dropped only in a later, separate change
once the backfill is verified and a rollback window has passed.

Most read sites are covered by `src/lib/convex/adapters.ts` (already the
Convex-doc → app-type boundary, e.g. `media_url` at `:346`), so the fallback
logic lands in a small number of places rather than at every call site.

## Module changes

### `convex/files.ts`

`generateUploadUrl` / `registerUpload` / `getUrl` / `remove` / `storeFromUrl`
are reimplemented against R2, returning and accepting keys.

**Tenant isolation must not regress.** The current module is carefully hardened:
`fileOwners` binds each object to an account, and `getUrl`/`remove` return a
non-leaky `NOT_FOUND` for a foreign or unregistered id so a caller cannot
distinguish cross-account from missing. The R2 version keeps all of it —
ownership recorded on upload sync, the same `requireRole("agent")` floor, and
the same non-leaky error shape. This is the highest-risk part of the change and
should get explicit review.

### `src/lib/storage/upload-media.ts`

`uploadAccountMedia` returns `{ key }` instead of `{ url, storageId }`;
`deleteAccountMedia` takes a key. Its four call sites (composer ×2,
node-config-form, template-manager) update accordingly. Size limits
(`MEDIA_MAX_BYTES`, `MEDIA_MAX_BYTES_BY_KIND`) are unchanged.

### `convex/whatsappConfig.ts` / `convex/ingest.ts`

`resolveInboundMedia` returns `{ key }`; the ad-referral block at `ingest.ts:621`
writes `storedImageKey`. The decrypted access token still never leaves the
action — unchanged.

### New: media URL resolution helper

One function, mirrored server- and client-side, building
`${R2_PUBLIC_HOST}/${key}` and implementing the `key ?? legacyUrl` fallback.

Server-side read sites that must call it before handing a URL to an external
fetcher — missing one means that path silently keeps serving from the VPS:

- `convex/send.ts:151` → `metaSend.sendMedia`
- `convex/apiV1.ts:577` → `metaSend.sendMedia`
- `convex/flowsEngine.ts:690` → `metaSend.sendMedia`
- `src/lib/whatsapp/template-send-builder.ts:106` (template header media)
- `convex/lib/ai/media.ts:41` (Whisper fetch) and `:103` (vision `image_url`)

Client-side, `src/lib/convex/adapters.ts` covers the bulk of rendering.

## Migration

Row-driven, not object-driven — rows are what need rewriting; unreferenced
objects are swept at the end.

1. **Measure.** `ctx.db.system.query("_storage")` yields every object with
   `size` and `contentType` → current usage and cost projection.
2. **Backfill.** Batched, cursor-based over `messages` (both `mediaUrl` and
   `referral.storedImageUrl`), `templates`, `users` and `flowNodes`: fetch bytes
   from the existing Convex URL → PUT to R2 under a new key → patch the key
   field. Runs as a paced internal action so it cannot saturate the VPS uplink.
   **Index-driven pagination only — no `.filter()`.** Per the repo-wide rule,
   `.filter()` does not narrow the scan and `.take(n)` stops at n *matches*, not
   n reads; that exact shape took `/settings?tab=cron` down on 2026-07-18.
3. **Verify.** Reconcile counts, spot-check each media type end-to-end.
4. **Purge.** Delete objects from Convex storage; reclaim VPS disk.
5. **Later, separately.** Drop the vestigial URL columns.

## Rollout order

Backend-first, per the standing deploy lesson (Convex backend is a separate
manual deploy from Netlify; merge `origin/main` before every `convex deploy`):

1. Spike component support (below).
2. Create the R2 API token; bind `objs.holidayys.co`; set env vars.
3. Ship schema additions — additive, dormant.
4. Ship dual-read (`key ?? url`) — no behavior change.
5. Flip new writes to R2.
6. **End-to-end verify a real outbound media send before backfilling.**
7. Run the backfill, monitored.
8. Purge Convex storage, reclaim disk.

## Risks

### 1. ~~Convex component support~~ — RESOLVED by dropping the component

Originally this design assumed `@convex-dev/r2`, which requires the backend to
support components — unverifiable remotely (`/version` and `/instance_version`
both return `unknown`, no image tag recorded in this repo) and untestable
without a production push, since there is exactly one live self-hosted Convex
and `convex dev` / `deploy` / `codegen` all target it.

**The component is dropped.** R2 is an S3-compatible endpoint, so it is reached
directly with [`aws4fetch`](https://github.com/mhart/aws4fetch) — a 6.4 kB
client that signs with `fetch` + `SubtleCrypto` and is
[the approach Cloudflare itself documents for R2](https://developers.cloudflare.com/r2/examples/aws/aws4fetch/).

This is strictly better here:

- **No backend-version dependency.** The blocker disappears entirely.
- **Matches this codebase's documented convention.** `convex/lib/whatsappEncryption.ts:11`
  states `"use node"` is a last resort and Web Crypto is preferred;
  `convex/webhookDelivery.ts:177-184` already does HMAC-SHA256 via
  `crypto.subtle.importKey` + `.sign`, which is exactly what SigV4 needs. The
  AWS SDK would have forced `"use node"`, and `"use node"` files may only
  export actions — a real structural constraint.
- **We need three operations** (PUT, DELETE, presigned PUT). The component's
  metadata table and pagination are redundant, since keys live in our own rows.

**Contract that must be honored:** `Content-Type` is part of the presigned
signature, and **the upload fails if the client then sends a different
`Content-Type` than the one signed**.

🚨 Setting the header on the `Request` passed to `sign()` is NOT sufficient —
that is all Cloudflare's documented example does, and it leaves the header
unsigned. aws4fetch keeps `content-type` in its `UNSIGNABLE_HEADERS` set and
filters on `allHeaders || !UNSIGNABLE_HEADERS.has(header)`, so the signing
call must pass **`{ aws: { signQuery: true, allHeaders: true } }`**. Verified
against `aws4fetch`'s source during implementation (Task 3, 2026-07-19); the
first draft of this design had the bug. So the client's MIME type must round-trip:
browser reports `file.type` → server presigns with exactly that → browser PUTs
with exactly that. `src/lib/storage/upload-media.ts:78` already sends
`"Content-Type": file.type`, so this falls out naturally — but it means
`presignPut` must take the content type as an argument and must not default it.

Getting this right is also what makes the objects serve correctly: R2 stores the
signed `Content-Type`, which is what lets `<img>`/`<audio>`/`<video>` and Meta's
fetcher handle the object properly.

### 2. Cloudflare could block Meta's media fetcher

If bot protection, a WAF rule or hotlink protection sits in front of
`objs.holidayys.co`, outbound media sends fail **silently from Meta's side** —
the CRM shows the message as sent. Must be proven with a real end-to-end send
(step 6) before any backfill runs.

### 3. Privacy posture is inherited, not improved

Customers send passport scans and ID documents over WhatsApp. Those sit at
public, unauthenticated (unguessable-key) URLs today; this design keeps that at
parity. Accepted deliberately by the owner. Storing keys rather than URLs means
tightening later is a resolver change, not a migration.

## Testing

- Unit: key generation, URL resolution, `key ?? url` fallback precedence.
- `convex-test` **lacks `ctx.db.system`** (known gotcha), so the measurement and
  purge steps need their enumeration seam mocked.
- Tenant isolation: the existing `files.ts` cross-account tests must be ported
  and must still pass against the R2 implementation.
- Integration: a separate throwaway bucket, never `wa-holidayys`.

## Deferred

- **Edge-side inbound ingestion.** A Cloudflare Worker doing the Meta → R2
  transfer would keep inbound bytes off the VPS entirely. Meaningful only after
  the read traffic (the dominant share) is already offloaded.
- **Dropping legacy URL columns.** Separate change, after a rollback window.

## Open questions

1. Current media footprint on the VPS and total disk size — shapes backfill
   pacing. Resolved by step 1 of Migration regardless.
2. Is `holidayys.co` on the same Cloudflare account as the `wa-holidayys`
   bucket? Determines whether the custom-domain binding is one click or a DNS
   delegation.
