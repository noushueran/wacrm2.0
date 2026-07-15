'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQuery } from 'convex/react';
import { toast } from 'sonner';
import { Loader2, Plus, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toUiTag, toUiTagGroup } from '@/lib/convex/adapters';
import { groupTags } from '@/lib/inbox/labels';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { api } from '../../../convex/_generated/api';
import type { Id } from '../../../convex/_generated/dataModel';

const PRESET_COLORS = [
  '#ef4444', '#f97316', '#f59e0b', '#10b981',
  '#06b6d4', '#3b82f6', '#8b5cf6', '#ec4899',
];

export function TagGroupsManager() {
  const t = useTranslations('Settings.tagGroups');
  const groupsRes = useQuery(api.tagGroups.list);
  const tagsRes = useQuery(api.tags.list);
  const groups = useMemo(() => (groupsRes ?? []).map(toUiTagGroup), [groupsRes]);
  const tags = useMemo(() => (tagsRes ?? []).map(toUiTag), [tagsRes]);
  const dimensions = useMemo(() => groupTags(groups, tags), [groups, tags]);
  const loading = groupsRes === undefined || tagsRes === undefined;

  const createGroup = useMutation(api.tagGroups.create);
  const removeGroup = useMutation(api.tagGroups.remove);
  const createTag = useMutation(api.tags.create);
  const removeTag = useMutation(api.tags.remove);

  const [groupName, setGroupName] = useState('');
  const [mode, setMode] = useState<'single' | 'multi'>('multi');
  const [busy, setBusy] = useState(false);

  async function addGroup() {
    if (!groupName.trim()) return toast.error(t('nameRequired'));
    setBusy(true);
    try {
      await createGroup({ name: groupName.trim(), selectionMode: mode });
      setGroupName('');
      toast.success(t('created'));
    } catch {
      toast.error(t('failed'));
    } finally {
      setBusy(false);
    }
  }

  async function deleteGroup(id: string, name: string) {
    if (!window.confirm(t('deleteGroupConfirm', { name }))) return;
    try {
      await removeGroup({ groupId: id as Id<'tagGroups'> });
      toast.success(t('deleted'));
    } catch {
      toast.error(t('failed'));
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="size-6 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {dimensions.map(({ group, tags: groupTagsList }) => (
        <div key={group?.id ?? 'ungrouped'} className="rounded-lg border border-border p-3">
          <div className="mb-2 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-foreground">
                {group ? group.name : t('ungrouped')}
              </span>
              {group && (
                <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">
                  {group.selection_mode === 'single' ? t('single') : t('multi')}
                </span>
              )}
            </div>
            {group && (
              <Button
                variant="ghost" size="icon-sm"
                onClick={() => deleteGroup(group.id, group.name)}
                title={t('deleteGroup')}
                className="text-muted-foreground hover:text-red-400"
              >
                <Trash2 className="size-4" />
              </Button>
            )}
          </div>

          <div className="flex flex-wrap gap-2">
            {groupTagsList.map((tag) => (
              <span
                key={tag.id}
                className="group inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-medium"
                style={{ backgroundColor: `${tag.color}20`, color: tag.color, border: `1px solid ${tag.color}40` }}
              >
                {tag.name}
                <button
                  type="button"
                  onClick={async () => {
                    if (!window.confirm(t('deleteTagConfirm', { name: tag.name }))) return;
                    try { await removeTag({ tagId: tag.id as Id<'tags'> }); }
                    catch { toast.error(t('failed')); }
                  }}
                  aria-label={t('deleteTag')}
                  className="ml-0.5 rounded-full p-0.5 opacity-60 hover:opacity-100"
                >
                  ×
                </button>
              </span>
            ))}
            {group && (
              <AddTagInline
                colorPool={PRESET_COLORS}
                placeholder={t('tagName')}
                addLabel={t('addTag')}
                onAdd={(name, color) =>
                  createTag({ name, color, groupId: group.id as Id<'tagGroups'> })
                }
              />
            )}
          </div>
        </div>
      ))}

      {/* New group row */}
      <div className="flex flex-wrap items-center gap-2 border-t border-border pt-4">
        <Input
          value={groupName}
          onChange={(e) => setGroupName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') addGroup(); }}
          placeholder={t('newGroupName')}
          className="min-w-[180px] flex-1"
          maxLength={40}
        />
        <div className="flex overflow-hidden rounded-md border border-border text-xs">
          {(['multi', 'single'] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={cn('px-2.5 py-1.5', mode === m ? 'bg-primary text-primary-foreground' : 'text-muted-foreground')}
            >
              {m === 'single' ? t('single') : t('multi')}
            </button>
          ))}
        </div>
        <Button variant="outline" size="sm" onClick={addGroup} disabled={busy || !groupName.trim()}>
          {busy ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
          {t('addGroup')}
        </Button>
      </div>
    </div>
  );
}

/** Inline "add a tag to this group" control: name + colour swatch + add. */
function AddTagInline({
  colorPool, placeholder, addLabel, onAdd,
}: {
  colorPool: string[];
  placeholder: string;
  addLabel: string;
  onAdd: (name: string, color: string) => Promise<unknown>;
}) {
  const [name, setName] = useState('');
  const [color, setColor] = useState(colorPool[3]);
  const [busy, setBusy] = useState(false);
  async function submit() {
    if (!name.trim()) return;
    setBusy(true);
    try { await onAdd(name.trim(), color); setName(''); }
    finally { setBusy(false); }
  }
  return (
    <span className="inline-flex items-center gap-1.5">
      <Input
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
        placeholder={placeholder}
        className="h-7 w-28 text-xs"
        maxLength={30}
      />
      <button
        type="button"
        aria-label="tag colour"
        onClick={() => setColor(colorPool[(colorPool.indexOf(color) + 1) % colorPool.length])}
        className="size-5 rounded"
        style={{ backgroundColor: color }}
      />
      <Button variant="ghost" size="icon-sm" onClick={submit} disabled={busy} title={addLabel}>
        {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
      </Button>
    </span>
  );
}
