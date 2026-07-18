// UI mirror of the funnel stage ORDER + flags (labels come from i18n;
// event mappings live server-side in convex/lib/funnel.ts). Kept as a small
// standalone module so the frontend needn't import across the convex/ boundary.
// `terminal` marks an exit state (lost): the sidebar stepper hides it until
// reached, and the pipeline renders it as a closing column, not a milestone.
export const UI_FUNNEL_STAGES = [
  { key: "new_lead", internalOnly: false, needsValue: false, terminal: false },
  { key: "qualified", internalOnly: false, needsValue: false, terminal: false },
  { key: "price_quoted", internalOnly: false, needsValue: false, terminal: false },
  { key: "itinerary_created", internalOnly: true, needsValue: false, terminal: false },
  { key: "itinerary_sent", internalOnly: false, needsValue: false, terminal: false },
  { key: "invoice_sent", internalOnly: false, needsValue: false, terminal: false },
  { key: "purchased", internalOnly: false, needsValue: true, terminal: false },
  { key: "lost", internalOnly: true, needsValue: false, terminal: true },
] as const;

export type UiFunnelStageKey = (typeof UI_FUNNEL_STAGES)[number]["key"];
export const UI_FUNNEL_STAGE_KEYS: UiFunnelStageKey[] = UI_FUNNEL_STAGES.map(
  (s) => s.key,
);
