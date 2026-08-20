"use client"

/**
 * WhatsApp-style live preview of what a `send_message` (or `send_template`)
 * step will actually deliver. Purely presentational: it takes the same
 * config the composer is editing and renders it — no queries, no uploads,
 * no effects. Which bubbles to show, in what order, and how a template's
 * `{{n}}` resolves live in `./preview-plan.ts`, so those decisions are
 * unit-tested without rendering anything.
 *
 * `interactive` payloads are NOT drawn here — `interactive-builder.tsx`
 * already renders a WhatsApp-style buttons/list preview column
 * (`InteractivePreview`), so this delegates to that instead of drawing a
 * second, slightly-different-looking bubble for the same payload. Text and
 * media bubbles use the same card styling `InteractivePreview` uses
 * (`w-full max-w-[260px] ... bg-card ... ring-1 ring-border`) so every
 * bubble in this column — whichever case produced it — reads as one
 * component, not two half-matching previews stitched together.
 *
 * The one rule that must not be fudged: when `media.type === "audio"` and
 * `text` is non-empty, `planSend` (convex/lib/automations/sendPlan.ts)
 * sends TWO messages, because WhatsApp cannot caption audio. This renders
 * two bubbles for that case — audio, then text, in send order — because
 * showing one would misrepresent what the customer receives.
 */

import { Fragment, type ReactNode } from "react"
import { useTranslations } from "next-intl"
import { FileText, ImageOff } from "lucide-react"

import { cn } from "@/lib/utils"
import { resolveMediaUrl } from "@/lib/storage/media-url"
import { InteractivePreview } from "@/components/interactive/interactive-preview"
import type { SendMessageStepConfig } from "@/types"

import {
  planPreviewBubbles,
  resolveTemplatePreview,
  splitInterpolationTokens,
  type PreviewBubble,
} from "./preview-plan"

const BUBBLE_CLASS =
  "w-full max-w-[260px] overflow-hidden rounded-lg bg-card text-foreground shadow-sm ring-1 ring-border"

type Translator = ReturnType<typeof useTranslations>

// ------------------------------------------------------------
// Shared chrome — the "Preview" label over a chat-background tint,
// matching interactive-builder.tsx's own preview column exactly so the
// two sit together as one visual language wherever they're mounted.
// ------------------------------------------------------------

function PreviewShell({ children, className }: { children: ReactNode; className?: string }) {
  const t = useTranslations("Automations.builder")
  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5", className)}>
      <span className="text-[12px] font-medium uppercase tracking-wide text-muted-foreground">
        {t("preview.label")}
      </span>
      <div className="flex flex-col gap-2 rounded-lg bg-muted/40 p-3">{children}</div>
    </div>
  )
}

function Placeholder({ children }: { children: ReactNode }) {
  return (
    <span className="mx-0.5 inline-block rounded bg-muted px-1 py-0.5 align-baseline font-mono text-[11px] text-muted-foreground ring-1 ring-border">
      {children}
    </span>
  )
}

/** Renders a token `interpolate()` (convex/automationsEngine.ts) does NOT
 *  resolve to content in production (`tokenResolves` in ./preview-plan.ts
 *  says which) — struck through and destructive-colored, with a `title`
 *  explaining what actually happens, so it can never be mistaken for "this
 *  becomes the contact's name" the way the plain muted `Placeholder` pill
 *  would read. I-1 fix: the engine deletes this token entirely rather than
 *  leaving it literal, so showing a confident pill here would misrepresent
 *  what the customer receives — exactly the bug this component exists to
 *  avoid. */
function VanishingToken({ children }: { children: ReactNode }) {
  const t = useTranslations("Automations.builder")
  return (
    <span
      title={t("preview.tokenWontSend")}
      className="mx-0.5 inline-block rounded bg-destructive/10 px-1 py-0.5 align-baseline font-mono text-[11px] text-destructive line-through decoration-destructive ring-1 ring-destructive/40"
    >
      {children}
    </span>
  )
}

/** Renders `{{ ... }}` tokens as either a neutral muted pill (`{{ message.text }}`,
 *  the one token `interpolate()` actually fills with content — see
 *  `tokenResolves` in ./preview-plan.ts) or a destructive, struck-through
 *  `VanishingToken` (everything else, `{{ vars.* }}` included — the engine
 *  deletes these at send time, it does not leave them literal). This
 *  preview has no contact/message context to resolve a value WITH, so even
 *  a resolving token still renders as a pill rather than substituted text. */
function InterpolatedText({ text }: { text: string }) {
  const segments = splitInterpolationTokens(text)
  return (
    <>
      {segments.map((seg, i) =>
        seg.kind === "token" ? (
          seg.resolves ? (
            <Placeholder key={i}>{`{{${seg.raw}}}`}</Placeholder>
          ) : (
            <VanishingToken key={i}>{`{{${seg.raw}}}`}</VanishingToken>
          )
        ) : (
          <Fragment key={i}>{seg.value}</Fragment>
        ),
      )}
    </>
  )
}

// ------------------------------------------------------------
// send_message preview
// ------------------------------------------------------------

export interface MessagePreviewProps {
  config: SendMessageStepConfig
  className?: string
}

export function MessagePreview({ config, className }: MessagePreviewProps) {
  const t = useTranslations("Automations.builder")
  const bubbles = planPreviewBubbles(config)

  return (
    <PreviewShell className={className}>
      {bubbles.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("preview.empty")}</p>
      ) : (
        bubbles.map((bubble, i) => <Bubble key={i} bubble={bubble} t={t} />)
      )}
    </PreviewShell>
  )
}

function Bubble({ bubble, t }: { bubble: PreviewBubble; t: Translator }) {
  switch (bubble.kind) {
    case "text":
      return (
        <div className={BUBBLE_CLASS}>
          <p className="whitespace-pre-wrap break-words px-3 py-2 text-sm">
            <InterpolatedText text={bubble.text} />
          </p>
        </div>
      )
    case "media":
      return <MediaBubble bubble={bubble} t={t} />
    case "interactive":
      return <InteractivePreview payload={bubble.payload} />
  }
}

function Caption({ text }: { text: string }) {
  return (
    <p className="whitespace-pre-wrap break-words border-t border-border px-3 py-2 text-sm">
      <InterpolatedText text={text} />
    </p>
  )
}

function UnavailableRow({ label, t }: { label: string; t: Translator }) {
  return (
    <div className="flex items-center gap-2 px-3 py-2.5 text-xs text-muted-foreground">
      <ImageOff className="h-4 w-4 shrink-0" aria-hidden />
      <span>{t("preview.unavailable", { label })}</span>
    </div>
  )
}

type MediaPreviewBubble = Extract<PreviewBubble, { kind: "media" }>

function MediaBubble({ bubble, t }: { bubble: MediaPreviewBubble; t: Translator }) {
  const url = resolveMediaUrl({ key: bubble.key, url: bubble.url })

  if (bubble.mediaType === "document") {
    const filename =
      bubble.filename ||
      (bubble.key ? bubble.key.split("/").pop() : bubble.url?.split("/").pop()) ||
      t("composer.documentLabel")
    return (
      <div className={BUBBLE_CLASS}>
        <div className="flex items-center gap-2 px-3 py-2.5">
          <FileText className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="min-w-0 flex-1 truncate text-sm font-medium" title={filename}>
            {filename}
          </span>
        </div>
        {bubble.caption && <Caption text={bubble.caption} />}
      </div>
    )
  }

  if (bubble.mediaType === "audio") {
    return (
      <div className={BUBBLE_CLASS}>
        {url ? (
          <div className="px-3 py-2.5">
            {/* Real playback, not a decorative waveform — matches how
                message-bubble.tsx renders an actual audio message, and
                lets the operator confirm the right file was attached. */}
            <audio src={url} controls className="h-10 w-full max-w-[220px]" />
          </div>
        ) : (
          <UnavailableRow label={t("composer.audioLabel")} t={t} />
        )}
      </div>
    )
  }

  // image / video
  return (
    <div className={BUBBLE_CLASS}>
      {url ? (
        bubble.mediaType === "image" ? (
          // Plain `<img>`, not next/image: `url` resolves to an R2 public
          // host or a legacy external URL, neither a fixed origin listed
          // in `images.remotePatterns` — same reasoning as message-bubble.tsx's
          // MediaImage.
          // eslint-disable-next-line @next/next/no-img-element
          <img src={url} alt={t("composer.imageLabel")} className="block max-h-48 w-full object-cover" />
        ) : (
          <video src={url} controls className="block max-h-48 w-full" />
        )
      ) : (
        <UnavailableRow
          label={t(bubble.mediaType === "image" ? "composer.imageLabel" : "composer.videoLabel")}
          t={t}
        />
      )}
      {bubble.caption && <Caption text={bubble.caption} />}
    </div>
  )
}

// ------------------------------------------------------------
// send_template preview — simplified: one bubble, {{n}} substituted with
// whatever the operator has typed so far, unfilled ones left as pills.
//
// I-4 fix: `body`/`variables` alone can't tell "nothing chosen yet" apart
// from "chosen, but the account's template list hasn't loaded yet" or
// "chosen, but that template no longer matches anything approved" — the
// caller (`automation-builder.tsx`'s `SendTemplateFields`) resolves all
// three from `useResources()` and passes `loading`/`notFoundLabel`
// explicitly. `resolveTemplatePreview` (./preview-plan.ts) is the pure
// decision; this component only renders whichever state it returns.
// ------------------------------------------------------------

export interface TemplatePreviewProps {
  body: string
  variables?: Record<string, string>
  className?: string
  /** True while the account's template list is still loading (the Convex
   *  query hasn't resolved) — distinct from both "nothing chosen yet" and
   *  "chosen, but not found". Default false. */
  loading?: boolean
  /** Set when `template_name` is non-empty but doesn't match any
   *  currently-resolved approved template (deleted/unapproved since this
   *  step was configured). Pass the EXACT text the template `<select>`
   *  already shows for this case — never a second, invented way to say
   *  "not found". */
  notFoundLabel?: string
}

export function TemplatePreview({
  body,
  variables,
  className,
  loading = false,
  notFoundLabel,
}: TemplatePreviewProps) {
  const t = useTranslations("Automations.builder")
  const state = resolveTemplatePreview({ loading, notFoundLabel, body, variables })

  return (
    <PreviewShell className={className}>
      {state.kind === "loading" ? (
        <p className="text-sm text-muted-foreground">{t("preview.loading")}</p>
      ) : state.kind === "not-found" ? (
        <p className="text-sm text-muted-foreground">{state.label}</p>
      ) : state.segments.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("preview.empty")}</p>
      ) : (
        <div className={BUBBLE_CLASS}>
          <p className="whitespace-pre-wrap break-words px-3 py-2 text-sm">
            {state.segments.map((seg, i) =>
              seg.kind === "text" ? (
                <Fragment key={i}>{seg.value}</Fragment>
              ) : (
                <Placeholder key={i}>{`{{${seg.n}}}`}</Placeholder>
              ),
            )}
          </p>
        </div>
      )}
    </PreviewShell>
  )
}
