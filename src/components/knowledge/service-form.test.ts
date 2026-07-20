import { expect, test } from 'vitest';
import { suggestServiceKey, parseAliases } from './service-form';

test('suggestServiceKey slugifies a display name', () => {
  expect(suggestServiceKey('UAE Visa Services')).toBe('uae-visa-services');
  expect(suggestServiceKey('  Flights & Hotels ')).toBe('flights-hotels');
});

test('parseAliases splits on commas, trims, drops blanks, dedupes case-insensitively', () => {
  expect(parseAliases('visa, Tourist Visa , , visa')).toEqual(['visa', 'Tourist Visa']);
  expect(parseAliases('')).toEqual([]);
});
