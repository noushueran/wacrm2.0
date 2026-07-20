'use client';

import { useEffect, useRef, useState, type JSX } from 'react';
import { useTranslations } from 'next-intl';
import { ConvexError } from 'convex/values';
import { Loader2 } from 'lucide-react';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

import { hasLintErrors, lintServiceInput } from '../../../convex/lib/kb/lint';
import type { LintIssue } from '../../../convex/lib/kb/types';

// ============================================================
// ServiceForm — create/edit dialog for a single kbServices row.
// Convex-free (like service-matrix.tsx): it renders a Dialog,
// validates with the shared lint rules, and hands clean values up
// through `onSubmit`/`onDelete`. `knowledge-studio.tsx` owns the
// `useMutation` calls, which keeps this file mockable for Task 8's
// browser verification.
//
// `key` is the service's immutable identity — `kbEntries` and
// `kbOpsBlocks` join on it by string, and `kbServices.upsert` has no
// id argument, so a saved key can never be renamed. The key input is
// disabled+readOnly whenever `initial` is present (edit mode); in
// create mode it's freely editable but pre-filled from the name via
// `suggestServiceKey`, so most services never need it touched by hand.
// ============================================================

type ServiceFormValues = {
  key: string;
  name: string;
  aliases: string[];
  routingTagName?: string;
  status: 'active' | 'paused';
  sortOrder: number;
};

/** Slug suggestion for a brand-new service's key, derived from its
 *  display name. Only a starting point — the key input stays editable
 *  in create mode so the user may override it before first save. */
export function suggestServiceKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** Splits the free-text aliases field on commas, trims each part,
 *  drops blanks, and dedupes case-insensitively (first casing seen wins). */
export function parseAliases(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const norm = trimmed.toLowerCase();
    if (seen.has(norm)) continue;
    seen.add(norm);
    out.push(trimmed);
  }
  return out;
}

/** What a rejected `onSubmit`/`onDelete` told us. `kbServices.upsert`
 *  only ever throws a `{ issues }` ConvexError; `kbServices.remove`
 *  throws `{ reason: "service_in_use" }` while an entry or ops block
 *  still references the key (Convex has no cascading deletes, so this
 *  is enforced in application code, not the schema). Anything else —
 *  a plain network error, or `remove`'s NOT_FOUND on an already-gone
 *  row — falls back to `other` rather than pretending to know more
 *  than it does. */
type SubmitError =
  | { kind: 'issues'; issues: LintIssue[] }
  | { kind: 'serviceInUse' }
  | { kind: 'other' };

function readSubmitError(err: unknown): SubmitError {
  if (err instanceof ConvexError && err.data !== null && typeof err.data === 'object') {
    const data = err.data as Record<string, unknown>;
    if (Array.isArray(data.issues)) return { kind: 'issues', issues: data.issues as LintIssue[] };
    if (data.reason === 'service_in_use') return { kind: 'serviceInUse' };
  }
  return { kind: 'other' };
}

const KEY_ISSUE_CODES = new Set(['key_slug', 'key_taken']);
const NAME_ISSUE_CODES = new Set(['name_required']);
const ALIAS_ISSUE_CODES = new Set(['alias_blank', 'alias_duplicate']);

export function ServiceForm({
  open,
  initial,
  existingKeys,
  onClose,
  onSubmit,
  onDelete,
}: {
  open: boolean;
  initial?: ServiceFormValues;
  existingKeys: string[];
  onClose: () => void;
  onSubmit: (values: ServiceFormValues) => Promise<void>;
  /** Present only in edit mode; omit for create. */
  onDelete?: () => Promise<void>;
}): JSX.Element {
  const t = useTranslations('Knowledge');
  const isEdit = initial !== undefined;

  const [name, setName] = useState('');
  const [key, setKey] = useState('');
  const [keyTouched, setKeyTouched] = useState(false);
  const [aliasesRaw, setAliasesRaw] = useState('');
  const [routingTagName, setRoutingTagName] = useState('');
  const [status, setStatus] = useState<'active' | 'paused'>('active');
  const [sortOrder, setSortOrder] = useState(0);

  const [submitting, setSubmitting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [submitError, setSubmitError] = useState<SubmitError | null>(null);

  // `initial` is a fresh object every time `knowledge-studio.tsx`'s
  // `studioOverview` query recomputes — which fires on ANY write to
  // kbServices/kbEntries/kbOpsBlocks anywhere in the account, not just
  // the row being edited. Keying the re-seed effect below on `initial`
  // itself would re-fire on every such reactive update, silently
  // overwriting whatever the admin has half-typed while the dialog is
  // still open. `key` is the service's one immutable field (see the
  // module doc comment above), so it's the right re-seed trigger. This
  // ref just keeps the latest field values on hand for when that
  // trigger *does* fire — it's updated every render (a plain field
  // write, not effectful) so the effect always reads fresh data
  // without pulling `initial`, or its never-referentially-stable
  // `aliases` array, into its dependency array.
  const initialRef = useRef(initial);
  initialRef.current = initial;

  // Re-seed every field whenever the dialog opens for a (possibly
  // different) service — it stays mounted across opens/closes (the
  // studio just flips `open`), so `useState` initializers alone would
  // only ever apply once. Keyed on `initial?.key`, not `initial`
  // itself: a reactive re-render that hands us a new `initial` object
  // for the *same* service must not clobber in-progress edits.
  useEffect(() => {
    if (!open) return;
    const seed = initialRef.current;
    setName(seed?.name ?? '');
    setKey(seed?.key ?? '');
    setKeyTouched(false);
    setAliasesRaw((seed?.aliases ?? []).join(', '));
    setRoutingTagName(seed?.routingTagName ?? '');
    setStatus(seed?.status ?? 'active');
    setSortOrder(seed?.sortOrder ?? 0);
    setSubmitError(null);
  }, [open, initial?.key]);

  const aliases = parseAliases(aliasesRaw);
  // The service's own key must never count against itself as "taken"
  // — mirrors the conditional kbServices.upsert applies server-side
  // (`existing ? [] : siblings.map(...)`).
  const issues = lintServiceInput({
    key,
    name,
    aliases,
    existingKeys: isEdit ? [] : existingKeys,
  });
  const blocked = hasLintErrors(issues);
  const issuesFor = (codes: Set<string>) => issues.filter((issue) => codes.has(issue.code));

  function handleNameChange(next: string) {
    setName(next);
    if (!isEdit && !keyTouched) setKey(suggestServiceKey(next));
  }

  function handleKeyChange(next: string) {
    setKeyTouched(true);
    setKey(next);
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (blocked || submitting || deleting) return;
    setSubmitError(null);
    setSubmitting(true);
    try {
      await onSubmit({
        key,
        name: name.trim(),
        aliases,
        routingTagName: routingTagName.trim() || undefined,
        status,
        sortOrder,
      });
    } catch (err) {
      setSubmitError(readSubmitError(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete() {
    if (!onDelete || submitting || deleting) return;
    if (!window.confirm(t('serviceForm.deleteConfirm'))) return;
    setSubmitError(null);
    setDeleting(true);
    try {
      await onDelete();
    } catch (err) {
      setSubmitError(readSubmitError(err));
    } finally {
      setDeleting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {isEdit ? t('serviceForm.editTitle') : t('serviceForm.createTitle')}
          </DialogTitle>
        </DialogHeader>

        {submitError ? (
          <Alert variant="destructive">
            <AlertDescription>
              {submitError.kind === 'issues' ? (
                <ul className="list-disc space-y-0.5 pl-4">
                  {submitError.issues.map((issue) => (
                    <li key={issue.code}>{issue.message}</li>
                  ))}
                </ul>
              ) : submitError.kind === 'serviceInUse' ? (
                t('serviceForm.deleteBlocked')
              ) : (
                'Something went wrong.'
              )}
            </AlertDescription>
          </Alert>
        ) : null}

        <form onSubmit={handleSave} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="sf-name">{t('serviceForm.name')}</Label>
            <Input
              id="sf-name"
              value={name}
              onChange={(e) => handleNameChange(e.target.value)}
              placeholder={t('serviceForm.namePlaceholder')}
            />
            {issuesFor(NAME_ISSUE_CODES).map((issue) => (
              <p key={issue.code} className="text-xs text-destructive">
                {issue.message}
              </p>
            ))}
          </div>

          <div className="space-y-2">
            <Label htmlFor="sf-key">{t('serviceForm.key')}</Label>
            <Input
              id="sf-key"
              value={key}
              onChange={(e) => handleKeyChange(e.target.value)}
              disabled={isEdit}
              readOnly={isEdit}
            />
            <p className="text-xs text-muted-foreground">{t('serviceForm.keyHint')}</p>
            {issuesFor(KEY_ISSUE_CODES).map((issue) => (
              <p key={issue.code} className="text-xs text-destructive">
                {issue.message}
              </p>
            ))}
          </div>

          <div className="space-y-2">
            <Label htmlFor="sf-aliases">{t('serviceForm.aliases')}</Label>
            <Input
              id="sf-aliases"
              value={aliasesRaw}
              onChange={(e) => setAliasesRaw(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">{t('serviceForm.aliasesHint')}</p>
            {issuesFor(ALIAS_ISSUE_CODES).map((issue) => (
              <p key={issue.code} className="text-xs text-destructive">
                {issue.message}
              </p>
            ))}
          </div>

          <div className="space-y-2">
            <Label htmlFor="sf-routing-tag">{t('serviceForm.routingTag')}</Label>
            <Input
              id="sf-routing-tag"
              value={routingTagName}
              onChange={(e) => setRoutingTagName(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">{t('serviceForm.routingTagHint')}</p>
          </div>

          <div className="space-y-2">
            <Label>{t('serviceForm.status')}</Label>
            <Select value={status} onValueChange={(v) => setStatus(v as 'active' | 'paused')}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="active">{t('serviceForm.statusActive')}</SelectItem>
                <SelectItem value="paused">{t('serviceForm.statusPaused')}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="sf-sort-order">{t('serviceForm.sortOrder')}</Label>
            <Input
              id="sf-sort-order"
              type="number"
              value={sortOrder}
              onChange={(e) => {
                const n = Number(e.target.value);
                setSortOrder(Number.isNaN(n) ? 0 : n);
              }}
            />
          </div>

          <DialogFooter>
            {isEdit && onDelete ? (
              <Button
                type="button"
                variant="destructive"
                className="sm:mr-auto"
                disabled={submitting || deleting}
                onClick={handleDelete}
              >
                {deleting && <Loader2 className="size-4 animate-spin" />}
                {t('serviceForm.delete')}
              </Button>
            ) : null}
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              disabled={submitting || deleting}
            >
              {t('serviceForm.cancel')}
            </Button>
            <Button type="submit" disabled={blocked || submitting || deleting}>
              {submitting && <Loader2 className="size-4 animate-spin" />}
              {t('serviceForm.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
