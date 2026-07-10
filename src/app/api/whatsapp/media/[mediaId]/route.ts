import { NextResponse } from 'next/server'
import { ConvexHttpClient } from 'convex/browser'
import { convexAuthNextjsToken } from '@convex-dev/auth/nextjs/server'
import { api } from '@/lib/convex/server-client'

// Inbound-media proxy — the browser can't hold the decrypted WhatsApp
// access token (message-bubble.tsx just wants an authenticated blob
// URL), so this route stays server-side. All the account/config/
// decrypt work that used to happen here via Supabase now happens
// inside Convex's `whatsappConfig.fetchMedia` action, along with the
// Meta round-trip itself — this route's only remaining job is to
// bridge the caller's own Convex auth token through and stream back
// the bytes the action returns. The decrypted token never crosses
// back out to Next.js.
//
// A FRESH `ConvexHttpClient` per request — deliberately NOT the shared
// `getConvexClient()` singleton from `@/lib/convex/server-client`,
// which is reused across concurrent requests in this server process.
// Calling `.setAuth()` on that shared instance would leak one caller's
// identity onto another's concurrent request.
export async function GET(
  request: Request,
  { params }: { params: Promise<{ mediaId: string }> }
) {
  try {
    const { mediaId } = await params

    if (!mediaId) {
      return NextResponse.json(
        { error: 'Media ID is required' },
        { status: 400 }
      )
    }

    const token = await convexAuthNextjsToken()
    if (!token) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      )
    }

    const client = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!)
    client.setAuth(token)

    const result = await client.action(api.whatsappConfig.fetchMedia, {
      mediaId,
    })

    return new Response(new Uint8Array(result.data), {
      status: 200,
      headers: {
        'Content-Type': result.contentType,
        'Cache-Control': 'public, max-age=86400',
      },
    })
  } catch (error) {
    console.error('Error in WhatsApp media GET:', error)
    return NextResponse.json(
      { error: 'Failed to fetch media' },
      { status: 500 }
    )
  }
}
