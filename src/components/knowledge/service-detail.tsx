'use client';

import { useState, type JSX, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { ArrowLeft, Loader2, Pencil, Plus, Trash2 } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { softBadge, type SoftTone } from '@/lib/ui/soft-badge';
import { cn } from '@/lib/utils';
import type { ServiceVerdict } from '@/lib/knowledge/verdict';
import type { ServiceRow } from './service-matrix';
import { DeleteEntryDialog, EntryEditor } from './entry-editor';

// ============================================================
// ServiceDetail — the drill-down view for one kbServices row: back
// button, service identity + verdict + "Edit service", one section per
// prose-entry type (overview/faq/requirements/itinerary/policy/
// process/note) each listing its entries with edit/publish/unpublish/
// delete actions, then three ops sections (qualification/sales/
// purchase) rendered via `opsSlot`.
//
// `opsSlot` is a render prop so Task 7's checklist editors can mount
// here without this file importing them — React hooks can't be called
// conditionally/in a loop, so Task 7 runs its queries unconditionally
// in `KnowledgeStudio` and has `opsSlot` merely select from
// already-fetched results. Keeping that boundary is what makes the two
// tasks independently reviewable.
//
// Convex-free (props only), matching service-matrix.tsx and
// service-form.tsx: every write goes through an async callback prop
// the studio shell binds to a `useMutation` call, so Task 8 can drive
// this component from mocked data in a temporary preview route.
// ============================================================

export const ENTRY_TYPE_ORDER = [
  'overview', 'faq', 'requirements', 'itinerary', 'policy', 'process', 'note',
] as const;
export type EntryType = (typeof ENTRY_TYPE_ORDER)[number];

export type EntrySummary = {
  _id: string;
  type: string;
  title: string;
  body: string;
  audience: 'customer' | 'internal';
  status: 'draft' | 'published';
  version: number;
};
export type EntryDraft = {
  entryId?: string;
  type: string;
  title: string;
  body: string;
  audience: 'customer' | 'internal';
};

/** Buckets `entries` by `type`, preserving `ENTRY_TYPE_ORDER` as the
 *  key order and dropping types with nothing in them — `Object.keys`
 *  on the result is exactly the set of sections that have content. */
export function groupEntriesByType(
  entries: EntrySummary[],
): Partial<Record<string, EntrySummary[]>> {
  const grouped: Partial<Record<string, EntrySummary[]>> = {};
  for (const type of ENTRY_TYPE_ORDER) {
    const matching = entries.filter((e) => e.type === type);
    if (matching.length) grouped[type] = matching;
  }
  return grouped;
}

// Duplicated from service-matrix.tsx's own private VerdictBadge rather
// than imported: that file isn't part of this task and stays
// independently reviewable (same reasoning as the opsSlot boundary
// above) — only its exported `ServiceRow` type crosses the boundary.
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

function EntryStatusBadge({
  status,
  t,
}: {
  status: EntrySummary['status'];
  t: ReturnType<typeof useTranslations>;
}) {
  return (
    <Badge
      variant="outline"
      className={cn('text-[10px]', softBadge(status === 'published' ? 'success' : 'info'))}
    >
      {status === 'published' ? t('detail.publishedBadge') : t('detail.draftBadge')}
    </Badge>
  );
}

function EntryRow({
  entry,
  busy,
  onEdit,
  onPublish,
  onUnpublish,
  onDelete,
  t,
}: {
  entry: EntrySummary;
  busy: boolean;
  onEdit: () => void;
  onPublish: () => void;
  onUnpublish: () => void;
  onDelete: () => void;
  t: ReturnType<typeof useTranslations>;
}) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
      <div className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 truncate text-sm text-foreground">{entry.title}</span>
        <EntryStatusBadge status={entry.status} t={t} />
        <span className="shrink-0 text-xs text-muted-foreground">
          {t('detail.version', { n: entry.version })}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={t('entryEditor.editTitle')}
          onClick={onEdit}
          disabled={busy}
        >
          <Pencil className="size-3.5" />
        </Button>
        {entry.status === 'published' ? (
          <Button type="button" variant="ghost" size="sm" onClick={onUnpublish} disabled={busy}>
            {busy && <Loader2 className="size-3.5 animate-spin" />}
            {t('entryEditor.unpublish')}
          </Button>
        ) : (
          <Button type="button" variant="ghost" size="sm" onClick={onPublish} disabled={busy}>
            {busy && <Loader2 className="size-3.5 animate-spin" />}
            {t('entryEditor.publish')}
          </Button>
        )}
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={t('entryEditor.delete')}
          className="text-destructive hover:text-destructive"
          onClick={onDelete}
          disabled={busy}
        >
          <Trash2 className="size-3.5" />
        </Button>
      </div>
    </li>
  );
}

/** What the create/edit dialog is doing: closed, or open seeded with a
 *  draft — either a fresh entry pre-set to a chosen type (no
 *  `entryId`, from a section's "Add {type}" button) or an existing one
 *  (from a row's edit button). */
type EditorState = { open: false } | { open: true; initial: EntryDraft };

export function ServiceDetail({
  service,
  entries,
  onBack,
  onEditService,
  onSaveEntry,
  onPublishEntry,
  onUnpublishEntry,
  onRemoveEntry,
  opsSlot,
}: {
  service: ServiceRow;
  entries: EntrySummary[];
  onBack: () => void;
  onEditService: () => void;
  onSaveEntry: (values: EntryDraft) => Promise<void>;
  onPublishEntry: (entryId: string) => Promise<void>;
  onUnpublishEntry: (entryId: string) => Promise<void>;
  onRemoveEntry: (entryId: string) => Promise<void>;
  opsSlot: (kind: 'qualification' | 'sales' | 'purchase') => ReactNode;
}): JSX.Element {
  const t = useTranslations('Knowledge');
  const grouped = groupEntriesByType(entries);

  const [editor, setEditor] = useState<EditorState>({ open: false });
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  // The single entry currently mid publish/unpublish — deleting has
  // its own busy state inside DeleteEntryDialog, and its modal backdrop
  // already blocks interaction with the row underneath, so it doesn't
  // need to participate here too.
  const [busyId, setBusyId] = useState<string | null>(null);

  const closeEditor = () => setEditor({ open: false });

  async function handleSaveEntry(values: EntryDraft) {
    // Only reached on success — EntryEditor catches a rejection from
    // onSaveEntry itself and renders it inline, mirroring
    // service-form.tsx's onSubmit/ServiceForm split (the child never
    // closes itself on error; the parent closes only after the await
    // above resolves).
    await onSaveEntry(values);
    closeEditor();
  }

  async function handlePublish(entryId: string) {
    setBusyId(entryId);
    try {
      await onPublishEntry(entryId);
    } catch (err) {
      console.error('[ServiceDetail] publish entry failed:', err);
      toast.error(t('entryEditor.publishFailed'));
    } finally {
      setBusyId(null);
    }
  }

  async function handleUnpublish(entryId: string) {
    setBusyId(entryId);
    try {
      await onUnpublishEntry(entryId);
    } catch (err) {
      console.error('[ServiceDetail] unpublish entry failed:', err);
      toast.error(t('entryEditor.unpublishFailed'));
    } finally {
      setBusyId(null);
    }
  }

  async function handleConfirmDelete() {
    if (!pendingDeleteId) return;
    try {
      await onRemoveEntry(pendingDeleteId);
      setPendingDeleteId(null);
    } catch (err) {
      console.error('[ServiceDetail] delete entry failed:', err);
      toast.error(t('entryEditor.deleteFailed'));
    }
  }

  return (
    <div className="mt-6 space-y-6">
      <Button type="button" variant="ghost" size="sm" onClick={onBack}>
        <ArrowLeft className="size-4" />
        {t('detail.back')}
      </Button>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <h3 className="min-w-0 truncate text-base font-semibold text-foreground">
            {service.name}
          </h3>
          <VerdictBadge verdict={service.verdict} t={t} />
        </div>
        <Button type="button" variant="outline" size="sm" onClick={onEditService}>
          <Pencil className="size-4" />
          {t('detail.editService')}
        </Button>
      </div>

      <div className="space-y-4">
        {ENTRY_TYPE_ORDER.map((type) => {
          const typeLabel = t(`detail.types.${type}`);
          const typeEntries = grouped[type] ?? [];
          return (
            <Card key={type}>
              <CardContent className="p-0">
                <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
                  <h4 className="text-sm font-medium text-foreground">{typeLabel}</h4>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      setEditor({
                        open: true,
                        initial: { type, title: '', body: '', audience: 'customer' },
                      })
                    }
                  >
                    <Plus className="size-3.5" />
                    {t('detail.addEntry', { type: typeLabel })}
                  </Button>
                </div>
                {typeEntries.length ? (
                  <ul className="divide-y divide-border">
                    {typeEntries.map((entry) => (
                      <EntryRow
                        key={entry._id}
                        entry={entry}
                        busy={busyId === entry._id}
                        onEdit={() =>
                          setEditor({
                            open: true,
                            initial: {
                              entryId: entry._id,
                              type: entry.type,
                              title: entry.title,
                              body: entry.body,
                              audience: entry.audience,
                            },
                          })
                        }
                        onPublish={() => void handlePublish(entry._id)}
                        onUnpublish={() => void handleUnpublish(entry._id)}
                        onDelete={() => setPendingDeleteId(entry._id)}
                        t={t}
                      />
                    ))}
                  </ul>
                ) : (
                  <p className="px-3 py-3 text-sm text-muted-foreground">{t('detail.noEntries')}</p>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>

      <div className="space-y-4">
        {(['qualification', 'sales', 'purchase'] as const).map((kind) => (
          <Card key={kind}>
            <CardContent className="space-y-2">
              <h4 className="text-sm font-medium text-foreground">{t(`columns.${kind}`)}</h4>
              {opsSlot(kind)}
            </CardContent>
          </Card>
        ))}
      </div>

      <EntryEditor
        open={editor.open}
        initial={editor.open ? editor.initial : undefined}
        onClose={closeEditor}
        onSave={handleSaveEntry}
      />

      <DeleteEntryDialog
        open={pendingDeleteId !== null}
        onCancel={() => setPendingDeleteId(null)}
        onConfirm={handleConfirmDelete}
      />
    </div>
  );
}
