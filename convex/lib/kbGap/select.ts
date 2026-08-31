/**
 * Knowledge gap agent — which answered inquiries are worth spending a
 * provider call on.
 *
 * Pure, so the rules carry unit tests without a ctx, like every other
 * agent's selection logic.
 */

export interface KbGapConfig {
  enabled: boolean;
  entriesPerRun: number;
  /** Answers shorter than this cannot be knowledge. */
  minAnswerChars: number;
}

/** Off by default: with no enabled row the sweep finds nothing and the
 *  feature costs nothing, like every other agent here. */
export const DEFAULT_KB_GAP_CONFIG: KbGapConfig = {
  enabled: false,
  entriesPerRun: 10,
  minAnswerChars: 20,
};

/**
 * A bare acknowledgement — the staff member tapped something to clear
 * the notification. Production stores "Okay" as an answer.
 *
 * Anchored to the WHOLE string on purpose: "Yes , freelance visa can
 * change to employment visa later" must not match, and it is the single
 * most valuable answer in the production sample.
 */
const BARE_ACK = /^(ok|okay|yes|no|done|noted|sure|thanks|thank you)[\s.!]*$/i;

/**
 * Whether this answer is too thin to be worth a provider call.
 *
 * DELIBERATELY narrow. It catches only what can be decided from the
 * shape of the text — emptiness, brevity, a bare acknowledgement.
 *
 * It does NOT try to spot a long, polite deflection like "Tell them our
 * team will contact you for this solution" (also real production data).
 * Recognising that requires reading meaning, and a keyword list would
 * reject genuine answers that happen to mention the team. That
 * judgement belongs to the model, which returns `worthKeeping` with a
 * reason — see `./prompt.ts`.
 */
export function isThinAnswer(
  answer: string | null | undefined,
  config: KbGapConfig,
): boolean {
  const text = (answer ?? "").trim();
  if (text.length < config.minAnswerChars) return true;
  if (BARE_ACK.test(text)) return true;
  return false;
}
