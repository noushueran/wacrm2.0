'use client'

import { useQuery } from 'convex/react'
import { api } from '../../../../convex/_generated/api'
import { useTranslations } from 'next-intl'
import { useAuth } from '@/hooks/use-auth'
import { MetricCard } from '@/components/dashboard/metric-card'
import { SkeletonCard } from '@/components/dashboard/skeleton'
import { formatCurrency } from '@/lib/currency'
import { UI_FUNNEL_STAGE_KEYS } from '@/lib/inbox/funnel'
import { Users, ShoppingCart, DollarSign } from 'lucide-react'

export default function CampaignsPage() {
  const t = useTranslations('Campaigns')
  const tFunnel = useTranslations('Inbox.funnel')
  const { accountId } = useAuth()
  const data = useQuery(api.campaigns.overview, accountId ? {} : 'skip')
  const loading = data === undefined
  const byStage = Object.fromEntries((data?.funnel ?? []).map((f) => [f.stage, f.count]))
  const maxCount = Math.max(1, ...(data?.funnel ?? []).map((f) => f.count))

  return (
    <div className="space-y-6 p-4 sm:p-6">
      <div>
        <h1 className="text-xl font-semibold text-foreground">{t('title')}</h1>
        <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {loading || !data ? (
          Array.from({ length: 4 }).map((_, i) => <SkeletonCard key={i} />)
        ) : (
          <>
            <MetricCard title={t('newLeads')} value={(byStage.new_lead ?? 0).toLocaleString()} icon={Users} />
            <MetricCard title={t('qualified')} value={(byStage.qualified ?? 0).toLocaleString()} icon={Users} />
            <MetricCard title={t('purchases')} value={data.purchase.count.toLocaleString()} icon={ShoppingCart} />
            <MetricCard title={t('purchaseValue')} value={formatCurrency(data.purchase.reportedValue, data.purchase.currency)} icon={DollarSign} subtitle={t('reportedToMeta')} />
          </>
        )}
      </div>

      {/* Funnel breakdown */}
      {!loading && data && (
        <div className="rounded-xl border border-border bg-card p-5">
          <h2 className="mb-3 text-sm font-medium text-foreground">{t('funnelTitle')}</h2>
          <div className="space-y-2">
            {UI_FUNNEL_STAGE_KEYS.map((stage) => {
              const count = byStage[stage] ?? 0
              return (
                <div key={stage} className="flex items-center gap-3">
                  <span className="w-32 shrink-0 text-sm text-muted-foreground">{tFunnel(`stage.${stage}`)}</span>
                  <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                    <div className="h-full rounded-full bg-primary" style={{ width: `${(count / maxCount) * 100}%` }} />
                  </div>
                  <span className="w-10 shrink-0 text-right text-sm tabular-nums text-foreground">{count}</span>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Meta delivery */}
      {!loading && data && (
        <div className="rounded-xl border border-border bg-card p-5">
          <h2 className="mb-3 text-sm font-medium text-foreground">{t('metaTitle')}</h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            {(['sent', 'pending', 'unmatched', 'error', 'abandoned', 'total'] as const).map((k) => (
              <div key={k} className="rounded-lg border border-border bg-background p-3">
                <p className="text-xs text-muted-foreground">{t(`meta.${k}`)}</p>
                <p className="mt-1 text-lg font-semibold tabular-nums text-foreground">{data.meta[k]}</p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
