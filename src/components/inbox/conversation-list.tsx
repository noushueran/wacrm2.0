"use client";

import { useState, useCallback, useMemo, useRef, useEffect, memo } from "react";
import { useQuery } from "convex/react";
import type { PaginationStatus } from "convex/react";
import { api } from "../../../convex/_generated/api";
import {
  matchesContactFilters,
  resolveAssignee,
} from "@/lib/inbox/conversations";
import { PrefetchThread } from "@/components/inbox/prefetch-thread";
import { toUiTag, toUiTagGroup, toUiMemberProfile } from "@/lib/convex/adapters";
import { tagChipRow } from "@/lib/inbox/labels";
import { useAuth } from "@/hooks/use-auth";
import { cn } from "@/lib/utils";
import type { Conversation, ConversationStatus, Tag, TagGroup, Profile } from "@/types";
import { Search, ChevronDown, X } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
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
import { OwnSpendLine } from "@/components/inbox/own-spend-line";

/** Which assignment bucket the list shows. `all` omits the server-side
 *  `assignment` filter entirely (today's default view). */
export type AssignmentTab = "all" | "mine" | "unassigned";

interface ConversationListProps {
  activeConversationId: string | null;
  onSelect: (conversation: Conversation) => void;
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
  conversations,
  loadMore,
  status,
  assignment,
  onAssignmentChange,
}: ConversationListProps) {
  const t = useTranslations("Inbox.conversationList");

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
  // Memoized so `tagsById` below can hold — a fresh array here rebuilt
  // that map on every render.
  const tags = useMemo(() => (tagDocs ?? []).map(toUiTag), [tagDocs]);

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
  const { user } = useAuth();
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

  const activeFilter = FILTER_OPTIONS.find((o) => o.value === filter);

  return (
    // w-full on mobile so the list occupies the whole viewport when it's
    // the single pane showing; fixed 320px on desktop where it shares the
    // row with the thread + contact sidebar.
    <div className="flex h-full w-full flex-col border-r border-border bg-card lg:w-80">
      {/* Agent-only "this month" spend line — self-hides for
          supervisors/admins (who have the Dashboard card instead) and
          when lead-value tracking is off. */}
      <OwnSpendLine />

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
            className={cn(
              "flex-1 rounded-md px-2 py-1 text-xs font-medium transition-colors",
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
                  <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground">
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
                  className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] text-foreground hover:bg-muted/70"
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
                className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] text-foreground hover:bg-muted/70"
              >
                <span className="max-w-24 truncate">{selectedCompany}</span>
                <X className="h-3 w-3" />
              </button>
            )}
            <button
              onClick={clearContactFilters}
              className="px-1 text-[11px] text-muted-foreground hover:text-foreground"
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
        {status === "LoadingFirstPage" ? (
          <div className="flex items-center justify-center py-12">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="px-4 py-12 text-center">
            <p className="text-sm text-muted-foreground">
              {assignment === "mine"
                ? t("emptyMine")
                : assignment === "unassigned"
                  ? t("emptyUnassigned")
                  : t("noConversations")}
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
                currentUserId={user?.id}
                profilesById={profilesById}
                onHover={handleHover}
                onHoverEnd={handleHoverEnd}
                t={t}
                groups={groups}
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
    </div>
  );
}

interface ConversationItemProps {
  conversation: Conversation;
  isActive: boolean;
  onSelect: (conversation: Conversation) => void;
  /** Inputs for this row's assignee chip, rather than a pre-resolved
   *  `AssigneeDisplay` — resolving it in the parent's `.map` produced a
   *  fresh object per row on every render, which defeated the memo. Both
   *  of these are stable. */
  currentUserId: string | undefined;
  profilesById: Map<string, Profile>;
  /** Pointer entered this row — parent debounces then prefetches it. */
  onHover: (conversationId: string) => void;
  /** Pointer left this row before the debounce fired — cancel it. */
  onHoverEnd: () => void;
  t: ReturnType<typeof useTranslations>;
  groups: TagGroup[];
}

/**
 * Memoized: hovering a row flips the parent's `prefetchId` state, so the
 * list re-renders constantly as the pointer moves down it. With every
 * prop here value-stable, the other 29 rows now skip that render.
 */
const ConversationItem = memo(function ConversationItem({
  conversation,
  isActive,
  onSelect,
  currentUserId,
  profilesById,
  onHover,
  onHoverEnd,
  t,
  groups,
}: ConversationItemProps) {
  const contact = conversation.contact;
  const displayName = contact?.name || contact?.phone || t("unknown");
  const initials = displayName.charAt(0).toUpperCase();
  const chips = tagChipRow(groups, contact?.tags ?? [], 3);
  const assignee = useMemo(
    () => resolveAssignee(conversation, currentUserId, profilesById),
    [conversation, currentUserId, profilesById],
  );

  const handleClick = useCallback(() => {
    onSelect(conversation);
  }, [onSelect, conversation]);

  const handleMouseEnter = useCallback(() => {
    onHover(conversation.id);
  }, [onHover, conversation.id]);

  const timeAgo = conversation.last_message_at
    ? formatDistanceToNow(new Date(conversation.last_message_at), {
        addSuffix: false,
      })
    : "";

  return (
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
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-medium text-foreground">
        {contact?.avatar_url ? (
          <img
            src={contact.avatar_url}
            alt={displayName}
            className="h-10 w-10 rounded-full object-cover"
          />
        ) : (
          initials
        )}
      </div>

      {/* Content */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-sm font-medium text-foreground">
            {displayName}
          </span>
          <span className="shrink-0 text-[10px] text-muted-foreground">{timeAgo}</span>
        </div>
        <div className="mt-0.5 flex items-center justify-between gap-2">
          <p className="truncate text-xs text-muted-foreground">
            {conversation.last_message_text || t("noMessagesYet")}
          </p>
          <div className="flex shrink-0 items-center gap-1.5">
            {assignee.kind !== "unassigned" && (
              <span
                title={
                  assignee.kind === "you" ? t("assignedToYou") : assignee.name
                }
                className={cn(
                  "inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium",
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
              <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground">
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
                className="rounded-full px-2 py-0.5 text-[10px] font-medium"
                style={{ backgroundColor: `${tag.color}20`, color: tag.color }}
              >
                {tag.name}
              </span>
            ))}
            {chips.overflow > 0 && (
              <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                +{chips.overflow}
              </span>
            )}
          </div>
        )}
      </div>
    </button>
  );
});
