import type { OpsBlockInput, OpsKind } from "./types";

export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

// Exact heading grammar the live engines fuzzy-retrieve by (em dash).
// Also accepts en dash / hyphen when PARSING legacy pastes, but always
// RENDERS the em dash form.
const HEADING_RE = /^(QUALIFICATION CHECKLIST|SALES CHECKLIST|PURCHASE CRITERIA)\s*[—–-]\s*(.+?)\s*$/;

const KIND_BY_HEADING: Record<string, OpsKind> = {
  "QUALIFICATION CHECKLIST": "qualification",
  "SALES CHECKLIST": "sales",
  "PURCHASE CRITERIA": "purchase",
};

export function renderOpsSentinel(serviceName: string, block: OpsBlockInput): string {
  if (block.kind === "qualification") {
    const lines = (block.criteria ?? []).map((c) => {
      const base = c.marks !== undefined ? `- ${c.label} (${c.marks} marks)` : `- ${c.label}`;
      return c.question ? `${base} — ask: ${c.question}` : base;
    });
    return [`QUALIFICATION CHECKLIST — ${serviceName}`, ...lines].join("\n");
  }
  if (block.kind === "sales") {
    const lines = (block.steps ?? []).map((s) =>
      s.description ? `- ${s.label}: ${s.description}` : `- ${s.label}`,
    );
    return [`SALES CHECKLIST — ${serviceName}`, ...lines].join("\n");
  }
  const lines = (block.conditions ?? []).map((c) => `- ${c.label}`);
  const tail =
    block.reportValue !== undefined
      ? [`Report value: ${block.reportValue} ${block.currency ?? "AED"}`]
      : [];
  return [`PURCHASE CRITERIA — ${serviceName}`, ...lines, ...tail].join("\n");
}

export type ParsedLegacySection = { kind: OpsKind; serviceName: string; raw: string };
export type ParsedLegacyDoc = { title: string; prose: string; sections: ParsedLegacySection[] };

export function parseLegacyDocument(title: string, content: string): ParsedLegacyDoc {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const proseLines: string[] = [];
  const sections: ParsedLegacySection[] = [];
  let current: ParsedLegacySection | null = null;
  for (const line of lines) {
    const m = line.match(HEADING_RE);
    if (m) {
      current = { kind: KIND_BY_HEADING[m[1]], serviceName: m[2], raw: "" };
      sections.push(current);
      continue;
    }
    if (current) current.raw += (current.raw ? "\n" : "") + line;
    else proseLines.push(line);
  }
  for (const s of sections) s.raw = s.raw.trim();
  return { title, prose: proseLines.join("\n").trim(), sections };
}

const ITEM_RE = /^-\s*(.+?)(?:\s*\((\d+)\s*marks?\))?\s*$/;
export function parseChecklistLines(raw: string): { label: string; marks?: number }[] {
  const items: { label: string; marks?: number }[] = [];
  for (const line of raw.split("\n")) {
    const m = line.trim().match(ITEM_RE);
    if (!m) continue;
    items.push(m[2] !== undefined ? { label: m[1], marks: Number(m[2]) } : { label: m[1] });
  }
  return items;
}

const REPORT_VALUE_RE = /^Report value:\s*(\d+(?:\.\d+)?)\s*([A-Z]{3})?\s*$/im;
export function parseReportValue(raw: string): { reportValue?: number; currency?: string } {
  const m = raw.match(REPORT_VALUE_RE);
  if (!m) return {};
  return m[2] ? { reportValue: Number(m[1]), currency: m[2] } : { reportValue: Number(m[1]) };
}
