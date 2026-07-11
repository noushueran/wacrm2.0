"use client";

import { useEffect } from "react";
import { X } from "lucide-react";
import { useTranslations } from "next-intl";
import type { Contact } from "@/types";
import { cn } from "@/lib/utils";
import { ContactSidebar } from "./contact-sidebar";

interface ContactPanelDrawerProps {
  open: boolean;
  onClose: () => void;
  contact: Contact | null;
}

/**
 * On-demand contact details, shown as a slide-over on the right edge of
 * the thread (opened by clicking the header name/number). Absolutely
 * positioned inside the thread's `relative` center column so it overlays
 * the chat without resizing it. Desktop: a transparent scrim keeps the
 * chat visible; mobile: a light dim + full-width sheet.
 */
export function ContactPanelDrawer({
  open,
  onClose,
  contact,
}: ContactPanelDrawerProps) {
  const t = useTranslations("Inbox.sidebar");

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  return (
    <>
      {/* Scrim — catches outside clicks to close. */}
      <div
        aria-hidden
        onClick={onClose}
        className={cn(
          "absolute inset-0 z-20 bg-foreground/10 transition-opacity lg:bg-transparent",
          open ? "opacity-100" : "pointer-events-none opacity-0",
        )}
      />
      {/* Panel */}
      <aside
        aria-label={t("contactInfo")}
        aria-hidden={!open}
        className={cn(
          "absolute inset-y-0 right-0 z-30 flex w-full flex-col border-l border-border bg-card shadow-xl transition-transform duration-200 ease-out sm:w-[360px]",
          open ? "translate-x-0" : "translate-x-full",
        )}
      >
        <div className="flex h-12 shrink-0 items-center justify-between border-b border-border px-4">
          <span className="text-sm font-semibold text-foreground">
            {t("contactInfo")}
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("close")}
            className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1">
          <ContactSidebar contact={contact} />
        </div>
      </aside>
    </>
  );
}
