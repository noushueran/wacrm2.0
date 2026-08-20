"use client";

import { Check, ChevronDown, ListChecks, Megaphone } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { PresenceDot } from "@/components/presence/presence-dot";
import { QualificationChip } from "@/components/inbox/qualification-chip";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useQuery } from "@/lib/convex/cached";
import { UI_FUNNEL_STAGES, type UiFunnelStageKey } from "@/lib/inbox/funnel";
import { presenceLabel } from "@/lib/presence";
import { cn } from "@/lib/utils";
import type { Profile, Tag } from "@/types";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import type { PresenceStatus } from "@/lib/presence";

export interface LeadPopoverProps {
  /** Rendered inside the trigger; produced by `leadButtonLabel`. */
  label: string;
  /** Drives the trigger's accent — true once a stage is set. */
  active: boolean;
  conversationId: Id<"conversations"> | null;
  currentStage: UiFunnelStageKey | null;
  onStageSelect: (stage: UiFunnelStageKey) => void;
  profiles: Profile[];
  assignedAgentId: string | null;
  currentUserId: string | null;
  /** Supervisor+ gets the full teammate list; an agent gets claim/release. */
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
  /** A viewer sees the read-only Context and Tags sections only — stage and
   * assignee are agent+ writes the server would reject. */
  readOnly: boolean;
}

/**
 * Everything that answers "what kind of lead is this?" — stage, assignee,
 * ad provenance, qualification progress, tags — behind one trigger.
 *
 * The four used to be two dropdowns plus three badge families competing
 * for room in the header row. They are one question, so they get one home.
 *
 * Because the popup unmounts while closed, `QualificationChip`'s Convex
 * query only runs once the popover is opened, rather than on every thread
 * open. That is deliberate.
 */
export function LeadPopover(props: LeadPopoverProps) {
  const t = useTranslations("Inbox.messageThread");
  const tFunnel = useTranslations("Inbox.funnel");
  const [open, setOpen] = useState(false);

  const hasTags = props.tags.length > 0 || props.tagOverflow > 0;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label={t("leadFallback")}
        className={cn(
          "inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-xs hover:bg-muted",
          props.active ? "text-primary" : "text-muted-foreground",
        )}
      >
        <ListChecks className="h-3.5 w-3.5 shrink-0" />
        {/* `lg:` rather than `sm:` — deliberate. Between 640 and 1024 the
            header carries the most at once: the window pill has appeared,
            the mobile back button has not yet gone, and the control cluster
            never shrinks. This label is the widest thing that can give way
            (~124px, e.g. "Itinerary created · KB"), and nothing is lost by
            dropping it: the icon and aria-label still name the control, and
            every value it displays is inside the popover it opens. Without
            this the window pill gets clipped in that band. */}
        <span className="hidden lg:inline">{props.label}</span>
        <ChevronDown className="h-3 w-3 shrink-0" />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 gap-0 p-0">
        {!props.readOnly && (
          <Section title={t("leadSectionStage")}>
            {UI_FUNNEL_STAGES.map((s) => {
              const selected = props.currentStage === s.key;
              return (
                <button
                  key={s.key}
                  type="button"
                  onClick={() => {
                    props.onStageSelect(s.key);
                    setOpen(false);
                  }}
                  className={cn(
                    "flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted",
                    selected ? "text-primary" : "text-popover-foreground",
                  )}
                >
                  {tFunnel(`stage.${s.key}`)}
                  {selected && <Check className="h-3 w-3" />}
                </button>
              );
            })}
          </Section>
        )}

        {!props.readOnly && (
          <Section title={t("leadSectionAssignee")} bordered>
            {props.canAssignToOthers ? (
              <>
                {props.profiles.length === 0 ? (
                  <p className="px-2 py-1.5 text-sm text-muted-foreground">
                    {t("noTeammates")}
                  </p>
                ) : (
                  props.profiles.map((p) => {
                    const selected = p.user_id === props.assignedAgentId;
                    const presence = props.getPresence(p.user_id);
                    return (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => {
                          props.onAssignChange(p.user_id);
                          setOpen(false);
                        }}
                        className={cn(
                          "flex w-full items-center rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted",
                          selected ? "text-primary" : "text-popover-foreground",
                        )}
                      >
                        <PresenceDot
                          status={presence}
                          label={presenceLabel(
                            presence,
                            props.getLastSeenAt(p.user_id),
                            props.now,
                          )}
                          className="mr-2"
                        />
                        <span className="flex-1 truncate">
                          {p.full_name}
                          {p.user_id === props.currentUserId ? t("me") : ""}
                        </span>
                        {selected && <Check className="ml-2 h-3 w-3" />}
                      </button>
                    );
                  })
                )}
                {props.assignedAgentId && (
                  <button
                    type="button"
                    onClick={() => {
                      props.onAssignChange(null);
                      setOpen(false);
                    }}
                    className="flex w-full rounded-md px-2 py-1.5 text-left text-sm text-muted-foreground hover:bg-muted"
                  >
                    {t("unassign")}
                  </button>
                )}
              </>
            ) : props.mine ? (
              <button
                type="button"
                onClick={() => {
                  props.onAssignChange(null);
                  setOpen(false);
                }}
                className="flex w-full rounded-md px-2 py-1.5 text-left text-sm text-popover-foreground hover:bg-muted"
              >
                {t("release")}
              </button>
            ) : (
              <button
                type="button"
                disabled={!props.isPool || !props.currentUserId}
                onClick={() => {
                  if (props.currentUserId) {
                    props.onAssignChange(props.currentUserId);
                    setOpen(false);
                  }
                }}
                className="flex w-full rounded-md px-2 py-1.5 text-left text-sm text-popover-foreground hover:bg-muted disabled:opacity-50"
              >
                {t("claim")}
              </button>
            )}
          </Section>
        )}

        <ContextSection isAdLead={props.isAdLead} conversationId={props.conversationId} />

        {hasTags && (
          <Section title={t("leadSectionTags")} bordered>
            <div className="flex flex-wrap items-center gap-1.5 px-2 py-1">
              {props.tags.map((tag) => (
                <span
                  key={tag.id}
                  className="inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-medium"
                  style={{ backgroundColor: `${tag.color}20`, color: tag.color }}
                >
                  {tag.source === 'ad' && (
                    <Megaphone
                      className="mr-1 h-2.5 w-2.5 shrink-0"
                      role="img"
                      aria-label={t('fromAd')}
                    />
                  )}
                  {tag.name}
                </span>
              ))}
              {props.tagOverflow > 0 && (
                <span className="inline-flex shrink-0 items-center rounded-full bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
                  +{props.tagOverflow}
                </span>
              )}
            </div>
          </Section>
        )}
      </PopoverContent>
    </Popover>
  );
}

/**
 * Owns the qualification query so it can tell whether it has anything to
 * show — the ad badge, the qualification chip, or neither — before
 * deciding whether to render the "Context" heading at all. Rendered only
 * inside `PopoverContent`, which Base UI unmounts while closed, so this
 * query still only fires while the popover is open.
 */
function ContextSection({
  isAdLead,
  conversationId,
}: {
  isAdLead: boolean;
  conversationId: Id<"conversations"> | null;
}) {
  const t = useTranslations("Inbox.messageThread");
  const session = useQuery(
    api.qualification.getSessionForConversation,
    conversationId ? { conversationId } : "skip",
  );
  const hasChip =
    !!session && (session.status === "qualified" || session.status === "collecting");

  if (!isAdLead && !hasChip) return null;

  return (
    <Section title={t("leadSectionContext")} bordered>
      <div className="flex flex-wrap items-center gap-1.5 px-2 py-1">
        {isAdLead && (
          <span className="inline-flex items-center gap-1 rounded-full border border-primary/40 px-2 py-0.5 text-[11px] text-primary">
            <Megaphone className="h-3 w-3" />
            {t("adLeadBadge")}
          </span>
        )}
        <QualificationChip conversationId={conversationId} />
      </div>
    </Section>
  );
}

function Section({
  title,
  bordered,
  children,
}: {
  title: string;
  bordered?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("p-1.5", bordered && "border-t border-border")}>
      <p className="px-2 pb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </p>
      {children}
    </div>
  );
}
