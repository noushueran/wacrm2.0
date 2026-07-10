import { describe, it, expect } from 'vitest';
import { serializeWebhookEndpoint, type ConvexApiWebhookEndpoint } from './endpoints';

describe('serializeWebhookEndpoint', () => {
  it('projects public fields from a Convex doc and never leaks a secret', () => {
    const doc: ConvexApiWebhookEndpoint = {
      _id: 'w1',
      _creationTime: Date.parse('2026-01-01T00:00:00Z'),
      url: 'https://example.com/hook',
      events: ['message.received'],
      isActive: true,
      failureCount: 0,
    };
    const out = serializeWebhookEndpoint(doc);
    expect(out).not.toHaveProperty('secret');
    expect(out).toEqual({
      id: 'w1',
      url: 'https://example.com/hook',
      events: ['message.received'],
      is_active: true,
      last_delivery_at: null,
      failure_count: 0,
      created_at: '2026-01-01T00:00:00.000Z',
    });
  });

  it('formats a present lastDeliveryAt as an ISO string', () => {
    const doc: ConvexApiWebhookEndpoint = {
      _id: 'w2',
      _creationTime: Date.parse('2026-01-01T00:00:00Z'),
      url: 'https://example.com/hook',
      events: ['message.received'],
      isActive: false,
      failureCount: 3,
      lastDeliveryAt: Date.parse('2026-01-05T00:00:00Z'),
    };
    const out = serializeWebhookEndpoint(doc);
    expect(out.last_delivery_at).toBe('2026-01-05T00:00:00.000Z');
    expect(out.is_active).toBe(false);
    expect(out.failure_count).toBe(3);
  });
});
