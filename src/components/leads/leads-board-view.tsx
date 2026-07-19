'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { format, formatDistanceToNow } from 'date-fns';
import {
  BadgeCheck,
  BadgeDollarSign,
  ClipboardCheck,
  Copy,
  ExternalLink,
  Globe,
  ListChecks,
  Loader2,
  Megaphone,
  MessageCircle,
  Search,
  Timer,
  UserRound,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { LeadChecklist, type LeadChecklistData } from '@/components/leads/lead-checklist';
import {
  LeadsPipelineView,
  type StageChangeExtras,
} from '@/components/leads/leads-pipeline-view';
import type { PipelineStageKey } from '@/lib/leads/pipeline';
import { cn } from '@/lib/utils';

// ============================================================
// LeadsBoardView — the presentational Leads workspace (v5 visual
// upgrade): status filter pills + service filter + search, score rings,
// assignee front-and-center, offer/feedback trail in the detail panel.
// v6 adds the List | Pipeline toggle (deals kanban over the funnel) and
// the per-lead sales checklist. Pure view over the `leadsBoard` payload
// so it can be rendered with mock data for visual verification —
// mutations arrive as props from the page.
// ============================================================

export interface LeadRow {
  sessionId: string;
  conversationId: string;
  status: string;
  origin: string;
  score: number | null;
  serviceName: string | null;
  summary: string | null;
  answeredCount: number;
  expectedCount: number;
  followUpsSent: number;
  nextFollowUpAt: number | null;
  qualifiedAt: number | null;
  closedReason: string | null;
  startedAt: number;
  contactName: string;
  contactPhone: string;
  source: 'ad' | 'website' | 'organic';
  assigneeName: string | null;
  fields: { key: string; label: string | null; value: string; confidence: string }[];
  scoreBreakdown: { criterion: string; marks: number; maxMarks: number; reason: string | null }[];
  assignment: {
    acceptedAt: number | null;
    offersMade: number;
    lastFeedback: string | null;
    lastFeedbackAt: number | null;
  };
  funnelStage: string | null;
  funnelStageUpdatedAt: number | null;
  saleValue: number | null;
  saleCurrency: string | null;
  purchase: {
    status: 'sent' | 'not_met';
    confidence: number;
    reasons: string[];
    value: number | null;
    currency: string | null;
    sentAt: number | null;
    manual: boolean;
  } | null;
  checklist: LeadChecklistData | null;
}

export type LeadsView = 'list' | 'pipeline';

export interface LeadsBoardData {
  summary: {
    collecting: number;
    qualified: number;
    expired: number;
    opted_out: number;
    disqualified: number;
    total: number;
    qualificationRate: number;
    avgScore: number;
  };
  leads: LeadRow[];
}

const STATUS_STYLE: Record<string, string> = {
  qualified: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-500',
  collecting: 'border-primary/40 bg-primary/10 text-primary',
  expired: 'border-border bg-muted text-muted-foreground',
  opted_out: 'border-red-500/40 bg-red-500/10 text-red-400',
  disqualified: 'border-border bg-muted text-muted-foreground',
};

const SOURCE_ICON = { ad: Megaphone, website: Globe, organic: MessageCircle } as const;

type StatusFilter = 'all' | 'qualified' | 'collecting' | 'closed';
const CLOSED = new Set(['expired', 'opted_out', 'disqualified']);

function scoreTone(score: number): string {
  if (score >= 70) return 'text-emerald-500 border-emerald-500/50';
  if (score >= 40) return 'text-amber-500 border-amber-500/50';
  return 'text-muted-foreground border-border';
}

/** Compact score ring — a conic gradient dial with the number inside. */
function ScoreRing({ score }: { score: number | null }) {
  if (score === null) {
    return (
      <div className="flex size-11 shrink-0 items-center justify-center rounded-full border-2 border-dashed border-border text-[10px] text-muted-foreground">
        —
      </div>
    );
  }
  const hue = score >= 70 ? '#10b981' : score >= 40 ? '#f59e0b' : '#94a3b8';
  return (
    <div
      className="flex size-11 shrink-0 items-center justify-center rounded-full p-[3px]"
      style={{ background: `conic-gradient(${hue} ${score * 3.6}deg, color-mix(in srgb, ${hue} 18%, transparent) 0deg)` }}
      role="img"
      aria-label={`Score ${score} out of 100`}
    >
      <div className={cn('flex size-full items-center justify-center rounded-full bg-card text-sm font-bold tabular-nums', scoreTone(score))}>
        {score}
      </div>
    </div>
  );
}

function MiniBar({ value, max, className }: { value: number; max: number; className?: string }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <div className={cn('h-1.5 w-full overflow-hidden rounded-full bg-muted', className)}>
      <div className="h-full rounded-full bg-primary/70" style={{ width: `${pct}%` }} />
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: string | number; accent?: boolean }) {
  return (
    <Card>
      <CardContent className="pb-4 pt-5">
        <p className={cn('text-2xl font-bold tabular-nums', accent ? 'text-primary' : 'text-foreground')}>
          {value}
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">{label}</p>
      </CardContent>
    </Card>
  );
}

/** The purchase-signal verdict card (spec 2026-07-19-purchase-signals):
 *  what the judge decided, and the supervisor+ manual-fire escape hatch
 *  for case-by-case calls the criteria text didn't anticipate. */
function PurchaseSignalCard({
  lead,
  t,
  canSendPurchase,
  onSendPurchaseSignal,
}: {
  lead: LeadRow;
  t: ReturnType<typeof useTranslations>;
  canSendPurchase: boolean;
  onSendPurchaseSignal: (lead: LeadRow) => Promise<void>;
}) {
  const [sending, setSending] = useState(false);
  if (lead.status !== 'qualified') return null;
  const p = lead.purchase;
  const canFire = canSendPurchase && p?.status !== 'sent' && lead.source !== 'organic';
  if (!p && !canFire) return null;
  return (
    <div className="space-y-1.5 rounded-lg border border-border p-3 text-sm">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {t('purchase.title')}
      </p>
      {p?.status === 'sent' ? (
        <>
          <p className="flex items-center gap-1.5 font-medium text-emerald-500">
            <BadgeDollarSign className="h-3.5 w-3.5" />
            {t('purchase.sent')}
            {p.manual ? (
              <span className="text-[10px] font-normal text-muted-foreground">
                {t('purchase.manual')}
              </span>
            ) : null}
          </p>
          {p.value !== null ? (
            <p className="text-xs text-muted-foreground">
              {t('purchase.reportedValue', { value: p.value, currency: p.currency ?? '' })}
            </p>
          ) : null}
        </>
      ) : p ? (
        <p className="font-medium text-muted-foreground">
          {t('purchase.notMet', { confidence: p.confidence })}
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">{t('purchase.notEvaluated')}</p>
      )}
      {p && p.reasons.length > 0 ? (
        <ul className="space-y-0.5 text-xs text-muted-foreground">
          {p.reasons.slice(0, 4).map((reason, i) => (
            <li key={i}>• {reason}</li>
          ))}
        </ul>
      ) : null}
      {canFire ? (
        <Button
          size="sm"
          variant="outline"
          disabled={sending}
          onClick={async () => {
            setSending(true);
            try {
              await onSendPurchaseSignal(lead);
            } finally {
              setSending(false);
            }
          }}
        >
          {sending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
          {t('purchase.send')}
        </Button>
      ) : null}
    </div>
  );
}

function LeadDetail({
  lead,
  t,
  canEdit,
  canSendPurchase,
  onCompleteItem,
  onReopenItem,
  onSendPurchaseSignal,
  bare,
}: {
  lead: LeadRow;
  t: ReturnType<typeof useTranslations>;
  canEdit: boolean;
  canSendPurchase: boolean;
  onCompleteItem: (lead: LeadRow, itemKey: string, note: string) => Promise<void>;
  onReopenItem: (lead: LeadRow, itemKey: string) => Promise<void>;
  onSendPurchaseSignal: (lead: LeadRow) => Promise<void>;
  /** true inside the pipeline card dialog (no top border needed). */
  bare?: boolean;
}) {
  return (
    <div className={cn(!bare && 'border-t border-border pt-4')}>
      {lead.status === 'qualified' || lead.checklist ? (
        <LeadChecklist
          checklist={lead.checklist}
          canEdit={canEdit}
          onCompleteItem={(itemKey, note) => onCompleteItem(lead, itemKey, note)}
          onReopenItem={(itemKey) => onReopenItem(lead, itemKey)}
          className="mb-5"
        />
      ) : null}
      <div className="grid gap-5 lg:grid-cols-3">
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
          <p className="mt-3 rounded-lg bg-muted/60 p-2.5 text-sm text-muted-foreground">{lead.summary}</p>
        ) : null}
      </div>

      <div>
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t('detail.marks')}
        </p>
        {lead.scoreBreakdown.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('detail.noMarks')}</p>
        ) : (
          <div className="space-y-2">
            {lead.scoreBreakdown.map((b, i) => (
              <div key={`${b.criterion}-${i}`} className="text-sm">
                <div className="flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate text-muted-foreground">{b.criterion}</span>
                  <span className="shrink-0 font-medium tabular-nums text-foreground">
                    {b.marks}/{b.maxMarks}
                  </span>
                </div>
                <MiniBar value={b.marks} max={b.maxMarks} className="mt-1" />
                {b.reason ? <p className="mt-0.5 text-xs text-muted-foreground/80">{b.reason}</p> : null}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="space-y-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t('detail.assignmentTitle')}
        </p>
        <div className="rounded-lg border border-border p-3 text-sm">
          {lead.assigneeName ? (
            <>
              <p className="flex items-center gap-1.5 font-medium text-foreground">
                <UserRound className="h-3.5 w-3.5 text-primary" />
                {lead.assigneeName}
              </p>
              {lead.assignment.acceptedAt ? (
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {t('detail.acceptedAgo', {
                    ago: formatDistanceToNow(new Date(lead.assignment.acceptedAt), { addSuffix: true }),
                  })}
                </p>
              ) : null}
            </>
          ) : (
            <p className="font-medium text-amber-500">{t('detail.unassigned')}</p>
          )}
          {lead.assignment.offersMade > 0 ? (
            <p className="mt-1 text-xs text-muted-foreground">
              {t('detail.offersMade', { count: lead.assignment.offersMade })}
            </p>
          ) : null}
        </div>
        {lead.assignment.lastFeedback ? (
          <div className="rounded-lg bg-muted/60 p-2.5">
            <p className="text-xs font-medium text-muted-foreground">
              {t('detail.lastUpdate', {
                ago: lead.assignment.lastFeedbackAt
                  ? formatDistanceToNow(new Date(lead.assignment.lastFeedbackAt), { addSuffix: true })
                  : '',
              })}
            </p>
            <p className="mt-1 text-sm text-foreground">{lead.assignment.lastFeedback}</p>
          </div>
        ) : null}
        <PurchaseSignalCard
          lead={lead}
          t={t}
          canSendPurchase={canSendPurchase}
          onSendPurchaseSignal={onSendPurchaseSignal}
        />

        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span>{t('detail.followUps', { count: lead.followUpsSent })}</span>
          {lead.nextFollowUpAt ? (
            <span className="inline-flex items-center gap-1">
              <Timer className="h-3 w-3" />
              {t('detail.nextFollowUp', { at: format(new Date(lead.nextFollowUpAt), 'MMM d · HH:mm') })}
            </span>
          ) : null}
          {lead.qualifiedAt ? (
            <span>{t('detail.qualifiedAt', { at: format(new Date(lead.qualifiedAt), 'MMM d · HH:mm') })}</span>
          ) : null}
          {lead.closedReason ? <span>{t(`closedReason.${lead.closedReason}` as never)}</span> : null}
        </div>
      </div>
      </div>
    </div>
  );
}

export interface LeadsBoardViewProps {
  board: LeadsBoardData;
  view: LeadsView;
  onViewChange: (view: LeadsView) => void;
  canEdit: boolean;
  /** supervisor+ — shows the manual "send purchase signal" action. */
  canSendPurchase: boolean;
  onCompleteItem: (lead: LeadRow, itemKey: string, note: string) => Promise<void>;
  onReopenItem: (lead: LeadRow, itemKey: string) => Promise<void>;
  onSendPurchaseSignal: (lead: LeadRow) => Promise<void>;
  onStageChange: (
    lead: LeadRow,
    stage: PipelineStageKey,
    extras?: StageChangeExtras,
  ) => Promise<boolean>;
}

export function LeadsBoardView({
  board,
  view,
  onViewChange,
  canEdit,
  canSendPurchase,
  onCompleteItem,
  onReopenItem,
  onSendPurchaseSignal,
  onStageChange,
}: LeadsBoardViewProps) {
  const t = useTranslations('Leads');
  const tFunnel = useTranslations('Inbox.funnel');
  const [openId, setOpenId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [serviceFilter, setServiceFilter] = useState<string>('all');
  const [search, setSearch] = useState('');

  const services = useMemo(
    () => [...new Set(board.leads.map((l) => l.serviceName).filter((s): s is string => !!s))].sort(),
    [board.leads],
  );

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return board.leads.filter((l) => {
      if (statusFilter === 'qualified' && l.status !== 'qualified') return false;
      if (statusFilter === 'collecting' && l.status !== 'collecting') return false;
      if (statusFilter === 'closed' && !CLOSED.has(l.status)) return false;
      if (serviceFilter !== 'all' && l.serviceName !== serviceFilter) return false;
      if (
        q &&
        ![l.contactName, l.contactPhone, l.serviceName ?? '', l.assigneeName ?? '', l.summary ?? '']
          .join(' ')
          .toLowerCase()
          .includes(q)
      ) {
        return false;
      }
      return true;
    });
  }, [board.leads, statusFilter, serviceFilter, search]);

  const pills: { id: StatusFilter; label: string; count: number }[] = [
    { id: 'all', label: t('filters.all'), count: board.leads.length },
    { id: 'qualified', label: t('summary.qualified'), count: board.summary.qualified },
    { id: 'collecting', label: t('summary.collecting'), count: board.summary.collecting },
    {
      id: 'closed',
      label: t('filters.closed'),
      count: board.summary.expired + board.summary.opted_out + board.summary.disqualified,
    },
  ];

  const viewPills: { id: LeadsView; label: string }[] = [
    { id: 'list', label: t('view.list') },
    { id: 'pipeline', label: t('view.pipeline') },
  ];

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <ClipboardCheck className="h-6 w-6 text-primary" />
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-bold tracking-tight text-foreground">{t('pageTitle')}</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">{t('pageDesc')}</p>
        </div>
        <div className="flex shrink-0 items-center rounded-full border border-border p-0.5">
          {viewPills.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => onViewChange(p.id)}
              className={cn(
                'rounded-full px-3 py-1 text-xs font-medium transition-colors',
                view === p.id
                  ? 'bg-primary/10 text-primary'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {view === 'pipeline' ? (
        <LeadsPipelineView
          leads={board.leads}
          canEdit={canEdit}
          onStageChange={onStageChange}
          inQualificationCount={board.summary.collecting}
          onShowList={() => onViewChange('list')}
          renderLeadDetail={(lead) => (
            <LeadDetail
              lead={lead}
              t={t}
              canEdit={canEdit}
              canSendPurchase={canSendPurchase}
              onCompleteItem={onCompleteItem}
              onReopenItem={onReopenItem}
              onSendPurchaseSignal={onSendPurchaseSignal}
              bare
            />
          )}
        />
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

      <div className="mt-6 flex flex-wrap items-center gap-2">
        {pills.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => setStatusFilter(p.id)}
            className={cn(
              'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
              statusFilter === p.id
                ? 'border-primary/60 bg-primary/10 text-primary'
                : 'border-border text-muted-foreground hover:bg-muted',
            )}
          >
            {p.label} <span className="tabular-nums opacity-70">{p.count}</span>
          </button>
        ))}
        {services.length > 0 ? (
          <select
            value={serviceFilter}
            onChange={(e) => setServiceFilter(e.target.value)}
            className="h-7 rounded-full border border-border bg-background px-2 text-xs text-foreground"
            aria-label={t('filters.service')}
          >
            <option value="all">{t('filters.allServices')}</option>
            {services.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        ) : null}
        <div className="relative ml-auto w-full sm:w-56">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('filters.searchPlaceholder')}
            className="h-8 pl-8 text-sm"
          />
        </div>
      </div>

      <div className="mt-4 space-y-2">
        {visible.length === 0 ? (
          <Card>
            <CardContent className="py-10 text-center text-sm text-muted-foreground">
              {board.leads.length === 0 ? t('empty') : t('filters.noMatches')}
            </CardContent>
          </Card>
        ) : (
          visible.map((lead) => {
            const SourceIcon = SOURCE_ICON[lead.source];
            const open = openId === lead.sessionId;
            return (
              <Card key={lead.sessionId} className={cn(open && 'border-primary/40')}>
                <CardContent className="py-3.5">
                  <div className="flex w-full items-start gap-3">
                    <button
                      type="button"
                      onClick={() => setOpenId(open ? null : lead.sessionId)}
                      className="flex min-w-0 flex-1 items-center gap-3 text-left"
                    >
                      <ScoreRing score={lead.score} />
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                          <span className="font-medium text-foreground">{lead.contactName}</span>
                          {lead.contactPhone !== lead.contactName ? (
                            <span className="whitespace-nowrap text-xs text-muted-foreground">{lead.contactPhone}</span>
                          ) : null}
                          <Badge
                            variant="outline"
                            className={cn('gap-1 text-[10px]', STATUS_STYLE[lead.status])}
                          >
                            {lead.status === 'qualified' ? <BadgeCheck className="h-3 w-3" /> : null}
                            {t(`status.${lead.status}` as never)}
                          </Badge>
                          {lead.funnelStage && lead.funnelStage !== 'new_lead' ? (
                            <Badge
                              variant="outline"
                              className={cn(
                                'text-[10px]',
                                lead.funnelStage === 'purchased'
                                  ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-500'
                                  : lead.funnelStage === 'lost'
                                    ? 'border-red-500/40 bg-red-500/10 text-red-400'
                                    : 'border-border text-muted-foreground',
                              )}
                            >
                              {tFunnel(`stage.${lead.funnelStage}` as never)}
                            </Badge>
                          ) : null}
                          {lead.purchase?.status === 'sent' ? (
                            <Badge
                              variant="outline"
                              className="gap-1 border-emerald-500/40 bg-emerald-500/10 text-[10px] text-emerald-500"
                              title={t('purchase.sentTooltip')}
                            >
                              <BadgeDollarSign className="h-3 w-3" />
                              {t('purchase.sentBadge')}
                            </Badge>
                          ) : null}
                        </span>
                        <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                          {lead.serviceName ? <span className="font-medium">{lead.serviceName}</span> : null}
                          <span className="inline-flex items-center gap-1">
                            <SourceIcon className="h-3 w-3" />
                            {t(`source.${lead.source}` as never)}
                          </span>
                          <span className="inline-flex min-w-20 items-center gap-1.5">
                            <span className="tabular-nums">{lead.answeredCount}/{lead.expectedCount}</span>
                            <MiniBar value={lead.answeredCount} max={lead.expectedCount} className="w-12" />
                          </span>
                          {lead.checklist ? (
                            <span
                              className={cn(
                                'inline-flex items-center gap-1',
                                lead.checklist.doneCount === lead.checklist.total &&
                                  lead.checklist.total > 0 &&
                                  'text-emerald-500',
                              )}
                              title={t('checklist.title')}
                            >
                              <ListChecks className="h-3 w-3" />
                              <span className="tabular-nums">
                                {lead.checklist.doneCount}/{lead.checklist.total}
                              </span>
                            </span>
                          ) : null}
                          <span className={cn('inline-flex items-center gap-1', !lead.assigneeName && 'text-amber-500')}>
                            <UserRound className="h-3 w-3" />
                            {lead.assigneeName ?? t('detail.unassigned')}
                          </span>
                          <span>{formatDistanceToNow(new Date(lead.startedAt), { addSuffix: true })}</span>
                        </span>
                      </span>
                    </button>
                    <div className="flex shrink-0 items-center gap-1">
                      <button
                        type="button"
                        onClick={() => navigator.clipboard?.writeText(lead.contactPhone)}
                        className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'px-2')}
                        title={t('copyPhone')}
                      >
                        <Copy className="h-3.5 w-3.5" />
                      </button>
                      <Link
                        href={`/inbox?c=${lead.conversationId}`}
                        className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'px-2 sm:px-3')}
                        title={t('openChat')}
                      >
                        <ExternalLink className="h-3.5 w-3.5 sm:mr-1" />
                        <span className="hidden sm:inline">{t('openChat')}</span>
                      </Link>
                    </div>
                  </div>
                  {open ? (
                    <LeadDetail
                      lead={lead}
                      t={t}
                      canEdit={canEdit}
                      canSendPurchase={canSendPurchase}
                      onCompleteItem={onCompleteItem}
                      onReopenItem={onReopenItem}
                      onSendPurchaseSignal={onSendPurchaseSignal}
                    />
                  ) : null}
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
