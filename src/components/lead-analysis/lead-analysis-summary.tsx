'use client';

import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type {
  LeadAnalysisBoardData,
  LeadAnalysisFilters,
  LeadAnalysisView,
  LeadBandKey,
  LeadLaneKey,
} from './lead-analysis-filter';

// ============================================================
// The Lead Analysis queue's summary tiles (hot/warm/cold/awaiting-us/
// unscored/avg score) and its band/lane/search filter controls —
// PRESENTATIONAL ONLY, so it can be rendered with mock data for visual
// verification and unit-tested without Convex. All filtering is
// client-side over the single bounded payload the board query returns.
//
// Filter STATE is lifted to and owned by the page
// (`src/app/(dashboard)/lead-analysis/page.tsx`) rather than kept local
// here: the page needs the exact same filtered list this component
// renders against in order to compute auto-advance selection after an
// archive (`nextSelectionAfterArchive`), and it has no way to read state
// that lived only inside this component.
//
// The filter VALUES are the query's arguments now — filtering runs
// server-side over the whole board, not client-side over one page — so
// this component only renders the controls and reports changes upward.
// The predicate itself is pinned in `convex/leadAnalysis.test.ts`; this
// repo has no jsdom, so component tests assert on static markup only
// and could never have simulated a select change anyway.
// ============================================================

export function LeadAnalysisSummary({
  board,
  view,
  onViewChange,
  filters,
  onFiltersChange,
}: {
  board: LeadAnalysisBoardData;
  view: LeadAnalysisView;
  onViewChange: (view: LeadAnalysisView) => void;
  filters: LeadAnalysisFilters;
  onFiltersChange: (next: LeadAnalysisFilters) => void;
}) {
  const t = useTranslations('LeadAnalysis');

  const viewPills: { id: LeadAnalysisView; label: string }[] = [
    { id: 'active', label: t('view.active') },
    { id: 'archived', label: t('view.archived') },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <div className="flex shrink-0 items-center rounded-full border p-0.5">
          {viewPills.map((p) => (
            <button
              key={p.id}
              type="button"
              data-testid={`view-toggle-${p.id}`}
              onClick={() => onViewChange(p.id)}
              className={cn(
                'rounded-full px-3 py-1 text-xs font-medium transition-colors',
                view === p.id
                  ? 'bg-primary/10 text-primary'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      <dl className="grid grid-cols-3 gap-2 sm:grid-cols-6">
        <Tile
          label={t('tiles.hot')}
          value={board.summary.hot}
          testId="tile-hot"
        />
        <Tile label={t('tiles.warm')} value={board.summary.warm} />
        <Tile label={t('tiles.cold')} value={board.summary.cold} />
        <Tile
          label={t('tiles.awaitingUs')}
          value={board.summary.awaitingUs}
          testId="tile-awaitingUs"
        />
        <Tile label={t('tiles.unscored')} value={board.summary.unscored} />
        <Tile label={t('tiles.avgScore')} value={board.summary.avgScore} />
      </dl>

      <div className="flex flex-wrap items-end gap-4">
        <div className="space-y-1">
          <Label htmlFor="band-filter">{t('filters.band')}</Label>
          <select
            id="band-filter"
            className="bg-background h-9 rounded-md border px-2 text-sm"
            value={filters.band}
            onChange={(e) =>
              onFiltersChange({
                ...filters,
                band: e.target.value as 'all' | LeadBandKey,
              })
            }
          >
            <option value="all">{t('filters.all')}</option>
            <option value="hot">{t('tiles.hot')}</option>
            <option value="warm">{t('tiles.warm')}</option>
            <option value="cold">{t('tiles.cold')}</option>
          </select>
        </div>

        <div className="space-y-1">
          <Label htmlFor="lane-filter">{t('filters.lane')}</Label>
          <select
            id="lane-filter"
            className="bg-background h-9 rounded-md border px-2 text-sm"
            value={filters.lane}
            onChange={(e) =>
              onFiltersChange({
                ...filters,
                lane: e.target.value as 'all' | LeadLaneKey,
              })
            }
          >
            <option value="all">{t('filters.all')}</option>
            <option value="awaiting_us">{t('lane.awaiting_us')}</option>
            <option value="awaiting_them">{t('lane.awaiting_them')}</option>
          </select>
        </div>

        <div className="space-y-1">
          <Label htmlFor="lead-search">{t('filters.search')}</Label>
          <Input
            id="lead-search"
            className="w-56"
            value={filters.search}
            onChange={(e) =>
              onFiltersChange({ ...filters, search: e.target.value })
            }
          />
        </div>
      </div>
    </div>
  );
}

function Tile({
  label,
  value,
  testId,
}: {
  label: string;
  value: number;
  /** Optional hook for tests that need to pin one specific tile's label —
   *  several tile labels (e.g. "Hot", "Awaiting us") are also emitted by
   *  the filter `<select>` options below, so a bare text match can't tell
   *  the tile apart from those. */
  testId?: string;
}) {
  return (
    <div className="rounded-md border p-2">
      <dt data-testid={testId} className="text-muted-foreground text-xs">
        {label}
      </dt>
      <dd className="text-base font-semibold">{value}</dd>
    </div>
  );
}
