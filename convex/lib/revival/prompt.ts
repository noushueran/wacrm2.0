/**
 * Revival agent prompt and response parsing. Pure, so both carry unit
 * tests without ever touching a provider — the same split as
 * `lib/leadAnalysis/prompt.ts` and `lib/ai/classify.ts`.
 */

import { withExtraInstructions } from "../agentRegistry";

/**
 * A WhatsApp display name is whatever the person typed into their own
 * profile. In this account that includes "Alhamdulillah", emoji-laden
 * handles like "கண்ணப்பகோனார் 🔥🔥தீரன்", shop names, and blanks — so
 * `contacts.name` is NOT reliably a personal name, and a nudge opening
 * "Alhamdulillah 😊" (seen in production 2026-08-09) reads as a bot
 * mistaking a phrase for a person.
 *
 * This strips decoration and returns null when nothing name-like is
 * left. It deliberately does NOT try to judge whether the remaining
 * words are "really" a name — that is unknowable across Malayalam,
 * Tamil, Arabic and Latin scripts, and guessing wrong would drop real
 * names. The prompt handles the residual doubt by telling the model the
 * value may not be a personal name at all.
 */
export function sanitizeContactName(raw: string | null): string | null {
  if (!raw) return null;
  const cleaned = raw
    // Pictographs, variation selectors, and zero-width joiners.
    .replace(/[\p{Extended_Pictographic}️‍]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  // A single character is decoration, not an address.
  return cleaned.length >= 2 ? cleaned : null;
}

export interface RevivalPromptInput {
  contactName: string | null;
  serviceName: string | null;
  /** Rendered "field: value" lines from the qualification profile. */
  profileLines: string[];
  quietHours: number;
  /** The account's own extra instructions for this agent, if any. */
  extraInstructions?: string | null;
}

export function buildRevivalPrompt(input: RevivalPromptInput): string {
  const name = sanitizeContactName(input.contactName);
  const who = name ?? "(not known)";
  const service = input.serviceName ?? "what they asked about";
  const profile = input.profileLines.length
    ? input.profileLines.join("\n")
    : "(nothing captured yet)";

  const head = [
    "You write ONE short WhatsApp follow-up to a travel customer who stopped replying.",
    "",
    `Customer's WhatsApp profile name: ${who}`,
    `Interested in: ${service}`,
    `Quiet for: ${input.quietHours} hours`,
    "What we know about their trip:",
    profile,
    "",
    "Rules:",
    "- That profile name is whatever they typed about themselves. It is often",
    "  a shop name, a phrase like 'Alhamdulillah', or decoration. Use it ONLY",
    "  if it plainly reads as a personal name; otherwise greet them without a",
    "  name. Never open with it as if it were one.",
    "- Reply in the SAME language and script they were using, including Manglish.",
    "- Reference their actual trip. A generic 'just checking in' is a failure.",
    "- One or two sentences. This is WhatsApp, not email.",
    "- Do NOT invent a price, a discount, availability, or any commitment.",
    "- Do NOT apologise for messaging, and do not open with 'Sorry to bother'.",
    "- End with one easy question they can answer in a few words.",
  ].join("\n");

  // The business's own words go BEFORE the format contract — see
  // `withExtraInstructions` for why that ordering is the safety
  // property, not a stylistic choice.
  return withExtraInstructions(
    head,
    [
      'Return ONLY JSON: {"body": string, "reason": string, "confidence": "high"|"medium"|"low"}',
      "`reason` is one line for a human reviewer explaining why this lead, now.",
    ].join("\n"),
    input.extraInstructions,
  );
}

export interface ParsedDraft {
  body: string;
  reason: string;
  confidence: "high" | "medium" | "low";
}

/**
 * Never throws. A model returning junk must degrade to "no draft for
 * this lead", not take down the whole sweep — the same contract as
 * `lib/ai/classify.ts`'s `parseClassification`.
 */
export function parseRevivalDraft(raw: string): ParsedDraft | null {
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
  // Arrays are objects too, and `typeof null === "object"` — both would
  // sail through a naive check and blow up on property access below.
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }

  const obj = parsed as Record<string, unknown>;
  const body = typeof obj.body === "string" ? obj.body.trim() : "";
  if (!body) return null;

  const reason = typeof obj.reason === "string" ? obj.reason.trim() : "";

  // Anything beyond the three known values is treated as low: an
  // unrecognised confidence is not evidence of confidence.
  const c = obj.confidence;
  const confidence = c === "high" || c === "medium" || c === "low" ? c : "low";

  return { body, reason, confidence };
}

/**
 * DRY-RUN stand-in, so tests exercise the real parse path with no
 * network — mirrors `aiTagging`'s `syntheticClassifyRaw`. Confidence is
 * pinned low: a synthetic guess earns no more than that.
 */
export const SYNTHETIC_REVIVAL_RAW = JSON.stringify({
  body: "Hi! Still thinking about the trip? Happy to help with the next step.",
  reason: "Synthetic dry-run draft",
  confidence: "low",
});
