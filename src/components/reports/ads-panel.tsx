'use client'

import { Fragment, useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { ChevronDown, Megaphone } from 'lucide-react'
import { useQuery } from '@/lib/convex/cached'
import { api } from '../../../convex/_generated/api'
// `AD_ROW_LIMIT` (100) is imported rather than hardcoded so the truncation
// copy below cannot drift from the backend's actual cap. Imported from
// `convex/lib/reportStats`, NOT `convex/reports` — that module is
// database-free (no `ctx`/`db`/`_generated/server`), while `convex/reports`
// pulls in `accountQuery`, every query handler in the file, and the whole
// role-check machinery; importing so much as one constant from it here
// would ship all of that to the browser to obtain one integer. Same fix
// `conversations-panel.tsx` needed for `STATUS_MIX_CAP` — see that panel's
// identical comment.
import { AD_ROW_LIMIT } from '../../../convex/lib/reportStats'
import { Skeleton } from '@/components/dashboard/skeleton'
import { EmptyState } from '@/components/dashboard/empty-state'
import { formatCurrency } from '@/lib/currency'
import { downloadCsv } from '@/lib/reports/csv'
import { cn } from '@/lib/utils'
import type { ReportPanelProps } from '@/lib/reports/types'

type SortKey =
  | 'conversations'
  | 'firstTouchLeads'
  | 'qualified'
  | 'purchased'
  | 'saleValue'

// `tooltipKey` is the caveat a column cannot be read correctly without.
// Two columns carry one; the rest are what they say. Kept on the column
// definition rather than as a ternary at the render site so adding a
// third does not deepen a nested conditional.
const COLUMNS: { key: SortKey; labelKey: string; tooltipKey?: string }[] = [
  { key: 'conversations', labelKey: 'ads.conversations' },
  {
    key: 'firstTouchLeads',
    labelKey: 'ads.firstTouchLeads',
    tooltipKey: 'ads.firstTouchLeadsTooltip',
  },
  { key: 'qualified', labelKey: 'ads.qualified' },
  { key: 'purchased', labelKey: 'ads.purchased' },
  { key: 'saleValue', labelKey: 'ads.value', tooltipKey: 'ads.valueNote' },
]

/**
 * Ads panel: `api.reports.adPerformance`'s per-ad table — which
 * Click-to-WhatsApp ads produced conversations in the window, and what
 * those conversations went on to do (qualified / purchased / sale value).
 *
 * THREE WAYS TO COUNT AN "AD CONVERSATION", AND NONE IS A SUBTOTAL OF
 * ANOTHER. See docs/superpowers/specs/2026-08-05-reports-section-design.md
 * ("Three ways to count an ad conversation") before touching any copy here:
 *   - Conversations tab's `conversationsStartedAd` — per CONVERSATION,
 *     counted once, and only if the conversation's earliest referral was
 *     an ad;
 *   - this panel's `conversations` column — per AD, so one conversation
 *     touched by three different ads contributes a row to each of the
 *     three;
 *   - `firstTouchLeads` below — per CONTACT: the contact's first-ever ad
 *     referral. Not the same population as either figure above.
 * `sum(rows.conversations)` is not reconcilable with `conversationsStartedAd`
 * in either direction — see `adPerformance`'s own doc comment in
 * convex/reports.ts for the exact mechanics (an "ad" referral with no
 * `adId` bumps one counter while being dropped from this table entirely).
 * That is why this panel carries a standing counting-method note instead of
 * a totals row, and why `firstTouchLeads` is never labelled bare "Leads" —
 * see its own column comment below.
 *
 * THE VALUE COLUMN DIVERGES FROM THE FUNNEL TAB, for two independent
 * reasons, and `ads.valueNote` states both because the CSV export below
 * hands the reader that column in a spreadsheet where summing it is one
 * keystroke:
 *   - it attributes a conversation's FULL sale value to every ad that
 *     touched it (convex/reports.ts:449 adds `saleByConversation` once per
 *     ad the conversation appears under), so the column is a per-ad
 *     attribution, not an additive decomposition of revenue;
 *   - it omits the legacy `conversionEvents` value fallback that
 *     `funnelOverview` applies (convex/reports.ts:766), so a pre-`saleValue`
 *     purchase counts on the Funnel tab and not here.
 * The divergence is deliberate and the set of causes is closed — do not
 * add copy or arithmetic implying the two tabs can be reconciled.
 */
export function AdsPanel({ reportWindow, canRead }: ReportPanelProps) {
  const t = useTranslations('Reports')
  const [sortKey, setSortKey] = useState<SortKey>('conversations')
  const [expanded, setExpanded] = useState<string | null>(null)

  const data = useQuery(
    api.reports.adPerformance,
    canRead
      ? { sinceMs: reportWindow.sinceMs, untilMs: reportWindow.untilMs }
      : 'skip',
  )

  // Sorting is purely client-side over what the server already truncated by
  // conversations descending (see `adPerformance`'s doc comment in
  // convex/reports.ts). Re-sorting can reorder these rows but can never
  // surface an ad outside the returned set — the rows returned are always
  // the top `AD_ROW_LIMIT` by volume, regardless of how the table is then
  // displayed.
  const rows = useMemo(
    () => [...(data?.rows ?? [])].sort((a, b) => b[sortKey] - a[sortKey]),
    [data?.rows, sortKey],
  )

  if (data === undefined) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-10 w-full rounded-lg" />
        <Skeleton className="h-64 w-full rounded-xl" />
      </div>
    )
  }

  const resolutionBacklog =
    data.resolution.pending + data.resolution.dormant + data.resolution.abandoned

  // Honesty gate: `byAd` in `adPerformance`'s handler only ever creates a
  // row when at least one ad referral landed on it, so an empty `rows`
  // means an empty WINDOW (no ad referrals at all), not every ad happening
  // to net zero conversions. Render an empty state, never a table of
  // zeros — see the design doc's "An empty range renders an empty state"
  // requirement.
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={Megaphone}
        title={t('ads.emptyTitle')}
        hint={t('ads.emptyHint')}
      />
    )
  }

  return (
    <div className="space-y-3">
      {resolutionBacklog > 0 && (
        <div className="rounded-lg border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
          {/* Unnamed ads are the resolver's state, not an error. Surfacing
              the counts explains WHY some rows below show a bare id. */}
          {t('ads.resolutionBacklog', {
            pending: data.resolution.pending,
            dormant: data.resolution.dormant,
            abandoned: data.resolution.abandoned,
          })}
        </div>
      )}

      <div className="overflow-hidden rounded-xl border border-border bg-card">
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border p-4">
          <div>
            <h2 className="text-sm font-medium text-foreground">{t('ads.title')}</h2>
            {/* Standing disclaimer, not conditional on anything — the
                triple-counting this describes is true on every render, not
                just when something looks off. See this component's own
                doc comment for the exact mechanics. Deliberately no totals
                row anywhere in this panel, for the same reason. */}
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t('ads.countingNote')}
            </p>
            {/* The money half of the same standing disclaimer, and the
                one part of the counting story the product did not say
                anywhere: `ads.countingNote` covers conversations and the
                Funnel tab's `recordedValueNote` covers organic-vs-Meta,
                but neither says the Value column is non-additive AND
                narrower than the Funnel tab's recorded value. Visible
                copy, not only the column tooltip — the CSV button
                directly beside this exports that column. */}
            <p className="mt-0.5 max-w-2xl text-xs text-muted-foreground">
              {t('ads.valueNote')}
            </p>
          </div>
          <button
            type="button"
            className="rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground"
            onClick={() =>
              downloadCsv(
                'ads.csv',
                [
                  'campaign',
                  'ad_set',
                  'ad',
                  'ad_id',
                  'conversations',
                  'first_touch_contacts',
                  'qualified',
                  'purchased',
                  'value',
                  'services',
                ],
                rows.map((r) => [
                  r.campaignName,
                  r.adSetName,
                  r.adName,
                  r.adId,
                  r.conversations,
                  r.firstTouchLeads,
                  r.qualified,
                  r.purchased,
                  r.saleValue,
                  r.serviceKeys.join(' | '),
                ]),
              )
            }
          >
            {t('exportCsv')}
          </button>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-xs text-muted-foreground">
                <th className="px-4 py-2 text-left font-medium">{t('ads.ad')}</th>
                {COLUMNS.map((col) => (
                  <th
                    key={col.key}
                    className="px-4 py-2 text-right font-medium"
                    // The sort is always descending (`b[key] - a[key]`),
                    // so there is no ascending state to report. Every
                    // sortable header carries the attribute — "none" on
                    // the inactive ones is what tells a screen reader
                    // they are sortable at all, rather than leaving the
                    // sorted column's state unannounced.
                    aria-sort={col.key === sortKey ? 'descending' : 'none'}
                  >
                    <button
                      type="button"
                      onClick={() => setSortKey(col.key)}
                      // Caveats a column cannot be read correctly without
                      // — `firstTouchLeads` is a per-CONTACT figure
                      // sitting in a per-ad row, and `saleValue` is
                      // non-additive and narrower than the Funnel tab's.
                      // Tooltip only as a convenience; both are stated in
                      // visible copy above the table.
                      title={col.tooltipKey ? t(col.tooltipKey) : undefined}
                      className={cn(
                        'hover:text-foreground',
                        col.key === sortKey && 'text-foreground',
                      )}
                    >
                      {t(col.labelKey)}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const isOpen = expanded === row.adId
                return (
                  <Fragment key={row.adId}>
                    <tr
                      onClick={() => setExpanded(isOpen ? null : row.adId)}
                      className="cursor-pointer border-b border-border last:border-0 hover:bg-muted/40"
                    >
                      <td className="px-4 py-2">
                        <div className="flex items-center gap-2">
                          {/* The drill-in's keyboard entry point. A real
                              <button> rather than the repo's
                              role="button"+tabIndex+onKeyDown div shape
                              (contacts/import-modal.tsx), because that
                              shape applied to the <tr> would strip the
                              row of its row/cell semantics — every cell
                              would fold into one button label, and the
                              `aria-sort` on the column headers above
                              would be describing a table whose rows are
                              no longer rows. The row keeps its onClick
                              so a mouse can still hit anywhere on it;
                              `stopPropagation` stops that handler
                              double-toggling on top of this one. */}
                          <button
                            type="button"
                            aria-expanded={isOpen}
                            aria-label={t('ads.toggleDetails', {
                              ad: row.adName ?? row.adId,
                            })}
                            onClick={(e) => {
                              e.stopPropagation()
                              setExpanded(isOpen ? null : row.adId)
                            }}
                            className="shrink-0 rounded text-muted-foreground hover:text-foreground"
                          >
                            <ChevronDown
                              className={cn(
                                'h-3.5 w-3.5 transition-transform',
                                isOpen && 'rotate-180',
                              )}
                            />
                          </button>
                          <div className="min-w-0">
                            {row.adName ? (
                              <p className="truncate text-foreground">{row.adName}</p>
                            ) : (
                              // The name has not resolved. Show the real id
                              // rather than a placeholder — an operator can
                              // look that up in Meta; "Unknown ad" helps
                              // nobody.
                              <p
                                className="truncate font-mono text-xs text-muted-foreground"
                                title={t('ads.unresolved')}
                              >
                                {row.adId}
                              </p>
                            )}
                            <p className="truncate text-xs text-muted-foreground">
                              {[row.campaignName, row.adSetName]
                                .filter(Boolean)
                                .join(' › ') || '—'}
                            </p>
                          </div>
                        </div>
                      </td>
                      {/* `.toLocaleString()` on every count, matching the
                          MetricCard tiles on the other four tabs — bare
                          numbers here made "1234" on one tab and "1,234"
                          on the next read as two different products.
                          `formatCurrency` already groups. */}
                      <td className="px-4 py-2 text-right tabular-nums">
                        {row.conversations.toLocaleString()}
                      </td>
                      <td
                        className="px-4 py-2 text-right tabular-nums"
                        title={t('ads.firstTouchLeadsTooltip')}
                      >
                        {row.firstTouchLeads.toLocaleString()}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums">
                        {row.qualified.toLocaleString()}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums">
                        {row.purchased.toLocaleString()}
                      </td>
                      <td
                        className="px-4 py-2 text-right tabular-nums"
                        title={t('ads.valueNote')}
                      >
                        {formatCurrency(row.saleValue, data.currency)}
                      </td>
                    </tr>
                    {isOpen && (
                      <tr className="border-b border-border bg-muted/20">
                        <td colSpan={COLUMNS.length + 1} className="px-4 py-3">
                          {/* Built entirely from the row already fetched,
                              so expanding costs no additional read. */}
                          <div className="space-y-2">
                            {(
                              [
                                ['ads.conversations', row.conversations],
                                ['ads.qualified', row.qualified],
                                ['ads.purchased', row.purchased],
                              ] as const
                            ).map(([labelKey, count]) => (
                              <div key={labelKey} className="flex items-center gap-3">
                                <span className="w-28 shrink-0 text-xs text-muted-foreground">
                                  {t(labelKey)}
                                </span>
                                <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                                  <div
                                    className="h-full rounded-full bg-primary"
                                    style={{
                                      width: `${
                                        row.conversations === 0
                                          ? 0
                                          : (count / row.conversations) * 100
                                      }%`,
                                    }}
                                  />
                                </div>
                                {/* `min-w-8`, not `w-8`: a grouped
                                    five-digit count is wider than the
                                    fixed track and would overflow it. */}
                                <span className="min-w-8 shrink-0 text-right text-xs tabular-nums">
                                  {count.toLocaleString()}
                                </span>
                              </div>
                            ))}
                            <p className="pt-1 text-xs text-muted-foreground">
                              {t('ads.service')}:{' '}
                              {row.serviceKeys.length > 0 ? row.serviceKeys.join(', ') : '—'}
                            </p>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      {data.truncated > 0 && (
        <p className="text-xs text-muted-foreground">
          {/* The table is capped server-side by conversations descending.
              Saying so — with the REAL cap (`AD_ROW_LIMIT`), not a
              hardcoded "100" that could drift from it — is the difference
              between a top-N view and one that silently implies it is
              exhaustive. */}
          {t('ads.truncated', { limit: AD_ROW_LIMIT, n: data.truncated })}
        </p>
      )}
    </div>
  )
}
