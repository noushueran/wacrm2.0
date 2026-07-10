"use client";

import { Component, useMemo } from "react";
import { useParams, useRouter } from "next/navigation";
import { useQuery } from "convex/react";
import { Loader2 } from "lucide-react";

import { useTranslations } from "next-intl";

import { FlowEditorShell } from "@/components/flows/flow-editor-shell";
import { toUiFlow, toUiFlowNode } from "@/lib/convex/adapters";
import { api } from "../../../../../convex/_generated/api";
import type { Id } from "../../../../../convex/_generated/dataModel";

/**
 * Flow editor shell.
 *
 * Loads `{flow, nodes}` from `api.flows.get` and hands it to
 * `<FlowEditorShell>`. Owns the loading/error state so the builder can
 * focus purely on editing.
 *
 * Open to every authenticated user — the beta gate that previously
 * 404'd non-beta accounts was removed in PR #134. `api.flows.get`
 * still throws `ConvexError NOT_FOUND` on a flow id the caller doesn't
 * own (`requireOwnFlow` in convex/flows.ts), which becomes the "Flow
 * not found" state below via `FlowNotFoundBoundary`.
 */

/**
 * Class-based error boundary — catches the render-time throw from
 * `useQuery(api.flows.get, ...)` when the flow id is malformed or
 * belongs to another account. Mirrors
 * `broadcasts/[id]/page.tsx`'s `BroadcastNotFoundBoundary`, the
 * established pattern in this codebase for this exact problem (a
 * `try/catch` wrapped around the hook call itself would violate
 * `rules-of-hooks`).
 */
class FlowNotFoundBoundary extends Component<
  { fallback: React.ReactNode; children: React.ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  render() {
    if (this.state.hasError) return this.props.fallback;
    return this.props.children;
  }
}

function FlowEditorContent({ flowId }: { flowId: string }) {
  const result = useQuery(api.flows.get, { flowId: flowId as Id<"flows"> });
  const loading = result === undefined;

  const flow = useMemo(() => (result ? toUiFlow(result.flow) : null), [result]);
  const nodes = useMemo(
    () => (result ? result.nodes.map(toUiFlowNode) : []),
    [result],
  );

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // Unreachable in practice once `loading` is false — `api.flows.get`
  // either returns `{flow, nodes}` or throws (caught by
  // `FlowNotFoundBoundary` above this component, which unmounts it
  // before this point). Kept so TypeScript narrows `flow` for
  // `FlowEditorShell` below.
  if (!flow) return null;

  return <FlowEditorShell initialFlow={flow} initialNodes={nodes} />;
}

export default function FlowEditorPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const t = useTranslations("Flows.edit");

  return (
    <FlowNotFoundBoundary
      fallback={
        <div className="flex h-full flex-col items-center justify-center gap-3">
          <p className="text-sm text-muted-foreground">{t("notFound")}</p>
          <button
            type="button"
            onClick={() => router.push("/flows")}
            className="text-sm text-primary hover:opacity-80"
          >
            {t("backToFlows")}
          </button>
        </div>
      }
    >
      <FlowEditorContent flowId={params.id} />
    </FlowNotFoundBoundary>
  );
}
