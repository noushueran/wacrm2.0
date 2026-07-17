import { NextResponse } from 'next/server'
import { verifyMetaWebhookSignature } from '@/lib/whatsapp/webhook-signature'

// ============================================================
// Thin proxy (Phase 8, Task 4b) — Meta's webhook URL stays pointed at
// THIS route, unchanged (a deliberate project architecture decision),
// but all parsing/dispatch logic moved to a Convex httpAction
// (`convex/http.ts`'s `POST /whatsapp/ingest` + `GET /whatsapp/webhook`).
// This route's only remaining jobs:
//
//   - POST: verify Meta's `x-hub-signature-256` HMAC on the RAW body
//     (signature material — META_APP_SECRET — stays here, never crosses
//     into Convex), then forward the exact raw bytes to Convex with a
//     shared-secret header (`x-wacrm-proxy-secret` / `WEBHOOK_PROXY_SECRET`)
//     so only this route can call that otherwise-public Convex endpoint.
//   - GET: no signature to verify (Meta's verify handshake carries no
//     HMAC, just a plaintext `hub.verify_token`) — relay
//     hub.mode/challenge/verify_token to Convex's own GET httpAction
//     (gated by the same shared secret) and pass its response straight
//     through.
//
// Everything that used to live here — the Supabase admin client,
// `processWebhook`/`processMessage`/`parseMessageContent`, and the
// flows/automations/AI-reply/webhook-delivery engine calls — moved to
// `convex/http.ts` + `convex/ingest.ts`'s `processInbound` orchestrator.
//
// `WEBHOOK_PROXY_SECRET` and `NEXT_PUBLIC_CONVEX_SITE_URL` must both be
// set for this route to do anything useful — see this task's own report
// for why `NEXT_PUBLIC_CONVEX_SITE_URL` (not the unprefixed
// `CONVEX_SITE_URL` `.env.local.example` used to document) is the
// correct variable, and why the controller must set the shared secret
// on both this app and the Convex deployment.
// ============================================================

function convexSiteUrl(): string {
  const site = process.env.NEXT_PUBLIC_CONVEX_SITE_URL
  if (!site) {
    throw new Error(
      '[webhook proxy] NEXT_PUBLIC_CONVEX_SITE_URL is not set — cannot forward to the Convex httpAction.',
    )
  }
  return site.replace(/\/$/, '')
}

function proxySecretHeaders(): Record<string, string> {
  const secret = process.env.WEBHOOK_PROXY_SECRET
  if (!secret) {
    throw new Error(
      '[webhook proxy] WEBHOOK_PROXY_SECRET is not set — cannot authenticate to the Convex httpAction.',
    )
  }
  return { 'x-wacrm-proxy-secret': secret }
}

// Ceiling on the forward to Convex. Without it, a hung or very slow
// Convex backend blocks this function until the platform kills it —
// Meta then gets NO response at all and retries, and those retries
// arrive while the original is still hung (self-amplifying). Both
// handlers below already return regardless of the forward's outcome, so
// aborting costs nothing that isn't already accepted; Convex's own
// wamid dedup (`convex/ingest.ts`'s `ingestInbound`) covers the
// duplicate-delivery side.
const FORWARD_TIMEOUT_MS = 5_000

// GET - Webhook verification. No signature to check (Meta's handshake
// has none) — just relay the query string to Convex's own GET
// httpAction and pass its response straight back to Meta.
export async function GET(request: Request) {
  try {
    const incoming = new URL(request.url)
    const target = new URL(`${convexSiteUrl()}/whatsapp/webhook`)
    target.search = incoming.search

    const response = await fetch(target, {
      method: 'GET',
      headers: proxySecretHeaders(),
      signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS),
    })
    const text = await response.text()
    return new Response(text, {
      status: response.status,
      headers: {
        'Content-Type': response.headers.get('content-type') ?? 'text/plain',
      },
    })
  } catch (error) {
    console.error('[webhook proxy] GET forward failed:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// POST - Receive messages. Verify Meta's signature here (the one thing
// this route still owns), then forward the exact raw bytes to the
// Convex httpAction, which does all the parsing + engine dispatch.
export async function POST(request: Request) {
  // Read raw body first so we can HMAC-verify the exact bytes Meta
  // signed, and so the SAME bytes (not a re-encoded JSON.stringify) are
  // what Convex receives and eventually persists/hashes against.
  const rawBody = await request.text()
  const signature = request.headers.get('x-hub-signature-256')

  if (!verifyMetaWebhookSignature(rawBody, signature)) {
    // 401 (not 200) — we want Meta's delivery dashboard to show
    // failures loudly if a misconfiguration causes signatures to stop
    // matching, rather than silently eating events.
    console.warn('[webhook] rejected request with invalid signature')
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  // Forward to Convex and await it — the Convex httpAction itself is
  // fast (it only parses + does small status/template patches inline,
  // scheduling the actual flows/automations/AI-reply/webhook-delivery
  // fan-out via `ctx.scheduler.runAfter` rather than awaiting it), so
  // this await does not risk missing Meta's ~20s ack timeout the way
  // running the full fan-out in-process used to. Any failure here is
  // logged, not surfaced to Meta — we still ack 200 below, same
  // fast-unconditional-ack contract the previous in-process `after()`
  // version had (background-processing failures were never reflected
  // in the HTTP response either).
  try {
    const target = `${convexSiteUrl()}/whatsapp/ingest`
    const response = await fetch(target, {
      method: 'POST',
      headers: {
        ...proxySecretHeaders(),
        'content-type': 'application/json',
      },
      body: rawBody,
      signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS),
    })
    if (!response.ok) {
      console.error(
        `[webhook proxy] Convex httpAction responded ${response.status}`,
      )
    }
  } catch (error) {
    console.error('[webhook proxy] forward to Convex failed:', error)
  }

  return NextResponse.json({ status: 'received' }, { status: 200 })
}
