'use client'

import { Fragment, useState } from 'react'
import { useTranslations } from 'next-intl'
import { ChevronDown, ExternalLink, Radio } from 'lucide-react'
import { useQuery } from '@/lib/convex/cached'
import { api } from '../../../convex/_generated/api'
import { Skeleton } from '@/components/dashboard/skeleton'
import { EmptyState } from '@/components/dashboard/empty-state'
import { downloadCsv } from '@/lib/reports/csv'
import { cn } from '@/lib/utils'
import type { ReportPanelProps } from '@/lib/reports/types'

/**
 * Events panel: our funnel against Meta's dataset, per event.
 *
 * THE ONE RULE THIS FILE EXISTS TO HOLD: a null `recorded` is UNKNOWN and
 * renders as an em dash with a reason. It is never coerced to 0. Meta
 * having received nothing and our not knowing what Meta received are
 * different claims, and a reconciliation table that conflates them
 * reports a delivery failure that did not happen.
 *
 * Internal-only milestones are shown greyed rather than filtered out —
 * the funnel has eight stages and hiding two implies it has six.
 */
export function EventsPanel({ reportWindow, canRead }: ReportPanelProps) {
  const t = useTranslations('Reports')
  const [expanded, setExpanded] = useState<string | null>(null)

  const data = useQuery(
    api.reports.metaEventReconciliation,
    canRead ? { rangeDays: reportWindow.dayKeys.length } : 'skip',
  )

  if (!data) return <Skeleton className="h-64 w-full" />

  const { rows, meta } = data
  // Meta's side counts too. Gating on our own `reached` alone hid the
  // Recorded column exactly when it carries the most signal: a fresh
  // deployment, or any window where we produced no conversionEvents but
  // Meta's dataset holds events — a positive delta on every row, which
  // the panel would have replaced with "no conversion events in this
  // range".
  const hasEvents = rows.some((r) => r.reached > 0 || (r.recorded ?? 0) > 0)

  // Formats an instant as a date in the DATASET's timezone, never the
  // viewer's — the same rule the counts themselves follow. Printing this
  // window in the viewer's zone would caption the table with a range that
  // disagrees with the numbers under it, which is the exact class of
  // mismatch this tab exists to expose.
  //
  // Shift by the offset, then read the date in UTC: identical to
  // `localDayKeyFromMs`'s arithmetic (local = ms - tzOffsetMinutes*60_000).
  const datasetDate = (ms: number) =>
    new Date(ms - meta.tzOffsetMinutes * 60_000).toLocaleDateString(undefined, {
      day: 'numeric',
      month: 'short',
      timeZone: 'UTC',
    })

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-card p-3">
        <div className="flex items-center gap-2 text-sm">
          <Radio className="h-4 w-4 text-muted-foreground" />
          <span className="text-muted-foreground">
            {t('events.datasetLabel')}
          </span>
          <span className="font-mono text-foreground">
            {meta.datasetId ?? t('events.unknown')}
          </span>
        </div>
        <div className="text-xs text-muted-foreground">
          {meta.tzName
            ? t('events.timezoneNote', { tz: meta.tzName })
            : t('events.timezoneUnknown')}
          {' · '}
          {meta.lastSyncedAt
            ? t('events.lastSynced', {
                when: new Date(meta.lastSyncedAt).toLocaleString(),
              })
            : t('events.neverSynced')}
        </div>
        {/* The window this tab ACTUALLY reconciled, spelled out, because it
            is not the window the range picker implies: it ends on the last
            fully-closed dataset day, so a "30 days" Events view covers a
            different 30 days than a "30 days" Conversations view. Without
            this line the two tabs look comparable and are not.

            `untilMs` is EXCLUSIVE, so the last INCLUDED day is `untilMs - 1`.
            Printing `untilMs` itself would name a day whose counts are not
            in the table. */}
        <div
          className="text-xs text-muted-foreground"
          title={t('events.windowWhy')}
        >
          {t('events.windowNote', {
            from: datasetDate(meta.sinceMs),
            to: datasetDate(meta.untilMs - 1),
          })}
        </div>
        {meta.datasetId && (
          <a
            href={`https://eventsmanager.facebook.com/events_manager2/list/dataset/${meta.datasetId}/overview`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
          >
            {t('events.openEventsManager')}
            <ExternalLink className="h-3 w-3" />
          </a>
        )}
      </div>

      {!meta.available && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-foreground">
          {t('events.unavailable', {
            reason: meta.lastError ?? t('events.neverSynced'),
          })}
        </div>
      )}

      {/* The sync WORKED and simply has not read back this far. Same
          degraded treatment as the unavailable case — every Recorded and
          Δ below is already an em dash, because the query returns null
          rather than a partial sum — but a different explanation, naming
          the range it does cover. Reported separately from `lastError`
          on purpose: this is not an error, and calling it one sends
          someone hunting an outage that does not exist. */}
      {meta.coverageGap !== null && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-foreground">
          {meta.coverageGap
            ? t('events.coverageShort', { covered: meta.coverageGap })
            : t('events.coverageNone')}
        </div>
      )}

      {!hasEvents ? (
        <EmptyState title={t('events.empty')} />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-muted-foreground">
                <th className="px-3 py-2 font-medium">{t('events.colMilestone')}</th>
                <th className="px-3 py-2 font-medium">{t('events.colEvent')}</th>
                <th className="px-3 py-2 text-right font-medium" title={t('events.reachedTooltip')}>{t('events.colReached')}</th>
                <th className="px-3 py-2 text-right font-medium" title={t('events.deliveredTooltip')}>{t('events.colDelivered')}</th>
                <th className="px-3 py-2 text-right font-medium" title={t('events.recordedTooltip')}>{t('events.colRecorded')}</th>
                <th className="px-3 py-2 text-right font-medium">{t('events.colDelta')}</th>
                <th className="w-8" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const internal = row.eventName === null
                const open = expanded === row.stage
                const gap = row.reached - row.delivered
                return (
                  <Fragment key={row.stage}>
                  <tr
                    className={cn(
                      'border-b border-border last:border-0',
                      internal && 'text-muted-foreground',
                    )}
                  >
                    <td className="px-3 py-2">{row.label}</td>
                    <td className="px-3 py-2 font-mono text-xs">
                      {row.eventName ?? t('events.internalOnly')}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{row.reached}</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {internal ? t('events.unknown') : row.delivered}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {/* null is UNKNOWN, never 0 — see this file's header. */}
                      {row.recorded === null ? t('events.unknown') : row.recorded}
                    </td>
                    <td
                      className={cn(
                        'px-3 py-2 text-right tabular-nums',
                        row.delta !== null && row.delta !== 0 && 'text-amber-600',
                      )}
                    >
                      {row.delta === null
                        ? t('events.unknown')
                        : row.delta > 0
                          ? `+${row.delta}`
                          : row.delta}
                    </td>
                    <td className="px-3 py-2">
                      {gap > 0 && (
                        <button
                          type="button"
                          aria-label={t('events.statusBreakdown')}
                          aria-expanded={open}
                          onClick={() => setExpanded(open ? null : row.stage)}
                        >
                          <ChevronDown
                            className={cn('h-4 w-4 transition-transform', open && 'rotate-180')}
                          />
                        </button>
                      )}
                    </td>
                  </tr>
                  {/* The reached-minus-delivered gap, itemised. Only
                      non-zero statuses are listed: a row of zeros is
                      noise, and the whole point of this drawer is to
                      name the one status that accounts for the gap. */}
                  {open && gap > 0 && (
                    <tr className="border-b border-border bg-muted/30">
                      <td colSpan={7} className="px-3 py-2">
                        <div className="text-xs text-muted-foreground">
                          {t('events.statusBreakdown')}
                        </div>
                        <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs">
                          {Object.entries(row.byStatus)
                            .filter(([, count]) => count > 0)
                            .map(([status, count]) => (
                              <li key={status} className="tabular-nums">
                                <span className="font-mono">{status}</span>{' '}
                                {count}
                              </li>
                            ))}
                        </ul>
                      </td>
                    </tr>
                  )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {hasEvents && (
        <button
          type="button"
          onClick={() =>
            downloadCsv(
              'meta-events.csv',
              ['milestone', 'event', 'reached', 'delivered', 'recorded', 'delta'],
              rows.map((r) => [
                r.label,
                r.eventName ?? '',
                r.reached,
                r.delivered,
                // Empty cell, not 0: an unknown must not become a number
                // the moment it leaves the screen for a spreadsheet.
                r.recorded === null ? null : r.recorded,
                r.delta === null ? null : r.delta,
              ]),
            )
          }
          className="text-sm text-primary hover:underline"
        >
          {t('exportCsv')}
        </button>
      )}
    </div>
  )
}
