'use client';

import type { JSX } from 'react';
import { useTranslations } from 'next-intl';
import { Plus } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { softBadge, type SoftTone } from '@/lib/ui/soft-badge';
import { cn } from '@/lib/utils';
import type { ServiceVerdict } from '@/lib/knowledge/verdict';

// ============================================================
// ServiceMatrix — the Knowledge Studio landing view: every service
// against six content slots, each carrying a readiness verdict. The
// at-a-glance answer to "which services can my AI agent actually use?"
//
// Pure props-in component — no Convex hooks — so Task 8 can drive it
// with mock data from a temporary preview route for browser
// verification. The studio shell (`knowledge-studio.tsx`) owns the
// `studioOverview` query and passes `services` down untouched.
//
// Responsive: a `Table` at `sm` and up, one `Card` per service below
// `sm` (the stacked-below-`sm` treatment `leads-board-view.tsx`
// establishes elsewhere in this repo). Both layouts render into the
// DOM at once and Tailwind's `hidden`/`sm:hidden` classes pick which
// is visible — the hidden one drops out of the accessibility tree, so
// there's no double-announcement for assistive tech.
// ============================================================

/** The three `kbEntries` types with a dedicated matrix column. */
export const MATRIX_ENTRY_COLUMNS = ['overview', 'faq', 'requirements'] as const;
/** `kbEntries` types with no column of their own — summed into "+N more". */
export const OTHER_ENTRY_TYPES = ['itinerary', 'policy', 'process', 'note'] as const;

export type ServiceRow = {
  key: string;
  name: string;
  aliases: string[];
  status: 'active' | 'paused';
  sortOrder: number;
  entries: Record<string, { published: number; draft: number }>;
  ops: Record<
    'qualification' | 'sales' | 'purchase',
    { state: 'published' | 'draft' | 'absent'; marksTotal: number | null }
  >;
  verdict: ServiceVerdict;
};

/** Entries whose type has no column of their own, so nothing is invisible. */
export function otherEntryCount(
  entries: Record<string, { published: number; draft: number }>,
): number {
  return OTHER_ENTRY_TYPES.reduce(
    (n, type) => n + (entries[type]?.published ?? 0) + (entries[type]?.draft ?? 0),
    0,
  );
}

type Mark = 'filled' | 'hollow' | 'empty';

// filled = something published (good); hollow = draft only (in progress);
// empty = a muted dash — nothing here yet. Shape AND colour both vary so
// the state doesn't ride on colour perception alone; the accessible
// name (see `StatusDot`) is what actually carries the state, though.
const MARK_DOT_CLASS: Record<Exclude<Mark, 'empty'>, string> = {
  filled: 'bg-emerald-500',
  hollow: 'border-2 border-amber-500 bg-transparent',
};

/** A shape+label status indicator. `label` is the sole source of truth
 * for assistive tech — a filled-vs-hollow dot means nothing to a screen
 * reader, so every instance carries a `title`/`aria-label` with counts. */
function StatusDot({ mark, label }: { mark: Mark; label: string }) {
  if (mark === 'empty') {
    return (
      <span
        role="img"
        aria-label={label}
        title={label}
        className="text-sm leading-none text-muted-foreground/50"
      >
        —
      </span>
    );
  }
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={cn('inline-block size-2.5 shrink-0 rounded-full', MARK_DOT_CLASS[mark])}
    />
  );
}

const VERDICT_TONE: Record<ServiceVerdict, SoftTone> = {
  ready: 'success',
  blocked: 'warning',
  draft: 'info',
  empty: 'neutral',
};

function VerdictBadge({
  verdict,
  t,
}: {
  verdict: ServiceVerdict;
  t: ReturnType<typeof useTranslations>;
}) {
  return (
    <Badge variant="outline" className={cn('shrink-0 text-[10px]', softBadge(VERDICT_TONE[verdict]))}>
      {t(`verdict.${verdict}`)}
    </Badge>
  );
}

function EntryCell({
  counts,
  columnLabel,
  t,
}: {
  counts: { published: number; draft: number };
  columnLabel: string;
  t: ReturnType<typeof useTranslations>;
}) {
  const mark: Mark = counts.published > 0 ? 'filled' : counts.draft > 0 ? 'hollow' : 'empty';
  const label = `${columnLabel}: ${t('matrix.entryStatus', {
    published: counts.published,
    draft: counts.draft,
  })}`;
  return <StatusDot mark={mark} label={label} />;
}

function OpsCell({
  state,
  columnLabel,
  t,
}: {
  state: 'published' | 'draft' | 'absent';
  columnLabel: string;
  t: ReturnType<typeof useTranslations>;
}) {
  const mark: Mark = state === 'published' ? 'filled' : state === 'draft' ? 'hollow' : 'empty';
  const label = `${columnLabel}: ${t(`matrix.opsState.${state}`)}`;
  return <StatusDot mark={mark} label={label} />;
}

/** Qualification is the one ops column that also carries a marks total —
 * flagged as a warning when the block is published but the total isn't
 * 100, since that's a service the operator believes is live but which
 * can't actually qualify a lead (`serviceVerdict`'s exact rule). */
function QualificationCell({
  ops,
  columnLabel,
  t,
}: {
  ops: { state: 'published' | 'draft' | 'absent'; marksTotal: number | null };
  columnLabel: string;
  t: ReturnType<typeof useTranslations>;
}) {
  const warn = ops.state === 'published' && ops.marksTotal !== null && ops.marksTotal !== 100;
  const warnLabel =
    ops.marksTotal !== null ? t('matrix.marksOff', { total: ops.marksTotal }) : undefined;
  return (
    <div className="flex items-center gap-1.5">
      <OpsCell state={ops.state} columnLabel={columnLabel} t={t} />
      {ops.marksTotal !== null ? (
        <span
          className={cn(
            'text-xs tabular-nums',
            warn ? 'font-semibold text-amber-500' : 'text-muted-foreground',
          )}
          title={warn ? warnLabel : undefined}
          aria-label={warn ? warnLabel : undefined}
        >
          {ops.marksTotal}
        </span>
      ) : null}
    </div>
  );
}

function OtherCount({
  entries,
  t,
}: {
  entries: ServiceRow['entries'];
  t: ReturnType<typeof useTranslations>;
}) {
  const count = otherEntryCount(entries);
  if (count === 0) return null;
  return <span className="text-xs text-muted-foreground">{t('matrix.otherCount', { count })}</span>;
}

/** The clickable service identity: name + verdict badge. Rendered as a
 * `button` (not the whole `tr`, which can't validly host one) so the
 * row is keyboard-reachable — clicking anywhere else in a table row
 * isn't operable without a mouse. */
function ServiceIdentity({
  service,
  onSelectService,
  t,
  className,
}: {
  service: ServiceRow;
  onSelectService: (key: string) => void;
  t: ReturnType<typeof useTranslations>;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelectService(service.key)}
      className={cn(
        'flex min-w-0 items-center gap-2 text-left font-medium text-foreground hover:underline',
        className,
      )}
    >
      <span className="min-w-0 truncate">{service.name}</span>
      <VerdictBadge verdict={service.verdict} t={t} />
    </button>
  );
}

export function ServiceMatrix({
  services,
  onSelectService,
  onCreateService,
}: {
  services: ServiceRow[];
  onSelectService: (key: string) => void;
  onCreateService: () => void;
}): JSX.Element {
  const t = useTranslations('Knowledge');

  if (services.length === 0) {
    return (
      <Card className="mt-6">
        <CardContent className="flex flex-col items-center justify-center gap-3 py-10 text-center">
          <p className="text-sm font-medium text-foreground">{t('empty.title')}</p>
          <p className="max-w-sm text-sm text-muted-foreground">{t('empty.body')}</p>
          <Button type="button" size="sm" onClick={onCreateService}>
            <Plus className="size-4" />
            {t('empty.action')}
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="mt-6">
      <div className="mb-3 flex justify-end">
        <Button type="button" size="sm" variant="outline" onClick={onCreateService}>
          <Plus className="size-4" />
          {t('matrix.newService')}
        </Button>
      </div>

      {/* `sm` and up: a Table, one row per service. */}
      <Card className="hidden sm:block">
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('columns.service')}</TableHead>
                <TableHead>{t('columns.overview')}</TableHead>
                <TableHead>{t('columns.faq')}</TableHead>
                <TableHead>{t('columns.requirements')}</TableHead>
                <TableHead>{t('columns.qualification')}</TableHead>
                <TableHead>{t('columns.sales')}</TableHead>
                <TableHead>{t('columns.purchase')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {services.map((service) => (
                <TableRow key={service.key}>
                  <TableCell>
                    <ServiceIdentity service={service} onSelectService={onSelectService} t={t} />
                  </TableCell>
                  <TableCell>
                    <EntryCell
                      counts={service.entries.overview}
                      columnLabel={t('columns.overview')}
                      t={t}
                    />
                  </TableCell>
                  <TableCell>
                    <EntryCell counts={service.entries.faq} columnLabel={t('columns.faq')} t={t} />
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <EntryCell
                        counts={service.entries.requirements}
                        columnLabel={t('columns.requirements')}
                        t={t}
                      />
                      <OtherCount entries={service.entries} t={t} />
                    </div>
                  </TableCell>
                  <TableCell>
                    <QualificationCell
                      ops={service.ops.qualification}
                      columnLabel={t('columns.qualification')}
                      t={t}
                    />
                  </TableCell>
                  <TableCell>
                    <OpsCell
                      state={service.ops.sales.state}
                      columnLabel={t('columns.sales')}
                      t={t}
                    />
                  </TableCell>
                  <TableCell>
                    <OpsCell
                      state={service.ops.purchase.state}
                      columnLabel={t('columns.purchase')}
                      t={t}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Below `sm`: one Card per service. */}
      <div className="space-y-3 sm:hidden">
        {services.map((service) => (
          <Card key={service.key}>
            <CardContent>
              <ServiceIdentity
                service={service}
                onSelectService={onSelectService}
                t={t}
                className="w-full justify-between"
              />
              <dl className="mt-3 grid grid-cols-3 gap-x-3 gap-y-3 text-xs">
                <div>
                  <dt className="text-muted-foreground">{t('columns.overview')}</dt>
                  <dd className="mt-1">
                    <EntryCell
                      counts={service.entries.overview}
                      columnLabel={t('columns.overview')}
                      t={t}
                    />
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">{t('columns.faq')}</dt>
                  <dd className="mt-1">
                    <EntryCell counts={service.entries.faq} columnLabel={t('columns.faq')} t={t} />
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">{t('columns.requirements')}</dt>
                  <dd className="mt-1 flex items-center gap-1.5">
                    <EntryCell
                      counts={service.entries.requirements}
                      columnLabel={t('columns.requirements')}
                      t={t}
                    />
                    <OtherCount entries={service.entries} t={t} />
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">{t('columns.qualification')}</dt>
                  <dd className="mt-1">
                    <QualificationCell
                      ops={service.ops.qualification}
                      columnLabel={t('columns.qualification')}
                      t={t}
                    />
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">{t('columns.sales')}</dt>
                  <dd className="mt-1">
                    <OpsCell
                      state={service.ops.sales.state}
                      columnLabel={t('columns.sales')}
                      t={t}
                    />
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">{t('columns.purchase')}</dt>
                  <dd className="mt-1">
                    <OpsCell
                      state={service.ops.purchase.state}
                      columnLabel={t('columns.purchase')}
                      t={t}
                    />
                  </dd>
                </div>
              </dl>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
