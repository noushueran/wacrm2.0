// Pure helpers for the /leads deals pipeline (kanban over the funnel).
// Only QUALIFIED sessions are deals; their column is the conversation's
// funnel stage clamped up to "qualified" (a fresh deal whose conversation
// still says new_lead belongs in the first column, not off-board).

export const PIPELINE_STAGE_KEYS = [
  "qualified",
  "price_quoted",
  "itinerary_created",
  "itinerary_sent",
  "invoice_sent",
  "purchased",
  "lost",
] as const;

export type PipelineStageKey = (typeof PIPELINE_STAGE_KEYS)[number];

/** Mirror of convex/lib/salesChecklist.ts's LOSS_CATEGORIES (the frontend
 *  never imports across the convex/ boundary). */
export const LOSS_CATEGORY_KEYS = [
  "price",
  "competitor",
  "budget",
  "timing",
  "unresponsive",
  "changed_plans",
  "other",
] as const;

export type LossCategoryKey = (typeof LOSS_CATEGORY_KEYS)[number];

interface PipelineLeadInput {
  status: string;
  funnelStage: string | null;
}

/** The kanban column a lead belongs to — null when it isn't a deal
 *  (only qualified sessions ride the pipeline). */
export function effectivePipelineStage(
  lead: PipelineLeadInput,
): PipelineStageKey | null {
  if (lead.status !== "qualified") return null;
  const stage = lead.funnelStage;
  if (
    stage &&
    (PIPELINE_STAGE_KEYS as readonly string[]).includes(stage)
  ) {
    return stage as PipelineStageKey;
  }
  // No funnel stage yet, or a pre-deal stage (new_lead) → first column.
  return "qualified";
}

export function groupLeadsByStage<L extends PipelineLeadInput>(
  leads: L[],
): Record<PipelineStageKey, L[]> {
  const grouped = Object.fromEntries(
    PIPELINE_STAGE_KEYS.map((k) => [k, [] as L[]]),
  ) as Record<PipelineStageKey, L[]>;
  for (const lead of leads) {
    const stage = effectivePipelineStage(lead);
    if (stage) grouped[stage].push(lead);
  }
  return grouped;
}
