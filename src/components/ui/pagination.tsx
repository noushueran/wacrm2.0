'use client';

import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { pageCountFor, pageTokens } from '@/lib/ui/pagination';

// ============================================================
// The shared pagination control — one bar, used by every paged list
// (/contacts, /leads, /lead-analysis). Presentational and stateless: it
// is handed a 0-based `page` and a `total`, and reports clicks back. It
// owns no data fetching, so it works identically over a server-paged
// query and a client-sliced array.
//
// All page arithmetic lives in `@/lib/ui/pagination` and is unit-tested
// there — this file only decides what the arithmetic looks like.
// ============================================================

export interface PaginationProps {
  /** Current page, 0-based. */
  page: number;
  pageSize: number;
  /** Size of the WHOLE (filtered) result set, not of the current page. */
  total: number;
  onPageChange: (page: number) => void;
  /**
   * A page is in flight. Disables the controls so a double-click can't
   * queue two jumps — it does NOT blank the bar, because a control that
   * disappears while loading makes the layout jump on every page turn.
   */
  busy?: boolean;
  className?: string;
}

export function Pagination({
  page,
  pageSize,
  total,
  onPageChange,
  busy = false,
  className,
}: PaginationProps) {
  const t = useTranslations('Pagination');
  const pageCount = pageCountFor(total, pageSize);

  // Nothing to page through and nothing to count.
  if (total === 0) return null;

  const start = page * pageSize + 1;
  const end = Math.min((page + 1) * pageSize, total);
  const hasPrev = page > 0;
  const hasNext = page < pageCount - 1;

  return (
    <div
      className={cn(
        'flex flex-wrap items-center justify-between gap-3 pt-1',
        className
      )}
      data-testid="pagination"
    >
      <p className="text-muted-foreground text-xs tabular-nums">
        {t('showing', { start, end, total })}
      </p>

      {/* The range label alone is worth showing on a single page; the
          controls are not — six disabled buttons say nothing. */}
      {pageCount > 1 && (
        <nav
          className="flex items-center gap-1"
          aria-label={t('label')}
          data-testid="pagination-controls"
        >
          <Button
            variant="outline"
            size="icon-sm"
            disabled={!hasPrev || busy}
            onClick={() => onPageChange(page - 1)}
            aria-label={t('previous')}
            data-testid="pagination-prev"
            className="disabled:opacity-30"
          >
            <ChevronLeft className="size-4" />
          </Button>

          {/* Numbered jumps: the whole point of pages over "load more" is
              being able to aim at one. Below `sm` they'd wrap onto their
              own line, so that breakpoint gets the compact counter. */}
          <div className="hidden items-center gap-1 sm:flex">
            {pageTokens(page, pageCount).map((token, i) =>
              token === 'ellipsis' ? (
                <span
                  key={`gap-${i}`}
                  aria-hidden="true"
                  className="text-muted-foreground px-1 text-xs select-none"
                >
                  …
                </span>
              ) : (
                <Button
                  key={token}
                  variant={token === page ? 'default' : 'outline'}
                  size="icon-sm"
                  disabled={busy}
                  onClick={() => onPageChange(token)}
                  aria-label={t('goToPage', { page: token + 1 })}
                  aria-current={token === page ? 'page' : undefined}
                  className="text-xs tabular-nums"
                >
                  {token + 1}
                </Button>
              )
            )}
          </div>

          <span className="text-muted-foreground px-2 text-xs tabular-nums sm:hidden">
            {t('pageOf', { page: page + 1, total: pageCount })}
          </span>

          <Button
            variant="outline"
            size="icon-sm"
            disabled={!hasNext || busy}
            onClick={() => onPageChange(page + 1)}
            aria-label={t('next')}
            data-testid="pagination-next"
            className="disabled:opacity-30"
          >
            <ChevronRight className="size-4" />
          </Button>
        </nav>
      )}
    </div>
  );
}
