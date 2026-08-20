// Meta templates use positional {{1}}, {{2}}, … placeholders. This
// module answers "which variables does this template body need, in the
// order Meta expects them" so the builder can render one input per
// variable. The numeric sort mirrors `automationsEngine.ts`'s
// `sortTemplateParams`, which exists because a lexicographic sort yields
// "1", "10", "2", … and silently scrambles any template with ≥10
// variables.

const PLACEHOLDER = /\{\{\s*(\d+)\s*\}\}/g;

/** Unique placeholder numbers in a template body, ascending. */
export function extractTemplateVariables(body: string): number[] {
  if (!body) return [];
  const found = new Set<number>();
  for (const match of body.matchAll(PLACEHOLDER)) {
    const n = Number(match[1]);
    if (Number.isInteger(n) && n > 0) found.add(n);
  }
  return [...found].sort((a, b) => a - b);
}
