'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { formatDistanceToNow } from 'date-fns';
import { BookOpenText, Check, CircleDashed, ListChecks, RotateCcw, Trophy, XCircle } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

// ============================================================
// LeadChecklist — the post-qualification sales checklist panel.
// Purely presentational over the `leadsBoard` checklist payload;
// mutations arrive as callbacks so the board stays mock-renderable.
// Completing an item REQUIRES a comment (the owner's rule: "Okay, I
// have done this" + what happened) — the inline form enforces it.
// ============================================================

export interface LeadChecklistData {
  checklistId: string;
  source: 'kb' | 'default';
  doneCount: number;
  total: number;
  outcome: {
    result: 'won' | 'lost';
    lossCategory: string | null;
    lossDetail: string | null;
    at: number;
  } | null;
  items: {
    key: string;
    title: string;
    description: string | null;
    done: boolean;
    doneAt: number | null;
    doneByName: string | null;
    note: string | null;
  }[];
}

interface LeadChecklistProps {
  checklist: LeadChecklistData | null;
  canEdit: boolean;
  onCompleteItem: (itemKey: string, note: string) => void | Promise<void>;
  onReopenItem: (itemKey: string) => void | Promise<void>;
  className?: string;
}

const MIN_NOTE = 3;

export function LeadChecklist({
  checklist,
  canEdit,
  onCompleteItem,
  onReopenItem,
  className,
}: LeadChecklistProps) {
  const t = useTranslations('Leads.checklist');
  const tLoss = useTranslations('Inbox.funnel.lossCategory');
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);

  if (!checklist) {
    return (
      <p className={cn('text-sm text-muted-foreground', className)}>{t('none')}</p>
    );
  }

  const complete = checklist.doneCount === checklist.total && checklist.total > 0;
  const pct = checklist.total > 0 ? Math.round((checklist.doneCount / checklist.total) * 100) : 0;

  const submit = async (itemKey: string) => {
    if (note.trim().length < MIN_NOTE || saving) return;
    setSaving(true);
    try {
      await onCompleteItem(itemKey, note.trim());
      setActiveKey(null);
      setNote('');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={className}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          <ListChecks className="h-3.5 w-3.5 text-primary" />
          {t('title')}
        </p>
        <Badge variant="outline" className="gap-1 text-[10px] text-muted-foreground">
          <BookOpenText className="h-3 w-3" />
          {checklist.source === 'kb' ? t('sourceKb') : t('sourceDefault')}
        </Badge>
        <span
          className={cn(
            'text-xs font-medium tabular-nums',
            complete ? 'text-emerald-500' : 'text-muted-foreground',
          )}
        >
          {complete ? t('complete') : t('progress', { done: checklist.doneCount, total: checklist.total })}
        </span>
        <div className="h-1.5 w-24 overflow-hidden rounded-full bg-muted">
          <div
            className={cn('h-full rounded-full', complete ? 'bg-emerald-500' : 'bg-primary/70')}
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>

      {checklist.outcome ? (
        <div
          className={cn(
            'mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border px-3 py-2 text-sm',
            checklist.outcome.result === 'won'
              ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-500'
              : 'border-red-500/40 bg-red-500/10 text-red-400',
          )}
        >
          {checklist.outcome.result === 'won' ? (
            <Trophy className="h-4 w-4" />
          ) : (
            <XCircle className="h-4 w-4" />
          )}
          <span className="font-medium">
            {checklist.outcome.result === 'won' ? t('outcomeWon') : t('outcomeLost')}
          </span>
          {checklist.outcome.result === 'lost' && checklist.outcome.lossCategory ? (
            <span className="text-xs opacity-90">
              {tLoss(checklist.outcome.lossCategory as never)}
              {checklist.outcome.lossDetail ? ` — ${checklist.outcome.lossDetail}` : ''}
            </span>
          ) : null}
        </div>
      ) : null}

      <ul className="mt-2 space-y-1.5">
        {checklist.items.map((item) => {
          const open = activeKey === item.key;
          return (
            <li
              key={item.key}
              className={cn(
                'rounded-lg border border-border px-3 py-2',
                item.done && 'bg-muted/40',
              )}
            >
              <div className="flex items-start gap-2.5">
                {item.done ? (
                  <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full bg-emerald-500 text-white">
                    <Check className="h-3 w-3" />
                  </span>
                ) : (
                  <CircleDashed className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                )}
                <div className="min-w-0 flex-1">
                  <p
                    className={cn(
                      'text-sm font-medium',
                      item.done ? 'text-muted-foreground' : 'text-foreground',
                    )}
                  >
                    {item.title}
                  </p>
                  {!item.done && item.description ? (
                    <p className="mt-0.5 text-xs text-muted-foreground">{item.description}</p>
                  ) : null}
                  {item.done && item.note ? (
                    <p className="mt-0.5 break-words text-xs text-muted-foreground">
                      💬 {item.note}
                    </p>
                  ) : null}
                  {item.done && (item.doneByName || item.doneAt) ? (
                    <p className="mt-0.5 text-[11px] text-muted-foreground/70">
                      {t('doneBy', {
                        name: item.doneByName ?? '—',
                        ago: item.doneAt
                          ? formatDistanceToNow(new Date(item.doneAt), { addSuffix: true })
                          : '',
                      })}
                    </p>
                  ) : null}
                </div>
                {canEdit ? (
                  item.done ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-xs text-muted-foreground"
                      onClick={() => void onReopenItem(item.key)}
                      title={t('reopen')}
                    >
                      <RotateCcw className="h-3.5 w-3.5" />
                    </Button>
                  ) : (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 px-2.5 text-xs"
                      onClick={() => {
                        setActiveKey(open ? null : item.key);
                        setNote('');
                      }}
                    >
                      {t('markDone')}
                    </Button>
                  )
                ) : null}
              </div>

              {open && canEdit && !item.done ? (
                <div className="mt-2 space-y-2 border-t border-border pt-2">
                  <Textarea
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder={t('notePlaceholder')}
                    rows={2}
                    className="text-sm"
                    autoFocus
                  />
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      className="h-7 px-3 text-xs"
                      disabled={note.trim().length < MIN_NOTE || saving}
                      onClick={() => void submit(item.key)}
                    >
                      {t('save')}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-xs"
                      onClick={() => {
                        setActiveKey(null);
                        setNote('');
                      }}
                    >
                      {t('cancel')}
                    </Button>
                    <span className="text-[11px] text-muted-foreground">{t('noteHint')}</span>
                  </div>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
