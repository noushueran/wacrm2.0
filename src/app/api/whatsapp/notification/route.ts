import { NextResponse } from 'next/server'
import { ConvexHttpClient } from 'convex/browser'
import { convexAuthNextjsToken } from '@convex-dev/auth/nextjs/server'
import { api } from '@/lib/convex/server-client'
import type { Id } from '../../../../../convex/_generated/dataModel'

// Acts on a notification the user answered from the OS shade, without
// opening the app.
//
// The service worker cannot talk to Convex directly — it has no Convex
// client and no way to hold a session — but it CAN make a same-origin
// `fetch` with cookies. So this route is the bridge: it takes the
// caller's own Convex auth token and performs the action as them. It
// grants no authority of its own. Every authorization decision still
// happens inside Convex (`requireConversationAccess`), so a stale
// notification for a conversation since reassigned to a colleague fails
// there exactly as it would in the UI.
//
// Reached only from `public/sw.js`'s `notificationclick` handler.
//
// A FRESH `ConvexHttpClient` per request — deliberately NOT the shared
// `getConvexClient()` singleton, which is reused across concurrent
// requests in this server process; calling `.setAuth()` on that shared
// instance would leak one caller's identity onto another's. Same rule
// as the media proxy beside this route.

/** Matches the Cloud API's own text ceiling. A notification reply that
 *  exceeds it would be rejected by Meta anyway; failing here keeps a
 *  pointless round-trip off the wire. */
const MAX_REPLY_LENGTH = 4096

type Body = {
  action?: unknown
  conversationId?: unknown
  text?: unknown
}

export async function POST(request: Request) {
  try {
    // CSRF guard. This is a state-changing POST authenticated purely by
    // cookie, so a cross-site form post would otherwise be able to send
    // a WhatsApp message as the signed-in agent. The service worker is
    // same-origin by construction, so requiring that costs nothing.
    // `Origin` is sent on every cross-origin POST by every browser that
    // can run a service worker, so a MISSING origin is not a hole worth
    // failing closed on (some same-origin fetches omit it); a PRESENT
    // one that disagrees is.
    const origin = request.headers.get('origin')
    if (origin && origin !== new URL(request.url).origin) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    let body: Body
    try {
      body = (await request.json()) as Body
    } catch {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
    }

    const { action, conversationId, text } = body

    if (typeof conversationId !== 'string' || conversationId.length === 0) {
      return NextResponse.json(
        { error: 'conversationId is required' },
        { status: 400 }
      )
    }
    if (action !== 'reply' && action !== 'read') {
      return NextResponse.json(
        { error: 'action must be "reply" or "read"' },
        { status: 400 }
      )
    }

    // Validated BEFORE authenticating, so a malformed request is cheap
    // and never reaches Convex.
    let reply = ''
    if (action === 'reply') {
      if (typeof text !== 'string') {
        return NextResponse.json(
          { error: 'text is required to reply' },
          { status: 400 }
        )
      }
      reply = text.trim()
      if (reply.length === 0) {
        // An empty inline reply is a slip, not an instruction to send a
        // blank message to a customer.
        return NextResponse.json({ error: 'text is empty' }, { status: 400 })
      }
      if (reply.length > MAX_REPLY_LENGTH) {
        return NextResponse.json({ error: 'text is too long' }, { status: 413 })
      }
    }

    const token = await convexAuthNextjsToken()
    if (!token) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const client = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!)
    client.setAuth(token)

    if (action === 'read') {
      await client.mutation(api.conversations.markRead, {
        conversationId: conversationId as Id<'conversations'>,
      })
      return NextResponse.json({ ok: true })
    }

    await client.action(api.send.send, {
      conversationId: conversationId as Id<'conversations'>,
      messageType: 'text',
      contentText: reply,
    })
    return NextResponse.json({ ok: true })
  } catch (error) {
    console.error('Error in WhatsApp notification action POST:', error)
    return NextResponse.json(
      { error: 'Failed to act on notification' },
      { status: 500 }
    )
  }
}
