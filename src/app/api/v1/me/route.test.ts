import { describe, expect, it, vi } from 'vitest';

const requireApiKeyMock = vi.fn();
vi.mock('@/lib/auth/api-context', () => ({
  requireApiKey: (...args: unknown[]) => requireApiKeyMock(...args),
}));

const queryMock = vi.fn();
vi.mock('@/lib/convex/server-client', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/convex/server-client')>();
  return {
    ...actual,
    getConvexClient: () => ({ query: queryMock }),
  };
});

const { GET } = await import('./route');

describe('GET /api/v1/me', () => {
  it('requires no scope, and maps the Convex result to { account, key }', async () => {
    requireApiKeyMock.mockResolvedValue({
      authType: 'api_key',
      accountId: 'acct-1',
      keyHash: 'hash-1',
      scopes: ['messages:send'],
    });
    queryMock.mockResolvedValue({
      accountId: 'acct-1',
      accountName: 'Acme Inc',
      keyId: 'key-1',
      scopes: ['messages:send'],
    });

    const res = await GET(new Request('https://x.test/api/v1/me'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: {
        account: { id: 'acct-1', name: 'Acme Inc' },
        key: { id: 'key-1', scopes: ['messages:send'] },
      },
    });

    // No scope argument passed to requireApiKey.
    expect(requireApiKeyMock).toHaveBeenCalledWith(expect.anything());
  });

  it('maps an unauthorized failure straight through (no Convex call)', async () => {
    const { unauthorized } = await import('@/lib/api/v1/respond');
    requireApiKeyMock.mockRejectedValue(unauthorized());

    const res = await GET(new Request('https://x.test/api/v1/me'));
    expect(res.status).toBe(401);
    expect(queryMock).not.toHaveBeenCalled();
  });
});
