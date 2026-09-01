"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useAction, useConvex, useMutation } from "convex/react";
// Cached variants — keep each per-conversation subscription
// (messages.listByConversation, reactions.forConversation) warm for a few
// minutes after the thread switches away, so re-opening a recently-viewed
// chat paints instantly instead of paying another cold round-trip to the
// self-hosted Convex backend. Mutations/actions stay on `convex/react`.
import { useQuery, usePaginatedQuery } from "@/lib/convex/cached";
import type { FunctionReturnType } from "convex/server";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { ThreadHeader } from "@/components/inbox/thread-header";
import {
  toUiMemberProfile,
  toUiMessage,
  toUiReaction,
  toUiTagGroup,
} from "@/lib/convex/adapters";
import { tagChipRow } from "@/lib/inbox/labels";
import { splitEarlierNotes, mergeTimelineEntries } from "@/lib/inbox/notes";
import { NoteCard } from "./note-card";
import { AssignmentEvent } from "./assignment-event";
import { OptionalFeatureBoundary } from "./optional-feature-boundary";
import { NoteComposer } from "./note-composer";
import { DoNotContactBanner } from "./do-not-contact-banner";
import { LeadQualityCard } from "@/components/inbox/lead-quality-card";
import { useAuth } from "@/hooks/use-auth";
import { usePresence } from "@/hooks/use-presence";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/dashboard/skeleton";
import {
  INITIAL_MESSAGE_PAGE_SIZE,
  messageAreaState,
  overrideControls,
} from "@/lib/inbox/view";
import {
  formatWindowRemaining,
  resolveConversationWindows,
} from "@/lib/inbox/messagingWindow";
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
  UserPlus,
  Loader2,
  BadgeCheck,
} from "lucide-react";
import { format, isToday, isYesterday } from "date-fns";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { MessageBubble } from "./message-bubble";
import { MessageActions } from "./message-actions";
import { MessageComposer, type SendMediaPayload } from "./message-composer";
import { deleteAccountMedia } from "@/lib/storage/upload-media";
import { TemplatePicker } from "./template-picker";
import { AiThreadBanner } from "./ai-thread-banner";
import { buildReplyPreview } from "./reply-quote";
import { toast } from "sonner";
import { canAssignToOthers, hasMinRole } from "@/lib/auth/roles";
import { UI_FUNNEL_STAGES } from "@/lib/inbox/funnel";
import { LossReasonDialog } from "@/components/leads/loss-reason-dialog";
import { convexErrorData } from "@/lib/convex/adapters";
// Pure type only — `convex/lib/inbox/overrides.ts` has no server-only
// import of its own (no `ctx`/`db` reference), so it's safe to pull a
// type from it into client code, same precedent as
// `src/lib/inbox/messagingWindow.ts` importing from
// `convex/lib/whatsapp/messagingWindow`.
import type { SnoozePreset } from "../../../convex/lib/inbox/overrides";

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
  /**
   * Puts this thread's unread badge back — the escape hatch for opening
   * the wrong chat, since simply rendering here already marked it read
   * (see the `markRead` effect below). The page owns it because
   * restoring the badge only sticks if the thread is closed in the same
   * breath; this component just offers the control.
   */
  onMarkUnread?: (conversationId: string) => void;
}

/**
 * `null` for an empty `dateStr` — the shape `mergeTimelineEntries`
 * (`src/lib/inbox/notes.ts`) hands back for a note-only group when the
 * conversation has no messages at all: there is no meaningful date to
 * show for it, and `new Date("")` is an Invalid Date that `date-fns`'s
 * `format` throws `RangeError: Invalid time value` on. The caller must
 * skip rendering the separator entirely on `null` rather than falling
 * back to some placeholder string — that would print the same wrong
 * label for every note-only conversation.
 */
function formatDateSeparator(
  dateStr: string,
  t: ReturnType<typeof useTranslations>,
): string | null {
  if (!dateStr) return null;
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

/** One conversation's ownership handovers, exactly as
 *  `conversations.listEvents` projects them. */
type ThreadEvents = FunctionReturnType<typeof api.conversations.listEvents>;

/**
 * Renders nothing. Its only job is running `conversations.listEvents` and
 * lifting the result up to `MessageThread` — isolating the subscription
 * (and its potential throw) in a component of its own so
 * `OptionalFeatureBoundary` can catch it. That isolation is the whole
 * point: `useQuery` rethrows a query error during the render of whatever
 * component CALLS it, so leaving the hook in `MessageThread` and wrapping
 * the pills in a boundary would catch nothing and a missing backend
 * function would take the Inbox route down. Same shape (and the same
 * reason) as `DeepLinkFallbackFetcher` in
 * `src/app/(dashboard)/inbox/page.tsx`.
 */
function ThreadEventsFetcher({
  conversationId,
  onResolved,
}: {
  conversationId: Id<"conversations">;
  onResolved: (state: { conversationId: string; docs: ThreadEvents }) => void;
}) {
  const events = useQuery(api.conversations.listEvents, { conversationId });
  useEffect(() => {
    if (events) onResolved({ conversationId, docs: events });
  }, [events, conversationId, onResolved]);
  return null;
}

export function MessageThread({
  conversation,
  contact,
  onBack,
  contactPanelOpen,
  onToggleContactPanel,
  onMarkUnread,
}: MessageThreadProps) {
  const t = useTranslations("Inbox.messageThread");
  const tTimer = useTranslations("Inbox.sessionTimer");
  const tWindow = useTranslations("Inbox.messagingWindow");
  const tQuote = useTranslations("Inbox.replyQuote");
  const tNotes = useTranslations("Inbox.notes");

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
  const contactId = contact?.id;
  const hasUnread = (conversation?.unread_count ?? 0) > 0;

  const tFunnel = useTranslations("Inbox.funnel");
  const funnelState = useQuery(
    api.funnel.getState,
    conversationId ? { conversationId: conversationId as Id<"conversations"> } : "skip",
  );
  const setStageMutation = useMutation(api.funnel.setStage);
  const [purchaseOpen, setPurchaseOpen] = useState(false);
  const [purchaseAmount, setPurchaseAmount] = useState("");
  const [lossOpen, setLossOpen] = useState(false);

  // Custom-snooze dialog state (Task 7) — the one preset that needs a
  // form rather than a single click. `customSnoozeDateTime` holds the
  // raw `datetime-local` input value (browser-local wall time); resolved
  // to epoch ms only at confirm time, matching every other timestamp on
  // this page being computed at the point of use rather than kept as a
  // Date object in state.
  const [snoozeCustomOpen, setSnoozeCustomOpen] = useState(false);
  const [customSnoozeDateTime, setCustomSnoozeDateTime] = useState("");
  const [customSnoozeReason, setCustomSnoozeReason] = useState("");

  const applyStage = useCallback(
    async (
      stage: string,
      extras?: { saleValue?: number; lossCategory?: string; lossDetail?: string },
    ) => {
      if (!conversation) return;
      try {
        await setStageMutation({
          conversationId: conversation.id as Id<"conversations">,
          stage: stage as never,
          ...(extras?.saleValue !== undefined ? { saleValue: extras.saleValue } : {}),
          ...(extras?.lossCategory ? { lossCategory: extras.lossCategory } : {}),
          ...(extras?.lossDetail ? { lossDetail: extras.lossDetail } : {}),
        });
      } catch (err) {
        console.error("Failed to update stage:", err);
        // The won-gate: the sales checklist must be complete first.
        toast.error(
          convexErrorData(err)?.reason === "checklist_incomplete"
            ? tFunnel("checklistIncomplete")
            : tFunnel("updateError"),
        );
      }
    },
    [conversation, setStageMutation, tFunnel],
  );

  const handleStageSelect = useCallback(
    (stage: string) => {
      const def = UI_FUNNEL_STAGES.find((s) => s.key === stage);
      if (def?.needsValue) {
        setPurchaseAmount("");
        setPurchaseOpen(true);
        return;
      }
      if (def?.terminal) {
        // Losing demands the exact reason — same dialog as the pipeline.
        setLossOpen(true);
        return;
      }
      void applyStage(stage);
    },
    [applyStage],
  );

  // The assign dropdown's teammate list — every member of the account,
  // via reactive `api.members.list` (the Convex counterpart to the old
  // Supabase `profiles` read), mapped to the `Profile` shape the
  // dropdown already consumes. A member added/removed elsewhere surfaces
  // here without a manual refetch.
  const memberDocs = useQuery(api.members.list);
  const groupDocs = useQuery(api.tagGroups.list);
  const groups = useMemo(
    () => (groupDocs ?? []).map(toUiTagGroup),
    [groupDocs],
  );
  const profiles = useMemo(
    () => (memberDocs ?? []).map(toUiMemberProfile),
    [memberDocs],
  );

  // Do-not-contact banner (Task 10, spec 2026-07-30-conversation-notes-
  // p3): Tasks 4-8 make auto-reply, follow-ups, broadcasts and
  // auto-assignment silently stop for a flagged contact — this is the
  // visible half. `canClearDoNotContact` mirrors `clearDoNotContact`'s
  // own `requireRole("supervisor")` floor (a stricter gate than the
  // agent+ checks above, because clearing overrides something the
  // CUSTOMER asked for), the same client-check-is-a-display-concern
  // pattern as `canStopChasing`/`canArchive` below. `doNotContactByName`
  // resolves against `profiles` (already loaded for the assign
  // dropdown) instead of adding a query just for a name — `null` when
  // the setting member isn't found (e.g. removed from the account),
  // and the banner falls back to its date-only copy.
  const canClearDoNotContact =
    !!accountRole && hasMinRole(accountRole, "supervisor");
  const doNotContactByName = useMemo(() => {
    const byUserId = contact?.do_not_contact?.byUserId;
    if (!byUserId) return null;
    return profiles.find((p) => p.user_id === byUserId)?.full_name ?? null;
  }, [contact?.do_not_contact?.byUserId, profiles]);

  // Messages — Convex paginated query, newest-first; reversed below for
  // chronological (oldest-first) display. "Load older messages" calls
  // `msg.loadMore`.
  const msg = usePaginatedQuery(
    api.messages.listByConversation,
    conversationId
      ? { conversationId: conversationId as Id<"conversations"> }
      : "skip",
    { initialNumItems: INITIAL_MESSAGE_PAGE_SIZE },
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

  // Grouped by date — feeds both the date separators below and the notes
  // merge (`timelineGroups`). Computed here rather than after the
  // `!conversation || !contact` early return further down: the merge
  // lives in a `useMemo`, which (like every hook) must run
  // unconditionally on every render, so its inputs can't wait on a
  // conditional return either.
  const messageGroups = useMemo(() => groupMessagesByDate(messages), [messages]);

  // Notes — reactive, oldest-first (Task 5's `listForConversation`).
  const noteDocs = useQuery(
    api.contactNotes.listForConversation,
    conversationId
      ? { conversationId: conversationId as Id<"conversations"> }
      : "skip",
  );
  const removeNoteMutation = useMutation(api.contactNotes.remove);

  // Ownership handovers — reactive, oldest-first
  // (`conversations.listEvents`), but subscribed by `ThreadEventsFetcher`
  // under an error boundary further down rather than here, so a thread
  // never goes down over a backend function the deployment doesn't have
  // yet. The conversation id is stored beside the rows and re-checked on
  // read: without it, a thread switch would paint the PREVIOUS thread's
  // handovers until the new subscription resolved.
  const [eventsState, setEventsState] = useState<{
    conversationId: string;
    docs: ThreadEvents;
  } | null>(null);
  // `eventsState &&` before the comparison, not `?.`: with no state and
  // no open conversation both sides would be `undefined` and match — the
  // same false positive the note-ownership checks below guard against.
  const eventDocs =
    eventsState && eventsState.conversationId === conversationId
      ? eventsState.docs
      : undefined;

  // Notes and ownership events render inline so the thread reads as one
  // story. `messageGroups` keeps owning date bucketing and its
  // separators; the merge only places entries inside groups it produced.
  const { earlierCount, earlierEventCount, timelineGroups } = useMemo(() => {
    const oldest = messageGroups[0]?.messages[0];
    const oldestAt = oldest ? new Date(oldest.created_at).getTime() : null;
    const notes = splitEarlierNotes(noteDocs ?? [], oldestAt);
    const events = splitEarlierNotes(eventDocs ?? [], oldestAt);
    return {
      earlierCount: notes.earlier.length + events.earlier.length,
      // Kept apart from the total so the pill can pick an honest
      // sentence: "N earlier notes and updates" is a lie for a thread
      // whose earlier rows are all notes — the common case.
      earlierEventCount: events.earlier.length,
      // Explicit type arguments: given one array literal that mixes
      // "note" and "event" tagged entries, TS's inference for the union
      // parameter `TimelineEntry<N, E>` doesn't keep N and E separate per
      // element — it collapses both onto the same (note-shaped) candidate,
      // so the "event" literal then fails to type-check against a
      // `value` typed for notes. Naming N and E from each source's own
      // `inWindow` result sidesteps that inference gap.
      timelineGroups: mergeTimelineEntries<
        Message,
        (typeof notes.inWindow)[number],
        (typeof events.inWindow)[number],
        (typeof messageGroups)[number]
      >(
        messageGroups,
        [
          ...notes.inWindow.map((value) => ({ type: "note" as const, value })),
          ...events.inWindow.map((value) => ({ type: "event" as const, value })),
        ],
        (m: Message) => new Date(m.created_at).getTime(),
      ),
    };
  }, [noteDocs, eventDocs, messageGroups]);

  // Delete is wired for real (author-or-admin gated server-side by
  // `contactNotes.remove`). Edit is Phase 2 — no editor UI exists yet, so
  // `onEdit` is simply not passed to `NoteCard` below, which omits the
  // Edit menu item entirely rather than rendering one that no-ops.
  const handleDeleteNote = useCallback(
    async (noteId: string) => {
      try {
        await removeNoteMutation({ noteId: noteId as Id<"contactNotes"> });
      } catch {
        toast.error(tNotes("deleteFailed"));
      }
    },
    [removeNoteMutation, tNotes],
  );

  // Both messaging windows tick down while the thread is open, so the
  // countdowns stay honest without a reload. A minute of granularity is
  // all the labels render, so 30s keeps them accurate at half the cost of
  // a per-second timer.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  // Meta runs TWO independent clocks and this resolves both from one shared
  // source of truth (`convex/lib/whatsapp/messagingWindow.ts`):
  //   - the 24h customer service window decides whether a free-form message
  //     may be sent at all;
  //   - the 72h free-entry-point window decides whether messages are FREE.
  // They are not nested: a conversation can be template-only AND free.
  const windows = useMemo(
    () =>
      resolveConversationWindows({
        conversation: conversation ?? {},
        messages,
        now: nowMs,
      }),
    [conversation, messages, nowMs],
  );

  // 24-hour session timer. `windows.csw` already accounts for
  // `last_inbound_at`, falling back to the loaded thread for older rows.
  const sessionInfo = useMemo(() => {
    if (!messages.length) return { expired: false, remaining: "" };

    const hasCustomerMessage = messages.some((m) => m.sender_type === "customer");
    if (!hasCustomerMessage) {
      return { expired: true, remaining: tTimer("noCustomerMessages") };
    }

    if (!windows.csw.open) {
      return { expired: true, remaining: tTimer("expired") };
    }

    const hoursLeft = windows.csw.remainingMs / (60 * 60 * 1000);
    const remaining =
      hoursLeft >= 1
        ? tTimer("xhRemaining", { hours: Math.floor(hoursLeft) })
        : tTimer("xmRemaining", {
            minutes: Math.max(1, Math.floor(hoursLeft * 60)),
          });

    return { expired: false, remaining };
  }, [messages, tTimer, windows.csw.open, windows.csw.remainingMs]);

  // 72h free-entry-point countdown. Rendered whenever the window is open —
  // deliberately NOT gated on the 24h window having expired, which is what
  // previously hid it for every freshly-active ad lead.
  const freeWindowRemaining = windows.fep.open
    ? formatWindowRemaining(windows.fep.remainingMs)
    : null;

  // Time left to reply and still unlock the free window. Only set while
  // this is an unanswered ad lead inside the 24h deadline.
  const unlockRemaining =
    windows.unlockRemainingMs !== null
      ? formatWindowRemaining(windows.unlockRemainingMs)
      : null;

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
          mediaKey: payload.mediaKey,
          contentText,
          filename: payload.filename,
          replyToMessageId: payload.replyToId as Id<"messages"> | undefined,
        });
      } catch (err) {
        console.error("Failed to send media:", err);
        const reason = err instanceof Error ? err.message : "network error";
        toast.error(`Failed to send: ${reason}`);
        // The upload never reached the recipient — GC the orphaned
        // object rather than leaving it in the bucket forever.
        void deleteAccountMedia(convex, payload.mediaKey).catch(() => {});
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

  // Stop chasing (Task 7, spec 2026-07-27-inbox-lanes): pull a lead out
  // of the automated follow-up sequence by hand. Agent+ — matches
  // `leadAnalysis.stopSequence`'s own `requireRole("agent")` (Task 5
  // lowered this from supervisor+, same as `leadAnalysis.archive`/
  // `restore`) — computed the same way `inbox/page.tsx`'s `canRestore`
  // and `lead-analysis/page.tsx`'s `canArchive` are (client check is a
  // display concern only; the server call is the real gate).
  const canStopChasing = !!accountRole && hasMinRole(accountRole, "agent");
  const stopSequenceMutation = useMutation(api.leadAnalysis.stopSequence);
  const handleStopChasing = useCallback(async () => {
    if (!conversation) return;
    try {
      await stopSequenceMutation({
        conversationId: conversation.id as Id<"conversations">,
      });
    } catch (err) {
      console.error("Failed to stop chasing this conversation:", err);
      toast.error(t("stopChasingFailed"));
    }
  }, [conversation, stopSequenceMutation, t]);

  /**
   * Archive from the Inbox. P2 shipped `leadAnalysis.archive` and wired
   * it to the Lead Analysis board, and shipped Restore to this app's
   * archived banner — but never wired Archive itself into the Inbox, so
   * the only way to shelve a thread was to leave the screen you work in
   * and find it on the board. Reported 2026-07-28.
   *
   * Same agent+ gate as `handleStopChasing` above and as
   * `inbox/page.tsx`'s `canRestore`, for the same reason: the client
   * check is a display concern, `requireRole("agent")` on the mutation
   * is the real gate.
   *
   * Deliberately available on EVERY lane, not just Chasing. The single
   * most common reason to archive is a wrong number or a spam message,
   * and those arrive in Active — see the spec's §Manual archive
   * short-circuits the ladder.
   */
  const canArchive = !!accountRole && hasMinRole(accountRole, "agent");
  const archiveMutation = useMutation(api.leadAnalysis.archive);
  const handleArchive = useCallback(async () => {
    if (!conversation) return;
    try {
      await archiveMutation({
        conversationId: conversation.id as Id<"conversations">,
      });
      toast.success(t("archivedToast"));
    } catch (err) {
      console.error("Failed to archive this conversation:", err);
      toast.error(t("archiveFailed"));
    }
  }, [conversation, archiveMutation, t]);

  /**
   * Manual lane overrides (Task 7, spec 2026-07-28-inbox-manual-
   * overrides): Snooze parks a thread until a wake time; Chase now marks
   * a lead ghosted by moving it into Chasing by hand. Same agent+ gate
   * as `handleArchive`/`handleStopChasing` above — the client check is a
   * display concern only, `requireRole("agent")` on each
   * `inboxOverrides.ts` mutation is the real gate.
   *
   * Both actions hide the thread from wherever the agent is currently
   * looking (a snoozed thread drops out of every lane but Snoozed; a
   * forced-Chasing thread jumps out of Active/Waiting into Chasing), so
   * a misclick is otherwise only recoverable by hunting through a tab —
   * hence the Undo action on each success toast, wired to the inverse
   * mutation (`wake`/`unforceChasing`).
   *
   * WHICH of the three controls to show is decided by `overrideControls`
   * in `@/lib/inbox/view` rather than inline here — every "false" it
   * returns mirrors a rejection in `convex/inboxOverrides.ts`, so the
   * rules are the load-bearing part and belong somewhere testable
   * (this component is not statically renderable; that module is).
   */
  const overrides = overrideControls(
    !!accountRole && hasMinRole(accountRole, "agent"),
    // `?? {}` for the no-conversation-selected render, matching the
    // `conversation ?? {}` this file already uses above.
    conversation ?? {},
  );

  const wakeMutation = useMutation(api.inboxOverrides.wake);
  const handleWake = useCallback(async () => {
    if (!conversation) return;
    try {
      await wakeMutation({
        conversationId: conversation.id as Id<"conversations">,
      });
    } catch (err) {
      // No dedicated copy for this failure (it's reached either from the
      // "Wake now" button or as the Undo on a snooze toast, neither the
      // primary action) — plain string, same convention
      // `handleAssignChange`/`handleStatusChange` above already use for
      // their own secondary-action failures.
      console.error("Failed to wake this conversation:", err);
      toast.error("Failed to wake this conversation");
    }
  }, [conversation, wakeMutation]);

  const unforceChasingMutation = useMutation(api.inboxOverrides.unforceChasing);
  const handleUnforceChasing = useCallback(async () => {
    if (!conversation) return;
    try {
      await unforceChasingMutation({
        conversationId: conversation.id as Id<"conversations">,
      });
    } catch (err) {
      // Same "no dedicated copy for a secondary action" reasoning as
      // `handleWake` above — this only ever runs as the Undo on a
      // Chase-now toast.
      console.error("Failed to undo Chase now:", err);
      toast.error("Failed to undo Chase now");
    }
  }, [conversation, unforceChasingMutation]);

  const snoozeMutation = useMutation(api.inboxOverrides.snooze);
  const handleSnooze = useCallback(
    async (
      choice: { preset: SnoozePreset } | { customMs: number },
      reason?: string,
    ) => {
      if (!conversation) return;
      try {
        const until = await snoozeMutation({
          conversationId: conversation.id as Id<"conversations">,
          ...("preset" in choice
            ? { preset: choice.preset }
            : { customMs: choice.customMs }),
          ...(reason ? { reason } : {}),
        });
        toast.success(
          t("snoozedToast", { when: format(new Date(until), "MMM d, h:mm a") }),
          { action: { label: t("undo"), onClick: () => void handleWake() } },
        );
      } catch (err) {
        console.error("Failed to snooze this conversation:", err);
        toast.error(t("snoozeFailed"));
      }
    },
    [conversation, snoozeMutation, t, handleWake],
  );

  const forceChasingMutation = useMutation(api.inboxOverrides.forceChasing);
  const handleChaseNow = useCallback(async () => {
    if (!conversation) return;
    try {
      await forceChasingMutation({
        conversationId: conversation.id as Id<"conversations">,
      });
      toast.success(t("chasedToast"), {
        action: { label: t("undo"), onClick: () => void handleUnforceChasing() },
      });
    } catch (err) {
      console.error("Failed to move this conversation to Chasing:", err);
      toast.error(t("chaseNowFailed"));
    }
  }, [conversation, forceChasingMutation, t, handleUnforceChasing]);

  // Confirm handler for the custom-snooze dialog — the datetime-local
  // input's value is interpreted as browser-local wall time by `Date`,
  // same as every other client-side timestamp construction in this app.
  const handleConfirmCustomSnooze = useCallback(() => {
    if (!customSnoozeDateTime) return;
    const ms = new Date(customSnoozeDateTime).getTime();
    if (!Number.isFinite(ms)) return;
    setSnoozeCustomOpen(false);
    void handleSnooze({ customMs: ms }, customSnoozeReason.trim() || undefined);
    setCustomSnoozeDateTime("");
    setCustomSnoozeReason("");
  }, [customSnoozeDateTime, customSnoozeReason, handleSnooze]);

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
  // they don't own — `send.send` enforces this server-side (per-
  // conversation "own" access via `canAccessConversation`, RBAC final
  // review) — so a pool (unassigned) conversation must be claimed
  // first. Wraps `handleAssignChange` (which already owns the
  // try/catch + toast) with a local busy flag so the "Claim to reply"
  // CTA can show a spinner and guard against double-clicks.
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
  const headerChips = tagChipRow(groups, contact.tags ?? [], 6);
  // Cold first-page load → skeleton (not a blank spinner); loaded-but-empty
  // → empty state; otherwise the message list. A re-visited conversation is
  // served from the query cache, so `area` is "list" immediately and the
  // skeleton never flashes. See `messageAreaState` for the exact rules.
  const area = messageAreaState(msg.status, messages.length);
  const currentStatus = STATUS_OPTIONS.find(
    (s) => s.value === conversation.status
  );
  const assignedAgentId = conversation.assigned_agent_id ?? null;
  const currentAssignee = profiles.find((p) => p.user_id === assignedAgentId);
  // Claim-to-reply (Task 11): whether this conversation is the caller's
  // own vs. still sitting in the shared pool. Drives both the header
  // assign-dropdown's agent-limited actions and the composer swap below.
  const mine = assignedAgentId === user?.id;
  const isPool = !assignedAgentId;
  // Viewers are read-only in the thread (Task 11 parity with the status /
  // assign controls above): they can see reactions but not add or toggle
  // them — reactions.set/remove require requireRole("agent"). Threaded into
  // the message toolbar (hides the add-reaction button) and the pills
  // (rendered non-interactive) so a viewer never gets a control that would
  // only fail server-side.
  const canReact = accountRole !== "viewer";

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
      {/* Renders no DOM — the ownership-events subscription, isolated so
          its failure costs the pills and nothing else. Keyed by
          conversation so a caught error doesn't stick to every later
          thread, the same reason the Inbox page keys its own boundary. */}
      {conversationId && (
        <OptionalFeatureBoundary
          key={conversationId}
          feature="conversations.listEvents"
        >
          <ThreadEventsFetcher
            conversationId={conversationId as Id<"conversations">}
            onResolved={setEventsState}
          />
        </OptionalFeatureBoundary>
      )}
      <ThreadHeader
        displayName={displayName}
        phone={contact.phone}
        photoUrl={contact.avatar_url}
        onBack={onBack}
        onToggleContactPanel={onToggleContactPanel}
        contactPanelOpen={contactPanelOpen}

        sessionRemaining={sessionInfo.remaining}
        sessionExpired={sessionInfo.expired}
        freeText={
          freeWindowRemaining
            ? tWindow("freeBadge", { remaining: freeWindowRemaining })
            : null
        }
        freeTitle={
          freeWindowRemaining
            ? tWindow(
                windows.fep.source === "meta"
                  ? "freeBadgeTitle"
                  : "freeBadgeEstimatedTitle",
                { remaining: freeWindowRemaining },
              )
            : undefined
        }

        status={currentStatus ?? null}
        statusOptions={STATUS_OPTIONS}
        onStatusChange={(v) => handleStatusChange(v as ConversationStatus)}
        canEditStatus={accountRole !== "viewer"}

        canEditLead={accountRole !== "viewer"}
        conversationId={conversationId ? (conversationId as Id<"conversations">) : null}
        currentStage={funnelState?.currentStage ?? null}
        stageLabel={
          funnelState?.currentStage
            ? tFunnel(`stage.${funnelState.currentStage}`)
            : null
        }
        onStageSelect={handleStageSelect}
        profiles={profiles}
        assignedAgentId={assignedAgentId}
        assigneeName={currentAssignee?.full_name ?? null}
        currentUserId={user?.id ?? null}
        canAssignToOthers={!!accountRole && canAssignToOthers(accountRole)}
        mine={mine}
        isPool={isPool}
        onAssignChange={handleAssignChange}
        getPresence={getPresence}
        getLastSeenAt={(id) => getRow(id)?.last_seen_at ?? null}
        now={now}
        isAdLead={!!conversation.ad_referral}
        tags={headerChips.visible}
        tagOverflow={headerChips.overflow}

        showSnooze={overrides.snooze}
        showWake={overrides.wake}
        onSnoozeThreeHours={() => void handleSnooze({ preset: "three_hours" })}
        onSnoozeTomorrow={() => void handleSnooze({ preset: "tomorrow" })}
        onSnoozeNextWeek={() => void handleSnooze({ preset: "next_week" })}
        onSnoozeCustom={() => setSnoozeCustomOpen(true)}
        onWake={() => void handleWake()}

        showChaseNow={overrides.chaseNow}
        onChaseNow={() => void handleChaseNow()}
        showStopChasing={canStopChasing && conversation.sequenceStatus === "running"}
        onStopChasing={() => void handleStopChasing()}
        showArchive={canArchive && !conversation.archived_at}
        onArchive={() => void handleArchive()}
        showMarkUnread={accountRole !== "viewer" && !!onMarkUnread && !!conversationId}
        onMarkUnread={() => conversationId && onMarkUnread?.(conversationId)}
      />

      {/* Messages Area. Wrapped in its own `relative flex-1 flex flex-col`
          box (rather than putting `relative` on the scrolling div itself)
          so `NoteComposer`'s `absolute bottom-4 right-4` trigger anchors
          to a box that does NOT scroll. An absolutely-positioned
          descendant of a scrolling ancestor is laid out against that
          ancestor's padding box but travels with the scrolled content —
          mounting the composer as a sibling of the scroll div, both
          inside this non-scrolling wrapper, keeps the button fixed in
          the viewport regardless of scroll position.
          `min-h-0` is load-bearing here too: a flex child defaults to
          min-height:auto, so without it this wrapper would grow to fit
          its content instead of shrinking to the remaining column
          space, and the inner scroll div would never see an overflow to
          scroll (same failure mode `conversation-list.tsx`'s `ScrollArea`
          comment documents for issue #229 — this only happens to work
          without it via the min-content-size-to-overflowing-descendant
          recursion, which is spec-compliant but not worth depending on
          silently). */}
      <div className="relative flex-1 flex flex-col min-h-0">
        <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4">
          {area === "loading" ? (
            <ThreadSkeleton />
          ) : area === "empty" && timelineGroups.length === 0 ? (
            // `area === "empty"` only means no MESSAGES loaded
            // (`messageAreaState`, `src/lib/inbox/view.ts`) — a
            // message-less conversation can still carry notes
            // (`insertConversation`/`findOrCreateForContact`/broadcasts
            // all produce one before any message exists). Falling
            // through to the placeholder whenever `timelineGroups` is
            // non-empty keeps a note-only thread's notes visible
            // instead of silently swallowing them behind "No messages
            // yet".
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
              {/* Notes and events older than the oldest loaded message have
                  no message to sit beside — surfaced as a count instead of
                  vanishing. See `splitEarlierNotes`. */}
              {earlierCount > 0 && (
                <div className="flex justify-center pb-2">
                  <span className="rounded-full bg-amber-500/10 px-3 py-1 text-[11px] text-muted-foreground">
                    {/* "…notes and updates" only when there ARE updates
                        up there. Most threads have notes and no handover,
                        and promising an ownership change that isn't there
                        sends the agent hunting for it. */}
                    {tNotes(
                      earlierEventCount > 0 ? "earlierItems" : "earlierNotes",
                      { count: earlierCount },
                    )}
                  </span>
                </div>
              )}
              {timelineGroups.map((group, groupIndex) => {
                const dateLabel = formatDateSeparator(group.date, t);
                return (
                <div key={group.date || `no-date-${groupIndex}`}>
                  {/* Date separator — omitted for a note-only group
                      (`group.date === ""`, see `mergeTimelineEntries`):
                      there is no message to anchor a date to, and
                      `formatDateSeparator` returns `null` for it rather
                      than feeding an Invalid Date into `date-fns`. */}
                  {dateLabel && (
                    <div className="mb-4 flex items-center justify-center">
                      <span className="rounded-full bg-muted px-3 py-1 text-[11px] font-medium text-muted-foreground">
                        {dateLabel}
                      </span>
                    </div>
                  )}
                  {/* Messages + inline notes and ownership events */}
                  <div className="space-y-2">
                    {group.items.map((item) => {
                      if (item.type === "event") {
                        return (
                          <AssignmentEvent
                            key={item.value._id}
                            event={item.value}
                          />
                        );
                      }
                      if (item.type === "note") {
                        const note = item.value;
                        // `!!note.createdByUserId` guards against a
                        // false-positive match on `undefined === undefined`
                        // while `user` hasn't populated yet — without it, a
                        // system note (no author) would briefly show
                        // Delete, which the server's `requireAuthorOrAdmin`
                        // would then reject.
                        const canManage =
                          (!!note.createdByUserId && note.createdByUserId === user?.id) ||
                          (accountRole ? hasMinRole(accountRole, "admin") : false);
                        return (
                          <NoteCard
                            key={note._id}
                            note={note}
                            canManage={canManage}
                            // `onEdit` intentionally omitted — Phase 2
                            // builds the edit UI; `NoteCard` only renders
                            // the Edit menu item when a handler is passed.
                            onDelete={handleDeleteNote}
                          />
                        );
                      }
                      const msg = item.value;
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
                          canReact={canReact}
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
                            canReact={canReact}
                          />
                        </MessageActions>
                      );
                    })}
                  </div>
                </div>
                );
              })}
            </div>
          )}
        </div>
        {conversationId && contactId && (
          <NoteComposer
            contactId={contactId as Id<"contacts">}
            conversationId={conversationId as Id<"conversations">}
          />
        )}
        {/* Lead-quality panel (spec 2026-09-01-lead-quality-feedback-loop).
            Deliberately HERE rather than above the composer: it is a
            floating action beside the notes button — the affordance agents
            already use to record something about a lead — and it shares
            that button's positioning context. An earlier build put one
            question inline in the footer, which crowded the message area on
            every unanswered lead. Wrapped because Netlify builds the
            frontend from `main` while Convex deploys separately, so the
            window where this component exists and
            `leadQuality:getCardState` does not is real, and `useQuery`
            rethrows during render. */}
        {conversationId && (
          <OptionalFeatureBoundary feature="leadQuality.getCardState">
            <LeadQualityCard
              conversationId={conversationId as Id<"conversations">}
            />
          </OptionalFeatureBoundary>
        )}
      </div>

      {/* Free-window unlock nudge. Meta opens the 72h free-entry-point
          window only if we answer a Click-to-WhatsApp lead within 24h of
          the click — miss it and every later template is billed. Shown
          only while that is still winnable, and not to viewers, who
          cannot reply. */}
      {unlockRemaining && accountRole !== "viewer" && (
        <div
          title={tWindow("unlockNudgeTitle")}
          className="mb-2 flex items-center gap-2 rounded-lg bg-emerald-500/10 px-3 py-2 text-xs text-emerald-400"
        >
          <BadgeCheck className="h-4 w-4 shrink-0" />
          <span>
            {tWindow("unlockNudge", { remaining: unlockRemaining })}
          </span>
        </div>
      )}

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

      {/* Do-not-contact banner (Task 10) — rendered as a sibling of the
          messages-area wrapper above and the composer below, so like the
          unlock nudge and AiThreadBanner it sits outside the `overflow-
          y-auto` scroll div (line ~1441) and cannot scroll out of view
          (the Phase 1 Critical this task exists to avoid repeating: a
          floating trigger placed inside the scroll container). Directly
          above the composer per the brief. The composer itself is never
          disabled here — a human is not blocked from messaging, only
          the automated paths (Tasks 4-8) are gated server-side. */}
      {contactId && contact?.do_not_contact && (
        <DoNotContactBanner
          contactId={contactId as Id<"contacts">}
          at={contact.do_not_contact.at}
          byName={doNotContactByName}
          canClear={canClearDoNotContact}
        />
      )}

      {/* Composer / claim-to-reply / read-only notice — role-gated
          (Task 11). An agent viewing a pool conversation that isn't
          theirs yet can't send — `send.send` rejects it server-side
          (per-conversation "own" access, RBAC final review) — they get a
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
          // Scoped to the expired-session case on purpose: that is when an
          // agent needs to know template re-engagement is free. The header
          // badge carries the always-visible signal.
          adFreeWindowLabel={sessionInfo.expired ? freeWindowRemaining : null}
        />
      )}

      <TemplatePicker
        open={templateModalOpen}
        onOpenChange={setTemplateModalOpen}
        onSelect={handleSendTemplate}
      />

      <Dialog open={purchaseOpen} onOpenChange={setPurchaseOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{tFunnel("saleAmountTitle")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <label className="text-xs text-muted-foreground">{tFunnel("saleAmountLabel")}</label>
            <Input
              type="number"
              inputMode="decimal"
              min="0"
              value={purchaseAmount}
              onChange={(e) => setPurchaseAmount(e.target.value)}
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button
              onClick={() => {
                const v = Number(purchaseAmount);
                if (!Number.isFinite(v) || v <= 0) return;
                setPurchaseOpen(false);
                void applyStage("purchased", { saleValue: v });
              }}
              disabled={!(Number(purchaseAmount) > 0)}
            >
              {tFunnel("saleAmountConfirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <LossReasonDialog
        open={lossOpen}
        onOpenChange={setLossOpen}
        onConfirm={(category, detail) =>
          void applyStage("lost", { lossCategory: category, lossDetail: detail })
        }
      />

      {/* Custom snooze (Task 7) — the one preset that needs a form. The
          server (`inboxOverrides.snooze` / `resolveSnoozeUntilMs`) is the
          real gate on "in the past" / "beyond 30 days"; this dialog does
          no client-side range validation of its own, only requiring a
          value be picked before Confirm is enabled. */}
      <Dialog open={snoozeCustomOpen} onOpenChange={setSnoozeCustomOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("snoozeCustom")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <Input
              type="datetime-local"
              value={customSnoozeDateTime}
              onChange={(e) => setCustomSnoozeDateTime(e.target.value)}
              autoFocus
            />
            <Input
              value={customSnoozeReason}
              onChange={(e) => setCustomSnoozeReason(e.target.value)}
              placeholder={t("snoozeReasonPlaceholder")}
            />
          </div>
          <DialogFooter>
            <Button
              onClick={handleConfirmCustomSnooze}
              disabled={!customSnoozeDateTime}
            >
              {t("snoozeConfirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * Placeholder shown while a conversation's first page of messages is
 * still loading (cold, uncached open). A few message-shaped bars —
 * alternating incoming/outgoing — read as "messages arriving" rather than
 * a blank pane with a lone spinner, and roughly match the real bubble
 * layout so the swap to content doesn't jump. Declared at module scope so
 * it doesn't remount on every parent re-render. Purely decorative, hence
 * `aria-hidden`.
 */
function ThreadSkeleton() {
  const rows: { out: boolean; w: string }[] = [
    { out: false, w: "w-40" },
    { out: false, w: "w-56" },
    { out: true, w: "w-48" },
    { out: false, w: "w-32" },
    { out: true, w: "w-60" },
    { out: true, w: "w-36" },
  ];
  return (
    <div className="space-y-3" aria-hidden="true">
      {rows.map((r, i) => (
        <div
          key={i}
          className={cn("flex", r.out ? "justify-end" : "justify-start")}
        >
          <Skeleton className={cn("h-10 max-w-[75%] rounded-2xl", r.w)} />
        </div>
      ))}
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
