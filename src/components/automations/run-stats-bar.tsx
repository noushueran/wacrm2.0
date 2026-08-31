"use client"

import { useTranslations } from "next-intl"

// Pure, dependency-free module (see its own header) — safe to import
// straight into a client component, unlike anything that pulls in
// `convex/_generated` or `convex/server`.
import type { RunCounts } from "../../../convex/lib/automations/runStats"
import { cn } from "@/lib/utils"

export interface RunStatsBarProps {
  counts: RunCounts
  size?: "sm" | "md"
}

interface Figure {
  key: string
  value: number
  label: string
  /** Set only for the two figures the brief calls out for colour — every
   *  other figure stays neutral regardless of its value. */
  valueClassName?: string
}

/**
 * Shared Enrolled / Waiting / Sent / Failed strip — the one place both
 * the automations list (one line per automation) and a single
 * automation's logs page (page-level summary) render run outcomes, so
 * the two can never drift into disagreeing labels, colours, or what
 * "Sent" even means. `Sent` reads off `counts.completed` (a run that
 * finished clean, per `convex/lib/automations/runStats.ts`) and `Failed`
 * off `counts.failed`. `cancelled` only renders when non-zero, so the
 * common case — nothing has ever been cancelled — stays a clean four
 * figures instead of a fifth, always-zero one.
 *
 * `counts.truncated` (re-review fix, 2026-08): `countRunsBounded`
 * (`convex/automations.ts`) reads each status up to a cap, so a busy
 * automation's figures can be a FLOOR rather than an exact count — the
 * server already logs this (`console.warn`), but that goes to Convex
 * logs nobody looking at this page ever sees. Every figure gets a "+"
 * suffix and a footnote appears below the strip so the page itself says
 * so, matching the brief's own "reads as complete when it isn't" concern
 * — moved from the read (already fixed) to the payload otherwise.
 * Applied to every figure, not just `enrolled`: `countRunsBounded`
 * reports one account-wide flag, not which individual status(es) hit
 * the cap, so marking only some figures would imply a precision this
 * data doesn't have.
 *
 * Self-contained: fetches its own translations rather than taking `t` as
 * a prop, since its namespace (`Automations.stats`) differs from either
 * caller's own (`Automations.list` / `Automations.logs`).
 */
export function RunStatsBar({ counts, size = "md" }: RunStatsBarProps) {
  const t = useTranslations("Automations.stats")
  const isSm = size === "sm"
  const suffix = counts.truncated ? "+" : ""

  const figures: Figure[] = [
    { key: "enrolled", value: counts.enrolled, label: t("enrolled") },
    // Coloured because it's the figure that most needs a glance-able
    // "this needs attention" cue — a contact sitting in `wait` right now.
    {
      key: "waiting",
      value: counts.waiting,
      label: t("waiting"),
      valueClassName: "text-amber-500",
    },
    { key: "sent", value: counts.completed, label: t("sent") },
    { key: "failed", value: counts.failed, label: t("failed"), valueClassName: "text-destructive" },
  ]
  if (counts.cancelled > 0) {
    figures.push({ key: "cancelled", value: counts.cancelled, label: t("cancelled") })
  }

  return (
    <div className={cn("flex flex-col", isSm ? "gap-1" : "gap-1.5")}>
      <div
        className={cn(
          "flex flex-wrap items-center",
          isSm ? "gap-x-3 gap-y-1" : "gap-x-5 gap-y-1.5",
        )}
      >
        {figures.map((f) => (
          <span
            key={f.key}
            className={cn(
              "inline-flex items-baseline gap-1 text-muted-foreground",
              isSm ? "text-xs" : "text-sm",
            )}
          >
            <strong
              className={cn(
                "tabular-nums font-semibold text-foreground",
                isSm ? "text-xs" : "text-base",
                f.valueClassName,
              )}
            >
              {f.value}
              {suffix}
            </strong>{" "}
            {f.label}
          </span>
        ))}
      </div>
      {counts.truncated && (
        <p className={cn("text-muted-foreground", isSm ? "text-[11px]" : "text-xs")}>
          {t("truncated")}
        </p>
      )}
    </div>
  )
}
