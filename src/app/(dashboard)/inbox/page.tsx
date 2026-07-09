"use client";

import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { usePaginatedQuery, useQuery, useMutation } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { toUiConversation } from "@/lib/convex/adapters";
import type { Conversation } from "@/types";
import { ConversationList } from "@/components/inbox/conversation-list";
import { MessageThread } from "@/components/inbox/message-thread";
import { ContactSidebar } from "@/components/inbox/contact-sidebar";
import { WifiOff } from "lucide-react";
import { cn } from "@/lib/utils";

// Remembers the agent's show/hide choice for the desktop contact panel
// across reloads and sessions (device-scoped, like the theme prefs).
const CONTACT_PANEL_STORAGE_KEY = "wacrm:inbox:contact-panel-open";

export default function InboxPage() {
  const t = useTranslations("Inbox.page");
  const router = useRouter();
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

  /**
   * Whether the desktop contact sidebar (tags / deals / notes) is shown.
   * Defaults to `true` (the historical behaviour) and is restored from
   * localStorage after mount. We deliberately do NOT read localStorage in
   * the initializer: the server renders with `true`, so reading a stored
   * `false` synchronously would produce a hydration mismatch. The effect
   * below reconciles to the stored value right after mount instead.
   */
  const [contactPanelOpen, setContactPanelOpen] = useState(true);
  useEffect(() => {
    try {
      const stored = localStorage.getItem(CONTACT_PANEL_STORAGE_KEY);
      // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot sync from localStorage on mount, not a per-render derivation
      if (stored !== null) setContactPanelOpen(stored === "true");
    } catch {
      // localStorage can throw in private-browsing / sandboxed contexts.
    }
  }, []);

  const handleToggleContactPanel = useCallback(() => {
    setContactPanelOpen((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(CONTACT_PANEL_STORAGE_KEY, String(next));
      } catch {
        // Persistence is best-effort; ignore storage failures.
      }
      return next;
    });
  }, []);

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
    {},
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

  const wa = useQuery(api.whatsappConfig.get);
  const whatsappConnected = wa === undefined ? null : wa?.status === "connected";

  const handleSelectConversation = useCallback(
    (conversation: Conversation) => {
      // Re-clicking the already-active conversation would clear the
      // thread's messages effect deps for no reason — bail out early.
      if (activeConversationId === conversation.id) return;
      setActiveConversationId(conversation.id);
      // Record the selection on the deep-link ref BEFORE we change the
      // URL. The router.replace below flips `deepLinkConvId`, which
      // could otherwise cause the auto-select effect above to think a
      // *different* deep-link should be applied.
      autoSelectedForDeepLinkRef.current = conversation.id;
      // Reflect the selection in the URL so a refresh lands the user
      // back in the same thread, and so copy-paste links work. Use
      // replace() to avoid polluting browser history with every click.
      router.replace(`/inbox?c=${conversation.id}`, { scroll: false });
      markRead({
        conversationId: conversation.id as Id<"conversations">,
      }).catch((err) => {
        console.error("Failed to mark conversation read:", err);
      });
    },
    [activeConversationId, router, markRead],
  );

  // Mobile "back" — deselect the conversation so the list pane comes
  // back. Also clears the ?c= param so a refresh lands on the list
  // instead of re-opening the thread the user just backed out of.
  const handleCloseConversation = useCallback(() => {
    setActiveConversationId(null);
    // Clearing the ref lets the deep-link auto-selector fire again if
    // the user later visits /inbox?c=<same-id> — desirable UX.
    autoSelectedForDeepLinkRef.current = null;
    router.replace("/inbox", { scroll: false });
  }, [router]);

  // On mobile (<lg) we show a SINGLE pane — either the list or the
  // thread — rather than cramming both side-by-side. Selecting a
  // conversation slides the thread in; the thread's back button pops
  // it back to the list. On lg+ both panes render side-by-side as
  // before, unchanged.
  const hasActiveConv = !!activeConversation;

  return (
    <div className="-m-4 flex h-[calc(100vh-3.5rem)] flex-col overflow-hidden sm:-m-6">
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
        <div
          className={cn(
            "flex h-full min-w-0 flex-1 lg:flex",
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
        </div>

        {/* Right panel: Contact sidebar — desktop only, and only when the
            agent hasn't collapsed it via the thread-header toggle (#258).
            On mobile it's always hidden (the `lg:block` below), so the
            toggle — which is itself desktop-only — never affects it. */}
        {contactPanelOpen && (
          <div className="hidden lg:block">
            <ContactSidebar contact={activeContact} />
          </div>
        )}
      </div>
    </div>
  );
}
