// Shared result shapes the dashboard components consume. Centralised
// here so each component stays thin and the page-level loader wires
// them up without type gymnastics.

export interface MetricDelta {
  current: number
  previous: number
}

// `MetricsBundle` and `ConversationsSeriesPoint` used to live here, for
// the dashboard's KPI tiles and its conversations chart respectively.
// Both are gone: the tiles now read `api.dashboard.snapshot`, whose return
// type is inferred straight off the Convex function (so it cannot drift
// from the backend the way a hand-written mirror can), and the chart was
// removed outright because /reports' Conversations tab renders a strict
// superset of it. `MetricDelta` and the response shapes below are still
// used, so the file stays.

export interface ResponseTimeBucket {
  /** 0 = Mon … 6 = Sun (Monday-first). */
  dow: number
  /** Average first-response time in minutes. Null means no samples. */
  avgMinutes: number | null
  samples: number
}

export interface ResponseTimeSummary {
  buckets: ResponseTimeBucket[]
  thisWeekAvg: number | null
  lastWeekAvg: number | null
}

export type ActivityKind =
  | 'message'
  | 'deal'
  | 'broadcast'
  | 'automation'
  | 'contact'

export interface ActivityItem {
  id: string
  kind: ActivityKind
  /** Primary line of text rendered in the feed. Pre-formatted. */
  text: string
  /** ISO timestamp the item happened at, drives relative-time + sort. */
  at: string
  /** Optional deep-link for the whole row (not all items have a target). */
  href?: string
}
