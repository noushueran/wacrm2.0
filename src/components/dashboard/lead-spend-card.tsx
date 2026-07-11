"use client"

import { useMemo, useState, type ReactNode } from 'react'
import { useQuery } from '@/lib/convex/cached'
import { api } from '../../../convex/_generated/api'
import { useAuth } from '@/hooks/use-auth'
import { formatCurrency } from '@/lib/currency'
import { hasMinRole } from '@/lib/auth/roles'
import { cn } from '@/lib/utils'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

import { useTranslations } from 'next-intl'

type Period = 'thisMonth' | 'allTime'

/** One agent's rollup from `api.leadCharges.report`. Declared locally
 *  (rather than importing Convex's `Id<'users'>`) since this is a pure
 *  display shape — `userId` only ever needs to behave like a `string`
 *  here (React `key`), and `Id<'users'>` is structurally assignable to
 *  `string` so `report.rows` satisfies this without a cast. */
interface LeadSpendRow {
  userId: string
  name: string
  leadCount: number
  totalSpent: number
}

/**
 * Local-midnight start of the current calendar month, in ms — the
 * "This month" boundary for the spend report. Computed in the
 * caller's local timezone (not UTC), same convention as
 * `startOfLocalDay` in `src/lib/dashboard/date-utils.ts`: "this
 * month" is a local-calendar concept, not a UTC one.
 */
function startOfThisMonth(d: Date = new Date()): number {
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime()
}

/**
 * Dashboard "Lead spend" card.
 *
 * Unlike the other dashboard widgets (which receive `data`/`loading`
 * props from the page-level loader), this card owns its query
 * directly and fully self-hides: it renders nothing while the report
 * is loading AND nothing once loaded if the account has never set a
 * positive `leadValue` (`report.enabled === false`) — so the card
 * only ever appears for accounts that opted into lead-spend tracking,
 * with no conditional needed at the call site.
 *
 * Role branch mirrors the server's own scoping in
 * `convex/leadCharges.ts` (`hasMinRole(ctx.role, "supervisor")`):
 * supervisor+ get every agent's row back from the query and see a
 * table; an agent only ever gets their own row back and sees a single
 * summary line. Keeping the client check identical to the server's is
 * what makes that split safe.
 */
export function LeadSpendCard() {
  const t = useTranslations('Dashboard.leadSpend')
  const { accountId, accountRole } = useAuth()
  const [period, setPeriod] = useState<Period>('thisMonth')

  // Recomputed only when the toggle changes, mirroring how the
  // dashboard page memoises its own "now"-derived query args.
  const from = useMemo(
    () => (period === 'thisMonth' ? startOfThisMonth() : undefined),
    [period],
  )

  const report = useQuery(api.leadCharges.report, accountId ? { from } : 'skip')

  // Loading (undefined) or feature-off (enabled: false) — no card.
  if (report === undefined || report.enabled === false) return null

  const canSeeAll = accountRole !== null && hasMinRole(accountRole, 'supervisor')

  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-foreground">{t('title')}</h2>
        <div className="flex items-center gap-1 rounded-lg bg-muted/60 p-1">
          <PeriodButton
            active={period === 'thisMonth'}
            onClick={() => setPeriod('thisMonth')}
          >
            {t('thisMonth')}
          </PeriodButton>
          <PeriodButton
            active={period === 'allTime'}
            onClick={() => setPeriod('allTime')}
          >
            {t('allTime')}
          </PeriodButton>
        </div>
      </div>

      <div className="mt-4">
        {canSeeAll ? (
          <SupervisorTable rows={report.rows} currency={report.currency} t={t} />
        ) : (
          <AgentSummary row={report.rows[0]} currency={report.currency} t={t} />
        )}
      </div>
    </div>
  )
}

// ------------------------------------------------------------

function PeriodButton({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
        active
          ? 'bg-secondary text-secondary-foreground'
          : 'text-muted-foreground hover:text-foreground',
      )}
    >
      {children}
    </button>
  )
}

function SupervisorTable({
  rows,
  currency,
  t,
}: {
  rows: readonly LeadSpendRow[]
  currency: string
  t: ReturnType<typeof useTranslations>
}) {
  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">{t('empty')}</p>
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="text-muted-foreground">{t('agent')}</TableHead>
          <TableHead className="text-right text-muted-foreground">
            {t('leads')}
          </TableHead>
          <TableHead className="text-right text-muted-foreground">
            {t('spent')}
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.userId}>
            <TableCell className="font-medium text-foreground">
              {row.name}
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {row.leadCount.toLocaleString()}
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {formatCurrency(row.totalSpent, currency)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

function AgentSummary({
  row,
  currency,
  t,
}: {
  row: LeadSpendRow | undefined
  currency: string
  t: ReturnType<typeof useTranslations>
}) {
  return (
    <p className="text-sm text-foreground">
      {t('yourSpend', {
        amount: formatCurrency(row?.totalSpent ?? 0, currency),
        count: row?.leadCount ?? 0,
      })}
    </p>
  )
}
