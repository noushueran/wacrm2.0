import { expect, test } from 'vitest';
import { computeSaveBlocked, nextRowKey } from './checklist-editor';

test('nextRowKey slugifies the label', () => {
  expect(nextRowKey('Travel dates', [])).toBe('travel-dates');
});

test('nextRowKey dedupes against existing keys with a numeric suffix', () => {
  expect(nextRowKey('Travel dates', ['travel-dates'])).toBe('travel-dates-2');
  expect(nextRowKey('Travel dates', ['travel-dates', 'travel-dates-2'])).toBe('travel-dates-3');
});

test('nextRowKey falls back for a label with no slug-able characters', () => {
  expect(nextRowKey('!!!', [])).toBe('item');
  expect(nextRowKey('!!!', ['item'])).toBe('item-2');
});

test('nextRowKey truncates very long labels to 40 characters', () => {
  const key = nextRowKey('a'.repeat(80), []);
  expect(key.length).toBeLessThanOrEqual(40);
});

// Regression coverage for the final-review finding: saving an empty
// checklist used to be allowed because `items_required` (the only issue
// zero rows ever produces) isn't a SHAPE_ISSUE_CODES entry, so the old
// `saveBlocked` check missed it entirely.
test('computeSaveBlocked blocks an empty checklist even though items_required is not a shape issue', () => {
  expect(
    computeSaveBlocked([], [{ level: 'error', code: 'items_required', message: 'x' }]),
  ).toBe(true);
});

test('computeSaveBlocked allows a single valid row with no issues', () => {
  expect(computeSaveBlocked([{ key: 'a', label: 'A' }], [])).toBe(false);
});

test('computeSaveBlocked still blocks on a shape issue when rows are present', () => {
  expect(
    computeSaveBlocked(
      [{ key: 'a', label: '' }],
      [{ level: 'error', code: 'label_required', message: 'x' }],
    ),
  ).toBe(true);
});
