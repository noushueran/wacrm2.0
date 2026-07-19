import { describe, expect, test } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../../../messages/en.json';
import { ServiceMatrix, otherEntryCount, type ServiceRow } from './service-matrix';

const emptyEntries = {
  overview: { published: 0, draft: 0 }, faq: { published: 0, draft: 0 },
  itinerary: { published: 0, draft: 0 }, requirements: { published: 0, draft: 0 },
  policy: { published: 0, draft: 0 }, process: { published: 0, draft: 0 },
  note: { published: 0, draft: 0 },
};
const absentOps = {
  qualification: { state: 'absent' as const, marksTotal: null },
  sales: { state: 'absent' as const, marksTotal: null },
  purchase: { state: 'absent' as const, marksTotal: null },
};

function row(over: Partial<ServiceRow> = {}): ServiceRow {
  return {
    key: 'georgia', name: 'Georgia', aliases: [], status: 'active', sortOrder: 0,
    entries: emptyEntries, ops: absentOps, verdict: 'empty', ...over,
  };
}

function markup(services: ServiceRow[]): string {
  // NextIntlClientProviderProps declares `children: ReactNode` as required.
  // createElement's overload only folds a trailing positional argument into
  // `props.children` when that field is optional (as it is for
  // DropdownMenuGroup in the sibling precedent test) — with a required
  // field, tsc needs `children` written into the props object instead. But
  // `react/no-children-prop` disallows writing `children` as an explicit
  // prop. Real JSX for just this one wrapper satisfies both: the compiler
  // threads the nested child into the required prop, and no literal
  // `children` key appears in source for the lint rule to catch.
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={messages}>
      {React.createElement(ServiceMatrix, {
        services,
        onSelectService: () => {},
        onCreateService: () => {},
      })}
    </NextIntlClientProvider>,
  );
}

describe('otherEntryCount', () => {
  test('sums only entry types that have no column of their own', () => {
    expect(otherEntryCount({
      ...emptyEntries,
      overview: { published: 5, draft: 5 },   // has a column — excluded
      policy: { published: 1, draft: 0 },
      note: { published: 0, draft: 2 },
    })).toBe(3);
  });
  test('is zero when only column-backed types have content', () => {
    expect(otherEntryCount({ ...emptyEntries, faq: { published: 9, draft: 0 } })).toBe(0);
  });
});

describe('ServiceMatrix', () => {
  test('renders the empty state when there are no services', () => {
    expect(markup([])).toContain(messages.Knowledge.empty.title);
  });

  test('renders the service name and its verdict label', () => {
    const html = markup([row({ verdict: 'ready' })]);
    expect(html).toContain('Georgia');
    expect(html).toContain(messages.Knowledge.verdict.ready);
  });

  test('renders the qualification marks total when one is known', () => {
    expect(markup([row({
      ops: { ...absentOps, qualification: { state: 'published', marksTotal: 90 } },
    })])).toContain('90');
  });

  test('renders a "+N more" count for entry types without a column', () => {
    expect(markup([row({
      entries: {
        ...emptyEntries,
        policy: { published: 1, draft: 0 },
        note: { published: 0, draft: 2 },
      },
    })])).toContain('+3 more');
  });
});
