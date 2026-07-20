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
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';

import { hasLintErrors, lintEntryInput } from '../../../convex/lib/kb/lint';
import type { LintIssue } from '../../../convex/lib/kb/types';
import type { EntryDraft } from './service-detail';

// ============================================================
// EntryEditor — create/edit dialog for one kbEntries row. Convex-free
// (like service-form.tsx): validates with the shared lint rules and
// hands clean values up through `onSave`; `knowledge-studio.tsx` owns
// the `useMutation` call. This dialog only ever operates within
// whichever service `ServiceDetail` currently has open, so `scope`/
// `serviceKey` are never fields here — the caller injects them.
//
// `DeleteEntryDialog` (below) is a separate, small confirm dialog, not
// nested inside this one: deleting an entry is a single click from its
// row in ServiceDetail, not something that requires opening the full
// create/edit form first.
// ============================================================

const ENTRY_TYPE_OPTIONS = [
  'overview', 'faq', 'requirements', 'itinerary', 'policy', 'process', 'note',
] as const;
// ^ Mirrors service-detail.tsx's ENTRY_TYPE_ORDER (the same 7 literals
// kbEntries.save accepts), re-declared locally rather than imported:
// service-detail.tsx imports EntryEditor (a value import), so
// importing a value the other way would make the two files a runtime
// circular dependency. The `EntryDraft` import below is type-only, so
// it doesn't have that problem — type imports are erased at compile
// time and never execute as a real module edge.

const TITLE_ISSUE_CODES = new Set(['title_required']);
const BODY_ERROR_CODES = new Set(['body_required']);

/** What a rejected `onSave` told us. Mirrors service-form.tsx's own
 *  `SubmitError`, simplified: entries have no "in use" delete guard to
 *  special-case, so everything that isn't a lint rejection collapses
 *  into a generic failure message. */
type SubmitError = { kind: 'issues'; issues: LintIssue[] } | { kind: 'other' };

function readSubmitError(err: unknown): SubmitError {
  if (err instanceof ConvexError && err.data !== null && typeof err.data === 'object') {
    const data = err.data as Record<string, unknown>;
    if (Array.isArray(data.issues)) {
      return { kind: 'issues', issues: data.issues as LintIssue[] };
    }
  }
  return { kind: 'other' };
}

export function EntryEditor({
  open,
  initial,
  onClose,
  onSave,
}: {
  open: boolean;
  /** Seeds the form: an existing entry (carries `entryId`) when
   *  editing, or a fresh draft pre-set to a chosen type (no
   *  `entryId`) when creating from a section's "Add {type}" button.
   *  Optional only defensively — ServiceDetail always builds one
   *  before setting `open`. */
  initial?: EntryDraft;
  onClose: () => void;
  onSave: (values: EntryDraft) => Promise<void>;
}): JSX.Element {
  const t = useTranslations('Knowledge');
  const isEdit = initial?.entryId !== undefined;

  const [type, setType] = useState<string>(ENTRY_TYPE_OPTIONS[0]);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [audience, setAudience] = useState<'customer' | 'internal'>('customer');

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<SubmitError | null>(null);

  // Same indirection as service-form.tsx's `initialRef`, and for the
  // same reason: the re-seed effect below only wants to run on
  // `open`'s false→true transition, so it must read `initial` fresh
  // at that moment without listing the object itself (new every
  // render) in its dependency array.
  const initialRef = useRef(initial);
  initialRef.current = initial;

  useEffect(() => {
    if (!open) return;
    const seed = initialRef.current;
    setType(seed?.type ?? ENTRY_TYPE_OPTIONS[0]);
    setTitle(seed?.title ?? '');
    setBody(seed?.body ?? '');
    setAudience(seed?.audience ?? 'customer');
    setSubmitError(null);
  }, [open]);

  // `scope`/`serviceKey` are fixed by context — this dialog only ever
  // edits within whichever service is currently open — so a
  // placeholder non-empty serviceKey is enough to keep the shared
  // `service_key_required` rule from firing here. The real key is
  // supplied by knowledge-studio.tsx when it actually calls
  // kbEntries.save.
  const issues = lintEntryInput({
    scope: 'service',
    serviceKey: 'current-service',
    title,
    body,
    audience,
  });
  const blocked = hasLintErrors(issues);
  const titleIssues = issues.filter((issue) => TITLE_ISSUE_CODES.has(issue.code));
  const bodyErrors = issues.filter(
    (issue) => issue.level === 'error' && BODY_ERROR_CODES.has(issue.code),
  );
  // price_mention (and any future warning-level rule) lands here —
  // advisory only, never blocks saving (`blocked` above only looks at
  // error-level issues).
  const bodyWarnings = issues.filter((issue) => issue.level === 'warning');

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (blocked || submitting) return;
    setSubmitError(null);
    setSubmitting(true);
    try {
      await onSave({
        entryId: initial?.entryId,
        type,
        title: title.trim(),
        body: body.trim(),
        audience,
      });
    } catch (err) {
      setSubmitError(readSubmitError(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {isEdit ? t('entryEditor.editTitle') : t('entryEditor.createTitle')}
          </DialogTitle>
        </DialogHeader>

        {isEdit ? (
          <Alert>
            <AlertDescription>{t('entryEditor.editWarning')}</AlertDescription>
          </Alert>
        ) : null}

        {submitError ? (
          <Alert variant="destructive">
            <AlertDescription>
              {submitError.kind === 'issues' ? (
                <ul className="list-disc space-y-0.5 pl-4">
                  {submitError.issues.map((issue) => (
                    <li key={issue.code}>{issue.message}</li>
                  ))}
                </ul>
              ) : (
                t('entryEditor.saveFailed')
              )}
            </AlertDescription>
          </Alert>
        ) : null}

        <form onSubmit={handleSave} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="ee-type">{t('entryEditor.type')}</Label>
            <Select
              value={type}
              onValueChange={(v) => {
                // Single-select `onValueChange` is typed nullable for the
                // "cleared" case; this Select always has a value selected
                // (SelectItem covers every ENTRY_TYPE_OPTIONS member and
                // there's no clear affordance), so `v` is never actually
                // null in practice — the guard just keeps `type`'s state
                // honestly non-nullable rather than casting past it.
                if (v !== null) setType(v);
              }}
            >
              <SelectTrigger id="ee-type" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ENTRY_TYPE_OPTIONS.map((option) => (
                  <SelectItem key={option} value={option}>
                    {t(`detail.types.${option}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="ee-title">{t('entryEditor.title')}</Label>
            <Input id="ee-title" value={title} onChange={(e) => setTitle(e.target.value)} />
            {titleIssues.map((issue) => (
              <p key={issue.code} className="text-xs text-destructive">
                {issue.message}
              </p>
            ))}
          </div>

          <div className="space-y-2">
            <Label htmlFor="ee-body">{t('entryEditor.body')}</Label>
            <Textarea
              id="ee-body"
              rows={6}
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
            {bodyErrors.map((issue) => (
              <p key={issue.code} className="text-xs text-destructive">
                {issue.message}
              </p>
            ))}
            {bodyWarnings.map((issue) => (
              <p key={issue.code} className="text-xs text-amber-600 dark:text-amber-400">
                {issue.message}
              </p>
            ))}
          </div>

          <div className="space-y-2">
            <Label>{t('entryEditor.audience')}</Label>
            <RadioGroup
              value={audience}
              onValueChange={(v) => setAudience(v as 'customer' | 'internal')}
            >
              <label className="flex items-center gap-2 text-sm text-foreground">
                <RadioGroupItem value="customer" />
                {t('entryEditor.audienceCustomer')}
              </label>
              <label className="flex items-center gap-2 text-sm text-foreground">
                <RadioGroupItem value="internal" />
                {t('entryEditor.audienceInternal')}
              </label>
            </RadioGroup>
            <p className="text-xs text-muted-foreground">{t('entryEditor.audienceHint')}</p>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>
              {t('entryEditor.cancel')}
            </Button>
            <Button type="submit" disabled={blocked || submitting}>
              {submitting && <Loader2 className="size-4 animate-spin" />}
              {t('entryEditor.saveDraft')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Confirm-delete dialog for one entry. Kept separate from `EntryEditor`
 * above (not nested in its footer) so deleting a row is a single click
 * from `ServiceDetail`'s list, not something that requires opening the
 * full form first. `onConfirm` is expected to handle its own errors
 * (surface them however the caller prefers, e.g. a toast) and only
 * resolve — this dialog just tracks its own busy spinner around it and
 * leaves closing to the caller (`open` is fully controlled).
 */
export function DeleteEntryDialog({
  open,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}): JSX.Element {
  const t = useTranslations('Knowledge');
  const [deleting, setDeleting] = useState(false);

  async function handleConfirm() {
    setDeleting(true);
    try {
      await onConfirm();
    } finally {
      setDeleting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{t('entryEditor.delete')}</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">{t('entryEditor.deleteConfirm')}</p>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onCancel} disabled={deleting}>
            {t('entryEditor.cancel')}
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={() => void handleConfirm()}
            disabled={deleting}
          >
            {deleting && <Loader2 className="size-4 animate-spin" />}
            {t('entryEditor.delete')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
