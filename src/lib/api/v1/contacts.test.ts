import { describe, it, expect } from 'vitest';

import { serializeContact } from './contacts';

describe('serializeContact', () => {
  it('projects a Convex contact doc + embedded tags onto the public shape', () => {
    const doc = {
      _id: 'c1',
      _creationTime: Date.parse('2026-01-01T00:00:00Z'),
      phone: '+14155550123',
      name: 'Jane',
      company: 'Acme',
      tags: [{ _id: 't1', name: 'vip', color: '#fff' }],
    };
    expect(serializeContact(doc)).toEqual({
      id: 'c1',
      phone: '+14155550123',
      name: 'Jane',
      email: null,
      company: 'Acme',
      avatar_url: null,
      tags: [{ id: 't1', name: 'vip', color: '#fff' }],
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    });
  });

  it('nulls every optional scalar field that is absent, and tolerates an empty tags array', () => {
    const doc = {
      _id: 'c2',
      _creationTime: Date.parse('2026-01-02T00:00:00Z'),
      phone: '+1',
      tags: [],
    };
    const result = serializeContact(doc);
    expect(result.name).toBeNull();
    expect(result.email).toBeNull();
    expect(result.company).toBeNull();
    expect(result.avatar_url).toBeNull();
    expect(result.tags).toEqual([]);
  });
});
