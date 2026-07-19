'use client';

import { useCallback, useSyncExternalStore } from 'react';
import { useMutation } from 'convex/react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { useQuery } from '@/lib/convex/cached';
import { useAuth } from '@/hooks/use-auth';
import {
  LeadsBoardView,
  type LeadRow,
  type LeadsView,
} from '@/components/leads/leads-board-view';
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
  const { accountRole } = useAuth();
  const canView =
    accountRole === 'agent' ||
    accountRole === 'supervisor' ||
    accountRole === 'admin' ||
    accountRole === 'owner';
  const canEdit = canView; // viewers never reach the board query at all
  // Manual purchase signals move ad spend — supervisor+ only (matches
  // the server's requireRole("supervisor") on sendPurchaseSignal).
  const canSendPurchase =
    accountRole === 'supervisor' || accountRole === 'admin' || accountRole === 'owner';
  const board = useQuery(api.qualification.leadsBoard, canView ? {} : 'skip');

  const view = useSyncExternalStore(
    subscribeToViewStore,
    readViewSnapshot,
    (): LeadsView => 'list',
  );
  const handleViewChange = useCallback((next: LeadsView) => {
    memoryView = next;
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
    />
  );
}
