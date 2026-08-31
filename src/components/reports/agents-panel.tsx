'use client'

import { useMemo } from 'react'
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
import { useTranslations } from 'next-intl'
import { useQuery } from '@/lib/convex/cached'
import { api } from '../../../convex/_generated/api'
import { ASSIGNMENT_ROW_LIMIT } from '../../../convex/lib/reportStats'
import { SkeletonCard } from '@/components/dashboard/skeleton'
import { EmptyState } from '@/components/dashboard/empty-state'
import { downloadCsv } from '@/lib/reports/csv'
import {
  AvailableChartColors,
  constructCategoryColors,
  getColorClassName,
  type AvailableChartColorsKeys,
} from '@/components/tremor/chart-colors'
import {
  ASSIGNMENT_HISTORY_FLOOR_DAY,
  ASSIGNMENT_HISTORY_FLOOR_MS,
  type ReportPanelProps,
} from '@/lib/reports/types'

/**
 * Agents panel: `api.reports.assignmentsByAgent` — how many leads each agent
 * picked up, on each local day of the selected window. See
 * docs/superpowers/specs/2026-08-21-agents-assignment-report-design.md.
 *
 * A cell counts DISTINCT CONVERSATIONS, not handover events: a thread that
 * bounces to the same agent three times in a day counts once for them. That
 * rule lives in `foldAssignmentEvents` server-side, and the copy on screen has
 * to keep matching it — "leads assigned", never "assignments", which would
 * promise the event count this deliberately does not show.
 *
 * The chart is for shape; the TABLE is the record. The chart names at most
 * `CHART_AGENT_LIMIT` agents and pools the rest into one grey band, because a
 * stacked bar past nine segments stops being readable — but every agent
 * appears in the table below, by name, and the CSV exports the table.
 */

/**
 * Agents drawn as their own band in the stacked chart. The rest are pooled
 * into "Other".
 *
 * Eight because that is how many distinct hues the vendored palette actually
 * offers once grey is held back: `AvailableChartColors` has nine entries and
 * grey is reserved for the "Other" band, so raising this past eight would
 * silently wrap `constructCategoryColors`' modulo and paint two agents the
 * same colour — a chart that looks fine and reads wrong.
 */
const CHART_AGENT_LIMIT = 8

/** Recharts `dataKey` for the pooled band. Prefixed so it cannot collide with
 *  a Convex user id, which is what every other key in a chart row is. */
const OTHER_KEY = '__other'

/** Grey is the "Other" band's colour, so it is held back from the per-agent
 *  palette — otherwise a named agent could be painted the same grey as the
 *  pool they are explicitly not part of. */
const AGENT_COLORS = AvailableChartColors.filter(
  (color) => color !== 'gray',
) as AvailableChartColorsKeys[]

export function AgentsPanel({ reportWindow, canRead }: ReportPanelProps) {
  const t = useTranslations('Reports')

  const data = useQuery(
    api.reports.assignmentsByAgent,
    canRead
      ? {
          sinceMs: reportWindow.sinceMs,
          untilMs: reportWindow.untilMs,
          dayKeys: reportWindow.dayKeys,
          tzOffsetMinutes: reportWindow.tzOffsetMinutes,
        }
      : 'skip',
  )

  // Named before the early returns below so the hook order stays fixed across
  // the loading render and the loaded one.
  const chartAgents = useMemo(
    () => (data?.agents ?? []).slice(0, CHART_AGENT_LIMIT),
    [data],
  )
  const overflowAgents = useMemo(
    () => (data?.agents ?? []).slice(CHART_AGENT_LIMIT),
    [data],
  )
  const colors = useMemo(
    () =>
      constructCategoryColors(
        chartAgents.map((agent) => agent.userId),
        AGENT_COLORS,
      ),
    [chartAgents],
  )
  const points = useMemo(
    () =>
      (data?.days ?? []).map((day) => {
        const row: Record<string, string | number> = { key: day.dayKey }
        for (const agent of chartAgents) row[agent.userId] = day.byAgent[agent.userId] ?? 0
        if (overflowAgents.length > 0) {
          row[OTHER_KEY] = overflowAgents.reduce(
            (sum, agent) => sum + (day.byAgent[agent.userId] ?? 0),
            0,
          )
        }
        return row
      }),
    [data, chartAgents, overflowAgents],
  )

  if (data === undefined) {
    return (
      <div className="space-y-4">
        <SkeletonCard />
        <SkeletonCard />
      </div>
    )
  }

  // An assignee with no `memberships` row — someone who has left the team.
  // Their leads are still counted (see the query's doc comment); only the
  // label is unknown.
  const agentName = (agent: { name: string | null }) =>
    agent.name ?? t('agents.formerMember')

  const dayTotal = (day: (typeof data.days)[number]) =>
    Object.values(day.byAgent).reduce((sum, n) => sum + n, 0)

  const grandTotal = data.agents.reduce((sum, agent) => sum + agent.total, 0)
  const releasedTotal = data.days.reduce((sum, day) => sum + day.released, 0)

  // The window reaches back before the table that feeds this panel existed.
  // Without the note below, the empty stretch reads as an idle team.
  const beforeHistoryFloor = reportWindow.sinceMs < ASSIGNMENT_HISTORY_FLOOR_MS

  const exportCsv = () =>
    downloadCsv(
      'agents.csv',
      ['agent', ...data.days.map((day) => day.dayKey), 'total'],
      [
        ...data.agents.map((agent) => [
          agentName(agent),
          ...data.days.map((day) => day.byAgent[agent.userId] ?? 0),
          agent.total,
        ]),
        [
          t('agents.released'),
          ...data.days.map((day) => day.released),
          releasedTotal,
        ],
        [t('agents.total'), ...data.days.map(dayTotal), grandTotal],
      ],
    )

  return (
    <div className="space-y-5">
      <div className="flex justify-end">
        <button
          type="button"
          className="rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground"
          onClick={exportCsv}
        >
          {t('exportCsv')}
        </button>
      </div>

      {beforeHistoryFloor && (
        <p className="rounded-lg border border-dashed border-border bg-card/40 px-3 py-2 text-xs text-muted-foreground">
          {t('agents.historyFloor', { date: ASSIGNMENT_HISTORY_FLOOR_DAY })}
        </p>
      )}

      {data.truncated && data.earliestCoveredDay && (
        <p className="rounded-lg border border-dashed border-border bg-card/40 px-3 py-2 text-xs text-muted-foreground">
          {t('agents.truncated', {
            limit: ASSIGNMENT_ROW_LIMIT.toLocaleString(),
            date: data.earliestCoveredDay,
          })}
        </p>
      )}

      <div className="rounded-xl border border-border bg-card p-5">
        <h2 className="mb-1 text-sm font-medium text-foreground">
          {t('agents.chartTitle')}
        </h2>
        <p className="mb-4 text-xs text-muted-foreground">{t('agents.chartSubtitle')}</p>
        {grandTotal === 0 ? (
          <EmptyState title={t('agents.emptyTitle')} hint={t('agents.emptyHint')} />
        ) : (
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
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
                formatter={(value) => Number(value).toLocaleString()}
              />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              {chartAgents.map((agent) => (
                <Bar
                  key={agent.userId}
                  dataKey={agent.userId}
                  name={agentName(agent)}
                  stackId="agents"
                  className={getColorClassName(
                    colors.get(agent.userId) ?? 'gray',
                    'fill',
                  )}
                />
              ))}
              {overflowAgents.length > 0 && (
                <Bar
                  dataKey={OTHER_KEY}
                  name={t('agents.otherAgents', { count: overflowAgents.length })}
                  stackId="agents"
                  className={getColorClassName('gray', 'fill')}
                />
              )}
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>

      <div className="rounded-xl border border-border bg-card p-5">
        <h2 className="mb-4 text-sm font-medium text-foreground">
          {t('agents.tableTitle')}
        </h2>
        {grandTotal === 0 && releasedTotal === 0 ? (
          <EmptyState title={t('agents.emptyTitle')} hint={t('agents.emptyHint')} />
        ) : (
          // Its own scroll container, not the page's: at 90 days this table is
          // far wider than the viewport, and letting it push the page body
          // sideways would drag every other panel's layout with it.
          <div className="overflow-x-auto">
            <table className="w-full min-w-max border-collapse text-sm">
              <thead>
                <tr className="border-b border-border text-left">
                  <th className="sticky left-0 z-10 bg-card py-2 pr-4 font-medium text-muted-foreground">
                    {t('agents.agent')}
                  </th>
                  {data.days.map((day) => (
                    <th
                      key={day.dayKey}
                      // Full ISO date on hover: the header is trimmed to
                      // MM-DD to keep 90 columns readable, which drops the
                      // year — fine at a glance, ambiguous when a window
                      // spans a year boundary.
                      title={day.dayKey}
                      className="px-2 py-2 text-right font-medium tabular-nums text-muted-foreground"
                    >
                      {day.dayKey.slice(5)}
                    </th>
                  ))}
                  <th className="px-2 py-2 text-right font-medium text-muted-foreground">
                    {t('agents.total')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.agents.map((agent) => (
                  <tr key={agent.userId} className="border-b border-border/60">
                    <th className="sticky left-0 z-10 bg-card py-2 pr-4 text-left font-normal text-foreground">
                      <span className="flex items-center gap-2">
                        <span
                          aria-hidden
                          className={`h-2 w-2 shrink-0 rounded-full ${getColorClassName(
                            colors.get(agent.userId) ?? 'gray',
                            'bg',
                          )}`}
                        />
                        {agentName(agent)}
                      </span>
                    </th>
                    {data.days.map((day) => {
                      const count = day.byAgent[agent.userId] ?? 0
                      return (
                        <td
                          key={day.dayKey}
                          className={`px-2 py-2 text-right tabular-nums ${
                            count === 0 ? 'text-muted-foreground/40' : 'text-foreground'
                          }`}
                        >
                          {count}
                        </td>
                      )
                    })}
                    <td className="px-2 py-2 text-right font-medium tabular-nums text-foreground">
                      {agent.total.toLocaleString()}
                    </td>
                  </tr>
                ))}

                {/* Releases back to the pool. Deliberately NOT folded into any
                    agent's row: a release has no recipient, and debiting the
                    agent who let go of the thread would mix "who picked leads
                    up" with "who put them down" in one number. */}
                <tr className="border-b border-border/60">
                  <th className="sticky left-0 z-10 bg-card py-2 pr-4 text-left font-normal text-muted-foreground">
                    {t('agents.released')}
                  </th>
                  {data.days.map((day) => (
                    <td
                      key={day.dayKey}
                      className={`px-2 py-2 text-right tabular-nums ${
                        day.released === 0
                          ? 'text-muted-foreground/40'
                          : 'text-muted-foreground'
                      }`}
                    >
                      {day.released}
                    </td>
                  ))}
                  <td className="px-2 py-2 text-right font-medium tabular-nums text-muted-foreground">
                    {releasedTotal.toLocaleString()}
                  </td>
                </tr>

                <tr>
                  <th className="sticky left-0 z-10 bg-card py-2 pr-4 text-left font-medium text-foreground">
                    {t('agents.total')}
                  </th>
                  {data.days.map((day) => (
                    <td
                      key={day.dayKey}
                      className="px-2 py-2 text-right font-medium tabular-nums text-foreground"
                    >
                      {dayTotal(day)}
                    </td>
                  ))}
                  <td className="px-2 py-2 text-right font-semibold tabular-nums text-foreground">
                    {grandTotal.toLocaleString()}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-3 text-xs text-muted-foreground">{t('agents.caveat')}</p>
      </div>
    </div>
  )
}
