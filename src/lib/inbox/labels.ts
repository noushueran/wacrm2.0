import type { Tag, TagGroup } from "@/types";

export type LabelDimension = { group: TagGroup | null; tags: Tag[] };

/** Organises an account's tags into ordered dimensions for the label
 *  picker: one per group (by `position`), with any ungrouped tags under a
 *  trailing `group: null` dimension (omitted when there are none). */
export function groupTags(groups: TagGroup[], tags: Tag[]): LabelDimension[] {
  const ordered = [...groups].sort((a, b) => a.position - b.position);
  const validIds = new Set(groups.map((g) => g.id));
  const byGroup = new Map<string, Tag[]>();
  const ungrouped: Tag[] = [];
  for (const tag of tags) {
    if (tag.group_id && validIds.has(tag.group_id)) {
      const list = byGroup.get(tag.group_id) ?? [];
      list.push(tag);
      byGroup.set(tag.group_id, list);
    } else {
      ungrouped.push(tag);
    }
  }
  const dims: LabelDimension[] = ordered.map((group) => ({
    group,
    tags: byGroup.get(group.id) ?? [],
  }));
  if (ungrouped.length > 0) dims.push({ group: null, tags: ungrouped });
  return dims;
}

export function isSelected(tag: Tag, selectedIds: Set<string>): boolean {
  return selectedIds.has(tag.id);
}

export type TagChipRow = { visible: Tag[]; overflow: number };

/** Flattens a contact's tags in group-position order (grouped first by each
 *  group's `position`, ungrouped last — same order as {@link groupTags}) and
 *  caps them at `limit`, returning the visible tags plus a `+N` overflow
 *  count. Used to render compact tag chips on inbox rows and the chat header,
 *  so the most important labels (earliest groups) survive the cut-off. */
export function tagChipRow(
  groups: TagGroup[],
  tags: Tag[],
  limit: number,
): TagChipRow {
  const ordered = groupTags(groups, tags).flatMap((d) => d.tags);
  const visible = ordered.slice(0, Math.max(0, limit));
  return { visible, overflow: ordered.length - visible.length };
}
