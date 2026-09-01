'use client'

import { useTranslations } from 'next-intl'
import { Users, ShoppingCart, DollarSign } from 'lucide-react'
import { useQuery } from '@/lib/convex/cached'
import { api } from '../../../convex/_generated/api'
import { UI_FUNNEL_STAGE_KEYS } from '@/lib/inbox/funnel'
import { MetricCard } from '@/components/dashboard/metric-card'
import { SkeletonCard } from '@/components/dashboard/skeleton'
import { formatCurrency } from '@/lib/currency'
import { downloadCsv } from '@/lib/reports/csv'
import type { ReportPanelProps } from '@/lib/reports/types'
import { LeadsPipelineCard } from '@/components/dashboard/leads-pipeline-card'

/** The four lead-quality milestones, in funnel order. */
const QUALITY_COUNT_KEYS = ['lead', 'mql', 'sql', 'converted'] as const

/** The four rates between them, in the same order. */
const QUALITY_RATE_KEYS = [
  'mqlRate',
  'sqlRate',
  'convertedFromSqlRate',
  'leadToCustomerRate',
] as const

/**
 * A lifecycle rate for display. `null` means the denominator was zero, and
 * it renders as an em dash rather than "0%" — the server deliberately
 * returns null instead of 0 for exactly this reason (see
 * `lifecycleFunnel` in convex/lib/reportStats.ts): "0% of 0 leads became
 * MQL" is a claim the data cannot support, and showing it as 0% is how a
 * quiet window gets misread as a collapse in lead quality.
 */
function formatRate(rate: number | null): string {
  if (rate === null) return '—'
  return `${(rate * 100).toFixed(1)}%`
}

const META_STATUS_KEYS = [
  'sent',
  'pending',
  'dormant',
  'unmatched',
  'error',
  'abandoned',
  'total',
] as const

/**
 * Funnel panel: `api.reports.funnelOverview` — `campaigns.overview`'s body
 * re-homed off its old fixed 365-day window onto the range picker's
 * `reportWindow` (see convex/campaigns.ts, now `@deprecated`, and
 * convex/reports.ts's `funnelOverview` doc comment). Stage-by-stage
 * conversation counts, Meta delivery-status counts, and recorded purchase
 * value — a single aggregate over the window, not a day-by-day series like
 * the other four panels.
 *
 * That shape does NOT excuse it from the spec's "every panel offers CSV
 * export of exactly what is on screen" (design doc, "Export"): eight stage
 * counts, two purchase figures and seven Meta delivery statuses are still
 * seventeen numbers a reader wants in a sheet, and `downloadCsv` is
 * shape-agnostic. Exported as one long section/metric/
 * value table rather than a wide row, because the three groups (funnel
 * stages, purchases, Meta delivery statuses) are not columns of a shared
 * key and flattening them into one row would invent a relationship
 * between them. `recorded_value` ships beside its `currency` for the same
 * reason `formatCurrency` gets one on screen — a bare number in a
 * spreadsheet has no unit.
 *
 * "Recorded value", never "purchase value" alone or anything implying a
 * Meta total: `funnelOverview.purchase.totalValue` reads
 * `funnelTransitions.saleValue`, which exists for ORGANIC conversations
 * too, not `conversionEvents`, which exists only for attributed ones — see
 * that query's own doc comment in convex/reports.ts for the legacy-row
 * fallback. `funnelOverview.purchase.totalValue` and the Ads tab's
 * `sum(adPerformance.rows.saleValue)` can therefore disagree on a
 * pre-`saleValue` row (the Ads tab has no such fallback) — a known, closed,
 * non-growing discrepancy that is not reconciled here. Do not add copy
 * implying the two tabs agree.
 *
 * Deliberately NOT rendered: `purchase.totalValue / purchase.count` as an
 * "average sale value". `count` is distinct-conversations-reaching-
 * `purchased` (every purchase), while `totalValue` sums only the subset
 * with a recorded value (`saleValue` or its legacy `conversionEvents`
 * fallback) — so the quotient would silently under-report whenever any
 * purchase carries no recorded value.
 */
export function FunnelPanel({ reportWindow, canRead }: ReportPanelProps) {
  const t = useTranslations('Reports')
  const tFunnel = useTranslations('Inbox.funnel')

  const data = useQuery(
    api.reports.funnelOverview,
    canRead
      ? { sinceMs: reportWindow.sinceMs, untilMs: reportWindow.untilMs }
      : 'skip',
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

  const byStage = Object.fromEntries(data.funnel.map((f) => [f.stage, f.count]))
  const maxCount = Math.max(1, ...data.funnel.map((f) => f.count))

  return (
    <div className="space-y-5">
      {/* Panel-level, not card-level: this export covers all three
          groups below, so it does not belong in any one card's header
          the way the other panels' series exports do. */}
      <div className="flex justify-end">
        <button
          type="button"
          className="rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground"
          onClick={() =>
            downloadCsv('funnel.csv', ['section', 'metric', 'value'], [
              ...UI_FUNNEL_STAGE_KEYS.map((stage) => [
                'funnel',
                stage,
                byStage[stage] ?? 0,
              ]),
              ...QUALITY_COUNT_KEYS.map((k) => [
                'lead_quality',
                k,
                data.lifecycle[k],
              ]),
              ...QUALITY_RATE_KEYS.map((k) => [
                'lead_quality',
                k,
                // Empty rather than "—" in a sheet: a dash is text and
                // would poison the column's type for the whole export.
                data.lifecycle[k] === null ? '' : data.lifecycle[k]!,
              ]),
              ['purchases', 'count', data.purchase.count],
              ['purchases', 'recorded_value', data.purchase.totalValue],
              ['purchases', 'currency', data.purchase.currency],
              ...META_STATUS_KEYS.map((k) => ['meta_delivery', k, data.meta[k]]),
            ])
          }
        >
          {t('exportCsv')}
        </button>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard
          title={t('funnel.newLeads')}
          value={(byStage.new_lead ?? 0).toLocaleString()}
          icon={Users}
        />
        <MetricCard
          title={t('funnel.qualified')}
          value={(byStage.qualified ?? 0).toLocaleString()}
          icon={Users}
        />
        <MetricCard
          title={t('funnel.purchases')}
          value={data.purchase.count.toLocaleString()}
          icon={ShoppingCart}
        />
        <MetricCard
          title={t('funnel.recordedValue')}
          value={formatCurrency(data.purchase.totalValue, data.purchase.currency)}
          icon={DollarSign}
          subtitle={t('funnel.recordedValueNote')}
        />
      </div>

      {/* Lead quality: the four milestones this CRM reports to Meta, and
          the rates between them. The counts come from the SAME
          first-arrival stage counters as the bars below (so a lead is
          counted once per stage it reached, never per day), projected
          onto the 4-stage lifecycle by `lifecycleFunnel` server-side —
          which is also the mapping the outbox uses, so this card and the
          wire can never disagree about what an MQL is. */}
      <div className="rounded-xl border border-border bg-card p-5">
        <h2 className="text-sm font-medium text-foreground">{t('funnel.qualityTitle')}</h2>
        <p className="mt-1 text-xs text-muted-foreground">{t('funnel.qualityNote')}</p>
        <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
          {QUALITY_COUNT_KEYS.map((k) => (
            <div key={k} className="rounded-lg border border-border bg-background p-3">
              <p className="text-xs text-muted-foreground">{t(`funnel.quality.${k}`)}</p>
              <p className="mt-1 text-lg font-semibold tabular-nums text-foreground">
                {data.lifecycle[k].toLocaleString()}
              </p>
            </div>
          ))}
        </div>
        <div className="mt-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
          {QUALITY_RATE_KEYS.map((k) => (
            <div key={k} className="rounded-lg border border-border bg-background p-3">
              <p className="text-xs text-muted-foreground">{t(`funnel.quality.${k}`)}</p>
              <p className="mt-1 text-lg font-semibold tabular-nums text-foreground">
                {formatRate(data.lifecycle[k])}
              </p>
            </div>
          ))}
        </div>
      </div>

      <div className="rounded-xl border border-border bg-card p-5">
        <h2 className="mb-3 text-sm font-medium text-foreground">{t('funnel.funnelTitle')}</h2>
        <div className="space-y-2">
          {UI_FUNNEL_STAGE_KEYS.map((stage) => {
            const count = byStage[stage] ?? 0
            return (
              <div key={stage} className="flex items-center gap-3">
                <span className="w-32 shrink-0 text-sm text-muted-foreground">
                  {tFunnel(`stage.${stage}`)}
                </span>
                <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-primary"
                    style={{ width: `${(count / maxCount) * 100}%` }}
                  />
                </div>
                {/* Grouped, matching the MetricCard tiles above and the
                    Ads table — and `min-w-10` rather than a fixed `w-10`
                    so a five-digit grouped count cannot overflow the
                    track. */}
                <span className="min-w-10 shrink-0 text-right text-sm tabular-nums text-foreground">
                  {count.toLocaleString()}
                </span>
              </div>
            )
          })}
        </div>
      </div>

      {/* Where deals stand RIGHT NOW, beside the windowed counts above.
          Re-homed from /dashboard, where it was the second-heaviest query
          on the page. The two are complementary, not duplicates: the bars
          above count conversations that REACHED each stage inside the
          selected range (a conversation appears in every stage it passed
          through), while this counts each open deal once, in the stage it
          currently sits in, over all time. It therefore ignores the range
          picker — which is why it carries its own heading rather than
          being folded into the section above. */}
      <LeadsPipelineCard />

      <div className="rounded-xl border border-border bg-card p-5">
        <h2 className="mb-3 text-sm font-medium text-foreground">{t('funnel.metaTitle')}</h2>
        {/* lg:grid-cols-7 so all 7 tiles sit on one desktop row — with 6
            columns the dormant tile would hang alone on a second row.
            Kept exactly as `/campaigns` had it. */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
          {META_STATUS_KEYS.map((k) => (
            <div key={k} className="rounded-lg border border-border bg-background p-3">
              <p className="text-xs text-muted-foreground">{t(`funnel.meta.${k}`)}</p>
              <p className="mt-1 text-lg font-semibold tabular-nums text-foreground">
                {data.meta[k].toLocaleString()}
              </p>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
