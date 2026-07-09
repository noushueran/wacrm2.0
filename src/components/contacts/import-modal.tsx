'use client';

import { useMemo, useRef, useState } from 'react';
import { useMutation, useQuery } from 'convex/react';
import { useAuth } from '@/hooks/use-auth';
import { dedupeByPhone } from '@/lib/contacts/dedupe';
import {
  parseContactCsv,
  type ParsedContactRow,
} from '@/lib/contacts/parse-contact-csv';
import { isConvexErrorCode, toUiTag } from '@/lib/convex/adapters';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import {
  Upload,
  FileText,
  Loader2,
  CheckCircle,
  XCircle,
  AlertTriangle,
  Tag,
} from 'lucide-react';
import { useTranslations } from 'next-intl';

import { api } from '../../../convex/_generated/api';
import type { Id } from '../../../convex/_generated/dataModel';

const DEFAULT_TAG_COLOR = '#3b82f6';
const PREVIEW_LIMIT = 5;
// Convex has no bulk-insert mutation — `contacts.create` is one row per
// call — so imports fan out in small concurrent batches rather than the
// Supabase-era single chunked `.insert([...50 rows])` call. Convex
// mutations are serialized server-side, so concurrent calls are safe;
// this is purely a client-side throughput knob.
const IMPORT_CONCURRENCY = 10;

function truncateFilename(name: string, max = 48): string {
  if (name.length <= max) return name;
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.')) : '';
  const base = name.slice(0, name.length - ext.length);
  const keep = max - ext.length - 1;
  return `${base.slice(0, Math.max(keep, 12))}…${ext}`;
}

function PreviewCell({
  value,
  mono,
  maxWidth = 'max-w-[9rem]',
}: {
  value: string;
  mono?: boolean;
  maxWidth?: string;
}) {
  return (
    <span
      className={cn(
        'block truncate',
        maxWidth,
        mono && 'font-mono text-[11px]'
      )}
      title={value}
    >
      {value}
    </span>
  );
}

function ImportPreviewTags({
  tagNames,
  tagColorByKey,
}: {
  tagNames: string[];
  tagColorByKey: Map<string, string>;
}) {
  const t = useTranslations('Contacts.importModal');

  if (tagNames.length === 0) {
    return <span className="text-muted-foreground">—</span>;
  }

  return (
    <div className="flex min-w-[4.5rem] flex-wrap gap-1">
      {tagNames.map((name) => {
        const color =
          tagColorByKey.get(name.trim().toLowerCase()) ?? DEFAULT_TAG_COLOR;
        const isKnown = tagColorByKey.has(name.trim().toLowerCase());
        return (
          <span
            key={name}
            className="inline-flex max-w-full items-center gap-1 rounded-full px-2 py-0.5 text-[10px] leading-none font-medium"
            style={{
              backgroundColor: `${color}18`,
              color,
              border: `1px solid ${color}${isKnown ? '55' : '30'}`,
            }}
            title={isKnown ? name : t('willBeCreated', { name })}
          >
            <span
              className="size-1.5 shrink-0 rounded-full"
              style={{ backgroundColor: color }}
            />
            <span className="truncate">{name}</span>
          </span>
        );
      })}
    </div>
  );
}

// ============================================================
// Tag-name resolution, Convex-flavored. This is a deliberate,
// local-to-this-component reimplementation of
// `src/lib/contacts/resolve-import-tags.ts`'s `resolveImportTagIds`/
// `assignImportedContactTags` — that module is NOT touched here because
// `src/lib/api/v1/contacts.ts` (the REST API v1 route, Phase 8 Task 4,
// out of scope) still depends on its Supabase-client-based signature.
// ============================================================

interface ExistingTagLike {
  id: Id<'tags'>;
  name: string;
}

async function resolveTagIds(params: {
  existingTags: ExistingTagLike[];
  tagNames: string[];
  canCreateTags: boolean;
  createTag: (args: { name: string; color: string }) => Promise<Id<'tags'>>;
}): Promise<{ tagIdByKey: Map<string, Id<'tags'>>; skippedNames: string[] }> {
  const { existingTags, tagNames, canCreateTags, createTag } = params;

  const uniqueNames: string[] = [];
  const seen = new Set<string>();
  for (const raw of tagNames) {
    const name = raw.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueNames.push(name);
  }
  if (uniqueNames.length === 0) return { tagIdByKey: new Map(), skippedNames: [] };

  const tagIdByKey = new Map<string, Id<'tags'>>();
  for (const tag of existingTags) {
    const key = tag.name.trim().toLowerCase();
    if (!tagIdByKey.has(key)) tagIdByKey.set(key, tag.id);
  }

  const skippedNames: string[] = [];
  const toCreate: string[] = [];
  for (const name of uniqueNames) {
    const key = name.toLowerCase();
    if (tagIdByKey.has(key)) continue;
    if (canCreateTags) toCreate.push(name);
    else skippedNames.push(name);
  }

  for (const name of toCreate) {
    try {
      const id = await createTag({ name, color: DEFAULT_TAG_COLOR });
      tagIdByKey.set(name.toLowerCase(), id);
    } catch {
      // Another request may have created the same name first (or the
      // mutation failed for some other reason) — treat as skipped
      // rather than failing the whole import.
      skippedNames.push(name);
    }
  }

  return { tagIdByKey, skippedNames };
}

interface ContactTagAssignment {
  contactId: Id<'contacts'>;
  tagNames: string[];
}

async function assignTagsToImportedContacts(
  assignments: ContactTagAssignment[],
  tagIdByKey: Map<string, Id<'tags'>>,
  assignTag: (args: {
    contactId: Id<'contacts'>;
    tagId: Id<'tags'>;
  }) => Promise<unknown>,
): Promise<number> {
  const pairs: { contactId: Id<'contacts'>; tagId: Id<'tags'> }[] = [];
  for (const { contactId, tagNames } of assignments) {
    const assignedTagIds = new Set<Id<'tags'>>();
    for (const name of tagNames) {
      const tagId = tagIdByKey.get(name.trim().toLowerCase());
      if (!tagId || assignedTagIds.has(tagId)) continue;
      assignedTagIds.add(tagId);
      pairs.push({ contactId, tagId });
    }
  }
  if (pairs.length === 0) return 0;

  let assigned = 0;
  for (let i = 0; i < pairs.length; i += IMPORT_CONCURRENCY) {
    const chunk = pairs.slice(i, i + IMPORT_CONCURRENCY);
    await Promise.all(chunk.map((pair) => assignTag(pair)));
    assigned += chunk.length;
  }
  return assigned;
}

interface ImportModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImported: () => void;
}

export function ImportModal({
  open,
  onOpenChange,
  onImported,
}: ImportModalProps) {
  const t = useTranslations('Contacts.importModal');
  const { canEditSettings } = useAuth();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const tagsResult = useQuery(api.tags.list);
  const tags = useMemo(() => (tagsResult ?? []).map(toUiTag), [tagsResult]);

  const createContact = useMutation(api.contacts.create);
  const createTag = useMutation(api.tags.create);
  const assignTag = useMutation(api.contacts.assignTag);

  const [file, setFile] = useState<File | null>(null);
  const [parsedRows, setParsedRows] = useState<ParsedContactRow[]>([]);
  const [hasTagsColumn, setHasTagsColumn] = useState(false);
  const [hasCompanyColumn, setHasCompanyColumn] = useState(false);
  const [tagColorByKey, setTagColorByKey] = useState<Map<string, string>>(
    new Map()
  );
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<{
    imported: number;
    skipped: number;
    failed: number;
    tagsAssigned: number;
  } | null>(null);

  function reset() {
    setFile(null);
    setParsedRows([]);
    setHasTagsColumn(false);
    setHasCompanyColumn(false);
    setTagColorByKey(new Map());
    setResult(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  function handleOpenChange(next: boolean) {
    if (!next) reset();
    onOpenChange(next);
  }

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const selected = e.target.files?.[0];
    if (!selected) return;

    setFile(selected);
    setResult(null);

    const text = await selected.text();
    const {
      rows,
      hasTagsColumn: csvHasTags,
      hasCompanyColumn: csvHasCompany,
    } = parseContactCsv(text);

    if (rows.length === 0) {
      toast.error(t('toastNoValidRows'));
      setParsedRows([]);
      setHasTagsColumn(false);
      setHasCompanyColumn(false);
      setTagColorByKey(new Map());
      return;
    }

    setParsedRows(rows);
    setHasTagsColumn(csvHasTags);
    setHasCompanyColumn(csvHasCompany);

    if (csvHasTags) {
      const colors = new Map<string, string>();
      for (const tag of tags) {
        const key = tag.name.trim().toLowerCase();
        if (!colors.has(key)) colors.set(key, tag.color);
      }
      setTagColorByKey(colors);
    } else {
      setTagColorByKey(new Map());
    }
  }

  async function handleImport() {
    if (parsedRows.length === 0) return;
    setImporting(true);

    try {
      let imported = 0;
      let skipped = 0;
      let failed = 0;

      // 1) De-dupe within the file by normalized phone (keep first).
      const { unique, duplicates: inFileDupes } = dedupeByPhone(parsedRows);
      skipped += inFileDupes;

      // 2) Resolve tag names -> ids (admin+ may auto-create missing tags).
      //    Skip the round-trip when the import carries no tag names.
      //    Unlike the Supabase-era flow, there is no bulk "existing
      //    phone_normalized" pre-check query to skip obvious dupes before
      //    inserting — `contacts.create` already dedupes per row
      //    server-side (`by_account_phone`), so every unique row is
      //    attempted and a `DUPLICATE_PHONE` error is counted as skipped.
      const allTagNames = unique.flatMap((row) => row.tagNames);
      let tagIdByKey = new Map<string, Id<'tags'>>();
      let skippedNames: string[] = [];
      if (allTagNames.length > 0) {
        ({ tagIdByKey, skippedNames } = await resolveTagIds({
          existingTags: tags.map((tag) => ({
            id: tag.id as Id<'tags'>,
            name: tag.name,
          })),
          tagNames: allTagNames,
          canCreateTags: canEditSettings,
          createTag: (args) => createTag(args),
        }));
      }

      const tagAssignments: ContactTagAssignment[] = [];

      // 3) Create contacts in small concurrent batches (Convex has no
      //    bulk-insert mutation; mutations are serialized server-side so
      //    concurrent calls are safe).
      for (let i = 0; i < unique.length; i += IMPORT_CONCURRENCY) {
        const chunk = unique.slice(i, i + IMPORT_CONCURRENCY);
        const results = await Promise.allSettled(
          chunk.map((row) =>
            createContact({
              phone: row.phone,
              name: row.name,
              email: row.email,
              company: row.company,
            }),
          ),
        );
        results.forEach((res, idx) => {
          const row = chunk[idx];
          if (res.status === 'fulfilled') {
            imported++;
            if (row.tagNames.length > 0) {
              tagAssignments.push({
                contactId: res.value,
                tagNames: row.tagNames,
              });
            }
          } else if (isConvexErrorCode(res.reason, 'DUPLICATE_PHONE')) {
            skipped++;
          } else {
            failed++;
          }
        });
      }

      // 4) Wire tags onto the contacts we just created. Failure here must
      //    not mask a successful contact import.
      let tagsAssigned = 0;
      try {
        tagsAssigned = await assignTagsToImportedContacts(
          tagAssignments,
          tagIdByKey,
          (args) => assignTag(args),
        );
      } catch {
        toast.warning(t('toastTagsWarning'));
      }

      setResult({ imported, skipped, failed, tagsAssigned });
      if (imported > 0) {
        toast.success(t('toastImported', { count: imported }));
        onImported();
      }
      if (tagsAssigned > 0) {
        toast.success(t('toastTagsAssigned', { count: tagsAssigned }));
      }
      if (skippedNames.length > 0) {
        const sample = skippedNames.slice(0, 3).join(', ');
        const more =
          skippedNames.length > 3 ? ` (+${skippedNames.length - 3} more)` : '';
        toast.info(t('toastTagsSkipped', { sample, more }));
      }
      if (skipped > 0) {
        toast.info(t('toastSkipped', { count: skipped }));
      }
      if (failed > 0) {
        toast.error(t('toastFailed', { count: failed }));
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : t('toastError');
      toast.error(message);
    } finally {
      setImporting(false);
    }
  }

  const preview = parsedRows.slice(0, PREVIEW_LIMIT);
  // Tags: OR — show when the CSV declares a column or preview rows carry
  // values, so an all-empty tags column still renders for validation.
  const previewHasTags =
    hasTagsColumn || preview.some((row) => row.tagNames.length > 0);
  // Company: AND — hide unless the CSV declares it and preview has data,
  // avoiding an all-dash column that wastes horizontal space.
  const previewHasCompany =
    hasCompanyColumn && preview.some((row) => row.company?.trim());

  const tagStats = useMemo(() => {
    const names = new Set<string>();
    let rowsWithTags = 0;
    for (const row of parsedRows) {
      if (row.tagNames.length === 0) continue;
      rowsWithTags++;
      for (const name of row.tagNames) names.add(name.trim().toLowerCase());
    }
    return { unique: names.size, rowsWithTags };
  }, [parsedRows]);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="flex max-h-[min(90vh,720px)] flex-col gap-0 overflow-hidden border-border/80 bg-popover p-0 text-popover-foreground sm:max-w-2xl">
        <div className="shrink-0 space-y-4 border-b border-border/80 px-6 pt-6 pb-5">
          <DialogHeader className="gap-1.5">
            <DialogTitle className="text-lg text-popover-foreground">
              {t('title')}
            </DialogTitle>
            <DialogDescription className="leading-relaxed text-muted-foreground"
              dangerouslySetInnerHTML={{
                __html: t.markup('desc', {
                  phoneCode: (chunks) => `<code class="rounded bg-muted px-1 py-0.5 text-[11px] text-muted-foreground">${chunks}</code>`,
                  nameCode: (chunks) => `<code class="rounded bg-muted px-1 py-0.5 text-[11px] text-muted-foreground">${chunks}</code>`,
                  emailCode: (chunks) => `<code class="rounded bg-muted px-1 py-0.5 text-[11px] text-muted-foreground">${chunks}</code>`,
                  companyCode: (chunks) => `<code class="rounded bg-muted px-1 py-0.5 text-[11px] text-muted-foreground">${chunks}</code>`,
                  tagsCode: (chunks) => `<code class="rounded bg-muted px-1 py-0.5 text-[11px] text-muted-foreground">${chunks}</code>`,
                })
              }}
            />
          </DialogHeader>

          <div
            role="button"
            tabIndex={0}
            onClick={() => fileInputRef.current?.click()}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ')
                fileInputRef.current?.click();
            }}
            className={cn(
              'group flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border border-dashed p-5 transition-all',
              file
                ? 'border-primary/35 bg-primary/[0.04]'
                : 'hover:border-primary/40 border-border/80 bg-background/40 hover:bg-background/70'
            )}
          >
            {file ? (
              <>
                <div className="bg-primary/15 ring-primary/25 flex size-10 items-center justify-center rounded-lg ring-1">
                  <FileText className="text-primary size-5" />
                </div>
                <p
                  className="max-w-full truncate px-2 text-sm font-medium text-popover-foreground"
                  title={file.name}
                >
                  {truncateFilename(file.name)}
                </p>
                <span className="rounded-full bg-muted px-2.5 py-0.5 text-[11px] font-medium text-muted-foreground">
                  {t('rowsReady', { count: parsedRows.length })}
                </span>
              </>
            ) : (
              <>
                <div className="flex size-10 items-center justify-center rounded-lg bg-muted/80 ring-1 ring-border/80 transition-colors group-hover:bg-muted">
                  <Upload className="size-5 text-muted-foreground group-hover:text-foreground" />
                </div>
                <p className="text-sm text-muted-foreground">
                  {t('uploadDropzone')}
                </p>
                <p className="text-[11px] text-muted-foreground">
                  {t('uploadHint')}
                </p>
              </>
            )}
          </div>

          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,text/csv"
            onChange={handleFileChange}
            className="hidden"
          />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
          {preview.length > 0 && !result && (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-[11px] font-semibold tracking-[0.14em] text-muted-foreground uppercase">
                  {t('preview', { count: preview.length })}
                </p>
                <div className="flex flex-wrap items-center gap-1.5">
                  {tagStats.rowsWithTags > 0 && (
                    <span className="inline-flex items-center gap-1 rounded-md bg-muted/90 px-2 py-0.5 text-[11px] text-muted-foreground">
                      <Tag className="text-primary/80 size-3" />
                      {t('previewTags', { tags: tagStats.unique, contacts: tagStats.rowsWithTags })}
                    </span>
                  )}
                </div>
              </div>

              <div className="overflow-hidden rounded-xl border border-border ring-1 ring-border/50">
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[32rem] text-xs">
                    <thead>
                      <tr className="border-b border-border bg-background/60">
                        <th className="px-3 py-2 text-left font-medium whitespace-nowrap text-muted-foreground">
                          {t('columns.phone')}
                        </th>
                        <th className="px-3 py-2 text-left font-medium whitespace-nowrap text-muted-foreground">
                          {t('columns.name')}
                        </th>
                        <th className="px-3 py-2 text-left font-medium whitespace-nowrap text-muted-foreground">
                          {t('columns.email')}
                        </th>
                        {previewHasCompany && (
                          <th className="px-3 py-2 text-left font-medium whitespace-nowrap text-muted-foreground">
                            {t('columns.company')}
                          </th>
                        )}
                        {previewHasTags && (
                          <th className="px-3 py-2 text-left font-medium whitespace-nowrap text-muted-foreground">
                            {t('columns.tags')}
                          </th>
                        )}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border/70">
                      {preview.map((row, i) => (
                        <tr
                          key={i}
                          className="bg-popover/40 transition-colors hover:bg-muted/30"
                        >
                          <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">
                            <PreviewCell
                              value={row.phone}
                              mono
                              maxWidth="max-w-[7.5rem]"
                            />
                          </td>
                          <td className="px-3 py-2 text-popover-foreground">
                            <PreviewCell
                              value={row.name || '—'}
                              maxWidth="max-w-[8.5rem]"
                            />
                          </td>
                          <td className="px-3 py-2 text-muted-foreground">
                            <PreviewCell
                              value={row.email || '—'}
                              maxWidth="max-w-[10rem]"
                            />
                          </td>
                          {previewHasCompany && (
                            <td className="px-3 py-2 text-muted-foreground">
                              <PreviewCell
                                value={row.company || '—'}
                                maxWidth="max-w-[7rem]"
                              />
                            </td>
                          )}
                          {previewHasTags && (
                            <td className="px-3 py-2 align-top">
                              <ImportPreviewTags
                                tagNames={row.tagNames}
                                tagColorByKey={tagColorByKey}
                              />
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {parsedRows.length > PREVIEW_LIMIT && (
                <p className="text-center text-[11px] text-muted-foreground">
                  {t('moreRows', { count: parsedRows.length - PREVIEW_LIMIT })}
                </p>
              )}
            </div>
          )}

          {result && (
            <div className="rounded-xl border border-border bg-background/50 p-4">
              <p className="text-sm font-medium text-popover-foreground">{t('importComplete')}</p>
              <div className="mt-3 flex flex-wrap gap-3">
                {result.imported > 0 && (
                  <div className="text-primary flex items-center gap-1.5 text-sm">
                    <CheckCircle className="size-4 shrink-0" />
                    {t('resultImported', { count: result.imported })}
                  </div>
                )}
                {result.tagsAssigned > 0 && (
                  <div className="flex items-center gap-1.5 text-sm text-cyan-400">
                    <CheckCircle className="size-4 shrink-0" />
                    {t('resultTags', { count: result.tagsAssigned })}
                  </div>
                )}
                {result.skipped > 0 && (
                  <div className="flex items-center gap-1.5 text-sm text-amber-400">
                    <AlertTriangle className="size-4 shrink-0" />
                    {t('resultSkipped', { count: result.skipped })}
                  </div>
                )}
                {result.failed > 0 && (
                  <div className="flex items-center gap-1.5 text-sm text-red-400">
                    <XCircle className="size-4 shrink-0" />
                    {t('resultFailed', { count: result.failed })}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        <DialogFooter className="mt-0 shrink-0 gap-2 border-t border-border/80 bg-background/50 px-6 py-4 sm:justify-end">
          <Button
            type="button"
            variant="outline"
            onClick={() => handleOpenChange(false)}
            className="border-border text-muted-foreground hover:bg-muted"
          >
            {result ? t('close') : t('cancel')}
          </Button>
          {!result && (
            <Button
              type="button"
              disabled={parsedRows.length === 0 || importing}
              onClick={handleImport}
              className="bg-primary hover:bg-primary/90 text-primary-foreground"
            >
              {importing && <Loader2 className="size-4 animate-spin" />}
              {parsedRows.length > 0 ? t('importBtn', { count: parsedRows.length }) : t('importBtn', { count: 0 })}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
