'use client';

import { useState, type JSX } from 'react';
import { useTranslations } from 'next-intl';
import { ConvexError } from 'convex/values';
import { ArrowDown, ArrowUp, Loader2, Plus, Trash2 } from 'lucide-react';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { marksTotal } from '@/lib/knowledge/verdict';
import { softBadge } from '@/lib/ui/soft-badge';

import { hasLintErrors, lintOpsBlock } from '../../../convex/lib/kb/lint';
import type { LintIssue, OpsBlockInput } from '../../../convex/lib/kb/types';
import { EntryStatusBadge } from './service-detail';

// ============================================================
// ChecklistEditor — inline editor for one kbOpsBlocks row: a
// qualification checklist (weighted criteria), a sales checklist
// (ordered steps), or a purchase-criteria block (conditions plus an
// optional report value/currency). One component serves all three
// because they differ only in row shape (`ChecklistRow` below); `kind`
// switches which optional fields render.
//
// Convex-free (props only), matching entry-editor.tsx/service-form.tsx:
// validates with the shared `lintOpsBlock` rule and hands clean values
// up through `onSave`/`onPublish`/`onUnpublish` — knowledge-studio.tsx
// owns the `useMutation` calls, which keeps this file mockable for
// Task 8's browser verification.
//
// Split lint gate (mirrors convex/kbOps.ts's own header comment): Save
// blocks only on SHAPE errors (`label_required`, `key_duplicate`) so a
// half-finished checklist can be parked as a draft; Publish blocks on
// EVERY error-level issue via `hasLintErrors`, most visibly a
// qualification's marks not summing to 100. Save additionally refuses
// zero rows outright (see `computeSaveBlocked`) — a client-only UX
// guard layered on top of the lint split, not part of it.
//
// Row `key` is assigned once, at add-time, via `nextRowKey` — never
// rewritten when its label is edited afterwards, since downstream data
// (and any future per-criterion analytics) joins on it. Mirrors
// convex/kbImport.ts's `dedupedItemKeys` exactly (same slug + numeric
// suffix rules), so hand-authored and imported blocks are shaped
// identically.
// ============================================================

export type ChecklistRow = {
  key: string;
  label: string;
  question?: string; // qualification only
  description?: string; // sales only
  marks?: number; // qualification only
};

const MAX_KEY_LENGTH = 40;

/**
 * Slugifies `label` into a row key, deduped against `existing` keys
 * with a numeric suffix. Mirrors convex/kbImport.ts's
 * `dedupedItemKeys` (built on that module's `slugify`) exactly:
 * lowercase, non-alphanumeric runs collapsed to a single hyphen,
 * leading/trailing hyphens trimmed, capped at 40 characters, falling
 * back to "item" when nothing slug-able remains. A brand-new row (see
 * `addRow` below) has no label yet, so it lands on this same fallback
 * — "item", "item-2", … — until the admin types a real one; the key
 * never changes after that, by design (see the module doc comment).
 */
export function nextRowKey(label: string, existing: string[]): string {
  const base =
    label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
      .slice(0, MAX_KEY_LENGTH).replace(/-+$/, '') || 'item';
  if (!existing.includes(base)) return base;
  let n = 2;
  while (existing.includes(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

// Shape problems block Save via SHAPE_ISSUE_CODES below; every other
// error-level issue (marks_sum, report_value_positive, currency_format)
// only blocks Publish. `items_required` is the one exception: it's a
// completeness issue, not a shape one, so it's deliberately left out of
// this set (which otherwise stays byte-for-byte mirrored to kbOps.ts's
// own SHAPE_ERROR_CODES) — `computeSaveBlocked` below blocks Save on
// zero rows separately instead. See that function's own comment.
const SHAPE_ISSUE_CODES = new Set(['label_required', 'key_duplicate']);

/** Whether the current rows/issues combination should block Save.
 *  Exported so it's directly unit-testable (checklist-editor.test.ts) —
 *  this repo has no React Testing Library to drive the component itself.
 *
 *  Blocks on zero rows, in addition to any SHAPE_ISSUE_CODES error.
 *  Zero rows only trips `items_required` (a completeness issue — see
 *  SHAPE_ISSUE_CODES above), so without this extra check Save stayed
 *  enabled on an empty, untouched block. That mattered because Save is
 *  the only mutation that can create a `kbOpsBlocks` row in the first
 *  place (`status === 'absent'` means none exists yet): once created,
 *  `kbServices.remove` treats the service as permanently "in use", and
 *  Phase 1 ships no `kbOps.remove` mutation to undo it (Convex
 *  dashboard only).
 *
 *  This also blocks re-saving an *existing* block down to zero rows —
 *  intentionally, not as a side effect. An empty checklist is never a
 *  meaningful thing to persist (Publish has always refused one, via the
 *  same `items_required` issue), and nothing is stranded by refusing
 *  it: the last real save stays intact server-side until rows are added
 *  back. */
export function computeSaveBlocked(rows: ChecklistRow[], issues: LintIssue[]): boolean {
  if (rows.length === 0) return true;
  return issues.some((i) => i.level === 'error' && SHAPE_ISSUE_CODES.has(i.code));
}

type Kind = 'qualification' | 'sales' | 'purchase';

/** Maps this editor's flat `rows` into the field `lintOpsBlock` expects
 *  for `kind` — the same criteria/steps/conditions split the backend
 *  stores and validates against. */
function toOpsBlockInput(
  kind: Kind,
  rows: ChecklistRow[],
  reportValue: number | undefined,
  currency: string | undefined,
): OpsBlockInput {
  if (kind === 'qualification') {
    return {
      kind,
      criteria: rows.map((r) => (
        { key: r.key, label: r.label, question: r.question, marks: r.marks }
      )),
    };
  }
  if (kind === 'sales') {
    return {
      kind,
      steps: rows.map((r) => ({ key: r.key, label: r.label, description: r.description })),
    };
  }
  return {
    kind,
    conditions: rows.map((r) => ({ key: r.key, label: r.label })),
    reportValue,
    currency,
  };
}

/** Trims free-text fields before they leave this component, mirroring
 *  entry-editor.tsx's `title.trim()`/`body.trim()` at its own save
 *  boundary. Kind-agnostic: `question`/`description` are already
 *  `undefined` for rows that don't use them, so trimming is a no-op
 *  there. Blank optional strings collapse to `undefined` rather than
 *  `""` so a cleared field doesn't linger as an empty string server-side. */
function cleanRows(rows: ChecklistRow[]): ChecklistRow[] {
  return rows.map((r) => ({
    key: r.key,
    label: r.label.trim(),
    question: r.question?.trim() || undefined,
    description: r.description?.trim() || undefined,
    marks: r.marks,
  }));
}

function parseOptionalNumber(raw: string): number | undefined {
  if (raw.trim() === '') return undefined;
  const n = Number(raw);
  return Number.isNaN(n) ? undefined : n;
}

/** De-dupes a list of lint issues by `code`, keeping the first
 *  occurrence of each. `lintOpsBlock` can emit the same code more than
 *  once (e.g. `label_required` once per blank row), and the server's
 *  rejection payload can carry the same shape — either way, React needs
 *  a unique `key` per rendered `<li>`, so every issue list this
 *  component renders (the live lint issues below and whatever a
 *  rejected save/publish call returns) goes through this first. */
function dedupeIssuesByCode(issues: LintIssue[]): LintIssue[] {
  return Array.from(new Map(issues.map((i) => [i.code, i])).values());
}

/** What a rejected onSave/onPublish/onUnpublish told us. Mirrors
 *  entry-editor.tsx's own `SubmitError`. */
type SubmitError = { kind: 'issues'; issues: LintIssue[] } | { kind: 'other' };

function readSubmitError(err: unknown): SubmitError {
  if (err instanceof ConvexError && err.data !== null && typeof err.data === 'object') {
    const data = err.data as Record<string, unknown>;
    if (Array.isArray(data.issues)) return { kind: 'issues', issues: data.issues as LintIssue[] };
  }
  return { kind: 'other' };
}

type PendingAction = 'save' | 'publish' | 'unpublish';

export function ChecklistEditor({
  kind,
  rows: initialRows,
  reportValue: initialReportValue,
  currency: initialCurrency,
  status,
  onSave,
  onPublish,
  onUnpublish,
}: {
  kind: Kind;
  rows: ChecklistRow[];
  reportValue?: number;
  currency?: string;
  status: 'draft' | 'published' | 'absent';
  onSave: (values: {
    rows: ChecklistRow[]; reportValue?: number; currency?: string;
  }) => Promise<void>;
  onPublish: () => Promise<void>;
  onUnpublish: () => Promise<void>;
}): JSX.Element {
  const t = useTranslations('Knowledge');

  // Seeded once from props and never resynced afterwards. Unlike
  // EntryEditor's dialog, this editor has no open/close transition to
  // hang a re-seed effect off — knowledge-studio.tsx only mounts it
  // once its `useOpsBlocks` hook resolves this block's query past
  // `undefined` (loading), and it stays mounted for as long as the
  // service detail view is open. Every write this component makes
  // (save/publish/unpublish) round-trips back through that same query
  // and always reproduces exactly the local state that produced it, so
  // there's nothing external to resync to.
  const [rows, setRows] = useState<ChecklistRow[]>(initialRows);
  const [reportValue, setReportValue] = useState<number | undefined>(initialReportValue);
  const [currency, setCurrency] = useState<string | undefined>(initialCurrency);
  // Tracks local edits not yet persisted — used only by handlePublish
  // below (to save-before-publish so Publish always acts on what's on
  // screen); never rendered directly.
  const [dirty, setDirty] = useState(false);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [submitError, setSubmitError] = useState<SubmitError | null>(null);
  const submitting = pending !== null;

  const issues = lintOpsBlock(toOpsBlockInput(kind, rows, reportValue, currency));
  const saveBlocked = computeSaveBlocked(rows, issues);
  const publishBlocked = hasLintErrors(issues);
  // marks_sum is surfaced instead by the dedicated live total below
  // (which shows the exact running total, not just "off by some
  // amount") — repeating it here would just say the same thing twice.
  // label_required can repeat once per blank row (lint.ts doesn't stop
  // at the first one); key_duplicate stops the scan at its first hit.
  // De-duping by code is enough to avoid showing the same message
  // multiple times.
  const errorIssues = issues.filter((i) => i.level === 'error' && i.code !== 'marks_sum');
  const uniqueErrorIssues = dedupeIssuesByCode(errorIssues);

  const total = kind === 'qualification' ? marksTotal(rows) : null;

  function mutateRows(next: ChecklistRow[]) {
    setRows(next);
    setDirty(true);
  }

  function addRow() {
    mutateRows([...rows, { key: nextRowKey('', rows.map((r) => r.key)), label: '' }]);
  }

  function removeRow(index: number) {
    mutateRows(rows.filter((_, i) => i !== index));
  }

  function moveRow(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= rows.length) return;
    const next = [...rows];
    [next[index], next[target]] = [next[target], next[index]];
    mutateRows(next);
  }

  function updateRow(index: number, patch: Partial<ChecklistRow>) {
    mutateRows(rows.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  }

  /** Persists the current local state via `onSave`, then reflects the
   *  trimmed values back into local state and clears `dirty`. */
  async function persist(): Promise<void> {
    const cleanedRows = cleanRows(rows);
    const cleanedCurrency = currency?.trim() || undefined;
    await onSave({ rows: cleanedRows, reportValue, currency: cleanedCurrency });
    setRows(cleanedRows);
    setCurrency(cleanedCurrency);
    setDirty(false);
  }

  async function runAction(action: PendingAction, fn: () => Promise<void>): Promise<void> {
    setSubmitError(null);
    setPending(action);
    try {
      await fn();
    } catch (err) {
      setSubmitError(readSubmitError(err));
    } finally {
      setPending(null);
    }
  }

  function handleSave() {
    if (saveBlocked || submitting) return;
    void runAction('save', persist);
  }

  function handlePublish() {
    if (publishBlocked || submitting) return;
    // onPublish (mirroring kbOps.publish) takes no payload — it
    // (re)publishes whatever is already saved server-side. Saving
    // first when there are unsaved local edits keeps "Publish" always
    // acting on what's on screen, instead of silently republishing
    // stale content the admin has since changed.
    void runAction('publish', async () => {
      if (dirty) await persist();
      await onPublish();
    });
  }

  function handleUnpublish() {
    if (submitting) return;
    void runAction('unpublish', onUnpublish);
  }

  return (
    <div className="space-y-3">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <h5 className="text-sm font-medium text-foreground">{t(`checklist.${kind}`)}</h5>
          {status === 'absent' ? (
            // EntryStatusBadge's status type (EntrySummary['status']) has no
            // "absent" member — entries always exist once listed, so that
            // component never needs it. Hand-rolled here to match its exact
            // markup (Badge variant="outline" + softBadge) rather than
            // widening a shared component's contract for a state it will
            // never see.
            <Badge variant="outline" className={cn('text-[10px]', softBadge('neutral'))}>
              {t('checklist.notCreatedBadge')}
            </Badge>
          ) : (
            <EntryStatusBadge status={status} t={t} />
          )}
        </div>
        <p className="text-xs text-muted-foreground">{t(`checklist.${kind}Hint`)}</p>
      </div>

      {status === 'absent' ? (
        <p className="text-xs text-muted-foreground">{t('checklist.notCreated')}</p>
      ) : null}

      {status === 'published' ? (
        <Alert>
          <AlertDescription>{t('checklist.editWarning')}</AlertDescription>
        </Alert>
      ) : null}

      {submitError ? (
        <Alert variant="destructive">
          <AlertDescription>
            {submitError.kind === 'issues' ? (
              <ul className="list-disc space-y-0.5 pl-4">
                {dedupeIssuesByCode(submitError.issues).map((issue) => (
                  <li key={issue.code}>{issue.message}</li>
                ))}
              </ul>
            ) : (
              t('checklist.saveFailed')
            )}
          </AlertDescription>
        </Alert>
      ) : null}

      <ul className="space-y-2">
        {rows.map((row, index) => (
          <li
            key={row.key}
            className="flex items-start gap-2 rounded-md border border-border p-2"
          >
            <div className="flex-1 space-y-1.5">
              <Label htmlFor={`cl-${kind}-${row.key}-label`} className="sr-only">
                {t('checklist.label')}
              </Label>
              <Input
                id={`cl-${kind}-${row.key}-label`}
                value={row.label}
                placeholder={t('checklist.label')}
                aria-invalid={row.label.trim() === ''}
                disabled={submitting}
                onChange={(e) => updateRow(index, { label: e.target.value })}
              />
              {kind === 'qualification' ? (
                <>
                  <Label htmlFor={`cl-${kind}-${row.key}-question`} className="sr-only">
                    {t('checklist.question')}
                  </Label>
                  <Input
                    id={`cl-${kind}-${row.key}-question`}
                    value={row.question ?? ''}
                    placeholder={t('checklist.question')}
                    disabled={submitting}
                    onChange={(e) => updateRow(index, { question: e.target.value })}
                  />
                </>
              ) : null}
              {kind === 'sales' ? (
                <>
                  <Label htmlFor={`cl-${kind}-${row.key}-description`} className="sr-only">
                    {t('checklist.description')}
                  </Label>
                  <Input
                    id={`cl-${kind}-${row.key}-description`}
                    value={row.description ?? ''}
                    placeholder={t('checklist.description')}
                    disabled={submitting}
                    onChange={(e) => updateRow(index, { description: e.target.value })}
                  />
                </>
              ) : null}
              {kind === 'qualification' ? (
                <>
                  <Label htmlFor={`cl-${kind}-${row.key}-marks`} className="sr-only">
                    {t('checklist.marks')}
                  </Label>
                  <Input
                    id={`cl-${kind}-${row.key}-marks`}
                    type="number"
                    value={row.marks ?? ''}
                    placeholder={t('checklist.marks')}
                    disabled={submitting}
                    onChange={(e) =>
                      updateRow(index, { marks: parseOptionalNumber(e.target.value) })
                    }
                  />
                </>
              ) : null}
            </div>
            <div className="flex shrink-0 flex-col gap-1">
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={t('checklist.moveUp')}
                disabled={submitting || index === 0}
                onClick={() => moveRow(index, -1)}
              >
                <ArrowUp className="size-3.5" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={t('checklist.moveDown')}
                disabled={submitting || index === rows.length - 1}
                onClick={() => moveRow(index, 1)}
              >
                <ArrowDown className="size-3.5" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={t('checklist.removeRow')}
                className="text-destructive hover:text-destructive"
                disabled={submitting}
                onClick={() => removeRow(index)}
              >
                <Trash2 className="size-3.5" />
              </Button>
            </div>
          </li>
        ))}
      </ul>

      <Button type="button" variant="outline" size="sm" disabled={submitting} onClick={addRow}>
        <Plus className="size-3.5" />
        {t('checklist.addRow')}
      </Button>

      {kind === 'qualification' ? (
        <p
          className={cn(
            'text-xs',
            total !== null && total !== 100 ? 'text-destructive' : 'text-muted-foreground',
          )}
        >
          {total === null ? t('checklist.marksIncomplete') : t('checklist.marksTotal', { total })}
        </p>
      ) : null}

      {kind === 'purchase' ? (
        <div className="flex gap-2">
          <div className="flex-1 space-y-1.5">
            <Label htmlFor={`cl-${kind}-report-value`}>{t('checklist.reportValue')}</Label>
            <Input
              id={`cl-${kind}-report-value`}
              type="number"
              value={reportValue ?? ''}
              disabled={submitting}
              onChange={(e) => {
                setReportValue(parseOptionalNumber(e.target.value));
                setDirty(true);
              }}
            />
          </div>
          <div className="w-24 space-y-1.5">
            <Label htmlFor={`cl-${kind}-currency`}>{t('checklist.currency')}</Label>
            <Input
              id={`cl-${kind}-currency`}
              value={currency ?? ''}
              maxLength={3}
              disabled={submitting}
              onChange={(e) => {
                setCurrency(e.target.value.toUpperCase());
                setDirty(true);
              }}
            />
          </div>
        </div>
      ) : null}

      {uniqueErrorIssues.length > 0 ? (
        <ul className="list-disc space-y-0.5 pl-4">
          {uniqueErrorIssues.map((issue) => (
            <li key={issue.code} className="text-xs text-destructive">
              {issue.message}
            </li>
          ))}
        </ul>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" disabled={saveBlocked || submitting} onClick={handleSave}>
          {pending === 'save' && <Loader2 className="size-3.5 animate-spin" />}
          {t('checklist.saveDraft')}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={publishBlocked || submitting}
          onClick={handlePublish}
        >
          {pending === 'publish' && <Loader2 className="size-3.5 animate-spin" />}
          {t('checklist.publish')}
        </Button>
        {status === 'published' ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={submitting}
            onClick={handleUnpublish}
          >
            {pending === 'unpublish' && <Loader2 className="size-3.5 animate-spin" />}
            {t('checklist.unpublish')}
          </Button>
        ) : null}
      </div>
      {publishBlocked ? (
        <p className="text-xs text-muted-foreground">{t('checklist.publishBlocked')}</p>
      ) : null}
    </div>
  );
}
