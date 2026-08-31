"use client"

/**
 * Unified "Send Message" step editor — text, an optional single
 * attachment (image/video/audio/document), optional reply buttons or a
 * list, and an out-of-window template fallback. Backs the `send_message`
 * automation step; `automation-builder.tsx`'s `StepEditor` also mounts
 * this for legacy `send_buttons`/`send_list` steps (seeded with just
 * `{ interactive }`), upgrading them to `send_message` the moment the
 * user opens and edits one.
 *
 * Media and `interactive` are mutually exclusive
 * (`convex/lib/automations/validate.ts` rejects a config with both, and
 * `planSend` resolves the tie in media's favour) — enforced here by
 * disabling whichever section isn't active rather than letting the user
 * build a combination that only fails at save/send time.
 *
 * `text` and `interactive` are similarly one-or-the-other: `planSend`
 * (convex/lib/automations/sendPlan.ts) reads `text` only when there's no
 * `interactive` payload, so once buttons/list is picked the "Message
 * text" field above is disabled rather than left sitting on screen as a
 * second, silently-ignored body input next to the InteractiveBuilder's
 * own "Body" field.
 */

import { useCallback, useRef, useState } from "react"
import { useConvex, useMutation } from "convex/react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { ChevronDown, Loader2, Paperclip, Upload, X } from "lucide-react"

import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  InteractiveBuilder,
  blankButtonsPayload,
  blankListPayload,
} from "@/components/interactive/interactive-builder"
import { MessagePreview } from "./message-preview"
import { uploadAccountMedia, MEDIA_MAX_BYTES } from "@/lib/storage/upload-media"
import { cn } from "@/lib/utils"
import type {
  MessageTemplate,
  SendMessageFallbackConfig,
  SendMessageMediaConfig,
  SendMessageStepConfig,
} from "@/types"

import { useResources } from "./automation-builder"
import { extractTemplateVariables } from "../../../convex/lib/automations/templateVars"
import { api } from "../../../convex/_generated/api"

type MediaAttachmentType = SendMessageMediaConfig["type"]
type FallbackHeaderType = NonNullable<SendMessageFallbackConfig["header"]>["type"]

// Mirrors node-config-form.tsx's MEDIA_ACCEPT (the Flows send_media
// form), extended with audio — WhatsApp's supported voice-note set.
const MEDIA_ACCEPT: Record<MediaAttachmentType, string> = {
  image: "image/png,image/jpeg,image/webp",
  video: "video/mp4,video/3gpp",
  audio: "audio/aac,audio/mp4,audio/mpeg,audio/amr,audio/ogg",
  document:
    "application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.presentationml.presentation,text/plain",
}

const FALLBACK_NONE = "__none__"

function nonEmpty(s: string | undefined): boolean {
  return typeof s === "string" && s.trim().length > 0
}

function toTemplateValue(name: string, lang: string): string {
  return `${name}::${lang}`
}

function isMediaHeaderType(
  headerType: MessageTemplate["header_type"],
): headerType is FallbackHeaderType {
  return headerType === "image" || headerType === "video" || headerType === "document"
}

export interface SendComposerProps {
  value: SendMessageStepConfig
  onChange: (next: SendMessageStepConfig) => void
}

export function SendComposer({ value, onChange }: SendComposerProps) {
  const t = useTranslations("Automations.builder")

  return (
    // The @container declaration and the @lg/composer: query below live
    // on separate elements deliberately — a container query can't
    // resolve against the element that establishes the container itself
    // (same rule interactive-builder.tsx's own `@container/ib` follows).
    // Named `/composer`, not left bare: this step card renders at a fixed
    // max-w-[560px] regardless of viewport (automation-builder.tsx's
    // canvas caps every step card there), so the fold point had to be
    // checked against that real width, not assumed from the token —
    // `@2xl` (42rem/672px) never fires inside a 560px card, `@lg`
    // (32rem/512px) does, with room to spare (~523-555px measured).
    //
    // I-2 fix: when buttons/list is picked, InteractiveBuilder below now
    // mounts with `showPreview={false}` (its own preview column would
    // otherwise duplicate the delegated MessagePreview to the right of
    // this whole split), so its nested `@lg/ib` query has nothing left to
    // fold — this breakpoint no longer needs to stay in sync with it.
    <div className="@container/composer">
      <div className="flex flex-col gap-5 @lg/composer:flex-row">
        <div className="min-w-0 flex-1 space-y-5">
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">
              {t("config.messageText")}
            </label>
            <Textarea
              value={value.text ?? ""}
              onChange={(e) => onChange({ ...value, text: e.target.value })}
              placeholder={t("config.placeholderMessageText")}
              disabled={!!value.interactive}
              className="min-h-24 bg-muted text-foreground"
            />
            {/* planSend (convex/lib/automations/sendPlan.ts) reads `text` only
                when there's no `interactive` payload — an interactive send's
                body comes entirely from the InteractiveBuilder's own "Body"
                field below. Disabling this field once buttons/list is picked
                stops the two from ever looking like independent inputs, the
                same way AttachmentSection/InteractiveSection already disable
                each other. */}
            {!!value.interactive && (
              <p className="mt-1 text-xs text-amber-500">{t("composer.interactiveDisablesText")}</p>
            )}
          </div>

          <AttachmentSection value={value} onChange={onChange} t={t} />

          <div className="border-t border-border pt-4">
            <InteractiveSection value={value} onChange={onChange} t={t} />
          </div>

          <div className="border-t border-border pt-4">
            <FallbackSection value={value} onChange={onChange} t={t} />
          </div>
        </div>

        <MessagePreview config={value} className="shrink-0 @lg/composer:w-[280px]" />
      </div>
    </div>
  )
}

// ------------------------------------------------------------
// Attachment — image / video / audio / document
// ------------------------------------------------------------

function AttachmentSection({
  value,
  onChange,
  t,
}: {
  value: SendMessageStepConfig
  onChange: (next: SendMessageStepConfig) => void
  t: ReturnType<typeof useTranslations>
}) {
  const convex = useConvex()
  const startUpload = useMutation(api.files.startUpload)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  // Tracks the type the NEXT upload will be tagged as, before a file
  // exists yet. Once `value.media` is set, its own `type` is
  // authoritative — this only drives the picker's display before that.
  const [pendingType, setPendingType] = useState<MediaAttachmentType>(
    value.media?.type ?? "image",
  )

  // `handleFile` is async and resumes after `await uploadAccountMedia` —
  // by then `value`/`onChange` may be stale, since nothing here blocks
  // the rest of the form and the user can keep typing, or switch to
  // Buttons, while an upload is in flight. These refs are updated
  // unconditionally on every render (not inside an effect, so there's no
  // window where a same-tick completion could still read a stale value)
  // and read AFTER the await instead of the closed-over props, so the
  // completion merges into whatever the user has done SINCE the upload
  // started rather than silently reverting it.
  const valueRef = useRef(value)
  valueRef.current = value
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  const media = value.media
  const disabled = !!value.interactive
  const mediaType = media?.type ?? pendingType

  const handleFile = useCallback(
    async (file: File) => {
      if (file.size > MEDIA_MAX_BYTES) {
        toast.error(
          t("composer.fileTooLarge", { size: (file.size / 1024 / 1024).toFixed(1) }),
        )
        return
      }
      setUploading(true)
      try {
        const { key } = await uploadAccountMedia(convex, startUpload, file, "automation")
        const latest = valueRef.current
        if (latest.interactive) {
          // The user switched to buttons/list while this upload was in
          // flight. Applying it now would either silently discard that
          // switch (merging into the pre-upload snapshot) or violate the
          // media/interactive exclusivity (forcing media onto the
          // current value) — so the upload is dropped instead, loudly.
          toast.error(t("composer.uploadDiscardedStale"))
          return
        }
        // Patch `media` in one call, merged into the LATEST config (not
        // the value this callback closed over) so the form never renders
        // a half-uploaded state and never reverts edits made mid-upload.
        onChangeRef.current({
          ...latest,
          media: {
            type: mediaType,
            key,
            filename: mediaType === "document" ? file.name : undefined,
          },
        })
        toast.success(t("composer.uploadSuccess"))
      } catch (err) {
        toast.error(err instanceof Error ? err.message : t("composer.uploadFailed"))
      } finally {
        setUploading(false)
      }
    },
    [convex, startUpload, mediaType, t],
  )

  const handleTypeChange = (v: MediaAttachmentType | null) => {
    if (!v) return
    setPendingType(v)
    if (media) {
      // Meta's mime requirements differ per type — a file already
      // uploaded under the old type can't be resent as the new one.
      onChange({ ...value, media: undefined })
    }
  }

  const displayName =
    media?.filename ||
    (media?.key ? media.key.split("/").pop() : media?.url?.split("/").pop()) ||
    ""

  // Base UI's <Select.Value> only resolves a label from SelectItems that
  // have actually mounted (i.e. the popup has been opened at least once)
  // — without this, the trigger shows the raw value ("image") instead of
  // its label ("Image") until the user opens the dropdown. Passing
  // `items` lets it resolve the label immediately.
  const mediaItems: Record<MediaAttachmentType, string> = {
    image: t("composer.imageLabel"),
    video: t("composer.videoLabel"),
    audio: t("composer.audioLabel"),
    document: t("composer.documentLabel"),
  }

  return (
    <div className="space-y-2">
      <label className="block text-xs font-medium text-muted-foreground">
        {t("composer.attachmentLabel")}
      </label>
      <Select value={mediaType} onValueChange={handleTypeChange} disabled={disabled} items={mediaItems}>
        <SelectTrigger className="w-full bg-muted">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="image">{t("composer.imageLabel")}</SelectItem>
          <SelectItem value="video">{t("composer.videoLabel")}</SelectItem>
          <SelectItem value="audio">{t("composer.audioLabel")}</SelectItem>
          <SelectItem value="document">{t("composer.documentLabel")}</SelectItem>
        </SelectContent>
      </Select>

      {media ? (
        <div className="flex items-center gap-2 rounded-md border border-border bg-muted px-3 py-2 text-xs">
          <Paperclip className="h-3.5 w-3.5 shrink-0 text-cyan-400" aria-hidden />
          <span className="min-w-0 flex-1 truncate text-foreground" title={displayName}>
            {displayName}
          </span>
          <button
            type="button"
            onClick={() => onChange({ ...value, media: undefined })}
            className="rounded p-1 text-muted-foreground hover:bg-background hover:text-foreground"
            aria-label={t("composer.removeFile")}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading || disabled}
          className="flex w-full items-center justify-center gap-2 rounded-md border border-dashed border-border bg-card px-3 py-4 text-xs text-muted-foreground transition-colors hover:border-border hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
        >
          {uploading ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {t("composer.uploading")}
            </>
          ) : (
            <>
              <Upload className="h-3.5 w-3.5" />
              {t("composer.clickToUpload")}
            </>
          )}
        </button>
      )}
      <input
        ref={fileInputRef}
        type="file"
        accept={MEDIA_ACCEPT[mediaType]}
        className="hidden"
        disabled={disabled}
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) void handleFile(f)
          // Reset so picking the same file twice still fires onChange.
          e.target.value = ""
        }}
      />

      {disabled && (
        <p className="text-xs text-amber-500">{t("composer.interactiveDisablesMedia")}</p>
      )}
      {!disabled && media?.type === "audio" && nonEmpty(value.text) && (
        <p className="text-xs text-muted-foreground">{t("composer.audioCaptionNote")}</p>
      )}
    </div>
  )
}

// ------------------------------------------------------------
// Reply buttons / list
// ------------------------------------------------------------

function InteractiveSection({
  value,
  onChange,
  t,
}: {
  value: SendMessageStepConfig
  onChange: (next: SendMessageStepConfig) => void
  t: ReturnType<typeof useTranslations>
}) {
  const disabled = !!value.media
  const kind = value.interactive?.kind ?? "none"

  function pick(next: "none" | "buttons" | "list") {
    if (disabled || next === kind) return
    if (next === "none") {
      onChange({ ...value, interactive: undefined })
    } else {
      onChange({
        ...value,
        interactive: next === "buttons" ? blankButtonsPayload() : blankListPayload(),
      })
    }
  }

  return (
    <div className="space-y-2">
      <label className="block text-xs font-medium text-muted-foreground">
        {t("composer.interactiveLabel")}
      </label>
      <div className="flex gap-2">
        <SegmentButton active={kind === "none"} onClick={() => pick("none")}>
          {t("composer.interactiveNone")}
        </SegmentButton>
        <SegmentButton active={kind === "buttons"} disabled={disabled} onClick={() => pick("buttons")}>
          {t("composer.interactiveButtons")}
        </SegmentButton>
        <SegmentButton active={kind === "list"} disabled={disabled} onClick={() => pick("list")}>
          {t("composer.interactiveList")}
        </SegmentButton>
      </div>

      {disabled && (
        <p className="text-xs text-amber-500">{t("composer.mediaDisablesInteractive")}</p>
      )}

      {value.interactive && (
        <div className="pt-1">
          {/* I-2 fix: showPreview={false} — MessagePreview above (mounted
              by SendComposer's own caller) already delegates to
              InteractivePreview for this exact payload, so
              InteractiveBuilder's own nested preview column would be a
              second, redundant "Preview" column right next to it.
              showValidationError={false} — the amber StepIssues strip
              rendered next to this step's card already shows the
              identical validateInteractivePayload error (both read
              cfg.interactive through the SAME validator, one via
              validateStepsForActivation's send_message case, the other
              directly here), so this component's own red inline copy
              would restate the same sentence in a contradictory colour. */}
          <InteractiveBuilder
            value={value.interactive}
            onChange={(payload) => onChange({ ...value, interactive: payload })}
            showPreview={false}
            showValidationError={false}
          />
        </div>
      )}
    </div>
  )
}

function SegmentButton({
  active,
  disabled,
  onClick,
  children,
}: {
  active: boolean
  disabled?: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "flex-1 rounded-md border px-3 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        active
          ? "border-primary bg-primary/10 text-primary"
          : "border-border bg-muted text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  )
}

// ------------------------------------------------------------
// Out-of-window template fallback
// ------------------------------------------------------------

function FallbackSection({
  value,
  onChange,
  t,
}: {
  value: SendMessageStepConfig
  onChange: (next: SendMessageStepConfig) => void
  t: ReturnType<typeof useTranslations>
}) {
  const { templates } = useResources()
  const [open, setOpen] = useState(() => !!value.fallback)
  const convex = useConvex()
  const startUpload = useMutation(api.files.startUpload)
  const [headerUploading, setHeaderUploading] = useState(false)
  const headerInputRef = useRef<HTMLInputElement>(null)

  // See the matching comment in AttachmentSection — keeps the header
  // upload's completion (also async, also unblocked from the rest of the
  // form) merging into whatever the user has done SINCE it started,
  // instead of the stale value/fallback this closure was created with.
  const valueRef = useRef(value)
  valueRef.current = value
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  const fallback = value.fallback
  const current = fallback ? toTemplateValue(fallback.template_name, fallback.language) : FALLBACK_NONE
  const selectedTemplate = fallback
    ? templates.find((tmpl) => toTemplateValue(tmpl.name, tmpl.language ?? "en_US") === current)
    : undefined
  const hasMatch = !fallback || !!selectedTemplate
  const variableNumbers = selectedTemplate ? extractTemplateVariables(selectedTemplate.body_text) : []
  const needsHeader = isMediaHeaderType(selectedTemplate?.header_type)

  function selectTemplate(v: string | null) {
    if (!v || v === FALLBACK_NONE) {
      onChange({ ...value, fallback: undefined })
      return
    }
    const [name, lang] = v.split("::")
    // A new template rarely means the same thing by the same {{n}} — and
    // may not even declare the header the old one did — so switching
    // drops stale variables/header rather than carrying them forward.
    onChange({
      ...value,
      fallback: { template_name: name ?? "", language: lang ?? "", variables: {} },
    })
  }

  function setVariable(n: number, v: string) {
    if (!fallback) return
    onChange({
      ...value,
      fallback: { ...fallback, variables: { ...fallback.variables, [String(n)]: v } },
    })
  }

  const handleHeaderFile = useCallback(
    async (file: File) => {
      if (!fallback || !selectedTemplate || !isMediaHeaderType(selectedTemplate.header_type)) return
      if (file.size > MEDIA_MAX_BYTES) {
        toast.error(
          t("composer.fileTooLarge", { size: (file.size / 1024 / 1024).toFixed(1) }),
        )
        return
      }
      // Captured before the await — this is what the SELECTED file was
      // actually validated against, so it stays pinned to this upload
      // regardless of what the template picker shows by the time it
      // finishes (same reasoning as AttachmentSection's `mediaType`).
      const headerType = selectedTemplate.header_type as FallbackHeaderType
      const templateIdentity = toTemplateValue(
        selectedTemplate.name,
        selectedTemplate.language ?? "en_US",
      )
      setHeaderUploading(true)
      try {
        const { key } = await uploadAccountMedia(convex, startUpload, file, "automation")
        const latest = valueRef.current
        const latestFallback = latest.fallback
        const stillSameTemplate =
          !!latestFallback &&
          toTemplateValue(latestFallback.template_name, latestFallback.language) === templateIdentity
        if (!latestFallback || !stillSameTemplate) {
          // The fallback was cleared, or switched to a different
          // template, while this header was uploading — attaching it now
          // would land on the wrong (or no) template, so it's dropped.
          toast.error(t("composer.uploadDiscardedStale"))
          return
        }
        // Merge into the LATEST config (not the value/fallback this
        // closure was created with), so a variable typed while this
        // upload was in flight survives.
        onChangeRef.current({
          ...latest,
          fallback: { ...latestFallback, header: { type: headerType, key } },
        })
        toast.success(t("composer.uploadSuccess"))
      } catch (err) {
        toast.error(err instanceof Error ? err.message : t("composer.uploadFailed"))
      } finally {
        setHeaderUploading(false)
      }
    },
    [convex, startUpload, fallback, selectedTemplate, t],
  )

  const headerDisplayName =
    fallback?.header?.key?.split("/").pop() || fallback?.header?.url?.split("/").pop() || ""

  // See the matching comment in AttachmentSection — `items` is required
  // for the trigger to show a real label instead of the raw sentinel/
  // "name::lang" value before the popup has ever been opened.
  const templateItems: Record<string, React.ReactNode> = {
    [FALLBACK_NONE]: t("composer.fallbackNone"),
  }
  for (const tmpl of templates) {
    const lang = tmpl.language ?? "en_US"
    templateItems[toTemplateValue(tmpl.name, lang)] = `${tmpl.name} (${lang})`
  }
  if (fallback && !hasMatch) {
    templateItems[current] = t("templates.unknown", {
      name: fallback.template_name,
      lang: fallback.language || t("templates.unknownLang"),
    })
  }

  return (
    <div>
      <p className="mb-2 text-xs text-muted-foreground">{t("composer.fallbackExplainer")}</p>
      <div className="rounded-md border border-border">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex w-full items-center justify-between px-3 py-2 text-left text-xs font-medium text-foreground"
        >
          <span>{t("composer.fallbackToggle")}</span>
          <ChevronDown
            className={cn("h-3.5 w-3.5 text-muted-foreground transition-transform", open && "rotate-180")}
          />
        </button>
        {open && (
          <div className="space-y-3 border-t border-border p-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                {t("composer.fallbackTemplateLabel")}
              </label>
              <Select value={current} onValueChange={selectTemplate} items={templateItems}>
                <SelectTrigger className="w-full bg-muted">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={FALLBACK_NONE}>{t("composer.fallbackNone")}</SelectItem>
                  {templates.map((tmpl) => {
                    const lang = tmpl.language ?? "en_US"
                    return (
                      <SelectItem key={tmpl.id} value={toTemplateValue(tmpl.name, lang)}>
                        {tmpl.name} ({lang})
                      </SelectItem>
                    )
                  })}
                  {/* Preserve a saved fallback template that's since been
                      unapproved/deleted, mirroring SendTemplateFields. */}
                  {fallback && !hasMatch && (
                    <SelectItem value={current}>
                      {t("templates.unknown", {
                        name: fallback.template_name,
                        lang: fallback.language || t("templates.unknownLang"),
                      })}
                    </SelectItem>
                  )}
                </SelectContent>
              </Select>
              {templates.length === 0 && (
                <p className="mt-1 text-[12px] text-muted-foreground">{t("composer.fallbackNoTemplates")}</p>
              )}
            </div>

            {!fallback && (
              <p className="text-xs text-amber-500">{t("composer.fallbackNoTemplateWarning")}</p>
            )}

            {variableNumbers.length > 0 && (
              <>
                <div className="grid grid-cols-2 gap-2">
                  {variableNumbers.map((n) => (
                    <div key={n}>
                      <label className="mb-1 block text-xs font-medium text-muted-foreground">
                        {t("composer.fallbackVariableLabel", { n })}
                      </label>
                      <Input
                        value={fallback?.variables?.[String(n)] ?? ""}
                        onChange={(e) => setVariable(n, e.target.value)}
                        className="bg-muted text-foreground"
                      />
                    </div>
                  ))}
                </div>
                <p className="text-[12px] text-muted-foreground">{t("composer.fallbackVariablesHelp")}</p>
              </>
            )}

            {needsHeader && fallback && (
              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground">
                  {t("composer.fallbackHeaderLabel")}
                </label>
                {fallback.header?.key || fallback.header?.url ? (
                  <div className="flex items-center gap-2 rounded-md border border-border bg-muted px-3 py-2 text-xs">
                    <Paperclip className="h-3.5 w-3.5 shrink-0 text-cyan-400" aria-hidden />
                    <span className="min-w-0 flex-1 truncate text-foreground">{headerDisplayName}</span>
                    <button
                      type="button"
                      onClick={() => onChange({ ...value, fallback: { ...fallback, header: undefined } })}
                      className="rounded p-1 text-muted-foreground hover:bg-background hover:text-foreground"
                      aria-label={t("composer.removeFile")}
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => headerInputRef.current?.click()}
                    disabled={headerUploading}
                    className="flex w-full items-center justify-center gap-2 rounded-md border border-dashed border-border bg-card px-3 py-4 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {headerUploading ? (
                      <>
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        {t("composer.uploading")}
                      </>
                    ) : (
                      <>
                        <Upload className="h-3.5 w-3.5" />
                        {t("composer.clickToUpload")}
                      </>
                    )}
                  </button>
                )}
                {/* validate.ts can only see step_config, not the template's
                    own header_type, so it has no way to reject an
                    activation that leaves a required header unfilled —
                    this client-side warning is the only guard. Without
                    it, activation passes, and at send time `cfg.header`
                    is undefined so only the body component reaches Meta,
                    which 400s with the opaque error 132000 this branch
                    exists to eliminate. */}
                {!fallback.header?.key && !fallback.header?.url && (
                  <p className="mt-1 text-xs text-amber-500">
                    {t("composer.headerRequiredWarning")}
                  </p>
                )}
                <input
                  ref={headerInputRef}
                  type="file"
                  accept={
                    isMediaHeaderType(selectedTemplate?.header_type)
                      ? MEDIA_ACCEPT[selectedTemplate!.header_type as MediaAttachmentType]
                      : undefined
                  }
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0]
                    if (f) void handleHeaderFile(f)
                    e.target.value = ""
                  }}
                />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
