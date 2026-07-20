import { expect, test } from 'vitest';
import { nextRowKey } from './checklist-editor';

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
