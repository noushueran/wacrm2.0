"use client";

import { formatDistanceToNow } from "date-fns";
import { useTranslations } from "next-intl";
import type { UiFunnelStageKey } from "@/lib/inbox/funnel";
import { DoNotContactIndicator } from "./do-not-contact-banner";

export interface ContactStatusHeaderProps {
  /** Resolved display name of the assigned member, or `null` when the
   *  conversation is unassigned. Caller resolves the id → name lookup
   *  (same `api.members.list` mapping `message-thread.tsx` already does
   *  for its assign dropdown) — this component owns no queries. */
  assignedName: string | null;
  /** Current funnel stage key, or `null` when there's no funnel state
   *  to show (e.g. no conversation selected). */
  stage: UiFunnelStageKey | null;
  /** `conversation.lastMessageAt`, or `null` if never contacted. */
  lastContactedAt: number | null;
  /** `qualificationSessions.nextFollowUpAt`, or `null` if there is none
   *  (feature not reachable from the current session shape, or simply
   *  unset). The line is omitted entirely when absent — there's no
   *  "no follow-up" copy, unlike the other two fields. */
  nextFollowUpAt: number | null;
  /** Set → the whole strip is replaced by the compact
   *  `DoNotContactIndicator` below. `byName` is pre-resolved the same
   *  way `message-thread.tsx` already resolves `doNotContactByName`
   *  against the loaded member list.
   *
   *  This is state only, no Clear control: the actionable, full
   *  `DoNotContactBanner` already lives above the composer in
   *  `message-thread.tsx`, always visible and outside any scroll area.
   *  Rendering that same full banner a second time here put two
   *  identical red banners with two live Clear buttons on screen at
   *  once (Phase 2 final review, MINOR 2) — state lives in the panel,
   *  the action stays in the thread. */
  doNotContact: { at: number; byName: string | null } | null;
}

/**
 * Orientation strip at the top of the contact panel (spec Phase 2,
 * Task 3) — "where does this customer stand right now" before an agent
 * reads anything else below it.
 *
 * Presentational only: every value arrives already resolved from the
 * caller (`ContactSidebar`, wired in Task 6), which stays the single
 * place that talks to Convex. That keeps this component renderable in
 * the plain-node test environment and keeps query lifecycles in one
 * file.
 *
 * When `doNotContact` is set, the strip is REPLACED by the compact
 * `DoNotContactIndicator`, never shown alongside it — do-not-contact is
 * the only thing telling an agent why six kinds of automation have gone
 * quiet for this customer, and status text that competes with a stop
 * signal buries it.
 */
export function ContactStatusHeader({
  assignedName,
  stage,
  lastContactedAt,
  nextFollowUpAt,
  doNotContact,
}: ContactStatusHeaderProps) {
  const t = useTranslations("Inbox.activity");

  if (doNotContact) {
    return (
      <DoNotContactIndicator at={doNotContact.at} byName={doNotContact.byName} />
    );
  }

  const line1 = [
    assignedName ? t("assignedTo", { name: assignedName }) : t("unassigned"),
    stage ? t(`stage.${stage}`) : null,
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");

  const line2 = [
    lastContactedAt !== null
      ? t("lastContacted", {
          when: formatDistanceToNow(new Date(lastContactedAt), { addSuffix: true }),
        })
      : t("neverContacted"),
    nextFollowUpAt !== null
      ? t("nextFollowUp", {
          when: formatDistanceToNow(new Date(nextFollowUpAt), { addSuffix: true }),
        })
      : null,
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");

  return (
    <div className="min-w-0 space-y-0.5 border-b border-border px-3 py-2 text-[11px] leading-snug text-muted-foreground">
      <p className="truncate">{line1}</p>
      <p className="truncate">{line2}</p>
    </div>
  );
}
