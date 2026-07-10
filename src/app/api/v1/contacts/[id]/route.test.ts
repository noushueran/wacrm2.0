import { describe, expect, it, vi } from 'vitest';

const requireApiKeyMock = vi.fn();
vi.mock('@/lib/auth/api-context', () => ({
  requireApiKey: (...args: unknown[]) => requireApiKeyMock(...args),
}));

const queryMock = vi.fn();
const mutationMock = vi.fn();
vi.mock('@/lib/convex/server-client', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/convex/server-client')>();
  return {
    ...actual,
    getConvexClient: () => ({ query: queryMock, mutation: mutationMock }),
  };
});

const { GET, PATCH, DELETE } = await import('./route');

function ctx() {
  return { authType: 'api_key', accountId: 'acct-1', keyHash: 'hash-1', scopes: [] };
}

function contactDoc(overrides: Record<string, unknown> = {}) {
  return {
    _id: 'c1',
    _creationTime: Date.parse('2026-01-01T00:00:00Z'),
    phone: '+1',
    name: 'Jane',
    tags: [],
    ...overrides,
  };
}

const paramsFor = (id: string) => ({ params: Promise.resolve({ id }) });

describe('GET /api/v1/contacts/{id}', () => {
  it('404s when Convex returns null', async () => {
    requireApiKeyMock.mockResolvedValue(ctx());
    queryMock.mockResolvedValue(null);
    const res = await GET(new Request('https://x.test'), paramsFor('c1'));
    expect(res.status).toBe(404);
  });

  it('200s the serialized contact on a match', async () => {
    requireApiKeyMock.mockResolvedValue(ctx());
    queryMock.mockResolvedValue(contactDoc());
    const res = await GET(new Request('https://x.test'), paramsFor('c1'));
    expect(res.status).toBe(200);
  });
});

describe('PATCH /api/v1/contacts/{id}', () => {
  it('forwards only the fields present in the body — omitted fields never appear in the Convex args', async () => {
    requireApiKeyMock.mockResolvedValue(ctx());
    mutationMock.mockResolvedValue(contactDoc({ name: 'Renamed' }));

    const res = await PATCH(
      new Request('https://x.test', { method: 'PATCH', body: JSON.stringify({ name: 'Renamed' }) }),
      paramsFor('c1')
    );
    expect(res.status).toBe(200);

    const sentArgs = mutationMock.mock.calls[0]![1] as Record<string, unknown>;
    expect('name' in sentArgs).toBe(true);
    expect('email' in sentArgs).toBe(false);
    expect('company' in sentArgs).toBe(false);
  });

  it('400s when a scalar field is neither a string nor null', async () => {
    requireApiKeyMock.mockResolvedValue(ctx());
    const res = await PATCH(
      new Request('https://x.test', { method: 'PATCH', body: JSON.stringify({ name: 42 }) }),
      paramsFor('c1')
    );
    expect(res.status).toBe(400);
    expect(mutationMock).not.toHaveBeenCalled();
  });

  it('404s when Convex returns null (foreign or missing contact)', async () => {
    requireApiKeyMock.mockResolvedValue(ctx());
    mutationMock.mockResolvedValue(null);
    const res = await PATCH(
      new Request('https://x.test', { method: 'PATCH', body: JSON.stringify({ name: 'X' }) }),
      paramsFor('c1')
    );
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/v1/contacts/{id}', () => {
  it('200s { id, deleted: true } on success, 404s on a null result', async () => {
    requireApiKeyMock.mockResolvedValue(ctx());
    mutationMock.mockResolvedValueOnce({ id: 'c1' });
    const ok = await DELETE(new Request('https://x.test', { method: 'DELETE' }), paramsFor('c1'));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ data: { id: 'c1', deleted: true } });

    mutationMock.mockResolvedValueOnce(null);
    const notFound = await DELETE(
      new Request('https://x.test', { method: 'DELETE' }),
      paramsFor('missing')
    );
    expect(notFound.status).toBe(404);
  });
});
