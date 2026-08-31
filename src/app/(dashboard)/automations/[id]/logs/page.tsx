"use client"

import { Component, use, useEffect, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { useMutation } from "convex/react"
import { useQuery } from "@/lib/convex/cached"
import { toast } from "sonner"
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
import {
  convexErrorMessage,
  isConvexErrorCode,
  toUiAutomation,
  toUiAutomationLog,
} from "@/lib/convex/adapters"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { RunStatsBar } from "@/components/automations/run-stats-bar"
import { cn } from "@/lib/utils"
import { countdownTo, formatRelative } from "@/lib/automations/trigger-meta"
import { flattenStepsByKey, type StepTreeNode } from "@/lib/automations/step-lookup"

import { api } from "../../../../../../convex/_generated/api"
// TYPE-ONLY, and it must stay that way. A *value* import from a
// `convex/*.ts` query module drags the whole module — `accountQuery`,
// `requireRole`, every handler body and the table/index names they
// reference — into this route's client chunk; webpack does not
// tree-shake it. `import type` is erased before bundling, so it costs
// nothing (verified against the built chunks for this route). If you
// ever need a runtime VALUE from that module, move it to a db-free
// module under `convex/lib/` and import it from there instead.
import type { ContactSummary } from "../../../../../../convex/automations"
import type { Doc, Id } from "../../../../../../convex/_generated/dataModel"
import { emptyRunCounts } from "../../../../../../convex/lib/automations/runStats"

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
 * One log row. The contact arrives already resolved on the row —
 * `automations.logs` attaches it server-side (see `attachContacts` in
 * convex/automations.ts).
 *
 * It used to run its own `contacts.get` here, one reactive subscription
 * per visible row (the `broadcasts/[id]/page.tsx` `RecipientRow`
 * pattern). At this page's 100-row limit that was 100 extra queries —
 * each also embedding that contact's tags — and not one of them could
 * begin until the `logs` query had already come back, making them a
 * third sequential round trip rather than a parallel one.
 */
function LogRow({
  log,
  contact,
  isOpen,
  onToggle,
  t,
}: {
  log: AutomationLog
  contact: ContactSummary | null
  isOpen: boolean
  onToggle: () => void
  t: ReturnType<typeof useTranslations>
}) {
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

/**
 * One row in the Waiting tab — a contact currently parked on a `wait`
 * step. Like `LogRow` above, the contact comes pre-resolved on the row
 * from `waitingRuns` rather than from a per-row `contacts.get`.
 *
 * `onCancelRequest` hands the resolved display name up to the parent
 * rather than the parent re-deriving it: the confirm dialog needs a
 * human name for its "This stops the queued steps for {name}" copy.
 */
function WaitingRow({
  run,
  contact,
  stepNode,
  onCancelRequest,
  t,
  tBuilder,
}: {
  run: Doc<"automationRuns">
  contact: ContactSummary | null
  stepNode: StepTreeNode | undefined
  onCancelRequest: (contactName: string) => void
  t: ReturnType<typeof useTranslations>
  tBuilder: ReturnType<typeof useTranslations>
}) {
  const displayName = contact?.name ?? contact?.phone ?? t("unknownContact")

  // `currentStepKey` is only ever written from a `wait` step's own key
  // (see step-lookup.ts's header), so `stepNode` — when resolved at all —
  // is always that step. Falls back to the bare step-type label if the
  // tree lookup came up empty (an edit mid-wait, or a pre-Task-10 row
  // with no stepKey at all) rather than showing nothing.
  const stepLabel = stepNode ? tBuilder(`steps.${stepNode.step_type}`) : t("waiting.unknownStep")

  const countdown = countdownTo(run.resumeAt)
  const countdownText =
    countdown.unit === "due"
      ? t("countdown.due")
      : t(`countdown.${countdown.unit}`, { count: countdown.count })

  return (
    <li className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-foreground">{displayName}</div>
        <div className="truncate text-xs text-muted-foreground">
          {t("waiting.atStep", { step: stepLabel })}
        </div>
      </div>
      <div className="whitespace-nowrap text-xs font-medium text-amber-500 tabular-nums">
        {countdownText}
      </div>
      <Button variant="outline" size="sm" onClick={() => onCancelRequest(displayName)}>
        {t("waiting.cancel")}
      </Button>
    </li>
  )
}

function AutomationLogsContent({ id }: { id: string }) {
  const router = useRouter()
  const t = useTranslations("Automations.logs")
  const tBuilder = useTranslations("Automations.builder")
  const [openLogId, setOpenLogId] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<"history" | "waiting">("history")
  const [pendingCancel, setPendingCancel] = useState<{
    run: Doc<"automationRuns">
    name: string
  } | null>(null)
  const [cancelling, setCancelling] = useState(false)

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
  // Resolves a waiting run's `currentStepKey` back to the step it names —
  // see `src/lib/automations/step-lookup.ts`'s header for why the engine
  // guarantees that key always points at a `wait` step.
  const stepsByKey = useMemo(
    () =>
      automationDoc
        ? flattenStepsByKey(automationDoc.steps as StepTreeNode[])
        : new Map<string, StepTreeNode>(),
    [automationDoc],
  )

  const logsResult = useQuery(api.automations.logs, {
    automationId: id as Id<"automations">,
  })
  // `toUiAutomationLog` maps the log doc only, so the server-attached
  // `contact` is carried alongside it rather than through the adapter.
  const logs = useMemo(
    () =>
      (logsResult ?? []).map((doc) => ({
        log: toUiAutomationLog(doc),
        contact: doc.contact,
      })),
    [logsResult],
  )

  // Fix wave (2026-08), finding 4: this used to read `automations.list`
  // (the account's WHOLE automation set, each with its own run-counts
  // read) just to pick this one row back out of it — a documented
  // fallback at the time, since adding a dedicated query needed a
  // `convex codegen` run that task couldn't perform. `runCounts` is
  // that dedicated query now: same bounded per-status counting `list`
  // itself uses, scoped to just this automation, so a single detail
  // page no longer pays the account-wide cost.
  const runCountsResult = useQuery(api.automations.runCounts, {
    automationId: id as Id<"automations">,
  })
  const runCounts = useMemo(() => runCountsResult ?? emptyRunCounts(), [runCountsResult])

  const waitingResult = useQuery(api.automations.waitingRuns, {
    automationId: id as Id<"automations">,
  })
  const waitingRuns = waitingResult ?? []

  // Re-renders the Waiting tab periodically so its countdowns actually
  // count down instead of freezing at whatever they read on first
  // render — `useQuery` only re-renders on DATA changes, not on
  // wall-clock time passing.
  const [, setTick] = useState(0)
  useEffect(() => {
    const intervalId = setInterval(() => setTick((n) => n + 1), 30_000)
    return () => clearInterval(intervalId)
  }, [])

  const cancelRunMutation = useMutation(api.automations.cancelRun)

  async function confirmCancel() {
    if (!pendingCancel) return
    setCancelling(true)
    try {
      await cancelRunMutation({ runId: pendingCancel.run._id })
      toast.success(t("waiting.cancelSuccess"))
      setPendingCancel(null)
    } catch (err) {
      // `cancelRun` throws NOT_CANCELLABLE when the run finished between
      // this list rendering and Cancel being clicked — a real TOCTOU, not
      // a hypothetical. `waitingRuns` is a live query, so the stale row
      // is already gone (or about to be) on its own the moment the
      // backend's status flips; this just tells the user the truth
      // instead of a generic failure and closes the dialog rather than
      // retrying a mutation that will only fail again the same way.
      if (isConvexErrorCode(err, "NOT_CANCELLABLE") || isConvexErrorCode(err, "NOT_FOUND")) {
        toast.error(t("waiting.alreadyFinished"))
        setPendingCancel(null)
      } else {
        toast.error(convexErrorMessage(err) || t("waiting.cancelError"))
      }
    } finally {
      setCancelling(false)
    }
  }

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

      <RunStatsBar counts={runCounts} size="md" />

      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as "history" | "waiting")}>
        <TabsList>
          <TabsTrigger value="history">{t("tabs.history")}</TabsTrigger>
          <TabsTrigger value="waiting">{t("tabs.waiting")}</TabsTrigger>
        </TabsList>

        <TabsContent value="history" className="mt-4">
          {logs.length === 0 ? (
            <div className="flex h-48 flex-col items-center justify-center rounded-xl border border-dashed border-border bg-card/40">
              <p className="text-sm text-foreground">{t("emptyTitle")}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {t("emptyDesc")}
              </p>
            </div>
          ) : (
            <ul className="space-y-2">
              {logs.map(({ log, contact }) => (
                <LogRow
                  key={log.id}
                  log={log}
                  contact={contact}
                  isOpen={openLogId === log.id}
                  onToggle={() => setOpenLogId(openLogId === log.id ? null : log.id)}
                  t={t}
                />
              ))}
            </ul>
          )}
        </TabsContent>

        <TabsContent value="waiting" className="mt-4">
          {waitingRuns.length === 0 ? (
            <div className="flex h-48 flex-col items-center justify-center rounded-xl border border-dashed border-border bg-card/40">
              <p className="text-sm text-foreground">{t("waiting.emptyTitle")}</p>
            </div>
          ) : (
            <ul className="space-y-2">
              {waitingRuns.map((run) => (
                <WaitingRow
                  key={run._id}
                  run={run}
                  contact={run.contact}
                  stepNode={run.currentStepKey ? stepsByKey.get(run.currentStepKey) : undefined}
                  onCancelRequest={(name) => setPendingCancel({ run, name })}
                  t={t}
                  tBuilder={tBuilder}
                />
              ))}
            </ul>
          )}
        </TabsContent>
      </Tabs>

      <Dialog
        open={!!pendingCancel}
        onOpenChange={(v) => !v && !cancelling && setPendingCancel(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("waiting.cancelTitle")}</DialogTitle>
            <DialogDescription>
              {t("waiting.cancelDesc", { name: pendingCancel?.name ?? "" })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setPendingCancel(null)}
              disabled={cancelling}
            >
              {t("waiting.keepWaiting")}
            </Button>
            <Button
              variant="destructive"
              onClick={confirmCancel}
              disabled={cancelling}
            >
              {cancelling ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {t("waiting.cancelConfirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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
        "inline-flex items-center rounded-full border px-2 py-0.5 text-[12px] font-medium",
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
