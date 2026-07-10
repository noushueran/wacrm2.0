import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// GET /api/whatsapp/media/[mediaId] — Convex port. This route now only
// bridges the caller's own Convex auth token (`convexAuthNextjsToken`)
// through to `api.whatsappConfig.fetchMedia` via a FRESH `ConvexHttpClient`
// per request — never the shared `getConvexClient()` singleton, since that
// instance is reused across concurrent requests and `.setAuth()` would leak
// one caller's identity onto another's. Both `convexAuthNextjsToken` and
// `ConvexHttpClient` are mocked here so no real Convex deployment or
// Supabase call is involved.
// ---------------------------------------------------------------------------

const tokenMock = vi.fn<() => Promise<string | undefined>>()
vi.mock('@convex-dev/auth/nextjs/server', () => ({
  convexAuthNextjsToken: () => tokenMock(),
}))

const actionMock = vi.fn()
const setAuthMock = vi.fn()
// `route.ts` calls `new ConvexHttpClient(...)`, so the mock must be
// usable as a constructor — a plain `function` (never an arrow
// function, which `new` rejects) that returns the fake client object.
const ConvexHttpClientMock = vi.fn(function ConvexHttpClient() {
  return { setAuth: setAuthMock, action: actionMock }
})
vi.mock('convex/browser', () => ({
  ConvexHttpClient: ConvexHttpClientMock,
}))

const { GET } = await import('./route')

function req(mediaId: string) {
  return GET(new Request(`http://localhost/api/whatsapp/media/${mediaId}`), {
    params: Promise.resolve({ mediaId }),
  })
}

describe('GET /api/whatsapp/media/[mediaId]', () => {
  beforeEach(() => {
    tokenMock.mockReset()
    actionMock.mockReset()
    setAuthMock.mockReset()
    ConvexHttpClientMock.mockClear()
    process.env.NEXT_PUBLIC_CONVEX_URL = 'https://example.convex.cloud'
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('400s when mediaId is missing', async () => {
    const res = await req('')
    expect(res.status).toBe(400)
    expect(tokenMock).not.toHaveBeenCalled()
  })

  it('401s when there is no Convex auth token, without ever calling the action', async () => {
    tokenMock.mockResolvedValue(undefined)

    const res = await req('media-1')

    expect(res.status).toBe(401)
    expect(actionMock).not.toHaveBeenCalled()
  })

  it('sets the caller token on a FRESH client and streams the bytes + content type fetchMedia returns', async () => {
    tokenMock.mockResolvedValue('token-abc')
    const bytes = new Uint8Array([1, 2, 3, 4]).buffer
    actionMock.mockResolvedValue({ data: bytes, contentType: 'image/png' })

    const res = await req('media-1')

    // A new client per request — never the shared singleton.
    expect(ConvexHttpClientMock).toHaveBeenCalledTimes(1)
    expect(ConvexHttpClientMock).toHaveBeenCalledWith('https://example.convex.cloud')
    expect(setAuthMock).toHaveBeenCalledWith('token-abc')
    expect(actionMock).toHaveBeenCalledTimes(1)
    const [fnRef, args] = actionMock.mock.calls[0] as [unknown, { mediaId: string }]
    expect(args).toEqual({ mediaId: 'media-1' })
    expect(fnRef).toBeDefined()

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('image/png')
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=86400')
    const buf = await res.arrayBuffer()
    expect(new Uint8Array(buf)).toEqual(new Uint8Array([1, 2, 3, 4]))
  })

  it('500s when fetchMedia throws (e.g. FORBIDDEN, NO_ACCOUNT, or no config)', async () => {
    tokenMock.mockResolvedValue('token-abc')
    actionMock.mockRejectedValue(new Error('WhatsApp not configured for this account'))

    const res = await req('media-1')

    expect(res.status).toBe(500)
    const json = await res.json()
    expect(json.error).toBe('Failed to fetch media')
  })
})
