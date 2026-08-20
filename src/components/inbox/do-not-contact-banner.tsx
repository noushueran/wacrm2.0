"use client";

import { useCallback, useState } from "react";
import { useTranslations } from "next-intl";
import { useMutation } from "convex/react";
import { format } from "date-fns";
import { Ban } from "lucide-react";
import { toast } from "sonner";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { Button } from "@/components/ui/button";

/**
 * The visible half of the do-not-contact gate. Every automated path
 * (auto-reply, qualification follow-ups, lead-sequence steps,
 * broadcasts, chase auto-assignment) silently stops for this contact —
 * without this banner an agent would have no way to learn why.
 *
 * A human is deliberately NOT blocked from messaging: the composer stays
 * usable. Machines are stopped; people are informed.
 */
export function DoNotContactBanner({
  contactId,
  at,
  byName,
  canClear,
}: {
  contactId: Id<"contacts">;
  at: number;
  byName: string | null;
  canClear: boolean;
}) {
  const t = useTranslations("Inbox.notes");
  const clear = useMutation(api.contactNotes.clearDoNotContact);
  const [clearing, setClearing] = useState(false);

  const handleClear = useCallback(async () => {
    setClearing(true);
    try {
      await clear({ contactId });
      toast.success(t("doNotContactCleared"));
    } catch {
      toast.error(t("doNotContactClearFailed"));
    } finally {
      setClearing(false);
    }
  }, [clear, contactId, t]);

  const date = format(new Date(at), "MMM d, yyyy");

  return (
    <div className="flex items-start gap-2 border-t border-destructive/30 bg-destructive/10 px-4 py-2">
      <Ban className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium text-destructive">
          {t("doNotContactTitle")}
        </p>
        <p className="mt-0.5 text-[12px] text-muted-foreground">
          {t("doNotContactBody")}
        </p>
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          {byName
            ? t("doNotContactSetBy", { name: byName, date })
            : t("doNotContactSetByUnknown", { date })}
        </p>
      </div>
      {canClear && (
        <Button
          size="sm"
          variant="outline"
          disabled={clearing}
          onClick={() => void handleClear()}
        >
          {t("doNotContactClear")}
        </Button>
      )}
    </div>
  );
}

/**
 * Compact one-line variant for the contact panel's status header
 * (`ContactStatusHeader`). The full `DoNotContactBanner` above already
 * renders above the composer in `message-thread.tsx` — always visible,
 * outside any scroll area, and the one with the live Clear button. With
 * the panel open too, rendering the full banner a second time put two
 * identical red banners with two live Clear controls on screen at once
 * (Phase 2 final review, MINOR 2), one of them inside the panel's scroll
 * area where it may not even be reachable. This variant states the same
 * fact — flagged, by whom, when — without a second action: state lives
 * in the panel, the action stays in the thread.
 */
export function DoNotContactIndicator({
  at,
  byName,
}: {
  at: number;
  byName: string | null;
}) {
  const t = useTranslations("Inbox.notes");
  const date = format(new Date(at), "MMM d, yyyy");

  return (
    <div className="flex items-center gap-1.5 border-b border-border px-3 py-2 text-[11px] text-destructive">
      <Ban className="h-3.5 w-3.5 shrink-0" />
      <span className="truncate">
        {t("doNotContactTitle")}
        {" — "}
        {byName
          ? t("doNotContactSetBy", { name: byName, date })
          : t("doNotContactSetByUnknown", { date })}
      </span>
    </div>
  );
}
