'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { ArrowRight, GitBranch, Trophy } from 'lucide-react';

import { useQuery } from '@/lib/convex/cached';
import { useAuth } from '@/hooks/use-auth';
import { groupLeadsByStage, PIPELINE_STAGE_KEYS, type PipelineStageKey } from '@/lib/leads/pipeline';
import { formatCurrencyShort } from '@/lib/currency';
import { cn } from '@/lib/utils';
import { EmptyState } from './empty-state';
import { Skeleton } from './skeleton';

import { api } from '../../../convex/_generated/api';

// ============================================================
// LeadsPipelineCard — the dashboard's compact view of the REAL deals
// pipeline (qualified leads over the funnel), replacing the legacy
// pipelines/deals donut. One segmented bar + per-stage counts, win
// rate, and won value; links through to /leads' Pipeline view. Reads
// the same cached `leadsBoard` subscription the leads page uses, so
// visiting both costs one query. Render-gated by the caller (viewers
// may not call `leadsBoard`).
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
  // Same account-readiness gate as every dashboard query; viewers have no
  // lead queue (`leadsBoard` would throw), so the card self-hides.
  const { accountId, accountRole } = useAuth();
  const canView =
    !!accountId &&
    (accountRole === 'agent' ||
      accountRole === 'supervisor' ||
      accountRole === 'admin' ||
      accountRole === 'owner');
  const board = useQuery(api.qualification.leadsBoard, canView ? {} : 'skip');

  const stats = useMemo(() => {
    if (!board) return null;
    const grouped = groupLeadsByStage(board.leads);
    const stages = PIPELINE_STAGE_KEYS.map((key) => ({
      key,
      count: grouped[key].length,
    }));
    const total = stages.reduce((n, s) => n + s.count, 0);
    const closed = grouped.purchased.length + grouped.lost.length;
    const winRate = closed > 0 ? Math.round((grouped.purchased.length / closed) * 100) : null;
    const wonByCurrency = new Map<string, number>();
    for (const lead of grouped.purchased) {
      if (lead.saleValue && lead.saleValue > 0) {
        const cur = lead.saleCurrency ?? 'USD';
        wonByCurrency.set(cur, (wonByCurrency.get(cur) ?? 0) + lead.saleValue);
      }
    }
    return {
      stages,
      total,
      winRate,
      wonByCurrency: [...wonByCurrency.entries()],
      inQualification: board.summary.collecting,
    };
  }, [board]);

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
                    className={cn('h-full', STAGE_BG[s.key])}
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
                    <span className={cn('size-2 shrink-0 rounded-full', STAGE_BG[s.key])} aria-hidden />
                    <span className="flex-1 truncate text-muted-foreground">
                      {tFunnel(`stage.${s.key}` as never)}
                    </span>
                    <span className="tabular-nums font-medium text-foreground">{s.count}</span>
                  </li>
                ))}
            </ul>

            <div className="mt-auto flex flex-wrap items-center gap-x-4 gap-y-1 pt-4 text-xs text-muted-foreground">
              {stats.wonByCurrency.map(([currency, value]) => (
                <span key={currency} className="inline-flex items-center gap-1 text-emerald-500">
                  <Trophy className="h-3 w-3" />
                  {formatCurrencyShort(value, currency)}
                </span>
              ))}
              {stats.winRate !== null ? <span>{t('winRate', { rate: stats.winRate })}</span> : null}
              {stats.inQualification > 0 ? (
                <span>{t('inQualification', { count: stats.inQualification })}</span>
              ) : null}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
