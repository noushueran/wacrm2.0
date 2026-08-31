"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
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
import { MediaLightbox } from "./media-lightbox";
import { useMediaObjectUrl } from "./use-media-object-url";
import { useMediaDownload } from "./use-media-download";
import { ReplyQuote } from "./reply-quote";
import { MessageReactions } from "./message-reactions";
import { AdReferralCard } from "./ad-referral-card";
import { VoiceTranscript } from "./voice-transcript";
import { InteractivePreview } from "@/components/interactive/interactive-preview";
import { linkifyMessage } from "@/lib/inbox/linkify";
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

/** Shared by every media type: the two strings `useMediaDownload` needs
 *  for its failure toast, read off the bubble's own `t`. */
function downloadLabels(t: ReturnType<typeof useTranslations>) {
  return { failed: t("downloadFailed"), openInTab: t("openInTab") };
}

interface MediaProps {
  url: string;
  createdAt: Message["created_at"];
  caption?: string;
  t: ReturnType<typeof useTranslations>;
}

function MediaImage({ url, createdAt, caption, t }: MediaProps) {
  const { src, state, markError } = useMediaObjectUrl(url);
  const [viewerOpen, setViewerOpen] = useState(false);
  const { download, pending } = useMediaDownload(downloadLabels(t));
  const alt = caption || t("photo");

  if (state === "error") {
    return (
      <div className="flex h-40 w-60 items-center justify-center rounded-lg bg-muted">
        <ImageOff className="h-8 w-8 text-muted-foreground" />
      </div>
    );
  }

  if (state === "loading" || !src) {
    return (
      <div className="flex h-40 w-60 items-center justify-center rounded-lg bg-muted">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setViewerOpen(true)}
        aria-label={t("viewLarger")}
        className="block cursor-zoom-in rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {/* Plain `<img>`, not `next/image`. `src` is a short-lived signed
            URL for WhatsApp media on object storage: the host is not a fixed
            origin that could be listed in `images.remotePatterns` (none is
            configured), and routing an already-authenticated, expiring URL
            through the optimizer would both re-fetch it server-side and bill
            per transformation for images displayed at most once, in a chat
            thread, at a fixed 240px cap. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt={alt}
          onError={markError}
          // `object-contain`, not `object-cover`: a cover crop cuts the
          // top and bottom off a tall banner, which is precisely the
          // content an agent needs to check at a glance.
          className="max-h-64 max-w-60 rounded-lg object-contain"
        />
      </button>
      <MediaLightbox
        open={viewerOpen}
        onOpenChange={setViewerOpen}
        kind="image"
        src={src}
        alt={alt}
        caption={caption}
        downloadPending={pending}
        onDownload={() => void download({ kind: "image", url, createdAt })}
        t={t}
      />
    </>
  );
}

function MediaVideo({ url, createdAt, caption, t }: MediaProps) {
  const [viewerOpen, setViewerOpen] = useState(false);
  const { download, pending } = useMediaDownload(downloadLabels(t));

  return (
    <>
      {/* The video keeps its own click (play/pause), so enlarging needs a
          control of its own rather than a click-through overlay. */}
      <div className="relative w-fit">
        <video src={url} controls className="max-h-64 max-w-60 rounded-lg" />
        <button
          type="button"
          onClick={() => setViewerOpen(true)}
          aria-label={t("viewLarger")}
          className="absolute top-1.5 right-1.5 flex h-7 w-7 items-center justify-center rounded-full bg-black/60 text-white outline-none transition-colors hover:bg-black/80 focus-visible:ring-2 focus-visible:ring-white/60"
        >
          <Maximize2 className="h-3.5 w-3.5" />
        </button>
      </div>
      <MediaLightbox
        open={viewerOpen}
        onOpenChange={setViewerOpen}
        kind="video"
        src={url}
        alt={caption || t("video")}
        caption={caption}
        downloadPending={pending}
        onDownload={() => void download({ kind: "video", url, createdAt })}
        t={t}
      />
    </>
  );
}

function MediaDocument({ url, createdAt, caption, t }: MediaProps) {
  const { download, pending } = useMediaDownload(downloadLabels(t));
  const name = caption || t("document");

  return (
    <div className="flex items-center gap-1 rounded-lg bg-muted/50 pr-1 text-sm">
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-3 py-2 hover:bg-muted"
      >
        <FileText className="h-5 w-5 shrink-0 text-muted-foreground" />
        <span className="truncate">{name}</span>
      </a>
      <button
        type="button"
        onClick={() =>
          void download({ kind: "document", url, createdAt, documentName: caption })
        }
        disabled={pending}
        aria-label={t("download")}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
      >
        <Download className="h-4 w-4" />
      </button>
    </div>
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

/**
 * Message text with its URLs turned into anchors. Until this existed
 * every bubble rendered `content_text` as an inert string, so a link an
 * agent sent — or a customer sent in — could not be clicked at all.
 *
 * `target="_blank"` keeps the inbox tab alive (an agent clicking a link
 * mid-thread must not lose the conversation), and `rel` carries all
 * three of noopener/noreferrer/nofollow because a large share of these
 * URLs arrive in INBOUND messages and are therefore untrusted: noopener
 * closes the reverse-tabnabbing hole that `target="_blank"` opens on its
 * own, and nofollow keeps the CRM from vouching for whatever a stranger
 * pasted. The href itself is constrained to http(s) by `linkifyMessage`.
 *
 * Colour is inherited rather than set: these bubbles come in two fills
 * (agent = `bg-primary`, customer = muted), and a fixed link colour is
 * unreadable on one of them.
 */
function LinkifiedText({ text }: { text: string }) {
  return (
    <>
      {linkifyMessage(text).map((segment, i) =>
        segment.type === "link" ? (
          <a
            key={i}
            href={segment.href}
            target="_blank"
            rel="noopener noreferrer nofollow"
            className="underline underline-offset-2 hover:opacity-80"
          >
            {segment.text}
          </a>
        ) : (
          <span key={i}>{segment.text}</span>
        ),
      )}
    </>
  );
}

export function MessageContentBody({ message, t, isAgent }: { message: Message, t: ReturnType<typeof useTranslations>, isAgent: boolean }) {
  switch (message.content_type) {
    case "text":
      return (
        <p className="whitespace-pre-wrap break-words text-sm">
          <LinkifiedText text={message.content_text ?? ""} />
        </p>
      );

    case "image":
      return (
        <div>
          {message.media_url ? (
            <MediaImage
              url={message.media_url}
              createdAt={message.created_at}
              caption={message.content_text}
              t={t}
            />
          ) : (
            <MediaUnavailable label={t("photo")} t={t} />
          )}
          {message.content_text && (
            <p className="mt-1 whitespace-pre-wrap break-words text-sm">
              <LinkifiedText text={message.content_text} />
            </p>
          )}
        </div>
      );

    case "video":
      return (
        <div>
          {message.media_url ? (
            <MediaVideo
              url={message.media_url}
              createdAt={message.created_at}
              caption={message.content_text}
              t={t}
            />
          ) : (
            <MediaUnavailable label={t("video")} t={t} />
          )}
          {message.content_text && (
            <p className="mt-1 whitespace-pre-wrap break-words text-sm">
              <LinkifiedText text={message.content_text} />
            </p>
          )}
        </div>
      );

    case "audio":
      return (
        <div>
          {message.media_url ? (
            <audio src={message.media_url} controls className="max-w-60" />
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

    case "document":
      if (!message.media_url) {
        return <MediaUnavailable label={message.content_text || t("document")} t={t} />;
      }
      return (
        <MediaDocument
          url={message.media_url}
          createdAt={message.created_at}
          caption={message.content_text}
          t={t}
        />
      );

    case "template":
      return (
        <div>
          <span
            className={cn(
              "mb-1 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium",
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
              <LinkifiedText text={message.content_text} />
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
            <span className="inline-flex items-center gap-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              <CornerDownLeft className="h-3 w-3" />
              {t("buttonReply")}
            </span>
            <p className="whitespace-pre-wrap break-words text-sm">
              <LinkifiedText text={message.content_text || t("interactiveReply")} />
            </p>
          </div>
        );
      }
      return (
        <p className="whitespace-pre-wrap break-words text-sm">
          <LinkifiedText text={message.content_text || t("interactiveReply")} />
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
          <LinkifiedText text={message.content_text || t("contactCard")} />
        </p>
      );
    }

    default:
      return (
        <p className="whitespace-pre-wrap break-words text-sm">
          <LinkifiedText text={message.content_text || t("unsupported")} />
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
              className="inline-flex items-center gap-0.5 rounded-full bg-primary-foreground/20 px-1.5 py-px text-[10px] font-semibold uppercase leading-none tracking-wide text-primary-foreground"
              title={t("aiBadgeTitle")}
            >
              <Sparkles className="h-2.5 w-2.5" />
              {t("aiBadge")}
            </span>
          )}
          <span
            className={cn(
              "text-[11px]",
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
