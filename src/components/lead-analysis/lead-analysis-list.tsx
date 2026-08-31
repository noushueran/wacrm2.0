'use client';

import { useTranslations } from 'next-intl';
import { RotateCw, Archive as ArchiveIcon, ArchiveRestore } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { silenceLabel } from './lead-analysis-filter';
import type { LeadAnalysisRow, LeadBandKey } from './lead-analysis-filter';

// ============================================================
// The Lead Analysis queue — PRESENTATIONAL ONLY, so it can be rendered
// with mock data and asserted on as static markup (this repo has no
// jsdom). Rows carry signal only; the actions are icon buttons revealed
// on hover/focus so a narrow column still supports triage without
// opening a lead — dismissing an obvious dud shouldn't cost an open,
// which would also mark it read.
//
// Each row is a `<li role="button" tabIndex={0}>`, not a `<button>`
// wrapping the action buttons — nesting a button inside a button is
// invalid HTML (see the comment on the row in
// src/components/inbox/conversation-list.tsx, which keeps the action
// control as an absolutely-positioned SIBLING for the same reason).
// `role`/`tabIndex`/`onKeyDown` make the existing DOM shape keyboard-
// activatable without that restructure.
// ============================================================

const BAND_CLASS: Record<LeadBandKey, string> = {
  hot: 'bg-red-100 text-red-900 dark:bg-red-950 dark:text-red-200',
  warm: 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200',
  cold: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
};

export function LeadAnalysisList({
  leads,
  selectedConversationId,
  onSelect,
  canReanalyze,
  onReanalyze,
  canArchive,
  onArchive,
  onRestore,
}: {
  leads: LeadAnalysisRow[];
  selectedConversationId: string | null;
  onSelect: (lead: LeadAnalysisRow) => void;
  canReanalyze: boolean;
  onReanalyze: (lead: LeadAnalysisRow) => void;
  canArchive: boolean;
  onArchive: (lead: LeadAnalysisRow) => void;
  onRestore: (lead: LeadAnalysisRow) => void;
}) {
  const t = useTranslations('LeadAnalysis');

  if (leads.length === 0) {
    return <p className="text-muted-foreground p-4 text-sm">{t('empty')}</p>;
  }

  return (
    <ul className="divide-y">
      {leads.map((lead) => {
        const selected = lead.conversationId === selectedConversationId;
        return (
          <li
            key={lead.analysisId}
            data-testid="lead-row"
            role="button"
            tabIndex={0}
            aria-current={selected ? 'true' : undefined}
            className={cn(
              'group hover:bg-muted/50 focus-visible:ring-ring flex cursor-pointer items-start gap-2 px-3 py-2.5 outline-none focus-visible:ring-2 focus-visible:ring-inset',
              selected && 'bg-muted'
            )}
            onClick={() => onSelect(lead)}
            onKeyDown={(e) => {
              // Guard against keydown bubbling up from the nested
              // Re-analyze/Archive <button>s: their own click handlers
              // already `stopPropagation()`, but that stops the CLICK a
              // browser synthesizes for Enter/Space on a focused button —
              // it does not stop the KEYDOWN itself, which fires and
              // bubbles here first. Without this check, keyboard-
              // activating an action button would also select (and thus
              // open/read) the row. Only react when the keydown
              // originated on the row itself.
              if (e.target !== e.currentTarget) return;
              if (e.key === 'Enter') {
                onSelect(lead);
              } else if (e.key === ' ') {
                e.preventDefault();
                onSelect(lead);
              }
            }}
          >
            <span
              data-testid="lead-score"
              className={cn(
                'mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold',
                lead.band ? BAND_CLASS[lead.band] : 'bg-muted text-muted-foreground'
              )}
              title={lead.reason ?? undefined}
            >
              {lead.score ?? '–'}
            </span>

            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{lead.contactName}</p>
              <p
                data-testid="lead-reason"
                className="text-muted-foreground line-clamp-2 text-xs"
              >
                {lead.reason ?? t('row.unscored')}
              </p>
              <div className="mt-1 flex flex-wrap items-center gap-1.5">
                <Badge variant="secondary" className="text-[10px]">
                  {t(`lane.${lead.lane}` as never)}
                </Badge>
                {lead.returnedAt !== null && (
                  <Badge data-testid="row-returned-badge" variant="outline" className="text-[10px]">
                    {t('row.returned')}
                  </Badge>
                )}
                <span className="text-muted-foreground text-[10px]">
                  {(() => {
                    const silence = silenceLabel(lead.daysSinceLastMessage);
                    return silence.kind === 'days'
                      ? t('row.daysSilent', { days: silence.days })
                      : t('row.today');
                  })()}
                </span>
              </div>
            </div>

            {/* Actions stop propagation so acting on a row never also
                opens it — archiving an obvious dud must not mark it
                read on the way past. */}
            <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
              {canReanalyze && (
                <button
                  type="button"
                  data-testid="row-reanalyze-action"
                  title={t('row.reanalyze')}
                  aria-label={t('row.reanalyze')}
                  className="hover:bg-background rounded-md p-1.5"
                  onClick={(e) => {
                    e.stopPropagation();
                    onReanalyze(lead);
                  }}
                >
                  <RotateCw className="h-3.5 w-3.5" />
                </button>
              )}
              {canArchive && (
                <button
                  type="button"
                  data-testid="row-archive-action"
                  title={lead.archived ? t('row.restore') : t('row.archive')}
                  aria-label={lead.archived ? t('row.restore') : t('row.archive')}
                  className="hover:bg-background rounded-md p-1.5"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (lead.archived) onRestore(lead);
                    else onArchive(lead);
                  }}
                >
                  {lead.archived ? (
                    <ArchiveRestore className="h-3.5 w-3.5" />
                  ) : (
                    <ArchiveIcon className="h-3.5 w-3.5" />
                  )}
                </button>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
