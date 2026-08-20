/**
 * Knowledge gap agent prompts and parsing. Pure, so both carry unit
 * tests without ever touching a provider.
 *
 * TWO jobs, deliberately separate:
 *
 *  - `buildEntryPrompt` turns ONE answered inquiry into a knowledge-base
 *    draft. The answer already exists — a human wrote it — so the model
 *    is rewriting, not inventing.
 *
 *  - `buildClusterPrompt` groups the questions nobody answered. It is
 *    told, in as many words, not to answer them: visa eligibility and
 *    pricing are exactly where a confident guess costs a customer or a
 *    fine, and there is no human answer here to rewrite.
 */

import { withExtraInstructions } from "../agentRegistry";

/** The `kbEntries.type` values a drafted entry may claim. */
export const DRAFTABLE_TYPES = [
  "faq",
  "policy",
  "process",
  "requirements",
  "note",
] as const;
export type DraftableType = (typeof DRAFTABLE_TYPES)[number];

export interface EntryPromptInput {
  question: string;
  answer: string;
  serviceName: string | null;
  extraInstructions?: string | null;
}

export function buildEntryPrompt(input: EntryPromptInput): string {
  const head = [
    "A customer asked a travel agency a question the assistant could not answer.",
    "A member of staff answered it. Turn that exchange into ONE knowledge-base entry",
    "so the assistant can answer it itself next time.",
    "",
    `Customer's question: ${input.question}`,
    `Staff answer: ${input.answer}`,
    input.serviceName ? `Service: ${input.serviceName}` : "Service: (not identified)",
    "",
    "Rules:",
    "- Use ONLY what the staff answer actually says. Never add a fact it does not contain,",
    "  however confident you are — a wrong visa rule is worse than a missing one.",
    "- Write the body as a statement of fact, not as a reply to one person.",
    "  'Freelance visas can be converted to employment visas later', not 'Yes you can'.",
    "- Fix spelling and grammar. Keep the meaning exactly.",
    "- Set worthKeeping false when the answer is a deflection rather than knowledge",
    "  ('our team will contact you', 'we will check'), or when it is specific to one",
    "  customer and teaches nothing reusable. Say why in reason.",
    `- type must be one of: ${DRAFTABLE_TYPES.join(", ")}.`,
  ].join("\n");

  return withExtraInstructions(
    head,
    [
      'Return ONLY JSON: {"worthKeeping": boolean, "reason": string, "title": string, "body": string, "type": string}',
      "title is a short heading a colleague could scan. body is one or two plain sentences.",
    ].join("\n"),
    input.extraInstructions,
  );
}

export interface ParsedEntry {
  worthKeeping: boolean;
  reason: string;
  title: string;
  body: string;
  type: DraftableType;
}

/** Never throws — junk degrades to "no draft", never to a bad entry. */
export function parseEntryDraft(raw: string): ParsedEntry | null {
  const obj = parseJsonObject(raw);
  if (!obj) return null;

  const worthKeeping = obj.worthKeeping === true;
  const reason = str(obj.reason);
  // A rejection is a complete, useful answer — it needs no title or body.
  if (!worthKeeping) {
    return { worthKeeping: false, reason, title: "", body: "", type: "faq" };
  }

  const title = str(obj.title);
  const body = str(obj.body);
  // Keeping something with no body would put an empty entry in the KB.
  if (!title || !body) return null;

  const t = str(obj.type).toLowerCase();
  const type = (DRAFTABLE_TYPES as readonly string[]).includes(t)
    ? (t as DraftableType)
    : "faq";

  return { worthKeeping: true, reason, title, body, type };
}

export interface ClusterPromptInput {
  questions: string[];
  extraInstructions?: string | null;
}

export function buildClusterPrompt(input: ClusterPromptInput): string {
  const numbered = input.questions
    .map((q, i) => `${i + 1}. ${q.replace(/\s+/g, " ").trim()}`)
    .join("\n");

  const head = [
    "These are questions customers asked a travel agency that NOBODY has answered.",
    "Group them into themes, so the business can see what it keeps being asked",
    "and has never written down.",
    "",
    numbered,
    "",
    "Rules:",
    "- DO NOT ANSWER ANY OF THEM. You do not know this agency's visa rules,",
    "  prices, or policies, and a confident guess here is worse than silence.",
    "- A theme names what the questions are ABOUT, in a few words.",
    "- Group only genuinely similar questions. A theme of one is fine and honest;",
    "  forcing unrelated questions together hides the real pattern.",
    "- Order themes by how many questions they cover, most first.",
  ].join("\n");

  return withExtraInstructions(
    head,
    [
      'Return ONLY JSON: {"themes": [{"theme": string, "questions": [<1-based numbers>]}]}',
      "Every question number must appear in exactly one theme.",
    ].join("\n"),
    input.extraInstructions,
  );
}

export interface ParsedTheme {
  theme: string;
  /** Zero-based indexes into the questions array handed to the prompt. */
  indexes: number[];
}

/**
 * Never throws. Out-of-range and duplicate numbers are dropped rather
 * than trusted: the model is 1-based and enthusiastic, and an index off
 * the end would read someone else's question into a theme.
 */
export function parseClusters(raw: string, questionCount: number): ParsedTheme[] {
  const obj = parseJsonObject(raw);
  if (!obj || !Array.isArray(obj.themes)) return [];

  const seen = new Set<number>();
  const out: ParsedTheme[] = [];

  for (const entry of obj.themes) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const theme = str(e.theme);
    if (!theme) continue;

    const nums = Array.isArray(e.questions) ? e.questions : [];
    const indexes: number[] = [];
    for (const n of nums) {
      const i = typeof n === "number" ? Math.floor(n) - 1 : NaN;
      if (!Number.isInteger(i) || i < 0 || i >= questionCount) continue;
      if (seen.has(i)) continue;
      seen.add(i);
      indexes.push(i);
    }
    if (indexes.length > 0) out.push({ theme, indexes });
  }

  return out.sort((a, b) => b.indexes.length - a.indexes.length);
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
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
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  return parsed as Record<string, unknown>;
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** DRY-RUN stand-ins, so tests exercise the real parse paths. */
export const SYNTHETIC_ENTRY_RAW = JSON.stringify({
  worthKeeping: true,
  reason: "Synthetic dry-run draft",
  title: "Freelance visa conversion",
  body: "A freelance visa can be converted to an employment visa later.",
  type: "faq",
});

export const SYNTHETIC_CLUSTER_RAW = JSON.stringify({
  themes: [{ theme: "Visa conversion", questions: [1] }],
});
