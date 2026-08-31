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

/** How long to wait for the Convex httpAction before giving up and asking
 *  Meta to redeliver. Comfortably inside Meta's ~20s ack window so the
 *  response below is ours rather than a platform timeout. */
const FORWARD_TIMEOUT_MS = 10_000

/**
 * Decline the delivery so Meta retries it later.
 *
 * 503 rather than 500: this is "the downstream is unavailable, come back",
 * which is exactly true, and it is the status least likely to be read as a
 * permanent application fault.
 */
function askMetaToRedeliver() {
  return NextResponse.json(
    { status: 'unavailable', detail: 'backend unreachable — retry' },
    { status: 503 },
  )
}

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
  // running the full fan-out in-process used to.
  //
  // WHAT HAPPENS WHEN THE FORWARD FAILS, AND WHY IT CHANGED. This used to
  // log the failure and ack 200 regardless — a deliberate
  // "fast unconditional ack" contract. The cost of that contract is total
  // and silent: Meta treats a 200 as delivered and never redelivers, so
  // every inbound message that arrives while Convex is unreachable is lost
  // with no queue, no dead-letter and no error anyone sees. Measured
  // against production traffic (466 inbound/day), a two-hour backend
  // outage at a busy hour silently destroys ~57 customer messages.
  //
  // A 5xx tells Meta to redeliver, which turns that permanent loss into a
  // delay. That matters routinely — any backend blip — and acutely during
  // the Boston -> Mumbai VPS migration, where the backend is deliberately
  // stopped for the cutover.
  //
  // The 4xx/5xx split is the load-bearing part. A 5xx (or an unreachable
  // host) means Convex never got to judge the payload, so the same bytes
  // may well succeed later. A 4xx means Convex DID receive it and rejected
  // it — a bad payload or a wrong proxy secret — and redelivering the
  // identical bytes just reproduces the rejection on Meta's retry
  // schedule. Those keep acking 200, exactly as before.
  //
  // The trade to be aware of: sustained 5xx can make Meta throttle or
  // disable a webhook subscription. That is a reason to keep any planned
  // outage short, not a reason to prefer silent data loss.
  try {
    const target = `${convexSiteUrl()}/whatsapp/ingest`
    const response = await fetch(target, {
      method: 'POST',
      headers: {
        ...proxySecretHeaders(),
        'content-type': 'application/json',
      },
      body: rawBody,
      // Fail fast rather than hanging until Meta's own ack timeout. With
      // no bound, an unreachable backend holds the connection open until
      // the platform kills it, which burns the ack window and lands Meta
      // on a generic gateway error instead of the deliberate 503 below.
      signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS),
    })
    if (!response.ok) {
      console.error(
        `[webhook proxy] Convex httpAction responded ${response.status}`,
      )
      if (response.status >= 500) return askMetaToRedeliver()
    }
  } catch (error) {
    // Network failure, DNS failure, or the timeout above.
    console.error('[webhook proxy] forward to Convex failed:', error)
    return askMetaToRedeliver()
  }

  return NextResponse.json({ status: 'received' }, { status: 200 })
}
