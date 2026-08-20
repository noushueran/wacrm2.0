'use client'

import { useQuery } from '@/lib/convex/cached'
import { api } from '../../../convex/_generated/api'
import { ActivityFeed } from '@/components/dashboard/activity-feed'
import type { ReportPanelProps } from '@/lib/reports/types'

/**
 * Activity panel: `api.dashboard.activity` — the interleaved feed of recent
 * customer messages, contacts, deal moves, broadcasts and automation runs.
 *
 * IT LIVED ON /dashboard AND WAS THE SINGLE SLOWEST THING THERE. Not
 * because of its read count — measured at 47 documents, which is nothing —
 * but because it is the dashboard's only query that touches `messages`, and
 * on this deployment that table's first read after a quiet spell carries a
 * large cold-start penalty: measured at 22–26s for this query, and 12.7s
 * for a `.take(1)` returning ONE document (~1.4s warm). A feed nobody acts
 * on was therefore setting the home screen's time-to-content.
 *
 * Here that cost is both rarer and honest: the panel only mounts when
 * someone opens this tab, which is a deliberate "show me what happened"
 * action rather than something that happens on every login.
 *
 * `reportWindow` is accepted to satisfy `ReportPanelProps` and deliberately
 * ignored — `activity` takes a row LIMIT, not a window, so the range picker
 * cannot narrow it. Rather than pretend otherwise, the tab is ordered last
 * (see `REPORT_TABS`) and the panel says what it is showing.
 */
export function ActivityPanel({ canRead }: ReportPanelProps) {
  // Fetch up to 50 so the biggest page-size option in the feed (50 rows)
  // is already in memory — switching sizes is then a pure client slice.
  // `api.dashboard.activity` is supervisor-gated server-side and `useQuery`
  // re-throws FORBIDDEN synchronously during render; with no Error Boundary
  // in this app that crashes the route rather than showing nothing, which
  // is why `canRead` (the page's role floor) gates the subscription.
  const data = useQuery(api.dashboard.activity, canRead ? { limit: 50 } : 'skip')

  return <ActivityFeed items={data ?? null} loading={data === undefined} />
}
