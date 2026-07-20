'use client';

import { useMutation } from 'convex/react';
import { useQuery } from '@/lib/convex/cached';
import type { OpsKind } from '../../../convex/lib/kb/types';
import { api } from '../../../convex/_generated/api';
import type { Doc } from '../../../convex/_generated/dataModel';
import type { ChecklistRow } from './checklist-editor';

// ============================================================
// useOpsBlocks — the Task 7 counterpart of knowledge-studio.tsx's own
// inline entries wiring (saveEntry/publishEntry/unpublishEntry/
// removeEntry), pulled into its own hook rather than added inline.
// knowledge-studio.tsx was already 246 lines with 4 queries and 6
// mutations before this task; this is 3 more of each plus a
// criteria/steps/conditions ↔ ChecklistRow[] mapping in both
// directions, which would have made `opsSlot`'s callback the least
// scannable part of an already-dense render function. Everything here
// is Convex-coupled wiring with no independent logic worth unit
// testing on its own (same reasoning that leaves knowledge-studio.tsx
// itself untested — service-detail.test.ts and this folder's other
// `.test.ts` files cover the pure pieces instead).
//
// Hooks note: `ServiceDetail`'s `opsSlot` render prop is invoked once
// per kind (three times) during render, and React hooks cannot be
// called conditionally or in a loop body. The three `useQuery` calls
// below run unconditionally — each individually skip-guarded — so
// `blockFor` can do is a synchronous lookup, not a hook call.
// `KnowledgeStudio` must likewise call `useOpsBlocks` itself
// unconditionally (never inside `opsSlot`) to keep that contract
// intact one level up.
// ============================================================

export type OpsBlockData = {
  status: 'draft' | 'published' | 'absent';
  rows: ChecklistRow[];
  reportValue?: number;
  currency?: string;
};

function rowsFromDoc(kind: OpsKind, doc: Doc<'kbOpsBlocks'>): ChecklistRow[] {
  if (kind === 'qualification') return doc.criteria ?? [];
  if (kind === 'sales') return doc.steps ?? [];
  return doc.conditions ?? [];
}

export function useOpsBlocks(isAdmin: boolean, selectedService: string | null) {
  const qualification = useQuery(
    api.kbOps.get,
    isAdmin && selectedService ? { serviceKey: selectedService, kind: 'qualification' } : 'skip',
  );
  const sales = useQuery(
    api.kbOps.get,
    isAdmin && selectedService ? { serviceKey: selectedService, kind: 'sales' } : 'skip',
  );
  const purchase = useQuery(
    api.kbOps.get,
    isAdmin && selectedService ? { serviceKey: selectedService, kind: 'purchase' } : 'skip',
  );

  const save = useMutation(api.kbOps.save);
  const publish = useMutation(api.kbOps.publish);
  const unpublish = useMutation(api.kbOps.unpublish);

  /** The fetched block for `kind`, or `undefined` while its query is
   *  still loading — `ChecklistEditor` has no "loading" status of its
   *  own, so the caller is expected to hold off mounting it until this
   *  resolves (a `null` row and status `'absent'` are for "no ops block
   *  saved yet", a real, renderable state). */
  function blockFor(kind: OpsKind): OpsBlockData | undefined {
    const doc = kind === 'qualification' ? qualification : kind === 'sales' ? sales : purchase;
    if (doc === undefined) return undefined;
    if (doc === null) return { status: 'absent', rows: [] };
    return {
      status: doc.status,
      rows: rowsFromDoc(kind, doc),
      reportValue: doc.reportValue,
      currency: doc.currency,
    };
  }

  // `selectedService` is guaranteed non-null by the time any of these
  // are actually invoked: they're only reachable through a
  // `ChecklistEditor` instance, which `opsSlot` only renders once
  // `blockFor` above has resolved data for a selected service. The
  // throw is a defensive backstop, not an expected path.
  function requireServiceKey(): string {
    if (!selectedService) throw new Error('useOpsBlocks: no service selected');
    return selectedService;
  }

  function onSave(kind: OpsKind) {
    return async (values: {
      rows: ChecklistRow[]; reportValue?: number; currency?: string;
    }): Promise<void> => {
      const serviceKey = requireServiceKey();
      await save({
        serviceKey,
        kind,
        criteria: kind === 'qualification'
          ? values.rows.map((r) => (
              { key: r.key, label: r.label, question: r.question, marks: r.marks }
            ))
          : undefined,
        steps: kind === 'sales'
          ? values.rows.map((r) => ({ key: r.key, label: r.label, description: r.description }))
          : undefined,
        conditions: kind === 'purchase'
          ? values.rows.map((r) => ({ key: r.key, label: r.label }))
          : undefined,
        reportValue: values.reportValue,
        currency: values.currency,
      });
    };
  }

  function onPublish(kind: OpsKind) {
    return async (): Promise<void> => {
      await publish({ serviceKey: requireServiceKey(), kind });
    };
  }

  function onUnpublish(kind: OpsKind) {
    return async (): Promise<void> => {
      await unpublish({ serviceKey: requireServiceKey(), kind });
    };
  }

  return { blockFor, onSave, onPublish, onUnpublish };
}
