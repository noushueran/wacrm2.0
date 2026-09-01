"use client";

import { useState, useCallback, useMemo, useRef, useEffect } from "react";
import { useQuery } from "convex/react";
import type { PaginationStatus } from "convex/react";
import { api } from "../../../convex/_generated/api";
import {
  matchesContactFilters,
  resolveAssignee,
  type AssigneeDisplay,
} from "@/lib/inbox/conversations";
import { ContactAvatar } from "@/components/inbox/contact-avatar";
import { PrefetchThread } from "@/components/inbox/prefetch-thread";
import { PrefetchLane } from "@/components/inbox/prefetch-lane";
import { toUiTag, toUiTagGroup, toUiMemberProfile } from "@/lib/convex/adapters";
import { tagChipRow } from "@/lib/inbox/labels";
import { resolveConversationWindows } from "@/lib/inbox/messagingWindow";
import type { AssignmentTab, InboxLane } from "@/lib/inbox/view";
import { useAuth } from "@/hooks/use-auth";
import { cn } from "@/lib/utils";
import type { Conversation, ConversationStatus, Tag, TagGroup, Profile } from "@/types";
import { Search, ChevronDown, X, Mail, Megaphone, Gauge } from "lucide-react";
import { formatDistanceToNow, format } from "date-fns";
import { useTranslations } from "next-intl";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/dashboard/skeleton";
import { OwnSpendLine } from "@/components/inbox/own-spend-line";

// `AssignmentTab` / `InboxLane` are DEFINED in `@/lib/inbox/view` and
// re-exported here so every existing import site is unchanged. They moved
// because `conversationListArgs` — which turns a (lane, assignment) pair
// into this list's Convex query args — has to live in a module the
// prefetcher can import without pulling in this whole component, and a
// second copy of either union is exactly the hand-maintained-twin trap
// this codebase keeps getting bitten by.
export type { AssignmentTab, InboxLane };

/** Pure lane → empty-state message-key mapping. Exported (rather than
 *  inlined in `ConversationList`'s empty-state branch) so a test can
 *  assert every lane resolves to its own distinct message without
 *  rendering the list itself — which needs a live Convex context, same
 *  reasoning as `ConversationItem`'s export below. */
export function laneEmptyMessageKey(lane: InboxLane): string {
  return {
    active: "laneActiveEmpty",
    waiting: "laneWaitingEmpty",
    chasing: "laneChasingEmpty",
    archived: "laneArchivedEmpty",
    snoozed: "laneSnoozedEmpty",
  }[lane];
}

interface ConversationListProps {
  activeConversationId: string | null;
  onSelect: (conversation: Conversation) => void;
  /** Restores the unread badge on a row that was opened by mistake.
   *  Owned by the page, which also has to close the thread to make the
   *  restore stick — see its `handleMarkUnread`. */
  onMarkUnread: (conversationId: string) => void;
  /** Reactive, already-adapted page of conversations — owned by the
   *  page's `usePaginatedQuery(api.conversations.list, ...)`. */
  conversations: Conversation[];
  /** Fetches the next (older) page. Powers the "Load more" button. */
  loadMore: (numItems: number) => void;
  /** Pagination status from the page's `usePaginatedQuery` — drives the
   *  initial spinner and the "Load more" button's visibility. */
  status: PaginationStatus;
  /** Active assignment tab + setter — owned by the page, which owns the
   *  paginated query this tab feeds into. */
  assignment: AssignmentTab;
  onAssignmentChange: (tab: AssignmentTab) => void;
  /**
   * Active lane tab + setter — owned by the page, which threads it into
   * the same `api.conversations.list` query as `assignment` (mutually
   * exclusive there with `archived` — see the page's query construction).
   * A SEPARATE axis from `assignment`, same composition as before: a
   * supervisor can still view Archived + Mine at once, since "Archived"
   * is one of the four lane values rather than a fifth, bolted-on
   * control. Supersedes the standalone Archived toggle this used to be
   * (lead-analysis P2) — see task-6 report for why that toggle was
   * retired rather than kept alongside this.
   */
  lane: InboxLane;
  onLaneChange: (lane: InboxLane) => void;
}

const STATUS_COLORS: Record<ConversationStatus, string> = {
  open: "bg-primary",
  pending: "bg-amber-500",
  closed: "bg-muted-foreground",
};



type InboxFilter = ConversationStatus | "all" | "unread";

export function ConversationList({
  activeConversationId,
  onSelect,
  onMarkUnread,
  conversations,
  loadMore,
  status,
  assignment,
  onAssignmentChange,
  lane,
  onLaneChange,
}: ConversationListProps) {
  const t = useTranslations("Inbox.conversationList");
  const tWindow = useTranslations("Inbox.messagingWindow");
  // Same scope the thread panel reads, so the badge and the panel are
  // worded from one place.
  const tQuality = useTranslations("Inbox.leadQuality");

  // One clock for every row's free-window badge. 60s is plenty: the badge
  // is a boolean, so it only has to flip near the window's expiry.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  const FILTER_OPTIONS: { label: string; value: InboxFilter }[] = useMemo(() => [
    { label: t("filterAll"), value: "all" },
    { label: t("filterUnread"), value: "unread" },
    { label: t("filterOpen"), value: "open" },
    { label: t("filterPending"), value: "pending" },
    { label: t("filterClosed"), value: "closed" },
  ], [t]);

  const ASSIGNMENT_TABS: { label: string; value: AssignmentTab }[] = useMemo(
    () => [
      { label: t("tabAll"), value: "all" },
      { label: t("tabMine"), value: "mine" },
      { label: t("tabUnassigned"), value: "unassigned" },
    ],
    [t],
  );

  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<InboxFilter>("all");
  // Contact-based filters (issue #272). Tags use OR logic (a conversation
  // matches if its contact carries any selected tag), consistent with
  // Broadcast audience filtering. Company is an exact match on the field.
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
  const [selectedCompany, setSelectedCompany] = useState<string | null>(null);

  // Tag definitions for the filter picker — a reactive account-wide
  // query rather than the conversations' own embedded `contact.tags`,
  // so the picker always lists every tag (not just ones currently in
  // use by a loaded conversation).
  const tagDocs = useQuery(api.tags.list);
  const tags = (tagDocs ?? []).map(toUiTag);

  // Tag groups — order each row's tag chips by the group's own position
  // (most important dimensions first, so they survive the +N cut-off).
  const groupDocs = useQuery(api.tagGroups.list);
  const groups = useMemo(
    () => (groupDocs ?? []).map(toUiTagGroup),
    [groupDocs],
  );

  // Current user + account roster — resolve each row's assignee chip
  // (a teammate's name/initial, or "You"). `api.members.list` is already
  // loaded by the thread's assign dropdown, so this reuses a cached
  // subscription rather than adding a new round-trip.
  const { user, accountRole } = useAuth();
  const memberDocs = useQuery(api.members.list);
  const profilesById = useMemo(() => {
    const m = new Map<string, Profile>();
    for (const doc of memberDocs ?? []) {
      const p = toUiMemberProfile(doc);
      m.set(p.user_id, p);
    }
    return m;
  }, [memberDocs]);

  // Company options are derived from the loaded conversations — there's no
  // separate companies table, and only companies with a live conversation
  // are worth offering as an inbox filter.
  const companies = useMemo(() => {
    const set = new Set<string>();
    for (const c of conversations) {
      const co = c.contact?.company?.trim();
      if (co) set.add(co);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [conversations]);

  const tagsById = useMemo(() => {
    const m = new Map<string, Tag>();
    for (const t of tags) m.set(t.id, t);
    return m;
  }, [tags]);

  const filtered = useMemo(() => {
    let result = conversations;

    if (filter === "unread") {
      result = result.filter((c) => c.unread_count > 0);
    } else if (filter !== "all") {
      result = result.filter((c) => c.status === filter);
    }

    // Contact-based filters (tags via OR logic, exact company match).
    if (selectedTagIds.length > 0 || selectedCompany !== null) {
      result = result.filter((c) =>
        matchesContactFilters(c, {
          tagIds: selectedTagIds,
          company: selectedCompany,
        })
      );
    }

    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter((c) => {
        const name = c.contact?.name?.toLowerCase() ?? "";
        const phone = c.contact?.phone?.toLowerCase() ?? "";
        const lastMsg = c.last_message_text?.toLowerCase() ?? "";
        return name.includes(q) || phone.includes(q) || lastMsg.includes(q);
      });
    }

    return result;
  }, [conversations, filter, search, selectedTagIds, selectedCompany]);

  const toggleTag = useCallback((id: string) => {
    setSelectedTagIds((prev) =>
      prev.includes(id) ? prev.filter((t) => t !== id) : [...prev, id]
    );
  }, []);

  const clearContactFilters = useCallback(() => {
    setSelectedTagIds([]);
    setSelectedCompany(null);
  }, []);

  const hasContactFilters = selectedTagIds.length > 0 || selectedCompany !== null;

  const handleSearchChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setSearch(e.target.value);
    },
    []
  );

  const handleSelect = useCallback(
    (conv: Conversation) => {
      onSelect(conv);
    },
    [onSelect]
  );

  // Hover-prefetch (perf): warm a conversation's thread queries while the
  // pointer rests on its row, so the eventual click paints from the query
  // cache instead of a cold round-trip. Debounced so sweeping the cursor
  // down the list doesn't open a subscription for every row it crosses —
  // only a row the pointer settles on (~120ms) gets prefetched. One slot:
  // `prefetchId` follows the hover; the cache keeps prior warmed threads
  // alive on its own (5-min TTL), so there's nothing to tear down here.
  const [prefetchId, setPrefetchId] = useState<string | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleHover = useCallback((id: string) => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    hoverTimer.current = setTimeout(() => setPrefetchId(id), 120);
  }, []);

  const handleHoverEnd = useCallback(() => {
    if (hoverTimer.current) {
      clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
  }, []);

  useEffect(
    () => () => {
      if (hoverTimer.current) clearTimeout(hoverTimer.current);
    },
    [],
  );

  // Tab-hover prefetch (perf) — the same trick one level up. Each lane
  // and each assignment tab is its OWN server-filtered paginated query,
  // so the first click on a tab this session hasn't opened pays a full
  // cold round-trip before a single row paints; that is the "switching
  // tabs is slow" the owner reported. Warming it while the pointer
  // travels to the tab hides that latency behind the mouse movement,
  // and the query cache keeps it warm afterwards, so every later visit
  // to that tab is instant.
  //
  // ONE slot, not five: prefetching every tab up front would open five
  // live subscriptions per open inbox, and each inbound WhatsApp message
  // invalidates all of them — five server recomputations per message
  // instead of one, on a self-hosted deployment, to save a latency the
  // pointer already covers. Same 120ms debounce as the row prefetch, so
  // sweeping the cursor across the row doesn't fire four queries.
  const [prefetchTab, setPrefetchTab] = useState<
    { lane: InboxLane; assignment: AssignmentTab } | null
  >(null);
  const tabHoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const armTabPrefetch = useCallback(
    (target: { lane: InboxLane; assignment: AssignmentTab }) => {
      if (tabHoverTimer.current) clearTimeout(tabHoverTimer.current);
      tabHoverTimer.current = setTimeout(() => setPrefetchTab(target), 120);
    },
    [],
  );

  const handleTabHoverEnd = useCallback(() => {
    if (tabHoverTimer.current) {
      clearTimeout(tabHoverTimer.current);
      tabHoverTimer.current = null;
    }
  }, []);

  const handleLaneHover = useCallback(
    (target: InboxLane) => armTabPrefetch({ lane: target, assignment }),
    [armTabPrefetch, assignment],
  );

  const handleAssignmentHover = useCallback(
    (target: AssignmentTab) => armTabPrefetch({ lane, assignment: target }),
    [armTabPrefetch, lane],
  );

  useEffect(
    () => () => {
      if (tabHoverTimer.current) clearTimeout(tabHoverTimer.current);
    },
    [],
  );

  const activeFilter = FILTER_OPTIONS.find((o) => o.value === filter);

  return (
    // w-full on mobile so the list occupies the whole viewport when it's
    // the single pane showing; fixed 384px on desktop where it shares the
    // row with the thread + contact sidebar.
    //
    // The width is set by `LaneTabs` below, not by the rows: five tabs
    // have to sit side by side without ellipsising, and the padding
    // there is already down to `px-0.5` — there is nothing left to shave,
    // so headroom can only come from the panel. Measured at 384: 67.2px
    // of text box per tab against a widest label ("Archived") of 56px at
    // the 13px `text-xs`, so ~11px of slack.
    //
    // It has been squeezed twice already — 320 clipped "Snoozed"
    // mid-glyph, then 352 survived the 12px→13px type bump with only
    // 5px to spare. If type grows again, widen here rather than trimming
    // padding, and do NOT shorten the labels: "Archive" and "Snooze" are
    // the thread header's ACTION buttons, so reusing those words as
    // state labels a few pixels away would trade a layout problem for a
    // comprehension one.
    <div className="flex h-full w-full flex-col border-r border-border bg-card lg:w-96">
      {/* Agent-only "this month" spend line — self-hides for
          supervisors/admins (who have the Dashboard card instead) and
          when lead-value tracking is off. */}
      <OwnSpendLine />

      {/* Lane tabs — which lane of the pipeline to show. A SEPARATE axis
          from the assignment tabs below (its own row, not merged or
          nested into that button group), server-filtered via the page's
          `lane`/`archived` query args. Composes with assignment: e.g.
          "Chasing" + "Mine" together, with no extra state needed here. */}
      <LaneTabs
        lane={lane}
        onLaneChange={onLaneChange}
        t={t}
        onPrefetch={handleLaneHover}
        onPrefetchEnd={handleTabHoverEnd}
      />

      {/* Assignment tabs — which bucket of chats to show. A separate axis
          from the status/tags filters below: this one is server-filtered
          via the page's `assignment` query arg, so each tab paginates its
          own complete set. `All` is the default (today's view unchanged). */}
      <div className="flex items-center gap-1 border-b border-border p-2">
        {ASSIGNMENT_TABS.map((tab) => (
          <button
            key={tab.value}
            type="button"
            onClick={() => onAssignmentChange(tab.value)}
            // Same cache-warming as the lane row above — this axis is
            // server-filtered too, so each bucket is its own cold query.
            onMouseEnter={() => handleAssignmentHover(tab.value)}
            onFocus={() => handleAssignmentHover(tab.value)}
            onMouseLeave={handleTabHoverEnd}
            onBlur={handleTabHoverEnd}
            className={cn(
              // `min-w-0`/`truncate` for the same reason as `LaneTabs` —
              // three short labels leave plenty of room today, but the
              // row should ellipsize rather than overflow if that changes.
              "min-w-0 flex-1 truncate rounded-md px-2 py-1 text-xs font-medium transition-colors",
              assignment === tab.value
                ? "bg-muted text-primary"
                : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Search + Filter */}
      <div className="space-y-2 border-b border-border p-3">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={handleSearchChange}
            placeholder={t("searchPlaceholder")}
            className="border-border bg-muted pl-9 text-sm text-foreground placeholder-muted-foreground focus:border-primary/50"
          />
        </div>

        <div className="flex flex-wrap items-center gap-1">
          <DropdownMenu>
            <DropdownMenuTrigger className="inline-flex items-center justify-center h-7 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground rounded-md hover:bg-muted">
                {activeFilter?.label ?? t("filterAll")}
                <ChevronDown className="h-3 w-3" />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              className="border-border bg-popover"
            >
              {FILTER_OPTIONS.map((opt) => (
                <DropdownMenuItem
                  key={opt.value}
                  onClick={() => setFilter(opt.value)}
                  className={cn(
                    "text-sm",
                    filter === opt.value
                      ? "text-primary"
                      : "text-popover-foreground"
                  )}
                >
                  {opt.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          {tags.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger
                className={cn(
                  "inline-flex items-center justify-center h-7 gap-1 px-2 text-xs rounded-md hover:bg-muted",
                  selectedTagIds.length > 0
                    ? "text-primary"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                {t("tags")}
                {selectedTagIds.length > 0 && (
                  <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[11px] font-bold text-primary-foreground">
                    {selectedTagIds.length}
                  </span>
                )}
                <ChevronDown className="h-3 w-3" />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="max-h-64 w-56 border-border bg-popover"
              >
                {tags.map((t) => (
                  <DropdownMenuCheckboxItem
                    key={t.id}
                    checked={selectedTagIds.includes(t.id)}
                    onCheckedChange={() => toggleTag(t.id)}
                    className="text-sm text-popover-foreground"
                  >
                    <span className="flex items-center gap-2">
                      <span
                        className="h-2 w-2 shrink-0 rounded-full"
                        style={{ backgroundColor: t.color }}
                      />
                      <span className="truncate">{t.name}</span>
                    </span>
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          {companies.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger
                className={cn(
                  "inline-flex max-w-40 items-center justify-center h-7 gap-1 px-2 text-xs rounded-md hover:bg-muted",
                  selectedCompany
                    ? "text-primary"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                <span className="truncate">{selectedCompany ?? t("company")}</span>
                <ChevronDown className="h-3 w-3 shrink-0" />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="max-h-64 w-56 border-border bg-popover"
              >
                <DropdownMenuItem
                  onClick={() => setSelectedCompany(null)}
                  className={cn(
                    "text-sm",
                    selectedCompany === null
                      ? "text-primary"
                      : "text-popover-foreground"
                  )}
                >
                  {t("allCompanies")}
                </DropdownMenuItem>
                {companies.map((co) => (
                  <DropdownMenuItem
                    key={co}
                    onClick={() => setSelectedCompany(co)}
                    className={cn(
                      "text-sm",
                      selectedCompany === co
                        ? "text-primary"
                        : "text-popover-foreground"
                    )}
                  >
                    <span className="truncate">{co}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>

        {hasContactFilters && (
          <div className="flex flex-wrap items-center gap-1">
            {selectedTagIds.map((id) => {
              const tag = tagsById.get(id);
              return (
                <button
                  key={id}
                  onClick={() => toggleTag(id)}
                  className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[12px] text-foreground hover:bg-muted/70"
                >
                  <span
                    className="h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{ backgroundColor: tag?.color ?? "var(--muted-foreground)" }}
                  />
                  <span className="max-w-24 truncate">{tag?.name ?? t("tags")}</span>
                  <X className="h-3 w-3" />
                </button>
              );
            })}
            {selectedCompany && (
              <button
                onClick={() => setSelectedCompany(null)}
                className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[12px] text-foreground hover:bg-muted/70"
              >
                <span className="max-w-24 truncate">{selectedCompany}</span>
                <X className="h-3 w-3" />
              </button>
            )}
            <button
              onClick={clearContactFilters}
              className="px-1 text-[12px] text-muted-foreground hover:text-foreground"
            >
              {t("clearAll")}
            </button>
          </div>
        )}
      </div>

      {/* Conversation Items.
          `min-h-0` is load-bearing: a flex child defaults to
          min-height:auto, so without it this ScrollArea grows to fit
          every conversation instead of shrinking to the remaining
          space — the list then overflows and gets clipped by the
          parent's overflow-hidden with no scrollbar (issue #229). */}
      <ScrollArea className="min-h-0 flex-1">
        {/* The skeleton is for having NOTHING to show, not merely for
            `LoadingFirstPage`. The page keeps handing this component the
            tab's last rows through a mid-session pagination reset (see
            its `conversationRowsToRender`), and that reset also reports
            `LoadingFirstPage` — so gating on the status alone would
            flash the skeleton over a list the user is reading. Gating on
            `conversations` (pre-filter) rather than `filtered` keeps a
            search or tag filter that legitimately matches nothing
            showing the empty state instead of a permanent skeleton. */}
        {status === "LoadingFirstPage" && conversations.length === 0 ? (
          <ConversationListSkeleton />
        ) : filtered.length === 0 ? (
          <div className="px-4 py-12 text-center">
            <p className="text-sm text-muted-foreground">
              {assignment === "mine"
                ? t("emptyMine")
                : assignment === "unassigned"
                  ? t("emptyUnassigned")
                  : t(laneEmptyMessageKey(lane))}
            </p>
          </div>
        ) : (
          <div className="flex flex-col">
            {filtered.map((conv) => (
              <ConversationItem
                key={conv.id}
                conversation={conv}
                isActive={conv.id === activeConversationId}
                onSelect={handleSelect}
                // Viewers get no control at all, matching the thread's
                // status/assign dropdowns: `conversations.markUnread`
                // requires requireRole("agent"), so for a viewer this
                // could only ever be a button that fails server-side.
                onMarkUnread={accountRole === "viewer" ? undefined : onMarkUnread}
                assignee={resolveAssignee(conv, user?.id, profilesById)}
                onHover={handleHover}
                onHoverEnd={handleHoverEnd}
                t={t}
                tWindow={tWindow}
                tQuality={tQuality}
                nowMs={nowMs}
                groups={groups}
                lane={lane}
              />
            ))}
            {/* Load more — Convex cursor pagination. Not gated on the
                active filters: the page's query is unfiltered by
                status (server-side `status` filtering is a separate,
                unused arg), so "load more" always means "fetch the
                next page of conversations by recency," same as before
                filters are applied client-side. */}
            {status === "CanLoadMore" && (
              <div className="flex justify-center py-3">
                <button
                  type="button"
                  onClick={() => loadMore(30)}
                  className="rounded-md px-3 py-1.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  Load more
                </button>
              </div>
            )}
            {status === "LoadingMore" && (
              <div className="flex items-center justify-center py-3">
                <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
              </div>
            )}
          </div>
        )}
      </ScrollArea>

      {/* Invisible hover-prefetcher for the row the pointer rests on —
          renders nothing, just warms that thread's cache. */}
      {prefetchId && <PrefetchThread conversationId={prefetchId} />}

      {/* Same idea for the tab the pointer is resting on. Skipped when it
          IS the current tab — that query is already this list's own
          subscription, so a second one would be pure duplication. */}
      {prefetchTab &&
        !(prefetchTab.lane === lane && prefetchTab.assignment === assignment) && (
          <PrefetchLane
            lane={prefetchTab.lane}
            assignment={prefetchTab.assignment}
          />
        )}
    </div>
  );
}

/**
 * What the list shows while a tab's FIRST page is in flight.
 *
 * Rows, not the centred spinner this replaced. Switching tabs resets the
 * paginated query — `usePaginatedQuery` rebuilds its state during render
 * when the args change, so `status` really is `LoadingFirstPage` for the
 * whole round-trip to the self-hosted backend, and the panel was going
 * blank-with-a-spinner every time. A spinner alone in an empty panel
 * reads as "stalled"; rows in the shape of the answer read as "coming".
 *
 * Geometry is matched to `ConversationItem` (h-11 avatar, gap-3, p-3) so
 * the real rows don't shift the list when they land.
 *
 * Exported for the same reason as `LaneTabs` and `ConversationItem`:
 * `ConversationList` opens Convex subscriptions, so only pieces without
 * a data dependency can be `renderToStaticMarkup`'d in a test.
 */
export function ConversationListSkeleton({ rows = 7 }: { rows?: number }) {
  return (
    <div className="flex flex-col">
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          className="flex items-center gap-3 border-b border-border/50 p-3"
        >
          <Skeleton className="h-11 w-11 shrink-0 rounded-full" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-3.5 w-1/2" />
            <Skeleton className="h-3 w-3/4" />
          </div>
        </div>
      ))}
    </div>
  );
}

interface LaneTabsProps {
  lane: InboxLane;
  onLaneChange: (lane: InboxLane) => void;
  /** `Inbox.conversationList` scope — same translator `ConversationList`
   *  already holds, just threaded down rather than re-resolved here. */
  t: ReturnType<typeof useTranslations>;
  /** Pointer entered (or focus landed on) a lane tab — the parent
   *  debounces then warms that lane's first page. Optional so this row
   *  stays renderable in isolation with no prefetching at all. */
  onPrefetch?: (lane: InboxLane) => void;
  /** Pointer left before the debounce fired — cancel it. */
  onPrefetchEnd?: () => void;
}

/**
 * Lane tab row — which lane of the pipeline (Active/Waiting/Chasing/
 * Archived) the list shows. Pulled out of `ConversationList`, like
 * `ConversationItem` below, purely so it can be static-rendered in
 * isolation: `ConversationList` itself opens Convex subscriptions
 * (`useQuery` for tags/groups/members, plus `<OwnSpendLine />`), so
 * `renderToStaticMarkup` on the whole list throws with no
 * `ConvexProvider` in the tree. This row has no data dependency of its
 * own — it just needs the current lane, the setter, and a translator —
 * so extracting it sidesteps that entirely rather than mocking Convex.
 */
export function LaneTabs({
  lane,
  onLaneChange,
  t,
  onPrefetch,
  onPrefetchEnd,
}: LaneTabsProps) {
  const LANE_TABS: { label: string; value: InboxLane }[] = [
    { label: t("laneActive"), value: "active" },
    { label: t("laneWaiting"), value: "waiting" },
    { label: t("laneChasing"), value: "chasing" },
    { label: t("laneArchived"), value: "archived" },
    { label: t("laneSnoozed"), value: "snoozed" },
  ];

  return (
    <div className="flex items-center gap-1 border-b border-border px-1.5 py-2">
      {LANE_TABS.map((tab) => (
        <button
          key={tab.value}
          type="button"
          onClick={() => onLaneChange(tab.value)}
          // Warm this lane's first page while the pointer travels to the
          // tab, so the click paints from cache. Also on focus, so
          // keyboard tabbing gets the same head start.
          onMouseEnter={() => onPrefetch?.(tab.value)}
          onFocus={() => onPrefetch?.(tab.value)}
          onMouseLeave={onPrefetchEnd}
          onBlur={onPrefetchEnd}
          className={cn(
            // `min-w-0` + `truncate` are the load-bearing pair here.
            // `flex-1` alone leaves each button's automatic minimum size
            // at its text width, so the five tabs REFUSE to shrink and
            // overflow the row instead — at 320px they summed to 324 and
            // the parent's overflow-hidden sliced "Snoozed" in half.
            // `min-w-0` lets them share the row equally; `truncate` makes
            // the failure mode an ellipsis rather than a cut glyph if a
            // longer label ever lands here. Neither fires today: at the
            // lg panel (w-96) each tab gets 67.2px of text box (372px
            // inner − 16px gaps, ÷5, − 4px padding) against a widest
            // label ("Archived") of 56px at the 13px `text-xs`.
            //
            // The row's padding is `px-1.5` and the tabs' `px-0.5`
            // because at the earlier `p-2`/`px-1` the budget was 56px
            // available vs 56px needed and "Archived" ellipsised. Those
            // are now as tight as they go, so the next type bump has to
            // be absorbed by the PANEL width, not here.
            //
            // Below `lg` the panel is full-width, so a ~320px phone
            // still ellipsises "Archived"/"Snoozed" by ~2px; 360px and
            // wider is clear. Measured, not derived.
            "min-w-0 flex-1 truncate rounded-md px-0.5 py-1 text-xs font-medium transition-colors",
            lane === tab.value
              ? "bg-muted text-primary"
              : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
          )}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

interface ConversationItemProps {
  conversation: Conversation;
  isActive: boolean;
  onSelect: (conversation: Conversation) => void;
  /** Restores this row's unread badge — see `ConversationListProps`.
   *  Absent for viewers, who have no write access to read state. */
  onMarkUnread?: (conversationId: string) => void;
  assignee: AssigneeDisplay;
  /** Pointer entered this row — parent debounces then prefetches it. */
  onHover: (conversationId: string) => void;
  /** Pointer left this row before the debounce fired — cancel it. */
  onHoverEnd: () => void;
  t: ReturnType<typeof useTranslations>;
  /** `Inbox.messagingWindow` scope — the free-window badge. */
  tWindow: ReturnType<typeof useTranslations>;
  /** `Inbox.leadQuality` scope — the lead-quality progress badge. */
  tQuality: ReturnType<typeof useTranslations>;
  /** Shared ticking clock, owned by the parent list. Keeps render pure. */
  nowMs: number;
  groups: TagGroup[];
  /**
   * Which lane tab is showing this row (Task 7). Threaded down from
   * `ConversationList`'s own `lane` prop rather than inferred from
   * `conversation.sequenceStatus` presence, so a row's rendering is
   * driven by which tab is showing it, not by which fields happen to be
   * populated on the conversation. Only the Chasing lane changes
   * anything below — every other lane's row stays byte-for-byte the
   * rendering it was before this task.
   */
  lane: InboxLane;
}

/** Exported for `conversation-list.test.tsx` — the list itself can't be
 *  static-rendered (it opens Convex subscriptions), but a single row's
 *  markup is exactly what the mark-unread control's structure hinges on. */
export function ConversationItem({
  conversation,
  isActive,
  onSelect,
  onMarkUnread,
  assignee,
  onHover,
  onHoverEnd,
  t,
  tWindow,
  tQuality,
  nowMs,
  groups,
  lane,
}: ConversationItemProps) {
  const contact = conversation.contact;
  const displayName = contact?.name || contact?.phone || t("unknown");
  const chips = tagChipRow(groups, contact?.tags ?? [], 3);

  // Only ad leads can ever be in a free-entry-point window, so the cheap
  // check short-circuits before resolving anything for ordinary threads.
  // `nowMs` is passed in rather than read here: render must stay pure, and
  // one clock for the whole list beats a timer per row.
  // `messages: []` is deliberate — see the badge's own comment below.
  const freeWindow =
    conversation.ad_referral !== undefined &&
    resolveConversationWindows({
      conversation,
      messages: [],
      now: nowMs,
    }).fep.open;

  const handleClick = useCallback(() => {
    onSelect(conversation);
  }, [onSelect, conversation]);

  const handleMouseEnter = useCallback(() => {
    onHover(conversation.id);
  }, [onHover, conversation.id]);

  const handleMarkUnread = useCallback(() => {
    onMarkUnread?.(conversation.id);
  }, [onMarkUnread, conversation.id]);

  const timeAgo = conversation.last_message_at
    ? formatDistanceToNow(new Date(conversation.last_message_at), {
        addSuffix: false,
      })
    : "";

  // Chasing lane (Task 7): the timestamp slot shows neglect, not a
  // snippet timestamp — how long the thread has sat quiet plus how many
  // nudges the sequence has already sent, instead of "3d". Uses the
  // shared `nowMs` clock (NOT a fresh `Date.now()` call, unlike
  // `timeAgo` above, which delegates to date-fns and reads the clock
  // internally) — a direct `Date.now()` here is a lint error
  // (`react-hooks/purity`: calling an impure function during render),
  // and `nowMs` is exactly the value this file already threads down for
  // this purpose (see the free-window badge above).
  const isChasing = lane === "chasing";
  const chasingDays = conversation.last_message_at
    ? Math.floor(
        (nowMs - new Date(conversation.last_message_at).getTime()) /
          86_400_000,
      )
    : 0;
  const needsDecision = isChasing && conversation.sequenceStatus === "exhausted";

  // Forced-Chasing badge (Task 7, spec 2026-07-28-inbox-manual-
  // overrides): a row can land in Chasing either by aging in (the
  // `chasingDays`/nudge detail above) or by a human marking it ghosted
  // by hand (`chasingForcedAt`) — the two are not distinguishable from
  // `chasingDays` alone, so this badges the manual case explicitly.
  const isForcedChasing = isChasing && !!conversation.chasing_forced_at;

  // Snoozed lane (Task 7): the timestamp slot shows the wake time
  // instead of the plain relative time every other lane shows — the
  // reason the row is even in this list. `snoozed_until` is a real
  // presence-flagged column (unlike `chasing_forced_at`'s badge above,
  // this lane's row set is already `eq("snoozedUntil", ...)`-filtered
  // server-side, so every row shown here has one), formatted absolute
  // (not "in 3h") since a wake time days out reads better as a date.
  const isSnoozed = lane === "snoozed";

  // Only a read row can be put back — an unread one already shows the
  // badge this restores, and `markUnread` no-ops on it server-side.
  const canMarkUnread = !!onMarkUnread && conversation.unread_count === 0;

  return (
    // The row stays a single <button>; the mark-unread control is its
    // SIBLING, overlaid on the corner. Nesting it inside would put a
    // button in a button — invalid HTML, and browsers recover by
    // hoisting it out, which drops the row's own click handling.
    <div className="group relative">
      <button
        onClick={handleClick}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={onHoverEnd}
        className={cn(
          "flex w-full items-start gap-3 px-3 py-3 text-left transition-colors hover:bg-muted/50",
          isActive && "border-l-2 border-primary bg-muted/70"
        )}
      >
        {/* Avatar */}
        <ContactAvatar
          displayName={displayName}
          seed={contact?.phone_normalized || contact?.phone || ""}
          photoUrl={contact?.avatar_url}
          size="md"
        />

        {/* Content */}
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-sm font-medium text-foreground">
              {displayName}
            </span>
            {/* Timestamp slot — swapped, not restructured, on the
                Chasing/Snoozed lanes: neglect detail (quiet-days + nudge
                count) or the wake time, instead of the plain relative
                time every other lane still shows here. */}
            <span className="shrink-0 text-right text-[11px] text-muted-foreground">
              {isChasing ? (
                <>
                  <span className="block">
                    {t("chasingQuietDays", { days: chasingDays })}
                  </span>
                  <span className="block">
                    {t("chasingProgress", {
                      sent: conversation.followUpsSent ?? 0,
                    })}
                  </span>
                </>
              ) : isSnoozed ? (
                <span className="block">
                  {t("snoozedUntilRow", {
                    when: conversation.snoozed_until
                      ? format(new Date(conversation.snoozed_until), "MMM d, h:mm a")
                      : "",
                  })}
                </span>
              ) : (
                timeAgo
              )}
            </span>
          </div>
          <div className="mt-0.5 flex items-center justify-between gap-2">
            <p className="truncate text-xs text-muted-foreground">
              {conversation.last_message_text || t("noMessagesYet")}
            </p>
            <div className="flex shrink-0 items-center gap-1.5">
              {/* Forced-Chasing badge — a human marked this ghosted by
                  hand, distinct from a row that aged in on its own. A
                  neutral pill (not `STATUS_COLORS.pending`'s amber below,
                  which reads as "needs a decision" — being forced isn't
                  itself a decision the agent is behind on). */}
              {isForcedChasing && (
                <span className="inline-flex items-center rounded-full bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
                  {t("forcedChasingBadge")}
                </span>
              )}
              {/* Chasing lane: badge a sequence the ladder has already
                  run out on — an agent decision, not automation, is
                  what happens next. Reuses `STATUS_COLORS`'s "pending"
                  (amber) tone rather than inventing a fourth status
                  color for one badge. */}
              {needsDecision && (
                <span
                  className={cn(
                    "inline-flex items-center rounded-full px-1.5 py-0.5 text-[11px] font-medium text-white",
                    STATUS_COLORS.pending,
                  )}
                >
                  {t("chasingNeedsDecision")}
                </span>
              )}
              {/* Ad lead still inside Meta's 72h free-entry-point window,
                  so every message to it — templates included — costs
                  nothing. Lets an agent triage the free ones first without
                  opening each thread.

                  Resolved from stored fields only: the thread view can fall
                  back to scanning its loaded messages, but the list would
                  have to load every thread's messages to do the same. Rows
                  that predate those fields show no badge here while still
                  showing the window inside the thread; they self-heal on
                  the conversation's next message. */}
              {freeWindow && (
                <span
                  title={tWindow("listFreeBadgeTitle")}
                  className="inline-flex items-center rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[11px] font-medium text-emerald-400"
                >
                  {tWindow("listFreeBadge")}
                </span>
              )}
              {/* Lead-quality progress. The panel inside the thread badges
                  the same `pending` count, from the same server-side
                  `stepStates` — an agent could not otherwise tell which
                  threads still owed an answer without opening every one,
                  which is most of why the panel went unused.

                  Three tones, because the three states call for different
                  things and a single count would flatten them:
                    · questions open  → primary, this row wants an answer
                    · all answered    → emerald tick, nothing to do
                    · stopped at a No → muted, nothing is ANSWERABLE right
                      now (the No is still correctable inside the thread,
                      so it is not "done" — it just must not nag).
                  Kept last-but-one so it sits beside the assignee chip
                  rather than competing with the lane badges above. */}
              {conversation.leadQuality && (
                <span
                  title={
                    conversation.leadQuality.pending > 0
                      ? tQuality("listBadgeTitle", {
                          pending: conversation.leadQuality.pending,
                        })
                      : conversation.leadQuality.ended
                        ? tQuality("listBadgeEndedTitle")
                        : tQuality("listBadgeDoneTitle")
                  }
                  className={cn(
                    "inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[11px] font-medium tabular-nums",
                    conversation.leadQuality.pending === 0
                      ? conversation.leadQuality.ended
                        ? "bg-muted text-muted-foreground"
                        : "bg-emerald-500/15 text-emerald-400"
                      : "bg-primary/15 text-primary",
                  )}
                >
                  <Gauge className="h-3 w-3 shrink-0" />
                  {conversation.leadQuality.answered}/
                  {conversation.leadQuality.total}
                </span>
              )}
              {assignee.kind !== "unassigned" && (
                <span
                  title={
                    assignee.kind === "you" ? t("assignedToYou") : assignee.name
                  }
                  className={cn(
                    "inline-flex items-center rounded-full px-1.5 py-0.5 text-[11px] font-medium",
                    assignee.kind === "you"
                      ? "bg-primary/15 text-primary"
                      : "bg-muted text-muted-foreground"
                  )}
                >
                  {assignee.kind === "you"
                    ? t("assignedToYou")
                    : assignee.name.charAt(0).toUpperCase()}
                </span>
              )}
              {conversation.unread_count > 0 && (
                <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[11px] font-bold text-primary-foreground">
                  {conversation.unread_count}
                </span>
              )}
              <span
                className={cn(
                  "h-2 w-2 rounded-full",
                  STATUS_COLORS[conversation.status]
                )}
                title={conversation.status}
              />
            </div>
          </div>
          {chips.visible.length > 0 && (
            <div className="mt-1.5 flex flex-wrap items-center gap-1">
              {chips.visible.map((tag) => (
                <span
                  key={tag.id}
                  className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium"
                  style={{ backgroundColor: `${tag.color}20`, color: tag.color }}
                >
                  {tag.source === "ad" && (
                    <Megaphone
                      className="mr-1 h-2.5 w-2.5 shrink-0"
                      role="img"
                      aria-label={t("fromAd")}
                    />
                  )}
                  {tag.name}
                </span>
              ))}
              {chips.overflow > 0 && (
                <span className="rounded-full bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
                  +{chips.overflow}
                </span>
              )}
            </div>
          )}
        </div>
      </button>

      {/* Mark-as-unread. Sits over the timestamp (the row's quietest
          corner) on its own opaque chip, so it reads as a control
          rather than smudging the text underneath.

          Hover-revealed on desktop only: coarse pointers have no hover
          state, so `sm:` gates the hiding rather than the showing —
          below that breakpoint the button is simply always there, and
          the list is the full-width pane anyway. `focus-visible:` keeps
          it reachable by keyboard, where "revealed on hover" would
          otherwise mean "invisible while focused". */}
      {canMarkUnread && (
        <button
          type="button"
          onClick={handleMarkUnread}
          aria-label={t("markUnread")}
          title={t("markUnread")}
          className={cn(
            "absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded-md",
            "bg-card text-muted-foreground shadow-sm transition-opacity",
            "hover:bg-muted hover:text-foreground",
            "sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100"
          )}
        >
          <Mail className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}
