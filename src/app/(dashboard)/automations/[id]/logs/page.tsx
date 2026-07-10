"use client"

import { Component, use, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { useQuery } from "convex/react"
import {
  ArrowLeft,
  Check,
  Loader2,
  X,
  ChevronDown,
  ChevronRight,
} from "lucide-react"
import { useTranslations } from "next-intl"

import type { AutomationLog, AutomationLogStepResult } from "@/types"
import { toUiAutomation, toUiAutomationLog, toUiContact } from "@/lib/convex/adapters"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { formatRelative } from "@/lib/automations/trigger-meta"

import { api } from "../../../../../../convex/_generated/api"
import type { Id } from "../../../../../../convex/_generated/dataModel"

/**
 * Class-based React error boundary — mirrors
 * `edit/page.tsx`'s `AutomationNotFoundBoundary` (and
 * `broadcasts/[id]/page.tsx`'s `BroadcastNotFoundBoundary`): catches the
 * render-time throw from `useQuery` when `automations.get` throws
 * (invalid id, or a well-formed but foreign/deleted one).
 */
class AutomationNotFoundBoundary extends Component<
  { fallback: React.ReactNode; children: React.ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false }

  static getDerivedStateFromError() {
    return { hasError: true }
  }

  render() {
    if (this.state.hasError) return this.props.fallback
    return this.props.children
  }
}

/**
 * One log row. `automations.logs` returns bare `automationLogs` docs
 * with no embedded contact (unlike the old Supabase `select('*,
 * contact:contacts(id, name, phone)')` join) — resolved here client-side
 * via the existing single-contact `contacts.get` query, mirroring
 * `broadcasts/[id]/page.tsx`'s `RecipientRow` pattern: one small
 * reactive subscription per visible row.
 */
function LogRow({
  log,
  isOpen,
  onToggle,
  t,
}: {
  log: AutomationLog
  isOpen: boolean
  onToggle: () => void
  t: ReturnType<typeof useTranslations>
}) {
  const contactDoc = useQuery(
    api.contacts.get,
    log.contact_id ? { contactId: log.contact_id as Id<"contacts"> } : "skip",
  )
  const contact = useMemo(
    () => (contactDoc ? toUiContact(contactDoc) : undefined),
    [contactDoc],
  )

  return (
    <li className="rounded-xl border border-border bg-card">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-3 px-4 py-3 text-left"
      >
        {isOpen ? (
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-4 w-4 text-muted-foreground" />
        )}
        <StatusBadge status={log.status} t={t} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-foreground">
            {contact?.name ?? contact?.phone ?? t("unknownContact")}
          </div>
          <div className="truncate text-xs text-muted-foreground">
            {log.trigger_event} · {log.steps_executed?.length ?? 0}{" "}
            {log.steps_executed?.length === 1
              ? t("step", { count: 1 }).replace("1 ", "")
              : t("stepPlural", { count: log.steps_executed?.length ?? 0 }).replace(/^[0-9]+ /, "")}
          </div>
        </div>
        <div className="text-xs text-muted-foreground">
          {formatRelative(log.created_at)}
        </div>
      </button>
      {isOpen && (
        <div className="border-t border-border px-4 py-3">
          {log.error_message && (
            <p className="mb-3 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
              {log.error_message}
            </p>
          )}
          <ul className="space-y-1.5">
            {(log.steps_executed ?? []).map((r, i) => (
              <StepRow key={i} result={r} />
            ))}
            {(log.steps_executed ?? []).length === 0 && (
              <li className="text-xs text-muted-foreground">{t("noSteps")}</li>
            )}
          </ul>
        </div>
      )}
    </li>
  )
}

function AutomationLogsContent({ id }: { id: string }) {
  const router = useRouter()
  const t = useTranslations("Automations.logs")
  const [openLogId, setOpenLogId] = useState<string | null>(null)

  // A throw from here (invalid/foreign/deleted id) is caught by
  // AutomationNotFoundBoundary one level up. `automations.logs` below
  // never throws for a foreign automationId (it just filters the
  // caller's own account-scoped rows down to zero), so only this call
  // needs the boundary.
  const automationDoc = useQuery(api.automations.get, {
    automationId: id as Id<"automations">,
  })
  const automation = useMemo(
    () => (automationDoc ? toUiAutomation(automationDoc.automation) : null),
    [automationDoc],
  )

  const logsResult = useQuery(api.automations.logs, {
    automationId: id as Id<"automations">,
  })
  const logs = useMemo(
    () => (logsResult ?? []).map((doc) => toUiAutomationLog(doc)),
    [logsResult],
  )
  const loading = !automation || logsResult === undefined

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => router.push("/automations")}
          className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          aria-label={t("backAria")}
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <div>
          <h1 className="text-2xl font-bold text-foreground">{automation.name}</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">{t("title")}</p>
        </div>
      </div>

      {logs.length === 0 ? (
        <div className="flex h-48 flex-col items-center justify-center rounded-xl border border-dashed border-border bg-card/40">
          <p className="text-sm text-foreground">{t("emptyTitle")}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("emptyDesc")}
          </p>
        </div>
      ) : (
        <ul className="space-y-2">
          {logs.map((log) => (
            <LogRow
              key={log.id}
              log={log}
              isOpen={openLogId === log.id}
              onToggle={() => setOpenLogId(openLogId === log.id ? null : log.id)}
              t={t}
            />
          ))}
        </ul>
      )}
    </div>
  )
}

export default function AutomationLogsPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = use(params)
  const router = useRouter()
  const t = useTranslations("Automations.logs")

  return (
    <AutomationNotFoundBoundary
      fallback={
        <div className="flex h-64 flex-col items-center justify-center gap-3">
          <p className="text-sm text-red-400">{t("loadError")}</p>
          <Button variant="outline" onClick={() => router.push("/automations")}>
            {t("back")}
          </Button>
        </div>
      }
    >
      <AutomationLogsContent id={id} />
    </AutomationNotFoundBoundary>
  )
}

function StatusBadge({ status, t }: { status: AutomationLog["status"], t: ReturnType<typeof useTranslations> }) {
  const classes =
    status === "success"
      ? "border-primary/30 bg-primary/10 text-primary"
      : status === "partial"
      ? "border-amber-500/30 bg-amber-500/10 text-amber-300"
      : "border-red-500/30 bg-red-500/10 text-red-300"
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium",
        classes,
      )}
    >
      {t(`status.${status}`)}
    </span>
  )
}

function StepRow({ result }: { result: AutomationLogStepResult }) {
  const ok = result.status === "success"
  return (
    <li className="flex items-start gap-2 text-xs">
      <span
        className={cn(
          "mt-0.5 flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full",
          ok ? "bg-primary/20 text-primary" : "bg-red-500/20 text-red-400",
        )}
        aria-hidden
      >
        {ok ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" />}
      </span>
      <span className="text-muted-foreground">{result.step_type}</span>
      {result.detail && (
        <span className="truncate text-muted-foreground">— {result.detail}</span>
      )}
    </li>
  )
}
