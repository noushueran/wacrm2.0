"use client";

import { useState, useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import { downloadHrefFor, filenameFor } from "@/lib/media/download";
import type { ContactsPayloadEntry, Message, MessageReaction } from "@/types";
import {
  Clock,
  Check,
  CheckCheck,
  XCircle,
  FileText,
  MapPin,
  LayoutTemplate,
  ImageOff,
  CornerDownLeft,
  Sparkles,
  Phone,
  Mail,
  Globe,
  Download,
  Maximize2,
} from "lucide-react";
import { format } from "date-fns";
import { ReplyQuote } from "./reply-quote";
import { MessageReactions } from "./message-reactions";
import { AdReferralCard } from "./ad-referral-card";
import { VoiceTranscript } from "./voice-transcript";
import { MediaLightbox } from "./media-lightbox";
import { InteractivePreview } from "@/components/interactive/interactive-preview";
import { useTranslations } from "next-intl";

interface MessageBubbleProps {
  message: Message;
  /** Pre-computed quote info for messages that reply to another. */
  reply?: { authorLabel: string; preview: string } | null;
  reactions?: MessageReaction[];
  currentUserId?: string;
  onToggleReaction?: (emoji: string) => void;
  /** When false (viewer role), reaction pills render read-only (still
   *  shown, not clickable) — passed through to <MessageReactions>.
   *  Defaults to true. */
  canReact?: boolean;
}

function StatusIcon({ status }: { status: Message["status"] }) {
  switch (status) {
    case "sending":
      return <Clock className="h-3 w-3 text-muted-foreground" />;
    case "sent":
      return <Check className="h-3 w-3 text-muted-foreground" />;
    case "delivered":
      return <CheckCheck className="h-3 w-3 text-muted-foreground" />;
    case "read":
      return <CheckCheck className="h-3 w-3 text-blue-400" />;
    case "failed":
      return <XCircle className="h-3 w-3 text-red-400" />;
    default:
      return null;
  }
}

function MediaUnavailable({ label, t }: { label: string, t: ReturnType<typeof useTranslations> }) {
  return (
    <div className="flex items-center gap-2 rounded-lg bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
      <ImageOff className="h-4 w-4 shrink-0 text-muted-foreground" />
      <span>{t("unavailable", { label })}</span>
    </div>
  );
}

/**
 * Save control for a media bubble.
 *
 * `href` comes from `downloadHrefFor`, which routes cross-origin media
 * through `/api/media/download` — the `download` attribute below is
 * IGNORED by browsers on a cross-origin url, so without that indirection
 * this button would just navigate to the file.
 */
function MediaDownloadButton({
  href,
  filename,
  label,
  className,
}: {
  href: string;
  filename: string;
  label: string;
  className?: string;
}) {
  return (
    <a
      href={href}
      download={filename}
      title={label}
      aria-label={label}
      className={cn(
        "inline-flex items-center justify-center rounded-md bg-black/55 p-1.5 text-white backdrop-blur-sm transition-colors hover:bg-black/75 focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:outline-none",
        className,
      )}
    >
      <Download className="h-3.5 w-3.5" />
    </a>
  );
}

/** Corner overlay controls, revealed when the media is hovered or focused. */
const OVERLAY_CONTROL =
  "opacity-0 transition-opacity group-hover/media:opacity-100 group-focus-within/media:opacity-100";

function MediaImage({
  url,
  alt,
  message,
  t,
}: {
  url: string;
  alt: string;
  message: Message;
  t: ReturnType<typeof useTranslations>;
}) {
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [zoomed, setZoomed] = useState(false);
  // The blob url must be revoked through a ref, not through `src`. The old
  // cleanup closed over the render in which the effect ran, where `src` was
  // still null — so it never revoked anything and every proxied image leaked
  // for the life of the page.
  const blobUrlRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setSrc(null);
    setError(false);
    setLoading(true);

    async function load() {
      if (!url) return;

      // Proxy URLs need auth fetch to create blob URL
      if (url.startsWith("/api/whatsapp/media/")) {
        try {
          const res = await fetch(url);
          if (!res.ok) throw new Error("Failed to load media");
          const blob = await res.blob();
          if (cancelled) return;
          const blobUrl = URL.createObjectURL(blob);
          blobUrlRef.current = blobUrl;
          setSrc(blobUrl);
        } catch {
          if (!cancelled) setError(true);
        } finally {
          if (!cancelled) setLoading(false);
        }
      } else {
        setSrc(url);
        setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = null;
      }
    };
  }, [url]);

  if (error) {
    return (
      <div className="flex h-40 w-60 items-center justify-center rounded-lg bg-muted">
        <ImageOff className="h-8 w-8 text-muted-foreground" />
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex h-40 w-60 items-center justify-center rounded-lg bg-muted">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  const filename = filenameFor(message);
  const downloadHref = message.media_url
    ? downloadHrefFor(message.media_url, filename)
    : null;

  return (
    <>
      <div className="group/media relative w-fit">
        <button
          type="button"
          onClick={() => setZoomed(true)}
          aria-label={t("viewImage")}
          className="block cursor-zoom-in rounded-lg focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          {/* `object-contain` is a safeguard, not the fix. With only
              `max-*` constraints and no fixed dimensions the box already
              takes the image's own aspect ratio, so `cover` and `contain`
              render identically today (measured: both 76.8×256 for a
              600×2000 banner). `contain` states the intent and stays
              correct if this ever gains explicit width/height, where
              `cover` WOULD start cropping. What actually made a tall
              banner unreadable is the thumbnail size itself — 77px wide
              here — which is what the lightbox below exists to solve. */}
          <img
            src={src ?? ""}
            alt={alt}
            className="max-h-64 max-w-60 rounded-lg object-contain"
            onError={() => setError(true)}
          />
        </button>
        {downloadHref && (
          <MediaDownloadButton
            href={downloadHref}
            filename={filename}
            label={t("download")}
            className={cn("absolute top-1.5 right-1.5", OVERLAY_CONTROL)}
          />
        )}
      </div>
      {src && (
        <MediaLightbox
          open={zoomed}
          onOpenChange={setZoomed}
          kind="image"
          src={src}
          alt={alt}
          title={alt}
          // Falls back to the displayed source (a blob url for proxied
          // media) when the message carries no resolvable media url.
          downloadHref={downloadHref ?? src}
          filename={filename}
          downloadLabel={t("download")}
          closeLabel={t("closeViewer")}
        />
      )}
    </>
  );
}

/**
 * Video bubble. The inline player keeps its native controls, so enlarging
 * is an explicit corner button rather than a click on the video itself —
 * clicking the frame belongs to play/pause.
 */
function MediaVideo({
  url,
  message,
  t,
}: {
  url: string;
  message: Message;
  t: ReturnType<typeof useTranslations>;
}) {
  const [zoomed, setZoomed] = useState(false);
  const inlineRef = useRef<HTMLVideoElement>(null);
  const filename = filenameFor(message);
  const downloadHref = downloadHrefFor(url, filename);

  // The lightbox mounts a SECOND player on the same source. Without this the
  // inline one keeps playing behind the backdrop and the agent hears both.
  function openZoomed() {
    inlineRef.current?.pause();
    setZoomed(true);
  }

  return (
    <>
      <div className="group/media relative w-fit">
        <video
          ref={inlineRef}
          src={url}
          controls
          className="max-h-64 max-w-60 rounded-lg"
        />
        <div
          className={cn(
            "absolute top-1.5 right-1.5 flex items-center gap-1",
            OVERLAY_CONTROL,
          )}
        >
          <button
            type="button"
            onClick={openZoomed}
            title={t("viewVideo")}
            aria-label={t("viewVideo")}
            className="inline-flex items-center justify-center rounded-md bg-black/55 p-1.5 text-white backdrop-blur-sm transition-colors hover:bg-black/75 focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:outline-none"
          >
            <Maximize2 className="h-3.5 w-3.5" />
          </button>
          <MediaDownloadButton
            href={downloadHref}
            filename={filename}
            label={t("download")}
          />
        </div>
      </div>
      <MediaLightbox
        open={zoomed}
        onOpenChange={setZoomed}
        kind="video"
        src={url}
        alt={t("video")}
        title={t("video")}
        downloadHref={downloadHref}
        filename={filename}
        downloadLabel={t("download")}
        closeLabel={t("closeViewer")}
      />
    </>
  );
}

function MessageContent({ message, t, isAgent }: { message: Message, t: ReturnType<typeof useTranslations>, isAgent: boolean }) {
  const body = <MessageContentBody message={message} t={t} isAgent={isAgent} />;
  if (!message.referral) return body;
  return (
    <>
      <AdReferralCard referral={message.referral} />
      {body}
    </>
  );
}

export function MessageContentBody({ message, t, isAgent }: { message: Message, t: ReturnType<typeof useTranslations>, isAgent: boolean }) {
  switch (message.content_type) {
    case "text":
      return (
        <p className="whitespace-pre-wrap break-words text-sm">
          {message.content_text}
        </p>
      );

    case "image":
      return (
        <div>
          {message.media_url ? (
            <MediaImage
              url={message.media_url}
              alt="Shared image"
              message={message}
              t={t}
            />
          ) : (
            <MediaUnavailable label={t("photo")} t={t} />
          )}
          {message.content_text && (
            <p className="mt-1 whitespace-pre-wrap break-words text-sm">
              {message.content_text}
            </p>
          )}
        </div>
      );

    case "video":
      return (
        <div>
          {message.media_url ? (
            <MediaVideo url={message.media_url} message={message} t={t} />
          ) : (
            <MediaUnavailable label={t("video")} t={t} />
          )}
          {message.content_text && (
            <p className="mt-1 whitespace-pre-wrap break-words text-sm">
              {message.content_text}
            </p>
          )}
        </div>
      );

    case "audio":
      return (
        <div>
          {message.media_url ? (
            <div className="flex items-center gap-1.5">
              <audio src={message.media_url} controls className="max-w-60" />
              <MediaDownloadButton
                href={downloadHrefFor(message.media_url, filenameFor(message))}
                filename={filenameFor(message)}
                label={t("download")}
                className="shrink-0 bg-foreground/10 text-foreground hover:bg-foreground/20"
              />
            </div>
          ) : (
            <MediaUnavailable label={t("audio")} t={t} />
          )}
          {/* Whisper already transcribed this on the way in (see
              `convex/aiReply.ts`); until now only the bot could read
              it. Audio only — the same column holds image
              descriptions, which stay hidden by design. */}
          {message.ai_transcription && (
            <VoiceTranscript
              text={message.ai_transcription}
              label={t("aiTranscript")}
              labelTitle={t("aiTranscriptTitle")}
              moreLabel={t("transcriptShowMore")}
              lessLabel={t("transcriptShowLess")}
            />
          )}
        </div>
      );

    case "document": {
      if (!message.media_url) {
        return <MediaUnavailable label={message.content_text || t("document")} t={t} />;
      }
      // The row is the download. It used to `target="_blank"` straight at
      // the media url, which — being cross-origin — opened the file in a
      // tab instead of saving it, leaving no way to get the file at all.
      const filename = filenameFor(message);
      return (
        <a
          href={downloadHrefFor(message.media_url, filename)}
          download={filename}
          className="flex items-center gap-2 rounded-lg bg-muted/50 px-3 py-2 text-sm hover:bg-muted"
        >
          <FileText className="h-5 w-5 shrink-0 text-muted-foreground" />
          <span className="truncate">
            {message.content_text || t("document")}
          </span>
          <Download className="h-4 w-4 shrink-0 text-muted-foreground" />
        </a>
      );
    }

    case "template":
      return (
        <div>
          <span
            className={cn(
              "mb-1 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium",
              // Outbound bubbles are filled with `bg-primary`, so the old
              // `bg-primary/20 text-primary` badge was purple-on-purple and
              // invisible — the reason a body-less template message rendered
              // as a fully blank bubble. Theme the pill to its bubble so it
              // always reads (and a template message is never blank).
              isAgent
                ? "bg-primary-foreground/20 text-primary-foreground"
                : "bg-primary/20 text-primary",
            )}
          >
            <LayoutTemplate className="h-3 w-3" />
            {t("template")}
          </span>
          {message.content_text && (
            <p className="mt-1 whitespace-pre-wrap break-words text-sm">
              {message.content_text}
            </p>
          )}
        </div>
      );

    case "location":
      return (
        <div className="flex items-center gap-2 text-sm">
          <MapPin className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span>{message.content_text || t("locationShared")}</span>
        </div>
      );

    case "interactive": {
      // Three cases share content_type='interactive':
      //  - OUTBOUND with payload (composer / automation / Flow send after
      //    migration 035): render the buttons/list as they appear on the phone.
      //  - INBOUND tap (customer chose an option, sender_type='customer'):
      //    no payload; show the tapped option's title with a reply affordance
      //    so agents can tell it's a tap, not the customer typing.
      //  - OUTBOUND with NO payload (legacy bot/Flow sends from before
      //    migration 035 backfilled the column): show the body text plainly —
      //    it is our own message, NOT a customer tap.
      if (message.interactive_payload) {
        return <InteractivePreview payload={message.interactive_payload} />;
      }
      if (message.sender_type === "customer") {
        return (
          <div className="flex flex-col gap-0.5">
            <span className="inline-flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              <CornerDownLeft className="h-3 w-3" />
              {t("buttonReply")}
            </span>
            <p className="whitespace-pre-wrap break-words text-sm">
              {message.content_text || t("interactiveReply")}
            </p>
          </div>
        );
      }
      return (
        <p className="whitespace-pre-wrap break-words text-sm">
          {message.content_text || t("interactiveReply")}
        </p>
      );
    }

    case "contacts": {
      // Outbound contact card (the vCard the customer received). Rows
      // with no stored payload (mid-deploy sends) fall back to the
      // readable `content_text` the send path always persists.
      if (message.contacts_payload?.length) {
        return (
          <div className="flex flex-col gap-2">
            {message.contacts_payload.map((entry, i) => (
              <ContactCardPreview key={i} entry={entry} isAgent={isAgent} t={t} />
            ))}
          </div>
        );
      }
      return (
        <p className="whitespace-pre-wrap break-words text-sm">
          {message.content_text || t("contactCard")}
        </p>
      );
    }

    default:
      return (
        <p className="whitespace-pre-wrap break-words text-sm">
          {message.content_text || t("unsupported")}
        </p>
      );
  }
}

/** One saved-contact card inside a `contacts` bubble — mirrors the
 *  WhatsApp client's own card: avatar initial, name, title/company, then
 *  the tappable details. Styled per bubble fill (agent = primary). */
function ContactCardPreview({
  entry,
  isAgent,
  t,
}: {
  entry: ContactsPayloadEntry;
  isAgent: boolean;
  t: ReturnType<typeof useTranslations>;
}) {
  const name = entry.name?.formatted_name || entry.name?.first_name || t("contactCard");
  const orgLine = [entry.org?.title, entry.org?.company].filter(Boolean).join(" · ");
  const muted = isAgent ? "text-primary-foreground/75" : "text-muted-foreground";
  return (
    <div
      className={cn(
        "min-w-52 rounded-lg border px-3 py-2",
        isAgent
          ? "border-primary-foreground/20 bg-primary-foreground/10"
          : "border-border bg-background/60",
      )}
    >
      <div className="flex items-center gap-2.5">
        <div
          className={cn(
            "flex size-9 shrink-0 items-center justify-center rounded-full text-sm font-semibold",
            isAgent
              ? "bg-primary-foreground/20 text-primary-foreground"
              : "bg-primary/10 text-primary",
          )}
        >
          {name.charAt(0).toUpperCase()}
        </div>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{name}</p>
          {orgLine && <p className={cn("truncate text-xs", muted)}>{orgLine}</p>}
        </div>
      </div>
      {(entry.phones?.length || entry.emails?.length || entry.urls?.length) ? (
        <div className={cn("mt-2 space-y-1 border-t pt-2 text-xs", isAgent ? "border-primary-foreground/15" : "border-border/70")}>
          {entry.phones?.map((p, i) =>
            p.phone ? (
              <p key={`p${i}`} className="flex items-center gap-1.5">
                <Phone className={cn("h-3 w-3 shrink-0", muted)} />
                <span className="truncate">{p.phone}</span>
              </p>
            ) : null,
          )}
          {entry.emails?.map((e, i) =>
            e.email ? (
              <p key={`e${i}`} className="flex items-center gap-1.5">
                <Mail className={cn("h-3 w-3 shrink-0", muted)} />
                <span className="truncate">{e.email}</span>
              </p>
            ) : null,
          )}
          {entry.urls?.map((u, i) =>
            u.url ? (
              <p key={`u${i}`} className="flex items-center gap-1.5">
                <Globe className={cn("h-3 w-3 shrink-0", muted)} />
                <span className="truncate">{u.url}</span>
              </p>
            ) : null,
          )}
        </div>
      ) : null}
    </div>
  );
}

export function MessageBubble({
  message,
  reply,
  reactions,
  currentUserId,
  onToggleReaction,
  canReact = true,
}: MessageBubbleProps) {
  const t = useTranslations("Inbox.bubble");

  const isAgent = message.sender_type === "agent" || message.sender_type === "bot";
  const time = format(new Date(message.created_at), "HH:mm");

  // Row alignment + width cap are owned by <MessageActions> so its hover
  // group matches the bubble's content area, not the full row.
  return (
    <div
      className={cn(
        "flex flex-col",
        isAgent ? "items-end" : "items-start",
      )}
    >
      <div
        className={cn(
          "relative rounded-2xl px-3 py-2",
          isAgent
            ? "rounded-br-md bg-primary text-primary-foreground"
            : "rounded-bl-md bg-muted text-foreground",
        )}
      >
        {reply && (
          <ReplyQuote
            authorLabel={reply.authorLabel}
            preview={reply.preview}
            onPrimary={isAgent}
          />
        )}
        <MessageContent message={message} t={t} isAgent={isAgent} />
        <div
          className={cn(
            "mt-1 flex items-center gap-1",
            isAgent ? "justify-end" : "justify-start",
          )}
        >
          {/* AI badge — only on replies the auto-reply bot generated
              (always outbound, so it sits on the primary fill). Lets
              agents tell an AI reply from their own / a Flow's at a
              glance. */}
          {message.ai_generated && (
            <span
              className="inline-flex items-center gap-0.5 rounded-full bg-primary-foreground/20 px-1.5 py-px text-[9px] font-semibold uppercase leading-none tracking-wide text-primary-foreground"
              title={t("aiBadgeTitle")}
            >
              <Sparkles className="h-2.5 w-2.5" />
              {t("aiBadge")}
            </span>
          )}
          <span
            className={cn(
              "text-[10px]",
              // Outbound bubbles sit on the primary fill, so the
              // timestamp must read against that (not the neutral
              // foreground) — otherwise it goes low-contrast in light
              // mode. Inbound bubbles use the muted surface.
              isAgent ? "text-primary-foreground/70" : "text-muted-foreground",
            )}
          >
            {time}
          </span>
          {isAgent && <StatusIcon status={message.status} />}
        </div>
      </div>
      {reactions && reactions.length > 0 && onToggleReaction && (
        <MessageReactions
          reactions={reactions}
          currentUserId={currentUserId}
          onToggle={onToggleReaction}
          canReact={canReact}
        />
      )}
    </div>
  );
}
