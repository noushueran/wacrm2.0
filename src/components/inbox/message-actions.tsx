"use client";

import { useState, type ReactNode } from "react";
import { CornerUpLeft, Copy, SmilePlus, Download } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import type { Message } from "@/types";
import { useTranslations } from "next-intl";
import { useMediaDownload } from "./use-media-download";
import type { MediaKind } from "@/lib/media/download";

// WhatsApp's own quick-reaction bar starts with these six. Picking the same
// set keeps the affordance familiar without pulling in a 300KB emoji library.
const QUICK_EMOJIS = ["👍", "❤️", "😂", "😮", "😢", "🙏"];

/** Content types that carry a file worth saving. Audio is deliberately
 *  absent: a voice note is played in place and already carries its own
 *  transcript, so a download control would be noise. */
const DOWNLOADABLE_TYPES = new Set<string>(["image", "video", "document"]);

function downloadKind(message: Message): MediaKind | null {
  if (!message.media_url) return null;
  return DOWNLOADABLE_TYPES.has(message.content_type)
    ? (message.content_type as MediaKind)
    : null;
}

interface MessageActionsProps {
  message: Message;
  onReply: () => void;
  onReact: (emoji: string) => void;
  /** When false (viewer role), the add-reaction button is hidden — adding
   *  a reaction (onReact → reactions.set) requires requireRole("agent")
   *  server-side, so a viewer could never react. Defaults to true. */
  canReact?: boolean;
  children: ReactNode;
}

/**
 * Hover/long-press toolbar wrapper around a `<MessageBubble>`. The bubble
 * itself stays a pure presenter — this component owns the action surface so
 * the bubble's render path is unaffected when the toolbar isn't visible.
 */
export function MessageActions({
  message,
  onReply,
  onReact,
  canReact = true,
  children,
}: MessageActionsProps) {
  const t = useTranslations("Inbox.actions");
  // Media copy lives in the bubble's namespace so the bubble's own
  // download controls and this one share one set of strings.
  const tMedia = useTranslations("Inbox.bubble");
  const { download, pending: downloadPending } = useMediaDownload({
    failed: tMedia("downloadFailed"),
    openInTab: tMedia("openInTab"),
  });
  const mediaKind = downloadKind(message);

  // Touch devices have no hover. Long-press fires `contextmenu`; we capture
  // it, suppress the native menu, and pin the toolbar open until the user
  // interacts elsewhere.
  const [touchOpen, setTouchOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);

  const isAgent =
    message.sender_type === "agent" || message.sender_type === "bot";

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    setTouchOpen(true);
  };

  const handleCopy = async () => {
    const text = message.content_text ?? "";
    if (!text) {
      toast.error(t("nothingToCopy"));
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      toast.success(t("copied"));
    } catch {
      toast.error(t("copyFailed"));
    }
    setTouchOpen(false);
  };

  const handlePickEmoji = (emoji: string) => {
    onReact(emoji);
    setPickerOpen(false);
    setTouchOpen(false);
  };

  const handleReply = () => {
    onReply();
    setTouchOpen(false);
  };

  const handleDownload = () => {
    if (!mediaKind || !message.media_url) return;
    void download({
      kind: mediaKind,
      url: message.media_url,
      createdAt: message.created_at,
      documentName: mediaKind === "document" ? message.content_text : null,
    });
    setTouchOpen(false);
  };

  // Row alignment lives here (not in MessageBubble) so the `group/actions`
  // hover region matches the bubble's content width — hovering empty space
  // in the row no longer reveals the toolbar.
  return (
    <div
      className={cn(
        "flex w-full",
        isAgent ? "justify-end" : "justify-start",
      )}
      onContextMenu={handleContextMenu}
      onBlur={() => setTouchOpen(false)}
    >
      {/* `min-w-0` lets this flex child actually respect the 75% cap.
       *  Default `min-width: auto` lets content (a long quote preview,
       *  an unbroken URL) push past the cap and shove the row past
       *  100%, which used to bleed across into the contact-sidebar
       *  area. See issue #165. */}
      <div className="group/actions relative min-w-0 max-w-[75%]">
        {children}
      <div
        data-touch-open={touchOpen || pickerOpen ? "true" : undefined}
        className={cn(
          "absolute -top-3 z-10 flex h-7 items-center gap-0.5 rounded-full border border-border bg-popover/95 px-1 shadow-md backdrop-blur-sm transition-opacity",
          "opacity-0 group-hover/actions:opacity-100 group-focus-within/actions:opacity-100",
          "data-[touch-open=true]:opacity-100",
          isAgent ? "right-3" : "left-3",
        )}
      >
        {/* Add-reaction button — hidden for viewers. Adding a reaction
            (onReact → postReaction → reactions.set) requires
            requireRole("agent") server-side, so a viewer could never
            react; hide the affordance rather than surface a control that
            only errors. Existing reactions still render read-only via
            <MessageReactions>. Reply/Copy below stay available. */}
        {canReact && (
          <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
            <PopoverTrigger
              className="flex h-5 w-5 items-center justify-center rounded-full text-popover-foreground hover:bg-muted hover:text-foreground"
              aria-label={t("react")}
            >
              <SmilePlus className="h-3.5 w-3.5" />
            </PopoverTrigger>
            <PopoverContent
              className="flex w-auto flex-row gap-1 p-1.5"
              sideOffset={6}
            >
              {QUICK_EMOJIS.map((e) => (
                <button
                  key={e}
                  type="button"
                  onClick={() => handlePickEmoji(e)}
                  className="flex h-8 w-8 items-center justify-center rounded-full text-lg leading-none transition-transform hover:scale-125 hover:bg-muted"
                  aria-label={t("reactWith", { emoji: e })}
                >
                  {e}
                </button>
              ))}
            </PopoverContent>
          </Popover>
        )}
        <button
          type="button"
          onClick={handleReply}
          className="flex h-5 w-5 items-center justify-center rounded-full text-popover-foreground hover:bg-muted hover:text-foreground"
          aria-label={t("reply")}
        >
          <CornerUpLeft className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={handleCopy}
          className="flex h-5 w-5 items-center justify-center rounded-full text-popover-foreground hover:bg-muted hover:text-foreground"
          aria-label={t("copyText")}
        >
          <Copy className="h-3.5 w-3.5" />
        </button>
        {mediaKind && (
          <button
            type="button"
            onClick={handleDownload}
            disabled={downloadPending}
            className="flex h-5 w-5 items-center justify-center rounded-full text-popover-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
            aria-label={tMedia("download")}
          >
            <Download className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      </div>
    </div>
  );
}
