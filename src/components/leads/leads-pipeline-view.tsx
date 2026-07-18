'use client';

import { useMemo, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { formatDistanceToNow } from 'date-fns';
import { ChevronDown, GripVertical, ListChecks, Trophy, UserRound, XCircle } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea, ScrollBar } from '@/components/ui/scroll-area';
import { LossReasonDialog } from '@/components/leads/loss-reason-dialog';
import {
  PIPELINE_STAGE_KEYS,
  effectivePipelineStage,
  groupLeadsByStage,
  type LossCategoryKey,
  type PipelineStageKey,
} from '@/lib/leads/pipeline';
import { formatCurrencyShort } from '@/lib/currency';
import { cn } from '@/lib/utils';

// ============================================================
// LeadsPipelineView — the deals kanban over the funnel stages.
// Structural over the board payload (no import from leads-board-view —
// the board renders THIS view and supplies `renderLeadDetail`, keeping
// the module graph acyclic and this component mock-renderable).
// Desktop: native HTML5 drag-and-drop between columns. Touch/keyboard:
// the per-card "Move to stage" menu. Won asks for the sale value,
// Lost demands the exact reason (LossReasonDialog); the server
// enforces both plus the checklist-complete gate.
// ============================================================

export interface PipelineLead {
  sessionId: string;
  conversationId: string;
  status: string;
  score: number | null;
  serviceName: string | null;
  contactName: string;
  assigneeName: string | null;
  funnelStage: string | null;
  funnelStageUpdatedAt: number | null;
  saleValue: number | null;
  saleCurrency: string | null;
  qualifiedAt: number | null;
  checklist: {
    doneCount: number;
    total: number;
    outcome: { result: 'won' | 'lost'; lossCategory: string | null; lossDetail: string | null; at: number } | null;
  } | null;
}

export interface StageChangeExtras {
  saleValue?: number;
  lossCategory?: LossCategoryKey;
  lossDetail?: string;
}

interface LeadsPipelineViewProps<L extends PipelineLead> {
  leads: L[];
  canEdit: boolean;
  /** Applies the move server-side; resolve false to leave the card put. */
  onStageChange: (lead: L, stage: PipelineStageKey, extras?: StageChangeExtras) => Promise<boolean>;
  /** Full detail block (answers/marks/checklist) rendered in the card dialog. */
  renderLeadDetail: (lead: L) => ReactNode;
  inQualificationCount: number;
  onShowList: () => void;
}

const STAGE_DOT: Record<PipelineStageKey, string> = {
  qualified: 'bg-primary',
  price_quoted: 'bg-sky-500',
  itinerary_created: 'bg-violet-500',
  itinerary_sent: 'bg-fuchsia-500',
  invoice_sent: 'bg-amber-500',
  purchased: 'bg-emerald-500',
  lost: 'bg-red-500',
};

function scoreDotTone(score: number | null): string {
  if (score === null) return 'bg-muted text-muted-foreground';
  if (score >= 70) return 'bg-emerald-500/15 text-emerald-500';
  if (score >= 40) return 'bg-amber-500/15 text-amber-500';
  return 'bg-muted text-muted-foreground';
}

export function LeadsPipelineView<L extends PipelineLead>({
  leads,
  canEdit,
  onStageChange,
  renderLeadDetail,
  inQualificationCount,
  onShowList,
}: LeadsPipelineViewProps<L>) {
  const t = useTranslations('Leads.pipeline');
  const tFunnel = useTranslations('Inbox.funnel');

  const [dragId, setDragId] = useState<string | null>(null);
  const [overStage, setOverStage] = useState<PipelineStageKey | null>(null);
  // The open-card dialog tracks the lead's ID, not the object — the board
  // payload refreshes reactively after every mutation, and the dialog must
  // re-render from the FRESH row (a stored snapshot would go stale the
  // moment a checklist item is ticked).
  const [openLeadId, setOpenLeadId] = useState<string | null>(null);
  const [lossFor, setLossFor] = useState<L | null>(null);
  const [valueFor, setValueFor] = useState<L | null>(null);
  const [valueText, setValueText] = useState('');
  const openLead = useMemo(
    () => (openLeadId ? (leads.find((l) => l.sessionId === openLeadId) ?? null) : null),
    [leads, openLeadId],
  );

  const grouped = useMemo(() => groupLeadsByStage(leads), [leads]);
  const deals = useMemo(
    () => PIPELINE_STAGE_KEYS.reduce((n, k) => n + grouped[k].length, 0),
    [grouped],
  );
  const wonValueByCurrency = useMemo(() => {
    const sums = new Map<string, number>();
    for (const lead of grouped.purchased) {
      if (lead.saleValue && lead.saleValue > 0) {
        const cur = lead.saleCurrency ?? 'USD';
        sums.set(cur, (sums.get(cur) ?? 0) + lead.saleValue);
      }
    }
    return [...sums.entries()];
  }, [grouped.purchased]);
  const winRate = useMemo(() => {
    const closed = grouped.purchased.length + grouped.lost.length;
    return closed > 0 ? Math.round((grouped.purchased.length / closed) * 100) : null;
  }, [grouped.purchased.length, grouped.lost.length]);

  // The one move entry point: dialogs for the gated stages, direct
  // mutation otherwise. Refreshed board data moves the card.
  const requestMove = (lead: L, stage: PipelineStageKey) => {
    if (!canEdit) return;
    if (effectivePipelineStage(lead) === stage) return;
    if (stage === 'purchased') {
      setValueText('');
      setValueFor(lead);
      return;
    }
    if (stage === 'lost') {
      setLossFor(lead);
      return;
    }
    void onStageChange(lead, stage);
  };

  const findLead = (sessionId: string) => leads.find((l) => l.sessionId === sessionId);

  return (
    <div className="mt-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{t('deals', { count: deals })}</span>
        {wonValueByCurrency.map(([currency, value]) => (
          <span key={currency} className="inline-flex items-center gap-1 text-emerald-500">
            <Trophy className="h-3 w-3" />
            {t('wonValue', { value: formatCurrencyShort(value, currency) })}
          </span>
        ))}
        {winRate !== null ? <span>{t('winRate', { rate: winRate })}</span> : null}
        {inQualificationCount > 0 ? (
          <button
            type="button"
            onClick={onShowList}
            className="underline-offset-2 hover:text-foreground hover:underline"
          >
            {t('inQualification', { count: inQualificationCount })}
          </button>
        ) : null}
      </div>

      {deals === 0 ? (
        <p className="mt-8 text-center text-sm text-muted-foreground">{t('empty')}</p>
      ) : (
        <ScrollArea className="mt-3 w-full whitespace-nowrap">
          <div className="flex items-start gap-3 pb-3">
            {PIPELINE_STAGE_KEYS.map((stage) => {
              const column = grouped[stage];
              const over = overStage === stage;
              return (
                <section
                  key={stage}
                  aria-label={tFunnel(`stage.${stage}` as never)}
                  className={cn(
                    'w-60 shrink-0 rounded-xl border border-border bg-muted/30 p-2 align-top',
                    over && canEdit && 'border-primary/60 bg-primary/5',
                  )}
                  onDragOver={(e) => {
                    if (!canEdit || !dragId) return;
                    e.preventDefault();
                    setOverStage(stage);
                  }}
                  onDragLeave={() => setOverStage((s) => (s === stage ? null : s))}
                  onDrop={(e) => {
                    if (!canEdit) return;
                    e.preventDefault();
                    const id = e.dataTransfer.getData('text/plain') || dragId;
                    setOverStage(null);
                    setDragId(null);
                    const lead = id ? findLead(id) : undefined;
                    if (lead) requestMove(lead, stage);
                  }}
                >
                  <header className="flex items-center gap-2 px-1 pb-2">
                    <span className={cn('size-2 rounded-full', STAGE_DOT[stage])} />
                    <span className="text-xs font-semibold text-foreground">
                      {tFunnel(`stage.${stage}` as never)}
                    </span>
                    <span className="ml-auto text-xs tabular-nums text-muted-foreground">
                      {column.length}
                    </span>
                  </header>

                  <div className="space-y-2">
                    {column.length === 0 ? (
                      <p className="whitespace-normal rounded-lg border border-dashed border-border px-2 py-3 text-center text-[11px] text-muted-foreground">
                        {over && canEdit ? t('dropHere') : '—'}
                      </p>
                    ) : (
                      column.map((lead) => {
                        const checklist = lead.checklist;
                        const checklistDone =
                          checklist !== null && checklist.total > 0 && checklist.doneCount === checklist.total;
                        return (
                          <article
                            key={lead.sessionId}
                            draggable={canEdit}
                            onDragStart={(e) => {
                              e.dataTransfer.setData('text/plain', lead.sessionId);
                              e.dataTransfer.effectAllowed = 'move';
                              setDragId(lead.sessionId);
                            }}
                            onDragEnd={() => {
                              setDragId(null);
                              setOverStage(null);
                            }}
                            className={cn(
                              'group cursor-pointer whitespace-normal rounded-lg border border-border bg-card p-2.5 shadow-sm transition-shadow hover:shadow',
                              dragId === lead.sessionId && 'opacity-50',
                            )}
                            onClick={() => setOpenLeadId(lead.sessionId)}
                          >
                            <div className="flex items-start gap-2">
                              {canEdit ? (
                                <GripVertical className="mt-0.5 h-3.5 w-3.5 shrink-0 cursor-grab text-muted-foreground/50" />
                              ) : null}
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-1.5">
                                  <span className="truncate text-sm font-medium text-foreground">
                                    {lead.contactName}
                                  </span>
                                  <span
                                    className={cn(
                                      'ml-auto flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full px-1 text-[10px] font-bold tabular-nums',
                                      scoreDotTone(lead.score),
                                    )}
                                  >
                                    {lead.score ?? '—'}
                                  </span>
                                </div>
                                {lead.serviceName ? (
                                  <p className="mt-0.5 truncate text-xs text-muted-foreground">
                                    {lead.serviceName}
                                  </p>
                                ) : null}
                                <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
                                  {checklist ? (
                                    <span
                                      className={cn(
                                        'inline-flex items-center gap-1',
                                        checklistDone && 'text-emerald-500',
                                      )}
                                    >
                                      <ListChecks className="h-3 w-3" />
                                      {t('checklistShort', {
                                        done: checklist.doneCount,
                                        total: checklist.total,
                                      })}
                                    </span>
                                  ) : null}
                                  <span
                                    className={cn(
                                      'inline-flex items-center gap-1 truncate',
                                      !lead.assigneeName && 'text-amber-500',
                                    )}
                                  >
                                    <UserRound className="h-3 w-3" />
                                    {lead.assigneeName ?? '—'}
                                  </span>
                                  {stage === 'purchased' && lead.saleValue ? (
                                    <span className="font-medium text-emerald-500">
                                      {formatCurrencyShort(lead.saleValue, lead.saleCurrency ?? 'USD')}
                                    </span>
                                  ) : null}
                                  {stage === 'lost' && checklist?.outcome?.lossCategory ? (
                                    <span className="inline-flex items-center gap-1 text-red-400">
                                      <XCircle className="h-3 w-3" />
                                      {tFunnel(`lossCategory.${checklist.outcome.lossCategory}` as never)}
                                    </span>
                                  ) : null}
                                  {lead.funnelStageUpdatedAt ?? lead.qualifiedAt ? (
                                    <span className="truncate">
                                      {t('inStageSince', {
                                        ago: formatDistanceToNow(
                                          new Date(lead.funnelStageUpdatedAt ?? lead.qualifiedAt ?? 0),
                                          { addSuffix: true },
                                        ),
                                      })}
                                    </span>
                                  ) : null}
                                </div>
                              </div>
                              {canEdit ? (
                                <DropdownMenu>
                                  <DropdownMenuTrigger
                                    onClick={(e) => e.stopPropagation()}
                                    className="rounded p-1 text-muted-foreground opacity-60 hover:bg-muted group-hover:opacity-100"
                                    aria-label={t('moveTo')}
                                  >
                                    <ChevronDown className="h-3.5 w-3.5" />
                                  </DropdownMenuTrigger>
                                  <DropdownMenuContent align="end" className="border-border bg-popover">
                                    {PIPELINE_STAGE_KEYS.filter((k) => k !== stage).map((k) => (
                                      <DropdownMenuItem
                                        key={k}
                                        className="text-sm"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          requestMove(lead, k);
                                        }}
                                      >
                                        {tFunnel(`stage.${k}` as never)}
                                      </DropdownMenuItem>
                                    ))}
                                  </DropdownMenuContent>
                                </DropdownMenu>
                              ) : null}
                            </div>
                          </article>
                        );
                      })
                    )}
                  </div>
                </section>
              );
            })}
          </div>
          <ScrollBar orientation="horizontal" />
        </ScrollArea>
      )}

      {/* Card dialog: the full lead detail + checklist. */}
      <Dialog open={openLead !== null} onOpenChange={(next) => !next && setOpenLeadId(null)}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
          {openLead ? (
            <>
              <DialogHeader>
                <DialogTitle className="flex flex-wrap items-center gap-2">
                  {openLead.contactName}
                  {openLead.serviceName ? (
                    <Badge variant="outline" className="text-[10px] text-muted-foreground">
                      {openLead.serviceName}
                    </Badge>
                  ) : null}
                </DialogTitle>
              </DialogHeader>
              {renderLeadDetail(openLead)}
            </>
          ) : null}
        </DialogContent>
      </Dialog>

      {/* Won: the sale value (same contract as the inbox purchase dialog). */}
      <Dialog
        open={valueFor !== null}
        onOpenChange={(next) => {
          if (!next) setValueFor(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{tFunnel('saleAmountTitle')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <label className="text-xs text-muted-foreground">{tFunnel('saleAmountLabel')}</label>
            <Input
              type="number"
              inputMode="decimal"
              min="0"
              value={valueText}
              onChange={(e) => setValueText(e.target.value)}
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button
              disabled={!(Number(valueText) > 0)}
              onClick={() => {
                const v = Number(valueText);
                const lead = valueFor;
                if (!lead || !Number.isFinite(v) || v <= 0) return;
                setValueFor(null);
                void onStageChange(lead, 'purchased', { saleValue: v });
              }}
            >
              {tFunnel('saleAmountConfirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Lost: category + exact why, mandatory. */}
      <LossReasonDialog
        open={lossFor !== null}
        onOpenChange={(next) => {
          if (!next) setLossFor(null);
        }}
        onConfirm={(category, detail) => {
          const lead = lossFor;
          setLossFor(null);
          if (lead) {
            void onStageChange(lead, 'lost', { lossCategory: category, lossDetail: detail });
          }
        }}
      />
    </div>
  );
}
