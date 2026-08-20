"use client";

import { useTranslations } from "next-intl";
import { UserMinus, UserPlus } from "lucide-react";
import { format } from "date-fns";

import {
  assignmentEventLine,
  UNKNOWN_MEMBER,
  type AssignmentEventView,
} from "@/lib/inbox/assignmentEvents";

/**
 * One ownership handover, inline in the thread. Deliberately a centred
 * pill in the date separator's visual language rather than a card: it is
 * context for the conversation, not a contribution to it.
 *
 * All branching lives in `assignmentEventLine`; this only renders.
 */
export function AssignmentEvent({
  event,
}: {
  event: AssignmentEventView & { _creationTime: number };
}) {
  const t = useTranslations("Inbox.assignmentEvents");
  const { key, values } = assignmentEventLine(event);

  // `assignmentEventLine` stays language-free and emits a sentinel for a
  // member who has left; the translated word is substituted here.
  const resolved = Object.fromEntries(
    Object.entries(values).map(([k, v]) => [
      k,
      v === UNKNOWN_MEMBER ? t("unknownMember") : v,
    ]),
  );

  const Icon = event.kind === "assigned" ? UserPlus : UserMinus;

  return (
    <div className="flex justify-center py-1">
      <span className="inline-flex max-w-[85%] items-center gap-1.5 rounded-full bg-muted/60 px-2.5 py-0.5 text-[11px] text-muted-foreground">
        <Icon className="h-3 w-3 shrink-0" />
        <span className="truncate">{t(key, resolved)}</span>
        <span className="shrink-0 opacity-70">
          {format(new Date(event._creationTime), "HH:mm")}
        </span>
      </span>
    </div>
  );
}
