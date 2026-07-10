"use client"

import { Component, use, useMemo } from "react"
import { useRouter } from "next/navigation"
import { useQuery } from "convex/react"
import { Loader2 } from "lucide-react"
import { useTranslations } from "next-intl"

import {
  AutomationBuilder,
  fromServerSteps,
  type BuilderInitial,
  type ServerStepNode,
} from "@/components/automations/automation-builder"
import { toUiAutomation } from "@/lib/convex/adapters"
import type { AutomationTriggerType } from "@/types"

import { api } from "../../../../../../convex/_generated/api"
import type { Id } from "../../../../../../convex/_generated/dataModel"

/**
 * Class-based React error boundary — the only way to catch a render-time
 * throw from a descendant, which is exactly what `useQuery` does when
 * `automations.get` throws server-side: either an `ArgumentValidationError`
 * (not even a well-formed `automations` id) or a `ConvexError NOT_FOUND`
 * (well-formed but foreign/deleted — `requireOwnAutomation` in
 * convex/automations.ts). Mirrors `broadcasts/[id]/page.tsx`'s
 * `BroadcastNotFoundBoundary` — same reasoning: a `try/catch` around the
 * `useQuery` call itself would make the hook call conditional, which
 * `eslint-plugin-react-hooks` rejects.
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

function EditAutomationContent({ id }: { id: string }) {
  // A throw from here (invalid/foreign/deleted id) is caught by
  // AutomationNotFoundBoundary one level up.
  const result = useQuery(api.automations.get, {
    automationId: id as Id<"automations">,
  })
  const loading = result === undefined

  const initial: BuilderInitial | null = useMemo(() => {
    if (!result) return null
    const automation = toUiAutomation(result.automation)
    return {
      id: automation.id,
      name: automation.name,
      description: automation.description ?? "",
      trigger_type: automation.trigger_type as AutomationTriggerType,
      trigger_config: automation.trigger_config as Record<string, unknown>,
      is_active: automation.is_active,
      steps: fromServerSteps(result.steps as ServerStepNode[]),
    }
  }, [result])

  if (loading || !initial) {
    return (
      <div className="flex h-screen items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    )
  }

  return <AutomationBuilder initial={initial} />
}

export default function EditAutomationPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = use(params)
  const router = useRouter()
  const t = useTranslations("Automations.edit")

  return (
    <AutomationNotFoundBoundary
      fallback={
        <div className="flex h-screen flex-col items-center justify-center gap-3">
          <p className="text-sm text-red-400">{t("loadError", { status: 404 })}</p>
          <button
            onClick={() => router.push("/automations")}
            className="text-sm text-primary hover:text-primary/80"
          >
            {t("back")}
          </button>
        </div>
      }
    >
      <EditAutomationContent id={id} />
    </AutomationNotFoundBoundary>
  )
}
