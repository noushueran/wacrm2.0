'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQuery } from 'convex/react';
import { Check, Plus } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { toUiTag, toUiTagGroup } from '@/lib/convex/adapters';
import { groupTags } from '@/lib/inbox/labels';
import {
  Popover, PopoverContent, PopoverTrigger,
} from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import type { Tag } from '@/types';
import { api } from '../../../convex/_generated/api';
import type { Id } from '../../../convex/_generated/dataModel';

export function LabelPicker({
  contactId, tags: assigned,
}: {
  contactId: string;
  tags: Tag[];
}) {
  const t = useTranslations('Inbox.labels');
  const groupsRes = useQuery(api.tagGroups.list);
  const tagsRes = useQuery(api.tags.list);
  const groups = useMemo(() => (groupsRes ?? []).map(toUiTagGroup), [groupsRes]);
  const allTags = useMemo(() => (tagsRes ?? []).map(toUiTag), [tagsRes]);
  const dimensions = useMemo(() => groupTags(groups, allTags), [groups, allTags]);
  const selectedIds = useMemo(() => new Set(assigned.map((x) => x.id)), [assigned]);

  const assignTag = useMutation(api.contacts.assignTag);
  const unassignTag = useMutation(api.contacts.unassignTag);
  const [open, setOpen] = useState(false);

  async function toggle(tag: Tag) {
    const isOn = selectedIds.has(tag.id);
    try {
      if (isOn) {
        await unassignTag({ contactId: contactId as Id<'contacts'>, tagId: tag.id as Id<'tags'> });
      } else {
        await assignTag({ contactId: contactId as Id<'contacts'>, tagId: tag.id as Id<'tags'> });
      }
    } catch {
      toast.error(t('failed'));
    }
  }

  return (
    <div className="mt-2 flex flex-wrap items-center gap-1">
      {assigned.length === 0 && (
        <span className="px-1 text-xs text-muted-foreground">{t('none')}</span>
      )}
      {assigned.map((tag) => (
        <button
          key={tag.id}
          type="button"
          onClick={() => toggle(tag)}
          className="rounded-full px-2 py-0.5 text-[10px] font-medium"
          style={{ backgroundColor: `${tag.color}20`, color: tag.color }}
          title={tag.name}
        >
          {tag.name} ×
        </button>
      ))}

      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          className="inline-flex items-center gap-0.5 rounded-full border border-dashed border-border px-2 py-0.5 text-[10px] text-muted-foreground hover:text-foreground"
        >
          <Plus className="size-3" /> {t('add')}
        </PopoverTrigger>
        <PopoverContent align="start" className="w-56 p-2">
          <div className="max-h-72 space-y-3 overflow-y-auto">
            {dimensions.map(({ group, tags: groupTagsList }) => (
              <div key={group?.id ?? 'ungrouped'}>
                <p className="mb-1 px-1 text-[10px] uppercase text-muted-foreground">
                  {group ? group.name : t('ungrouped')}
                </p>
                <div className="flex flex-col">
                  {groupTagsList.map((tag) => {
                    const on = selectedIds.has(tag.id);
                    return (
                      <button
                        key={tag.id}
                        type="button"
                        onClick={() => toggle(tag)}
                        className={cn(
                          'flex items-center justify-between rounded px-2 py-1 text-sm hover:bg-muted',
                          on ? 'text-foreground' : 'text-muted-foreground',
                        )}
                      >
                        <span className="flex items-center gap-1.5">
                          <span className="size-2 rounded-full" style={{ backgroundColor: tag.color }} />
                          {tag.name}
                        </span>
                        {on && <Check className="size-3.5 text-primary" />}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
