// Pure helpers for the /leads deals pipeline (kanban over the funnel).
// Only QUALIFIED sessions are deals; their column is the conversation's
// funnel stage clamped up to "qualified" (a fresh deal whose conversation
// still says new_lead belongs in the first column, not off-board).
// One conversation = one deal: the stage lives on the conversation, so a
// re-qualified conversation's older sessions are the same deal's history,
// not extra cards.

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

interface PipelineDealInput extends PipelineLeadInput {
  conversationId: string;
  startedAt: number;
}

export function groupLeadsByStage<L extends PipelineDealInput>(
  leads: L[],
): Record<PipelineStageKey, L[]> {
  // Collapse to one card per conversation BEFORE grouping. Every session
  // of a conversation shares its single funnel stage, so rendering each
  // qualified session would draw N cards that all move together on any
  // stage change. The surviving card is the newest qualified session —
  // the same "latest session" rule funnel.setStage's checklist gate uses.
  // Map.set keeps first-insertion order, so columns stay in the server's
  // newest-first order even when a later row wins the collapse.
  const latestByConversation = new Map<string, L>();
  for (const lead of leads) {
    if (effectivePipelineStage(lead) === null) continue;
    const current = latestByConversation.get(lead.conversationId);
    if (!current || lead.startedAt > current.startedAt) {
      latestByConversation.set(lead.conversationId, lead);
    }
  }
  const grouped = Object.fromEntries(
    PIPELINE_STAGE_KEYS.map((k) => [k, [] as L[]]),
  ) as Record<PipelineStageKey, L[]>;
  for (const lead of latestByConversation.values()) {
    const stage = effectivePipelineStage(lead);
    if (stage) grouped[stage].push(lead);
  }
  return grouped;
}
