'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useMutation } from 'convex/react';
import type { FunctionReturnType } from 'convex/server';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { useQuery } from '@/lib/convex/cached';
import { useAuth } from '@/hooks/use-auth';
import { cn } from '@/lib/utils';
import { toUiConversation } from '@/lib/convex/adapters';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { useKeptResult } from '@/hooks/use-kept-result';
import { Pagination } from '@/components/ui/pagination';
import { MessageThread } from '@/components/inbox/message-thread';
import { ContactPanelDrawer } from '@/components/inbox/contact-panel-drawer';
import { ConversationFetchBoundary } from '@/components/inbox/conversation-fetch-boundary';
import { LeadAnalysisSummary } from '@/components/lead-analysis/lead-analysis-summary';
import { LeadAnalysisList } from '@/components/lead-analysis/lead-analysis-list';
import {
  type LeadAnalysisFilters,
  type LeadAnalysisRow,
  type LeadAnalysisView,
} from '@/components/lead-analysis/lead-analysis-filter';
import { nextSelectionAfterArchive } from '@/components/lead-analysis/lead-analysis-selection';
import { BOARD_ROLES, pageAccessGate } from '@/lib/auth/page-access';

import { api } from '../../../../convex/_generated/api';
import type { Id } from '../../../../convex/_generated/dataModel';

// ============================================================
// /lead-analysis — split-pane workspace: a live-sorted queue on the
// left, an independently-fetched conversation thread on the right.
// RBAC: agents see only their own assigned leads (the query filters
// server-side); viewers have no board.
//
// This page owns the FILTER and PAGE state as well as the selection,
// because filtering and paging are SERVER-SIDE: `leadAnalysis.board`
// takes band/lane/search/page/pageSize and returns one page plus the
// whole-board totals, so that state IS the query's arguments.
//
// That is also why the list renders `board.leads` straight through
// instead of filtering it here. The board used to filter a single
// bounded payload client-side; the moment only one page crosses the
// wire, a filter left in the client would silently narrow from "search
// the board" to "search these 25 rows". The old `filterLeadRows` helper
// is gone for exactly that reason, and its behaviour now lives (and is
// tested) in `convex/leadAnalysis.ts`.
// ============================================================

/**
 * Renders nothing; lifts a resolved conversation up to the page. Split
 * out so `ConversationFetchBoundary` wraps ONLY this query and not the
 * list or the thread — a throw here must not take the page down.
 */
type ResolvedConversation = FunctionReturnType<typeof api.conversations.get>;

function SelectedConversationFetcher({
  conversationId,
  onResolved,
}: {
  conversationId: Id<'conversations'>;
  onResolved: (conversationId: Id<'conversations'>, c: ResolvedConversation) => void;
}) {
  const conversation = useQuery(api.conversations.get, { conversationId });
  useEffect(() => {
    if (conversation) onResolved(conversationId, conversation);
  }, [conversation, conversationId, onResolved]);
  return null;
}

const PAGE_SIZE = 25;

const EMPTY_FILTERS: LeadAnalysisFilters = {
  band: 'all',
  lane: 'all',
  search: '',
};

export default function LeadAnalysisPage() {
  const t = useTranslations('LeadAnalysis');
  const { accountRole, loading: authLoading, profileLoading } = useAuth();
  // Three states, not one boolean — see `@/lib/auth/page-access`. A null
  // `accountRole` during sign-in must not read as denial, and denial must
  // not borrow the board's "no leads scored yet" copy.
  const gate = pageAccessGate({ authLoading, profileLoading, accountRole }, BOARD_ROLES);
  const canView = gate === 'ready';
  // Archive/restore is a queue-management act, not per-lead work — agent+
  // (spec 2026-07-27-inbox-lanes §RBAC amends this from P2's supervisor+,
  // matching the server's requireRole("agent") on `leadAnalysis.archive` /
  // `restore`).
  const canArchive =
    accountRole === 'agent' ||
    accountRole === 'supervisor' ||
    accountRole === 'admin' ||
    accountRole === 'owner';

  const [view, setView] = useState<LeadAnalysisView>('active');
  const [filters, setFilters] = useState<LeadAnalysisFilters>(EMPTY_FILTERS);
  const [page, setPage] = useState(0);

  // The input stays instant; only the query waits. Without this, each
  // keystroke would open its own Convex subscription.
  const search = useDebouncedValue(filters.search.trim(), 300);

  // Any change to what is being filtered invalidates which page you are
  // on — page 4 of the unfiltered board is not page 4 of the filtered
  // one. Reset in the handlers rather than an effect, so the new filter
  // and `page: 0` reach the query in the same render and no request is
  // ever issued for a page that is about to be discarded.
  const handleFiltersChange = useCallback((next: LeadAnalysisFilters) => {
    setFilters(next);
    setPage(0);
  }, []);

  const handleViewChange = useCallback((next: LeadAnalysisView) => {
    setView(next);
    setPage(0);
  }, []);

  const result = useQuery(
    api.leadAnalysis.board,
    canView
      ? {
          view,
          page,
          pageSize: PAGE_SIZE,
          // Omitted rather than sent as "all": the validator takes the
          // literal band/lane values only, and an absent arg is what
          // means "no filter" server-side.
          ...(filters.band !== 'all' ? { band: filters.band } : {}),
          ...(filters.lane !== 'all' ? { lane: filters.lane } : {}),
          ...(search ? { search } : {}),
        }
      : 'skip'
  );
  // Keep the current page on screen while the next one loads, so a page
  // turn doesn't flash the whole board away and back.
  const { data: board, loading } = useKeptResult(result);

  const reanalyze = useMutation(api.leadAnalysis.reanalyze);
  const archive = useMutation(api.leadAnalysis.archive);
  const restore = useMutation(api.leadAnalysis.restore);

  const searchParams = useSearchParams();
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(
    () => searchParams.get('c'),
  );

  // Mirror selection into `?c=` so the open lead survives a reload and a
  // shared link lands on it. `replace`, not `push`: stepping through a
  // queue must not fill the back stack with one entry per lead.
  //
  // Uses `window.history.replaceState`, NOT `router.replace` — mirrors
  // the Inbox page's `handleSelectConversation` (src/app/(dashboard)/
  // inbox/page.tsx), which explicitly rejects `router.replace` because
  // for a dynamically-rendered route it re-runs the auth middleware and
  // refetches the route's RSC payload on EVERY click, even though the
  // visible thread here is already driven entirely by React state.
  // `replaceState` updates the URL with none of that work. Reading
  // `window.location.search` directly (rather than depending on
  // `searchParams`) also avoids the loop that a `router.replace`-driven
  // `searchParams` dependency would create: each navigation yields a
  // fresh `searchParams` reference, which would re-trigger this effect.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (selectedConversationId) params.set('c', selectedConversationId);
    else params.delete('c');
    const query = params.size ? `?${params}` : '';
    window.history.replaceState(null, '', `/lead-analysis${query}`);
  }, [selectedConversationId]);

  // The server already filtered and paged this; `visible` is exactly the
  // page it returned. Named for the selection arithmetic below, which
  // reasons about "the rows on screen" — which, with paging, is one page.
  const visible = useMemo(() => board?.leads ?? [], [board]);

  // Paired with the id it was fetched for, and cross-checked at the
  // derivation site below rather than cleared by an effect: an effect
  // runs after commit/paint, so `useEffect(() => setResolved(null), [id])`
  // would still show the PREVIOUS lead's thread for a frame after the
  // NEW lead's id (and its score/reason header, which derives from
  // `visible`) has already painted. Mirrors how the Inbox page pairs
  // `fallbackConversation` with the id it resolved for and cross-checks
  // it at the derivation site (`fallbackUiConversation?.id ===
  // activeConversationId`, src/app/(dashboard)/inbox/page.tsx) instead
  // of relying on effect timing.
  const [resolved, setResolved] = useState<{
    id: string;
    data: ResolvedConversation;
  } | null>(null);
  const handleConversationResolved = useCallback(
    (conversationId: Id<'conversations'>, data: ResolvedConversation) => {
      setResolved({ id: conversationId, data });
    },
    [],
  );
  const [contactPanelOpen, setContactPanelOpen] = useState(false);

  const activeConversation =
    resolved?.id === selectedConversationId ? toUiConversation(resolved.data) : null;
  const activeContact = activeConversation?.contact ?? null;
  const selectedLead = visible.find((l) => l.conversationId === selectedConversationId) ?? null;

  const handleReanalyze = useCallback(
    async (lead: LeadAnalysisRow) => {
      try {
        await reanalyze({
          conversationId: lead.conversationId as Id<'conversations'>,
        });
        toast.success(t('reanalyzeQueued'));
      } catch (err) {
        console.error('Failed to queue re-analysis:', err);
        toast.error(t('reanalyzeError'));
      }
    },
    [reanalyze, t],
  );

  const handleArchive = useCallback(
    async (lead: LeadAnalysisRow) => {
      // Snapshot BEFORE awaiting: the board is a live query and the
      // archive re-sorts it, so picking the neighbour afterwards would
      // race that update.
      const advanceTo = nextSelectionAfterArchive(
        visible,
        lead.conversationId,
        selectedConversationId,
      );
      try {
        await archive({ conversationId: lead.conversationId as Id<'conversations'> });
        setSelectedConversationId(advanceTo);
        toast.success(t('archivedToast'));
      } catch (err) {
        console.error('Failed to archive this lead:', err);
        toast.error(t('archiveError'));
      }
    },
    [archive, t, visible, selectedConversationId],
  );

  const handleRestore = useCallback(
    async (lead: LeadAnalysisRow) => {
      try {
        await restore({
          conversationId: lead.conversationId as Id<'conversations'>,
        });
        toast.success(t('restoredToast'));
      } catch (err) {
        console.error('Failed to restore this lead:', err);
        toast.error(t('restoreError'));
      }
    },
    [restore, t],
  );

  // Identity still resolving — say nothing about the data yet. Claiming
  // "no leads scored" here is what this page used to do, and it was false
  // on every account that had any.
  if (gate === 'loading') {
    return <p className="mt-8 text-sm text-muted-foreground">{t('loading')}</p>;
  }
  if (gate === 'no_access') {
    return <p className="mt-8 text-sm text-muted-foreground">{t('noAccess')}</p>;
  }
  // Only the FIRST load has nothing to show — later loads keep the
  // previous page rendered and just mark the controls busy.
  if (!board) {
    return <p className="mt-8 text-sm text-muted-foreground">{t('loading')}</p>;
  }

  return (
    <div className="-m-4 flex h-app-content flex-col overflow-hidden sm:-m-6">
      {selectedConversationId && (
        <ConversationFetchBoundary key={selectedConversationId}>
          <SelectedConversationFetcher
            conversationId={selectedConversationId as Id<'conversations'>}
            onResolved={handleConversationResolved}
          />
        </ConversationFetchBoundary>
      )}

      {/* Summary + filters. Hidden on mobile while a thread is open so
          the conversation gets the whole screen. */}
      <div className={cn('shrink-0 border-b px-4 py-3', selectedConversationId && 'hidden lg:block')}>
        <LeadAnalysisSummary
          board={board}
          view={view}
          onViewChange={handleViewChange}
          filters={filters}
          onFiltersChange={handleFiltersChange}
        />
      </div>

      <div className="flex flex-1 overflow-hidden">
        <div
          className={cn(
            'flex h-full flex-col overflow-y-auto border-r lg:w-96 lg:shrink-0',
            selectedConversationId ? 'hidden lg:flex' : 'flex flex-1',
          )}
        >
          <LeadAnalysisList
            leads={visible}
            selectedConversationId={selectedConversationId}
            onSelect={(lead) => setSelectedConversationId(lead.conversationId)}
            canReanalyze={canView}
            onReanalyze={handleReanalyze}
            canArchive={canArchive}
            onArchive={handleArchive}
            onRestore={handleRestore}
          />

          {/* Pager sits under the queue, inside the left pane, so it
              stays reachable while a thread occupies the right one.
              `board.total` is the size of the whole FILTERED board, not
              of this page — the server keeps that count precisely so the
              pager can exist without a second round trip. */}
          {board.pageCount > 1 && (
            <div className="shrink-0 border-t px-3 py-2">
              <Pagination
                page={board.page}
                pageSize={PAGE_SIZE}
                total={board.total}
                onPageChange={setPage}
                busy={loading}
              />
            </div>
          )}
        </div>

        <div
          className={cn(
            'min-w-0 flex-1 flex-col lg:flex',
            selectedConversationId ? 'flex' : 'hidden lg:flex',
          )}
        >
          {activeConversation ? (
            <>
              {/* Score + reason for the open lead — the one piece of
                  context the Inbox structurally cannot show. No mobile
                  back button here: `MessageThread` already renders its
                  own (unconditional whenever `onBack` is set), and it is
                  strictly better than a copy gated on `selectedLead` —
                  this block, and its button, disappear whenever the open
                  lead drops out of the filtered list (a filter change, a
                  lane flip from a new message, a view switch), which
                  would leave a stranded thread with no way back on
                  mobile. */}
              {selectedLead && (
                <div className="flex shrink-0 items-start gap-2 border-b px-4 py-2">
                  <span data-testid="thread-score" className="text-sm font-semibold">
                    {selectedLead.score ?? '–'}
                  </span>
                  <p className="text-muted-foreground min-w-0 flex-1 text-xs">
                    {selectedLead.reason ?? t('row.unscored')}
                  </p>
                </div>
              )}
              <div className="relative flex min-h-0 flex-1">
                <MessageThread
                  conversation={activeConversation}
                  contact={activeContact}
                  onBack={() => setSelectedConversationId(null)}
                  contactPanelOpen={contactPanelOpen}
                  onToggleContactPanel={() => setContactPanelOpen((o) => !o)}
                />
                <ContactPanelDrawer
                  open={contactPanelOpen}
                  onClose={() => setContactPanelOpen(false)}
                  contact={activeContact}
                  conversationId={selectedConversationId ?? undefined}
                />
              </div>
            </>
          ) : (
            <p className="text-muted-foreground m-auto text-sm">{t('selectLead')}</p>
          )}
        </div>
      </div>
    </div>
  );
}
