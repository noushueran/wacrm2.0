import { describe, it, expect } from 'vitest';
import { serializeBroadcast, type ConvexApiBroadcast } from './broadcasts';

describe('serializeBroadcast', () => {
  it('projects a Convex broadcast doc onto the public shape', () => {
    const doc: ConvexApiBroadcast = {
      _id: 'b1',
      _creationTime: Date.parse('2026-01-01T00:00:00Z'),
      name: 'July promo',
      templateName: 'promo_july',
      templateLanguage: 'en_US',
      status: 'sending',
      totalRecipients: 10,
      sentCount: 3,
      deliveredCount: 2,
      readCount: 1,
      repliedCount: 0,
      failedCount: 1,
    };
    expect(serializeBroadcast(doc)).toEqual({
      id: 'b1',
      name: 'July promo',
      template_name: 'promo_july',
      template_language: 'en_US',
      status: 'sending',
      total_recipients: 10,
      sent_count: 3,
      delivered_count: 2,
      read_count: 1,
      replied_count: 0,
      failed_count: 1,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    });
  });

  it('uses updatedAt when present instead of falling back to created_at', () => {
    const doc: ConvexApiBroadcast = {
      _id: 'b2',
      _creationTime: Date.parse('2026-01-01T00:00:00Z'),
      name: 'x',
      templateName: 'x',
      templateLanguage: 'en_US',
      status: 'sent',
      totalRecipients: 1,
      sentCount: 1,
      deliveredCount: 0,
      readCount: 0,
      repliedCount: 0,
      failedCount: 0,
      updatedAt: Date.parse('2026-01-02T00:00:00Z'),
    };
    expect(serializeBroadcast(doc).updated_at).toBe('2026-01-02T00:00:00.000Z');
  });
});
