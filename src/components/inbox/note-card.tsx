"use client";

import { useTranslations } from "next-intl";
import { format } from "date-fns";
import {
  Phone,
  MessageCircle,
  Users,
  Mail,
  Banknote,
  StickyNote,
  Settings2,
  Lock,
  Paperclip,
  MoreVertical,
} from "lucide-react";
import {
  noteKindOf,
  noteKindI18nKey,
  noteOutcomeI18nKey,
  formatAttachmentSize,
  type DisplayNoteKind,
  type NoteKind,
  type NoteOutcome,
} from "@/lib/inbox/notes";
import { mediaUrlFromKey } from "@/lib/storage/media-url";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export interface NoteAttachment {
  key: string;
  filename: string;
  contentType: string;
  size: number;
}

export interface NoteRow {
  _id: string;
  _creationTime: number;
  noteText: string;
  kind?: NoteKind;
  outcome?: NoteOutcome;
  attachments?: NoteAttachment[];
  editedAt?: number;
  outcomeClearedAt?: number;
  createdByUserId?: string;
  author: { userId: string; fullName?: string; avatarUrl?: string } | null;
}

const ICON_BY_KIND: Record<DisplayNoteKind, typeof Phone> = {
  call: Phone,
  whatsapp_external: MessageCircle,
  meeting: Users,
  email: Mail,
  payment: Banknote,
  general: StickyNote,
  system: Settings2,
};

/**
 * One internal note. Rendered full-width and centred, NEVER as a
 * left/right chat bubble — an agent must never be able to mistake a note
 * for something the customer received. (It cannot be: notes live in a
 * different table from `messages`, and the Meta send path reads only
 * `messages`. The visual distinction exists so the reader knows that.)
 */
export function NoteCard({
  note,
  canManage,
  onEdit,
  onDelete,
  fullWidth = false,
}: {
  note: NoteRow;
  canManage: boolean;
  /**
   * Optional on purpose: there is no edit UI yet (Phase 2). When omitted,
   * the Edit menu item is not rendered at all — a supplied-but-absent
   * handler would produce a menu item that silently no-ops, which is the
   * exact defect an earlier review caught. An item that isn't rendered
   * cannot no-op.
   */
  onEdit?: (id: string) => void;
  onDelete: (id: string) => void;
  /**
   * Drop the `mx-auto max-w-[85%]` centering below — that sizing assumes
   * the wide message thread, where a note narrower than a full chat
   * column is what reads as "different from a message". Inside the
   * narrow contact-panel sidebar (`ContactActivity`, Task 6 of
   * conversation-notes-p2), 85% of an already-narrow column centered
   * next to the entry's number reads as an oddly indented card instead,
   * so that caller passes `true` to use the full column width. Defaults
   * to `false` so `message-thread.tsx`'s rendering is unchanged.
   */
  fullWidth?: boolean;
}) {
  const t = useTranslations("Inbox.notes");
  const kind = noteKindOf(note);
  const Icon = ICON_BY_KIND[kind];
  // A `do_not_contact` outcome is only an ACTIVE block while
  // `outcomeClearedAt` is unset — a supervisor override leaves the
  // outcome itself untouched (it's the audit record of what the
  // customer said) but must stop the card from reading as a live
  // block. See `clearDoNotContact` in `convex/contactNotes.ts`.
  const isCleared = note.outcomeClearedAt != null;
  const isDoNotContact = note.outcome === "do_not_contact" && !isCleared;

  return (
    <div
      className={`${fullWidth ? "w-full" : "mx-auto w-full max-w-[85%]"} rounded-lg border border-dashed px-3 py-2 ${
        isDoNotContact
          ? "border-destructive/50 bg-destructive/5"
          : "border-amber-500/40 bg-amber-500/5"
      }`}
    >
      <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
        <Lock className="h-3 w-3 shrink-0" />
        <span className="uppercase tracking-wider">{t("internal")}</span>
        <span className="inline-flex items-center gap-1 rounded-full bg-muted px-1.5 py-0.5">
          <Icon className="h-3 w-3" />
          {t(noteKindI18nKey(kind))}
        </span>
        {note.outcome && (
          <span
            className={`rounded-full px-1.5 py-0.5 ${
              isDoNotContact
                ? "bg-destructive/15 text-destructive"
                : "bg-muted"
            }`}
          >
            <span className={isCleared ? "line-through" : ""}>
              {t(noteOutcomeI18nKey(note.outcome))}
            </span>
            {isCleared && (
              <span className="ml-1 text-muted-foreground">
                ({t("cleared")})
              </span>
            )}
          </span>
        )}
        <span className="ml-auto shrink-0">
          {format(new Date(note._creationTime), "MMM d, HH:mm")}
        </span>
        {canManage && (
          <DropdownMenu>
            {/* Styled directly rather than wrapped in <Button asChild> —
                `DropdownMenuTrigger` (base-ui) renders its own button and
                has no `asChild` prop; see `message-thread.tsx`'s
                thread-level overflow trigger for the same pattern. */}
            <DropdownMenuTrigger
              aria-label={t("more")}
              className="inline-flex h-5 w-5 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <MoreVertical className="h-3 w-3" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {onEdit && (
                <DropdownMenuItem onClick={() => onEdit(note._id)}>
                  {t("edit")}
                </DropdownMenuItem>
              )}
              <DropdownMenuItem
                className="text-destructive"
                onClick={() => onDelete(note._id)}
              >
                {t("delete")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      <p className="mt-1.5 whitespace-pre-wrap text-xs text-foreground">
        {note.noteText}
      </p>

      {note.attachments && note.attachments.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {note.attachments.map((attachment) => (
            <NoteAttachmentChip key={attachment.key} attachment={attachment} />
          ))}
        </div>
      )}

      <p className="mt-1.5 text-[11px] text-muted-foreground">
        {note.author?.fullName ?? t("systemAuthor")}
        {note.editedAt ? ` · ${t("edited")}` : ""}
      </p>
    </div>
  );
}

function NoteAttachmentChip({ attachment }: { attachment: NoteAttachment }) {
  const url = mediaUrlFromKey(attachment.key);
  const isImage = attachment.contentType.startsWith("image/");

  if (!url) return null;

  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2 py-1 text-[11px] text-foreground hover:bg-muted"
    >
      {isImage ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={url}
          alt={attachment.filename}
          className="h-6 w-6 rounded object-cover"
        />
      ) : (
        <Paperclip className="h-3 w-3" />
      )}
      <span className="max-w-[10rem] truncate">{attachment.filename}</span>
      <span className="shrink-0 text-muted-foreground">
        {formatAttachmentSize(attachment.size)}
      </span>
    </a>
  );
}
