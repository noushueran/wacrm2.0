import { describe, expect, it, vi } from 'vitest';

const requireApiKeyMock = vi.fn();
vi.mock('@/lib/auth/api-context', () => ({
  requireApiKey: (...args: unknown[]) => requireApiKeyMock(...args),
}));

const actionMock = vi.fn();
vi.mock('@/lib/convex/server-client', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/convex/server-client')>();
  return {
    ...actual,
    getConvexClient: () => ({ action: actionMock }),
  };
});

const { POST } = await import('./route');

function ctx() {
  return { authType: 'api_key', accountId: 'acct-1', keyHash: 'hash-1', scopes: [] };
}

describe('POST /api/v1/broadcasts', () => {
  it('202s with the accepted/rejected counts and forwards recipients cleanly', async () => {
    requireApiKeyMock.mockResolvedValue(ctx());
    actionMock.mockResolvedValue({ broadcastId: 'b1', totalRecipients: 2, rejected: 1 });

    const res = await POST(
      new Request('https://x.test/api/v1/broadcasts', {
        method: 'POST',
        body: JSON.stringify({
          template_name: 'promo_july',
          recipients: [
            { to: '+14155550123', params: ['Jane'] },
            { to: '+14155550124' },
            { to: 123 }, // malformed — coerced to '' by the route, rejected by Convex
          ],
        }),
      })
    );

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({
      data: {
        broadcast_id: 'b1',
        status: 'sending',
        total_recipients: 2,
        accepted: 2,
        rejected: 1,
      },
    });

    const sentArgs = actionMock.mock.calls[0]![1] as { recipients: { to: string; params?: string[] }[] };
    expect(sentArgs.recipients).toEqual([
      { to: '+14155550123', params: ['Jane'] },
      { to: '+14155550124', params: undefined },
      { to: '', params: undefined },
    ]);
  });

  it('400s a non-object body before ever calling Convex', async () => {
    requireApiKeyMock.mockResolvedValue(ctx());
    const res = await POST(
      new Request('https://x.test/api/v1/broadcasts', { method: 'POST', body: 'null' })
    );
    expect(res.status).toBe(400);
    expect(actionMock).not.toHaveBeenCalled();
  });

  it('maps a Convex BAD_REQUEST (e.g. empty recipients) to the 400 envelope', async () => {
    requireApiKeyMock.mockResolvedValue(ctx());
    const { ConvexError } = await import('convex/values');
    actionMock.mockRejectedValue(
      new ConvexError({ code: 'BAD_REQUEST', message: "'recipients' must be a non-empty array of { to, params? }" })
    );

    const res = await POST(
      new Request('https://x.test/api/v1/broadcasts', {
        method: 'POST',
        body: JSON.stringify({ template_name: 'x', recipients: [] }),
      })
    );
    expect(res.status).toBe(400);
  });
});
