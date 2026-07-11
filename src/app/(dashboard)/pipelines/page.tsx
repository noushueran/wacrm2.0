"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation } from "convex/react";
import { usePaginatedQuery, useQuery } from "@/lib/convex/cached";
import type { Contact, Deal, Profile } from "@/types";
import {
  toUiContact,
  toUiDeal,
  toUiMemberProfile,
  toUiPipeline,
  toUiPipelineStage,
} from "@/lib/convex/adapters";
import { PipelineBoard } from "@/components/pipelines/pipeline-board";
import { PipelineSettings } from "@/components/pipelines/pipeline-settings";
import { DealForm } from "@/components/pipelines/deal-form";
import { PipelineAnalytics } from "@/components/pipelines/pipeline-analytics";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { GitBranch, Plus, ChevronDown, Settings } from "lucide-react";
import { toast } from "sonner";
import { useCan } from "@/hooks/use-can";
import { GatedButton } from "@/components/ui/gated-button";
import { useTranslations } from "next-intl";

import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";

// Pipeline creation is admin-class (settings-tier write under
// the new RLS); deal creation is operational and only requires
// agent+. The two CTAs gate on different `useCan` capabilities,
// not on different copy.

export default function PipelinesPage() {
  const t = useTranslations("Pipelines.page");
  const canEditSettings = useCan("edit-settings");
  const canCreateDeals = useCan("send-messages");

  const [selectedPipelineId, setSelectedPipelineId] = useState<string>("");

  // Dialog / sheet state
  const [newPipelineOpen, setNewPipelineOpen] = useState(false);
  const [newPipelineName, setNewPipelineName] = useState("");
  const [creating, setCreating] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Deal form state is lifted here so both the top-bar "Add Deal" and
  // the per-column "+" trigger the same Sheet.
  const [dealFormOpen, setDealFormOpen] = useState(false);
  const [editingDeal, setEditingDeal] = useState<Deal | null>(null);
  const [defaultStageId, setDefaultStageId] = useState<string>("");

  // Guard against double-seeding (React StrictMode double-effect in dev).
  const seedAttempted = useRef(false);

  // `pipelines.list` embeds each pipeline's stages server-side (see
  // convex/pipelines.ts) — one live subscription gives both the
  // dropdown's pipeline list and the selected pipeline's stages below,
  // replacing the two separate Supabase loads (`loadPipelines`/`loadStages`).
  const pipelinesResult = useQuery(api.pipelines.list);
  const loading = pipelinesResult === undefined;
  const rawPipelines = useMemo(() => pipelinesResult ?? [], [pipelinesResult]);
  const pipelines = useMemo(
    () => rawPipelines.map(toUiPipeline),
    [rawPipelines],
  );

  // Keep the selection valid as the reactive pipeline list changes —
  // covers first load, a newly created pipeline, and the selected
  // pipeline being deleted elsewhere (falls back to the first remaining
  // one, or "" if none are left).
  useEffect(() => {
    if (loading) return;
    setSelectedPipelineId((prev) =>
      prev && pipelines.some((p) => p.id === prev)
        ? prev
        : (pipelines[0]?.id ?? ""),
    );
  }, [loading, pipelines]);

  const createPipeline = useMutation(api.pipelines.create);

  // Auto-seed a default pipeline the first time an admin+ caller has
  // none — mirrors the Supabase-era seed-if-empty. `pipelines.create` is
  // admin-gated server-side (convex/pipelines.ts: `ctx.requireRole("admin")`),
  // so a non-admin viewer/agent who lands here with zero pipelines just
  // sees the "no pipelines yet" empty state below instead of a failed
  // auto-seed attempt.
  useEffect(() => {
    if (loading || !canEditSettings) return;
    if (pipelines.length === 0 && !seedAttempted.current) {
      seedAttempted.current = true;
      createPipeline({ name: "Sales Pipeline" }).catch((err) => {
        console.error("Failed to seed pipeline:", err);
      });
    }
  }, [loading, canEditSettings, pipelines, createPipeline]);

  // The selected pipeline's stages come straight off the already-loaded
  // `pipelines.list` result (no second query needed) — found via the raw
  // doc so `.stages` (not part of the `Pipeline` UI type) is reachable.
  const rawSelectedPipeline = useMemo(
    () => rawPipelines.find((p) => p._id === selectedPipelineId),
    [rawPipelines, selectedPipelineId],
  );
  const stages = useMemo(
    () => rawSelectedPipeline?.stages.map(toUiPipelineStage) ?? [],
    [rawSelectedPipeline],
  );

  const dealsResult = useQuery(
    api.deals.listByPipeline,
    selectedPipelineId
      ? { pipelineId: selectedPipelineId as Id<"pipelines"> }
      : "skip",
  );

  // `deals.listByPipeline` returns a flat list with no embedded
  // contact/assignee (unlike the old Supabase join) — hydrated here from
  // the same account-wide contacts/members reads the deal form's own
  // pickers use below, so `DealCard` keeps showing a contact name and an
  // assignee initial. Same 500-item contacts cap noted for the picker
  // applies to this lookup too (see task report).
  const contactsPaged = usePaginatedQuery(
    api.contacts.list,
    {},
    { initialNumItems: 500 },
  );
  const contactsById = useMemo(() => {
    const map = new Map<string, Contact>();
    for (const doc of contactsPaged.results) map.set(doc._id, toUiContact(doc));
    return map;
  }, [contactsPaged.results]);

  const membersResult = useQuery(api.members.list);
  const membersById = useMemo(() => {
    const map = new Map<string, Profile>();
    for (const doc of membersResult ?? [])
      map.set(doc.userId, toUiMemberProfile(doc));
    return map;
  }, [membersResult]);

  const deals = useMemo(
    () =>
      (dealsResult ?? []).map((doc) => ({
        ...toUiDeal({ ...doc, stage: null }),
        contact: doc.contactId ? contactsById.get(doc.contactId) : undefined,
        assignee: doc.assignedToUserId
          ? membersById.get(doc.assignedToUserId)
          : undefined,
      })),
    [dealsResult, contactsById, membersById],
  );

  const moveDeal = useMutation(api.deals.move);

  const handleDealMoved = useCallback(
    async (dealId: string, newStageId: string) => {
      try {
        await moveDeal({
          dealId: dealId as Id<"deals">,
          stageId: newStageId as Id<"pipelineStages">,
        });
      } catch {
        toast.error(t("toastFailedMoveDeal"));
      }
    },
    [moveDeal, t],
  );

  const handleAddDeal = useCallback(
    (stageId?: string) => {
      setEditingDeal(null);
      setDefaultStageId(stageId ?? stages[0]?.id ?? "");
      setDealFormOpen(true);
    },
    [stages],
  );

  const handleEditDeal = useCallback((deal: Deal) => {
    setEditingDeal(deal);
    setDefaultStageId(deal.stage_id);
    setDealFormOpen(true);
  }, []);

  async function handleCreatePipeline() {
    const name = newPipelineName.trim();
    if (!name) return;
    setCreating(true);
    try {
      const newId = await createPipeline({ name });
      setNewPipelineName("");
      setNewPipelineOpen(false);
      setSelectedPipelineId(newId);
      toast.success(t("toastPipelineCreated"));
    } catch {
      toast.error(t("toastFailedCreatePipeline"));
    } finally {
      setCreating(false);
    }
  }

  const selectedPipeline = pipelines.find((p) => p.id === selectedPipelineId);

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div className="h-8 w-48 animate-pulse rounded bg-muted" />
          <div className="h-9 w-28 animate-pulse rounded-lg bg-muted" />
        </div>
        <div className="flex gap-3">
          {[1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="h-96 w-72 animate-pulse rounded-xl bg-muted/50" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          {/* Pipeline selector dropdown */}
          <DropdownMenu>
            <DropdownMenuTrigger
              className="inline-flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground hover:bg-muted transition-colors data-[popup-open]:bg-muted"
            >
              <GitBranch className="h-4 w-4 text-primary" />
              <span className="font-semibold">
                {selectedPipeline?.name ?? t("selectPipeline")}
              </span>
              <ChevronDown className="h-4 w-4 text-muted-foreground" />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              className="w-64 border-border bg-popover text-popover-foreground"
            >
              {pipelines.length === 0 && (
                <DropdownMenuItem disabled className="text-muted-foreground">
                  {t("noPipelinesYet")}
                </DropdownMenuItem>
              )}
              {pipelines.map((p) => (
                <DropdownMenuItem
                  key={p.id}
                  onClick={() => setSelectedPipelineId(p.id)}
                  className={
                    p.id === selectedPipelineId
                      ? "text-primary"
                      : "text-popover-foreground"
                  }
                >
                  <GitBranch className="mr-2 h-3.5 w-3.5" />
                  {p.name}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator className="bg-border" />
              {selectedPipeline && (
                <DropdownMenuItem
                  onClick={() => setSettingsOpen(true)}
                  className="text-popover-foreground"
                >
                  <Settings className="mr-2 h-3.5 w-3.5" />
                  {t("managePipelines")}
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <div className="flex items-center gap-2">
          <GatedButton
            variant="outline"
            canAct={canEditSettings}
            gateReason="create pipelines"
            onClick={() => setNewPipelineOpen(true)}
            className="border-border bg-card text-foreground hover:bg-muted"
          >
            <Plus className="mr-1 h-4 w-4" />
            {t("addPipeline")}
          </GatedButton>
          <GatedButton
            canAct={canCreateDeals}
            gateReason="create deals"
            disabled={!selectedPipelineId || stages.length === 0}
            onClick={() => handleAddDeal()}
            className="bg-primary text-primary-foreground hover:bg-primary/90"
          >
            <Plus className="mr-1 h-4 w-4" />
            {t("addDeal")}
          </GatedButton>
        </div>
      </div>

      {/* Board */}
      {pipelines.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border py-20">
          <GitBranch className="h-12 w-12 text-muted-foreground" />
          <h3 className="mt-4 text-lg font-medium text-foreground">
            {t("noPipelinesYet")}
          </h3>
          <p className="mt-2 text-sm text-muted-foreground">
            {t("createToStartTracking")}
          </p>
          <GatedButton
            canAct={canEditSettings}
            gateReason="create pipelines"
            onClick={() => setNewPipelineOpen(true)}
            className="mt-4 bg-primary text-primary-foreground hover:bg-primary/90"
          >
            <Plus className="mr-1 h-4 w-4" />
            {t("createPipeline")}
          </GatedButton>
        </div>
      ) : (
        <>
          <PipelineAnalytics stages={stages} deals={deals} />
          <PipelineBoard
            stages={stages}
            deals={deals}
            onDealMoved={handleDealMoved}
            onAddDeal={handleAddDeal}
            onEditDeal={handleEditDeal}
          />
        </>
      )}

      {/* New Pipeline Dialog */}
      <Dialog open={newPipelineOpen} onOpenChange={setNewPipelineOpen}>
        <DialogContent className="sm:max-w-sm bg-popover border-border">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground">{t("newPipeline")}</DialogTitle>
          </DialogHeader>
          <div className="py-2">
            <Label className="text-muted-foreground">{t("pipelineName")}</Label>
            <Input
              value={newPipelineName}
              onChange={(e) => setNewPipelineName(e.target.value)}
              placeholder={t("pipelineNamePlaceholder")}
              className="mt-2 bg-muted border-border text-foreground"
              onKeyDown={(e) => {
                if (e.key === "Enter") handleCreatePipeline();
              }}
            />
            <p className="mt-2 text-xs text-muted-foreground">
              {t("defaultStagesDesc")}
            </p>
          </div>
          <DialogFooter className="bg-popover/50 border-border">
            <Button
              variant="outline"
              onClick={() => setNewPipelineOpen(false)}
              className="border-border text-muted-foreground hover:bg-muted"
            >
              {t("cancel")}
            </Button>
            <Button
              onClick={handleCreatePipeline}
              disabled={creating || !newPipelineName.trim()}
              className="bg-primary text-primary-foreground hover:bg-primary/90"
            >
              {creating ? t("creating") : t("createPipelineBtn")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Pipeline Settings */}
      {selectedPipeline && (
        <PipelineSettings
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
          pipeline={selectedPipeline}
          stages={stages}
          onPipelinesChanged={() => {}}
          onStagesChanged={() => {}}
          onCreateNewPipeline={() => {
            setSettingsOpen(false);
            setNewPipelineOpen(true);
          }}
        />
      )}

      {/* Deal Form (Sheet) */}
      <DealForm
        open={dealFormOpen}
        onOpenChange={setDealFormOpen}
        deal={editingDeal}
        pipelineId={selectedPipelineId}
        stages={stages}
        defaultStageId={defaultStageId}
        onSaved={() => {}}
      />
    </div>
  );
}
