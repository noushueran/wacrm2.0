// ============================================================
// Archive vocabulary. Pure — no I/O, no Date.now().
//
// `archivedReason` is stored as a plain string on `conversations` (the
// schema keeps it a `v.optional(v.string())` so a future reason is a
// code change rather than a schema migration, exactly as
// `apiKeys.scopes` and `automations.triggerType` are handled). That
// makes THIS module the actual enforcement point, so validation lives
// here and every writer routes through it.
// ============================================================

export const ARCHIVE_REASONS = [
  /** A human archived it by hand (P2's only path). */
  "manual",
  /** The follow-up sequence exhausted its steps (P3). */
  "no_response",
  /** Older than `agedOutDays` and never scored (P3). */
  "aged_out",
  /** Not a sales conversation at all. */
  "not_a_lead",
] as const;

export type ArchiveReason = (typeof ARCHIVE_REASONS)[number];

export const ARCHIVE_REASON_MAX_NOTE = 200;

export function isArchiveReason(value: unknown): value is ArchiveReason {
  return (
    typeof value === "string" &&
    (ARCHIVE_REASONS as readonly string[]).includes(value)
  );
}

/**
 * Optional free-text note attached to a manual archive. Trimmed,
 * truncated, and collapsed to `undefined` when empty — so an empty
 * textarea never persists as `""`.
 */
export function normalizeArchiveNote(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  return trimmed.slice(0, ARCHIVE_REASON_MAX_NOTE);
}

/**
 * The value every INSERT into `leadAnalyses` must give its `archived`
 * field, derived from the conversation's own `archivedAt` — never a bare
 * `undefined` (silently claims "active" for an archived conversation) and
 * never `false` (see the SYNC INVARIANT / REPRESENTATION comments on
 * `leadAnalyses.archived` in schema.ts: `false` would split active rows
 * across two index values on `by_account_archived_score`).
 *
 * `leadAnalysis.ts`'s `archiveConversationCore` (called by `archive` and
 * the automated `archiveAutomated`), plus `leadAnalysis.restore` and
 * `conversations.unarchiveOnInbound`, remain the only WRITERS of an
 * existing row's `archived` field post-insert — this helper only seeds
 * the value at creation time, at each of the three sites that insert a
 * `leadAnalyses` row
 * (`leadAnalysis.reanalyze`, `leadAnalysisEngine.onInbound`,
 * `leadAnalysisEngine.backfillAccount`). A future fourth insert site must
 * use this too.
 */
export function archivedForInsert(conversation: { archivedAt?: number }): true | undefined {
  return conversation.archivedAt !== undefined ? true : undefined;
}
