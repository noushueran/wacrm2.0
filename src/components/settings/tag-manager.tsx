'use client';

import { Tag as TagIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { TagGroupsManager } from './tag-groups-manager';

/**
 * Tags card — colour-coded contact labels, organised into supervisor-
 * defined groups (Product, Destination, Priority, …). The grouped
 * create/delete UI lives in `TagGroupsManager`; this component keeps
 * only the card shell and title strings.
 */
export function TagManager() {
  const t = useTranslations('Settings.tagsAndFields');

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-foreground">
          <TagIcon className="size-4 text-primary" />
          {t('tagsTitle')}
        </CardTitle>
        <CardDescription className="text-muted-foreground">
          {t('tagsDesc')}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <TagGroupsManager />
      </CardContent>
    </Card>
  );
}
