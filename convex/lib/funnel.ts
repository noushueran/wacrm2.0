// The fixed sales funnel — the single source of truth for the stages an
// agent advances a conversation through, and how each maps to a Meta event
// per lane. Pure + dependency-free (no Convex/React) so it is unit-testable
// and shared by the dispatcher, the setStage mutation (Phase 2), and the UI.
//
// `metaCapi` = the business-messaging event sent on the AD (ctwa) lane.
// `webPixel` = the web-Pixel event Platform A fires on the WEBSITE (code)
// lane. `null` = internal-only (a back-office milestone, never sent to Meta).
// Meta's business-messaging event vocabulary is a FIXED set — these names
// come from it; web-Pixel names are web-standard events.
//
// `leadStage` is the LEAD-QUALITY LIFECYCLE label this stage reports to
// Meta, and it is deliberately NOT the wire event name. Meta's
// business-messaging Conversions API accepts a fixed 14-name enum
// (Purchase, LeadSubmitted, InitiateCheckout, AddToCart, ViewContent,
// OrderCreated, OrderShipped, OrderDelivered, OrderCanceled, OrderReturned,
// CartAbandoned, QualifiedLead, RatingProvided, ReviewProvided) which does
// NOT contain `MarketingQualifiedLead`/`SalesQualifiedLead`/`ConvertedLead`
// — and Meta additionally documents that CUSTOM event names cannot be used
// for optimization or Custom Audiences, which is the entire purpose of
// reporting lead quality back. So the standard name travels as
// `event_name` (stays optimizable) and this label travels alongside it as
// `custom_data.lead_stage`, which is what Events Manager Custom
// Conversions and our own funnel reporting segment on.
//
// Only the four business-funnel milestones carry a label; the operational
// in-between stages report their standard event with no lifecycle label,
// so a Custom Conversion built on `lead_stage` can never double-count.

export const FUNNEL_STAGES = [
  { key: "new_lead", label: "New lead", metaCapi: "LeadSubmitted", webPixel: "Lead", auto: true, needsValue: false, leadStage: "LEAD" },
  { key: "qualified", label: "Qualified lead", metaCapi: "QualifiedLead", webPixel: "Lead", auto: false, needsValue: false, leadStage: "MQL" },
  { key: "price_quoted", label: "Price quoted", metaCapi: "InitiateCheckout", webPixel: "InitiateCheckout", auto: false, needsValue: false, leadStage: "SQL" },
  { key: "itinerary_created", label: "Itinerary created", metaCapi: null, webPixel: null, auto: false, needsValue: false, leadStage: null },
  { key: "itinerary_sent", label: "Itinerary sent", metaCapi: "AddToCart", webPixel: "AddToCart", auto: false, needsValue: false, leadStage: null },
  { key: "invoice_sent", label: "Invoice sent", metaCapi: "OrderCreated", webPixel: "InitiateCheckout", auto: false, needsValue: false, leadStage: null },
  { key: "purchased", label: "Purchased", metaCapi: "Purchase", webPixel: "Purchase", auto: false, needsValue: true, leadStage: "CONVERTED" },
  // Terminal exit, appended LAST so `neverDowngrade` index math means the
  // engine can never pull a lost deal back into the working stages. Meta's
  // business-messaging vocabulary has no "lost" event → internal-only.
  { key: "lost", label: "Lost", metaCapi: null, webPixel: null, auto: false, needsValue: false, leadStage: null },
] as const;

export type FunnelStageKey = (typeof FUNNEL_STAGES)[number]["key"];

export const FUNNEL_STAGE_KEYS: FunnelStageKey[] = FUNNEL_STAGES.map(
  (s) => s.key,
);

export type FunnelLane = "code" | "ctwa";

/**
 * The deals-pipeline columns: the funnel minus `new_lead`, because only a
 * QUALIFIED session is a deal and a deal whose conversation still says
 * `new_lead` belongs in the first column rather than off-board.
 *
 * Mirrors `src/lib/leads/pipeline.ts`'s `PIPELINE_STAGE_KEYS`, following
 * this codebase's standing convention that the frontend never imports
 * across the `convex/` boundary (see that file's own note about
 * `LOSS_CATEGORIES`). Keep the two lists identical — `funnel.test.ts`
 * pins this one against `FUNNEL_STAGES`, so a stage added there without
 * being added here fails rather than silently vanishing from the board.
 */
export const PIPELINE_STAGE_KEYS = FUNNEL_STAGE_KEYS.filter(
  (k) => k !== "new_lead",
);

export type PipelineStageKey = Exclude<FunnelStageKey, "new_lead">;

/**
 * Which pipeline column a qualified session sits in, or `null` when it is
 * not a deal at all.
 *
 * Server-side twin of `effectivePipelineStage` in
 * `src/lib/leads/pipeline.ts`, with identical rules: non-qualified sessions
 * are not deals, and a deal with no funnel stage yet (or one still parked
 * at the pre-deal `new_lead`) falls into the first column.
 */
export function effectivePipelineStage(input: {
  status: string;
  funnelStage: string | null | undefined;
}): PipelineStageKey | null {
  if (input.status !== "qualified") return null;
  const stage = input.funnelStage;
  if (stage && (PIPELINE_STAGE_KEYS as readonly string[]).includes(stage)) {
    return stage as PipelineStageKey;
  }
  return "qualified";
}

export function getStage(key: FunnelStageKey) {
  const stage = FUNNEL_STAGES.find((s) => s.key === key);
  if (!stage) throw new Error(`unknown funnel stage: ${key}`);
  return stage;
}

/** The Meta event to send for a (lane, stage), or null when this stage is
 *  internal-only (not reported to Meta on any lane). */
export function resolveEventName(
  lane: FunnelLane,
  key: FunnelStageKey,
): string | null {
  const stage = getStage(key);
  return lane === "ctwa" ? stage.metaCapi : stage.webPixel;
}

/** Which delivery backend a lane dispatches to. */
export function backendForLane(lane: FunnelLane): "platformA" | "capi" {
  return lane === "code" ? "platformA" : "capi";
}

/**
 * The lead-quality lifecycle label for a stage, or `null` when the stage
 * carries none (the operational in-between stages and the internal-only
 * ones). This is the CRM's own vocabulary — LEAD / MQL / SQL / CONVERTED —
 * travelling as `custom_data.lead_stage` beside Meta's standard
 * `event_name`; see this file's header for why the two are separate.
 */
export type LeadLifecycleStage = "LEAD" | "MQL" | "SQL" | "CONVERTED";

export function resolveLeadStage(key: FunnelStageKey): LeadLifecycleStage | null {
  return getStage(key).leadStage;
}

/**
 * The one stage whose Meta event means MONEY HAS BEEN RECEIVED. Named
 * rather than inlined because two independent guards depend on it —
 * `seedStageConversionEvent`'s payment assertion and the purchase-signal
 * engine's re-point — and a rename that moved one without the other would
 * silently reopen the "Converted before payment" hole.
 */
export const CONVERTED_STAGE: FunnelStageKey = "purchased";

/**
 * Where the purchase-signal engine's PROXY verdict lands. It is an
 * intent judgement ("this lead meets the service's purchase criteria"),
 * not a receipt, so it reports the SQL milestone and must never reach
 * `CONVERTED_STAGE`. See `qualificationEngine.applyPurchaseVerdict`.
 */
export const PURCHASE_SIGNAL_PROXY_STAGE: FunnelStageKey = "price_quoted";
