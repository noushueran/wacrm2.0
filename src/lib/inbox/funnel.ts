// UI mirror of the funnel stage ORDER + flags (labels come from i18n;
// event mappings live server-side in convex/lib/funnel.ts). Kept as a small
// standalone module so the frontend needn't import across the convex/ boundary.
export const UI_FUNNEL_STAGES = [
  { key: "new_lead", internalOnly: false, needsValue: false },
  { key: "qualified", internalOnly: false, needsValue: false },
  { key: "price_quoted", internalOnly: false, needsValue: false },
  { key: "itinerary_created", internalOnly: true, needsValue: false },
  { key: "itinerary_sent", internalOnly: false, needsValue: false },
  { key: "invoice_sent", internalOnly: false, needsValue: false },
  { key: "purchased", internalOnly: false, needsValue: true },
] as const;

export type UiFunnelStageKey = (typeof UI_FUNNEL_STAGES)[number]["key"];
export const UI_FUNNEL_STAGE_KEYS: UiFunnelStageKey[] = UI_FUNNEL_STAGES.map(
  (s) => s.key,
);
