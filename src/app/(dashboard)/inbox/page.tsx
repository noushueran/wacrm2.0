"use client";

import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useMutation } from "convex/react";
import { usePaginatedQuery, useQuery } from "@/lib/convex/cached";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { toUiConversation } from "@/lib/convex/adapters";
import { inboxUrl } from "@/lib/inbox/view";
import type { Conversation } from "@/types";
import {
  ConversationList,
  type AssignmentTab,
} from "@/components/inbox/conversation-list";
import { MessageThread } from "@/components/inbox/message-thread";
import { ContactPanelDrawer } from "@/components/inbox/contact-panel-drawer";
import { WifiOff } from "lucide-react";
import { cn } from "@/lib/utils";

export default function InboxPage() {
  const t = useTranslations("Inbox.page");
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
  const [assignment, setAssignment] = useState<AssignmentTab>("all");

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
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset tied to conversation change, not a per-render derivation
    setContactPanelOpen(false);
  }, [activeConversationId]);

  // Fire the deep-link auto-select exactly once per URL — subsequent
  // list refreshes (a reactive push from Convex, a later click
  // elsewhere) must not snap the user back to the deep-linked
  // conversation if they've already navigated away.
  const autoSelectedForDeepLinkRef = useRef<string | null>(null);

  // Conversations — reactive Convex paginated query. Convex pushes
  // updates automatically whenever any underlying row changes (a new
  // message, a status/assign change, markRead), so there's no realtime
  // channel, no hydrate-on-miss, and no manual resync to manage: the
  // whole coordinator this page used to own is gone.
  const conv = usePaginatedQuery(
    api.conversations.list,
    { assignment: assignment === "all" ? undefined : assignment },
    { initialNumItems: 30 },
  );
  const conversations = useMemo(
    () => conv.results.map(toUiConversation),
    [conv.results],
  );

  const activeConversation = useMemo(
    () => conversations.find((c) => c.id === activeConversationId) ?? null,
    [conversations, activeConversationId],
  );
  const activeContact = activeConversation?.contact ?? null;

  const markRead = useMutation(api.conversations.markRead);

  // Resolve a pending deep-link once the reactive list has data. Mirrors
  // the previous `handleConversationsLoaded` behaviour, but driven off
  // the live `conversations` array instead of a one-shot fetch callback.
  useEffect(() => {
    if (
      deepLinkConvId &&
      autoSelectedForDeepLinkRef.current !== deepLinkConvId &&
      conversations.length > 0
    ) {
      autoSelectedForDeepLinkRef.current = deepLinkConvId;
      // If the deep-linked conversation is already the active one, do
      // nothing further — avoids re-selecting on every reactive push.
      if (activeConversationId === deepLinkConvId) return;
      const match = conversations.find((c) => c.id === deepLinkConvId);
      if (match) {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot sync driven by the ref guard above, not a per-render derivation
        setActiveConversationId(match.id);
        markRead({ conversationId: match.id as Id<"conversations"> }).catch(
          (err) => {
            console.error("Failed to mark conversation read:", err);
          },
        );
      }
    }
  }, [deepLinkConvId, conversations, activeConversationId, markRead]);

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
      // in the same thread and copy-paste links work — but via the native
      // history API, NOT `router.replace`. router.replace runs a soft
      // navigation to `/inbox`, which re-runs the auth middleware and
      // refetches the route's RSC payload on EVERY click, even though the
      // visible thread is already driven by React state. replaceState
      // updates the URL with none of that work, and (unlike pushState)
      // keeps rapid chat-switching out of the back/forward stack.
      window.history.replaceState(null, "", inboxUrl(conversation.id));
      markRead({
        conversationId: conversation.id as Id<"conversations">,
      }).catch((err) => {
        console.error("Failed to mark conversation read:", err);
      });
    },
    [activeConversationId, markRead],
  );

  // Mobile "back" — deselect the conversation so the list pane comes
  // back. Also clears the ?c= param so a refresh lands on the list
  // instead of re-opening the thread the user just backed out of.
  const handleCloseConversation = useCallback(() => {
    setActiveConversationId(null);
    // Clearing the ref lets the deep-link auto-selector fire again if
    // the user later visits /inbox?c=<same-id> — desirable UX.
    autoSelectedForDeepLinkRef.current = null;
    window.history.replaceState(null, "", inboxUrl(null));
  }, []);

  // On mobile (<lg) we show a SINGLE pane — either the list or the
  // thread — rather than cramming both side-by-side. Selecting a
  // conversation slides the thread in; the thread's back button pops
  // it back to the list. On lg+ both panes render side-by-side as
  // before, unchanged.
  const hasActiveConv = !!activeConversation;

  return (
    <div className="-m-4 flex h-app-content flex-col overflow-hidden sm:-m-6">
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
            conversations={conversations}
            loadMore={conv.loadMore}
            status={conv.status}
            assignment={assignment}
            onAssignmentChange={setAssignment}
          />
        </div>

        {/* Center panel: Message thread.
            Hidden on mobile when no conversation is selected so the
            list can occupy the full width. Always visible on lg+
            (shows its own empty-state if no thread is picked yet).

            `min-w-0` is load-bearing: without it, a single wide piece
            of content inside the thread (long quote preview, very
            long URL in a message body) forces the flex child past
            its share and pushes the contact-sidebar panel off-screen
            on the right. Issue #165. */}
        {/* `relative` anchors the contact-details slide-over, which
            overlays the thread's right edge instead of taking its own
            column. */}
        <div
          className={cn(
            "relative flex h-full min-w-0 flex-1 lg:flex",
            hasActiveConv ? "flex" : "hidden lg:flex",
          )}
        >
          <MessageThread
            conversation={activeConversation}
            contact={activeContact}
            onBack={handleCloseConversation}
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
  );
}
