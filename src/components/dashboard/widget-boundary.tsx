"use client"

import { unstable_catchError, type ErrorInfo } from 'next/error'
import { AlertTriangle, RotateCw } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { cn } from '@/lib/utils'

// ============================================================
// WidgetBoundary — per-widget error containment for the dashboard.
//
// Every dashboard widget owns a `useQuery` subscription, and
// `useQuery` (convex/react, re-exported through @/lib/convex/cached)
// re-THROWS a failed query synchronously during render. With no
// boundary in the tree, one bad query took the whole route down: when
// `dashboard.responseTime` blew past a Convex per-transaction read
// limit the entire page went blank on "Your request timed out
// performing too many system operations", even though the other seven
// widgets were healthy. This makes that failure local to the card that
// owns the query.
//
// Built on Next's `unstable_catchError` (next/error, added in 16.2.0 —
// this repo is on 16.2.6) rather than a hand-rolled `componentDidCatch`
// class, for three reasons that are easy to get wrong by hand:
//
//   1. `redirect()` and `notFound()` work by THROWING sentinel errors.
//      `unstable_catchError` re-throws anything `isNextRouterError`
//      matches, so those keep bubbling to the boundary that should
//      handle them. A naive class boundary swallows them instead —
//      which would silently break `RequireSection`'s redirect on the
//      very page this wraps.
//   2. It clears its own error state when the pathname changes, so a
//      widget that failed doesn't stay failed after you navigate away
//      and back.
//   3. It renders `children` directly, with NO wrapper DOM element.
//      That matters here: the charts row relies on `h-full` and
//      `lg:col-span-*` applying to direct grid children, and an extra
//      <div> would break both.
//
// `unstable_retry()` re-renders the boundary's children, which remounts
// the widget and re-subscribes its query — the recovery path for a
// transient failure (a timeout, a dropped socket). A query that is
// deterministically broken just throws again and lands back on this
// card, which is the honest outcome.
// ============================================================

interface WidgetErrorCardProps {
  /** The widget's own heading, so the card is identifiable in place. */
  title: string
  /** One-line explanation shown under the title. */
  message: string
  /** Label for the retry control. */
  retryLabel: string
  /** Label for the disclosure that reveals `detail`. */
  detailLabel: string
  /** Raw error text, shown collapsed. Omitted when there's nothing useful. */
  detail?: string
  onRetry: () => void
  className?: string
}

/**
 * Presentational error card — a sibling of `SkeletonCard` / `EmptyState`
 * in this directory, and deliberately prop-only (no `useTranslations`,
 * no error plumbing) so it renders under `renderToStaticMarkup` in
 * tests. Same idiom as `VoiceTranscript`, which takes its labels as
 * props for exactly this reason: there is no jsdom in this repo.
 */
export function WidgetErrorCard({
  title,
  message,
  retryLabel,
  detailLabel,
  detail,
  onRetry,
  className,
}: WidgetErrorCardProps) {
  return (
    <section
      // `min-h-40` matches EmptyState so a failed widget occupies roughly
      // the space its content would have, instead of collapsing the row.
      className={cn(
        'flex min-h-40 flex-col items-center justify-center gap-2 rounded-xl border border-border bg-card px-5 py-6 text-center',
        className,
      )}
      // Announced to screen readers when it replaces a loaded widget.
      role="alert"
    >
      <span className="flex h-10 w-10 items-center justify-center rounded-full bg-rose-500/10 text-rose-700 dark:text-rose-300">
        <AlertTriangle className="h-5 w-5" aria-hidden />
      </span>
      <h2 className="text-sm font-semibold text-foreground">{title}</h2>
      <p className="max-w-xs text-xs text-muted-foreground">{message}</p>

      <button
        type="button"
        onClick={onRetry}
        className="mt-1 inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-muted"
      >
        <RotateCw className="h-3 w-3" aria-hidden />
        {retryLabel}
      </button>

      {/* Internal staff tool — the raw message is what actually
          diagnoses these (the outage above was legible straight from
          the Convex error string), so it stays available in production
          rather than being dev-gated. Collapsed so it's opt-in. */}
      {detail ? (
        <details className="mt-1 w-full max-w-xs text-left">
          <summary className="cursor-pointer text-[11px] text-muted-foreground hover:text-foreground">
            {detailLabel}
          </summary>
          <p className="mt-1 break-words font-mono text-[11px] leading-relaxed text-muted-foreground">
            {detail}
          </p>
        </details>
      ) : null}
    </section>
  )
}

interface WidgetBoundaryProps {
  /** Already-translated widget heading — the caller owns its namespace. */
  title: string
  /** Extra classes for the fallback card only (grid spans, `h-full`). */
  className?: string
}

function WidgetFallback(
  { title, className }: WidgetBoundaryProps,
  { error, unstable_retry }: ErrorInfo,
) {
  const t = useTranslations('Dashboard.widgetError')

  return (
    <WidgetErrorCard
      title={title}
      message={t('message')}
      retryLabel={t('retry')}
      detailLabel={t('details')}
      detail={error?.message}
      onRetry={() => unstable_retry()}
      className={className}
    />
  )
}

/**
 * Wraps one dashboard widget. `title` names the widget in the fallback;
 * `className` lands on the fallback card only (the healthy path renders
 * children untouched), which is how the metrics bundle keeps its
 * three-column footprint when it fails.
 */
export const WidgetBoundary = unstable_catchError(WidgetFallback)
