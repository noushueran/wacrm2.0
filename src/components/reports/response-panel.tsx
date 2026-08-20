'use client'

import { useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { Clock, Gauge, Target, TrendingUp } from 'lucide-react'
import { useQuery } from '@/lib/convex/cached'
import { api } from '../../../convex/_generated/api'
// `AWAITING_SAMPLE_CAP` (500) is imported rather than hardcoded so the
// capped-backlog copy below cannot drift from the backend's actual
// ceiling. Imported from `convex/lib/reportStats`, NOT `convex/reports` —
// that module is database-free (no `ctx`/`db`/`_generated/server`), while
// `convex/reports` pulls in `accountQuery`, every query handler in the
// file, and the whole role-check machinery; importing so much as one
// constant from it here would ship all of that to the browser to obtain
// one integer. Same fix `conversations-panel.tsx` (`STATUS_MIX_CAP`) and
// `ads-panel.tsx` (`AD_ROW_LIMIT`) needed — see either panel's identical
// comment.
import { AWAITING_SAMPLE_CAP } from '../../../convex/lib/reportStats'
import { MetricCard } from '@/components/dashboard/metric-card'
import { SkeletonCard } from '@/components/dashboard/skeleton'
import { EmptyState } from '@/components/dashboard/empty-state'
import { downloadCsv } from '@/lib/reports/csv'
import { cn } from '@/lib/utils'
import type { ReportPanelProps } from '@/lib/reports/types'
import { ResponsePerformance } from '@/components/dashboard/response-performance'
import { daysAgoStart } from '@/lib/dashboard/date-utils'

// Bucket edges the reply-latency histogram is built with (see
// `RESPONSE_BUCKET_EDGES_MINUTES` in convex/lib/reportStats.ts) — the only
// targets `withinTargetRatio` can answer exactly. `TargetMinutes`, not
// `Target` — `Target` is already the lucide icon imported above for the
// "within target" card, and shadowing it with a type of the same name
// invites exactly the confusion this file otherwise goes out of its way to
// avoid.
const TARGETS = [1, 5, 15, 60] as const
type TargetMinutes = (typeof TARGETS)[number]

const AXIS = { fontSize: 11, fill: 'var(--muted-foreground)' } as const
const TOOLTIP_STYLE = {
  background: 'var(--card)',
  border: '1px solid var(--border)',
  borderRadius: 8,
  fontSize: 12,
} as const

// `null` means NO SAMPLES for that figure, which is not the same as a
// zero-minute average. Rendering 0 would claim instant replies on a range
// with no data — the exact opposite of the truth. Module-scope and pure
// (no `t()` dependency), unlike `fmtPercentile` below.
const fmtMinutes = (m: number | null) => (m === null ? '—' : `${m.toFixed(1)} min`)

/**
 * Response panel: `api.reports.responsePerformance`'s reply-latency KPIs
 * (avg / % within a selectable target / p50 / p90), its daily trend and
 * hour-of-day breakdown, plus the live awaiting-reply backlog from
 * `api.reports.awaitingReplyAges`.
 *
 * TWO SAMPLE COUNTS THAT CAN DISAGREE, both by design — see
 * `responsePerformance`'s own doc comment in convex/reports.ts and this
 * repo's reports-section design doc ("Two deploy-window artefacts"). The
 * top-level `data.samples` is HISTOGRAM-derived — the exact denominator
 * `withinTarget`/`p50`/`p90` are computed against — while each point in
 * `data.series` carries its own `responseCount`-derived `samples`, matching
 * `avgMinutes` beside it. `responseCount` shipped before `responseBuckets`,
 * so an hour predating the write path (and, permanently, the single hour
 * straddling the deploy — `backfillResponseBuckets` skips any row that
 * already has a histogram) has a count but no histogram. This panel never
 * blends the two into one figure: the KPI row's sample count and both
 * charts below all key off `seriesSamples` (summed from `series[].samples`,
 * so it matches what the charts actually plot — see that constant's own
 * comment), and a standing note appears under the KPI row whenever the two
 * disagree in EITHER direction, not only when the histogram falls short —
 * see the guard's own comment further down for how an over-count can also
 * happen.
 */
export function ResponsePanel({ reportWindow, canRead }: ReportPanelProps) {
  const t = useTranslations('Reports')
  // 5 minutes matches the existing hardcoded default in
  // `dashboard/response-performance.tsx`, so the two pages agree on day one.
  const [target, setTarget] = useState<TargetMinutes>(5)

  const data = useQuery(
    api.reports.responsePerformance,
    canRead
      ? {
          sinceMs: reportWindow.sinceMs,
          // Required alongside `sinceMs` — `readHours` needs both edges to
          // bound `byHourOfDay`'s pooling pass, which (like `volume`'s
          // `hourOfDay`) has no per-key filter of its own to fall back on,
          // so an unbounded upper read would silently pool hours past the
          // window into it. Correction over the task-14 brief, whose
          // snippet passed only `sinceMs` — the same defect already fixed
          // for `volume`/`adPerformance`/`funnelOverview`.
          untilMs: reportWindow.untilMs,
          keys: reportWindow.dayKeys,
          tzOffsetMinutes: reportWindow.tzOffsetMinutes,
          granularity: 'day' as const,
          targetMinutes: target,
        }
      : 'skip',
  )
  const backlog = useQuery(api.reports.awaitingReplyAges, canRead ? {} : 'skip')
  // Week-over-week averages, re-homed from /dashboard's ResponsePerformance
  // card. Deliberately NOT derived from `data.series` above: this compares
  // calendar weeks (Mon–Sun, this vs last) while `series` is bound to the
  // range picker's window, so on any range that is not exactly the current
  // two weeks the two would answer different questions. It keeps its own
  // fixed 14-day window for that reason, and ignores `reportWindow`.
  const weekOverWeek = useQuery(
    api.dashboard.responseTime,
    canRead
      ? {
          // Today plus the 13 prior days — enough to cover the whole of
          // last week no matter which weekday it is today.
          sinceMs: daysAgoStart(13).getTime(),
          tzOffsetMinutes: reportWindow.tzOffsetMinutes,
        }
      : 'skip',
  )

  // Count-derived total across the window, matching exactly what the two
  // charts below plot (`series[].samples`, all `responseCount`-derived) —
  // used for the avg card's subtitle and the charts' empty gate so every
  // number on this panel that isn't explicitly a histogram figure agrees
  // with the chart under it, rather than quoting the histogram-derived
  // `data.samples` (see this component's own doc comment). May run
  // fractionally behind a hand-summed `byHourOfDay` total at the window's
  // lower edge — `readHours` deliberately over-reads by up to one hour
  // there, and `byHourOfDay` pools all of it while `series` drops whatever
  // falls outside `keys` (the same fringe asymmetry `volume`'s `hourOfDay`
  // has) — not worth a dedicated backend field for a same-hour rounding
  // difference.
  const seriesSamples = useMemo(
    () => data?.series.reduce((sum, p) => sum + p.samples, 0) ?? 0,
    [data],
  )

  if (data === undefined) {
    return (
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <SkeletonCard key={i} />
        ))}
      </div>
    )
  }

  // A percentile is a bucket RANGE, never a point: the histogram knows how
  // many replies fell between two edges but nothing about the distribution
  // inside that gap, so a single interpolated number would be invented
  // precision. `highMinutes: null` is the open-ended top bucket ("over").
  const fmtPercentile = (
    p: { lowMinutes: number; highMinutes: number | null } | null,
  ) =>
    p === null
      ? '—'
      : p.highMinutes === null
        ? t('response.overMinutes', { n: p.lowMinutes })
        : t('response.betweenMinutes', { low: p.lowMinutes, high: p.highMinutes })

  // Both charts fold the same `hours` rows the KPI row's `seriesSamples` is
  // summed from, so one check covers both — the same shape
  // `conversations-panel.tsx`'s `isEmpty` uses for its volume chart and
  // hour heatmap.
  const isEmpty = seriesSamples === 0

  return (
    <div className="space-y-5">
      {/* This week vs last week against the SLA target — the one thing the
          old /dashboard card said that the windowed figures below do not.
          Everything else it showed is a strict subset of this panel. */}
      <ResponsePerformance
        data={weekOverWeek ?? null}
        loading={weekOverWeek === undefined}
        thresholdMinutes={target}
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard
          title={t('response.avg')}
          value={fmtMinutes(data.avgMinutes)}
          icon={Clock}
          subtitle={t('response.samples', { n: seriesSamples })}
        />
        <MetricCard
          title={t('response.withinTarget', { n: target })}
          value={
            data.withinTarget === null
              ? '—'
              : `${Math.round(data.withinTarget * 100)}%`
          }
          icon={Target}
        />
        <MetricCard title={t('response.p50')} value={fmtPercentile(data.p50)} icon={Gauge} />
        <MetricCard title={t('response.p90')} value={fmtPercentile(data.p90)} icon={TrendingUp} />
      </div>

      {/* Deploy-window caveat (see this component's doc comment). Typically
          true before the owner runs `backfillResponseBuckets`, since a row
          with a count but no histogram makes `data.samples` (histogram)
          fall short of `seriesSamples` (count). But the two can also
          diverge the OTHER way: if a resumed/re-run backfill's clear step
          ever resets a row's count without also resetting its histogram,
          `recordResponseSample`'s additive `addResponseBucket` piles a
          second copy of the histogram on top of the first on replay, so
          `data.samples` can exceed `seriesSamples` too. Comparing with "!=="
          catches both directions rather than assuming only one is possible. */}
      {data.samples !== seriesSamples && (
        <p className="text-xs text-muted-foreground">
          {t('response.histogramCaveat', {
            histogramSamples: data.samples,
            countSamples: seriesSamples,
          })}
        </p>
      )}

      <div className="rounded-xl border border-border bg-card p-5">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-medium text-foreground">{t('response.trendTitle')}</h2>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">{t('response.target')}</span>
            <div className="flex gap-1 rounded-lg border border-border p-1">
              {TARGETS.map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => setTarget(option)}
                  className={cn(
                    'rounded-md px-2.5 py-1 text-xs transition-colors',
                    option === target
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {t('response.minutes', { n: option })}
                </button>
              ))}
            </div>
            <button
              type="button"
              className="rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground"
              onClick={() =>
                downloadCsv(
                  'response.csv',
                  ['period', 'avg_minutes', 'samples'],
                  data.series.map((p) => [p.key, p.avgMinutes, p.samples]),
                )
              }
            >
              {t('exportCsv')}
            </button>
          </div>
        </div>

        {isEmpty ? (
          <EmptyState icon={Clock} title={t('response.emptyTitle')} hint={t('response.emptyHint')} />
        ) : (
          <ResponsiveContainer width="100%" height={240}>
            <LineChart data={data.series} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
              <XAxis dataKey="key" tick={AXIS} tickLine={false} axisLine={false} minTickGap={24} />
              <YAxis tick={AXIS} tickLine={false} axisLine={false} unit="m" />
              <Tooltip contentStyle={TOOLTIP_STYLE} />
              {/* `connectNulls={false}` on purpose: a day with no samples is
                  a GAP, and bridging it would draw a trend line through
                  data that does not exist. */}
              <Line
                type="monotone"
                dataKey="avgMinutes"
                name={t('response.avg')}
                stroke="var(--primary)"
                strokeWidth={2}
                dot={false}
                connectNulls={false}
              />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>

      <div className="rounded-xl border border-border bg-card p-5">
        <h2 className="mb-4 text-sm font-medium text-foreground">{t('response.hourTitle')}</h2>
        {isEmpty ? (
          <EmptyState icon={Clock} title={t('response.emptyTitle')} hint={t('response.emptyHint')} />
        ) : (
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={data.byHourOfDay} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
              <XAxis dataKey="hour" tick={AXIS} tickLine={false} axisLine={false} interval={2} />
              <YAxis tick={AXIS} tickLine={false} axisLine={false} unit="m" />
              <Tooltip contentStyle={TOOLTIP_STYLE} />
              <Bar
                dataKey="avgMinutes"
                name={t('response.avg')}
                fill="var(--primary)"
                radius={[4, 4, 0, 0]}
              />
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>

      {backlog && (
        <div className="rounded-xl border border-border bg-card p-5">
          <h2 className="mb-3 text-sm font-medium text-foreground">
            {t('response.backlogTitle')}
          </h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {(['under1h', 'h1to4', 'h4to24', 'over24h'] as const).map((k) => (
              <div key={k} className="rounded-lg border border-border bg-background p-3">
                <p className="text-xs text-muted-foreground">{t(`response.backlog.${k}`)}</p>
                <p className="mt-1 text-lg font-semibold tabular-nums text-foreground">
                  {backlog[k].toLocaleString()}
                </p>
              </div>
            ))}
          </div>
          {backlog.capped && (
            <p className="mt-3 text-xs text-muted-foreground">
              {t('response.backlogCapped', { limit: AWAITING_SAMPLE_CAP })}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
