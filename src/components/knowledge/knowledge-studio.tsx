'use client';

import { useState } from 'react';
import { useMutation } from 'convex/react';
import { useTranslations } from 'next-intl';
import { useQuery } from '@/lib/convex/cached';
import { useAuth } from '@/hooks/use-auth';
import { canEditSettings } from '@/lib/auth/roles';
import { LegacyDocuments } from './legacy-documents';
import { ServiceForm } from './service-form';
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
  // it. Task 6/7's detail view re-introduces the read of this value.
  const [, setSelectedService] = useState<string | null>(null);
  // Controls the create-service dialog rendered below. Owned here (not
  // in service-form.tsx) because that component stays Convex-free —
  // this shell owns the `useMutation` call and just toggles the dialog.
  const [createServiceOpen, setCreateServiceOpen] = useState(false);

  const overview = useQuery(api.knowledge.studioOverview, isAdmin ? {} : 'skip');
  const config = useQuery(api.aiConfig.get, isAdmin ? {} : 'skip');
  const upsertService = useMutation(api.kbServices.upsert);

  if (!isAdmin) return null;

  return (
    <div>
      <h2 className="text-lg font-semibold text-foreground">{t('title')}</h2>
      <p className="mt-1 text-sm text-muted-foreground">{t('subtitle')}</p>

      {/* Tasks 6-7 render the selected-service detail view here. */}
      {overview === undefined ? (
        <div className="mt-6 h-24 animate-pulse rounded-md bg-muted" />
      ) : (
        <>
          <ServiceMatrix
            services={overview.services}
            onSelectService={setSelectedService}
            onCreateService={() => setCreateServiceOpen(true)}
          />
          <ServiceForm
            open={createServiceOpen}
            existingKeys={overview.services.map((s) => s.key)}
            onClose={() => setCreateServiceOpen(false)}
            onSubmit={async (values) => {
              await upsertService(values);
              setCreateServiceOpen(false);
            }}
          />
        </>
      )}

      <LegacyDocuments
        canEdit={isAdmin}
        hasEmbeddingsKey={config?.hasEmbeddingsKey ?? false}
      />
    </div>
  );
}
