// ============================================================
// Selection arithmetic for the Lead Analysis workspace — pure, so it
// can be tested in a repo with no jsdom (component tests here assert on
// static markup and cannot simulate a click).
//
// Takes the structural minimum `{ conversationId }` rather than the full
// `LeadAnalysisRow`, so the list component can evolve without dragging
// this module along.
// ============================================================

/**
 * Where selection lands after a lead is archived.
 *
 * Called with the rows AS THEY STOOD AT CLICK TIME — not after the
 * reactive update lands. The board is a live query and archiving
 * re-sorts it; choosing from the post-update list would race that
 * re-sort and land somewhere arbitrary.
 *
 * With server-side paging those rows are ONE PAGE, not the whole board,
 * and this function deliberately stays inside it: archiving the last row
 * on a page falls back to the row above rather than pulling the page
 * forward, and archiving the only row on a page clears the selection.
 * Advancing across a page boundary would mean this pure function
 * reaching into page state and issuing a fetch — and the page it would
 * jump to is re-derived server-side the moment the archive lands, so the
 * "next" row it picked could be a different lead by the time it arrived.
 *
 * Archiving a lead that isn't the selected one never moves selection.
 */
export function nextSelectionAfterArchive(
  rows: readonly { conversationId: string }[],
  archivedConversationId: string,
  selectedConversationId: string | null,
): string | null {
  if (selectedConversationId === null) return null;
  if (archivedConversationId !== selectedConversationId) {
    return selectedConversationId;
  }

  const index = rows.findIndex((r) => r.conversationId === archivedConversationId);
  // Archived row already gone from the list (a concurrent update, or a
  // filter that excludes it) — there is no meaningful neighbour to pick.
  if (index === -1) return null;

  const next = rows[index + 1] ?? rows[index - 1] ?? null;
  return next?.conversationId ?? null;
}
