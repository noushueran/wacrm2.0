/**
 * Sales coach prompt and parsing.
 *
 * This is the one agent whose output is about a named colleague, so two
 * rules are enforced in the parser rather than merely requested in the
 * prompt:
 *
 *  1. NO SCORES. This account has zero deals and nothing has ever
 *     reached price_quoted, so there is no outcome data. A number built
 *     from process alone would read as objective and would not be.
 *  2. EVERY criticism carries a verbatim quote. Feedback about a person
 *     without evidence is an opinion, and an opinion from a model is not
 *     something anyone should have to answer for.
 */

import { withExtraInstructions } from "../agentRegistry";

export const COACH_DIMENSIONS = [
  "unanswered_question",
  "checklist_skipped",
  "slow_response",
  "tone",
] as const;
export type CoachDimension = (typeof COACH_DIMENSIONS)[number];

export interface CoachPromptInput {
  salespersonName: string;
  transcript: string;
  /** Checklist titles still unticked, if the lead has a checklist. */
  outstandingChecklist: string[];
  /** Computed in code — null when no human ever replied. */
  firstResponseMinutes: number | null;
  extraInstructions?: string | null;
}

export function buildCoachPrompt(input: CoachPromptInput): string {
  const responseLine =
    input.firstResponseMinutes === null
      ? "No human ever replied in this thread."
      : `First human reply came ${input.firstResponseMinutes} minutes after the customer wrote.`;

  const head = [
    "You review one WhatsApp sales conversation and coach the salesperson who handled it.",
    "",
    `Salesperson: ${input.salespersonName}`,
    responseLine,
    input.outstandingChecklist.length
      ? `Checklist steps still not done: ${input.outstandingChecklist.join("; ")}`
      : "Checklist: nothing outstanding, or none for this lead.",
    "",
    "Conversation:",
    input.transcript,
    "",
    "Look at exactly four things, and nothing else:",
    "- unanswered_question: the customer asked something and never got an answer.",
    "- checklist_skipped: a listed step was never done.",
    "- slow_response: the reply time above was poor, or nobody replied.",
    "- tone: the handling was curt, confusing, or unhelpful.",
    "",
    "Rules:",
    "- QUOTE THE THREAD for every observation. An observation you cannot",
    "  evidence with the customer's or salesperson's own words is one you",
    "  must not make. This is about a real person's work.",
    "- Do NOT score, grade, rate, or rank. No numbers out of ten, no",
    "  letter grades, no 'good/average/poor' verdicts on the person.",
    "- Judge only what is in this thread. Never guess at what happened on",
    "  a call, in person, or in another channel you cannot see.",
    "- Say what was done WELL too. A list of only faults is not coaching.",
    "- Be specific and brief. 'Ask for the travel dates earlier' beats",
    "  'improve qualification technique'.",
    "- If the thread was handled well, return no observations at all.",
    "  Inventing a fault to look useful is the worst thing you can do here.",
  ].join("\n");

  return withExtraInstructions(
    head,
    [
      'Return ONLY JSON: {"observations": [{"dimension": string, "observation": string, "quote": string}], "strengths": [string]}',
      `dimension must be one of: ${COACH_DIMENSIONS.join(", ")}.`,
    ].join("\n"),
    input.extraInstructions,
  );
}

export interface CoachObservation {
  dimension: CoachDimension;
  observation: string;
  quote?: string;
}

export interface ParsedCoaching {
  observations: CoachObservation[];
  strengths: string[];
}

/** Never throws. Junk degrades to "no coaching", never to a bad note. */
export function parseCoaching(raw: string): ParsedCoaching | null {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;

  const observations: CoachObservation[] = [];
  for (const item of Array.isArray(obj.observations) ? obj.observations : []) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const dimension = String(o.dimension ?? "").trim() as CoachDimension;
    if (!(COACH_DIMENSIONS as readonly string[]).includes(dimension)) continue;

    const observation = typeof o.observation === "string" ? o.observation.trim() : "";
    if (!observation) continue;

    const quote = typeof o.quote === "string" ? o.quote.trim() : "";
    // ENFORCED, not requested: a criticism of a named colleague without
    // evidence from the thread is dropped rather than filed.
    if (!quote) continue;

    observations.push({ dimension, observation, quote });
  }

  const strengths = (Array.isArray(obj.strengths) ? obj.strengths : [])
    .map((s) => (typeof s === "string" ? s.trim() : ""))
    .filter(Boolean);

  return { observations, strengths };
}

/** DRY-RUN stand-in, so tests exercise the real parse path. */
export const SYNTHETIC_COACHING_RAW = JSON.stringify({
  observations: [
    {
      dimension: "unanswered_question",
      observation: "The customer asked about the visa fee and never got a number.",
      quote: "How much is the visa?",
    },
  ],
  strengths: ["Replied quickly and in the customer's own language."],
});
