"use client";

import {
  ArchiveIcon,
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  Clock,
  Mail,
  MoreVertical,
} from "lucide-react";
import { useTranslations } from "next-intl";

import { ContactAvatar } from "@/components/inbox/contact-avatar";
import { LeadPopover } from "@/components/inbox/lead-popover";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { leadButtonLabel, windowPill } from "@/lib/inbox/threadHeader";
import type { UiFunnelStageKey } from "@/lib/inbox/funnel";
import { cn } from "@/lib/utils";
import { formatPhoneIntl } from "@/lib/whatsapp/phone-utils";
import type { Profile, Tag } from "@/types";
import type { Id } from "../../../convex/_generated/dataModel";
import type { PresenceStatus } from "@/lib/presence";

const TONE_CLASS = {
  primary: "text-primary",
  expired: "text-red-400",
  free: "text-emerald-400",
} as const;

export interface ThreadHeaderProps {
  displayName: string;
  phone: string;
  /** Contact photo, already resolved by `toUiContact`. Absent for almost
   *  every contact — WhatsApp supplies no customer pictures, so one only
   *  exists where a teammate uploaded it. `ContactAvatar` draws the
   *  derived colour/initials disc in that case. `phone` above doubles as
   *  the colour seed. */
  photoUrl?: string | null;
  onBack?: () => void;
  onToggleContactPanel?: () => void;
  contactPanelOpen?: boolean;

  sessionRemaining: string;
  sessionExpired: boolean;
  freeText: string | null;
  /** Tooltip for the free segment; already switched on `windows.fep.source`. */
  freeTitle: string | undefined;

  /** Null for a viewer, who gets no status control. */
  status: { label: string; value: string; color: string } | null;
  statusOptions: { label: string; value: string; color: string }[];
  onStatusChange: (value: string) => void;
  canEditStatus: boolean;

  canEditLead: boolean;
  conversationId: Id<"conversations"> | null;
  currentStage: UiFunnelStageKey | null;
  stageLabel: string | null;
  onStageSelect: (stage: UiFunnelStageKey) => void;
  profiles: Profile[];
  assignedAgentId: string | null;
  assigneeName: string | null;
  currentUserId: string | null;
  canAssignToOthers: boolean;
  mine: boolean;
  isPool: boolean;
  onAssignChange: (userId: string | null) => void;
  getPresence: (userId: string) => PresenceStatus;
  getLastSeenAt: (userId: string) => string | null;
  now: number;
  isAdLead: boolean;
  tags: Tag[];
  tagOverflow: number;

  showSnooze: boolean;
  showWake: boolean;
  onSnoozeThreeHours: () => void;
  onSnoozeTomorrow: () => void;
  onSnoozeNextWeek: () => void;
  onSnoozeCustom: () => void;
  onWake: () => void;

  showChaseNow: boolean;
  onChaseNow: () => void;
  showStopChasing: boolean;
  onStopChasing: () => void;
  showArchive: boolean;
  onArchive: () => void;
  showMarkUnread: boolean;
  onMarkUnread: () => void;
}

/**
 * The thread header: three zones on one row that never wraps.
 *
 * Identity shrinks (`min-w-0` + truncate), the window pill and the control
 * cluster do not (`shrink-0`). The previous single wrapping row changed
 * height and control position per conversation depending on which
 * conditional badges happened to render.
 */
export function ThreadHeader(props: ThreadHeaderProps) {
  const t = useTranslations("Inbox.messageThread");

  const segments = windowPill({
    sessionRemaining: props.sessionRemaining,
    sessionExpired: props.sessionExpired,
    freeText: props.freeText,
  });

  const label = leadButtonLabel({
    stageLabel: props.stageLabel,
    assigneeName: props.assigneeName,
    fallbackLabel: t("leadFallback"),
  });

  // The overflow trigger must not render when every item inside is hidden:
  // a viewer has no archive, no chase, no stop-chasing and no mark-unread,
  // and an empty menu that opens onto nothing is worse than no menu.
  const hasOverflow =
    props.showChaseNow ||
    props.showStopChasing ||
    props.showArchive ||
    props.showMarkUnread;

  // A viewer keeps the popover as a read-only window onto ad provenance
  // and tags, which the pre-refactor header showed them ungated — but
  // only when there is something in it to see.
  const showLead =
    props.canEditLead ||
    props.isAdLead ||
    props.tags.length > 0 ||
    props.tagOverflow > 0;

  return (
    <div className="flex items-center gap-2 border-b border-border bg-card px-3 py-3 sm:px-4">
      {/* Identity — the only zone allowed to shrink.

          `overflow-hidden` is load-bearing, not cosmetic. `min-w-0` is what
          lets the name truncate, but it also removes this zone's min-content
          floor: flexbox then hands the `shrink-0` control cluster its full
          width and crushes this zone toward zero, at which point ITS OWN
          `shrink-0` children (avatar, back button, window pill) overflow it
          and paint on top of the controls. Measured at a 560px column: the
          zone was 178px wide holding 229px of content, and the pill landed
          on the Status button. Clipping the pill is the acceptable failure;
          overlapping the controls is not. */}
      <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden sm:gap-3">
        {props.onBack && (
          <button
            type="button"
            onClick={props.onBack}
            aria-label={t("backToConversations")}
            className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground lg:hidden"
          >
            <ArrowLeft className="h-5 w-5" />
          </button>
        )}
        <ContactAvatar
          displayName={props.displayName}
          seed={props.phone}
          photoUrl={props.photoUrl}
          size="sm"
        />
        <button
          type="button"
          onClick={() => props.onToggleContactPanel?.()}
          aria-label={t("viewContactDetails")}
          aria-expanded={!!props.contactPanelOpen}
          className="group flex min-w-0 items-center gap-1 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-muted"
        >
          <span className="min-w-0">
            <span className="block truncate text-sm font-semibold text-foreground">
              {props.displayName}
            </span>
            <span className="block truncate text-xs text-muted-foreground">
              {formatPhoneIntl(props.phone)}
            </span>
          </span>
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
        </button>

        {/* Window pill — one border, up to two segments. */}
        {segments.length > 0 && (
          <span className="hidden shrink-0 items-center overflow-hidden rounded-full border border-border text-[11px] sm:inline-flex">
            {segments.map((seg, i) => (
              <span
                key={seg.key}
                title={seg.key === "free" ? props.freeTitle : undefined}
                className={cn(
                  "inline-flex items-center gap-1 px-2 py-0.5",
                  TONE_CLASS[seg.tone],
                  i > 0 && "border-l border-border",
                )}
              >
                {seg.key === "service" && <Clock className="h-3 w-3" />}
                {seg.text}
              </span>
            ))}
          </span>
        )}
      </div>

      {/* Controls — fixed width, never wrap. */}
      <div className="flex shrink-0 items-center gap-1.5">
        {props.canEditStatus && (
          <DropdownMenu>
            <DropdownMenuTrigger
              className={cn(
                "inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs hover:bg-muted",
                props.status?.color ?? "text-muted-foreground",
              )}
            >
              {props.status ? t(`status${props.status.label}`) : t("status")}
              <ChevronDown className="h-3 w-3" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="border-border bg-popover">
              {props.statusOptions.map((opt) => (
                <DropdownMenuItem
                  key={opt.value}
                  onClick={() => props.onStatusChange(opt.value)}
                  className={cn("text-sm", opt.color)}
                >
                  {t(`status${opt.label}`)}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}

        {showLead && (
          <LeadPopover
            label={label}
            active={!!props.currentStage}
            conversationId={props.conversationId}
            currentStage={props.currentStage}
            onStageSelect={props.onStageSelect}
            profiles={props.profiles}
            assignedAgentId={props.assignedAgentId}
            currentUserId={props.currentUserId}
            canAssignToOthers={props.canAssignToOthers}
            mine={props.mine}
            isPool={props.isPool}
            onAssignChange={props.onAssignChange}
            getPresence={props.getPresence}
            getLastSeenAt={props.getLastSeenAt}
            now={props.now}
            isAdLead={props.isAdLead}
            tags={props.tags}
            tagOverflow={props.tagOverflow}
            readOnly={!props.canEditLead}
          />
        )}

        {/* Snooze stays out of the overflow menu deliberately — it is a
            frequent action, and the icon-only form costs ~28px. */}
        {props.showWake && (
          <button
            type="button"
            onClick={props.onWake}
            className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            {t("wake")}
          </button>
        )}
        {props.showSnooze && (
          <div className="inline-flex items-stretch rounded-md text-muted-foreground">
            <button
              type="button"
              onClick={props.onSnoozeThreeHours}
              aria-label={t("snoozeThreeHours")}
              title={t("snoozeThreeHours")}
              className="inline-flex h-7 items-center rounded-l-md pl-2 pr-1.5 hover:bg-muted hover:text-foreground"
            >
              <Clock className="h-3.5 w-3.5" />
            </button>
            <DropdownMenu>
              <DropdownMenuTrigger
                aria-label={t("snooze")}
                className="inline-flex h-7 w-5 items-center justify-center rounded-r-md border-l border-border hover:bg-muted hover:text-foreground"
              >
                <ChevronDown className="h-3 w-3" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="border-border bg-popover">
                <DropdownMenuItem
                  onClick={props.onSnoozeTomorrow}
                  className="text-sm text-popover-foreground"
                >
                  {t("snoozeTomorrow")}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={props.onSnoozeNextWeek}
                  className="text-sm text-popover-foreground"
                >
                  {t("snoozeNextWeek")}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={props.onSnoozeCustom}
                  className="text-sm text-popover-foreground"
                >
                  {t("snoozeCustom")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}

        {hasOverflow && (
          <DropdownMenu>
            <DropdownMenuTrigger
              aria-label={t("more")}
              className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <MoreVertical className="h-4 w-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="border-border bg-popover">
              {props.showChaseNow && (
                <DropdownMenuItem
                  onClick={props.onChaseNow}
                  title={t("chaseNowTooltip")}
                  className="text-sm text-popover-foreground"
                >
                  {t("chaseNow")}
                </DropdownMenuItem>
              )}
              {props.showStopChasing && (
                <DropdownMenuItem
                  onClick={props.onStopChasing}
                  className="text-sm text-popover-foreground"
                >
                  {t("stopChasing")}
                </DropdownMenuItem>
              )}
              {props.showArchive && (
                <DropdownMenuItem
                  onClick={props.onArchive}
                  title={t("archiveTooltip")}
                  className="text-sm text-popover-foreground"
                >
                  <ArchiveIcon className="mr-2 h-3.5 w-3.5" />
                  {t("archive")}
                </DropdownMenuItem>
              )}
              {props.showMarkUnread && (
                <DropdownMenuItem
                  onClick={props.onMarkUnread}
                  className="text-sm text-popover-foreground"
                >
                  <Mail className="mr-2 h-3.5 w-3.5" />
                  {t("markUnread")}
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    </div>
  );
}
