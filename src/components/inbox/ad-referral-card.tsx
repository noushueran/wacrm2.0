"use client";

import type { MessageAdReferral } from "@/types";
import { Megaphone, ExternalLink } from "lucide-react";
import { useTranslations } from "next-intl";

/** WhatsApp-style Click-to-WhatsApp ad preview, stacked above the first
 *  inbound message's content. Handles image ads, video ads (thumbnail),
 *  and text-only ads (no media block). */
export function AdReferralCard({ referral }: { referral: MessageAdReferral }) {
  const t = useTranslations("Inbox.bubble");
  const img =
    referral.stored_image_url ?? referral.image_url ?? referral.thumbnail_url;

  return (
    <div className="mb-2 overflow-hidden rounded-lg border border-border bg-background/50">
      <div className="flex items-center gap-1 px-2 pt-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        <Megaphone className="h-3 w-3" />
        {t("fromAd")}
      </div>
      <div className="flex gap-2 p-2">
        {img && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={img}
            alt=""
            loading="lazy"
            className="h-14 w-14 shrink-0 rounded object-cover"
          />
        )}
        <div className="min-w-0">
          {referral.headline && (
            <p className="truncate text-xs font-semibold text-foreground">
              {referral.headline}
            </p>
          )}
          {referral.body && (
            <p className="line-clamp-2 text-xs text-muted-foreground">
              {referral.body}
            </p>
          )}
          {referral.source_url && (
            <a
              href={referral.source_url}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-0.5 inline-flex items-center gap-0.5 text-[11px] text-primary hover:underline"
            >
              {t("viewAd")}
              <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </div>
      </div>
    </div>
  );
}
