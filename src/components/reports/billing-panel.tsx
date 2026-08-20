'use client'

import { useTranslations } from 'next-intl'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { Receipt, Gift } from 'lucide-react'
import { useQuery } from '@/lib/convex/cached'
import { api } from '../../../convex/_generated/api'
// `PRICING_CATEGORY_KEYS` is imported rather than hardcoded so this panel's
// category columns cannot drift from the backend's actual set. Imported
// from `convex/lib/reportStats`, NOT `convex/reports` — that module is
// database-free (no `ctx`/`db`/`_generated/server`), while `convex/reports`
// pulls in `accountQuery`, every query handler in the file, and the whole
// role-check machinery; importing so much as one constant from it here
// would ship all of that to the browser to obtain six strings. Same fix
// `conversations-panel.tsx` (`STATUS_MIX_CAP`), `ads-panel.tsx`
// (`AD_ROW_LIMIT`) and `response-panel.tsx` (`AWAITING_SAMPLE_CAP`) needed
// — see any of those panels' identical comment.
import { PRICING_CATEGORY_KEYS } from '../../../convex/lib/reportStats'
import { MetricCard } from '@/components/dashboard/metric-card'
import { SkeletonCard } from '@/components/dashboard/skeleton'
import { EmptyState } from '@/components/dashboard/empty-state'
import { downloadCsv } from '@/lib/reports/csv'
import type { ReportPanelProps } from '@/lib/reports/types'

const CATEGORIES = PRICING_CATEGORY_KEYS

// Deliberately theme tokens with plain-color fallbacks rather than six
// hardcoded hexes, so the stack stays legible in both light and dark.
const CATEGORY_FILL: Record<(typeof CATEGORIES)[number], string> = {
  marketing: 'var(--chart-1, var(--primary))',
  utility: 'var(--chart-2, var(--primary))',
  service: 'var(--chart-3, var(--muted-foreground))',
  authentication: 'var(--chart-4, var(--muted-foreground))',
  free: 'var(--chart-5, var(--border))',
  other: 'var(--muted-foreground)',
}

/**
 * Billing panel: `api.reports.billing` — Meta conversation-window volumes
 * and billed-message categories from the `messageHourlyStats` rollup. This
 * panel carries more honesty constraints than any other in /reports; see
 * docs/superpowers/specs/2026-08-05-reports-section-design.md's Billing
 * section before touching any copy here.
 *
 * VOLUMES, NEVER MONEY. Meta's webhooks carry billing categories and
 * counts, never rate-card amounts, so nothing rendered below is (or
 * implies) a currency figure. Stated plainly in the note banner below —
 * not decoration: saying it in-product is the only way the constraint
 * survives someone screenshotting a single tile out of context.
 *
 * `metaConversations` IS NOT A BILLABLE COUNT and must never be labelled
 * one. The write path (`messages.bumpMetaConversationStats`) fires on
 * every newly-seen `conversationMetaId` with no billability test, so
 * free-entry-point windows are INSIDE it — `freeEntryPointConversations`
 * is a subset, not a sibling. This panel renders the billable figure as a
 * clearly-labelled DERIVATION (`metaConversations -
 * freeEntryPointConversations`), with both source numbers displayed beside
 * it, so the subtraction is legible rather than a reader being able to add
 * the "billable" and "free" tiles together and land on a number that
 * double-counts the free ones.
 *
 * BILLING IS FORWARD-ONLY. Unlike every other rollup counter in this
 * report, `metaConversations` / `freeEntryPointConversations` /
 * `billedMessagesByCategory` have no backfill (see the plan's Task 5) —
 * every period before the write path deployed reads zero. "Not collected"
 * and "nothing happened" must therefore never render identically, and
 * `billing.backfillNote` is what keeps them apart.
 *
 * The all-zero range is NOT the only case that needs it, and was not even
 * the common one: on day one every account's 30- and 90-day range spans
 * the deploy, so the chart ramps from a flat run of zeros into real data
 * — the same shape as "we had no traffic last month", with nothing on
 * screen to tell them apart. There is no stored "collection started"
 * timestamp to test against, so the note is gated on the honest
 * approximation of one: `showsBackfillNote` below — the range's EARLIEST
 * period carries no billing data at all. If the first period has data,
 * collection demonstrably began at or before this range's start and the
 * note would be noise; otherwise the leading zeros are indistinguishable
 * from pre-collection and the reader must be told. Interior zero periods
 * are deliberately NOT tested: a quiet Tuesday between two busy ones is
 * an ordinary gap, and treating it as a collection boundary would fire
 * the note on almost every range and train readers to ignore it.
 */
export function BillingPanel({ reportWindow, canRead }: ReportPanelProps) {
  const t = useTranslations('Reports')

  const data = useQuery(
    api.reports.billing,
    canRead
      ? {
          sinceMs: reportWindow.sinceMs,
          untilMs: reportWindow.untilMs,
          keys: reportWindow.dayKeys,
          tzOffsetMinutes: reportWindow.tzOffsetMinutes,
          granularity: 'day' as const,
        }
      : 'skip',
  )

  if (data === undefined) {
    return (
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <SkeletonCard />
        <SkeletonCard />
      </div>
    )
  }

  const categoryTotal = CATEGORIES.reduce(
    (sum, key) => sum + data.totals.categories[key],
    0,
  )
  // Both written by DIFFERENT branches of `applyStatusPricing` (see the
  // design doc's rollup-extension table), so one can be zero while the
  // other isn't — an existing conversation window taking a new message
  // bumps `billedMessagesByCategory` with no new `metaConversations`.
  // Checking both is the real "nothing at all happened OR was collected"
  // gate, not `metaConversations` alone.
  const isEmpty = data.totals.metaConversations === 0 && categoryTotal === 0
  // Same "did anything at all land in this bucket" test as `isEmpty`
  // above, per period rather than over the range's totals.
  const hasBillingData = (p: (typeof data.series)[number]) =>
    p.metaConversations > 0 ||
    p.freeEntryPointConversations > 0 ||
    CATEGORIES.some((key) => p.categories[key] > 0)
  // True when the range's EARLIEST period has no billing data — i.e. it
  // may predate collection, and every zero before the first real datapoint
  // is unattributable. Covers the all-zero range (`findIndex` returns -1)
  // and the far more common partial one (a positive index) with the same
  // test. See this component's doc comment for why interior gaps are not
  // treated as collection boundaries.
  const showsBackfillNote = data.series.findIndex(hasBillingData) !== 0
  // Defensive, not a known deploy-window artefact like
  // `conversations-panel.tsx`'s `conversationsStartedDirect` clamp: both
  // counters are written from the SAME `applyStatusPricing` branch (see
  // that query's doc comment in convex/reports.ts), so
  // `freeEntryPointConversations` should never exceed `metaConversations`
  // in practice. Clamped anyway so a display bug can never read as a
  // negative billable count.
  const billableConversations = Math.max(
    0,
    data.totals.metaConversations - data.totals.freeEntryPointConversations,
  )

  // Flatten `categories` up one level so recharts can address each as a
  // dataKey.
  const chartData = data.series.map((p) => ({ key: p.key, ...p.categories }))

  return (
    <div className="space-y-5">
      {/* Not decoration. Meta's webhooks carry billing CATEGORIES and
          COUNTS, never rate-card amounts, so this panel must never be read
          as spend. Saying it in-product is the only way that survives
          someone screenshotting a tile. */}
      <div className="rounded-lg border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
        <p>{t('billing.note')}</p>
        {/* Page-level, not chart-level: the forward-only gap distorts the
            two tiles below just as much as the chart, since both are
            summed over the same periods. Rendered only when the chart is
            — the empty case shows the identical note as the EmptyState's
            hint further down, so the two placements are mutually
            exclusive and the note never appears twice. */}
        {showsBackfillNote && !isEmpty && (
          <p className="mt-2">{t('billing.backfillNote')}</p>
        )}
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <MetricCard
          title={t('billing.billableConversations')}
          value={billableConversations.toLocaleString()}
          icon={Receipt}
          subtitle={t('billing.billableNote', {
            total: data.totals.metaConversations,
            free: data.totals.freeEntryPointConversations,
          })}
        />
        <MetricCard
          title={t('billing.freeEntryPoint')}
          value={data.totals.freeEntryPointConversations.toLocaleString()}
          icon={Gift}
          subtitle={t('billing.freeEntryPointNote')}
        />
      </div>

      <div className="rounded-xl border border-border bg-card p-5">
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="text-sm font-medium text-foreground">
            {t('billing.categoriesTitle')}
          </h2>
          <button
            type="button"
            className="rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground"
            onClick={() =>
              downloadCsv(
                'billing.csv',
                [
                  'period',
                  'meta_conversations',
                  'free_entry_point',
                  'billable_conversations',
                  ...CATEGORIES,
                ],
                data.series.map((p) => [
                  p.key,
                  p.metaConversations,
                  p.freeEntryPointConversations,
                  Math.max(0, p.metaConversations - p.freeEntryPointConversations),
                  ...CATEGORIES.map((c) => p.categories[c]),
                ]),
              )
            }
          >
            {t('exportCsv')}
          </button>
        </div>

        {isEmpty ? (
          <EmptyState
            icon={Receipt}
            title={t('billing.emptyTitle')}
            // The billing counters are forward-only by design — there is no
            // backfill (see the plan's Task 5). An empty older range means
            // "not collected", not "nothing happened", and this hint is
            // what stops the two from reading the same. `showsBackfillNote`
            // is always true here (an all-zero range has no period with
            // data), so this is the empty-case half of the same note — the
            // banner above renders the other half.
            hint={t('billing.backfillNote')}
          />
        ) : (
          <>
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                <XAxis
                  dataKey="key"
                  tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
                  tickLine={false}
                  axisLine={false}
                  minTickGap={24}
                />
                <YAxis
                  tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
                  tickLine={false}
                  axisLine={false}
                  allowDecimals={false}
                />
                <Tooltip
                  contentStyle={{
                    background: 'var(--card)',
                    border: '1px solid var(--border)',
                    borderRadius: 8,
                    fontSize: 12,
                  }}
                />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                {CATEGORIES.map((key, i) => (
                  <Bar
                    key={key}
                    stackId="categories"
                    dataKey={key}
                    name={t(`billing.category.${key}`)}
                    fill={CATEGORY_FILL[key]}
                    radius={i === CATEGORIES.length - 1 ? [4, 4, 0, 0] : undefined}
                  />
                ))}
              </BarChart>
            </ResponsiveContainer>

            <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
              {CATEGORIES.map((key) => (
                <div key={key} className="rounded-lg border border-border bg-background p-3">
                  <p className="text-xs text-muted-foreground">
                    {t(`billing.category.${key}`)}
                  </p>
                  <p className="mt-1 text-lg font-semibold tabular-nums text-foreground">
                    {data.totals.categories[key].toLocaleString()}
                  </p>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
