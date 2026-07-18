// Pure helpers for the post-qualification sales checklist — no Convex
// imports so everything here is directly unit-testable. The checklist a
// lead actually gets is KB-driven (the `SALES CHECKLIST` section of the
// account's knowledge base, turned into tasks by the account's LLM);
// `DEFAULT_SALES_CHECKLIST` is the deterministic fallback so every
// qualified lead ALWAYS gets a checklist, AI or not.

export interface ChecklistItemSeed {
  key: string;
  title: string;
  description?: string;
}

/** The owner's mandatory 6-step sales process (fallback when the KB has
 *  no SALES CHECKLIST section or the LLM output is unusable). */
export const DEFAULT_SALES_CHECKLIST: ChecklistItemSeed[] = [
  {
    key: "call",
    title: "Call the lead",
    description:
      "Speak to the customer on a real call (WhatsApp or phone) — not just chat.",
  },
  {
    key: "pitch",
    title: "Give a proper pitch",
    description:
      "Present the right package for their needs: what's included and why Holidayys.",
  },
  {
    key: "price",
    title: "Offer the price",
    description: "Share the exact package price and what it covers.",
  },
  {
    key: "negotiate",
    title: "Negotiate",
    description:
      "Handle the price discussion — use approved discounts or alternatives to reach a yes.",
  },
  {
    key: "follow_up",
    title: "Follow up again",
    description:
      "If there's no decision, follow up on the agreed date — never leave the lead cold.",
  },
  {
    key: "objection",
    title: "Win them back",
    description:
      "If they give a reason to drop off, address the objection and bring them back.",
  },
];

/** Fixed loss-reason vocabulary ("exactly why" also needs the free-text
 *  detail — this is the aggregatable half). Mirrored client-side in
 *  src/lib/leads/pipeline.ts. */
export const LOSS_CATEGORIES = [
  "price",
  "competitor",
  "budget",
  "timing",
  "unresponsive",
  "changed_plans",
  "other",
] as const;

export type LossCategory = (typeof LOSS_CATEGORIES)[number];

export function isLossCategory(value: string): value is LossCategory {
  return (LOSS_CATEGORIES as readonly string[]).includes(value);
}

const MAX_ITEMS = 12;
const MAX_TITLE = 120;
const MAX_DESCRIPTION = 300;

function slugify(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "task"
  );
}

/**
 * Parses the LLM's checklist generation into item seeds. Strict on shape
 * (a JSON array of `{title, description?}`), forgiving on packaging
 * (```json fences / surrounding prose). Returns null when the output
 * isn't a usable checklist (<2 valid tasks) — the caller falls back to
 * `DEFAULT_SALES_CHECKLIST`.
 */
export function parseChecklistGeneration(
  raw: string,
): ChecklistItemSeed[] | null {
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) text = fence[1].trim();
  // Last resort: slice from the first `[` to the last `]`.
  if (!text.startsWith("[")) {
    const start = text.indexOf("[");
    const end = text.lastIndexOf("]");
    if (start === -1 || end <= start) return null;
    text = text.slice(start, end + 1);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;

  const items: ChecklistItemSeed[] = [];
  const seen = new Map<string, number>();
  for (const entry of parsed) {
    if (items.length >= MAX_ITEMS) break;
    if (typeof entry !== "object" || entry === null) continue;
    const obj = entry as Record<string, unknown>;
    if (typeof obj.title !== "string" || !obj.title.trim()) continue;
    const title = obj.title.trim().slice(0, MAX_TITLE);
    const base = slugify(title);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    const description =
      typeof obj.description === "string" && obj.description.trim()
        ? obj.description.trim().slice(0, MAX_DESCRIPTION)
        : undefined;
    items.push({
      key: n === 1 ? base : `${base}-${n}`,
      title,
      ...(description ? { description } : {}),
    });
  }

  return items.length >= 2 ? items : null;
}

/** A checklist counts as complete only when it has items and every one is
 *  done — the won-gate predicate. */
export function allItemsDone(items: { done: boolean }[]): boolean {
  return items.length > 0 && items.every((i) => i.done);
}

/** System prompt for turning the KB's SALES CHECKLIST excerpts into the
 *  per-lead task list. Deterministic; the strict-JSON contract matches
 *  `parseChecklistGeneration`. */
export function buildChecklistPrompt(args: {
  excerpts: string[];
  serviceName: string | null;
}): string {
  const excerpts = args.excerpts
    .map((c, i) => `[${i + 1}] ${c}`)
    .join("\n\n---\n\n");
  return [
    "You turn a travel company's sales-process documentation into the working checklist a salesperson must complete for one newly qualified lead.",
    args.serviceName ? `The lead's service: ${args.serviceName}.` : "",
    "Documentation excerpts (SALES CHECKLIST section):",
    excerpts,
    "",
    'Reply with ONLY a JSON array of tasks, ordered: [{"title": "…", "description": "…"}]',
    "Rules: 3–12 tasks; imperative titles under 120 characters; description is one concrete sentence; no markdown, no commentary outside the JSON.",
  ]
    .filter(Boolean)
    .join("\n");
}
