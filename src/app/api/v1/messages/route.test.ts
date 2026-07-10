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

function req(body: unknown): Request {
  return new Request('https://x.test/api/v1/messages', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

describe('POST /api/v1/messages', () => {
  it('400s a missing "to" before ever calling Convex', async () => {
    requireApiKeyMock.mockResolvedValue(ctx());
    const res = await POST(req({ type: 'text', text: 'hi' }));
    expect(res.status).toBe(400);
    expect(actionMock).not.toHaveBeenCalled();
  });

  it('400s a structured template.params object instead of forwarding it', async () => {
    requireApiKeyMock.mockResolvedValue(ctx());
    const res = await POST(
      req({
        to: '+14155550123',
        type: 'template',
        template: { name: 'x', params: { body: ['A'] } },
      })
    );
    expect(res.status).toBe(400);
    expect(actionMock).not.toHaveBeenCalled();
  });

  it('sends a text message and maps the Convex result to the wire envelope', async () => {
    requireApiKeyMock.mockResolvedValue(ctx());
    actionMock.mockResolvedValue({
      messageId: 'm1',
      whatsappMessageId: 'wamid.1',
      conversationId: 'conv1',
      contactId: 'c1',
      contactCreated: true,
    });

    const res = await POST(req({ to: '+14155550123', type: 'text', text: 'Hi there' }));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      data: {
        message_id: 'm1',
        whatsapp_message_id: 'wamid.1',
        conversation_id: 'conv1',
        contact_id: 'c1',
        contact_created: true,
      },
    });
    expect(actionMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ keyHash: 'hash-1', to: '+14155550123', type: 'text', text: 'Hi there' })
    );
  });

  it('forwards positional template.params as an array', async () => {
    requireApiKeyMock.mockResolvedValue(ctx());
    actionMock.mockResolvedValue({
      messageId: 'm2',
      whatsappMessageId: 'wamid.2',
      conversationId: 'conv1',
      contactId: 'c1',
      contactCreated: false,
    });

    await POST(
      req({
        to: '+14155550123',
        type: 'template',
        template: { name: 'order_update', language: 'en_US', params: ['A123'] },
      })
    );

    const sentArgs = actionMock.mock.calls[0]![1] as { template?: { name: string; params?: string[] } };
    expect(sentArgs.template).toEqual({ name: 'order_update', language: 'en_US', params: ['A123'] });
  });

  it('maps a Convex BAD_REQUEST error to the 400 envelope', async () => {
    requireApiKeyMock.mockResolvedValue(ctx());
    const { ConvexError } = await import('convex/values');
    actionMock.mockRejectedValue(
      new ConvexError({ code: 'BAD_REQUEST', message: 'media_url is required for media messages' })
    );

    const res = await POST(req({ to: '+14155550123', type: 'image' }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe('media_url is required for media messages');
  });
});
