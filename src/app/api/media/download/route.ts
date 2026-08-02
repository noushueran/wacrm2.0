import { NextResponse } from 'next/server'
import { convexAuthNextjsToken } from '@convex-dev/auth/nextjs/server'

// Same-origin download endpoint for inbox media.
//
// Inbound media lives on the public Cloudflare R2 host, which is a
// DIFFERENT ORIGIN from the CRM. That makes it unsaveable from the client
// alone: the browser ignores `<a download>` cross-origin, and a
// `fetch()`→blob download needs `Access-Control-Allow-Origin` on the GET,
// which the bucket's CORS policy does not promise (it covers the `PUT`
// upload path only). So the bytes come back through here, re-served with a
// `Content-Disposition: attachment` header the browser will honour.
// See `src/lib/media/download.ts` for the client half.
//
// This route fetches a CALLER-SUPPLIED url server-side, which is an SSRF
// primitive if left open. Two things contain it:
//
//   1. It requires the caller's own Convex auth token. The R2 host is
//      already public, so this grants no new read access — it stops the
//      CRM being an anonymously usable proxy.
//   2. The target's origin must match one of a small, env-derived
//      allowlist EXACTLY (not a prefix/suffix test, which
//      `objs.example.com.evil.net` would defeat). An unset allowlist
//      denies everything rather than allowing everything, and redirects
//      are never followed — a 3xx from an allowlisted host could
//      otherwise hop to an internal address.

/** Origins whose bytes this route is willing to re-serve. */
function allowedOrigins(): Set<string> {
  const origins = new Set<string>()
  for (const raw of [
    process.env.NEXT_PUBLIC_R2_PUBLIC_HOST,
    // Pre-R2 rows still carry absolute Supabase Storage urls; without this
    // their media would stay undownloadable after the cutover.
    process.env.NEXT_PUBLIC_SUPABASE_URL,
  ]) {
    if (!raw) continue
    try {
      origins.add(new URL(raw).origin)
    } catch {
      // A malformed env value must not widen the allowlist — skip it.
    }
  }
  return origins
}

function isAllowed(target: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(target)
  } catch {
    return false
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false
  return allowedOrigins().has(parsed.origin)
}

/**
 * Make a caller-supplied name safe to put in a response header and safe for
 * the browser to write to disk: no directory component, no control
 * characters, no quotes, bounded length.
 */
function sanitizeFilename(raw: string | null): string {
  const base = (raw ?? '')
    .split(/[\\/]/)
    .pop()
    // eslint-disable-next-line no-control-regex
    ?.replace(/[\x00-\x1f\x7f"]/g, '')
    .trim()
  if (!base) return 'download'
  return base.slice(0, 120)
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const target = searchParams.get('url')

  if (!target) {
    return NextResponse.json({ error: 'url is required' }, { status: 400 })
  }

  // Auth BEFORE the allowlist check so an unauthenticated caller learns
  // nothing about which hosts are configured.
  const token = await convexAuthNextjsToken()
  if (!token) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  if (!isAllowed(target)) {
    return NextResponse.json(
      { error: 'url host is not allowed' },
      { status: 400 }
    )
  }

  const filename = sanitizeFilename(searchParams.get('name'))

  let upstream: Response
  try {
    // `redirect: 'manual'` is load-bearing: following a redirect would let
    // an allowlisted host hand us an arbitrary internal target.
    upstream = await fetch(target, { redirect: 'manual' })
  } catch (error) {
    console.error('Error fetching media for download:', error)
    return NextResponse.json({ error: 'Failed to fetch media' }, { status: 502 })
  }

  if (!upstream.ok) {
    // A 3xx lands here too (see `redirect: 'manual'` above) and is reported
    // as a bad gateway — statuses below 400 cannot carry a response body.
    return NextResponse.json(
      { error: 'Failed to fetch media' },
      { status: upstream.status >= 400 ? upstream.status : 502 }
    )
  }

  const headers = new Headers({
    'Content-Type':
      upstream.headers.get('Content-Type') ?? 'application/octet-stream',
    // RFC 5987 form only. Every browser in support today reads `filename*`,
    // and a second quoted `filename=` would only add a place for an
    // awkward character to break the header.
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
    // Media keys are content-addressed, so the bytes never change — but the
    // response is behind auth, so keep it out of shared caches.
    'Cache-Control': 'private, max-age=3600',
  })
  const length = upstream.headers.get('Content-Length')
  if (length) headers.set('Content-Length', length)

  // Stream rather than buffer: a video should not be held in server memory.
  return new Response(upstream.body, { status: 200, headers })
}
