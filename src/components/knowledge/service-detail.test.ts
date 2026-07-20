import { expect, test } from 'vitest';
import { groupEntriesByType, ENTRY_TYPE_ORDER } from './service-detail';

test('groupEntriesByType buckets entries and preserves the canonical type order', () => {
  const grouped = groupEntriesByType([
    { _id: '1', type: 'faq', title: 'Q1', body: '', audience: 'customer', status: 'published', version: 1 },
    { _id: '2', type: 'overview', title: 'O', body: '', audience: 'customer', status: 'draft', version: 1 },
    { _id: '3', type: 'faq', title: 'Q2', body: '', audience: 'customer', status: 'draft', version: 1 },
  ]);
  expect(Object.keys(grouped)).toEqual(ENTRY_TYPE_ORDER.filter((t) => grouped[t]?.length));
  expect(grouped.faq?.map((e) => e._id)).toEqual(['1', '3']);
  expect(grouped.overview?.map((e) => e._id)).toEqual(['2']);
});
