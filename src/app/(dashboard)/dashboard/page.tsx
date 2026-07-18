"use client"

import { useMemo, useState } from 'react'
import { useQuery } from '@/lib/convex/cached'
import { api } from '../../../../convex/_generated/api'
import { useAuth } from '@/hooks/use-auth'
import { formatCurrency } from '@/lib/currency'
import {
  MessageSquare,
  UserPlus,
  DollarSign,
  Clock,
} from 'lucide-react'

import { startOfLocalDay, daysAgoStart, lastNDayKeys } from '@/lib/dashboard/date-utils'
import type { ConversationsSeriesPoint } from '@/lib/dashboard/types'

import { MetricCard } from '@/components/dashboard/metric-card'
import { SkeletonCard } from '@/components/dashboard/skeleton'
import { LeadSpendCard } from '@/components/dashboard/lead-spend-card'
import { QuickActions } from '@/components/dashboard/quick-actions'
import { ConversationsChart } from '@/components/dashboard/conversations-chart'
import { LeadsPipelineCard } from '@/components/dashboard/leads-pipeline-card'
import { ResponsePerformance } from '@/components/dashboard/response-performance'
import { NeedsAttentionCard } from '@/components/dashboard/needs-attention-panel'
import { ActivityFeed } from '@/components/dashboard/activity-feed'

import { useTranslations } from 'next-intl'

type RangeDays = 7 | 30 | 90

export default function DashboardPage() {
  const t = useTranslations('Dashboard.page')
  // `accountId` is the account-readiness signal: `accountQuery` (which
  // backs every `api.dashboard.*` below) derives the account server-side
  // and THROWS `NO_ACCOUNT`/`UNAUTHENTICATED` if a query runs before the
  // caller's membership resolves. Gating each query on `accountId` (via
  // the "skip" sentinel) means they only ever fire once the account is
  // known, so a fresh sign-in shows skeletons instead of a thrown error.
  const { defaultCurrency, accountId, accountRole } = useAuth()

  const [range, setRange] = useState<RangeDays>(30)

  // Local-day boundaries ("today", the chart's day buckets, "this week")
  // are the caller's-timezone concept, so they're computed here in the
  // browser and passed to the UTC-only Convex aggregations — see
  // convex/dashboard.ts and convex/lib/dashboardDate.ts. `tzOffsetMinutes`
  // matches `Date.prototype.getTimezoneOffset()` (the convention those
  // helpers document). Memoised so "today" is captured once (per account /
  // per range), mirroring how the old client-side loader computed it once
  // per fetch rather than drifting every render.
  const metricsArgs = useMemo(
    () =>
      accountId
        ? {
            todayStartMs: startOfLocalDay().getTime(),
            yesterdayStartMs: daysAgoStart(1).getTime(),
          }
        : ('skip' as const),
    [accountId],
  )

  const seriesArgs = useMemo(
    () =>
      accountId
        ? {
            sinceMs: daysAgoStart(range - 1).getTime(),
            dayKeys: lastNDayKeys(range),
            tzOffsetMinutes: new Date().getTimezoneOffset(),
          }
        : ('skip' as const),
    [accountId, range],
  )

  const responseTimeArgs = useMemo(
    () =>
      accountId
        ? {
            // 14-day window (today + 13 prior days) — matches the original
            // loadResponseTime's `daysAgoStart(13)`.
            sinceMs: daysAgoStart(13).getTime(),
            tzOffsetMinutes: new Date().getTimezoneOffset(),
          }
        : ('skip' as const),
    [accountId],
  )

  // Reactive subscriptions. Each returns `undefined` while loading (or
  // while skipped), so `=== undefined` is the per-widget loading flag and
  // each card/chart shows its own skeleton independently — same
  // independent-loading UX the old per-query `finally(setLoading)` gave.
  const metricsData = useQuery(api.dashboard.metrics, metricsArgs)
  const seriesData = useQuery(api.dashboard.conversationsSeries, seriesArgs)
  // The leads-pipeline card self-gates its query; viewers (no lead queue)
  // just get the chart at full width.
  const showLeadsPipeline = accountRole !== 'viewer'
  const responseTimeData = useQuery(api.dashboard.responseTime, responseTimeArgs)
  // Fetch up to 50 so the biggest page-size option in the feed (50 rows)
  // is already in memory — switching sizes is then a pure client slice.
  const activityData = useQuery(api.dashboard.activity, accountId ? { limit: 50 } : 'skip')
  // Exact, role-scoped count of conversations awaiting a reply — powers the
  // lead "Waiting on reply" KPI. Already deployed (backs the sidebar badge).
  const unreadData = useQuery(api.conversations.unreadTotal, accountId ? {} : 'skip')

  const metrics = metricsData ?? null
  const metricsLoading = metricsData === undefined
  const responseTime = responseTimeData ?? null
  const responseTimeLoading = responseTimeData === undefined
  const activity = activityData ?? null
  const activityLoading = activityData === undefined
  const waiting = unreadData ?? 0
  const waitingLoading = unreadData === undefined

  // ConversationsChart takes a per-range record (its contract, so a
  // future full-cache variant stays a drop-in). We only ever subscribe to
  // the active range — Convex re-subscribes reactively when `range`
  // changes — so fill just that slot; the chart reads `series[range]`.
  const series: Record<RangeDays, ConversationsSeriesPoint[] | null> = {
    7: range === 7 ? (seriesData ?? null) : null,
    30: range === 30 ? (seriesData ?? null) : null,
    90: range === 90 ? (seriesData ?? null) : null,
  }
  const seriesLoading = seriesData === undefined

  return (
    <div className="space-y-5">
      {/* No in-page title — the header now carries "Dashboard". */}

      {/* Metric cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {/* Waiting on reply — the act-now number; loads independently of
            the metrics bundle so it can render as soon as it resolves. */}
        {waitingLoading ? (
          <SkeletonCard />
        ) : (
          <MetricCard
            title={t('waitingOnReply')}
            value={waiting.toLocaleString()}
            icon={Clock}
            subtitle={t('awaitingReply')}
          />
        )}
        {metricsLoading || !metrics ? (
          <>
            <SkeletonCard />
            <SkeletonCard />
            <SkeletonCard />
          </>
        ) : (
          <>
            <MetricCard
              title={t('activeConversations')}
              value={metrics.activeConversations.current.toLocaleString()}
              icon={MessageSquare}
              delta={{
                sign: metrics.activeConversations.previous,
                label: deltaLabel(
                  metrics.activeConversations.previous,
                  t('newTodayVsYesterday'),
                  t('noChange', { suffix: t('newTodayVsYesterday') })
                ),
              }}
            />
            <MetricCard
              title={t('newContactsToday')}
              value={metrics.newContactsToday.current.toLocaleString()}
              icon={UserPlus}
              {...(metrics.newLeadsBySource
                ? {
                    subtitle: t('leadsSplit', {
                      ad: metrics.newLeadsBySource.adToday,
                      direct: metrics.newLeadsBySource.directToday,
                    }),
                  }
                : {
                    delta: {
                      sign:
                        metrics.newContactsToday.current -
                        metrics.newContactsToday.previous,
                      label: deltaLabel(
                        metrics.newContactsToday.current -
                          metrics.newContactsToday.previous,
                        t('vsYesterday'),
                        t('noChange', { suffix: t('vsYesterday') })
                      ),
                    },
                  })}
            />
            <MetricCard
              title={t('openDealsValue')}
              value={formatCurrency(metrics.openDealsValue, defaultCurrency)}
              icon={DollarSign}
              subtitle={t('openDeals', { count: metrics.openDealsCount })}
            />
          </>
        )}
      </div>

      {/* Needs attention — the operational queue (open conversations
          awaiting a reply), role-scoped with Unassigned/Mine/All tabs. */}
      <NeedsAttentionCard />

      {/* Lead spend — self-hides (renders null) until an admin sets a
          positive lead value, so no conditional needed here. */}
      <LeadSpendCard />

      {/* Quick actions */}
      <QuickActions />

      {/* Charts row */}
      {/* items-stretch (the grid default) stretches the two columns to
          match the tallest sibling; adding h-full on each wrapper and
          on the inner panels makes both cards actually fill that
          stretched height so their rounded borders line up. Without
          this, the pipeline card rendered at its natural (shorter)
          height while the line chart drove the row height. */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
        <div className={showLeadsPipeline ? 'h-full lg:col-span-3' : 'h-full lg:col-span-5'}>
          <ConversationsChart
            series={series}
            loading={seriesLoading}
            range={range}
            onRangeChange={setRange}
          />
        </div>
        {showLeadsPipeline ? (
          <div className="h-full lg:col-span-2">
            <LeadsPipelineCard />
          </div>
        ) : null}
      </div>

      {/* Response performance — week-over-week averages vs SLA target. */}
      <ResponsePerformance data={responseTime} loading={responseTimeLoading} />

      {/* Activity feed */}
      <ActivityFeed items={activity} loading={activityLoading} />
    </div>
  )
}

// ------------------------------------------------------------

function deltaLabel(delta: number, suffix: string, noChangeLabel: string): string {
  if (delta === 0) return noChangeLabel
  const sign = delta > 0 ? '+' : ''
  return `${sign}${delta.toLocaleString()} ${suffix}`
}
