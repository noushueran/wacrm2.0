"use client";

import { useTranslations } from "next-intl";
import { BadgeCheck, ClipboardCheck } from "lucide-react";

import { useQuery } from "@/lib/convex/cached";
import { Badge } from "@/components/ui/badge";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";

/**
 * Thread-header qualification progress chip (spec §10). Renders nothing
 * when the conversation has no session (feature off / pre-feature
 * history / admin channel) or when the session ended without
 * qualifying — the header stays calm. `collecting` shows answered/
 * expected (+ score once the analysis pass produced one) with the next
 * missing item as the tooltip; `qualified` shows a green check.
 */
export function QualificationChip({
  conversationId,
}: {
  conversationId: Id<"conversations"> | null;
}) {
  const t = useTranslations("Inbox.qualification");
  const session = useQuery(
    api.qualification.getSessionForConversation,
    conversationId ? { conversationId } : "skip",
  );
  if (!session) return null;

  if (session.status === "qualified") {
    return (
      <Badge
        variant="outline"
        className="ml-1 hidden gap-1 border-emerald-500/40 text-[10px] text-emerald-500 sm:inline-flex"
      >
        <BadgeCheck className="h-3 w-3" />
        {t("qualifiedBadge")}
        {session.score !== null ? ` · ${session.score}` : ""}
      </Badge>
    );
  }

  if (session.status !== "collecting") return null;

  return (
    <Badge
      variant="outline"
      className="ml-1 hidden gap-1 border-primary/40 text-[10px] text-primary sm:inline-flex"
      title={
        session.missingHint
          ? t("progressTitle", { hint: session.missingHint })
          : undefined
      }
    >
      <ClipboardCheck className="h-3 w-3" />
      {session.answeredCount}/{session.expectedCount}
      {session.score !== null ? ` · ${session.score}` : ""}
    </Badge>
  );
}
