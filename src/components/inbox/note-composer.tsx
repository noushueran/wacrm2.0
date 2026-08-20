"use client";

import { useCallback, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { useConvex, useMutation } from "convex/react";
import { StickyNote, Paperclip, X, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import {
  NOTE_KINDS,
  NOTE_OUTCOMES,
  NOTE_ATTACHMENT_MAX_COUNT,
  NOTE_ATTACHMENT_MAX_BYTES,
  noteKindI18nKey,
  noteOutcomeI18nKey,
  type NoteKind,
  type NoteOutcome,
} from "@/lib/inbox/notes";
import { uploadAccountMedia } from "@/lib/storage/upload-media";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

interface StagedAttachment {
  key: string;
  filename: string;
  contentType: string;
  size: number;
}

/**
 * The floating "add note" button and its popover. A popover rather than
 * a modal on purpose: the agent is usually reading the conversation
 * while writing the note, and a modal would hide it.
 *
 * Files upload to R2 as soon as they are picked (staged), so Save is a
 * single fast mutation. An abandoned draft therefore leaks its uploaded
 * objects — accepted: `files.remove` GC is a Phase 2 concern, and a few
 * orphan objects cost less than a Save that hangs on a 25 MB upload.
 */
export function NoteComposer({
  contactId,
  conversationId,
}: {
  contactId: Id<"contacts">;
  conversationId: Id<"conversations">;
}) {
  const t = useTranslations("Inbox.notes");
  const convex = useConvex();
  const startUpload = useMutation(api.files.startUpload);
  const addNote = useMutation(api.contactNotes.add);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [open, setOpen] = useState(false);
  const [body, setBody] = useState("");
  const [kind, setKind] = useState<NoteKind>("call");
  const [outcome, setOutcome] = useState<NoteOutcome | null>(null);
  const [attachments, setAttachments] = useState<StagedAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);

  const handleFiles = useCallback(
    async (files: FileList | null) => {
      if (!files || files.length === 0) return;
      const picked = Array.from(files);

      if (attachments.length + picked.length > NOTE_ATTACHMENT_MAX_COUNT) {
        toast.error(t("tooManyFiles", { max: NOTE_ATTACHMENT_MAX_COUNT }));
        return;
      }
      const tooBig = picked.find((f) => f.size > NOTE_ATTACHMENT_MAX_BYTES);
      if (tooBig) {
        toast.error(
          t("fileTooLarge", {
            name: tooBig.name,
            max: Math.round(NOTE_ATTACHMENT_MAX_BYTES / (1024 * 1024)),
          }),
        );
        return;
      }

      setUploading(true);
      try {
        for (const file of picked) {
          try {
            const { key } = await uploadAccountMedia(
              convex,
              startUpload,
              file,
              "note",
            );
            setAttachments((prev) => [
              ...prev,
              {
                key,
                filename: file.name,
                contentType: file.type || "application/octet-stream",
                size: file.size,
              },
            ]);
          } catch {
            toast.error(t("uploadFailed", { name: file.name }));
          }
        }
      } finally {
        setUploading(false);
        if (fileInputRef.current) fileInputRef.current.value = "";
      }
    },
    [attachments.length, convex, startUpload, t],
  );

  const reset = useCallback(() => {
    setBody("");
    setKind("call");
    setOutcome(null);
    setAttachments([]);
  }, []);

  const handleSave = useCallback(async () => {
    // `uploading` belongs in this guard, not just on the Save button's
    // `disabled` — the textarea's Cmd/Ctrl+Enter shortcut calls this
    // function directly, bypassing the button entirely. Without it, a
    // save that races an in-flight upload fires `addNote` with whatever
    // is in `attachments` at that instant, silently dropping the file
    // still being staged. Keeping the guard here (not in the key
    // handler) means the button and the shortcut can't diverge again.
    if (!body.trim() || saving || uploading) return;

    // Stopping every automated message is a consequential act, so it
    // gets a confirm the other outcomes do not.
    if (outcome === "do_not_contact" && !window.confirm(t("confirmDoNotContact"))) {
      return;
    }

    setSaving(true);
    try {
      await addNote({
        contactId,
        conversationId,
        body: body.trim(),
        kind,
        outcome: outcome ?? undefined,
        attachments: attachments.length > 0 ? attachments : undefined,
      });
      reset();
      setOpen(false);
    } catch {
      toast.error(t("saveFailed"));
    } finally {
      setSaving(false);
    }
  }, [
    addNote,
    attachments,
    body,
    contactId,
    conversationId,
    kind,
    outcome,
    reset,
    saving,
    t,
    uploading,
  ]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      {/* Styled directly rather than wrapped in <Button asChild> —
          `PopoverTrigger` (base-ui) renders its own button and has no
          `asChild` prop; see `note-card.tsx`'s overflow trigger for the
          same pattern. */}
      <PopoverTrigger
        aria-label={t("addNote")}
        className="absolute bottom-4 right-4 z-10 flex h-11 w-11 items-center justify-center rounded-full bg-amber-500 text-white shadow-lg hover:bg-amber-600"
      >
        <StickyNote className="h-5 w-5" />
      </PopoverTrigger>

      <PopoverContent align="end" side="top" className="w-80 p-3">
        <div className="flex flex-wrap gap-1">
          {NOTE_KINDS.map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setKind(k)}
              className={`rounded-full px-2 py-1 text-[11px] ${
                kind === k
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground hover:bg-muted/70"
              }`}
            >
              {t(noteKindI18nKey(k))}
            </button>
          ))}
        </div>

        <div className="mt-2 flex flex-wrap gap-1">
          {NOTE_OUTCOMES.map((o) => (
            <button
              key={o}
              type="button"
              onClick={() => setOutcome(outcome === o ? null : o)}
              className={`rounded-full px-2 py-1 text-[11px] ${
                outcome === o
                  ? o === "do_not_contact"
                    ? "bg-destructive text-destructive-foreground"
                    : "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground hover:bg-muted/70"
              }`}
            >
              {t(noteOutcomeI18nKey(o))}
            </button>
          ))}
        </div>

        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void handleSave();
            }
          }}
          placeholder={t("placeholder")}
          rows={3}
          className="mt-2 w-full resize-none rounded-lg border border-border bg-muted px-3 py-2 text-xs text-foreground placeholder-muted-foreground outline-none focus:border-primary/50"
        />

        {attachments.length > 0 && (
          <div className="mt-2 space-y-1">
            {attachments.map((a) => (
              <div
                key={a.key}
                className="flex items-center gap-1.5 rounded-md bg-muted px-2 py-1 text-[11px]"
              >
                <Paperclip className="h-3 w-3 shrink-0" />
                <span className="flex-1 truncate">{a.filename}</span>
                <button
                  type="button"
                  aria-label={t("removeAttachment", { name: a.filename })}
                  onClick={() =>
                    setAttachments((prev) =>
                      prev.filter((x) => x.key !== a.key),
                    )
                  }
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="mt-2 flex items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => void handleFiles(e.target.files)}
          />
          <Button
            variant="ghost"
            size="sm"
            aria-label={t("attach")}
            disabled={uploading}
            onClick={() => fileInputRef.current?.click()}
          >
            {uploading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Paperclip className="h-3.5 w-3.5" />
            )}
          </Button>
          <Button
            size="sm"
            className="ml-auto"
            disabled={!body.trim() || saving || uploading}
            onClick={() => void handleSave()}
          >
            {t("save")}
          </Button>
        </div>

        <div className="mt-1 text-[11px] text-muted-foreground">
          {t("attachmentNotice")}
        </div>
      </PopoverContent>
    </Popover>
  );
}
