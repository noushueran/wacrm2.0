import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../../../messages/en.json';
import {
  type LeadAnalysisBoardData,
  type LeadAnalysisFilters,
  type LeadAnalysisRow,
} from './lead-analysis-filter';
import { LeadAnalysisList } from './lead-analysis-list';
import { LeadAnalysisSummary } from './lead-analysis-summary';

/**
 * Static-render tests, matching this repo's other component tests
 * (`voice-transcript.test.tsx`, `ui/dropdown-menu-group-label.test.tsx`,
 * `knowledge/service-matrix.test.tsx`, `inbox/conversation-list.test.tsx`)
 * — there is no jsdom and no Testing Library here, so these assert on
 * markup, not on clicks or select/typing events.
 *
 * Band/lane/search filtering is NOT tested here any more: it moved
 * server-side with pagination, because the moment only one page crosses
 * the wire a client-side filter silently narrows from "search the board"
 * to "search these 25 rows". Its behaviour is pinned in
 * `convex/leadAnalysis.test.ts` ("board filters by band across the whole
 * board, not just the page", and its lane/search siblings). These
 * components render whatever rows they are handed.
 */

const lead = (over: Partial<LeadAnalysisRow> = {}): LeadAnalysisRow => ({
  analysisId: 'a1',
  conversationId: 'c1',
  contactName: 'Asha',
  contactPhone: '+971500000001',
  score: 9,
  band: 'hot',
  reason: 'Gave dates and budget',
  signals: ['dates_given'],
  lane: 'awaiting_us',
  scoreStatus: 'scored',
  lastMessageAt: Date.now(),
  daysSinceLastMessage: 0,
  assigneeName: null,
  source: 'organic',
  serviceName: null,
  sequenceStatus: 'idle',
  followUpsSent: 0,
  scoredAt: Date.now(),
  archived: false,
  returnedAt: null,
  ...over,
});

const board = (leads: LeadAnalysisRow[]): LeadAnalysisBoardData => ({
  summary: {
    hot: leads.filter((l) => l.band === 'hot').length,
    warm: leads.filter((l) => l.band === 'warm').length,
    cold: leads.filter((l) => l.band === 'cold').length,
    awaitingUs: leads.filter((l) => l.lane === 'awaiting_us').length,
    awaitingThem: leads.filter((l) => l.lane === 'awaiting_them').length,
    unscored: leads.filter((l) => l.score === null).length,
    total: leads.length,
    avgScore: 9,
  },
  leads,
});

function summaryMarkup(
  data: LeadAnalysisBoardData,
  options: {
    view?: 'active' | 'archived';
    onViewChange?: (view: 'active' | 'archived') => void;
    filters?: LeadAnalysisFilters;
    onFiltersChange?: (next: LeadAnalysisFilters) => void;
  } = {}
): string {
  const {
    view = 'active',
    onViewChange = vi.fn(),
    filters = { band: 'all', lane: 'all', search: '' },
    onFiltersChange = vi.fn(),
  } = options;
  // See service-matrix.test.tsx: NextIntlClientProviderProps declares
  // `children` as required, so real JSX threads it in for us, while
  // React.createElement builds the props object for the component under
  // test without writing a literal `children` key (which
  // react/no-children-prop disallows).
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={messages}>
      {React.createElement(LeadAnalysisSummary, {
        board: data,
        view,
        onViewChange,
        filters,
        onFiltersChange,
      })}
    </NextIntlClientProvider>
  );
}

function listMarkup(
  leads: LeadAnalysisRow[],
  options: {
    selectedConversationId?: string | null;
    onSelect?: (lead: LeadAnalysisRow) => void;
    canReanalyze?: boolean;
    onReanalyze?: (lead: LeadAnalysisRow) => void;
    canArchive?: boolean;
    onArchive?: (lead: LeadAnalysisRow) => void;
    onRestore?: (lead: LeadAnalysisRow) => void;
  } = {}
): string {
  const {
    selectedConversationId = null,
    onSelect = vi.fn(),
    canReanalyze = true,
    onReanalyze = vi.fn(),
    canArchive = false,
    onArchive = vi.fn(),
    onRestore = vi.fn(),
  } = options;
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={messages}>
      {React.createElement(LeadAnalysisList, {
        leads,
        selectedConversationId,
        onSelect,
        canReanalyze,
        onReanalyze,
        canArchive,
        onArchive,
        onRestore,
      })}
    </NextIntlClientProvider>
  );
}

/**
 * Extracts the text content of the single element carrying the given
 * `data-testid` out of a `renderToStaticMarkup` string.
 *
 * Plain `toContain` checks on markup strings are vulnerable to a
 * vacuous-assertion trap this file used to have: several strings the
 * per-row fallbacks render (e.g. a lead's score, or the "Unscored"
 * fallback text) are ALSO rendered unconditionally elsewhere on the page
 * — the score chip's "9" collides with the avg-score summary tile, and
 * the row's "Unscored" fallback collides with the "Unscored" tile
 * label — so a bare `toContain` would pass even if the row-level
 * behavior being tested were broken or deleted outright. Testing
 * Library's `getByText` would catch this via its uniqueness check;
 * this regex-based lookup recreates that by scoping to one specific,
 * uniquely-tagged element instead.
 */
function textByTestId(html: string, testId: string): string {
  const match = html.match(new RegExp(`data-testid="${testId}"[^>]*>([^<]*)<`));
  if (!match) {
    throw new Error(`No element with data-testid="${testId}" found in markup`);
  }
  return match[1];
}

/**
 * Extracts the full opening tag (attributes included) carrying the given
 * `data-testid`, for tests that need to inspect its `class` — e.g. the
 * view-toggle pills, where the DIFFERENCE between `view: 'active'` and
 * `view: 'archived'` is entirely which pill's `class` carries the
 * selected-state utility, not its text content (both pills' text is
 * static and renders regardless of `view`).
 */
function tagByTestId(html: string, testId: string): string {
  const match = html.match(new RegExp(`<[a-z]+[^>]*data-testid="${testId}"[^>]*>`));
  if (!match) {
    throw new Error(`No element with data-testid="${testId}" found in markup`);
  }
  return match[0];
}

describe('LeadAnalysisSummary', () => {
  it('renders the summary tiles', () => {
    const html = summaryMarkup(board([lead()]));
    // Scoped to the tile elements themselves (data-testid="tile-hot" /
    // "tile-awaitingUs"), not bare `toContain('Hot')` /
    // `toContain('Awaiting us')` — both strings are ALSO emitted
    // unconditionally by the band/lane filter `<select>` options
    // (`<option value="hot">Hot</option>`,
    // `<option value="awaiting_us">Awaiting us</option>`). A bare
    // `toContain` would still pass with both tiles deleted outright —
    // see the `textByTestId` doc comment above.
    expect(textByTestId(html, 'tile-hot')).toBe('Hot');
    expect(textByTestId(html, 'tile-awaitingUs')).toBe('Awaiting us');
  });

  it('renders the band, lane, and search filter controls with genuinely associated labels', () => {
    const html = summaryMarkup(board([lead()]));
    expect(html).toMatch(/<label[^>]*\bfor="band-filter"[^>]*>\s*Band/);
    expect(html).toMatch(/<select[^>]*\bid="band-filter"/);
    expect(html).toMatch(/<label[^>]*\bfor="lane-filter"[^>]*>\s*Lane/);
    expect(html).toMatch(/<select[^>]*\bid="lane-filter"/);
    expect(html).toMatch(
      /<label[^>]*\bfor="lead-search"[^>]*>\s*Search name or phone/
    );
    expect(html).toMatch(/<input[^>]*\bid="lead-search"/);
  });

  it('highlights the pill matching the current view, not the other one', () => {
    // The previous version of this test only asserted both pills render
    // — true unconditionally, regardless of `view` — so it would keep
    // passing even if `view` were dropped from the pills entirely.
    // Assert the one thing that actually differs between the two prop
    // values: which pill carries the selected-state class.
    const activeHtml = summaryMarkup(board([lead()]), { view: 'active' });
    expect(tagByTestId(activeHtml, 'view-toggle-active')).toContain(
      'bg-primary/10'
    );
    expect(tagByTestId(activeHtml, 'view-toggle-archived')).not.toContain(
      'bg-primary/10'
    );

    const archivedHtml = summaryMarkup(board([lead()]), { view: 'archived' });
    expect(tagByTestId(archivedHtml, 'view-toggle-archived')).toContain(
      'bg-primary/10'
    );
    expect(tagByTestId(archivedHtml, 'view-toggle-active')).not.toContain(
      'bg-primary/10'
    );
  });
});

describe('LeadAnalysisList', () => {
  it("renders a lead's name, score, and reason", () => {
    const html = listMarkup([lead()]);
    expect(html).toContain('Asha');
    expect(textByTestId(html, 'lead-score')).toBe('9');
    expect(textByTestId(html, 'lead-reason')).toBe('Gave dates and budget');
  });

  it('shows an empty state when there are no leads', () => {
    const html = listMarkup([]);
    expect(html).toContain(
      'No leads scored yet. Scoring runs in the background.'
    );
  });

  it('labels an unscored lead rather than showing a blank score', () => {
    const html = listMarkup([lead({ score: null, band: null, reason: null })]);
    // Scoped to the row's own fallback text (data-testid="lead-reason"),
    // not a bare `toContain('Unscored')` — see the `textByTestId` doc
    // comment above for why that would be vacuous here.
    expect(textByTestId(html, 'lead-reason')).toBe('Unscored');
  });

  it('shows the Re-analyze action only when canReanalyze is true', () => {
    expect(listMarkup([lead()], { canReanalyze: true })).toContain(
      'row-reanalyze-action'
    );
    expect(listMarkup([lead()], { canReanalyze: false })).not.toContain(
      'row-reanalyze-action'
    );
  });

  it('shows Archive on an active row and Restore on an archived one', () => {
    // Scoped to data-testid="row-archive-action"'s `title` attribute —
    // the action is now an icon button with no visible text child, so a
    // bare `toContain('Archive')` / `toContain('Restore')` would not
    // distinguish this from other markup (see the textByTestId doc
    // comment above for the same trap in text form).
    const activeHtml = listMarkup([lead({ archived: false })], {
      canArchive: true,
    });
    expect(tagByTestId(activeHtml, 'row-archive-action')).toContain(
      'title="Archive"'
    );

    const archivedHtml = listMarkup([lead({ archived: true })], {
      canArchive: true,
    });
    expect(tagByTestId(archivedHtml, 'row-archive-action')).toContain(
      'title="Restore"'
    );
  });

  it('hides the archive action when canArchive is false', () => {
    const html = listMarkup([lead()], { canArchive: false });
    expect(html).not.toContain('data-testid="row-archive-action"');
  });

  it('marks a returned lead', () => {
    const html = listMarkup([lead({ returnedAt: Date.now() })]);
    // Scoped to data-testid="row-returned-badge" — not a bare
    // `toContain('Returned')`, which is not otherwise emitted elsewhere
    // on the page but is still scoped defensively for consistency with
    // the rest of this file's row-level assertions.
    expect(textByTestId(html, 'row-returned-badge')).toBe('Returned');
  });

  it('renders the row as keyboard-reachable (role="button", tabIndex="0")', () => {
    // This repo has no jsdom/Testing Library, so a keypress can't be
    // simulated — the row's onKeyDown activation is exercised only by
    // hand-testing. What this test CAN assert on static markup is that
    // the row is reachable and identifiable as interactive at all: a
    // bare `<li onClick>` is invisible to Tab and to assistive tech.
    const html = listMarkup([lead()]);
    expect(tagByTestId(html, 'lead-row')).toContain('role="button"');
    expect(tagByTestId(html, 'lead-row')).toContain('tabindex="0"');
  });

  it('marks the selected row with aria-current', () => {
    const html = renderToStaticMarkup(
      <NextIntlClientProvider locale="en" messages={messages}>
        <LeadAnalysisList
          leads={[lead({ conversationId: 'c1' }), lead({ analysisId: 'a2', conversationId: 'c2' })]}
          selectedConversationId="c2"
          onSelect={vi.fn()}
          canReanalyze
          onReanalyze={vi.fn()}
          canArchive
          onArchive={vi.fn()}
          onRestore={vi.fn()}
        />
      </NextIntlClientProvider>
    );
    expect(html.match(/aria-current="true"/g)).toHaveLength(1);
  });

  it('hides row actions from a user who cannot act', () => {
    const html = renderToStaticMarkup(
      <NextIntlClientProvider locale="en" messages={messages}>
        <LeadAnalysisList
          leads={[lead()]}
          selectedConversationId={null}
          onSelect={vi.fn()}
          canReanalyze={false}
          onReanalyze={vi.fn()}
          canArchive={false}
          onArchive={vi.fn()}
          onRestore={vi.fn()}
        />
      </NextIntlClientProvider>
    );
    expect(html).not.toContain('row-archive-action');
    expect(html).not.toContain('row-reanalyze-action');
  });

  it('offers restore rather than archive on an archived lead', () => {
    const html = renderToStaticMarkup(
      <NextIntlClientProvider locale="en" messages={messages}>
        <LeadAnalysisList
          leads={[lead({ archived: true })]}
          selectedConversationId={null}
          onSelect={vi.fn()}
          canReanalyze
          onReanalyze={vi.fn()}
          canArchive
          onArchive={vi.fn()}
          onRestore={vi.fn()}
        />
      </NextIntlClientProvider>
    );
    expect(html).toContain(messages.LeadAnalysis.row.restore);
  });
});
