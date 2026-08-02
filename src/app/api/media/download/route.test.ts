import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// GET /api/media/download — the same-origin download endpoint.
//
// Inbox media lives on a CROSS-ORIGIN R2 host, where the browser ignores
// `<a download>` and a blob fetch has no GET CORS to rely on, so saving a
// file has to come back through here with a `Content-Disposition` header
// (see the design doc dated 2026-08-02).
//
// The security-critical behaviour is the origin allowlist: this route
// fetches a caller-supplied url server-side, so anything not on the
// allowlist must be rejected BEFORE any outbound request happens. Several
// tests below assert `fetchMock` was never called for exactly that reason.
// ---------------------------------------------------------------------------

const tokenMock = vi.fn<() => Promise<string | undefined>>()
vi.mock('@convex-dev/auth/nextjs/server', () => ({
  convexAuthNextjsToken: () => tokenMock(),
}))

const { GET } = await import('./route')

const R2_HOST = 'https://objs.example.com'
const SUPABASE_URL = 'https://proj.supabase.co'

const fetchMock = vi.fn<typeof fetch>()

function req(params: Record<string, string>) {
  const qs = new URLSearchParams(params).toString()
  return GET(new Request(`http://localhost/api/media/download?${qs}`))
}

/** An upstream 200 carrying `body` as `type`. */
function upstreamOk(body = 'IMAGE-BYTES', type = 'image/jpeg') {
  return new Response(body, { status: 200, headers: { 'Content-Type': type } })
}

describe('GET /api/media/download', () => {
  beforeEach(() => {
    tokenMock.mockReset()
    tokenMock.mockResolvedValue('token-abc')
    fetchMock.mockReset()
    fetchMock.mockResolvedValue(upstreamOk())
    vi.stubGlobal('fetch', fetchMock)
    process.env.NEXT_PUBLIC_R2_PUBLIC_HOST = R2_HOST
    process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('401s when there is no Convex auth token, without fetching anything', async () => {
    tokenMock.mockResolvedValue(undefined)

    const res = await req({ url: `${R2_HOST}/a/in/x.jpg`, name: 'x.jpg' })

    expect(res.status).toBe(401)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('400s when the url parameter is missing', async () => {
    const res = await req({ name: 'x.jpg' })

    expect(res.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  // --- SSRF guard ---------------------------------------------------------

  it('400s for a host that is not on the allowlist, without fetching it', async () => {
    const res = await req({
      url: 'https://evil.example.net/steal',
      name: 'x.jpg',
    })

    expect(res.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('400s for a link-local address, without fetching it', async () => {
    // The classic cloud-metadata SSRF target.
    const res = await req({
      url: 'http://169.254.169.254/latest/meta-data/',
      name: 'x',
    })

    expect(res.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('400s for a non-http scheme, without fetching it', async () => {
    const res = await req({ url: 'file:///etc/passwd', name: 'x' })

    expect(res.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('400s for an unparseable url, without fetching it', async () => {
    const res = await req({ url: 'not a url', name: 'x' })

    expect(res.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('400s for a host that merely has the allowlisted host as a suffix', async () => {
    // `objs.example.com.evil.net` must not pass a naive `endsWith` check.
    const res = await req({
      url: 'https://objs.example.com.evil.net/x.jpg',
      name: 'x.jpg',
    })

    expect(res.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('400s when the R2 host is not configured, rather than allowing everything', async () => {
    delete process.env.NEXT_PUBLIC_R2_PUBLIC_HOST
    delete process.env.NEXT_PUBLIC_SUPABASE_URL

    const res = await req({ url: `${R2_HOST}/a/in/x.jpg`, name: 'x.jpg' })

    expect(res.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  // --- Happy path ---------------------------------------------------------

  it('streams an allowlisted R2 object back as an attachment', async () => {
    const res = await req({
      url: `${R2_HOST}/a/in/deadbeef.jpg`,
      name: 'whatsapp-image-2026-08-02.jpg',
    })

    expect(res.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`${R2_HOST}/a/in/deadbeef.jpg`)
    expect(res.headers.get('Content-Type')).toBe('image/jpeg')
    expect(res.headers.get('Content-Disposition')).toContain('attachment')
    expect(res.headers.get('Content-Disposition')).toContain(
      "filename*=UTF-8''whatsapp-image-2026-08-02.jpg",
    )
    await expect(res.text()).resolves.toBe('IMAGE-BYTES')
  })

  it('allows the legacy Supabase storage host', async () => {
    const res = await req({
      url: `${SUPABASE_URL}/storage/v1/object/public/media/old.png`,
      name: 'old.png',
    })

    expect(res.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('passes the upstream content type through', async () => {
    fetchMock.mockResolvedValue(upstreamOk('PDF-BYTES', 'application/pdf'))

    const res = await req({ url: `${R2_HOST}/a/d/x.pdf`, name: 'quote.pdf' })

    expect(res.headers.get('Content-Type')).toBe('application/pdf')
  })

  it('relays an upstream failure instead of reporting success', async () => {
    fetchMock.mockResolvedValue(new Response('nope', { status: 404 }))

    const res = await req({ url: `${R2_HOST}/a/in/gone.jpg`, name: 'x.jpg' })

    expect(res.status).toBe(404)
  })

  it('502s when the upstream fetch throws', async () => {
    fetchMock.mockRejectedValue(new Error('socket hang up'))

    const res = await req({ url: `${R2_HOST}/a/in/x.jpg`, name: 'x.jpg' })

    expect(res.status).toBe(502)
  })

  // --- Filename sanitisation ---------------------------------------------
  // `name` reaches us from a customer-controlled document label, and lands
  // in a response header. It must not be able to inject header syntax or a
  // path.

  it('strips a path out of the requested filename', async () => {
    const res = await req({
      url: `${R2_HOST}/a/d/x.pdf`,
      name: '../../etc/passwd',
    })

    const disposition = res.headers.get('Content-Disposition') ?? ''
    expect(disposition).toContain("filename*=UTF-8''passwd")
    expect(disposition).not.toContain('..')
  })

  it('strips quotes and control characters that would break the header', async () => {
    const res = await req({
      url: `${R2_HOST}/a/d/x.pdf`,
      name: 'a"b\r\nX-Injected: 1.pdf',
    })

    const disposition = res.headers.get('Content-Disposition') ?? ''
    expect(disposition).not.toContain('"')
    expect(disposition).not.toContain('\r')
    expect(disposition).not.toContain('\n')
    expect(res.headers.get('X-Injected')).toBeNull()
  })

  it('percent-encodes a non-ASCII filename', async () => {
    const res = await req({ url: `${R2_HOST}/a/d/x.pdf`, name: 'عرض.pdf' })

    const disposition = res.headers.get('Content-Disposition') ?? ''
    expect(disposition).toContain("filename*=UTF-8''")
    // Encoded, not raw — a raw non-ASCII byte in a header is invalid.
    expect(disposition).toContain(encodeURIComponent('عرض'))
  })

  it('falls back to a safe name when the requested one sanitises to nothing', async () => {
    const res = await req({ url: `${R2_HOST}/a/d/x.pdf`, name: '///' })

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Disposition')).toContain(
      "filename*=UTF-8''download",
    )
  })

  it('defaults the filename when none is supplied', async () => {
    const res = await req({ url: `${R2_HOST}/a/d/x.pdf` })

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Disposition')).toContain('attachment')
  })
})
