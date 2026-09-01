// UI mirror of the lead-quality feedback loop's vocabulary (server side:
// `convex/leadQuality.ts`). Kept as a small standalone module so the frontend
// needn't import across the `convex/` boundary — same convention, and the same
// reason, as `src/lib/inbox/funnel.ts`.
//
// Labels live in i18n (`Inbox.leadQuality.*`), not here: this file carries
// only the keys and their order.

export const LEAD_QUALITY_STEPS = [
  "genuine",
  "service",
  "intent",
  "payment",
] as const;
export type LeadQualityStep = (typeof LEAD_QUALITY_STEPS)[number];

/**
 * Why a lead was rejected. Drawn from the business rules for what must NOT
 * be marked qualified — spam, supplier outreach, job enquiries, wrong
 * service, unusable number, duplicates, and "asked a price then vanished".
 *
 * These are the ONLY thing a `no` collects, and it is one tap: the loss
 * dialog's mandatory free text is part of why bad leads went unrecorded, so
 * nothing here requires typing.
 */
export const LEAD_QUALITY_REASONS = [
  "spam",
  "supplier_vendor",
  "job_seeker",
  "wrong_service",
  "fake_number",
  "duplicate",
  "no_intent",
  "other",
] as const;
export type LeadQualityReason = (typeof LEAD_QUALITY_REASONS)[number];

/** The step whose positive answer carries money, and so needs an amount. */
export const LEAD_QUALITY_VALUE_STEP: LeadQualityStep = "payment";
