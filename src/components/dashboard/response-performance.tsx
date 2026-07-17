"use client"

import { Clock, TrendingDown, TrendingUp } from 'lucide-react'
import { useTranslations } from 'next-intl'

import type { ResponseTimeSummary } from '@/lib/dashboard/types'
import { cn } from '@/lib/utils'
import { softBadge } from '@/lib/ui/soft-badge'
import { Skeleton } from './skeleton'

interface ResponsePerformanceProps {
  data: ResponseTimeSummary | null
  loading: boolean
  /** SLA target in minutes, surfaced as a pill. */
  thresholdMinutes?: number
}

/**
 * Slim response-time summary — this-week vs last-week average first response,
 * plus an under/over-target pill. Reuses the existing `responseTime` query's
 * week averages; it replaces the niche by-weekday bar chart (and drops the
 * Tremor/Recharts import from the dashboard route).
 */
export function ResponsePerformance({
  data,
  loading,
  thresholdMinutes = 5,
}: ResponsePerformanceProps) {
  const t = useTranslations('Dashboard.responsePerformance')

  const thisWeek = data?.thisWeekAvg ?? null
  const lastWeek = data?.lastWeekAvg ?? null
  const hasData = thisWeek != null || lastWeek != null

  // "faster" = a lower average response time this week than last.
  const delta = thisWeek != null && lastWeek != null ? thisWeek - lastWeek : null
  const faster = delta != null && delta < 0
  const underTarget = thisWeek != null && thisWeek <= thresholdMinutes

  return (
    <section className="rounded-xl border border-border bg-card px-5 py-4">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
        <div className="flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-muted text-muted-foreground">
            <Clock className="h-4 w-4" />
          </span>
          <h2 className="text-sm font-semibold text-foreground">{t('title')}</h2>
        </div>

        {loading ? (
          <Skeleton className="h-6 w-56" />
        ) : !hasData ? (
          <p className="text-sm text-muted-foreground">{t('noData')}</p>
        ) : (
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
            <span className="text-muted-foreground">
              {t('thisWeek')}{' '}
              <span className="font-semibold tabular-nums text-foreground">
                {fmt(thisWeek)}
              </span>
            </span>
            <span className="flex items-center gap-1.5 text-muted-foreground">
              {t('lastWeek')} <span className="tabular-nums">{fmt(lastWeek)}</span>
              {delta != null && delta !== 0 ? (
                <span
                  className={cn(
                    'inline-flex items-center gap-0.5 font-medium tabular-nums',
                    faster
                      ? 'text-emerald-700 dark:text-emerald-300'
                      : 'text-rose-700 dark:text-rose-300',
                  )}
                >
                  {faster ? (
                    <TrendingDown className="h-3.5 w-3.5" />
                  ) : (
                    <TrendingUp className="h-3.5 w-3.5" />
                  )}
                  {fmt(Math.abs(delta))}
                </span>
              ) : null}
            </span>
            <span
              className={cn(
                'rounded-full border px-2 py-0.5 text-xs font-medium tabular-nums',
                softBadge(underTarget ? 'success' : 'danger'),
              )}
            >
              {underTarget
                ? t('target', { minutes: thresholdMinutes })
                : t('over', { minutes: thresholdMinutes })}
            </span>
          </div>
        )}
      </div>
    </section>
  )
}

function fmt(mins: number | null): string {
  if (mins == null) return '—'
  if (mins < 1) return `${Math.max(1, Math.round(mins * 60))}s`
  if (mins < 60) return `${mins.toFixed(1)}m`
  return `${(mins / 60).toFixed(1)}h`
}
