'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'

// ============================================================
// SnapshotAge — the honesty line under the dashboard's KPI tiles.
//
// Those tiles are no longer a live subscription. They read one row that
// the `dashboard-snapshot` cron rebuilds every two minutes, which is what
// took the route's tile query from 1,882 document reads to 1. The lag is
// invisible in what the tiles MEAN (day-scale figures on a screen someone
// leaves open) but it is still real, and a figure that silently lags is a
// figure a reader will eventually be caught out by. So the page states the
// age instead of implying there is none.
//
// `computedAtMs: null` is a genuine state, not an error: no snapshot row
// exists yet, because the backend was just deployed or the account was
// created since the last tick. It resolves itself within one interval, so
// it is phrased as "preparing" rather than as a failure.
// ============================================================

/** How often the rendered age re-computes. The cron writes every two
 *  minutes, so a 30s tick is fine enough that the label is never more than
 *  half a minute out of date, without re-rendering for no reason. */
const TICK_MS = 30_000

export function SnapshotAge({ computedAtMs }: { computedAtMs: number | null }) {
  const t = useTranslations('Dashboard.page')
  // Not derived at render time: with no ticker the label would freeze at
  // whatever the age was when the tiles last changed, which on an idle
  // account is indefinitely. Same interval idiom as NeedsAttentionCard.
  const [nowMs, setNowMs] = useState<number>(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), TICK_MS)
    return () => clearInterval(id)
  }, [])

  if (computedAtMs === null) {
    return (
      <p className="text-xs text-muted-foreground">{t('snapshotPreparing')}</p>
    )
  }

  // Clamped at zero: the snapshot is stamped by the server and read by a
  // browser whose clock may sit behind it, and "updated in -1 minutes" is
  // worse than "just now".
  const ageMs = Math.max(0, nowMs - computedAtMs)
  const ageMinutes = Math.floor(ageMs / 60_000)

  return (
    <p className="text-xs text-muted-foreground">
      {ageMinutes < 1
        ? t('snapshotJustNow')
        : ageMinutes < 60
          ? t('snapshotMinutesAgo', { minutes: ageMinutes })
          : t('snapshotHoursAgo', { hours: Math.floor(ageMinutes / 60) })}
    </p>
  )
}
