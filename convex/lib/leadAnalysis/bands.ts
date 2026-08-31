// ============================================================
// Pure banding math for Lead Analysis. No I/O, no Date.now() — the
// board and the engine both route every score through here so a band
// can never be computed two different ways.
// ============================================================

export type LeadBand = "hot" | "warm" | "cold";

export interface BandStep {
  delayDays: number;
  templateName: string;
  templateLanguage?: string;
}

export interface BandRule {
  key: LeadBand;
  minScore: number;
  maxScore: number;
  autoArchive: boolean;
  steps: BandStep[];
}

export const MIN_SCORE = 1;
export const MAX_SCORE = 10;

/**
 * Coerce a model-supplied number into a trustworthy integer score.
 * The model is never trusted: NaN floors to MIN_SCORE, Infinity caps at
 * MAX_SCORE, and everything else rounds then clamps.
 */
export function clampScore(raw: number): number {
  if (Number.isNaN(raw)) return MIN_SCORE;
  const rounded = Math.round(raw);
  if (rounded < MIN_SCORE) return MIN_SCORE;
  if (rounded > MAX_SCORE) return MAX_SCORE;
  return rounded;
}

/** The band whose inclusive [minScore, maxScore] covers `score`. */
export function bandForScore(score: number, bands: BandRule[]): LeadBand | null {
  const hit = bands.find((b) => score >= b.minScore && score <= b.maxScore);
  return hit ? hit.key : null;
}

/**
 * True iff any step in any band has no template chosen yet (P3 Task
 * 10 — the config UI's gate 1: "cannot enable while any band has a
 * hole in the cadence"). A step with an empty `templateName` would
 * stop every lead that reaches it with `template_unavailable`
 * (`lib/leadAnalysis/eligibility.ts` gate 12) — silently doing
 * nothing rather than sending.
 *
 * This is the ONE function both `leadAnalysis.updateConfig` (the
 * save-time guard — the actual correctness boundary, since a client
 * can call the mutation directly) and the settings UI (which disables
 * the enable toggle) call, so the two checks can never drift apart.
 */
export function bandsMissingTemplate(bands: BandRule[]): boolean {
  return bands.some((band) =>
    band.steps.some((step) => !step.templateName || step.templateName.trim() === ""),
  );
}
