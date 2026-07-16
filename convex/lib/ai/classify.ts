// ============================================================
// Pure helpers for the AI "classify" path — no I/O, unit-tested directly
// (same pattern as lib/ai/context.ts / handoff.ts). buildClassifyPrompt
// renders the account's tag catalogue as a fixed option set; the model
// may only choose from it. parseClassification maps the model's chosen
// tag NAMES back to real tag ids, dropping anything off-list and
// enforcing single-select groups. Never throws.
// ============================================================

export interface CatalogueGroup {
  id: string;
  name: string;
  selectionMode: "single" | "multi";
  tags: { id: string; name: string }[];
}
export interface Catalogue {
  groups: CatalogueGroup[];
}
export interface Classification {
  tagIds: string[];
  note?: string;
  confidence: "high" | "medium" | "low";
}

const CONFIDENCES = ["high", "medium", "low"] as const;

/** Extract the first balanced-looking JSON object from model text. */
function extractJsonObject(raw: string): unknown {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}

export function parseClassification(raw: string, catalogue: Catalogue): Classification {
  const obj = extractJsonObject(raw) as
    | { tags?: unknown; note?: unknown; confidence?: unknown }
    | null;
  if (!obj || typeof obj !== "object") return { tagIds: [], confidence: "low" };

  // name (lowercased) -> { id, groupId, single }
  const byName = new Map<string, { id: string; groupId: string; single: boolean }>();
  for (const g of catalogue.groups) {
    for (const tag of g.tags) {
      byName.set(tag.name.toLowerCase(), {
        id: tag.id,
        groupId: g.id,
        single: g.selectionMode === "single",
      });
    }
  }

  const names = Array.isArray(obj.tags)
    ? obj.tags.filter((x): x is string => typeof x === "string")
    : [];
  const tagIds: string[] = [];
  const usedSingleGroups = new Set<string>();
  const seen = new Set<string>();
  for (const name of names) {
    const hit = byName.get(name.trim().toLowerCase());
    if (!hit || seen.has(hit.id)) continue;
    if (hit.single && usedSingleGroups.has(hit.groupId)) continue; // one per single group
    tagIds.push(hit.id);
    seen.add(hit.id);
    if (hit.single) usedSingleGroups.add(hit.groupId);
  }

  const note =
    typeof obj.note === "string" && obj.note.trim() ? obj.note.trim() : undefined;
  const confidence = CONFIDENCES.includes(obj.confidence as (typeof CONFIDENCES)[number])
    ? (obj.confidence as "high" | "medium" | "low")
    : "low";

  return { tagIds, note, confidence };
}
