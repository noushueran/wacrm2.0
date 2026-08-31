"use client";

import { useCallback, useMemo, useState } from "react";
import { useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useTranslations } from "next-intl";
import { format } from "date-fns";
import { toast } from "sonner";
import { useQuery } from "@/lib/convex/cached";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import {
  filterActivity,
  groupActivityByDay,
  stageI18nKey,
  type ActivityFilter,
} from "@/lib/inbox/activity";
import { NoteCard, type NoteRow } from "./note-card";
import { Button } from "@/components/ui/button";

type ActivityEntries = FunctionReturnType<typeof api.contactActivity.listForContact>;
type ActivityEntry = ActivityEntries[number];

export interface ContactActivityProps {
  /** `undefined` when no contact is selected — the query is `"skip"`ped
   *  rather than run with a placeholder id. */
  contactId: Id<"contacts"> | undefined;
  /**
   * Per-note, not a single account-wide boolean: a note's own author can
   * always manage it, but only an admin can manage someone else's. The
   * caller computes this exactly as `message-thread.tsx` does —
   * `(!!note.createdByUserId && note.createdByUserId === user?.id) ||
   * hasMinRole(accountRole, "admin")` — mirroring the server's own
   * `requireAuthorOrAdmin`, so this component never offers a Delete the
   * server will reject.
   */
  canManageNote: (note: NoteRow) => boolean;
}

/**
 * The contact panel's numbered "everything that has happened with this
 * customer" feed (spec Phase 2, Task 5). Unlike `ContactStatusHeader`
 * (Task 3), this component owns its own query — `api.contactActivity.
 * listForContact` already merges notes and non-terminal funnel-stage
 * moves server-side (see that module's header comment for why it is
 * NOT a five-source merge), so there is nothing left for a caller to
 * pre-resolve.
 *
 * Numbering is 1..n across the WHOLE unfiltered list, newest first, and
 * does not restart per day group or change with the All/Notes-only
 * toggle — the numbers are a stable reference ("see note 7" in a
 * handover), and a per-group restart or per-filter renumbering would
 * both break that.
 *
 * Notes render through the existing `NoteCard` (never a second
 * renderer). `onEdit` is deliberately omitted — see that component's
 * own doc comment: there is no edit UI yet, and a supplied-but-absent
 * handler produced a silently no-op menu item that an earlier review
 * caught.
 */
export function ContactActivity({ contactId, canManageNote }: ContactActivityProps) {
  const t = useTranslations("Inbox.activity");
  const tNotes = useTranslations("Inbox.notes");
  const [filter, setFilter] = useState<ActivityFilter>("all");

  const entries = useQuery(
    api.contactActivity.listForContact,
    contactId ? { contactId } : "skip",
  );

  const removeNoteMutation = useMutation(api.contactNotes.remove);
  // Mirrors `message-thread.tsx`'s `handleDeleteNote` — same mutation,
  // same failure toast — so a delete behaves identically whether it was
  // triggered from the thread or from this feed.
  const handleDeleteNote = useCallback(
    async (noteId: string) => {
      try {
        await removeNoteMutation({ noteId: noteId as Id<"contactNotes"> });
      } catch {
        toast.error(tNotes("deleteFailed"));
      }
    },
    [removeNoteMutation, tNotes],
  );

  // Number the UNFILTERED list first, then filter — the numbers exist so
  // an agent can write "see note 7" in a handover, and a reference that
  // changes when someone toggles "Notes only" is not a reference. An
  // earlier version numbered the filtered list, so the same note read
  // "#7" under All and "#3" under Notes only; numbering before filtering
  // fixes that. The Notes-only view will show sparse numbers (1, 3, 4,
  // 7…) — that's correct: the gaps signal that other events are hidden
  // by the filter, not that anything is missing.
  //
  // Oldest = 1, counting DOWN as the list runs newest-first: the
  // opposite (newest = 1) would renumber every existing entry the
  // moment a new one lands, so "see note 3" in a handover would point
  // at a different note the next day. Counting down from the total
  // still answers "how many things have happened" at a glance (the
  // top-most number IS the count) while keeping every entry's number
  // stable as new ones arrive above it.
  const numbered = useMemo(() => {
    const allEntries = entries ?? [];
    return allEntries.map((entry, index) => ({
      ...entry,
      number: allEntries.length - index,
    }));
  }, [entries]);
  const filtered = useMemo(
    () => filterActivity(numbered, filter),
    [numbered, filter],
  );
  const groups = useMemo(() => groupActivityByDay(filtered), [filtered]);

  const isLoading = entries === undefined;

  return (
    <div>
      {/* No section heading here: `ContactCollapsibleSection` wraps this
          block and draws its own, so a `SectionLabel` would render
          "Activity" twice. The filters stay, right-aligned. */}
      <div className="flex items-center justify-end gap-2">
        <div className="flex items-center gap-1">
          <Button
            type="button"
            size="xs"
            variant={filter === "all" ? "secondary" : "ghost"}
            onClick={() => setFilter("all")}
          >
            {t("filterAll")}
          </Button>
          <Button
            type="button"
            size="xs"
            variant={filter === "notes" ? "secondary" : "ghost"}
            onClick={() => setFilter("notes")}
          >
            {t("filterNotes")}
          </Button>
        </div>
      </div>

      <div className="mt-2 space-y-3">
        {!isLoading && groups.length === 0 && (
          <p className="px-1 text-xs text-muted-foreground">{t("empty")}</p>
        )}

        {groups.map((group) => (
          <div key={group.day}>
            {/* Format from an entry's own `at`, not `group.day` — `day` is
                a local-calendar-day grouping key (see `groupActivityByDay`'s
                doc comment), and a bare `new Date("YYYY-MM-DD")` parses as
                UTC midnight, which would put the header back out of sync
                with the local-time rows underneath it. Every entry in the
                group shares the same local day by construction, so any of
                them gives the right header. */}
            <div className="mb-1.5 px-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              {format(new Date(group.entries[0].at), "MMMM d, yyyy")}
            </div>
            <div className="space-y-2">
              {group.entries.map((entry) =>
                entry.kind === "note" ? (
                  <NoteEntry
                    key={entry.note._id}
                    number={entry.number}
                    note={entry.note}
                    canManage={canManageNote(entry.note)}
                    onDelete={handleDeleteNote}
                  />
                ) : (
                  <StageEntry key={`${entry.at}-${entry.number}`} entry={entry} />
                ),
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function NoteEntry({
  number,
  note,
  canManage,
  onDelete,
}: {
  number: number;
  note: NoteRow;
  canManage: boolean;
  onDelete: (id: string) => void;
}) {
  return (
    <div className="flex items-start gap-2">
      <span className="mt-2 w-4 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">
        {number}
      </span>
      <div className="min-w-0 flex-1">
        {/* `onEdit` intentionally omitted — Phase 2 builds the edit UI;
            `NoteCard` only renders the Edit menu item when a handler is
            passed. `fullWidth` drops the message-thread centering that
            reads as an oddly indented card next to the number column
            here — see `NoteCard`'s own doc comment. */}
        <NoteCard note={note} canManage={canManage} onDelete={onDelete} fullWidth />
      </div>
    </div>
  );
}

function StageEntry({
  entry,
}: {
  entry: Extract<ActivityEntry, { kind: "stage" }> & { number: number };
}) {
  const t = useTranslations("Inbox.activity");
  // Same unattributed-author fallback `NoteCard` uses for a system note
  // (`note.author?.fullName ?? t("systemAuthor")`) — reached only if a
  // non-auto transition somehow has no resolved `byUserId`, which
  // shouldn't happen in practice but keeps the line from reading blank.
  const tNotes = useTranslations("Inbox.notes");

  return (
    <div className="flex items-center gap-2 px-1 text-xs text-muted-foreground">
      <span className="w-4 shrink-0 text-right text-[11px] tabular-nums">
        {entry.number}
      </span>
      <span className="min-w-0 flex-1 truncate text-foreground">
        {t("stageMoved", { stage: t(stageI18nKey(entry.stage)) })}
      </span>
      <span aria-hidden="true" className="shrink-0">
        ·
      </span>
      {/* The stage label above is the primary content and gets `flex-1`;
          the author only needs `shrink-0` + a `max-w-` cap so a long stage
          label ("Stage → Itinerary created") doesn't lose its truncation
          budget to a short one splitting the row 50/50 with it. `min-w-0`
          is still required alongside `shrink-0` + `max-w-`: a flex item's
          default `min-width: auto` floors it at its content's un-truncated
          width, which would otherwise push past `max-w-` instead of
          truncating. */}
      <span className="min-w-0 max-w-[8rem] shrink-0 truncate">
        {entry.auto
          ? t("autoStage")
          : entry.author?.fullName ?? tNotes("systemAuthor")}
      </span>
      <span className="shrink-0">
        {format(new Date(entry.at), "MMM d, HH:mm")}
      </span>
    </div>
  );
}
