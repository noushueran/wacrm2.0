"use client";

import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useMutation } from "convex/react";
import { usePaginatedQuery, useQuery } from "@/lib/convex/cached";
import type { FunctionReturnType } from "convex/server";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { toUiConversation } from "@/lib/convex/adapters";
import {
  conversationListArgs,
  conversationRowsToRender,
  conversationTabKey,
  historyActionForClose,
  historyActionForOpen,
  inboxUrl,
  parseAssignmentTab,
  INITIAL_CONVERSATION_PAGE_SIZE,
  type AssignmentTab,
  type InboxLane,
  type RememberedRows,
} from "@/lib/inbox/view";
import { hasMinRole } from "@/lib/auth/roles";
import { useAuth } from "@/hooks/use-auth";
import type { Conversation } from "@/types";
import { ConversationList } from "@/components/inbox/conversation-list";
import { MessageThread } from "@/components/inbox/message-thread";
import { ContactPanelDrawer } from "@/components/inbox/contact-panel-drawer";
import { ConversationFetchBoundary } from "@/components/inbox/conversation-fetch-boundary";
import { WifiOff, Archive } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

/** Shape of a resolved `conversations.get` result (conversation doc +
 *  embedded contact) — the same shape `toUiConversation` expects. Named
 *  here instead of re-derived at each call site, mirroring the
 *  `FunctionReturnType<typeof api.contacts.list>` pattern already used in
 *  `src/hooks/use-broadcast-sending.ts` and the broadcast wizard steps. */
type ConversationWithContact = FunctionReturnType<typeof api.conversations.get>;

/**
 * Renders nothing. Its only job is running the fallback
 * `conversations.get` query and lifting a successful result up to
 * `InboxPage` via `onResolved` — isolating the query (and its potential
 * throw) in its own component so `DeepLinkFallbackBoundary` above can
 * catch it without wrapping any of the page's other rendering. Mirrors
 * how `RecipientRow` in the broadcasts detail page lifts a resolved
 * contact up to its parent via callback instead of returning it from a
 * shared hook.
 */
function DeepLinkFallbackFetcher({
  conversationId,
  onResolved,
}: {
  conversationId: Id<"conversations">;
  onResolved: (conversation: ConversationWithContact) => void;
}) {
  const conversation = useQuery(api.conversations.get, { conversationId });
  useEffect(() => {
    if (conversation) onResolved(conversation);
  }, [conversation, onResolved]);
  return null;
}

export default function InboxPage() {
  const t = useTranslations("Inbox.page");
  // The restore-failure toast (Fix 5) reuses the Lead Analysis board's
  // own `restoreError` key rather than a new Inbox-scoped one: both
  // call the exact same `leadAnalysis.restore` mutation for the exact
  // same failure, just from two different entry points (this thread
  // banner vs. a board row) — see `src/app/(dashboard)/lead-analysis/
  // page.tsx`'s `handleRestore` for the sibling usage.
  const tLeadAnalysis = useTranslations("LeadAnalysis");
  const searchParams = useSearchParams();
  /**
   * `?c=<id>` deep-link support. Used when landing here from the
   * dashboard's recent-conversations list so the right thread opens
   * automatically instead of showing the empty center panel.
   */
  const deepLinkConvId = searchParams.get("c");

  const [activeConversationId, setActiveConversationId] = useState<
    string | null
  >(null);

  // Which assignment "bucket" the list shows: everything, only chats
  // assigned to me, or only the unassigned pool. Server-filtered via the
  // `assignment` arg below so each tab paginates its own complete set.
  // Seeded from `?assignment=`, which is what makes the manifest's
  // "Unassigned leads" home-screen shortcut actually land on that tab.
  // A lazy initialiser, so the parameter is read once on mount and the
  // agent's later tab clicks are never overwritten by the URL.
  const [assignment, setAssignment] = useState<AssignmentTab>(() =>
    parseAssignmentTab(searchParams.get("assignment")),
  );

  // Which lane the list shows. Server-filtered via the `lane`/`archived`
  // args below, so each tab paginates its own complete set — unlike the
  // status/tag/search filters, which narrow only the loaded page.
  //
  // Supersedes the old standalone Archived toggle (lead-analysis P2,
  // formerly a separate `archived` boolean here): "Archived" is now the
  // lane's fourth value instead of a second, bolted-on control, so a
  // supervisor viewing Archived + Mine at once still works (both args
  // compose independently on `api.conversations.list`) with a single
  // piece of tab state instead of two that could silently disagree.
  const [lane, setLane] = useState<InboxLane>("active");

  const { accountRole } = useAuth();
  // Restore is agent+ (spec 2026-07-27-inbox-lanes §RBAC amends this from
  // P2's supervisor+, matching `leadAnalysis.restore`'s `requireRole`) —
  // the client check is purely a display concern (hide a button that would
  // fail), not the security boundary.
  const canRestore = !!accountRole && hasMinRole(accountRole, "agent");

  /**
   * Whether the contact-details slide-over is open. On-demand, not
   * sticky: it defaults closed and is opened by clicking the thread
   * header name/number. A dedicated effect collapses it again whenever
   * the active conversation changes, so it never lingers across chats.
   */
  const [contactPanelOpen, setContactPanelOpen] = useState(false);

  const handleToggleContactPanel = useCallback(() => {
    setContactPanelOpen((prev) => !prev);
  }, []);

  // Collapse the panel whenever the agent opens or switches
  // conversations, so it only appears when they click the header.
  //
  // During render, guarded by the previous id — React's documented way to
  // reset state when the thing it belongs to changes, and the same shape
  // `inbox/contact-custom-fields.tsx` uses. As an effect this reset landed
  // after paint, so switching from a chat with the panel open rendered the
  // NEW conversation with the OLD conversation's panel still expanded for
  // a frame. `activeConversationId` is a string | null, so the guard
  // compares by value.
  const [panelConvId, setPanelConvId] = useState(activeConversationId);
  if (activeConversationId !== panelConvId) {
    setPanelConvId(activeConversationId);
    setContactPanelOpen(false);
  }

  // Fire the deep-link auto-select exactly once per URL — subsequent
  // list refreshes (a reactive push from Convex, a later click
  // elsewhere) must not snap the user back to the deep-linked
  // conversation if they've already navigated away.
  const autoSelectedForDeepLinkRef = useRef<string | null>(null);

  /**
   * Whether THIS page pushed a history entry for the open thread — i.e.
   * whether there is a list entry sitting behind it to go back to.
   *
   * A ref, not state: nothing renders from it, and it must be readable
   * and writable inside the same tick as the `history` call it describes.
   * Kept in step in exactly three places — set when opening pushes
   * (`handleSelectConversation`), set when a deep link synthesises a list
   * entry (the auto-select effect), cleared whenever a `popstate` lands
   * back on the list.
   */
  const pushedThreadEntryRef = useRef(false);

  /**
   * Open a conversation in the URL bar. `push` gives the hardware back
   * button somewhere to go; `replace` overwrites the current entry. See
   * `historyActionForOpen` for which applies when.
   */
  const writeThreadHistory = useCallback(
    (conversationId: string, action: "push" | "replace") => {
      if (action === "push") {
        window.history.pushState(null, "", inboxUrl(conversationId));
        pushedThreadEntryRef.current = true;
      } else {
        window.history.replaceState(null, "", inboxUrl(conversationId));
      }
    },
    [],
  );

  /**
   * Give a `?c=` deep link a list entry to fall back to.
   *
   * Landing straight on a thread — which is what every push notification
   * does, and notifications are this app's main entry point — leaves the
   * thread as the FIRST entry in the app's history. Back from there exits
   * to whatever preceded the app. Rewriting the current entry as the
   * list and then pushing the thread onto it means back lands on the
   * conversation list, the way a native messaging app behaves when you
   * open it from a notification.
   *
   * Both calls are synchronous, so React only ever observes the final
   * URL. Guarded by the ref so it happens at most once per opened thread.
   */
  const synthesizeListEntry = useCallback((conversationId: string) => {
    if (pushedThreadEntryRef.current) return;
    window.history.replaceState(null, "", inboxUrl(null));
    window.history.pushState(null, "", inboxUrl(conversationId));
    pushedThreadEntryRef.current = true;
  }, []);

  /**
   * Hardware back / forward. The URL is the source of truth here: read
   * `?c=` off the location that the browser has already restored and
   * bring `activeConversationId` into line with it.
   *
   * `autoSelectedForDeepLinkRef` is cleared rather than set, so the
   * auto-select effect below is free to re-run for this URL. It won't
   * duplicate the work — it returns early once `activeConversationId`
   * already equals the deep link — and clearing keeps a later, genuine
   * deep link to the same id working.
   *
   * Registered once. Listening on `window` rather than using Next's
   * router because the entries being walked were written with the native
   * history API, not by a route change.
   */
  useEffect(() => {
    const onPopState = () => {
      const next = new URLSearchParams(window.location.search).get("c");
      setActiveConversationId(next);
      autoSelectedForDeepLinkRef.current = null;
      if (next === null) pushedThreadEntryRef.current = false;
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  // Conversations — reactive Convex paginated query. Convex pushes
  // updates automatically whenever any underlying row changes (a new
  // message, a status/assign change, markRead), so there's no realtime
  // channel, no hydrate-on-miss, and no manual resync to manage: the
  // whole coordinator this page used to own is gone.
  //
  // Args and page size come from `conversationListArgs` /
  // `INITIAL_CONVERSATION_PAGE_SIZE` rather than being spelled out here,
  // because `PrefetchLane` (the tab-hover cache-warmer) has to produce a
  // byte-identical cache key or its warmed subscription is not the one
  // this hook reads. One builder, no way for the two to drift.
  const conv = usePaginatedQuery(
    api.conversations.list,
    conversationListArgs(lane, assignment),
    { initialNumItems: INITIAL_CONVERSATION_PAGE_SIZE },
  );
  const conversations = useMemo(
    () => conv.results.map(toUiConversation),
    [conv.results],
  );

  // Keep the tab's rows on screen across a mid-session pagination reset.
  //
  // `usePaginatedQuery` absorbs Convex's `InvalidCursor` by discarding
  // all pagination state and restarting from page one — results drop to
  // `[]` and `status` goes back to `LoadingFirstPage`, so the list the
  // user was reading flashes to a skeleton. Quantized lane boundaries
  // (`convex/lib/inbox/lanes.ts`) stopped that firing on every click,
  // but `InvalidCursor` is a NORMAL condition Convex documents — a
  // bucket rollover or the underlying data shifting still triggers it,
  // and a reset the user can see is a reset done badly.
  //
  // State adjusted DURING render, not a ref and not an effect — React's
  // documented "storing information from previous renders" pattern, and
  // the only one of the three that is correct here. A ref would have to
  // be read during render, which `react-hooks/refs` forbids because an
  // untracked read can silently be a render behind. An effect would fire
  // a second commit per push (`react-hooks/set-state-in-effect`). This
  // re-runs the render function instead, before anything is committed,
  // and settles immediately: the guard compares by identity, so the very
  // next pass finds `rememberedRows.rows === conversations` and stops.
  //
  // The guard only ever remembers a NON-empty page, which is the whole
  // trick: when results drop to `[]` mid-session this deliberately does
  // nothing, so the previous rows are still remembered and the reset has
  // something to render. The rules for when they may actually be shown
  // live in `conversationRowsToRender`, where they are unit-testable.
  const tabKey = conversationTabKey(lane, assignment);
  const [rememberedRows, setRememberedRows] = useState<
    RememberedRows<Conversation>
  >({ key: tabKey, rows: [] });
  if (
    conversations.length > 0 &&
    (rememberedRows.rows !== conversations || rememberedRows.key !== tabKey)
  ) {
    setRememberedRows({ key: tabKey, rows: conversations });
  }
  const visibleConversations = conversationRowsToRender(
    conv.status,
    tabKey,
    conversations,
    rememberedRows,
  ) as Conversation[];

  // Whether the CURRENT tab's paginated list has settled enough to trust
  // an absence — i.e. "not found" means "not found", not "still loading
  // page one". Matters below: a deep-linked id absent from `conversations`
  // is either genuinely elsewhere (archived while viewing the active tab,
  // or vice versa) or just hasn't loaded yet, and those must not be
  // confused.
  const conversationListSettled = conv.status !== "LoadingFirstPage";
  const deepLinkInList =
    !!deepLinkConvId && conversations.some((c) => c.id === deepLinkConvId);

  /**
   * Fallback single-conversation fetch (Fix 1) — a deep-linked or
   * previously-selected conversation is NOT always in the current tab's
   * paginated list: an archived conversation opened via an older
   * `lead_qualified`/`sla_alert` bell while viewing the active Inbox, or
   * (same root cause) a conversation that just dropped OUT of the
   * Archived tab's list because a supervisor clicked Restore on it. Both
   * would otherwise dead-end on the empty center panel with no way to
   * reach the archived banner + Restore button at all.
   *
   * Reuses `conversations.get` (`requireConversationAccess`, "view") —
   * the existing single-conversation read already used by the thread
   * itself elsewhere — rather than adding a new Convex function. Gated
   * on `conversationListSettled` so this never fires a redundant fetch
   * while the tab's own list is still loading page one; skipped outright
   * once the id is confirmed present there.
   *
   * The query itself runs inside `DeepLinkFallbackFetcher`, rendered
   * below wrapped in `DeepLinkFallbackBoundary` — NOT called directly
   * here — because `requireConversationAccess` throws `ConvexError
   * NOT_FOUND` for an id that's nonexistent, foreign, or outside the
   * caller's role scope (e.g. an agent's stale link to a conversation
   * reassigned to a colleague), and `useQuery` re-throws that
   * synchronously during render. Only a React error boundary can catch
   * that; see the boundary's own doc comment for why it's scoped as
   * narrowly as it is.
   */
  const shouldFetchFallback =
    !!deepLinkConvId && conversationListSettled && !deepLinkInList;

  const [fallbackConversation, setFallbackConversation] =
    useState<ConversationWithContact | null>(null);

  // Clears stale data once the fallback is no longer needed — the id
  // showed up in the tab's own list, the list un-settled again (tab
  // switch), or the deep link was cleared. Doesn't need to also fire on
  // every `deepLinkConvId` change while `shouldFetchFallback` stays
  // true: every consumer below checks `fallbackConversation._id ===
  // deepLinkConvId` (or the equivalent on the derived UI conversation),
  // so a stale doc left over from a previous id simply never matches.
  //
  // During render, guarded by the previous value of the flag, so the
  // clear happens before anything below reads `fallbackConversation`. As
  // an effect it cleared after paint, which rendered one frame of the
  // fallback thread at the exact moment it had been decided the fallback
  // was no longer wanted — the id having just appeared in the tab's own
  // list being the common case. `shouldFetchFallback` is a boolean, so
  // the guard compares by value.
  const [lastShouldFetchFallback, setLastShouldFetchFallback] =
    useState(shouldFetchFallback);
  if (shouldFetchFallback !== lastShouldFetchFallback) {
    setLastShouldFetchFallback(shouldFetchFallback);
    if (!shouldFetchFallback) {
      setFallbackConversation(null);
    }
  }

  const fallbackUiConversation = useMemo(
    () => (fallbackConversation ? toUiConversation(fallbackConversation) : null),
    [fallbackConversation],
  );

  const activeConversation = useMemo(() => {
    const inList = conversations.find((c) => c.id === activeConversationId);
    if (inList) return inList;
    if (fallbackUiConversation?.id === activeConversationId) {
      return fallbackUiConversation;
    }
    return null;
  }, [conversations, activeConversationId, fallbackUiConversation]);
  const activeContact = activeConversation?.contact ?? null;

  const markRead = useMutation(api.conversations.markRead);
  const restoreConversation = useMutation(api.leadAnalysis.restore);
  const markUnread = useMutation(api.conversations.markUnread);

  const handleRestore = useCallback(async () => {
    if (!activeConversationId) return;
    try {
      await restoreConversation({
        conversationId: activeConversationId as Id<"conversations">,
      });
    } catch (err) {
      console.error("Failed to restore this conversation:", err);
      toast.error(tLeadAnalysis("restoreError"));
    }
  }, [activeConversationId, restoreConversation, tLeadAnalysis]);

  // Resolve a pending deep-link once we know definitively whether it's
  // in the current tab's paginated list. Mirrors the previous
  // `handleConversationsLoaded` behaviour, but driven off the live
  // `conversations` array instead of a one-shot fetch callback — and
  // (Fix 1) falls through to the single-conversation fetch above once
  // the list has settled and the id still isn't there, rather than
  // silently giving up on an archived/cross-tab conversation.
  useEffect(() => {
    if (!deepLinkConvId || autoSelectedForDeepLinkRef.current === deepLinkConvId) {
      return;
    }
    // Already the active one — nothing further to do, but the ref still
    // needs to record this URL as handled so this effect doesn't keep
    // re-checking it on every reactive push.
    if (activeConversationId === deepLinkConvId) {
      autoSelectedForDeepLinkRef.current = deepLinkConvId;
      return;
    }
    const listMatch = conversations.find((c) => c.id === deepLinkConvId);
    if (listMatch) {
      autoSelectedForDeepLinkRef.current = deepLinkConvId;
      // STAYS AN EFFECT, unlike the two resets earlier in this file. Those
      // were pure state adjustments and moved into render; this one is not
      // adjacent to a side effect, it IS one — it mutates a ref above and
      // fires the `markRead` mutation below. React may render a component
      // more than once before committing (and does exactly that in
      // StrictMode), so a network write placed in the render path can be
      // issued twice for one user action. The suppression is the correct
      // outcome here, not a deferred cleanup.
      // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot sync driven by the ref guard above; this effect also performs a network mutation, so it cannot move into render
      setActiveConversationId(listMatch.id);
      // Give the hardware back button the conversation list to return to
      // — this thread was opened by a URL, not by a click, so nothing has
      // pushed an entry for it.
      synthesizeListEntry(listMatch.id);
      markRead({ conversationId: listMatch.id as Id<"conversations"> }).catch(
        (err) => {
          console.error("Failed to mark conversation read:", err);
        },
      );
      return;
    }
    // Not in the paginated list. Don't give up until the list has
    // settled AND the fallback fetch above has had a chance to resolve
    // — it may simply still be loading.
    if (!conversationListSettled) return;
    if (fallbackConversation && fallbackConversation._id === deepLinkConvId) {
      autoSelectedForDeepLinkRef.current = deepLinkConvId;
      setActiveConversationId(fallbackConversation._id);
      // Same reason as the in-list branch above.
      synthesizeListEntry(fallbackConversation._id);
      markRead({ conversationId: fallbackConversation._id }).catch((err) => {
        console.error("Failed to mark conversation read:", err);
      });
    }
  }, [
    deepLinkConvId,
    conversations,
    conversationListSettled,
    fallbackConversation,
    activeConversationId,
    markRead,
    synthesizeListEntry,
  ]);

  const wa = useQuery(api.whatsappConfig.connectionState);
  const whatsappConnected = wa === undefined ? null : wa.status === "connected";

  const handleSelectConversation = useCallback(
    (conversation: Conversation) => {
      // Re-clicking the already-active conversation would clear the
      // thread's messages effect deps for no reason — bail out early.
      if (activeConversationId === conversation.id) return;
      setActiveConversationId(conversation.id);
      // Record the selection on the deep-link ref BEFORE we change the
      // URL. The history update below still flips `deepLinkConvId` (Next
      // 16 syncs native history into `useSearchParams`), which could
      // otherwise make the auto-select effect above apply a *different*
      // deep-link.
      autoSelectedForDeepLinkRef.current = conversation.id;
      // Reflect the selection in the URL so a refresh lands the user back
      // in the same thread and copy-paste links work — via the native
      // history API either way, never `router.push`/`router.replace`.
      //
      // List → thread pushes, so back returns to the list; thread →
      // thread replaces, so rapid chat-switching stays out of the
      // back/forward stack. `historyActionForOpen` owns that rule and is
      // unit-tested; see its comment for why each branch is what it is.
      writeThreadHistory(
        conversation.id,
        historyActionForOpen(activeConversationId),
      );
      markRead({
        conversationId: conversation.id as Id<"conversations">,
      }).catch((err) => {
        console.error("Failed to mark conversation read:", err);
      });
    },
    [activeConversationId, markRead, writeThreadHistory],
  );

  // Mobile "back" — deselect the conversation so the list pane comes
  // back. Also clears the ?c= param so a refresh lands on the list
  // instead of re-opening the thread the user just backed out of.
  //
  // When opening pushed an entry this delegates to `history.back()` and
  // lets the popstate handler above do the state change, so the in-app
  // control and the hardware button are literally the same navigation —
  // no dead `?c=` entries piling up behind the user, and no way for the
  // two paths to drift. Otherwise (a deep link with no list entry behind
  // it) it rewrites the URL as before. `historyActionForClose` owns that
  // choice and is unit-tested.
  const handleCloseConversation = useCallback(() => {
    // Deselect SYNCHRONOUSLY, before either history branch. `history.back()`
    // only delivers its state change via `popstate`, one task later, and
    // `handleMarkUnread` below depends on this deselect having already
    // flushed by the time it fires its mutation — otherwise the restored
    // unread count can race back down onto a thread that is still open and
    // immediately re-read it. The popstate handler re-derives `null` from
    // the URL a moment later, which is idempotent.
    setActiveConversationId(null);
    // Clearing the ref lets the deep-link auto-selector fire again if
    // the user later visits /inbox?c=<same-id> — desirable UX.
    autoSelectedForDeepLinkRef.current = null;

    if (historyActionForClose(pushedThreadEntryRef.current) === "back") {
      window.history.back();
      return;
    }
    window.history.replaceState(null, "", inboxUrl(null));
  }, []);

  /**
   * Mark-as-unread — the undo for opening the wrong chat. Closing the
   * thread is part of the action rather than a courtesy: three separate
   * paths here re-read whatever conversation is on screen (this page's
   * select handler, the `?c=` deep-link effect above, and
   * `MessageThread`'s own "unread surfaced on the active thread" effect),
   * so a restore that left the thread open would be undone the instant
   * the new count arrived. `handleCloseConversation` also drops `?c=`,
   * which matters for the same reason — otherwise a refresh would
   * re-open and re-read the row the agent just put back.
   *
   * Deselect first, mutate second: the state flush re-renders
   * `MessageThread` with a null conversation (its effect early-returns on
   * that) well before the mutation's round-trip can push a nonzero count
   * back down.
   */
  const handleMarkUnread = useCallback(
    (conversationId: string) => {
      if (activeConversationId === conversationId) handleCloseConversation();
      markUnread({
        conversationId: conversationId as Id<"conversations">,
      }).catch((err) => {
        console.error("Failed to mark conversation unread:", err);
        toast.error(t("markUnreadFailed"));
      });
    },
    [activeConversationId, handleCloseConversation, markUnread, t],
  );

  // On mobile (<lg) we show a SINGLE pane — either the list or the
  // thread — rather than cramming both side-by-side. Selecting a
  // conversation slides the thread in; the thread's back button pops
  // it back to the list. On lg+ both panes render side-by-side as
  // before, unchanged.
  const hasActiveConv = !!activeConversation;

  return (
    <div className="-m-4 flex h-app-content flex-col overflow-hidden sm:-m-6">
      {/* Deep-link fallback fetch (Fix 1) — renders nothing. Isolated
          behind `DeepLinkFallbackBoundary` so a `NOT_FOUND`/forbidden
          throw from `conversations.get` (stale link, reassigned
          conversation, foreign/nonexistent id) unmounts only this,
          leaving the rest of the page — and its existing empty state —
          intact instead of crashing the whole route. `key` resets the
          boundary per deep-link id so one bad link can't permanently
          disable the fallback for links that come after it. */}
      {shouldFetchFallback && (
        <ConversationFetchBoundary key={deepLinkConvId}>
          <DeepLinkFallbackFetcher
            conversationId={deepLinkConvId as Id<"conversations">}
            onResolved={setFallbackConversation}
          />
        </ConversationFetchBoundary>
      )}

      {/* WhatsApp connection banner — in the flex column, not absolute,
          so it pushes the panels down instead of overlapping them. */}
      {whatsappConnected === false && (
        <div className="flex shrink-0 items-center justify-center gap-2 border-b border-amber-500/20 bg-amber-500/10 px-4 py-2">
          <WifiOff className="h-4 w-4 text-amber-400" />
          <p className="text-xs text-amber-400">
            {t("whatsappNotConnected")}
          </p>
        </div>
      )}

      <div className="flex flex-1 overflow-hidden">
        {/* Left panel: Conversation list.
            Hidden on mobile when a conversation is selected so the
            thread can occupy the full width. Always visible on lg+. */}
        <div
          className={cn(
            "flex h-full flex-1 lg:flex-none",
            hasActiveConv ? "hidden lg:flex" : "flex",
          )}
        >
          <ConversationList
            activeConversationId={activeConversation?.id ?? null}
            onSelect={handleSelectConversation}
            onMarkUnread={handleMarkUnread}
            conversations={visibleConversations}
            loadMore={conv.loadMore}
            status={conv.status}
            assignment={assignment}
            onAssignmentChange={setAssignment}
            lane={lane}
            onLaneChange={setLane}
          />
        </div>

        {/* Center panel: Message thread (+ archived banner above it).
            Hidden on mobile when no conversation is selected so the
            list can occupy the full width. Always visible on lg+
            (shows its own empty-state if no thread is picked yet).

            `min-w-0` is load-bearing: without it, a single wide piece
            of content inside the thread (long quote preview, very
            long URL in a message body) forces the flex child past
            its share and pushes the contact-sidebar panel off-screen
            on the right. Issue #165. `flex-col` stacks the optional
            archived banner above the thread+sidebar row below. */}
        <div
          className={cn(
            "flex h-full min-w-0 flex-1 flex-col lg:flex",
            hasActiveConv ? "flex" : "hidden lg:flex",
          )}
        >
          {/* Archived banner + Restore (lead-analysis P2) — shown above
              the thread when the selected conversation carries
              `archived_at`. Restore is agent+ (spec 2026-07-27-inbox-lanes
              §RBAC amends this from P2's supervisor+, matching the
              server's own `requireRole("agent")` on `leadAnalysis.restore`):
              the client check is a display concern, the server call is
              still the real gate. Disappears
              on its own once restored: the conversation drops out of the
              Archived tab's paginated list, but (Fix 1) the fallback
              single-conversation query above keeps `activeConversation`
              resolved to the now-unarchived row instead of the thread
              itself going empty — so the banner loses its condition
              while the thread stays open. */}
          {activeConversation?.archived_at && (
            <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-amber-500/20 bg-amber-500/10 px-4 py-2">
              <p className="flex items-center gap-2 text-xs text-amber-400">
                <Archive className="h-3.5 w-3.5 shrink-0" />
                {t("archivedBanner")}
              </p>
              {canRestore && (
                <button
                  type="button"
                  onClick={() => void handleRestore()}
                  className="shrink-0 rounded-md border border-amber-500/40 px-2 py-1 text-xs font-medium text-amber-400 hover:bg-amber-500/10"
                >
                  {t("restore")}
                </button>
              )}
            </div>
          )}

          {/* `relative` anchors the contact-details slide-over, which
              overlays the thread's right edge instead of taking its own
              column. `min-h-0` lets this row shrink under the banner
              above rather than overflowing the fixed-height column. */}
          <div className="relative flex min-h-0 flex-1">
            <MessageThread
              conversation={activeConversation}
              contact={activeContact}
              onBack={handleCloseConversation}
              onMarkUnread={handleMarkUnread}
              contactPanelOpen={contactPanelOpen}
              onToggleContactPanel={handleToggleContactPanel}
            />
            <ContactPanelDrawer
              open={contactPanelOpen}
              onClose={handleToggleContactPanel}
              contact={activeContact}
              conversationId={activeConversationId ?? undefined}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
