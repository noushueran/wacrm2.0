// Shared client-side types and pure helpers for the /reports section.
//
// `ReportWindow` is the one prop every panel (Tasks 12-15) takes as
// `reportWindow`, so it is defined once here rather than each panel
// re-deriving it with `ReturnType<typeof reportWindow>` — see
// `ReportPanelProps` below.

import { daysAgoStart, lastNDayKeys, localDayKey, mondayIndex } from '@/lib/dashboard/date-utils'

// `activity` sits last deliberately. It is the only tab that is a FEED
// rather than an aggregate over the range picker's window — it ignores
// `reportWindow` entirely (its query takes a row limit, not a window), so
// grouping it with the four windowed tabs at the front would imply the
// range control applies to it. It arrived here from /dashboard, which it
// was slowing down: its query is the one that touches `messages`, and on
// this deployment that table's first read carries a large cold penalty.
export const REPORT_TABS = [
  'conversations',
  'ads',
  'response',
  'funnel',
  'billing',
  // Windowed like the five above, so it sits with them rather than beside
  // `activity` — the range picker genuinely drives it.
  'agents',
  'activity',
] as const
export type ReportTab = (typeof REPORT_TABS)[number]

/**
 * The first local day for which assignment history exists at all.
 *
 * `conversationEvents` — the table behind the Agents tab — records a row
 * only from the moment the assignment-trail code is DEPLOYED. Nothing
 * backfilled it, and nothing can: `conversations.assignedToUserId` is a
 * bare field with no `assignedAt` companion, so there is no record
 * anywhere of when an earlier handover happened.
 *
 * Load-bearing, not trivia. On the 30- and 90-day ranges the window reaches
 * back past this date, and the resulting run of empty bars reads as "the team
 * assigned nothing for three weeks" — a confident, wrong story. The panel
 * shows a note whenever `sinceMs` predates this, so the gap is attributed to
 * missing history rather than to idle agents.
 *
 * PER-DEPLOYMENT, WHICH IS WHY IT IS CONFIGURATION. The date differs per
 * company because each one deploys the trail on its own day — the Amani
 * deployment's is 2026-08-13 (commit 7856d2e). Hardcoding one company's
 * date into a tree that ships to several is how the note comes to claim
 * history that this deployment never recorded, which is the exact
 * confident-wrong-story this constant exists to prevent.
 *
 * Unlike `src/lib/brand.ts` a missing value FALLS BACK rather than throwing:
 * the cost of being wrong here is a mislabelled empty range, not a CRM
 * wearing another company's name, and a Reports tab that refuses to render
 * is worse than one whose caveat is a few days out. `NaN` from an
 * unparseable value would make `sinceMs < floor` always false and silently
 * drop the note, so it is floored to 0 — no note rather than a wrong one.
 *
 * Parsed as local midnight (`new Date(y, m-1, d)`), matching how every other
 * day key in this file is built — see `mondayKeyOf`.
 */
export const ASSIGNMENT_HISTORY_FLOOR_DAY =
  process.env.NEXT_PUBLIC_ASSIGNMENT_HISTORY_FLOOR_DAY?.trim() || '2026-08-13'

export const ASSIGNMENT_HISTORY_FLOOR_MS = (() => {
  const [y, m, d] = ASSIGNMENT_HISTORY_FLOOR_DAY.split('-').map(Number)
  const ms = new Date(y, (m ?? 1) - 1, d ?? 1).getTime()
  return Number.isNaN(ms) ? 0 : ms
})()

export const RANGE_OPTIONS = [7, 30, 90] as const
export type RangeDays = (typeof RANGE_OPTIONS)[number]

export function parseTab(value: string | null): ReportTab {
  return (REPORT_TABS as readonly string[]).includes(value ?? '')
    ? (value as ReportTab)
    : 'conversations'
}

export function parseRange(value: string | null): RangeDays {
  const n = Number(value)
  return (RANGE_OPTIONS as readonly number[]).includes(n) ? (n as RangeDays) : 30
}

/**
 * Day keys, week keys, and the window bounds for a range, all resolved in
 * the caller's local timezone.
 *
 * Local-day boundaries are the CALLER's-timezone concept and a Convex
 * function always runs in UTC, so they are computed here and passed as
 * arguments — the same split `convex/lib/dashboardDate.ts` documents for
 * the server side. Week keys are each week's Monday, matching
 * `localWeekKeyFromMs` in `convex/lib/reportStats.ts`.
 *
 * `untilMs` is the EXCLUSIVE end of the window — see `reportWindow`'s own
 * comment for how it is derived and why the exclusivity is load-bearing.
 */
export type ReportWindow = {
  sinceMs: number
  untilMs: number
  dayKeys: string[]
  weekKeys: string[]
  /**
   * The subset of `weekKeys` whose Mon–Sun week is only PARTIALLY covered
   * by this window — fewer than seven of its days fall inside `dayKeys`.
   *
   * Load-bearing, not metadata. `weekKeys` is derived from `dayKeys`, so
   * the trailing week is partial unless today happens to be a Sunday and
   * the leading week is partial unless the range starts on a Monday — on
   * a 7-day range at weekly granularity BOTH bars are usually partial.
   * A partial week's bar is short because the window clipped it, not
   * because volume fell, and an unlabelled short final bar reads as a
   * collapse that never happened. The spec requires the label explicitly
   * ("A partial leading or trailing week in the selected range is reported
   * as-is and labelled partial") — see the design doc's "Week boundaries".
   */
  partialWeekKeys: string[]
  /** Days of each week key that actually fall inside the range. The
   *  denominator for the active-conversations weekly average — a partial
   *  week must not be divided by 7. */
  daysPerWeek: Record<string, number>
  tzOffsetMinutes: number
}

export function reportWindow(range: RangeDays): ReportWindow {
  const dayKeys = lastNDayKeys(range)
  // How many of each week's seven days the window actually covers.
  // `dayKeys` is a contiguous run, so a count below 7 is exactly "this
  // week is clipped by one of the window's edges" — no separate
  // leading/trailing special-casing, and it stays correct if `dayKeys`
  // ever stops being contiguous.
  const daysPerWeek = new Map<string, number>()
  for (const dayKey of dayKeys) {
    const monday = mondayKeyOf(dayKey)
    daysPerWeek.set(monday, (daysPerWeek.get(monday) ?? 0) + 1)
  }
  return {
    // Inclusive lower bound: local midnight of the first requested day.
    sinceMs: daysAgoStart(range - 1).getTime(),
    // Exclusive upper bound: local midnight of the day AFTER the last
    // requested day (today) — i.e. the start of tomorrow, local.
    // `daysAgoStart` subtracts its argument from today's start, so -1
    // advances a day instead of going back one.
    //
    // This edge is load-bearing, not tidying. Every query in
    // `convex/reports.ts` treats `untilMs` as EXCLUSIVE, and several
    // (`adPerformance`, `funnelOverview`, the `hourOfDay` fold inside
    // `volume`/`responsePerformance`) pool whatever they are handed with
    // no further per-row filter — so a value that isn't strictly past
    // today's own midnight would silently drop today's data, and a value
    // rounded to today's midnight instead of tomorrow's would do exactly
    // that. See `convex/reports.ts`'s `readHours` doc comment for the
    // server side of this same contract.
    untilMs: daysAgoStart(-1).getTime(),
    dayKeys,
    weekKeys: [...daysPerWeek.keys()],
    partialWeekKeys: [...daysPerWeek.entries()]
      .filter(([, days]) => days < 7)
      .map(([monday]) => monday),
    daysPerWeek: Object.fromEntries(daysPerWeek),
    tzOffsetMinutes: new Date().getTimezoneOffset(),
  }
}

/** Every panel's props. Declared once here so the five panels (Tasks
 *  12-15) cannot drift from each other.
 *
 *  Named `reportWindow`, not `window` — the obvious name shadows the
 *  global `window` object in every panel that destructures its props,
 *  which is exactly what the field was originally called before this
 *  correction. */
export type ReportPanelProps = { reportWindow: ReportWindow; canRead: boolean }

/**
 * The Monday (as a local `YYYY-MM-DD` key) of the week containing a local
 * day key. Stays entirely in LOCAL `Date` semantics throughout —
 * construction via `new Date(y, m-1, d)`, `mondayIndex`'s local
 * `getDay()`, and `localDayKey`'s local getters — so it needs no explicit
 * offset and cannot drift the way mixing UTC-based construction with
 * local-getter formatting would (a UTC-midnight instant read back through
 * local getters lands on the wrong calendar day for any negative UTC
 * offset, i.e. any timezone west of Greenwich).
 */
function mondayKeyOf(dayKey: string): string {
  const [y, m, d] = dayKey.split('-').map(Number)
  const date = new Date(y, m - 1, d)
  date.setDate(date.getDate() - mondayIndex(date))
  return localDayKey(date)
}
