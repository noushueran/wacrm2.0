'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { format } from 'date-fns';
import {
  BadgeCheck,
  ClipboardCheck,
  ExternalLink,
  Megaphone,
  Globe,
  MessageCircle,
  Timer,
} from 'lucide-react';

import { useQuery } from '@/lib/convex/cached';
import { useAuth } from '@/hooks/use-auth';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';

import { api } from '../../../../convex/_generated/api';

// ============================================================
// Leads workspace (qualification P4 — spec §10): the sales queue.
// Qualified leads first, sorted by score (highest first), then
// in-progress with progress bars, then closed states. Each row expands
// into the detail panel: every collected answer, the marks breakdown,
// source, follow-up state, and the open-chat deep link. Supervisor+
// (route-gated by canAccessRoute's blanket rule; the query re-checks
// server-side).
// ============================================================

type Board = NonNullable<ReturnType<typeof useLeadsBoard>>;
type Lead = Board['leads'][number];

function useLeadsBoard() {
  const { accountRole } = useAuth();
  const canView =
    accountRole === 'agent' ||
    accountRole === 'supervisor' ||
    accountRole === 'admin' ||
    accountRole === 'owner';
  return useQuery(api.qualification.leadsBoard, canView ? {} : 'skip');
}

const STATUS_STYLE: Record<string, string> = {
  qualified: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-500',
  collecting: 'border-primary/40 bg-primary/10 text-primary',
  expired: 'border-border bg-muted text-muted-foreground',
  opted_out: 'border-red-500/40 bg-red-500/10 text-red-400',
  disqualified: 'border-border bg-muted text-muted-foreground',
};

const SOURCE_ICON = { ad: Megaphone, website: Globe, organic: MessageCircle } as const;

function ScoreBadge({ score }: { score: number | null }) {
  if (score === null) return null;
  const tone =
    score >= 70
      ? 'border-emerald-500/40 text-emerald-500'
      : score >= 40
        ? 'border-amber-500/40 text-amber-500'
        : 'border-border text-muted-foreground';
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-semibold tabular-nums',
        tone,
      )}
    >
      {score}
    </span>
  );
}

function Stat({ label, value, accent }: { label: string; value: string | number; accent?: boolean }) {
  return (
    <Card>
      <CardContent className="pt-5 pb-4">
        <p className={cn('text-2xl font-bold tabular-nums', accent ? 'text-primary' : 'text-foreground')}>
          {value}
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">{label}</p>
      </CardContent>
    </Card>
  );
}

function LeadDetail({ lead, t }: { lead: Lead; t: ReturnType<typeof useTranslations> }) {
  return (
    <div className="grid gap-4 border-t border-border pt-4 sm:grid-cols-2">
      <div>
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t('detail.answers')}
        </p>
        {lead.fields.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('detail.noAnswers')}</p>
        ) : (
          <dl className="space-y-1.5">
            {lead.fields.map((f) => (
              <div key={f.key} className="flex items-baseline gap-2 text-sm">
                <dt className="shrink-0 text-muted-foreground">{f.label ?? f.key}:</dt>
                <dd className="min-w-0 break-words font-medium text-foreground">{f.value}</dd>
                {f.confidence === 'low' ? (
                  <span className="text-[10px] text-muted-foreground">({t('detail.unsure')})</span>
                ) : null}
              </div>
            ))}
          </dl>
        )}
        {lead.summary ? (
          <p className="mt-3 rounded-lg bg-muted/60 p-2.5 text-sm text-muted-foreground">
            {lead.summary}
          </p>
        ) : null}
      </div>
      <div>
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t('detail.marks')}
        </p>
        {lead.scoreBreakdown.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('detail.noMarks')}</p>
        ) : (
          <div className="space-y-1.5">
            {lead.scoreBreakdown.map((b, i) => (
              <div key={`${b.criterion}-${i}`} className="text-sm">
                <div className="flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate text-muted-foreground">{b.criterion}</span>
                  <span className="shrink-0 font-medium tabular-nums text-foreground">
                    {b.marks}/{b.maxMarks}
                  </span>
                </div>
                {b.reason ? (
                  <p className="text-xs text-muted-foreground/80">{b.reason}</p>
                ) : null}
              </div>
            ))}
          </div>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span>
            {t('detail.followUps', { count: lead.followUpsSent })}
          </span>
          {lead.nextFollowUpAt ? (
            <span className="inline-flex items-center gap-1">
              <Timer className="h-3 w-3" />
              {t('detail.nextFollowUp', {
                at: format(new Date(lead.nextFollowUpAt), 'MMM d · HH:mm'),
              })}
            </span>
          ) : null}
          {lead.qualifiedAt ? (
            <span>{t('detail.qualifiedAt', { at: format(new Date(lead.qualifiedAt), 'MMM d · HH:mm') })}</span>
          ) : null}
          {lead.closedReason ? <span>{t(`closedReason.${lead.closedReason}` as never)}</span> : null}
        </div>
      </div>
    </div>
  );
}

export default function LeadsPage() {
  const t = useTranslations('Leads');
  const board = useLeadsBoard();
  const [openId, setOpenId] = useState<string | null>(null);

  const grouped = useMemo(() => {
    if (!board) return [];
    return board.leads;
  }, [board]);

  return (
    <div>
      <div className="flex items-center gap-2">
        <ClipboardCheck className="h-6 w-6 text-primary" />
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">{t('pageTitle')}</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">{t('pageDesc')}</p>
        </div>
      </div>

      {!board ? (
        <p className="mt-8 text-sm text-muted-foreground">{t('loading')}</p>
      ) : (
        <>
          <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
            <Stat label={t('summary.qualified')} value={board.summary.qualified} accent />
            <Stat label={t('summary.collecting')} value={board.summary.collecting} />
            <Stat label={t('summary.expired')} value={board.summary.expired} />
            <Stat label={t('summary.optedOut')} value={board.summary.opted_out} />
            <Stat label={t('summary.rate')} value={`${board.summary.qualificationRate}%`} />
            <Stat label={t('summary.avgScore')} value={board.summary.avgScore} />
          </div>

          <div className="mt-6 space-y-2">
            {grouped.length === 0 ? (
              <Card>
                <CardContent className="py-10 text-center text-sm text-muted-foreground">
                  {t('empty')}
                </CardContent>
              </Card>
            ) : (
              grouped.map((lead) => {
                const SourceIcon = SOURCE_ICON[lead.source];
                const open = openId === lead.sessionId;
                return (
                  <Card key={lead.sessionId} className={cn(open && 'border-primary/40')}>
                    <CardContent className="py-4">
                      <div className="flex w-full flex-wrap items-center gap-x-3 gap-y-2">
                      <button
                        type="button"
                        onClick={() => setOpenId(open ? null : lead.sessionId)}
                        className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-2 text-left"
                      >
                        <ScoreBadge score={lead.score} />
                        <span className="min-w-0 flex-1 truncate">
                          <span className="font-medium text-foreground">{lead.contactName}</span>
                          <span className="ml-2 text-sm text-muted-foreground">{lead.contactPhone}</span>
                        </span>
                        {lead.serviceName ? (
                          <Badge variant="secondary" className="hidden sm:inline-flex">
                            {lead.serviceName}
                          </Badge>
                        ) : null}
                        <Badge variant="outline" className="hidden gap-1 text-[10px] sm:inline-flex">
                          <SourceIcon className="h-3 w-3" />
                          {t(`source.${lead.source}`)}
                        </Badge>
                        <Badge
                          variant="outline"
                          className={cn('gap-1 text-[10px]', STATUS_STYLE[lead.status])}
                        >
                          {lead.status === 'qualified' ? <BadgeCheck className="h-3 w-3" /> : null}
                          {t(`status.${lead.status}`)}
                        </Badge>
                        <span className="text-xs tabular-nums text-muted-foreground">
                          {lead.answeredCount}/{lead.expectedCount}
                        </span>
                        {lead.assigneeName ? (
                          <span className="hidden text-xs text-muted-foreground lg:inline">
                            {t('assignedTo', { name: lead.assigneeName })}
                          </span>
                        ) : null}
                      </button>
                      <Link
                        href={`/inbox?c=${lead.conversationId}`}
                        className={cn(
                          buttonVariants({ variant: 'ghost', size: 'sm' }),
                          'shrink-0',
                        )}
                      >
                        <ExternalLink className="mr-1 h-3.5 w-3.5" />
                        {t('openChat')}
                      </Link>
                      </div>
                      {open ? <LeadDetail lead={lead} t={t} /> : null}
                    </CardContent>
                  </Card>
                );
              })
            )}
          </div>
        </>
      )}
    </div>
  );
}
