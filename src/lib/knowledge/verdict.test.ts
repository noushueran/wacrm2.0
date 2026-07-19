import { describe, expect, test } from 'vitest';
import { marksTotal, serviceVerdict } from './verdict';

describe('marksTotal', () => {
  test('sums when every criterion has numeric marks', () => {
    expect(marksTotal([{ marks: 60 }, { marks: 40 }])).toBe(100);
  });
  test('returns null when the list is empty', () => {
    expect(marksTotal([])).toBeNull();
  });
  test('returns null when any criterion lacks marks', () => {
    expect(marksTotal([{ marks: 50 }, {}])).toBeNull();
  });
  test('treats 0 as a real value, not missing', () => {
    expect(marksTotal([{ marks: 0 }, { marks: 100 }])).toBe(100);
  });
});

describe('serviceVerdict', () => {
  const ready = {
    overviewPublished: true,
    hasAnyContent: true,
    hasAnyPublished: true,
    qualification: { state: 'published' as const, marksTotal: 100 },
    purchase: { state: 'published' as const },
  };

  test('ready when overview, qualification at 100, and purchase are all published', () => {
    expect(serviceVerdict(ready)).toBe('ready');
  });

  test('empty when nothing is authored at all', () => {
    expect(
      serviceVerdict({
        overviewPublished: false,
        hasAnyContent: false,
        hasAnyPublished: false,
        qualification: { state: 'absent', marksTotal: null },
        purchase: { state: 'absent' },
      })
    ).toBe('empty');
  });

  test('draft when content exists but nothing is published', () => {
    expect(
      serviceVerdict({
        overviewPublished: false,
        hasAnyContent: true,
        hasAnyPublished: false,
        qualification: { state: 'draft', marksTotal: 90 },
        purchase: { state: 'draft' },
      })
    ).toBe('draft');
  });

  test('blocked when qualification is published but marks are not 100', () => {
    expect(
      serviceVerdict({
        ...ready,
        qualification: { state: 'published', marksTotal: 90 },
      })
    ).toBe('blocked');
  });

  test('blocked when purchase criteria are missing', () => {
    expect(serviceVerdict({ ...ready, purchase: { state: 'absent' } })).toBe(
      'blocked'
    );
  });

  test('blocked when the overview exists only as a draft', () => {
    expect(serviceVerdict({ ...ready, overviewPublished: false })).toBe(
      'blocked'
    );
  });

  test('blocked when qualification marks are complete but the block is still a draft', () => {
    expect(serviceVerdict({
      ...ready,
      qualification: { state: 'draft', marksTotal: 100 },
    })).toBe('blocked');
  });
});
