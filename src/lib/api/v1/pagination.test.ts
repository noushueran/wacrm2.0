import { describe, it, expect } from 'vitest';
import { parseListParams, DEFAULT_LIMIT, MAX_LIMIT } from './pagination';

const req = (qs: string) => new Request(`https://x.test/api/v1/contacts${qs}`);

describe('parseListParams', () => {
  it('defaults limit and cursor', () => {
    expect(parseListParams(req(''))).toEqual({
      limit: DEFAULT_LIMIT,
      cursor: undefined,
    });
  });

  it('clamps limit to MAX_LIMIT and floors it', () => {
    expect(parseListParams(req('?limit=9999')).limit).toBe(MAX_LIMIT);
    expect(parseListParams(req('?limit=10.9')).limit).toBe(10);
  });

  it('falls back to default on non-positive / NaN limit', () => {
    expect(parseListParams(req('?limit=0')).limit).toBe(DEFAULT_LIMIT);
    expect(parseListParams(req('?limit=-5')).limit).toBe(DEFAULT_LIMIT);
    expect(parseListParams(req('?limit=abc')).limit).toBe(DEFAULT_LIMIT);
  });

  it('passes an opaque cursor straight through, untouched', () => {
    expect(parseListParams(req('?cursor=some-opaque-convex-cursor')).cursor).toBe(
      'some-opaque-convex-cursor'
    );
  });

  it('treats an empty cursor param the same as absent (undefined)', () => {
    expect(parseListParams(req('?cursor=')).cursor).toBeUndefined();
    expect(parseListParams(req('')).cursor).toBeUndefined();
  });
});
