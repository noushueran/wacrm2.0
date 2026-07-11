"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import {
  useAction,
  useConvex,
  useMutation,
  useQuery,
  usePaginatedQuery,
} from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import {
  toUiMemberProfile,
  toUiMessage,
  toUiReaction,
} from "@/lib/convex/adapters";
import { useAuth } from "@/hooks/use-auth";
import { usePresence } from "@/hooks/use-presence";
import { PresenceDot } from "@/components/presence/presence-dot";
import { presenceLabel } from "@/lib/presence";
import { cn } from "@/lib/utils";
import type {
  Conversation,
  Message,
  MessageReaction,
  Contact,
  ConversationStatus,
  MessageTemplate,
  InteractiveMessagePayload,
} from "@/types";
import {
  MessageSquare,
  ChevronDown,
  UserPlus,
  Check,
  Clock,
  ArrowLeft,
  Loader2,
  PanelRightOpen,
  PanelRightClose,
} from "lucide-react";
import { format, isToday, isYesterday, differenceInHours } from "date-fns";
import { useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MessageBubble } from "./message-bubble";
import { MessageActions } from "./message-actions";
import { MessageComposer, type SendMediaPayload } from "./message-composer";
import { deleteAccountMedia } from "@/lib/storage/upload-media";
import { TemplatePicker } from "./template-picker";
import { AiThreadBanner } from "./ai-thread-banner";
import { buildReplyPreview } from "./reply-quote";
import { toast } from "sonner";
import { canAssignToOthers } from "@/lib/auth/roles";

interface ReplyDraft {
  id: string;
  authorLabel: string;
  preview: string;
}

function renderTemplateBody(body: string, params: string[]): string {
  return body.replace(/\{\{(\d+)\}\}/g, (_, raw) => {
    const idx = Number(raw) - 1;
    return params[idx] ?? `{{${raw}}}`;
  });
}

interface MessageThreadProps {
  conversation: Conversation | null;
  contact: Contact | null;
  /**
   * On mobile, the thread is shown full-screen with the conversation list
   * hidden. This callback lets the page deselect the active conversation
   * and reveal the list again. Rendered as a back-arrow in the header on
   * mobile only.
   */
  onBack?: () => void;
  /**
   * Desktop-only contact-panel toggle. The page owns the open/closed
   * state (it's the one that renders the sidebar), so the thread just
   * reflects it and asks the page to flip it. Both optional so existing
   * callers keep working; the toggle button only renders when
   * `onToggleContactPanel` is wired up.
   */
  contactPanelOpen?: boolean;
  onToggleContactPanel?: () => void;
}

function formatDateSeparator(dateStr: string, t: ReturnType<typeof useTranslations>): string {
  const date = new Date(dateStr);
  if (isToday(date)) return t("today");
  if (isYesterday(date)) return t("yesterday");
  return format(date, "MMMM d, yyyy");
}

function groupMessagesByDate(messages: Message[]) {
  const groups: { date: string; messages: Message[] }[] = [];
  let currentDate = "";

  for (const msg of messages) {
    const day = format(new Date(msg.created_at), "yyyy-MM-dd");
    if (day !== currentDate) {
      currentDate = day;
      groups.push({ date: msg.created_at, messages: [msg] });
    } else {
      groups[groups.length - 1].messages.push(msg);
    }
  }

  return groups;
}

const STATUS_OPTIONS: { label: string; value: ConversationStatus; color: string }[] = [
  { label: "Open", value: "open", color: "text-primary" },
  { label: "Pending", value: "pending", color: "text-amber-400" },
  { label: "Closed", value: "closed", color: "text-muted-foreground" },
];

/**
 * WhatsApp-style doodle background applied to the chat area (both the
 * active thread and the empty state). The SVG tile lives at
 * `/public/inbox-doodle.svg`; the slate-950 colour sits underneath so
 * the doodles read as a subtle pattern rather than a stark grid.
 *
 * Defined once at module scope so the two render paths can't drift —
 * if we ever switch the asset, both spots update together.
 */
const DOODLE_BG_CLASSES =
  "bg-background bg-[url('/inbox-doodle.svg')] bg-repeat";

export function MessageThread({
  conversation,
  contact,
  onBack,
  contactPanelOpen,
  onToggleContactPanel,
}: MessageThreadProps) {
  const t = useTranslations("Inbox.messageThread");
  const tTimer = useTranslations("Inbox.sessionTimer");
  const tQuote = useTranslations("Inbox.replyQuote");

  const { user, accountRole } = useAuth();
  const convex = useConvex();
  const { getPresence, getRow, now } = usePresence();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [templateModalOpen, setTemplateModalOpen] = useState(false);
  const [replyTo, setReplyTo] = useState<ReplyDraft | null>(null);
  // Busy flag for the "Claim to reply" CTA only (Task 11) — the assign
  // dropdown's own items don't need one, they close on click.
  const [claiming, setClaiming] = useState(false);

  const conversationId = conversation?.id;
  const hasUnread = (conversation?.unread_count ?? 0) > 0;

  // The assign dropdown's teammate list — every member of the account,
  // via reactive `api.members.list` (the Convex counterpart to the old
  // Supabase `profiles` read), mapped to the `Profile` shape the
  // dropdown already consumes. A member added/removed elsewhere surfaces
  // here without a manual refetch.
  const memberDocs = useQuery(api.members.list);
  const profiles = useMemo(
    () => (memberDocs ?? []).map(toUiMemberProfile),
    [memberDocs],
  );

  // Messages — Convex paginated query, newest-first; reversed below for
  // chronological (oldest-first) display. "Load older messages" calls
  // `msg.loadMore`.
  const msg = usePaginatedQuery(
    api.messages.listByConversation,
    conversationId
      ? { conversationId: conversationId as Id<"conversations"> }
      : "skip",
    { initialNumItems: 30 },
  );
  const convexMessages = useMemo(
    () => msg.results.map(toUiMessage).reverse(),
    [msg.results],
  );

  // Message send now goes straight through `api.send.send` (a Convex
  // action — see the handlers below), which persists via
  // `messages.appendInternal` before returning. The reactive
  // `usePaginatedQuery` above already re-renders with the new row the
  // moment it lands, so there's no separate optimistic-bubble state to
  // maintain here anymore (Phase 8, Task 4).
  const messages = convexMessages;

  // Reactions — reactive; Convex updates the pills automatically on
  // every set/remove, no optimistic snapshot/rollback needed.
  const reactionDocs = useQuery(
    api.reactions.forConversation,
    conversationId
      ? { conversationId: conversationId as Id<"conversations"> }
      : "skip",
  );
  const reactions = (reactionDocs ?? []).map(toUiReaction);

  // 24-hour session timer
  const sessionInfo = useMemo(() => {
    if (!messages.length) return { expired: false, remaining: "" };

    // Find last customer message
    const lastCustomerMsg = [...messages]
      .reverse()
      .find((m) => m.sender_type === "customer");

    if (!lastCustomerMsg) return { expired: true, remaining: "No customer messages" };

    const hoursSince = differenceInHours(new Date(), new Date(lastCustomerMsg.created_at));
    const expired = hoursSince >= 24;

    if (expired) {
      return { expired: true, remaining: tTimer("expired") };
    }

    const hoursLeft = 24 - hoursSince;
    const remaining =
      hoursLeft >= 1
        ? tTimer("xhRemaining", { hours: Math.floor(hoursLeft) })
        : tTimer("xmRemaining", { minutes: Math.floor(hoursLeft * 60) });

    return { expired, remaining };
  }, [messages, tTimer]);

  // Reset the server-side unread_count to 0 whenever an unread count
  // surfaces on the active conversation — covers both (a) opening a
  // conversation that had unread messages and (b) new messages arriving
  // while the user is already viewing the thread (the webhook bumps
  // unread_count server-side; the reactive query pushes it into the
  // client, which re-runs this effect and flips it back to 0).
  //
  // Guarding on hasUnread prevents the eq-update loop: once unread_count
  // is 0 the condition is false, so no further mutation is issued.
  const markReadMutation = useMutation(api.conversations.markRead);
  useEffect(() => {
    if (!conversationId || !hasUnread) return;
    markReadMutation({
      conversationId: conversationId as Id<"conversations">,
    }).catch((err) => {
      console.error("Failed to reset unread_count:", err);
    });
  }, [conversationId, hasUnread, markReadMutation]);

  // Clear any in-progress reply draft when the active conversation changes —
  // a quote pulled from conversation A shouldn't bleed into conversation B.
  useEffect(() => {
    setReplyTo(null);
  }, [conversationId]);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    if (scrollRef.current) {
      const el = scrollRef.current;
      el.scrollTop = el.scrollHeight;
    }
  }, [messages]);

  const sendMessage = useAction(api.send.send);

  const handleSend = useCallback(
    async (text: string, replyToId?: string) => {
      if (!conversation) return;

      setReplyTo(null);

      try {
        await sendMessage({
          conversationId: conversation.id as Id<"conversations">,
          messageType: "text",
          contentText: text,
          replyToMessageId: replyToId as Id<"messages"> | undefined,
        });
      } catch (err) {
        console.error("Failed to send message:", err);
        const reason = err instanceof Error ? err.message : "network error";
        toast.error(`Failed to send: ${reason}`);
      }
    },
    [conversation, sendMessage]
  );

  const handleSendMedia = useCallback(
    async (payload: SendMediaPayload) => {
      if (!conversation) return;

      // Documents show their filename in our own bubble (and to the
      // recipient as the Meta caption when no caption was typed); other
      // kinds use the caption as-is. Audio carries no caption.
      const contentText =
        payload.kind === "document"
          ? payload.caption || payload.filename || "Document"
          : payload.caption;

      setReplyTo(null);

      try {
        await sendMessage({
          conversationId: conversation.id as Id<"conversations">,
          messageType: payload.kind,
          mediaUrl: payload.mediaUrl,
          contentText,
          filename: payload.filename,
          replyToMessageId: payload.replyToId as Id<"messages"> | undefined,
        });
      } catch (err) {
        console.error("Failed to send media:", err);
        const reason = err instanceof Error ? err.message : "network error";
        toast.error(`Failed to send: ${reason}`);
        // The upload never reached the recipient — GC the orphaned
        // object rather than leaving it in storage forever.
        void deleteAccountMedia(convex, payload.storageId).catch(() => {});
      }
    },
    [conversation, sendMessage, convex],
  );

  const handleSendInteractive = useCallback(
    async (payload: InteractiveMessagePayload, replyToId?: string) => {
      if (!conversation) return;

      try {
        await sendMessage({
          conversationId: conversation.id as Id<"conversations">,
          messageType: "interactive",
          interactivePayload: payload,
          replyToMessageId: replyToId as Id<"messages"> | undefined,
        });
      } catch (err) {
        console.error("Failed to send interactive message:", err);
        const reason = err instanceof Error ? err.message : "network error";
        toast.error(`Failed to send: ${reason}`);
      }
    },
    [conversation, sendMessage],
  );

  const setStatusMutation = useMutation(api.conversations.setStatus);
  const handleStatusChange = useCallback(
    async (status: ConversationStatus) => {
      if (!conversation) return;

      try {
        await setStatusMutation({
          conversationId: conversation.id as Id<"conversations">,
          status,
        });
      } catch (err) {
        console.error("Failed to update status:", err);
        toast.error("Failed to update status");
      }
    },
    [conversation, setStatusMutation]
  );

  const handleOpenTemplates = useCallback(() => {
    setTemplateModalOpen(true);
  }, []);

  const handleSendTemplate = useCallback(
    async (
      template: MessageTemplate,
      values: {
        body: string[];
        headerText?: string;
        buttonParams?: Record<number, string>;
      },
    ) => {
      if (!conversation) return;

      const renderedBody = renderTemplateBody(template.body_text, values.body);

      try {
        await sendMessage({
          conversationId: conversation.id as Id<"conversations">,
          messageType: "template",
          templateName: template.name,
          templateLanguage: template.language,
          // `api.send.send` → `metaSend.sendTemplate` only threads body
          // variables through today (mirrors `lib/whatsapp/metaApi.ts`'s
          // simplified, body-params-only sender) — there's no Convex-side
          // equivalent yet for `values.headerText`/`values.buttonParams`
          // (header text + URL-button substitution), so those are
          // dropped here rather than silently mismapped onto the wrong
          // field.
          templateParams: values.body,
          contentText: renderedBody,
        });
      } catch (err) {
        console.error("Failed to send template:", err);
        const reason = err instanceof Error ? err.message : "network error";
        toast.error(`Failed to send template: ${reason}`);
      }
    },
    [conversation, sendMessage],
  );

  // Build a quick id → Message map so reply quotes can be rendered without
  // an extra fetch — the thread already holds the full conversation.
  const messagesById = useMemo(() => {
    const map = new Map<string, Message>();
    for (const m of messages) map.set(m.id, m);
    return map;
  }, [messages]);

  // Bucket reactions by their target message_id for O(1) per-bubble lookup.
  const reactionsByMessageId = useMemo(() => {
    const map = new Map<string, MessageReaction[]>();
    for (const r of reactions) {
      const bucket = map.get(r.message_id);
      if (bucket) bucket.push(r);
      else map.set(r.message_id, [r]);
    }
    return map;
  }, [reactions]);

  const contactDisplayName = contact?.name || contact?.phone || "Customer";

  // Author label for a quoted message: "You" when we sent the parent,
  // contact name when the customer sent it.
  const authorLabelFor = useCallback(
    (m: Message): string => {
      const isAgentMsg =
        m.sender_type === "agent" || m.sender_type === "bot";
      return isAgentMsg ? "You" : contactDisplayName;
    },
    [contactDisplayName],
  );

  const handleStartReply = useCallback(
    (msg: Message) => {
      setReplyTo({
        id: msg.id,
        authorLabel: authorLabelFor(msg),
        preview: buildReplyPreview(msg, tQuote),
      });
    },
    [authorLabelFor, tQuote],
  );

  // Single reaction-set primitive. emoji === "" removes; otherwise adds/swaps.
  // The "toggle" semantic (pill click) is computed at the call site where the
  // current reactions for the bubble are already in scope — keeps this
  // function dependency-free w.r.t. the reaction list. Reactive: Convex
  // updates the pills automatically on success, no optimistic
  // snapshot/rollback needed.
  const setReactionMutation = useMutation(api.reactions.set);
  const removeReactionMutation = useMutation(api.reactions.remove);
  const reactToMetaAction = useAction(api.reactions.reactToMeta);
  const postReaction = useCallback(
    async (messageId: string, emoji: string) => {
      if (!user?.id || !conversation) {
        console.warn("[reactions] missing user or conversation");
        return;
      }

      try {
        if (emoji === "") {
          await removeReactionMutation({
            messageId: messageId as Id<"messages">,
            actorType: "agent",
            actorId: user.id,
          });
        } else {
          await setReactionMutation({
            messageId: messageId as Id<"messages">,
            emoji,
            actorType: "agent",
            actorId: user.id,
          });
        }
      } catch (err) {
        const reason = err instanceof Error ? err.message : "network error";
        toast.error(`Reaction failed: ${reason}`);
        return;
      }

      // Notify Meta best-effort. The DB row above (our own reaction
      // pill's source of truth) is already written — a Meta-side failure
      // here shouldn't roll it back, just surface a toast.
      try {
        await reactToMetaAction({
          messageId: messageId as Id<"messages">,
          emoji,
        });
      } catch (err) {
        const reason = err instanceof Error ? err.message : "network error";
        toast.error(`Failed to notify WhatsApp of the reaction: ${reason}`);
      }
    },
    // Dep is the whole `user` object (not `user?.id`) so the React
    // Compiler's inference agrees with the manual dep list — same
    // `preserve-manual-memoization` fix as `contact-sidebar.tsx`'s
    // `handleCopyPhone`.
    [
      conversation,
      user,
      setReactionMutation,
      removeReactionMutation,
      reactToMetaAction,
    ],
  );

  const assignMutation = useMutation(api.conversations.assign);
  const unassignMutation = useMutation(api.conversations.unassign);
  const handleAssignChange = useCallback(
    async (agentId: string | null) => {
      if (!conversation) return;

      if (agentId === null) {
        try {
          await unassignMutation({
            conversationId: conversation.id as Id<"conversations">,
          });
        } catch (err) {
          console.error("Failed to update assignment:", err);
          toast.error("Failed to update assignment");
        }
        return;
      }

      try {
        await assignMutation({
          conversationId: conversation.id as Id<"conversations">,
          userId: agentId as Id<"users">,
        });
      } catch (err) {
        console.error("Failed to update assignment:", err);
        toast.error("Failed to update assignment");
      }
    },
    [conversation, assignMutation, unassignMutation],
  );

  // Agent claim-to-reply (Task 11): an agent can't send in a conversation
  // they don't own — the server now rejects it — so a pool (unassigned)
  // conversation must be claimed first. Wraps `handleAssignChange` (which
  // already owns the try/catch + toast) with a local busy flag so the
  // "Claim to reply" CTA can show a spinner and guard against double-clicks.
  const handleClaim = useCallback(async () => {
    if (!user?.id) return;
    setClaiming(true);
    try {
      await handleAssignChange(user.id);
    } finally {
      setClaiming(false);
    }
  }, [user, handleAssignChange]);

  // Empty state — same WhatsApp-style doodle background as the active
  // thread below, so swapping between empty/selected doesn't change the
  // pattern under the user's eye.
  if (!conversation || !contact) {
    return (
      <div className={cn("flex flex-1 flex-col items-center justify-center", DOODLE_BG_CLASSES)}>
        <div className="flex h-16 w-16 items-center justify-center rounded-full bg-muted">
          <MessageSquare className="h-8 w-8 text-muted-foreground" />
        </div>
        <h3 className="mt-4 text-sm font-medium text-muted-foreground">
          {t("selectConversation")}
        </h3>
        <p className="mt-1 text-xs text-muted-foreground">
          {t("selectConversationHint")}
        </p>
      </div>
    );
  }

  const displayName = contact.name || contact.phone;
  const messageGroups = groupMessagesByDate(messages);
  const currentStatus = STATUS_OPTIONS.find(
    (s) => s.value === conversation.status
  );
  const assignedAgentId = conversation.assigned_agent_id ?? null;
  const currentAssignee = profiles.find((p) => p.user_id === assignedAgentId);
  const assignLabel = assignedAgentId
    ? (currentAssignee?.full_name ?? t("assigned"))
    : t("assign");
  // Claim-to-reply (Task 11): whether this conversation is the caller's
  // own vs. still sitting in the shared pool. Drives both the header
  // assign-dropdown's agent-limited actions and the composer swap below.
  const mine = assignedAgentId === user?.id;
  const isPool = !assignedAgentId;

  return (
    // `min-w-0` is load-bearing: the page already puts min-w-0 on the
    // thread's flex *wrapper* (issue #165), but this root keeps the
    // default `min-width: auto`, so a single wide message (long unbroken
    // URL/word) expands the whole thread past its flex share and the chat
    // paints on top of the contact sidebar at lg+ — outgoing bubbles get
    // clipped and the hover toolbar overlaps the Tags panel. Letting the
    // root shrink lets the bubbles' break-words / max-w caps apply.
    // Issue #257.
    <div className={cn("flex min-w-0 flex-1 flex-col", DOODLE_BG_CLASSES)}>
      {/* Header — solid card surface sits on top of the doodle so the
          name/avatar/dropdowns stay legible. */}
      <div className="flex items-center justify-between gap-2 border-b border-border bg-card px-3 py-3 sm:px-4">
        <div className="flex min-w-0 items-center gap-2 sm:gap-3">
          {/* Back-to-list button — mobile only. Hidden on lg+ where the
              conversation list is always visible next to the thread. */}
          {onBack && (
            <button
              type="button"
              onClick={onBack}
              aria-label={t("backToConversations")}
              className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground lg:hidden"
            >
              <ArrowLeft className="h-5 w-5" />
            </button>
          )}
          <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-muted text-sm font-medium text-foreground">
            {displayName.charAt(0).toUpperCase()}
          </div>
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold text-foreground">{displayName}</h2>
            <p className="truncate text-xs text-muted-foreground">{contact.phone}</p>
          </div>
          {/* Session timer badge — hidden on the narrowest phones so
              the name + back arrow keep their room. */}
          <Badge
            variant="outline"
            className={cn(
              "ml-1 hidden gap-1 border-border text-[10px] sm:inline-flex sm:ml-2",
              sessionInfo.expired ? "text-red-400" : "text-primary"
            )}
          >
            <Clock className="h-3 w-3" />
            {sessionInfo.remaining}
          </Badge>
        </div>

        <div className="flex items-center gap-2">
          {/* Contact-panel toggle — desktop only. The contact sidebar
              eats a chunk of horizontal width that crowds the thread on
              smaller laptops; this lets agents reclaim it when they just
              want to read and reply. Hidden on mobile, where the sidebar
              never renders as a permanent panel anyway. Issue #258. */}
          {onToggleContactPanel && (
            <button
              type="button"
              onClick={onToggleContactPanel}
              aria-label={
                contactPanelOpen ? t("hideContactPanel") : t("showContactPanel")
              }
              title={contactPanelOpen ? t("hideContact") : t("showContact")}
              aria-pressed={contactPanelOpen}
              className={cn(
                "hidden h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-muted hover:text-foreground lg:inline-flex",
                contactPanelOpen ? "text-primary" : "text-muted-foreground",
              )}
            >
              {contactPanelOpen ? (
                <PanelRightClose className="h-4 w-4" />
              ) : (
                <PanelRightOpen className="h-4 w-4" />
              )}
            </button>
          )}

          {/* Status dropdown */}
          <DropdownMenu>
            <DropdownMenuTrigger className={cn(
                  "inline-flex items-center justify-center h-7 gap-1 px-2 text-xs rounded-md hover:bg-muted",
                  currentStatus?.color ?? "text-muted-foreground"
                )}>
                {currentStatus ? t(`status${currentStatus.label}`) : t("status")}
                <ChevronDown className="h-3 w-3" />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              className="border-border bg-popover"
            >
              {STATUS_OPTIONS.map((opt) => (
                <DropdownMenuItem
                  key={opt.value}
                  onClick={() => handleStatusChange(opt.value)}
                  className={cn("text-sm", opt.color)}
                >
                  {t(`status${opt.label}`)}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Assign dropdown — supervisor+ keeps the full teammate picker.
              An agent gets self-serve Claim/Release only: the server now
              rejects an agent assigning to anyone but themselves (Task 11).
              A viewer gets no assign control at all — view-only, can't
              assign/claim/release. */}
          {accountRole !== "viewer" && (
            <DropdownMenu>
              <DropdownMenuTrigger
                className={cn(
                  "inline-flex items-center justify-center h-7 gap-1 px-2 text-xs rounded-md hover:bg-muted",
                  assignedAgentId ? "text-primary" : "text-muted-foreground"
                )}
              >
                <UserPlus className="h-3 w-3" />
                <span className="hidden sm:inline">{assignLabel}</span>
                <ChevronDown className="h-3 w-3" />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                className="border-border bg-popover"
              >
                {accountRole && canAssignToOthers(accountRole) ? (
                  <>
                    {profiles.length === 0 ? (
                      <DropdownMenuItem disabled className="text-sm text-muted-foreground">
                        {t("noTeammates")}
                      </DropdownMenuItem>
                    ) : (
                      profiles.map((p) => {
                        const isSelected = p.user_id === assignedAgentId;
                        const presence = getPresence(p.user_id);
                        return (
                          <DropdownMenuItem
                            key={p.id}
                            onClick={() => handleAssignChange(p.user_id)}
                            className={cn(
                              "text-sm",
                              isSelected ? "text-primary" : "text-popover-foreground"
                            )}
                          >
                            <PresenceDot
                              status={presence}
                              label={presenceLabel(
                                presence,
                                getRow(p.user_id)?.last_seen_at ?? null,
                                now
                              )}
                              className="mr-2"
                            />
                            <span className="flex-1">
                              {p.full_name}
                              {p.user_id === user?.id ? t("me") : ""}
                            </span>
                            {isSelected && <Check className="ml-2 h-3 w-3" />}
                          </DropdownMenuItem>
                        );
                      })
                    )}
                    {assignedAgentId && (
                      <>
                        <DropdownMenuSeparator className="bg-border" />
                        <DropdownMenuItem
                          onClick={() => handleAssignChange(null)}
                          className="text-sm text-muted-foreground"
                        >
                          {t("unassign")}
                        </DropdownMenuItem>
                      </>
                    )}
                  </>
                ) : mine ? (
                  // Agent, theirs: release back to the pool.
                  <DropdownMenuItem
                    onClick={() => handleAssignChange(null)}
                    className="text-sm text-popover-foreground"
                  >
                    {t("release")}
                  </DropdownMenuItem>
                ) : (
                  // Agent, unassigned (a colleague's conversation is never
                  // reachable here — the inbox scope already hides it):
                  // self-claim only.
                  <DropdownMenuItem
                    disabled={!isPool || !user?.id}
                    onClick={() => user?.id && handleAssignChange(user.id)}
                    className="text-sm text-popover-foreground"
                  >
                    {t("claim")}
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>

      {/* Messages Area */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4">
        {msg.status === "LoadingFirstPage" ? (
          <div className="flex items-center justify-center py-12">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          </div>
        ) : messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12">
            <p className="text-sm text-muted-foreground">{t("noMessagesYet")}</p>
            <p className="text-xs text-muted-foreground">
              {t("sendTemplateHint")}
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {/* Load older messages — cursor-paginated via Convex;
                `msg.loadMore` fetches the next (older) page. */}
            {msg.status === "CanLoadMore" && (
              <div className="flex justify-center pb-2">
                <button
                  type="button"
                  onClick={() => msg.loadMore(30)}
                  className="rounded-md px-3 py-1.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  Load older messages
                </button>
              </div>
            )}
            {msg.status === "LoadingMore" && (
              <div className="flex justify-center pb-2">
                <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
              </div>
            )}
            {messageGroups.map((group) => (
              <div key={group.date}>
                {/* Date separator */}
                <div className="mb-4 flex items-center justify-center">
                  <span className="rounded-full bg-muted px-3 py-1 text-[10px] font-medium text-muted-foreground">
                    {formatDateSeparator(group.date, t)}
                  </span>
                </div>
                {/* Messages */}
                <div className="space-y-2">
                  {group.messages.map((msg) => {
                    const parent = msg.reply_to_message_id
                      ? messagesById.get(msg.reply_to_message_id)
                      : null;
                    const reply = parent
                      ? {
                          authorLabel:
                            parent.sender_type === "agent" || parent.sender_type === "bot"
                              ? t("me")
                              : contact?.name || contact?.phone || "Unknown",
                          preview: buildReplyPreview(parent, tQuote),
                        }
                      : null;
                    const msgReactions = reactionsByMessageId.get(msg.id);
                    // Toggle is computed at the call site — `msgReactions`
                    // and `user?.id` are already in scope, no extra hook.
                    const handlePillToggle = (emoji: string) => {
                      const own = msgReactions?.find(
                        (r) =>
                          r.actor_type === "agent" &&
                          r.actor_id === user?.id,
                      );
                      const next = own?.emoji === emoji ? "" : emoji;
                      void postReaction(msg.id, next);
                    };
                    return (
                      <MessageActions
                        key={msg.id}
                        message={msg}
                        onReply={() => handleStartReply(msg)}
                        onReact={(emoji) => {
                          if (emoji) void postReaction(msg.id, emoji);
                        }}
                      >
                        <MessageBubble
                          message={msg}
                          reply={reply}
                          reactions={msgReactions}
                          currentUserId={user?.id}
                          onToggleReaction={handlePillToggle}
                        />
                      </MessageActions>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* AI auto-reply banner — take over an active bot, or resume it
          after a handoff. Renders nothing unless the account has
          auto-reply configured. Hidden entirely for viewers: both
          "Take over" and "Resume AI" are assign-class writes, and a
          viewer may not assign/claim/release (Task 11). */}
      {accountRole !== "viewer" && (
        <AiThreadBanner
          conversationId={conversation.id}
          disabled={conversation.ai_autoreply_disabled ?? false}
          handoffSummary={conversation.ai_handoff_summary}
          assignedAgentId={assignedAgentId}
          currentUserId={user?.id}
          onChange={(patch) => {
            if ("assigned_agent_id" in patch) {
              void handleAssignChange(patch.assigned_agent_id ?? null);
            }
          }}
        />
      )}

      {/* Composer / claim-to-reply / read-only notice — role-gated
          (Task 11). An agent viewing a pool conversation that isn't
          theirs yet can't send (the server now rejects it) — they get a
          Claim CTA instead, and the real composer returns reactively
          once they own it. A viewer never gets a composer at all.
          Supervisor/admin/owner and an agent on their own conversation
          get the normal composer, whose own `canSend` gate (unchanged)
          covers everything else. */}
      {accountRole === "viewer" ? (
        <ViewerComposerNotice t={t} />
      ) : accountRole === "agent" && !mine ? (
        <ClaimToReplyBar
          disabled={!isPool || !user?.id}
          claiming={claiming}
          onClaim={handleClaim}
          t={t}
        />
      ) : (
        <MessageComposer
          conversationId={conversation.id}
          sessionExpired={sessionInfo.expired}
          onSend={handleSend}
          onSendMedia={handleSendMedia}
          onSendInteractive={handleSendInteractive}
          onOpenTemplates={handleOpenTemplates}
          replyTo={replyTo}
          onClearReply={() => setReplyTo(null)}
        />
      )}

      <TemplatePicker
        open={templateModalOpen}
        onOpenChange={setTemplateModalOpen}
        onSelect={handleSendTemplate}
      />
    </div>
  );
}

/**
 * Replaces the composer for an agent viewing a pool conversation that
 * isn't theirs yet (Task 11 claim-to-reply) — the server rejects a send
 * until they own it. Claiming re-renders this away reactively once
 * `conversation.assigned_agent_id` flips to the caller's id. Declared at
 * module scope (not nested in `MessageThread`) so it doesn't remount on
 * every parent re-render, matching `message-composer.tsx`'s
 * `MediaDraftPreview` pattern.
 */
function ClaimToReplyBar({
  disabled,
  claiming,
  onClaim,
  t,
}: {
  disabled: boolean;
  claiming: boolean;
  onClaim: () => void;
  t: ReturnType<typeof useTranslations>;
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-t border-border bg-card p-3">
      <p className="text-sm text-muted-foreground">{t("claimHint")}</p>
      <Button
        type="button"
        size="sm"
        disabled={disabled || claiming}
        onClick={onClaim}
        className="shrink-0"
      >
        {claiming ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <UserPlus className="h-3.5 w-3.5" />
        )}
        {t("claimToReply")}
      </Button>
    </div>
  );
}

/** Replaces the composer for a viewer — read-only, never sends. */
function ViewerComposerNotice({
  t,
}: {
  t: ReturnType<typeof useTranslations>;
}) {
  return (
    <div className="border-t border-border bg-card p-3">
      <p className="text-sm text-muted-foreground">{t("viewerNotice")}</p>
    </div>
  );
}
