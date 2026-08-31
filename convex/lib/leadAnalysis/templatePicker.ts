// ============================================================
// Which templates the follow-up sequence's step picker (P3 Task 10 UI,
// `lead-sequence-settings.tsx`) may offer. Pure — no I/O, no Convex
// imports — so the exclusion rule is unit-testable without a Convex
// runtime and can never drift from what the picker actually renders,
// the same reasoning as `bands.ts`'s own `bandsMissingTemplate`.
//
// Fix 3 (whole-branch review, "a parameterised template silently burns
// the cadence"): `leadAnalysisEngine.ts`'s `sendSequenceStep` calls
// `metaSend.sendTemplate` with a FIXED, un-parameterised body — no
// `params` are ever supplied. A template whose body carries Meta
// variable placeholders (`{{1}}`, ...) is still perfectly capable of
// being APPROVED (Meta only reviews the text, never whether a future
// caller will ever supply params for it), so the picker's previous
// `status === 'APPROVED'` filter alone would happily offer one. Meta
// then rejects the send at runtime (error 132000) — see Fix 3's other
// half (`STOP_REASONS`'s `"send_failed"` in `eligibility.ts`) for what
// happens if one is picked anyway. Excluding it HERE, at configuration
// time, is cheaper and louder than only catching the failure at send
// time.
// ============================================================

/** The subset of a `messageTemplates` row this module needs — never a
 *  `Doc<"messageTemplates">` import, so this stays callable from plain
 *  client-side data (the container's `api.templates.list` result) with
 *  no Convex dependency. */
export interface TemplateCatalogRow {
  name: string;
  language?: string;
  status?: string;
  sampleValues?: { body?: string[]; header?: string[] };
}

export interface TemplatePickerOption {
  name: string;
  language?: string;
}

/** True iff this template's body is parameterised — it carries at
 *  least one Meta sample variable and so needs `params` at send time,
 *  which the follow-up sequence's fixed-body send never supplies. */
export function templateHasBodyPlaceholders(row: TemplateCatalogRow): boolean {
  return (row.sampleValues?.body?.length ?? 0) > 0;
}

/**
 * The options the step picker may offer: APPROVED and un-parameterised.
 * This function is the ONE place that filter is expressed — mirrors
 * `bandsMissingTemplate`'s own header comment on why a duplicate,
 * hand-rolled copy anywhere else (the container, a future new picker)
 * is exactly how the UI and the real send-time constraint would
 * silently drift apart.
 */
export function pickableSequenceTemplates(
  rows: TemplateCatalogRow[],
): TemplatePickerOption[] {
  return rows
    .filter((row) => row.status === "APPROVED" && !templateHasBodyPlaceholders(row))
    .map((row) => ({ name: row.name, language: row.language }));
}

/** Count of APPROVED templates hidden from the picker specifically
 *  because they're parameterised — never templates hidden merely for
 *  not being approved, which the picker already explains via
 *  `bands.noApprovedTemplates`. Used to render the "say why" note Fix
 *  3 requires rather than silently shrinking the option list. */
export function excludedParameterisedTemplateCount(rows: TemplateCatalogRow[]): number {
  return rows.filter(
    (row) => row.status === "APPROVED" && templateHasBodyPlaceholders(row),
  ).length;
}
