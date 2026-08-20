'use client';

import { useCallback, useState, useSyncExternalStore } from 'react';
import { useMutation } from 'convex/react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { useQuery } from '@/lib/convex/cached';
import { useAuth } from '@/hooks/use-auth';
import { BOARD_ROLES, pageAccessGate } from '@/lib/auth/page-access';
import {
  LeadsBoardView,
  type LeadRow,
  type LeadsFilters,
  type LeadsView,
} from '@/components/leads/leads-board-view';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { useKeptResult } from '@/hooks/use-kept-result';
import type { StageChangeExtras } from '@/components/leads/leads-pipeline-view';
import type { PipelineStageKey } from '@/lib/leads/pipeline';
import { convexErrorData } from '@/lib/convex/adapters';

import { api } from '../../../../convex/_generated/api';
import type { Id } from '../../../../convex/_generated/dataModel';

// ============================================================
// /leads — thin data wrapper over LeadsBoardView (the presentational
// board, kept separate so it can be rendered with mock data for visual
// verification). RBAC: agents see only their own assigned leads (the
// query filters server-side), supervisor+ the full board; viewers have
// no lead queue. This wrapper owns the real mutations (checklist items,
// pipeline stage moves) and the List | Pipeline view preference.
// ============================================================

const PAGE_SIZE = 25;

const EMPTY_FILTERS: LeadsFilters = { status: 'all', service: 'all', search: '' };

const VIEW_STORAGE_KEY = 'leads-view';
const VIEW_CHANGE_EVENT = 'wacrm:leads-view';

// The saved view preference as an external store (the lint-endorsed shape
// for localStorage-backed state): `storage` covers other tabs, the custom
// event covers this one, and the server snapshot pins SSR to 'list'.
function subscribeToViewStore(onStoreChange: () => void) {
  window.addEventListener('storage', onStoreChange);
  window.addEventListener(VIEW_CHANGE_EVENT, onStoreChange);
  return () => {
    window.removeEventListener('storage', onStoreChange);
    window.removeEventListener(VIEW_CHANGE_EVENT, onStoreChange);
  };
}

// In-memory fallback so the toggle still works when localStorage throws
// (private-browsing / sandboxed contexts).
let memoryView: LeadsView | null = null;

function readViewSnapshot(): LeadsView {
  try {
    const stored = localStorage.getItem(VIEW_STORAGE_KEY);
    if (stored === 'pipeline' || stored === 'list') return stored;
  } catch {
    // fall through to the in-memory value
  }
  return memoryView ?? 'list';
}

export default function LeadsPage() {
  const t = useTranslations('Leads');
  const tFunnel = useTranslations('Inbox.funnel');
  const { accountRole, loading: authLoading, profileLoading } = useAuth();
  // Three states, not one boolean — see `@/lib/auth/page-access`. Without
  // the split a viewer waited on "Loading leads…" forever: the board
  // query below is skipped for them, so `board` never arrives and the
  // only early return there could never be reached.
  const gate = pageAccessGate({ authLoading, profileLoading, accountRole }, BOARD_ROLES);
  const canView = gate === 'ready';
  const canEdit = canView; // viewers never reach the board query at all
  // Manual purchase signals move ad spend — supervisor+ only (matches
  // the server's requireRole("supervisor") on sendPurchaseSignal).
  const canSendPurchase =
    accountRole === 'supervisor' || accountRole === 'admin' || accountRole === 'owner';
  const view = useSyncExternalStore(
    subscribeToViewStore,
    readViewSnapshot,
    (): LeadsView => 'list',
  );

  const [filters, setFilters] = useState<LeadsFilters>(EMPTY_FILTERS);
  const [page, setPage] = useState(0);
  // The input stays instant; only the query waits, so typing doesn't open
  // a Convex subscription per keystroke.
  const search = useDebouncedValue(filters.search.trim(), 300);

  // ONLY the list view pages. The Pipeline view is a kanban that groups
  // every lead into stage columns and `dashboard/leads-pipeline-card.tsx`
  // does the same — handing either one a 25-row page would quietly empty
  // most of the columns, so pipeline keeps asking for the whole board
  // exactly as it did before.
  const listView = view === 'list';

  const result = useQuery(
    api.qualification.leadsBoard,
    canView
      ? listView
        ? {
            page,
            pageSize: PAGE_SIZE,
            // Omitted rather than sent as 'all' — an absent arg is what
            // means "no filter" server-side.
            ...(filters.status !== 'all' ? { status: filters.status } : {}),
            ...(filters.service !== 'all' ? { service: filters.service } : {}),
            ...(search ? { search } : {}),
          }
        : {}
      : 'skip',
  );
  // Keep the current page on screen while the next one loads, so a page
  // turn doesn't flash the whole board away and back.
  const { data: board, loading } = useKeptResult(result);

  // A filter change invalidates the page number — page 4 of the
  // unfiltered board is not page 4 of the filtered one. Reset in the
  // handler so the new filter and `page: 0` reach the query together.
  const handleFiltersChange = useCallback((next: LeadsFilters) => {
    setFilters(next);
    setPage(0);
  }, []);

  const handleViewChange = useCallback((next: LeadsView) => {
    memoryView = next;
    setPage(0);
    try {
      localStorage.setItem(VIEW_STORAGE_KEY, next);
    } catch {
      // best-effort persistence — the in-memory fallback still flips it
    }
    window.dispatchEvent(new Event(VIEW_CHANGE_EVENT));
  }, []);

  const setItemDone = useMutation(api.salesChecklists.setItemDone);
  const reopenItem = useMutation(api.salesChecklists.reopenItem);
  const setStage = useMutation(api.funnel.setStage);
  const sendPurchaseSignal = useMutation(api.qualification.sendPurchaseSignal);

  const handleSendPurchaseSignal = useCallback(
    async (lead: LeadRow) => {
      try {
        await sendPurchaseSignal({
          sessionId: lead.sessionId as Id<'qualificationSessions'>,
        });
        toast.success(t('purchase.sentToast'));
      } catch (err) {
        console.error('Failed to send the purchase signal:', err);
        const reason = convexErrorData(err)?.reason;
        toast.error(
          reason === 'not_attributed'
            ? t('purchase.notAttributed')
            : reason === 'already_sent'
              ? t('purchase.alreadySent')
              : t('purchase.error'),
        );
      }
    },
    [sendPurchaseSignal, t],
  );

  const handleCompleteItem = useCallback(
    async (lead: LeadRow, itemKey: string, note: string) => {
      if (!lead.checklist) return;
      try {
        await setItemDone({
          checklistId: lead.checklist.checklistId as Id<'salesChecklists'>,
          itemKey,
          note,
        });
      } catch (err) {
        console.error('Failed to complete checklist item:', err);
        const reason = convexErrorData(err)?.reason;
        toast.error(
          reason === 'note_required' ? t('checklist.noteRequired') : t('checklist.updateError'),
        );
      }
    },
    [setItemDone, t],
  );

  const handleReopenItem = useCallback(
    async (lead: LeadRow, itemKey: string) => {
      if (!lead.checklist) return;
      try {
        await reopenItem({
          checklistId: lead.checklist.checklistId as Id<'salesChecklists'>,
          itemKey,
        });
      } catch (err) {
        console.error('Failed to reopen checklist item:', err);
        toast.error(t('checklist.updateError'));
      }
    },
    [reopenItem, t],
  );

  const handleStageChange = useCallback(
    async (lead: LeadRow, stage: PipelineStageKey, extras?: StageChangeExtras) => {
      try {
        await setStage({
          conversationId: lead.conversationId as Id<'conversations'>,
          stage,
          ...(extras?.saleValue !== undefined ? { saleValue: extras.saleValue } : {}),
          ...(extras?.lossCategory ? { lossCategory: extras.lossCategory } : {}),
          ...(extras?.lossDetail ? { lossDetail: extras.lossDetail } : {}),
        });
        return true;
      } catch (err) {
        console.error('Failed to move the deal:', err);
        const reason = convexErrorData(err)?.reason;
        toast.error(
          reason === 'checklist_incomplete'
            ? tFunnel('checklistIncomplete')
            : tFunnel('updateError'),
        );
        return false;
      }
    },
    [setStage, tFunnel],
  );

  // Identity still resolving — the board query has not been issued yet.
  if (gate === 'loading') {
    return <p className="mt-8 text-sm text-muted-foreground">{t('loading')}</p>;
  }
  if (gate === 'no_access') {
    return <p className="mt-8 text-sm text-muted-foreground">{t('noAccess')}</p>;
  }
  if (!board) {
    return <p className="mt-8 text-sm text-muted-foreground">{t('loading')}</p>;
  }
  return (
    <LeadsBoardView
      board={board}
      view={view}
      onViewChange={handleViewChange}
      canEdit={canEdit}
      canSendPurchase={canSendPurchase}
      onCompleteItem={handleCompleteItem}
      onReopenItem={handleReopenItem}
      onSendPurchaseSignal={handleSendPurchaseSignal}
      onStageChange={handleStageChange}
      filters={filters}
      onFiltersChange={handleFiltersChange}
      pageSize={PAGE_SIZE}
      onPageChange={setPage}
      busy={loading}
    />
  );
}
