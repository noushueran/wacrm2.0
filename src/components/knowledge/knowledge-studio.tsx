'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery } from '@/lib/convex/cached';
import { useAuth } from '@/hooks/use-auth';
import { canEditSettings } from '@/lib/auth/roles';
import { LegacyDocuments } from './legacy-documents';
import { api } from '../../../convex/_generated/api';

/**
 * Root of the Knowledge tab.
 *
 * Every query here is admin-only on the server. `accountRole` is null while
 * the profile loads, and this app has no error boundary — firing an
 * admin-gated query in that window throws during render and crashes the
 * page. Hence the `'skip'` guard rather than an optimistic call.
 */
export function KnowledgeStudio() {
  const t = useTranslations('Knowledge');
  const { accountRole } = useAuth();
  // `accountRole` is null while the profile loads, so this is false during
  // that window — which is exactly what keeps the admin-only queries below
  // from firing early and throwing in render.
  const isAdmin = accountRole ? canEditSettings(accountRole) : false;
  // Owned here (not in a later task's file) because Tasks 4-7 build the
  // matrix/detail toggle on top of this same shell rather than replacing
  // it. Unused until that UI lands.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- see comment above
  const [selectedService, setSelectedService] = useState<string | null>(null);

  const overview = useQuery(api.knowledge.studioOverview, isAdmin ? {} : 'skip');
  const config = useQuery(api.aiConfig.get, isAdmin ? {} : 'skip');

  if (!isAdmin) return null;

  return (
    <div>
      <h2 className="text-lg font-semibold text-foreground">{t('title')}</h2>
      <p className="mt-1 text-sm text-muted-foreground">{t('subtitle')}</p>

      {/* Tasks 4-7 render the matrix / detail here. */}
      {overview === undefined ? (
        <div className="mt-6 h-24 animate-pulse rounded-md bg-muted" />
      ) : (
        <p className="mt-6 text-sm text-muted-foreground">
          {overview.services.length} service(s)
        </p>
      )}

      <LegacyDocuments
        canEdit={isAdmin}
        hasEmbeddingsKey={config?.hasEmbeddingsKey ?? false}
      />
    </div>
  );
}
