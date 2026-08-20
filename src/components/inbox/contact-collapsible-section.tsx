"use client";

import type { LucideIcon } from "lucide-react";
import { ChevronRight } from "lucide-react";
import { useTranslations } from "next-intl";

import { cn } from "@/lib/utils";
import { shouldShowMarker, type PanelSectionKey } from "@/lib/inbox/panelSections";

/**
 * One collapsible block of the contact panel.
 *
 * Purely presentational — open/closed state and its persistence live in
 * `ContactSidebar`, because seven of these share one stored object and one
 * `editing` flag; `resolveSectionOpen` decides, this renders.
 *
 * `marker` is what stops collapsing from being lossy: with seven sections
 * shut, "collapsed" and "empty" are indistinguishable without it, so a
 * section holding data shows a count (or a dot where a count means
 * nothing) on its closed header.
 */
export function ContactCollapsibleSection({
  sectionKey,
  icon: Icon,
  label,
  marker,
  open,
  forced,
  onToggle,
  children,
}: {
  sectionKey: PanelSectionKey;
  icon: LucideIcon;
  label: string;
  marker: number | boolean | null;
  open: boolean;
  /** Edit mode is holding this section open, so `resolveSectionOpen`
   *  outranks any toggle and the header stops being a control.
   *
   *  Without this the header was a dead click: `onToggle(false)` persisted
   *  `false`, `resolveSectionOpen` still returned `true` because `editing`
   *  won, so nothing moved — and the section the user thought they had
   *  closed vanished the moment they hit Save. The button is disabled
   *  instead, and its chevron mutes to an indicator, so what the control
   *  looks like matches what it does.
   *
   *  Derived (`editing && editable`) and passed in like `open`: this
   *  component owns no state. */
  forced: boolean;
  onToggle: (next: boolean) => void;
  children: React.ReactNode;
}) {
  const t = useTranslations("Inbox.sidebar");
  const showMarker = shouldShowMarker({ open, marker });

  return (
    <div className="border-t border-border">
      <button
        type="button"
        onClick={() => onToggle(!open)}
        disabled={forced}
        aria-disabled={forced}
        aria-expanded={open}
        aria-controls={`panel-section-${sectionKey}`}
        // No collapse/expand tooltip while forced: it would promise a
        // toggle the button cannot perform.
        title={
          forced
            ? undefined
            : open
              ? t("collapseSection", { label })
              : t("expandSection", { label })
        }
        className={cn(
          "flex w-full items-center gap-2 px-1 py-2.5 text-xs font-medium uppercase tracking-wider text-muted-foreground transition-colors",
          forced ? "cursor-default" : "hover:text-foreground",
        )}
      >
        {/* Muted rather than removed while forced — it still reads as the
            open-state indicator, and keeping it holds the label's
            alignment steady across entering and leaving edit mode. */}
        <ChevronRight
          className={cn(
            "h-3 w-3 shrink-0 transition-transform",
            open && "rotate-90",
            forced && "opacity-40",
          )}
        />
        <Icon className="h-3 w-3 shrink-0" />
        <span className="truncate">{label}</span>
        {showMarker && (
          <span
            className="ml-auto shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-normal normal-case tracking-normal text-muted-foreground"
            title={t("sectionHasContent")}
          >
            {typeof marker === "number" ? marker : "•"}
          </span>
        )}
      </button>
      {open && (
        <div id={`panel-section-${sectionKey}`} className="pb-3">
          {children}
        </div>
      )}
    </div>
  );
}
