import type { CustomField } from "@/types";

/** Normalises one raw custom-field value against its field's current type/
 *  options so a strict server-side validator never rejects it. Returns the
 *  value to send, or null to DROP it (stale select value / emptied
 *  multiselect / unknown field). Select: keep only if in options. Multiselect:
 *  keep only in-option items (JSON array string); null if none remain. Other
 *  types (text/date/number/legacy) pass through unchanged. */
export function pruneValueForField(field: CustomField | undefined, rawValue: string): string | null {
  if (!field) return null;
  const options = (field.field_options?.options as string[] | undefined) ?? [];
  if (field.field_type === "select") {
    return options.includes(rawValue) ? rawValue : null;
  }
  if (field.field_type === "multiselect") {
    let parsed: unknown;
    try { parsed = JSON.parse(rawValue); } catch { return null; }
    if (!Array.isArray(parsed)) return null;
    const kept = parsed.filter((x): x is string => typeof x === "string" && options.includes(x));
    return kept.length ? JSON.stringify(kept) : null;
  }
  return rawValue;
}
