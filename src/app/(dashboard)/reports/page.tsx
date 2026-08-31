'use client'

import { useMemo } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { useAuth } from '@/hooks/use-auth'
import { canAccessNav } from '@/lib/auth/roles'
import {
  REPORT_TABS,
  RANGE_OPTIONS,
  parseTab,
  parseRange,
  // Aliased: the local variable holding the computed window is named
  // `reportWindow` below (matching `ReportPanelProps.reportWindow`, the
  // prop every panel now takes). Importing the builder under that same
  // name would make `const reportWindow = useMemo(() => reportWindow(...))`
  // reference itself — the inner call resolves to the block-scoped
  // `const` being declared, still in its temporal dead zone at the point
  // `useMemo` invokes the callback, so it would throw
  // "Cannot access 'reportWindow' before initialization" on first render.
  reportWindow as buildReportWindow,
} from '@/lib/reports/types'
import { cn } from '@/lib/utils'
import { ConversationsPanel } from '@/components/reports/conversations-panel'
import { AdsPanel } from '@/components/reports/ads-panel'
import { ResponsePanel } from '@/components/reports/response-panel'
import { FunnelPanel } from '@/components/reports/funnel-panel'
import { BillingPanel } from '@/components/reports/billing-panel'
import { AgentsPanel } from '@/components/reports/agents-panel'
import { ActivityPanel } from '@/components/reports/activity-panel'

export default function ReportsPage() {
  const t = useTranslations('Reports')
  const router = useRouter()
  const params = useSearchParams()
  const { accountId, accountRole } = useAuth()

  const tab = parseTab(params.get('tab'))
  const range = parseRange(params.get('range'))
  // Renamed from `window`, which shadowed the global `window` object for
  // the rest of this component's body.
  const reportWindow = useMemo(() => buildReportWindow(range), [range])

  // Both the account and a SUFFICIENT role must be known before any panel
  // fires a query. `api.reports.*` is supervisor-gated server-side, and
  // `useQuery` re-throws FORBIDDEN synchronously during render — with no
  // Error Boundary in this app that crashes the route rather than showing
  // nothing. Same idiom as campaigns/page.tsx (now the /campaigns redirect).
  const canRead = !!accountId && !!accountRole && canAccessNav(accountRole, '/reports')

  const setParam = (key: 'tab' | 'range', value: string) => {
    const next = new URLSearchParams(params.toString())
    next.set(key, value)
    router.replace(`/reports?${next.toString()}`, { scroll: false })
  }

  return (
    <div className="space-y-5 p-4 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-foreground">{t('title')}</h1>
          <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
        </div>
        {/* Hidden on the Activity tab. That panel is a fixed-size feed
            keyed on a row limit, not a window — `api.dashboard.activity`
            takes no `sinceMs` — so leaving the control on screen there
            would offer a range that silently does nothing. */}
        <div
          className={cn(
            'flex gap-1 rounded-lg border border-border bg-card p-1',
            tab === 'activity' && 'hidden',
          )}
        >
          {RANGE_OPTIONS.map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setParam('range', String(option))}
              className={cn(
                'rounded-md px-3 py-1.5 text-sm transition-colors',
                option === range
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {t('range', { days: option })}
            </button>
          ))}
        </div>
      </div>

      <div className="flex gap-1 overflow-x-auto border-b border-border">
        {REPORT_TABS.map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => setParam('tab', key)}
            className={cn(
              'whitespace-nowrap border-b-2 px-3 py-2 text-sm transition-colors',
              key === tab
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {t(`tabs.${key}`)}
          </button>
        ))}
      </div>

      {tab === 'conversations' && (
        <ConversationsPanel reportWindow={reportWindow} canRead={canRead} />
      )}
      {tab === 'ads' && <AdsPanel reportWindow={reportWindow} canRead={canRead} />}
      {tab === 'response' && <ResponsePanel reportWindow={reportWindow} canRead={canRead} />}
      {tab === 'funnel' && <FunnelPanel reportWindow={reportWindow} canRead={canRead} />}
      {tab === 'billing' && <BillingPanel reportWindow={reportWindow} canRead={canRead} />}
      {tab === 'agents' && <AgentsPanel reportWindow={reportWindow} canRead={canRead} />}
      {tab === 'activity' && <ActivityPanel reportWindow={reportWindow} canRead={canRead} />}
    </div>
  )
}
