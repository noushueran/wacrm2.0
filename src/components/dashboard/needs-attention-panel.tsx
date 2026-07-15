"use client"

import Link from 'next/link'
import { useState } from 'react'
import { CheckCircle2, Megaphone } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { useQuery } from '@/lib/convex/cached'
import { api } from '../../../convex/_generated/api'
import { useAuth } from '@/hooks/use-auth'
import { conversationScope, type ConversationScope } from '@/lib/auth/roles'
import { cn } from '@/lib/utils'
import { softBadge } from '@/lib/ui/soft-badge'
import {
  selectWaiting,
  formatWaiting,
  type WaitingConversation,
} from '@/lib/dashboard/needs-attention'
import { EmptyState } from './empty-state'
import { Skeleton } from './skeleton'

export type QueueTab = 'all' | 'mine' | 'unassigned'

// Which tabs a role may see. Mirrors the server's `conversationScope`
// (roles.ts) so we never render a tab the backend would refuse to answer:
// admins/owners/supervisors get the full set; an agent sees only their own
// + the shared pool; a viewer sees the pool only (so no tab bar at all).
const TABS_FOR_SCOPE: Record<ConversationScope, QueueTab[]> = {
  all: ['all', 'mine', 'unassigned'],
  own_and_pool: ['mine', 'unassigned'],
  unassigned: ['unassigned'],
}

/**
 * Container: subscribes to the already-deployed `conversations.list`
 * (role-scoped, `embedContact`-enriched) for the active tab, then narrows to
 * the ones actually waiting on a reply. No new backend query — safe on the
 * live page.
 */
export function NeedsAttentionCard() {
  const { accountId, accountRole } = useAuth()
  const availableTabs = TABS_FOR_SCOPE[conversationScope(accountRole ?? 'viewer')]
  // `null` = "no explicit pick yet, follow the scope's default tab" — so a
  // late-resolving role (viewer → admin) lands on the right first tab instead
  // of being frozen on whatever the first render computed.
  const [picked, setPicked] = useState<QueueTab | null>(null)
  const tab: QueueTab =
    picked && availableTabs.includes(picked) ? picked : availableTabs[0]

  const data = useQuery(
    api.conversations.list,
    accountId
      ? {
          status: 'open' as const,
          assignment: tab === 'all' ? undefined : tab,
          paginationOpts: { numItems: 50, cursor: null },
        }
      : 'skip',
  )
  const items = data
    ? selectWaiting(data.page as WaitingConversation[])
    : null

  return (
    <NeedsAttentionPanel
      items={items}
      loading={data === undefined}
      tab={tab}
      onTabChange={setPicked}
      availableTabs={availableTabs}
      nowMs={Date.now()}
    />
  )
}

interface NeedsAttentionPanelProps {
  items: WaitingConversation[] | null
  loading: boolean
  tab: QueueTab
  onTabChange: (t: QueueTab) => void
  availableTabs: QueueTab[]
  nowMs: number
}

/** Presentational — prop-driven so it renders in the preview without Convex. */
export function NeedsAttentionPanel({
  items,
  loading,
  tab,
  onTabChange,
  availableTabs,
  nowMs,
}: NeedsAttentionPanelProps) {
  const t = useTranslations('Dashboard.needsAttention')
  const tabLabel: Record<QueueTab, string> = {
    all: t('tabAll'),
    mine: t('tabMine'),
    unassigned: t('tabUnassigned'),
  }
  const showTabs = availableTabs.length > 1

  return (
    <section className="rounded-xl border border-border bg-card">
      <header className="flex items-center justify-between gap-3 border-b border-border px-5 py-4">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold text-foreground">{t('title')}</h2>
          {items && items.length > 0 ? (
            <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-xs font-semibold tabular-nums text-primary">
              {items.length}
            </span>
          ) : null}
        </div>
        {showTabs ? (
          <div className="flex items-center gap-1 rounded-lg bg-muted/60 p-1">
            {availableTabs.map((tb) => (
              <button
                key={tb}
                type="button"
                onClick={() => onTabChange(tb)}
                className={cn(
                  'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
                  tab === tb
                    ? 'bg-secondary text-secondary-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {tabLabel[tb]}
              </button>
            ))}
          </div>
        ) : null}
      </header>

      {loading || !items ? (
        <div className="space-y-2 p-5">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="p-5">
          <EmptyState
            icon={CheckCircle2}
            title={t('allCaught')}
            hint={t('allCaughtHint')}
          />
        </div>
      ) : (
        <ul className="divide-y divide-border">
          {items.map((it) => (
            <Row key={it._id} item={it} nowMs={nowMs} t={t} />
          ))}
        </ul>
      )}
    </section>
  )
}

function Row({
  item,
  nowMs,
  t,
}: {
  item: WaitingConversation
  nowMs: number
  t: ReturnType<typeof useTranslations>
}) {
  const name = item.contact?.name || item.contact?.phone || t('unknown')
  const initial = (
    item.contact?.name?.charAt(0) ||
    item.contact?.phone?.charAt(0) ||
    '?'
  ).toUpperCase()
  const waited = formatWaiting(item.lastMessageAt, nowMs)

  return (
    <li>
      <Link
        href={`/inbox?c=${item._id}`}
        className="flex items-center gap-3 px-5 py-3 transition-colors hover:bg-muted/40"
      >
        <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-medium text-primary">
          {initial}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium text-foreground">
              {name}
            </span>
            {item.adReferral ? (
              <span
                className={cn(
                  'inline-flex flex-shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium',
                  softBadge('warning'),
                )}
              >
                <Megaphone className="h-2.5 w-2.5" />
                {t('adLead')}
              </span>
            ) : null}
          </div>
          <p className="truncate text-xs text-muted-foreground">
            {item.lastMessageText || t('noPreview')}
          </p>
        </div>
        {waited ? (
          <span className="flex-shrink-0 text-xs font-medium tabular-nums text-amber-700 dark:text-amber-300">
            {waited}
          </span>
        ) : null}
      </Link>
    </li>
  )
}
