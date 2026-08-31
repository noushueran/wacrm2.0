import { clampScore } from "./bands";
import type { ChatMessage } from "../ai/types";
import { withExtraInstructions } from "../agentRegistry";

// ============================================================
// Scoring prompt + response parsing. Pure and separately testable
// because the parse boundary is where an unreliable model meets a typed
// database: the score is clamped, the reason is truncated, and signals
// are intersected with a closed vocabulary, so nothing the model invents
// can reach the schema.
// ============================================================

/** The closed signal set. Anything else the model emits is discarded. */
export const SIGNAL_VOCABULARY = [
  "budget_given",
  "dates_given",
  "travelers_given",
  "destination_given",
  "ready_to_book",
  "price_shopping",
  "wrong_service",
  "unresponsive",
  "ghosted",
  "complaint",
  "spam",
] as const;

const REASON_MAX_CHARS = 240;

export interface ScorePromptInput {
  serviceName: string | null;
  services: string[];
  contact: {
    name?: string;
    travelDates?: string;
    travelers?: string;
    budget?: string;
    preferredDestination?: string;
  };
  /** The team's own notes on this contact, newest first, already
   *  formatted and TRUNCATED by the caller (see `formatNotesForScoring`).
   *
   *  Unlike `buildSystemPrompt`, this one gets the real text: this job's
   *  output is a score and a reason an AGENT reads, never a message a
   *  customer receives. "Met him, he's ready to book" is exactly the
   *  context that makes a score correct, and no message history carries
   *  it. */
  agentNotes?: string[];
}

export function buildScoreSystemPrompt(
  input: ScorePromptInput,
  extraInstructions?: string | null,
): string {
  const profile: string[] = [];
  const { contact } = input;
  if (contact.name) profile.push(`Name: ${contact.name}`);
  if (contact.preferredDestination) profile.push(`Destination: ${contact.preferredDestination}`);
  if (contact.travelDates) profile.push(`Travel dates: ${contact.travelDates}`);
  if (contact.travelers) profile.push(`Travellers: ${contact.travelers}`);
  if (contact.budget) profile.push(`Budget: ${contact.budget}`);

  const sections = [
    "You score sales leads for a travel agency that talks to customers on WhatsApp.",
    "You will be shown a conversation transcript. Judge how worth chasing this lead is.",
    "",
    "Score from 1 to 10:",
    "  9-10 — ready to book: explicit intent, concrete dates or budget, asking how to pay.",
    "  6-8  — genuine enquiry with real detail, still deciding.",
    "  4-5  — vague interest, little detail, or only price questions.",
    "  2-3  — browsing, one-line enquiry, or long silence after our reply.",
    "  1    — wrong service, spam, or clearly not a customer.",
    "",
    "Judge intent, fit, and specificity. Do NOT reward long conversations on their own —",
    "a short message with dates and a budget outranks a long one with neither.",
  ];

  if (input.serviceName) {
    sections.push("", `The customer is enquiring about: ${input.serviceName}`);
  }
  if (input.services.length > 0) {
    sections.push(`Services this agency sells: ${input.services.join(", ")}`);
  }
  if (profile.length > 0) {
    sections.push("", "Known details about this customer:", ...profile.map((p) => `  ${p}`));
  }
  if (input.agentNotes && input.agentNotes.length > 0) {
    sections.push(
      "",
      "The team's own notes on this contact (most recent first). These record " +
        "what happened off WhatsApp — calls, meetings, payments — and are often " +
        "more decisive than the chat history:\n" +
        input.agentNotes.join("\n"),
    );
  }

  sections.push(
    "",
    `Allowed signals (use only these): ${SIGNAL_VOCABULARY.join(", ")}`,
    "",
    "Reply with JSON ONLY, no prose and no code fence:",
    '{"score": <1-10>, "reason": "<one short sentence>", "signals": ["<signal>", ...]}',
  );

  // The closing contract is split out so the business's own words land
  // BEFORE it — see `withExtraInstructions`.
  const closingAt = sections.indexOf("Reply with JSON ONLY, no prose and no code fence:");
  if (closingAt === -1) return sections.join("\n");
  return withExtraInstructions(
    sections.slice(0, closingAt).join("\n"),
    sections.slice(closingAt).join("\n"),
    extraInstructions,
  );
}

/** Newest-first, capped. A chatty thread must not be able to inflate
 *  token spend without bound — the account's usage card is a 30-day
 *  window, and an uncapped prompt input is how that number surprises
 *  someone.
 *
 *  Exported so the caller's own read cap (`leadAnalysisEngine.ts`'s
 *  `contactNotes` query) can share this exact number instead of
 *  maintaining its own copy that could drift — there is no reason to
 *  ever read more rows than this formatter will keep. */
export const SCORING_NOTES_MAX = 10;
const SCORING_NOTES_MAX_CHARS = 1500;

/**
 * Pure formatter and budget-capper for `agentNotes`. Callers must supply
 * notes already sorted newest-first (the `by_contact` index with
 * `.order("desc")`); this function never sorts, it only caps.
 *
 * The budget also reserves 1 char per note after the first for the
 * `"\n"` `buildScoreSystemPrompt` later joins the returned array with —
 * so the STRING that actually reaches the model, not just the sum of
 * this function's own return values, stays within `SCORING_NOTES_MAX_CHARS`.
 */
export function formatNotesForScoring(
  notes: Array<{ _creationTime: number; noteText: string; kind?: string }>,
): string[] {
  const out: string[] = [];
  let budget = SCORING_NOTES_MAX_CHARS;
  for (const note of notes.slice(0, SCORING_NOTES_MAX)) {
    if (budget <= 0) break;
    // Every note after the first costs one extra char when the caller
    // later `.join("\n")`s the array — reserved here so that join can
    // never push the actual prompt text over budget.
    const separatorCost = out.length > 0 ? 1 : 0;
    const available = budget - separatorCost;
    if (available <= 0) break;
    const line = `${new Date(note._creationTime).toISOString().slice(0, 10)} · ${note.kind ?? "note"}: ${note.noteText}`;
    // Oldest dropped first: the loop runs newest-first, so once a line
    // no longer fully fits, TRUNCATE it to whatever budget remains
    // instead of dropping it outright (nothing validates `noteText`
    // length, so a single ~2000-char note used to `break` here and
    // return `[]` — blanking the whole notes section the scoring model
    // sees). Truncating means the newest note is always at least
    // partially represented; any OLDER note after it is still dropped
    // outright, since there is no budget left to even start one.
    if (line.length > available) {
      out.push(line.slice(0, available));
      break;
    }
    out.push(line);
    budget -= line.length + separatorCost;
  }
  return out;
}

/**
 * Append a final `user` turn before handing a scoring chat to
 * `generateReply`. NOT a no-op / removable nicety: Anthropic's Messages
 * API treats a TRAILING `assistant` turn as a response PREFILL — it
 * continues that message instead of answering the system prompt. Every
 * "awaiting them" lead (our reply is the last thing in the thread — most
 * open conversations, and most backfilled history) ends its `chat` array
 * on an assistant turn, so scoring it without this guard makes the model
 * keep writing the agent's WhatsApp reply instead of returning JSON.
 * `parseScoreResponse` then sees prose, returns null, and the row burns
 * its whole attempt budget (3 paid calls) without ever producing a
 * score. Harmless on OpenAI, which has no prefill semantics — this just
 * reads as one more turn there. Builds a NEW array; never mutates the
 * one the caller passed in.
 */
export function withScoringInstruction(chat: ChatMessage[]): ChatMessage[] {
  return [
    ...chat,
    { role: "user", content: "Score this conversation now. Reply with JSON only." },
  ];
}

export interface ParsedScore {
  score: number;
  reason: string;
  signals: string[];
}

/**
 * Pull the first balanced JSON object out of arbitrary model output.
 * String-literal aware: braces inside a JSON string (e.g. in a free-form
 * `reason`) must not perturb the depth count, so we track whether we're
 * inside a `"..."` string and honor backslash escapes while there.
 */
function extractJsonObject(raw: string): string | null {
  const start = raw.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }
  return null;
}

export function parseScoreResponse(raw: string): ParsedScore | null {
  // The type signature promises a string, but the contract with callers is
  // that this function is total over arbitrary provider output — never throw.
  if (typeof raw !== "string") return null;
  const json = extractJsonObject(raw);
  if (!json) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;

  // Accept a number or a numeric string; reject anything else outright —
  // a missing or non-numeric score means the model did not do the task.
  const rawScore =
    typeof obj.score === "number"
      ? obj.score
      : typeof obj.score === "string" && obj.score.trim() !== ""
        ? Number(obj.score)
        : Number.NaN;
  if (!Number.isFinite(rawScore)) return null;

  if (typeof obj.reason !== "string" || obj.reason.trim() === "") return null;

  const allowed = new Set<string>(SIGNAL_VOCABULARY);
  const signals = Array.isArray(obj.signals)
    ? [...new Set(obj.signals.filter((s): s is string => typeof s === "string" && allowed.has(s)))]
    : [];

  return {
    score: clampScore(rawScore),
    reason: obj.reason.trim().slice(0, REASON_MAX_CHARS),
    signals,
  };
}
