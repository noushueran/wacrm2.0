import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';

import messages from '../../../messages/en.json';
import { Pagination } from './pagination';

/**
 * Static-render tests, matching this repo's other component tests (no
 * jsdom/Testing Library — see `lead-analysis-list.test.tsx`'s header for
 * the precedent), over the REAL `Pagination` messages so a key deleted
 * from `en.json` fails here rather than rendering blank.
 *
 * These assertions used to live in `lead-analysis-board.test.tsx`, which
 * rendered the pager as part of the board. The board was split into a
 * summary and a list, and the pager moved up to
 * `/lead-analysis/page.tsx` — the level that owns the page state. They
 * are re-pointed here, at the component that actually renders the bar,
 * so the coverage survives the split instead of being deleted with the
 * board.
 */
function markup(props: Partial<React.ComponentProps<typeof Pagination>> = {}): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={messages}>
      {React.createElement(Pagination, {
        page: 0,
        pageSize: 25,
        total: 312,
        onPageChange: vi.fn(),
        ...props,
      })}
    </NextIntlClientProvider>
  );
}

function tagByTestId(html: string, testId: string): string {
  const match = html.match(new RegExp(`<[a-z]+[^>]*data-testid="${testId}"[^>]*>`));
  if (!match) {
    throw new Error(`No element with data-testid="${testId}" found in markup`);
  }
  return match[0];
}

describe('Pagination', () => {
  it('counts the whole filtered set in the range label, not the rows on screen', () => {
    // The regression this guards: passing `leads.length` as `total` would
    // read "Showing 1–25 of 25" on a 312-lead board and make pagination
    // look broken even while it works. `/lead-analysis/page.tsx` passes
    // `board.total` — the server's whole-board count — precisely so this
    // reads the truth.
    expect(markup({ page: 0, total: 312 })).toContain('Showing 1–25 of 312');
  });

  it('reports the range of a later page from the server-clamped page number', () => {
    expect(markup({ page: 2, total: 312 })).toContain('Showing 51–75 of 312');
  });

  it('renders page controls once there is more than one page', () => {
    const html = markup({ page: 0, total: 312 });
    expect(html).toContain('data-testid="pagination-controls"');
    expect(html).toContain('data-testid="pagination-next"');
  });

  it('shows the range but no controls when everything fits on one page', () => {
    const html = markup({ page: 0, total: 3 });
    expect(html).toContain('data-testid="pagination"');
    expect(html).not.toContain('data-testid="pagination-controls"');
  });

  it('omits the bar entirely when there is nothing to page through', () => {
    expect(markup({ total: 0 })).not.toContain('data-testid="pagination"');
  });

  it('disables Prev on the first page and Next on the last', () => {
    // Matches the ATTRIBUTE, not the substring: every one of these
    // buttons carries Tailwind's `disabled:opacity-30` /
    // `disabled:pointer-events-none` in its class list, so a bare
    // `toContain('disabled')` passes on an enabled button and asserts
    // nothing at all.
    const isDisabled = (tag: string) => tag.includes('disabled=""');

    const first = markup({ page: 0, total: 312 });
    expect(isDisabled(tagByTestId(first, 'pagination-prev'))).toBe(true);
    expect(isDisabled(tagByTestId(first, 'pagination-next'))).toBe(false);

    const last = markup({ page: 12, total: 312 });
    expect(isDisabled(tagByTestId(last, 'pagination-next'))).toBe(true);
    expect(isDisabled(tagByTestId(last, 'pagination-prev'))).toBe(false);
  });

  it('marks the current page for assistive tech', () => {
    expect(markup({ page: 2, total: 312 })).toContain('aria-current="page"');
  });
});
