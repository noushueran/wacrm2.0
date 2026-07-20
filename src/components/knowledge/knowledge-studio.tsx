'use client';

import { useEffect, useState } from 'react';
import { useMutation } from 'convex/react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useQuery } from '@/lib/convex/cached';
import { useAuth } from '@/hooks/use-auth';
import { canEditSettings } from '@/lib/auth/roles';
import { LegacyDocuments } from './legacy-documents';
import { ServiceDetail, type EntryType } from './service-detail';
import { ServiceForm } from './service-form';
import { ServiceMatrix } from './service-matrix';
import { api } from '../../../convex/_generated/api';
import type { Id } from '../../../convex/_generated/dataModel';

/**
 * What the shared create/edit `ServiceForm` dialog is doing. One piece
 * of state (not two open booleans) so the same dialog instance serves
 * both the matrix's "Add service" button and the detail view's "Edit
 * service" button without two dialogs fighting over who's open.
 */
type ServiceFormState = { mode: 'closed' } | { mode: 'create' } | { mode: 'edit'; key: string };

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

  const searchParams = useSearchParams();
  // `?service=<key>` deep-link support, read once at mount — matches the
  // tab switcher's `?tab=` pattern in src/app/(dashboard)/agents/page.tsx.
  // Validated below once `overview` loads: a key that doesn't name a real
  // service falls back to the matrix instead of rendering an empty detail
  // view.
  const [selectedService, setSelectedService] = useState<string | null>(
    searchParams.get('service'),
  );
  // Controls the create/edit-service dialog rendered below. Owned here
  // (not in service-form.tsx) because that component stays Convex-free —
  // this shell owns the `useMutation` calls and just toggles the dialog.
  const [serviceFormState, setServiceFormState] = useState<ServiceFormState>({ mode: 'closed' });

  const overview = useQuery(api.knowledge.studioOverview, isAdmin ? {} : 'skip');
  const config = useQuery(api.aiConfig.get, isAdmin ? {} : 'skip');
  // Raw kbServices rows, for the edit-service dialog's `initial` only.
  // `studioOverview`'s rows are deliberately status/stats-only (see that
  // query's own doc comment) and don't carry every raw field — notably
  // not `routingTagName`. Without this, editing a service would silently
  // blanket-clear its routing tag on every save, since ServiceForm always
  // submits whatever `routingTagName` it was seeded with (trimmed to
  // `undefined` when empty) and `kbServices.upsert` patches that field
  // verbatim.
  const kbServicesList = useQuery(api.kbServices.list, isAdmin ? {} : 'skip');
  const entries = useQuery(
    api.kbEntries.list,
    isAdmin && selectedService ? { serviceKey: selectedService } : 'skip',
  );

  const upsertService = useMutation(api.kbServices.upsert);
  const removeService = useMutation(api.kbServices.remove);
  const saveEntry = useMutation(api.kbEntries.save);
  const publishEntry = useMutation(api.kbEntries.publish);
  const unpublishEntry = useMutation(api.kbEntries.unpublish);
  const removeEntry = useMutation(api.kbEntries.remove);

  // Shallow URL sync so the open service is deep-linkable/shareable, via
  // the native History API rather than a router method — same
  // `window.history.replaceState` pattern the tab switcher established
  // (src/app/(dashboard)/agents/page.tsx's `selectTab`) and the inbox's
  // chat selection uses too. Handles both selecting (key) and clearing
  // (null) so onBack/onSelectService/the not-found fallback below can all
  // share it.
  const selectService = (key: string | null) => {
    setSelectedService(key);
    const params = new URLSearchParams(window.location.search);
    if (key) params.set('service', key);
    else params.delete('service');
    const qs = params.toString();
    window.history.replaceState(
      null,
      '',
      qs ? `${window.location.pathname}?${qs}` : window.location.pathname,
    );
  };

  // `selectedService` (seeded from `?service=`, or set by a matrix
  // click / a since-deleted service — see the ServiceForm `onDelete`
  // wiring below) might no longer name a real service once `overview`
  // has loaded. Corrected as a render-time state adjustment — per
  // React's own guidance for "resetting state when a prop/input
  // changes" (https://react.dev/learn/you-might-not-need-an-effect)
  // and the identical `!decided && configDoc !== undefined` pattern in
  // src/app/(dashboard)/agents/page.tsx — rather than a `useEffect`
  // that calls `setState`: `overview` only becomes non-undefined once
  // (a query resolving), so this can only ever correct once, but a
  // conditional `setState` call reachable from an effect body still
  // trips `react-hooks/set-state-in-effect` regardless of the guard.
  const serviceIsStale =
    selectedService !== null &&
    overview !== undefined &&
    !overview.services.some((s) => s.key === selectedService);
  if (serviceIsStale) setSelectedService(null);

  // Keeping the URL in sync with that correction (clearing a stale
  // `?service=` so a refresh doesn't reintroduce it) touches
  // `window.history` — a real side effect, unlike the setState above, so
  // unlike that correction it does belong in an effect. No setState call
  // here, so `react-hooks/set-state-in-effect` has nothing to flag.
  //
  // It deliberately does NOT key off `serviceIsStale`: that flag is
  // computed and then corrected within the very same render (the
  // setState above), so by the time any render actually commits,
  // `selectedService` has already been reset to `null` and
  // `serviceIsStale` reads `false` again — an effect watching it would
  // never observe `true` and this cleanup would never run. Instead this
  // reads the `?service=` param and the known service keys straight off
  // `overview`, both values that are still what they were post-commit,
  // and only once `overview` has actually loaded — while it's still
  // `undefined` the known-keys list is empty, and clearing the param
  // then would strip a valid deep link that simply hasn't resolved yet.
  useEffect(() => {
    if (overview === undefined) return;
    const params = new URLSearchParams(window.location.search);
    const serviceParam = params.get('service');
    if (serviceParam === null) return;
    if (overview.services.some((s) => s.key === serviceParam)) return;
    params.delete('service');
    const qs = params.toString();
    window.history.replaceState(
      null,
      '',
      qs ? `${window.location.pathname}?${qs}` : window.location.pathname,
    );
  }, [overview]);

  if (!isAdmin) return null;

  const selectedServiceRow = overview?.services.find((s) => s.key === selectedService);
  const editServiceRow =
    serviceFormState.mode === 'edit'
      ? kbServicesList?.find((s) => s.key === serviceFormState.key)
      : undefined;

  return (
    <div>
      <h2 className="text-lg font-semibold text-foreground">{t('title')}</h2>
      <p className="mt-1 text-sm text-muted-foreground">{t('subtitle')}</p>

      {overview === undefined ? (
        <div className="mt-6 h-24 animate-pulse rounded-md bg-muted" />
      ) : (
        <>
          {selectedServiceRow ? (
            entries === undefined ? (
              <div className="mt-6 h-24 animate-pulse rounded-md bg-muted" />
            ) : (
              <ServiceDetail
                service={selectedServiceRow}
                entries={entries}
                onBack={() => selectService(null)}
                onEditService={() =>
                  setServiceFormState({ mode: 'edit', key: selectedServiceRow.key })
                }
                onSaveEntry={async (values) => {
                  await saveEntry({
                    entryId: values.entryId ? (values.entryId as Id<'kbEntries'>) : undefined,
                    scope: 'service',
                    serviceKey: selectedServiceRow.key,
                    type: values.type as EntryType,
                    title: values.title,
                    body: values.body,
                    audience: values.audience,
                  });
                }}
                // Convex mutations resolve `Promise<null>`; wrapped in an
                // async function with no return so these match the
                // `Promise<void>` callback props ServiceDetail declares.
                onPublishEntry={async (id) => {
                  await publishEntry({ entryId: id as Id<'kbEntries'> });
                }}
                onUnpublishEntry={async (id) => {
                  await unpublishEntry({ entryId: id as Id<'kbEntries'> });
                }}
                onRemoveEntry={async (id) => {
                  await removeEntry({ entryId: id as Id<'kbEntries'> });
                }}
                // Task 7 fills this in with the real checklist editors,
                // driven by queries it runs unconditionally at this
                // component's top level (hooks can't be called from
                // inside a render-prop callback) — this placeholder just
                // keeps the boundary exercised until then.
                opsSlot={() => (
                  <p className="text-sm text-muted-foreground">Checklist editor coming soon.</p>
                )}
              />
            )
          ) : (
            <ServiceMatrix
              services={overview.services}
              onSelectService={selectService}
              onCreateService={() => setServiceFormState({ mode: 'create' })}
            />
          )}

          <ServiceForm
            open={serviceFormState.mode !== 'closed'}
            initial={
              editServiceRow
                ? {
                    key: editServiceRow.key,
                    name: editServiceRow.name,
                    aliases: editServiceRow.aliases,
                    routingTagName: editServiceRow.routingTagName,
                    status: editServiceRow.status,
                    sortOrder: editServiceRow.sortOrder,
                  }
                : undefined
            }
            existingKeys={overview.services.map((s) => s.key)}
            onClose={() => setServiceFormState({ mode: 'closed' })}
            onSubmit={async (values) => {
              await upsertService(values);
              setServiceFormState({ mode: 'closed' });
            }}
            onDelete={
              serviceFormState.mode === 'edit'
                ? async () => {
                    const { key } = serviceFormState;
                    await removeService({ key });
                    setServiceFormState({ mode: 'closed' });
                    // Return to the matrix rather than leaving the admin
                    // staring at a detail view for a service that no
                    // longer exists.
                    selectService(null);
                  }
                : undefined
            }
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
