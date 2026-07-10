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

const { GET, POST } = await import('./route');

function ctx(overrides: Partial<{ keyHash: string }> = {}) {
  return { authType: 'api_key', accountId: 'acct-1', keyHash: 'hash-1', scopes: [], ...overrides };
}

function contactDoc(overrides: Record<string, unknown> = {}) {
  return {
    _id: 'c1',
    _creationTime: Date.parse('2026-01-01T00:00:00Z'),
    phone: '+14155550123',
    name: 'Jane',
    tags: [],
    ...overrides,
  };
}

describe('GET /api/v1/contacts', () => {
  it('forwards limit/cursor/search/tag to api.apiV1.listContacts and serializes the page', async () => {
    requireApiKeyMock.mockResolvedValue(ctx());
    queryMock.mockResolvedValue({ items: [contactDoc()], nextCursor: 'abc' });

    const res = await GET(
      new Request('https://x.test/api/v1/contacts?limit=10&search=jane&tag=t1')
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[]; meta: { next_cursor: string | null } };
    expect(body.data).toHaveLength(1);
    expect(body.meta.next_cursor).toBe('abc');

    expect(queryMock).toHaveBeenCalledWith(expect.anything(), {
      keyHash: 'hash-1',
      limit: 10,
      cursor: undefined,
      search: 'jane',
      tag: 't1',
    });
  });
});

describe('POST /api/v1/contacts', () => {
  it('400s on a missing phone before ever calling Convex', async () => {
    requireApiKeyMock.mockResolvedValue(ctx());
    const res = await POST(
      new Request('https://x.test/api/v1/contacts', {
        method: 'POST',
        body: JSON.stringify({}),
      })
    );
    expect(res.status).toBe(400);
    expect(mutationMock).not.toHaveBeenCalled();
  });

  it('201s a newly-created contact, 200s an existing match', async () => {
    requireApiKeyMock.mockResolvedValue(ctx());

    mutationMock.mockResolvedValueOnce({ contact: contactDoc(), created: true });
    const created = await POST(
      new Request('https://x.test/api/v1/contacts', {
        method: 'POST',
        body: JSON.stringify({ phone: '+14155550123', tags: ['VIP'] }),
      })
    );
    expect(created.status).toBe(201);
    expect(mutationMock).toHaveBeenCalledWith(expect.anything(), {
      keyHash: 'hash-1',
      phone: '+14155550123',
      name: undefined,
      email: undefined,
      company: undefined,
      tags: ['VIP'],
    });

    mutationMock.mockResolvedValueOnce({ contact: contactDoc(), created: false });
    const matched = await POST(
      new Request('https://x.test/api/v1/contacts', {
        method: 'POST',
        body: JSON.stringify({ phone: '+14155550123' }),
      })
    );
    expect(matched.status).toBe(200);
  });

  it('maps a Convex FORBIDDEN error to a 403 envelope', async () => {
    requireApiKeyMock.mockResolvedValue(ctx());
    const { ConvexError } = await import('convex/values');
    mutationMock.mockRejectedValue(new ConvexError({ code: 'FORBIDDEN', scope: 'contacts:write' }));

    const res = await POST(
      new Request('https://x.test/api/v1/contacts', {
        method: 'POST',
        body: JSON.stringify({ phone: '+14155550123' }),
      })
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('forbidden');
  });
});
