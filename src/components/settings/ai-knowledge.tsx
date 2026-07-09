'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQuery } from 'convex/react';
import { toast } from 'sonner';
import { Loader2, Plus, Trash2, BookOpen } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';
import { useTranslations } from 'next-intl';
import { toUiAiKnowledgeDoc } from '@/lib/convex/adapters';

import { api } from '../../../convex/_generated/api';
import type { Id } from '../../../convex/_generated/dataModel';

/**
 * RAG knowledge base CRUD (Phase 8, Task 3 / P8-T3). `list`/`create`/
 * `remove` are ALL admin-gated server-side (`convex/aiKnowledge.ts`'s
 * own doc comment: knowledge content shapes what the AI tells
 * customers, so it gets the same write-level trust as
 * `aiConfig.upsert`, not a plain-member read) — unlike the pre-Convex
 * REST route, there is no lesser "any member can view" tier. The list
 * query is therefore only ever called (via the `"skip"` sentinel, same
 * idiom as `contact-detail-view.tsx`'s `tags.list`/`customFields.list`)
 * when `canEdit` is true, and the parent (`ai-config.tsx`) only mounts
 * this card for admins+ in the first place.
 *
 * `create` schedules chunk+embed ingestion server-side
 * (`ctx.scheduler.runAfter(0, internal.aiKnowledge.ingest, ...)`) — this
 * component only ever submits title/content, never chunks or embeds
 * anything itself.
 *
 * No `update`/`reindex` mutation exists in Convex (only `list`/
 * `create`/`remove`, plus internal-only `ingest`/`retrieve` actions
 * meant for the scheduler and the auto-reply/draft paths), so the old
 * "Edit existing doc" and "Reindex all" affordances have no Convex
 * counterpart and are dropped here — editing a document today means
 * delete + re-add. A row's title can still be expanded into a read-only
 * content preview, sourced from `list`'s own result (which already
 * carries full `content`, not just `title` — no extra fetch needed, and
 * none is possible: `aiKnowledge.getDocument` is `internalQuery`-only).
 */
export function AiKnowledgeCard({
  canEdit,
  hasEmbeddingsKey,
}: {
  canEdit: boolean;
  hasEmbeddingsKey: boolean;
}) {
  const t = useTranslations('Settings.aiKnowledge');

  const docsResult = useQuery(api.aiKnowledge.list, canEdit ? {} : 'skip');
  const docs = useMemo(
    () => (docsResult ?? []).map(toUiAiKnowledgeDoc),
    [docsResult],
  );
  const loading = canEdit && docsResult === undefined;

  const createDoc = useMutation(api.aiKnowledge.create);
  const removeDoc = useMutation(api.aiKnowledge.remove);

  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);

  const openNew = () => {
    setCreating(true);
    setTitle('');
    setContent('');
  };

  const cancelCreate = () => {
    setCreating(false);
    setTitle('');
    setContent('');
  };

  const handleCreate = async () => {
    if (!title.trim() || !content.trim()) {
      toast.error(t('titleContentRequired'));
      return;
    }
    setSaving(true);
    try {
      await createDoc({ title: title.trim(), content: content.trim() });
      // A 200 with `warning` (degraded indexing) had no Convex-side
      // signal to surface even in the old REST route's success path —
      // `create` schedules `ingest` fire-and-forget, so this mutation
      // resolving just means the document row itself was written.
      toast.success(t('saveSuccessNew'));
      cancelCreate();
      // No manual list refresh needed — `docsResult` above is a
      // reactive `useQuery`, same as `tag-manager.tsx`'s list.
    } catch (err) {
      console.error('[AiKnowledgeCard] create error:', err);
      toast.error(t('saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const handleRemove = async (id: string) => {
    setRemovingId(id);
    try {
      await removeDoc({ documentId: id as Id<'aiKnowledgeDocuments'> });
      toast.success(t('removeSuccess'));
      setExpandedId((cur) => (cur === id ? null : cur));
    } catch (err) {
      console.error('[AiKnowledgeCard] remove error:', err);
      toast.error(t('removeFailed'));
    } finally {
      setRemovingId(null);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <BookOpen className="h-4 w-4 text-primary" /> {t('title')}
        </CardTitle>
        <CardDescription>
          {t('description', {
            searchType: hasEmbeddingsKey ? t('semanticSearchOn') : t('keywordSearchOn')
          })}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          <div className="flex items-center py-4 text-sm text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> {t('loading')}
          </div>
        ) : (
          <>
            {docs.length === 0 && !creating && (
              <p className="text-sm text-muted-foreground">
                {t('noDocs')}
              </p>
            )}

            {docs.length > 0 && (
              <ul className="divide-y divide-border rounded-md border border-border">
                {docs.map((doc) => (
                  <li
                    key={doc.id}
                    className="flex flex-col gap-2 px-3 py-2"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <button
                        type="button"
                        onClick={() =>
                          setExpandedId((cur) => (cur === doc.id ? null : doc.id))
                        }
                        className="min-w-0 flex-1 truncate text-left text-sm text-foreground hover:underline"
                      >
                        {doc.title}
                      </button>
                      {canEdit && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 w-8 shrink-0 p-0 text-destructive hover:text-destructive"
                          onClick={() => void handleRemove(doc.id)}
                          disabled={removingId === doc.id}
                          title="Delete"
                        >
                          {removingId === doc.id ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <Trash2 className="h-4 w-4" />
                          )}
                        </Button>
                      )}
                    </div>
                    {expandedId === doc.id && (
                      <Textarea
                        readOnly
                        value={doc.content}
                        rows={6}
                        className="resize-none text-xs"
                      />
                    )}
                  </li>
                ))}
              </ul>
            )}

            {creating ? (
              <div className="space-y-3 rounded-md border border-border p-3">
                <div className="space-y-2">
                  <Label htmlFor="kb-title">{t('editDocTitle')}</Label>
                  <Input
                    id="kb-title"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder={t('editDocTitlePlaceholder')}
                    disabled={saving}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="kb-content">{t('editDocContent')}</Label>
                  <Textarea
                    id="kb-content"
                    value={content}
                    onChange={(e) => setContent(e.target.value)}
                    placeholder={t('editDocContentPlaceholder')}
                    rows={8}
                    disabled={saving}
                  />
                </div>
                <div className="flex justify-end gap-2">
                  <Button variant="ghost" onClick={cancelCreate} disabled={saving}>
                    {t('cancel')}
                  </Button>
                  <Button onClick={handleCreate} disabled={saving}>
                    {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    {t('saveDoc')}
                  </Button>
                </div>
              </div>
            ) : (
              canEdit && (
                <div className="flex items-center justify-between">
                  <Button variant="outline" size="sm" onClick={openNew}>
                    <Plus className="mr-2 h-4 w-4" /> {t('addDoc')}
                  </Button>
                </div>
              )
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
