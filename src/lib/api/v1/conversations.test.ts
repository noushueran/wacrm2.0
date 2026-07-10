import { describe, it, expect } from 'vitest';
import {
  serializeConversation,
  serializeMessage,
  type ConvexApiConversation,
  type ConvexApiMessage,
} from './conversations';

describe('serializeConversation', () => {
  it('projects public fields + nested contact/tags from a Convex doc', () => {
    const conv: ConvexApiConversation = {
      _id: 'conv1',
      _creationTime: Date.parse('2026-01-01T00:00:00Z'),
      contactId: 'c1',
      status: 'open',
      lastMessageText: 'hi',
      lastMessageAt: Date.parse('2026-01-01T00:00:00Z'),
      unreadCount: 2,
      contact: {
        _id: 'c1',
        phone: '+1',
        name: 'Jane',
        tags: [{ _id: 't1', name: 'vip', color: '#fff' }],
      },
    };

    const out = serializeConversation(conv);
    expect(out.id).toBe('conv1');
    expect(out.contact_id).toBe('c1');
    expect(out.contact?.tags).toEqual([{ id: 't1', name: 'vip', color: '#fff' }]);
    expect(out.unread_count).toBe(2);
    expect(out.last_message_at).toBe('2026-01-01T00:00:00.000Z');
  });

  it('nulls a missing contact and defaults unread_count/updated_at', () => {
    const conv: ConvexApiConversation = {
      _id: 'conv2',
      _creationTime: Date.parse('2026-01-02T00:00:00Z'),
      contactId: 'gone',
      status: 'closed',
      unreadCount: 0,
      contact: null,
    };
    const out = serializeConversation(conv);
    expect(out.contact).toBeNull();
    expect(out.updated_at).toBe(out.created_at); // backfilled, no updatedAt set
  });
});

describe('serializeMessage', () => {
  it('maps messageId → whatsapp_message_id and derives direction', () => {
    const inbound: ConvexApiMessage = {
      _id: 'm1',
      _creationTime: Date.parse('2026-01-01T00:00:00Z'),
      conversationId: 'conv1',
      senderType: 'customer',
      contentType: 'text',
      contentText: 'hello',
      messageId: 'wamid.123',
      status: 'delivered',
    };
    const outMsg = serializeMessage(inbound);
    expect(outMsg.direction).toBe('inbound');
    expect(outMsg.whatsapp_message_id).toBe('wamid.123');
    expect(outMsg).not.toHaveProperty('messageId');

    const agent = { ...inbound, senderType: 'agent' };
    expect(serializeMessage(agent).direction).toBe('outbound');
  });
});
