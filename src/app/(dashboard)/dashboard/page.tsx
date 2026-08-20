"use client"

import { useMemo } from 'react'
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

import { startOfLocalDay, daysAgoStart } from '@/lib/dashboard/date-utils'

import { MetricCard } from '@/components/dashboard/metric-card'
import { SkeletonCard } from '@/components/dashboard/skeleton'
import { LeadSpendCard } from '@/components/dashboard/lead-spend-card'
import { MyCoachingCard } from '@/components/dashboard/my-coaching-card'
import { QuickActions } from '@/components/dashboard/quick-actions'
import { NeedsAttentionCard } from '@/components/dashboard/needs-attention-panel'
import { SnapshotAge } from '@/components/dashboard/snapshot-age'

import { useTranslations } from 'next-intl'

// ============================================================
// /dashboard — the operational home screen.
//
// WHAT THIS PAGE IS FOR, since that is what decides what may live on it:
// the things a salesperson ACTS on. A queue to work, four numbers that set
// the day's context, and the buttons that start work. Analysis — charts,
// trends, feeds, anything a reader studies rather than acts on — lives at
// /reports, where waiting for a computation is the accepted bargain.
//
// This page used to carry both, and paid for it. It fired NINE concurrent
// Convex subscriptions on mount; measured against production data the two
// worst were `dashboard.metrics` at 1,882 document reads / ~8s and
// `qualification.leadsBoard` at 1,668 reads / ~2.4 MB — the latter to draw
// a stage bar the reader takes ten numbers off. Worse, the metrics query
// scanned ~1,300 `messages` rows for a figure NO tile rendered, and on this
// deployment the first read to touch `messages` pays a large cold penalty
// (measured: 12.7s for a single document, ~1.4s warm). The route's
// time-to-content was therefore set almost entirely by work nobody was
// waiting for.
//
// What moved to /reports: the conversations chart (the Conversations tab's
// volume series is a strict superset of it), the leads pipeline card (Funnel
// tab, rebuilt on a cheap aggregate), response performance (Response tab),
// and the activity feed (its own tab).
//
// What is left fires four subscriptions, measured on production data at
// ~51 document reads between them, against roughly 4,000 before:
//
//   dashboard.snapshot        1  — one indexed point read of the cron row
//   conversations.list       50  — the Needs Attention queue
//   leadCharges.report        0  — returns early while `leadValue` is unset
//   salesCoach.forMe          0  — take(N) over an empty table
//
// The last two still SUBSCRIBE even though they usually render nothing —
// they decide whether to show themselves from the result — so they are
// four subscriptions, not two. They are cheap rather than absent.
//
// Needs Attention deliberately stays live rather than joining the
// snapshot: it is the one thing on this page someone acts on immediately,
// and a work queue that lags is a work queue that misroutes.
// ============================================================

export default function DashboardPage() {
  const t = useTranslations('Dashboard.page')
  // `accountId` is the account-readiness signal: `accountQuery` (which
  // backs `api.dashboard.snapshot`) derives the account server-side and
  // THROWS `NO_ACCOUNT`/`UNAUTHENTICATED` if a query runs before the
  // caller's membership resolves. Gating on `accountId` (via the "skip"
  // sentinel) means it only ever fires once the account is known, so a
  // fresh sign-in shows skeletons instead of a thrown error.
  const { defaultCurrency, accountId } = useAuth()

  // Local-day boundaries are the caller's-timezone concept, so they are
  // computed here and passed to the UTC-only backend — see
  // convex/dashboard.ts. Same arg contract the old live `metrics` query
  // had; what changed is that they now fold a stored 72-hour rollup rather
  // than driving three fresh table scans. Memoised so "today" is captured
  // once per account rather than drifting every render.
  const snapshotArgs = useMemo(
    () =>
      accountId
        ? {
            todayStartMs: startOfLocalDay().getTime(),
            yesterdayStartMs: daysAgoStart(1).getTime(),
          }
        : ('skip' as const),
    [accountId],
  )

  const snapshotData = useQuery(api.dashboard.snapshot, snapshotArgs)
  // Three states, not two. `undefined` is "still loading" (render
  // skeletons); `null` is "the cron has not built this account's row yet"
  // — a real state on a freshly deployed backend or a brand-new account,
  // and one the tiles must NOT render as zeros, which would read as "no
  // work today" rather than "not computed yet".
  const loading = snapshotData === undefined
  const snapshot = snapshotData ?? null

  return (
    <div className="space-y-5">
      {/* No in-page title — the header now carries "Dashboard". */}

      {/* Metric cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {loading || !snapshot ? (
          <>
            <SkeletonCard />
            <SkeletonCard />
            <SkeletonCard />
            <SkeletonCard />
          </>
        ) : (
          <>
            <MetricCard
              title={t('waitingOnReply')}
              value={snapshot.waitingOnReply.toLocaleString()}
              icon={Clock}
              subtitle={t('awaitingReply')}
            />
            <MetricCard
              title={t('activeConversations')}
              // `capped` means the backend stopped counting at its ceiling
              // rather than reading the whole table (see
              // ACTIVE_CONVERSATIONS_CAP in convex/dashboard.ts), so the
              // real figure is higher than `current`. Render "500+" — a
              // bare "500" would read as exact and be wrong.
              value={`${snapshot.activeConversations.current.toLocaleString()}${
                snapshot.activeConversations.capped ? '+' : ''
              }`}
              icon={MessageSquare}
              delta={{
                sign: snapshot.activeConversations.previous,
                label: deltaLabel(
                  snapshot.activeConversations.previous,
                  t('newTodayVsYesterday'),
                  t('noChange', { suffix: t('newTodayVsYesterday') }),
                ),
              }}
            />
            <MetricCard
              title={t('newContactsToday')}
              value={snapshot.newContactsToday.current.toLocaleString()}
              subtitle={t('leadsSplit', {
                ad: snapshot.newLeadsBySource.adToday,
                direct: snapshot.newLeadsBySource.directToday,
              })}
              icon={UserPlus}
            />
            <MetricCard
              title={t('openDealsValue')}
              value={formatCurrency(snapshot.openDealsValue, defaultCurrency)}
              icon={DollarSign}
              subtitle={t('openDeals', { count: snapshot.openDealsCount })}
            />
          </>
        )}
      </div>

      {/* The tiles above are a snapshot, so they carry their age rather
          than presenting a lagging figure as live. Renders the
          not-yet-computed case too, which is why it sits outside the
          `snapshot &&` guard. */}
      {!loading ? <SnapshotAge computedAtMs={snapshot?.computedAtMs ?? null} /> : null}

      {/* Needs attention — the operational queue (open conversations
          awaiting a reply), role-scoped with Unassigned/Mine/All tabs.
          Deliberately live rather than snapshotted: this is the one thing
          on the page someone acts on immediately. */}
      <NeedsAttentionCard />

      {/* Lead spend — self-hides (renders null) until an admin sets a
          positive lead value, so no conditional needed here. */}
      <LeadSpendCard />

      {/* Renders nothing until this person actually has coaching, so it
          never sits on the home screen as a standing reminder of being
          watched. */}
      <MyCoachingCard />

      {/* Quick actions */}
      <QuickActions />
    </div>
  )
}

// ------------------------------------------------------------

function deltaLabel(delta: number, suffix: string, noChangeLabel: string): string {
  if (delta === 0) return noChangeLabel
  const sign = delta > 0 ? '+' : ''
  return `${sign}${delta.toLocaleString()} ${suffix}`
}
