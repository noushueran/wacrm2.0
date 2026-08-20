'use client'

import { useState, type ReactNode } from 'react'
import {
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { Megaphone, MessageSquare, MessagesSquare, Send, Users } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { useQuery } from '@/lib/convex/cached'
import { api } from '../../../convex/_generated/api'
// `STATUS_MIX_CAP` (500) is imported rather than hardcoded so the "500+"
// rendered below cannot drift from the backend's actual ceiling. Imported
// from `convex/lib/reportStats`, NOT `convex/reports` — that module is
// database-free (no `ctx`/`db`/`_generated/server`), while `convex/reports`
// pulls in `accountQuery`, every query handler in the file, and the whole
// role-check machinery; importing so much as one constant from it here
// would ship all of that to the browser to obtain one integer.
import { STATUS_MIX_CAP } from '../../../convex/lib/reportStats'
import { MetricCard } from '@/components/dashboard/metric-card'
import { SkeletonCard } from '@/components/dashboard/skeleton'
import { EmptyState } from '@/components/dashboard/empty-state'
import { downloadCsv } from '@/lib/reports/csv'
import type { ReportPanelProps } from '@/lib/reports/types'

/**
 * Conversations panel: `api.reports.volume`'s daily/weekly series split ad
 * vs. direct, messages in vs. out, an hour-of-day heatmap, range totals,
 * and the current open/pending/closed/archived mix from
 * `api.reports.conversationStatusMix`.
 *
 * The headline metric is labelled "New conversations", never
 * "Conversations started" — this CRM is one-conversation-per-contact (every
 * creation path is find-or-create by contact), so the figure counts a
 * contact's FIRST conversation, i.e. first engagement, not thread
 * activity. Owner decision, 2026-08-05 — see docs/superpowers/specs/
 * 2026-08-05-reports-section-design.md ("relabel rather than re-measure").
 *
 * The "Conversations with activity" tile/chart is deliberately NOT labelled
 * "Active conversations", even though that is the field name
 * (`activeConversations`) everywhere in the backend and the brief's own
 * copy. `/dashboard` already has a tile titled "Active Conversations"
 * (`Dashboard.page.activeConversations`) for a different metric — a LIVE
 * count of currently-open threads, capped at 500. This one is a FLOW:
 * distinct threads that saw any message, in or out, during the selected
 * range. Reusing the label for two different meanings, both visible to
 * supervisors, would be a defect, so this panel uses "Conversations with
 * activity" instead. Only the English copy differs — the i18n key names
 * (`conversations.active`, `conversations.activeTitle`, etc.) and the
 * `activeConversations` schema field are unchanged.
 */
export function ConversationsPanel({ reportWindow, canRead }: ReportPanelProps) {
  const t = useTranslations('Reports')
  const [granularity, setGranularity] = useState<'day' | 'week'>('day')

  const keys = granularity === 'day' ? reportWindow.dayKeys : reportWindow.weekKeys
  const data = useQuery(
    api.reports.volume,
    canRead
      ? {
          sinceMs: reportWindow.sinceMs,
          // `untilMs` is required — `reportWindow()` returns it as the
          // window's EXCLUSIVE upper bound, and the server needs both
          // edges to bound `hourOfDay`'s pooling pass, which (unlike
          // `series`) has no per-key filter of its own to fall back on.
          untilMs: reportWindow.untilMs,
          keys,
          tzOffsetMinutes: reportWindow.tzOffsetMinutes,
          granularity,
        }
      : 'skip',
  )
  const mix = useQuery(api.reports.conversationStatusMix, canRead ? {} : 'skip')
  const loading = data === undefined

  if (loading) {
    return (
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
        {Array.from({ length: 5 }).map((_, i) => (
          <SkeletonCard key={i} />
        ))}
      </div>
    )
  }

  // `null` means THERE IS NO DENOMINATOR, which is not the same as 0% —
  // with `conversationsStarted === 0` and `conversationsStartedAd > 0`
  // (the deploy-window artefact below), a literal 0 would print
  // "0% of all new conversations" beside a non-zero "From ads" tile. The
  // subtitle is dropped entirely instead.
  //
  // Clamped to 1 for the same reason `VolumeChart` clamps its Direct bar
  // to 0: between the backend deploy and backfill completion an ad
  // referral landing on a pre-deploy conversation can push
  // `conversationsStartedAd` past `conversationsStarted`, which would
  // otherwise render "150% of all new conversations". Both consumers of
  // that ratio now clamp — clamping only the chart left this subtitle
  // free to state the artefact as a fact.
  const adShare =
    data.totals.conversationsStarted === 0
      ? null
      : Math.min(
          1,
          data.totals.conversationsStartedAd / data.totals.conversationsStarted,
        )
  const peakHour = data.hourOfDay.indexOf(Math.max(...data.hourOfDay))

  // Honesty gate: an empty range must render an empty state, never a
  // chart built from zeros and presented as if it meant something.
  const isEmpty =
    data.totals.conversationsStarted === 0 &&
    data.totals.incoming === 0 &&
    data.totals.outgoing === 0

  // The heatmap needs its OWN gate, not `isEmpty`. `hourOfDay` counts
  // INCOMING messages only, while `isEmpty` requires started, incoming
  // AND outgoing to all be zero — so an outbound-only window (a
  // broadcast that got no replies) is not "empty" by that test, and the
  // heatmap would render an all-zero grid under "Busiest hour: 0:00".
  // `indexOf(max)` on an all-zero array returns 0, so the fabricated
  // peak is always midnight. Gate on the heatmap's own data instead.
  const hourOfDayEmpty = data.hourOfDay.every((n) => n === 0)

  // Only weeks can be partial here: `weekKeys` is derived from `dayKeys`,
  // so a range that does not start on a Monday and end on a Sunday clips
  // its first and/or last week (see `partialWeekKeys` in
  // src/lib/reports/types.ts). At day granularity there is nothing to
  // mark.
  const partialKeys = granularity === 'week' ? reportWindow.partialWeekKeys : []

  const activePoints = data.series.map((p) => {
    // At WEEK granularity this is AVERAGE DAILY ACTIVE, not a weekly total.
    // Distinct counts are not additive across buckets: summing a week's daily
    // counts would count a thread active on Monday and Thursday twice — the
    // exact bug the per-day dedup exists to prevent, one level up. The average
    // is the honest figure the stored data supports, which is why the axis
    // label and tooltip both say "avg/day".
    const days = granularity === 'week' ? (reportWindow.daysPerWeek[p.key] ?? 7) : 1
    return {
      key: p.key,
      value: days > 0 ? p.activeConversations / days : 0,
    }
  })

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <MetricCard
          title={t('conversations.started')}
          value={data.totals.conversationsStarted.toLocaleString()}
          icon={MessageSquare}
          subtitle={t('conversations.startedSubtitle')}
        />
        <MetricCard
          title={t('conversations.fromAds')}
          value={data.totals.conversationsStartedAd.toLocaleString()}
          icon={Megaphone}
          subtitle={
            adShare === null
              ? undefined
              : t('conversations.adShare', { pct: Math.round(adShare * 100) })
          }
        />
        <MetricCard
          title={t('conversations.received')}
          value={data.totals.incoming.toLocaleString()}
          icon={Users}
        />
        <MetricCard
          title={t('conversations.sent')}
          value={data.totals.outgoing.toLocaleString()}
          icon={Send}
        />
        <MetricCard
          title={t('conversations.active')}
          // `data.totals.activeConversations` is a SUM of each period's
          // distinct count (convex/reports.ts), and distinct counts are not
          // additive across periods — 10 threads active every day of a
          // 30-day range would sum to 300, not 10. Presented as an average
          // per day instead, consistent with how the chart already treats
          // week buckets; `dayKeys.length` is always the exact day count of
          // the selected range (7/30/90 — never a partial figure the way a
          // week bucket can be), so dividing by it needs no partial-range
          // guard the way `daysPerWeek` does.
          //
          // The unit lives IN THE VALUE, not just the subtitle: beside four
          // range-total tiles ("New conversations 240"), a bare "8.0" reads
          // as a much smaller total rather than a different UNIT, and a
          // reader who skips the subtitle has no way to catch that. Reuses
          // `activePerDay` ("avg/day") rather than inventing a new suffix —
          // the same label the chart directly below already uses for this
          // identical concept. `toLocaleString` (not `.toFixed`, which every
          // sibling tile above avoids) so a locale with a comma decimal
          // separator renders this tile the same way it renders the other
          // four.
          value={`${(
            data.totals.activeConversations / reportWindow.dayKeys.length
          ).toLocaleString(undefined, {
            minimumFractionDigits: 1,
            maximumFractionDigits: 1,
          })} ${t('conversations.activePerDay')}`}
          icon={MessagesSquare}
          subtitle={t('conversations.activeSubtitle')}
        />
      </div>

      <div className="rounded-xl border border-border bg-card p-5">
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="text-sm font-medium text-foreground">
            {t('conversations.chartTitle')}
          </h2>
          <div className="flex items-center gap-2">
            <div className="flex gap-1 rounded-lg border border-border p-1">
              {(['day', 'week'] as const).map((g) => (
                <button
                  key={g}
                  type="button"
                  onClick={() => setGranularity(g)}
                  className={
                    g === granularity
                      ? 'rounded-md bg-primary px-2.5 py-1 text-xs text-primary-foreground'
                      : 'rounded-md px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground'
                  }
                >
                  {t(`conversations.${g}`)}
                </button>
              ))}
            </div>
            <button
              type="button"
              className="rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground"
              onClick={() => {
                // The partial-week column exists for the same reason the
                // axis carries an asterisk: a clipped week's row is
                // lower than a full week's, and a spreadsheet strips
                // every visual cue the panel uses to say so. Weekly
                // only — a "partial_week" column against day keys would
                // be noise.
                const partial = new Set(partialKeys)
                downloadCsv(
                  `conversations-${granularity}.csv`,
                  [
                    'period',
                    ...(granularity === 'week' ? ['partial_week'] : []),
                    'conversations_started',
                    'from_ads',
                    'messages_in',
                    'messages_out',
                    'active_conversations',
                    'days_in_period',
                  ],
                  data.series.map((p) => [
                    p.key,
                    ...(granularity === 'week'
                      ? [partial.has(p.key) ? 'yes' : 'no']
                      : []),
                    p.conversationsStarted,
                    p.conversationsStartedAd,
                    p.incoming,
                    p.outgoing,
                    // Raw per-period figure, not the weekly average the chart
                    // plots — and at week granularity it is already a SUM of
                    // that week's daily distinct counts (conversation-DAYS,
                    // not the week's distinct conversation count; see
                    // `VolumeTotals.activeConversations` in
                    // convex/lib/reportStats.ts). `days_in_period` below is
                    // its denominator, NOT decoration: every range has a
                    // partial leading and/or trailing week, and for those
                    // dividing by a flat 7 is simply wrong — without this
                    // column a spreadsheet user has no way to recover the
                    // correct average for exactly those two rows.
                    p.activeConversations,
                    granularity === 'week' ? (reportWindow.daysPerWeek[p.key] ?? 7) : 1,
                  ]),
                )
              }}
            >
              {t('exportCsv')}
            </button>
          </div>
        </div>

        {isEmpty ? (
          <EmptyState
            icon={MessageSquare}
            title={t('conversations.emptyTitle')}
            hint={t('conversations.emptyHint')}
          />
        ) : (
          <VolumeChart points={data.series} partialKeys={partialKeys} />
        )}
      </div>

      {/* Its own chart rather than a fifth series on the volume chart — that one
          already carries stacked ad/direct bars plus incoming and outgoing lines,
          and a third line past that stops being readable. */}
      <div className="rounded-xl border border-border bg-card p-5">
        <h2 className="mb-4 text-sm font-medium text-foreground">
          {t('conversations.activeTitle')}
        </h2>
        {data.totals.activeConversations === 0 ? (
          <EmptyState
            title={t('conversations.activeEmptyTitle')}
            hint={t('conversations.activeEmptyHint')}
          />
        ) : (
          <>
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={activePoints} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
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
                  allowDecimals={granularity === 'week'}
                />
                <Tooltip
                  contentStyle={{
                    background: 'var(--card)',
                    border: '1px solid var(--border)',
                    borderRadius: 8,
                    fontSize: 12,
                  }}
                  formatter={(value) => [
                    // Recharts types a tooltip formatter's `value` as
                    // `ValueType | undefined` (string | number | array,
                    // possibly absent), not the plain `number` this chart's
                    // single numeric `dataKey` actually carries — coerced
                    // rather than cast so the formatter stays total.
                    granularity === 'week'
                      ? Number(value).toFixed(1)
                      : Number(value).toLocaleString(),
                    granularity === 'week'
                      ? t('conversations.activePerDay')
                      : t('conversations.active'),
                  ]}
                />
                {/* Week granularity only: a static "avg/day" signal, not
                    just the tooltip's. Without it a decimal bar has no
                    on-screen cue it is an average rather than a count until
                    hovered — the heading alone no longer carries "per day"
                    now that the label override shortened it to
                    "Conversations with activity". Reuses this codebase's
                    existing convention for naming a bar series (the volume
                    chart below already does this with the identical
                    `wrapperStyle`) rather than an axis `label`, which has no
                    precedent anywhere in this codebase and cannot be
                    layout-verified without a dev server. Absent at day
                    granularity, where the bars are a genuine count and
                    "Conversations with activity" would just repeat the
                    heading above for no reason. */}
                {granularity === 'week' && <Legend wrapperStyle={{ fontSize: 12 }} />}
                <Bar
                  dataKey="value"
                  name={
                    granularity === 'week'
                      ? t('conversations.activePerDay')
                      : t('conversations.active')
                  }
                  fill="var(--primary)"
                  radius={[4, 4, 0, 0]}
                />
              </BarChart>
            </ResponsiveContainer>
            <p className="mt-3 text-xs text-muted-foreground">
              {t('conversations.activeCaveat')}
            </p>
          </>
        )}
      </div>

      <div className="rounded-xl border border-border bg-card p-5">
        <h2 className="mb-3 text-sm font-medium text-foreground">
          {hourOfDayEmpty
            ? t('conversations.hourTitleEmpty')
            : t('conversations.hourTitle', { hour: peakHour })}
        </h2>
        {hourOfDayEmpty ? (
          // Its own copy, not the panel-wide empty state: an
          // outbound-only window is NOT "No activity in this range" —
          // messages were sent, none came back. Saying otherwise would
          // trade one false claim for another.
          <EmptyState
            icon={MessageSquare}
            title={t('conversations.hourEmptyTitle')}
            hint={t('conversations.hourEmptyHint')}
          />
        ) : (
          <HourHeatmap slots={data.hourOfDay} />
        )}
      </div>

      {mix && (
        <div className="rounded-xl border border-border bg-card p-5">
          <h2 className="mb-3 text-sm font-medium text-foreground">
            {t('conversations.mixTitle')}
          </h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {(['open', 'pending', 'closed', 'archived'] as const).map((k) => (
              <div key={k} className="rounded-lg border border-border bg-background p-3">
                <p className="text-xs text-muted-foreground">{t(`conversations.status.${k}`)}</p>
                <p className="mt-1 text-lg font-semibold tabular-nums text-foreground">
                  {/* `mix.capped` is ONE flag shared across all four
                      buckets — true the instant ANY of them hits
                      `STATUS_MIX_CAP`, not a per-bucket signal (see
                      `conversationStatusMix` in convex/reports.ts). So
                      "+" is only accurate on a bucket whose OWN value
                      already equals the cap: below the cap, `mix[k]` is
                      the exact count (clamping never touched it); at the
                      cap, the true count is that value or higher. Always
                      appending "+" whenever `capped` is true — the
                      brief's original shape — would mark an
                      uncapped bucket "12+" when it is exactly 12. */}
                  {mix.capped && mix[k] === STATUS_MIX_CAP
                    ? `${STATUS_MIX_CAP.toLocaleString()}+`
                    : mix[k].toLocaleString()}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

type VolumePoint = {
  key: string
  conversationsStarted: number
  conversationsStartedAd: number
  incoming: number
  outgoing: number
}

function VolumeChart({
  points,
  partialKeys,
}: {
  points: VolumePoint[]
  /** Keys whose bucket the window only partially covers — see
   *  `ReportWindow.partialWeekKeys`. Empty at day granularity. */
  partialKeys: readonly string[]
}) {
  const t = useTranslations('Reports')
  const partial = new Set(partialKeys)
  // Only footnote what is actually on screen: `partialKeys` covers the
  // whole window, `points` is what the chart plots.
  const hasPartial = points.some((p) => partial.has(p.key))

  // `conversationsStartedDirect` is presentation, not a server field —
  // derived here, next to its only consumer, rather than at the call
  // site (keeps `VolumePoint` an honest match for what `data.series`
  // actually returns).
  //
  // Clamped to 0: between the backend deploy and backfill completion, an
  // ad referral landing on a pre-deploy conversation can make
  // `conversationsStartedAd` exceed `conversationsStarted` for an hour,
  // which would otherwise render as a negative "Direct" bar. Self-healing
  // once the backfill finishes, but must not render wrong meanwhile — see
  // docs/superpowers/specs/2026-08-05-reports-section-design.md's
  // "Rollout" section.
  const chartPoints = points.map((p) => ({
    ...p,
    conversationsStartedDirect: Math.max(0, p.conversationsStarted - p.conversationsStartedAd),
  }))

  return (
    <>
      <ResponsiveContainer width="100%" height={280}>
        <ComposedChart data={chartPoints} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
          <XAxis
            dataKey="key"
            tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
            tickLine={false}
            axisLine={false}
            // A 90-day range has more labels than fit; recharts thins them
            // itself when given a numeric gap, which beats truncating the
            // series.
            interval="preserveStartEnd"
            minTickGap={24}
            // Marked in BOTH places on purpose. The asterisk survives the
            // axis thinning above and is visible without hovering; the
            // tooltip spells it out for a reader who does. A partial
            // week's bar is short because the window clipped it, and the
            // trailing week is partial on almost every range — unlabelled,
            // that final dip reads as a collapse in volume that did not
            // happen.
            tickFormatter={(key: string) =>
              partial.has(key) ? t('conversations.partialWeekAxis', { key }) : key
            }
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
            // Recharts types the tooltip label as `ReactNode`, not the
            // `string` the `key` dataKey actually carries — coerced
            // rather than cast so the formatter stays total.
            labelFormatter={(label: ReactNode) => {
              const key = String(label)
              return partial.has(key)
                ? t('conversations.partialWeekTooltip', { key })
                : key
            }}
          />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          {/* Ad-sourced is a SUBSET of started, so the two bars are stacked
              into one column rather than sitting side by side — side by
              side would read as two independent totals. */}
          <Bar
            stackId="starts"
            dataKey="conversationsStartedAd"
            name={t('conversations.fromAds')}
            fill="var(--primary)"
            radius={[0, 0, 0, 0]}
          />
          <Bar
            stackId="starts"
            dataKey="conversationsStartedDirect"
            name={t('conversations.direct')}
            fill="var(--muted-foreground)"
            radius={[4, 4, 0, 0]}
          />
          <Line
            type="monotone"
            dataKey="incoming"
            name={t('conversations.received')}
            stroke="var(--chart-2, var(--primary))"
            dot={false}
            strokeWidth={2}
          />
          <Line
            type="monotone"
            dataKey="outgoing"
            name={t('conversations.sent')}
            stroke="var(--chart-3, var(--muted-foreground))"
            dot={false}
            strokeWidth={2}
          />
        </ComposedChart>
      </ResponsiveContainer>
      {hasPartial && (
        <p className="mt-2 text-xs text-muted-foreground">
          {t('conversations.partialWeekNote')}
        </p>
      )}
    </>
  )
}

function HourHeatmap({ slots }: { slots: number[] }) {
  const t = useTranslations('Reports')
  const max = Math.max(1, ...slots)
  return (
    <div className="grid grid-cols-12 gap-1 sm:grid-cols-[repeat(24,minmax(0,1fr))]">
      {slots.map((count, hour) => (
        <div key={hour} className="flex flex-col items-center gap-1">
          <div
            className="h-10 w-full rounded bg-primary"
            // Opacity floor of 0.06 so an empty hour is still a visible
            // cell rather than a hole in the grid.
            style={{ opacity: count === 0 ? 0.06 : 0.15 + (count / max) * 0.85 }}
            title={t('conversations.hourTooltip', { hour, count })}
          />
          <span className="text-[10px] tabular-nums text-muted-foreground">
            {hour % 3 === 0 ? hour : ''}
          </span>
        </div>
      ))}
    </div>
  )
}
