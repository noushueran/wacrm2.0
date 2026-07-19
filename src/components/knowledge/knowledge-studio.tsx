'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery } from '@/lib/convex/cached';
import { useAuth } from '@/hooks/use-auth';
import { canEditSettings } from '@/lib/auth/roles';
import { LegacyDocuments } from './legacy-documents';
import { ServiceMatrix } from './service-matrix';
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
  // it. Task 4 wires the setter to the matrix's onSelectService; the value
  // itself is read starting Task 6/7's detail view — remove this disable
  // once that lands and actually reads `selectedService`.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- see comment above
  const [selectedService, setSelectedService] = useState<string | null>(null);
  // Task 5 supplies the actual create-service dialog/form; this shell only
  // owns the open/closed flag so the matrix's "Add service" affordance has
  // somewhere to write to in the meantime. The setter is wired below; the
  // value itself is read once Task 5's dialog renders — remove this
  // disable then.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- see comment above
  const [createServiceOpen, setCreateServiceOpen] = useState(false);

  const overview = useQuery(api.knowledge.studioOverview, isAdmin ? {} : 'skip');
  const config = useQuery(api.aiConfig.get, isAdmin ? {} : 'skip');

  if (!isAdmin) return null;

  return (
    <div>
      <h2 className="text-lg font-semibold text-foreground">{t('title')}</h2>
      <p className="mt-1 text-sm text-muted-foreground">{t('subtitle')}</p>

      {/* Tasks 6-7 render the selected-service detail view here. */}
      {overview === undefined ? (
        <div className="mt-6 h-24 animate-pulse rounded-md bg-muted" />
      ) : (
        <ServiceMatrix
          services={overview.services}
          onSelectService={setSelectedService}
          onCreateService={() => setCreateServiceOpen(true)}
        />
      )}

      <LegacyDocuments
        canEdit={isAdmin}
        hasEmbeddingsKey={config?.hasEmbeddingsKey ?? false}
      />
    </div>
  );
}
