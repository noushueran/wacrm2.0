import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// POST /api/whatsapp/notification — the bridge the service worker uses to act
// on a shade notification (inline Reply / Mark read) without opening the app.
//
// It is the only route in the app that can send a WhatsApp message to a real
// customer while authenticated purely by cookie, so most of what is asserted
// here is what it REFUSES: a cross-origin caller, an unauthenticated one, an
// empty or oversized reply, an unknown action. Authorization proper still
// happens inside Convex; these are the guards in front of it.
//
// Both `convexAuthNextjsToken` and `ConvexHttpClient` are mocked, so no real
// Convex deployment is involved.
// ---------------------------------------------------------------------------

const tokenMock = vi.fn<() => Promise<string | undefined>>()
vi.mock('@convex-dev/auth/nextjs/server', () => ({
  convexAuthNextjsToken: () => tokenMock(),
}))

const actionMock = vi.fn()
const mutationMock = vi.fn()
const setAuthMock = vi.fn()
// Must be usable as a constructor, so a plain `function`, never an arrow.
const ConvexHttpClientMock = vi.fn(function ConvexHttpClient() {
  return { setAuth: setAuthMock, action: actionMock, mutation: mutationMock }
})
vi.mock('convex/browser', () => ({
  ConvexHttpClient: ConvexHttpClientMock,
}))

const { POST } = await import('./route')

const URL_ = 'http://localhost/api/whatsapp/notification'

function post(body: unknown, headers: Record<string, string> = {}) {
  return POST(
    new Request(URL_, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    })
  )
}

describe('POST /api/whatsapp/notification', () => {
  beforeEach(() => {
    tokenMock.mockReset()
    actionMock.mockReset()
    mutationMock.mockReset()
    setAuthMock.mockReset()
    ConvexHttpClientMock.mockClear()
    tokenMock.mockResolvedValue('tok')
    process.env.NEXT_PUBLIC_CONVEX_URL = 'https://example.convex.cloud'
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  describe('what it refuses', () => {
    it('403s a cross-origin POST — cookie auth alone would otherwise be CSRF-able', async () => {
      const res = await post(
        { action: 'reply', conversationId: 'c1', text: 'hi' },
        { origin: 'https://evil.example' }
      )
      expect(res.status).toBe(403)
      expect(actionMock).not.toHaveBeenCalled()
      expect(tokenMock).not.toHaveBeenCalled()
    })

    it('allows a same-origin POST', async () => {
      const res = await post(
        { action: 'read', conversationId: 'c1' },
        { origin: 'http://localhost' }
      )
      expect(res.status).toBe(200)
    })

    it('401s without a session, never reaching Convex', async () => {
      tokenMock.mockResolvedValue(undefined)
      const res = await post({ action: 'read', conversationId: 'c1' })
      expect(res.status).toBe(401)
      expect(mutationMock).not.toHaveBeenCalled()
    })

    it('400s on malformed JSON', async () => {
      const res = await post('{not json')
      expect(res.status).toBe(400)
    })

    it('400s without a conversationId', async () => {
      expect((await post({ action: 'read' })).status).toBe(400)
      expect((await post({ action: 'read', conversationId: '' })).status).toBe(400)
    })

    it('400s on an unknown action', async () => {
      const res = await post({ action: 'delete', conversationId: 'c1' })
      expect(res.status).toBe(400)
      expect(actionMock).not.toHaveBeenCalled()
    })

    it('refuses an empty reply rather than sending a blank message to a customer', async () => {
      for (const text of ['', '   ', '\n']) {
        const res = await post({ action: 'reply', conversationId: 'c1', text })
        expect(res.status).toBe(400)
      }
      expect(actionMock).not.toHaveBeenCalled()
    })

    it('413s a reply past the Cloud API text ceiling', async () => {
      const res = await post({
        action: 'reply',
        conversationId: 'c1',
        text: 'x'.repeat(4097),
      })
      expect(res.status).toBe(413)
      expect(actionMock).not.toHaveBeenCalled()
    })

    it('validates before authenticating, so junk never costs a token lookup', async () => {
      await post({ action: 'nope', conversationId: 'c1' })
      expect(tokenMock).not.toHaveBeenCalled()
    })
  })

  describe('what it does', () => {
    it('sends the reply as the caller, on a fresh client', async () => {
      const res = await post({
        action: 'reply',
        conversationId: 'c1',
        text: '  on my way  ',
      })
      expect(res.status).toBe(200)
      expect(setAuthMock).toHaveBeenCalledWith('tok')
      // A fresh client per request — the shared singleton is reused across
      // concurrent requests and `.setAuth()` on it would leak one caller's
      // identity onto another's.
      expect(ConvexHttpClientMock).toHaveBeenCalledTimes(1)
      expect(actionMock.mock.calls[0][1]).toMatchObject({
        conversationId: 'c1',
        messageType: 'text',
        contentText: 'on my way',
      })
    })

    it('marks read via a mutation, sending nothing to the customer', async () => {
      const res = await post({ action: 'read', conversationId: 'c1' })
      expect(res.status).toBe(200)
      expect(mutationMock).toHaveBeenCalledTimes(1)
      expect(actionMock).not.toHaveBeenCalled()
    })

    it('500s when Convex rejects — e.g. a conversation since reassigned', async () => {
      actionMock.mockRejectedValue(new Error('NOT_FOUND'))
      const res = await post({ action: 'reply', conversationId: 'c1', text: 'hi' })
      expect(res.status).toBe(500)
    })
  })
})
