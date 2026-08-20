'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { ArrowRight, GitBranch, Trophy } from 'lucide-react';

import { useQuery } from '@/lib/convex/cached';
import { useAuth } from '@/hooks/use-auth';
import type { PipelineStageKey } from '@/lib/leads/pipeline';
import { formatCurrencyShort } from '@/lib/currency';
import { cn } from '@/lib/utils';
import { EmptyState } from './empty-state';
import { Skeleton } from './skeleton';

import { api } from '../../../convex/_generated/api';

// ============================================================
// LeadsPipelineCard — a compact view of the REAL deals pipeline (qualified
// leads over the funnel): one segmented bar, per-stage counts, win rate and
// won value, linking through to /leads' Pipeline view.
//
// NOW READS AN AGGREGATE, NOT THE BOARD. It used to share the /leads page's
// `leadsBoard` subscription, on the reasoning that visiting both pages then
// cost one query. That reasoning was sound and the price was not: measured
// against production data, `leadsBoard({})` is 1,668 document reads and a
// ~2.4 MB payload — 459 fully hydrated leads, each costing a contact, a
// conversation, an offers collect and a checklist lookup, issued
// SEQUENTIALLY — to produce the ten numbers below. `pipelineSummary`
// returns those ten numbers directly.
//
// It also no longer sits on /dashboard. A pipeline is something a manager
// studies, not something a salesperson acts on between messages, so it
// lives on /reports' Funnel tab beside the windowed funnel counts. The two
// are not redundant: this is where deals stand RIGHT NOW, `funnelOverview`
// is how many conversations reached each stage within the range.
// ============================================================

const STAGE_BG: Record<PipelineStageKey, string> = {
  qualified: 'bg-primary',
  price_quoted: 'bg-sky-500',
  itinerary_created: 'bg-violet-500',
  itinerary_sent: 'bg-fuchsia-500',
  invoice_sent: 'bg-amber-500',
  purchased: 'bg-emerald-500',
  lost: 'bg-red-500',
};

export function LeadsPipelineCard() {
  const t = useTranslations('Dashboard.leadsPipeline');
  const tFunnel = useTranslations('Inbox.funnel');
  // Same account-readiness gate as every other query; viewers have no lead
  // queue (`pipelineSummary` requires `agent`, so it would throw), so the
  // card self-hides rather than relying on its caller to know that.
  const { accountId, accountRole } = useAuth();
  const canView =
    !!accountId &&
    (accountRole === 'agent' ||
      accountRole === 'supervisor' ||
      accountRole === 'admin' ||
      accountRole === 'owner');
  const stats = useQuery(api.qualification.pipelineSummary, canView ? {} : 'skip');

  if (!canView) return null;

  return (
    <section className="flex h-full flex-col rounded-xl border border-border bg-card">
      <header className="flex items-start justify-between gap-2 border-b border-border px-5 py-4">
        <div>
          <h2 className="text-sm font-semibold text-foreground">{t('title')}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">{t('description')}</p>
        </div>
        <Link
          href="/leads"
          className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-primary hover:underline"
        >
          {t('viewBoard')}
          <ArrowRight className="h-3 w-3" />
        </Link>
      </header>

      <div className="flex flex-1 flex-col p-5">
        {!stats ? (
          <Skeleton className="h-40 w-full" />
        ) : stats.total === 0 ? (
          <EmptyState icon={GitBranch} title={t('empty')} hint={t('emptyHint')} />
        ) : (
          <>
            <div className="flex h-2.5 w-full gap-px overflow-hidden rounded-full bg-muted">
              {stats.stages
                .filter((s) => s.count > 0)
                .map((s) => (
                  <div
                    key={s.key}
                    className={cn('h-full', STAGE_BG[s.key as PipelineStageKey])}
                    style={{ width: `${(s.count / stats.total) * 100}%` }}
                    title={`${tFunnel(`stage.${s.key}` as never)}: ${s.count}`}
                  />
                ))}
            </div>

            <ul className="mt-4 space-y-1.5">
              {stats.stages
                .filter((s) => s.count > 0 || s.key === 'qualified')
                .map((s) => (
                  <li key={s.key} className="flex items-center gap-2.5 text-xs">
                    <span
                      className={cn(
                        'size-2 shrink-0 rounded-full',
                        STAGE_BG[s.key as PipelineStageKey],
                      )}
                      aria-hidden
                    />
                    <span className="flex-1 truncate text-muted-foreground">
                      {tFunnel(`stage.${s.key}` as never)}
                    </span>
                    <span className="tabular-nums font-medium text-foreground">{s.count}</span>
                  </li>
                ))}
            </ul>

            <div className="mt-auto flex flex-wrap items-center gap-x-4 gap-y-1 pt-4 text-xs text-muted-foreground">
              {stats.wonByCurrency.map((won) => (
                <span
                  key={won.currency}
                  className="inline-flex items-center gap-1 text-emerald-500"
                >
                  <Trophy className="h-3 w-3" />
                  {formatCurrencyShort(won.value, won.currency)}
                </span>
              ))}
              {stats.winRate !== null ? <span>{t('winRate', { rate: stats.winRate })}</span> : null}
              {stats.inQualification > 0 ? (
                <span>
                  {t('inQualification', { count: stats.inQualification })}
                  {/* The backend clamps both takes at 500 and reports it
                      rather than presenting the ceiling as exact. */}
                  {stats.capped ? '+' : ''}
                </span>
              ) : null}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
