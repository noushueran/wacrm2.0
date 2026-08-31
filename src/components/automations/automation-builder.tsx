"use client"

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"
import { useRouter } from "next/navigation"
import { useConvex, useMutation } from "convex/react"
import { useQuery } from "@/lib/convex/cached"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import {
  ArrowLeft,
  ChevronDown,
  Trash2,
  GripVertical,
  MessageSquare,
  FileText,
  Tag,
  TagIcon,
  UserCheck,
  PencilLine,
  Briefcase,
  Hourglass,
  GitBranch,
  Webhook,
  CircleSlash,
  Zap,
  Loader2,
  ArrowDown,
  ArrowUp,
  MousePointerClick,
  List,
  Paperclip,
  Upload,
  X,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Switch } from "@/components/ui/switch"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import type {
  AutomationStepType,
  AutomationTriggerType,
  CustomField,
  InteractiveMessagePayload,
  KeywordMatchTriggerConfig,
  MessageTemplate,
  Profile,
  SendMessageStepConfig,
  SendTemplateStepConfig,
  Tag as TagRecord,
} from "@/types"
import {
  blankButtonsPayload,
  blankListPayload,
} from "@/components/interactive/interactive-builder"
import { SendComposer } from "./send-composer"
import { TemplatePreview } from "./message-preview"
import { ActionPicker } from "./action-picker"
import { StepIssues, useStepIssues, type ValidationIssue } from "./step-issues"
import { interactivePayloadPreviewText } from "@/lib/whatsapp/interactive"
import { uploadAccountMedia, MEDIA_MAX_BYTES } from "@/lib/storage/upload-media"
import {
  convexErrorMessage,
  toUiCustomField,
  toUiMemberProfile,
  toUiPipeline,
  toUiPipelineStage,
  toUiTag,
  toUiTemplate,
} from "@/lib/convex/adapters"
import { cn } from "@/lib/utils"

import { api } from "../../../convex/_generated/api"
import type { Id } from "../../../convex/_generated/dataModel"
import { extractTemplateVariables } from "../../../convex/lib/automations/templateVars"

// ------------------------------------------------------------
// Types (builder-local — mirror the flattened rows we POST)
// ------------------------------------------------------------

export interface BuilderStep {
  /** Client-local id (list keys, expand/collapse state). Also the
   *  fallback source `toApiSteps` sends as `id` for a step that has never
   *  been saved — see `step_key`. */
  cid: string
  /** The server's stable per-step key (`automationSteps.stepKey`), once
   *  this step has been saved at least once — populated by
   *  `fromServerSteps` from the tree `automations.get` returns. Undefined
   *  for a step added in this editing session that has never been saved,
   *  in which case `toApiSteps` falls back to `cid`. */
  step_key?: string
  /** `stepKey ?? _id` — `stepsTree.ts`'s `BuilderStepNode.effectiveStepKey`,
   *  round-tripped by `fromServerSteps`. USE THIS for looking a step up in
   *  `stepStats` (Task 8's canvas chips): a step saved before Task 10's
   *  stepKey migration has `step_key === undefined` but still has
   *  accumulated stats, filed under its row's `_id` (see
   *  `automationsEngine.ts`'s own `step.stepKey ?? step._id` at write
   *  time) — `effective_step_key` is what actually matches those rows.
   *  Undefined for a step added this session that has never been saved,
   *  same as `step_key`. Deliberately NOT read by `toApiSteps` — see
   *  `effectiveStepKey`'s own comment in `stepsTree.ts` for why the save
   *  path must keep using `step_key` alone. */
  effective_step_key?: string
  step_type: AutomationStepType
  step_config: Record<string, unknown>
  branches?: { yes: BuilderStep[]; no: BuilderStep[] }
}

export interface BuilderInitial {
  id?: string
  name: string
  description: string
  trigger_type: AutomationTriggerType
  trigger_config: Record<string, unknown>
  is_active: boolean
  steps: BuilderStep[]
  /** See `convex/schema.ts`'s comment on `automations.stopOnReply`.
   *  Defaults to `false` for a brand-new draft and for any automation
   *  saved before this field existed (see `toUiAutomation`). */
  stop_on_reply: boolean
}

// ------------------------------------------------------------
// Step metadata — one source of truth for icon + label + border color
// ------------------------------------------------------------

interface StepMeta {
  label: string
  icon: typeof Zap
  /** Left-border accent color per spec. */
  border: string
}

// Exported for action-picker.tsx — the single source of truth for each
// step's icon/label, including send_buttons/send_list, which never
// appear in the add-step picker (see action-catalog.ts) but must still
// render correctly wherever an already-stored step of one of those two
// types shows up on the canvas.
export const STEP_META: Record<AutomationStepType, StepMeta> = {
  send_message: { label: "send_message", icon: MessageSquare, border: "border-l-primary" },
  send_buttons: { label: "send_buttons", icon: MousePointerClick, border: "border-l-primary" },
  send_list: { label: "send_list", icon: List, border: "border-l-primary" },
  send_template: { label: "send_template", icon: FileText, border: "border-l-primary" },
  add_tag: { label: "add_tag", icon: Tag, border: "border-l-primary" },
  remove_tag: { label: "remove_tag", icon: TagIcon, border: "border-l-primary" },
  assign_conversation: { label: "assign_conversation", icon: UserCheck, border: "border-l-primary" },
  update_contact_field: { label: "update_contact_field", icon: PencilLine, border: "border-l-primary" },
  create_deal: { label: "create_deal", icon: Briefcase, border: "border-l-primary" },
  wait: { label: "wait", icon: Hourglass, border: "border-l-border" },
  condition: { label: "condition", icon: GitBranch, border: "border-l-amber-500" },
  send_webhook: { label: "send_webhook", icon: Webhook, border: "border-l-primary" },
  close_conversation: { label: "close_conversation", icon: CircleSlash, border: "border-l-primary" },
}

const TRIGGER_OPTIONS: { value: AutomationTriggerType }[] = [
  { value: "new_message_received" },
  { value: "first_inbound_message" },
  { value: "keyword_match" },
  { value: "interactive_reply" },
  { value: "new_contact_created" },
  { value: "conversation_assigned" },
  { value: "tag_added" },
  { value: "time_based" },
]

function cid(): string {
  return (
    "c_" +
    (typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2) + Date.now().toString(36))
  )
}

// The send_buttons / send_list step_config IS an InteractiveMessagePayload,
// but step_config is typed generically as Record<string, unknown>. These two
// helpers hold the single unavoidable structural cast in one place so a
// payload-shape change has one seam to update instead of four scattered
// `as unknown as` sites.
function toStepConfig(p: InteractiveMessagePayload): Record<string, unknown> {
  return p as unknown as Record<string, unknown>
}
function asInteractive(cfg: Record<string, unknown>): InteractiveMessagePayload {
  return cfg as unknown as InteractiveMessagePayload
}

// Same cast-seam pattern as toStepConfig/asInteractive above, for
// send_message's SendComposer shape instead of the raw interactive payload.
function toSendConfig(cfg: SendMessageStepConfig): Record<string, unknown> {
  return cfg as unknown as Record<string, unknown>
}
function asSendConfig(cfg: Record<string, unknown>): SendMessageStepConfig {
  return cfg as unknown as SendMessageStepConfig
}

// Same cast-seam pattern again, for SendTemplateFields' whole-config
// contract (template_name/language/variables/header).
function toSendTemplateConfig(cfg: SendTemplateStepConfig): Record<string, unknown> {
  return cfg as unknown as Record<string, unknown>
}
function asSendTemplateConfig(cfg: Record<string, unknown>): SendTemplateStepConfig {
  return cfg as unknown as SendTemplateStepConfig
}

function blankConfig(type: AutomationStepType): Record<string, unknown> {
  switch (type) {
    case "send_message":
      return { text: "" }
    case "send_buttons":
      return toStepConfig(blankButtonsPayload())
    case "send_list":
      return toStepConfig(blankListPayload())
    case "send_template":
      return { template_name: "", language: "en_US" }
    case "add_tag":
    case "remove_tag":
      return { tag_id: "" }
    case "assign_conversation":
      return { mode: "round_robin" }
    case "update_contact_field":
      return { field: "name", value: "" }
    case "create_deal":
      return { pipeline_id: "", stage_id: "", title: "", value: 0 }
    case "wait":
      return { amount: 1, unit: "hours" }
    case "condition":
      return { subject: "tag_presence", operand: "", value: "" }
    case "send_webhook":
      return { url: "", headers: {}, body_template: "" }
    case "close_conversation":
      return {}
    default:
      return {}
  }
}

// ------------------------------------------------------------
// Account resources (tags, members, approved templates, pipelines)
//
// Loaded once at the builder root and shared via context so the
// tag / agent / template pickers below can offer existing resources
// by name instead of asking the user to paste raw UUIDs. Every picker
// falls back to a raw input when its list is empty (fresh account or
// an older deployment), so an automation is always authorable.
// ------------------------------------------------------------

interface AutomationResources {
  tags: TagRecord[]
  members: Profile[]
  templates: MessageTemplate[]
  customFields: CustomField[]
  pipelines: PipelineOption[]
  stages: PipelineStageOption[]
}

interface PipelineOption {
  id: string
  name: string
}

interface PipelineStageOption {
  id: string
  name: string
  pipeline_id: string
  position: number
}

/** The "no provider above me" sentinel. Compared by IDENTITY in
 *  `ResourcesProvider` below, so it must stay a single frozen module-level
 *  object — a fresh `{tags: [], ...}` literal would compare unequal and
 *  defeat the check. */
const EMPTY_RESOURCES: AutomationResources = Object.freeze({
  tags: [],
  members: [],
  templates: [],
  customFields: [],
  pipelines: [],
  stages: [],
})

const ResourcesContext = createContext<AutomationResources>(EMPTY_RESOURCES)

/** Exported so `send-composer.tsx` (the SendComposer's fallback-template
 *  picker) can read the same account resources without a second query. */
export function useResources(): AutomationResources {
  return useContext(ResourcesContext)
}

// ------------------------------------------------------------
// Per-step run stats (Task 8) — `api.automations.stepStats`, keyed on
// `stepKey` (NOT `stepId`/`_id`; see convex/automations.ts's own comment
// on why `automationSteps._id` churns on every save). Queried once at
// the builder root and handed down via context, sibling to
// `ResourcesContext` above, so every collapsed step card can look up its
// own row by `step.step_key` without each one running its own query.
// Deliberately a SEPARATE context rather than folded into
// `AutomationResources`: resources are account-wide and load in every
// mode, while this is per-automation and explicitly skipped in "new
// automation" mode (no id yet to query against).
// ------------------------------------------------------------

export interface StepStatsEntry {
  reached: number
  sent: number
  failed: number
  waiting: number
}

const StepStatsContext = createContext<Map<string, StepStatsEntry>>(new Map())

function useStepStats(): Map<string, StepStatsEntry> {
  return useContext(StepStatsContext)
}

/**
 * Mounts the account-resource queries — unless an ancestor already did.
 *
 * Exported so a route can hoist it ABOVE its own loading gate. On
 * `/automations/[id]/edit` the builder does not mount until
 * `automations.get` resolves, and these five queries only started when
 * the builder mounted — so the page paid two SEQUENTIAL round trips
 * (~200ms each against the self-hosted backend) before rendering
 * anything. Wrapping the route in this provider starts all six queries
 * in the same tick instead.
 *
 * The identity check makes the hoist safe rather than duplicative:
 * `AutomationBuilder` still renders its own `<ResourcesProvider>` (so
 * `/automations/new`, which has no gate to hoist past, keeps working
 * untouched), and when a route has already provided resources the inner
 * one degrades to a pass-through instead of opening a second set of
 * subscriptions. The branch is stable across a mount — the querying
 * provider never publishes `EMPTY_RESOURCES` — so this never swaps
 * component types mid-life and never remounts the builder subtree.
 */
export function ResourcesProvider({ children }: { children: ReactNode }) {
  const inherited = useContext(ResourcesContext)
  if (inherited !== EMPTY_RESOURCES) return <>{children}</>
  return <ResourcesQueryProvider>{children}</ResourcesQueryProvider>
}

function ResourcesQueryProvider({ children }: { children: ReactNode }) {
  // Tags, templates and custom fields come straight from Convex —
  // `accountQuery` scopes them to the caller's account. Only APPROVED
  // templates can actually be sent (anything else 400s at send time,
  // matching the broadcast picker), and `templates.list`/`tags.list`
  // don't sort server-side, so both are alphabetized here the same way
  // the old Supabase `.order("name")` did. Members go through
  // `members.list` so the agent picker inherits its email-visibility
  // rule (agents/viewers get a nulled `email` — see convex/members.ts).
  const tagsResult = useQuery(api.tags.list)
  const templatesResult = useQuery(api.templates.list)
  const customFieldsResult = useQuery(api.customFields.list)
  const pipelinesResult = useQuery(api.pipelines.list)
  const membersResult = useQuery(api.members.list)

  const tags = useMemo(
    () => (tagsResult ?? []).map(toUiTag).sort((a, b) => a.name.localeCompare(b.name)),
    [tagsResult],
  )
  const templates = useMemo(
    () =>
      (templatesResult ?? [])
        .filter((doc) => doc.status === "APPROVED")
        .map(toUiTemplate)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [templatesResult],
  )
  const customFields = useMemo(
    () => (customFieldsResult ?? []).map(toUiCustomField),
    [customFieldsResult],
  )
  const rawPipelines = useMemo(() => pipelinesResult ?? [], [pipelinesResult])
  const pipelines = useMemo(() => rawPipelines.map(toUiPipeline), [rawPipelines])
  const stages = useMemo(
    () => rawPipelines.flatMap((p) => p.stages.map(toUiPipelineStage)),
    [rawPipelines],
  )
  const members = useMemo(
    () => (membersResult ?? []).map(toUiMemberProfile),
    [membersResult],
  )

  // Memoized: this was a fresh object literal on every render, so every
  // `useResources()` consumer in the step tree re-rendered whenever the
  // builder did, no matter that the resources themselves were unchanged.
  const value = useMemo(
    () => ({ tags, members, templates, customFields, pipelines, stages }),
    [tags, members, templates, customFields, pipelines, stages],
  )

  return (
    <ResourcesContext.Provider value={value}>
      {children}
    </ResourcesContext.Provider>
  )
}

const SELECT_CLASS =
  "w-full rounded-md border border-border bg-muted px-2 py-1.5 text-sm text-foreground focus:border-primary focus:outline-none"

/** Tag dropdown by name + color, storing the tag's id. Falls back to a
 *  raw id input when no tags exist yet. */
function TagSelect({
  value,
  onChange,
  t,
}: {
  value: string
  onChange: (v: string) => void
  t: ReturnType<typeof useTranslations>
}) {
  const { tags } = useResources()
  if (tags.length === 0) {
    return (
      <Input
        placeholder={t("tags.placeholder")}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="bg-muted text-foreground"
      />
    )
  }
  const selected = tags.find((t) => t.id === value)
  return (
    <div className="flex items-center gap-2">
      <span
        className="h-3 w-3 shrink-0 rounded-full border border-border"
        style={{ backgroundColor: selected?.color ?? "transparent" }}
        aria-hidden
      />
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={SELECT_CLASS}
      >
        <option value="">{t("tags.select")}</option>
        {tags.map((tg) => (
          <option key={tg.id} value={tg.id}>
            {tg.name}
          </option>
        ))}
        {/* Preserve a saved tag that's since been deleted so editing an
            existing automation doesn't silently drop it. */}
        {value && !selected && (
          <option value={value}>{t("tags.unknown", { id: value })}</option>
        )}
      </select>
    </div>
  )
}

/** Contact-field dropdown for "Update Contact Field": built-in columns plus
 *  any account custom fields (stored as `custom:<id>`). A saved custom field
 *  that's since been deleted is preserved as a labelled option so editing an
 *  existing automation doesn't silently drop it. */
function ContactFieldSelect({
  value,
  onChange,
  t,
}: {
  value: string
  onChange: (v: string) => void
  t: ReturnType<typeof useTranslations>
}) {
  const { customFields } = useResources()
  const customValue = value.startsWith("custom:") ? value : ""
  const knownCustom =
    customValue && customFields.some((f) => `custom:${f.id}` === customValue)
  return (
    <select
      value={value || "name"}
      onChange={(e) => onChange(e.target.value)}
      className={SELECT_CLASS}
    >
      <option value="name">{t("fields.name")}</option>
      <option value="email">{t("fields.email")}</option>
      <option value="company">{t("fields.company")}</option>
      {customFields.length > 0 && (
        <optgroup label={t("fields.customFields")}>
          {customFields.map((f) => (
            <option key={f.id} value={`custom:${f.id}`}>
              {f.field_name}
            </option>
          ))}
        </optgroup>
      )}
      {customValue && !knownCustom && (
        <option value={customValue}>{t("fields.unknown", { id: customValue })}</option>
      )}
    </select>
  )
}

/** Agent dropdown by name, storing the member's user_id. Falls back to
 *  a raw id input when the member list is unavailable. */
function AgentSelect({
  value,
  onChange,
  t,
}: {
  value: string
  onChange: (v: string) => void
  t: ReturnType<typeof useTranslations>
}) {
  const { members } = useResources()
  if (members.length === 0) {
    return (
      <Input
        placeholder={t("agents.placeholder")}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="bg-muted text-foreground"
      />
    )
  }
  const selected = members.find((m) => m.user_id === value)
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={SELECT_CLASS}
    >
      <option value="">{t("agents.select")}</option>
      {members.map((m) => (
        <option key={m.user_id} value={m.user_id}>
          {m.full_name || m.email || m.user_id}
        </option>
      ))}
      {value && !selected && (
        <option value={value}>{t("agents.unknown", { id: value })}</option>
      )}
    </select>
  )
}

/** Pipeline + stage picker for Create Deal. The automation stores ids because
 *  the engine writes directly to deals, but authors should choose by name. */
function DealPipelineFields({
  pipelineId,
  stageId,
  onChange,
  t,
}: {
  pipelineId: string
  stageId: string
  onChange: (patch: { pipeline_id: string; stage_id: string }) => void
  t: ReturnType<typeof useTranslations>
}) {
  const { pipelines, stages } = useResources()

  if (pipelines.length === 0) {
    return (
      <>
        <FieldBlock label={t("pipelines.pipelineIdLabel")}>
          <Input
            value={pipelineId}
            onChange={(e) =>
              onChange({ pipeline_id: e.target.value, stage_id: stageId })
            }
            className="bg-muted text-foreground"
          />
        </FieldBlock>
        <FieldBlock label={t("pipelines.stageIdLabel")}>
          <Input
            value={stageId}
            onChange={(e) =>
              onChange({ pipeline_id: pipelineId, stage_id: e.target.value })
            }
            className="bg-muted text-foreground"
          />
        </FieldBlock>
      </>
    )
  }

  const selectedPipeline = pipelines.find((p) => p.id === pipelineId)
  const stageOptions = stages.filter((s) => s.pipeline_id === pipelineId)
  const selectedStage = stageOptions.find((s) => s.id === stageId)

  return (
    <>
      <FieldBlock label={t("pipelines.pipelineLabel")}>
        <select
          value={pipelineId}
          onChange={(e) => {
            const nextPipelineId = e.target.value
            const firstStage = stages.find(
              (s) => s.pipeline_id === nextPipelineId
            )
            onChange({
              pipeline_id: nextPipelineId,
              stage_id: firstStage?.id ?? "",
            })
          }}
          className={SELECT_CLASS}
        >
          <option value="">{t("pipelines.selectPipeline")}</option>
          {pipelines.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
          {pipelineId && !selectedPipeline && (
            <option value={pipelineId}>{t("pipelines.unknownPipeline", { id: pipelineId })}</option>
          )}
        </select>
      </FieldBlock>
      <FieldBlock label={t("pipelines.stageLabel")}>
        <select
          value={stageId}
          onChange={(e) =>
            onChange({ pipeline_id: pipelineId, stage_id: e.target.value })
          }
          className={SELECT_CLASS}
          disabled={!pipelineId || stageOptions.length === 0}
        >
          <option value="">
            {pipelineId ? t("pipelines.selectStage") : t("pipelines.selectPipelineFirst")}
          </option>
          {stageOptions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
          {stageId && pipelineId && !selectedStage && (
            <option value={stageId}>{t("pipelines.unknownStage", { id: stageId })}</option>
          )}
        </select>
      </FieldBlock>
    </>
  )
}

type TemplateHeaderType = NonNullable<SendTemplateStepConfig["header"]>["type"]

/** Mirrors `send-composer.tsx`'s `isMediaHeaderType` — kept as a separate
 *  copy rather than imported, since send-composer.tsx already imports
 *  `useResources` from this file; importing back would close a circular
 *  dependency between the two. */
function isTemplateHeaderMediaType(
  headerType: MessageTemplate["header_type"],
): headerType is TemplateHeaderType {
  return headerType === "image" || headerType === "video" || headerType === "document"
}

// Mirrors send-composer.tsx's MEDIA_ACCEPT for the same three kinds —
// WhatsApp template headers support image/video/document, never audio.
const TEMPLATE_HEADER_ACCEPT: Record<TemplateHeaderType, string> = {
  image: "image/png,image/jpeg,image/webp",
  video: "video/mp4,video/3gpp",
  document:
    "application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.presentationml.presentation,text/plain",
}

// Encode name + language in a select option value so two templates that
// share a name across languages stay distinct. Module-level (rather than
// defined inside SendTemplateFields, as it used to be) so handleHeaderFile's
// useCallback below can depend on a referentially-stable function instead
// of a fresh closure every render.
function toTemplateValue(name: string, lang: string): string {
  return `${name}::${lang}`
}

/** Template dropdown showing approved templates by name + language,
 *  storing template_name/language/variables/header. Falls back to manual
 *  name + language inputs when no approved templates are synced yet. */
function SendTemplateFields({
  cfg,
  onChange,
  t,
}: {
  cfg: SendTemplateStepConfig
  onChange: (next: SendTemplateStepConfig) => void
  t: ReturnType<typeof useTranslations>
}) {
  const { templates } = useResources()
  const convex = useConvex()
  const startUpload = useMutation(api.files.startUpload)
  const [headerUploading, setHeaderUploading] = useState(false)
  const headerInputRef = useRef<HTMLInputElement>(null)

  // Stale-closure guard for the async upload below — same pattern, and
  // same reason, as send-composer.tsx's handleHeaderFile: assigned in the
  // render body (not an effect) so the upload's await continuation reads
  // whatever the user has done SINCE the upload started, not the cfg this
  // callback closed over.
  const cfgRef = useRef(cfg)
  cfgRef.current = cfg
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  const templateName = cfg.template_name ?? ""
  const language = cfg.language ?? ""
  const current = templateName ? toTemplateValue(templateName, language) : ""
  const selectedTemplate = templates.find(
    (tmpl) => toTemplateValue(tmpl.name, tmpl.language ?? "en_US") === current,
  )
  const hasMatch = !!selectedTemplate
  const variableNumbers = selectedTemplate ? extractTemplateVariables(selectedTemplate.body_text) : []
  const needsHeader = isTemplateHeaderMediaType(selectedTemplate?.header_type)

  const handleHeaderFile = useCallback(
    async (file: File) => {
      if (!selectedTemplate || !isTemplateHeaderMediaType(selectedTemplate.header_type)) return
      if (file.size > MEDIA_MAX_BYTES) {
        toast.error(t("composer.fileTooLarge", { size: (file.size / 1024 / 1024).toFixed(1) }))
        return
      }
      // Captured before the await — pinned to the template that was
      // actually selected when THIS upload started, regardless of what
      // the picker shows by the time it resolves (same reasoning as
      // send-composer.tsx's `headerType`/`templateIdentity`).
      const headerType = selectedTemplate.header_type as TemplateHeaderType
      const templateIdentity = toTemplateValue(selectedTemplate.name, selectedTemplate.language ?? "en_US")
      setHeaderUploading(true)
      try {
        const { key } = await uploadAccountMedia(convex, startUpload, file, "automation")
        const latest = cfgRef.current
        const latestIdentity = latest.template_name
          ? toTemplateValue(latest.template_name, latest.language ?? "")
          : ""
        if (latestIdentity !== templateIdentity) {
          // The template selection changed (or was cleared) while this
          // upload was in flight — attaching it now would land on the
          // wrong (or no) template, so it's dropped instead, loudly.
          toast.error(t("composer.uploadDiscardedStale"))
          return
        }
        // Merge into the LATEST config (not the cfg this closure was
        // created with), so an edit made while this upload was in flight
        // survives.
        onChangeRef.current({ ...latest, header: { type: headerType, key } })
        toast.success(t("composer.uploadSuccess"))
      } catch (err) {
        toast.error(err instanceof Error ? err.message : t("composer.uploadFailed"))
      } finally {
        setHeaderUploading(false)
      }
    },
    [convex, startUpload, selectedTemplate, t],
  )

  function selectTemplate(name: string, lang: string) {
    // A new template rarely means the same thing by the same {{n}}, and
    // may not even declare the header the old one did — so switching
    // drops stale variables/header rather than carrying them forward.
    onChange({ template_name: name, language: lang, variables: {} })
  }

  function setVariable(n: number, v: string) {
    onChange({ ...cfg, variables: { ...cfg.variables, [String(n)]: v } })
  }

  if (templates.length === 0) {
    return (
      <>
        <FieldBlock label={t("templates.templateNameLabel")}>
          <Input
            value={templateName}
            onChange={(e) => onChange({ ...cfg, template_name: e.target.value })}
            className="bg-muted text-foreground"
          />
        </FieldBlock>
        <FieldBlock label={t("templates.languageLabel")}>
          <Input
            value={language}
            onChange={(e) => onChange({ ...cfg, language: e.target.value })}
            className="bg-muted text-foreground"
          />
        </FieldBlock>
      </>
    )
  }

  const headerDisplayName =
    cfg.header?.key?.split("/").pop() || cfg.header?.url?.split("/").pop() || ""

  return (
    <>
      <FieldBlock label={t("templates.templateLabel")}>
        <select
          value={current}
          onChange={(e) => {
            const [name, lang] = e.target.value.split("::")
            selectTemplate(name ?? "", lang ?? "")
          }}
          className={SELECT_CLASS}
        >
          <option value="">{t("templates.select")}</option>
          {templates.map((tmpl) => {
            const lang = tmpl.language ?? "en_US"
            return (
              <option key={tmpl.id} value={toTemplateValue(tmpl.name, lang)}>
                {tmpl.name} ({lang})
              </option>
            )
          })}
          {current && !hasMatch && (
            <option value={current}>
              {t("templates.unknown", { name: templateName, lang: language || t("templates.unknownLang") })}
            </option>
          )}
        </select>
      </FieldBlock>

      {variableNumbers.length > 0 && (
        <>
          {variableNumbers.map((n) => (
            <FieldBlock key={n} label={t("templates.variableLabel", { n })}>
              <Input
                value={cfg.variables?.[String(n)] ?? ""}
                onChange={(e) => setVariable(n, e.target.value)}
                className="bg-muted text-foreground"
              />
            </FieldBlock>
          ))}
          <p className="mb-2 text-[12px] text-muted-foreground">{t("composer.fallbackVariablesHelp")}</p>
        </>
      )}

      {needsHeader && (
        <FieldBlock label={t("templates.headerLabel")}>
          {cfg.header?.key || cfg.header?.url ? (
            <div className="flex items-center gap-2 rounded-md border border-border bg-muted px-3 py-2 text-xs">
              <Paperclip className="h-3.5 w-3.5 shrink-0 text-cyan-400" aria-hidden />
              <span className="min-w-0 flex-1 truncate text-foreground">{headerDisplayName}</span>
              <button
                type="button"
                onClick={() => onChange({ ...cfg, header: undefined })}
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
          {/* The Convex validator only sees step_config, not the
              template's own header_type, so it can't refuse activation
              over a missing header — this client-side warning is the
              only guard. Without it, activation passes, and at send time
              `cfg.header` is undefined so only the body component reaches
              Meta, which 400s with the opaque error 132000 this branch
              exists to eliminate. */}
          {!cfg.header?.key && !cfg.header?.url && (
            <p className="mt-1 text-xs text-amber-500">{t("composer.headerRequiredWarning")}</p>
          )}
          <input
            ref={headerInputRef}
            type="file"
            accept={
              isTemplateHeaderMediaType(selectedTemplate?.header_type)
                ? TEMPLATE_HEADER_ACCEPT[selectedTemplate!.header_type as TemplateHeaderType]
                : undefined
            }
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) void handleHeaderFile(f)
              e.target.value = ""
            }}
          />
        </FieldBlock>
      )}

      <div className="mt-3 border-t border-border pt-3">
        {/* I-4 fix: `selectedTemplate` is `undefined` both for "nothing
            chosen yet" (`current === ""`) and for "template_name is set but
            no longer in the resolved approved list" (deleted/unapproved
            since this step was configured) — the latter still passes
            `validateStepsForActivation` and the engine WILL attempt the
            send, so it must not read as "Nothing to send yet.". Reuses the
            EXACT same t("templates.unknown", ...) call the <select>'s own
            fallback <option> above uses, so the two can never disagree
            about what "not found" means or looks like. Only reachable once
            `templates.length > 0` (this whole branch is gated on that), so
            `templatesLoading` can never be true here — see
            resolveTemplatePreview's own comment for the loading case. */}
        <TemplatePreview
          body={selectedTemplate?.body_text ?? ""}
          notFoundLabel={
            current && !hasMatch
              ? t("templates.unknown", { name: templateName, lang: language || t("templates.unknownLang") })
              : undefined
          }
          variables={cfg.variables}
        />
      </div>
    </>
  )
}

// ------------------------------------------------------------
// Main builder component
// ------------------------------------------------------------

export function AutomationBuilder({ initial }: { initial: BuilderInitial }) {
  const router = useRouter()
  const t = useTranslations("Automations.builder")
  const isEditing = !!initial.id
  const [state, setState] = useState<BuilderInitial>(initial)
  const [saving, setSaving] = useState(false)
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const createAutomation = useMutation(api.automations.create)
  const updateAutomation = useMutation(api.automations.update)

  // Task 8 — per-step chips. Skipped in "new automation" mode: there is
  // no automationId yet, and a step's `step_key` (see `BuilderStep`'s own
  // comment) is only ever populated by the server round-trip anyway, so a
  // brand-new draft's steps could never match a stats row regardless.
  const stepStatsResult = useQuery(
    api.automations.stepStats,
    initial.id ? { automationId: initial.id as Id<"automations"> } : "skip",
  )
  const stepStatsMap = useMemo(() => {
    const map = new Map<string, StepStatsEntry>()
    for (const row of stepStatsResult ?? []) {
      map.set(row.stepKey, {
        reached: row.reached,
        sent: row.sent,
        failed: row.failed,
        waiting: row.waiting,
      })
    }
    return map
  }, [stepStatsResult])

  // Task 4 (Phase 3 builder-ux) — inline validation. Runs the exact
  // function the server gates activation on
  // (`convex/automations.ts`'s `assertActivatable`), so this and the
  // server's VALIDATION_FAILED refusal can never disagree about what
  // counts as broken. `state.steps` (`BuilderStep[]`) satisfies
  // `useStepIssues`'s structural `StepTreeNode` requirement with no cast
  // — see step-issues.tsx's own comment on why.
  const {
    issues: stepIssuesList,
    byPath: stepIssuesByPath,
    unattached: unattachedStepIssues,
  } = useStepIssues(state.steps)
  const hasStepIssues = stepIssuesList.length > 0
  // Only blocks turning it ON. `convex/automations.ts`'s own
  // `assertActivatable` comment is explicit that "draft saves and
  // deactivations are never validated" — an automation that's already
  // active and gets edited into a broken (unsaved) state must still be
  // switchable back OFF without first fixing the field, matching that
  // server-side invariant.
  const activeToggleDisabled = hasStepIssues && !state.is_active
  // Fix round (code review) — `save()` always sends `isActive:
  // state.is_active` explicitly (see `save()` below, and its call sites'
  // `isActive: state.is_active`), so it mirrors `convex/automations.ts`'s
  // `update`'s own `willBeActive = rest.isActive !== undefined ?
  // rest.isActive : existing.isActive` exactly — there is no "field
  // omitted, fall back to whatever's stored" branch to reproduce here,
  // because this client never omits it. The server validates whenever a
  // write would LEAVE the automation active, not only when a request
  // flips it on: an already-active automation edited into a broken state
  // and saved with the switch untouched still sends `isActive: true`
  // unchanged, so `willBeActive` is true and the server's
  // `assertActivatable` rejects with `VALIDATION_FAILED` — after a round
  // trip, which is exactly the failure this task exists to move earlier.
  // `activeToggleDisabled` above only gated the switch itself, leaving
  // this path — the single most ordinary one, editing a live automation
  // and hitting Save — ungated. Blocking Save only when it would leave
  // the automation active matches the switch's own reasoning: a save
  // that deactivates a broken automation, or a draft save on one that's
  // already inactive, must still go through untouched (same server
  // invariant `assertActivatable`'s comment states).
  const saveBlocked = state.is_active && hasStepIssues
  // `bucketIssuesByStepPath` inserts keys in the order issues are
  // encountered, which is validate.ts's own walk order — so the first key
  // here is the first-offending step, exactly what "scroll to the first
  // offending card" means. `undefined` when every issue is unattachable
  // (e.g. the zero-steps case has no card at all to point at).
  const firstOffendingPath: string | undefined = Array.from(stepIssuesByPath.keys())[0]

  function scrollToFirstIssue() {
    if (!firstOffendingPath) return
    const targetCid = findCidForStepPath(state.steps, firstOffendingPath)
    if (targetCid) setExpandedId(targetCid)
    // Defer to the next frame so a card that was just expanded has
    // actually laid out — scrolling in the same tick would still target
    // its collapsed height/position.
    requestAnimationFrame(() => {
      document
        .getElementById(`automation-step-${firstOffendingPath}`)
        ?.scrollIntoView({ behavior: "smooth", block: "center" })
    })
  }

  function patchTop<K extends keyof BuilderInitial>(key: K, value: BuilderInitial[K]) {
    setState((s) => ({ ...s, [key]: value }))
  }

  // --- Step tree mutations (immutable) ---

  function updateStep(path: StepPath, updater: (s: BuilderStep) => BuilderStep) {
    setState((s) => ({ ...s, steps: mapAtPath(s.steps, path, updater) }))
  }

  function addStepAt(parent: ParentScope, index: number, type: AutomationStepType) {
    const node: BuilderStep = {
      cid: cid(),
      step_type: type,
      step_config: blankConfig(type),
      branches: type === "condition" ? { yes: [], no: [] } : undefined,
    }
    setState((s) => ({ ...s, steps: insertAt(s.steps, parent, index, node) }))
    setExpandedId(node.cid)
  }

  function deleteStepAt(path: StepPath) {
    setState((s) => ({ ...s, steps: removeAt(s.steps, path) }))
  }

  function moveStepAt(path: StepPath, direction: -1 | 1) {
    setState((s) => ({ ...s, steps: moveAt(s.steps, path, direction) }))
  }

  async function save() {
    setSaving(true)
    try {
      const steps = toApiSteps(state.steps)
      const name = state.name || "Untitled automation"

      if (isEditing) {
        await updateAutomation({
          automationId: initial.id as Id<"automations">,
          name,
          description: state.description || undefined,
          triggerType: state.trigger_type,
          triggerConfig: state.trigger_config,
          isActive: state.is_active,
          steps,
          stopOnReply: state.stop_on_reply,
        })
        toast.success(t("toasts.saved"))
      } else {
        const newId = await createAutomation({
          name,
          description: state.description || undefined,
          triggerType: state.trigger_type,
          triggerConfig: state.trigger_config,
          isActive: state.is_active,
          steps,
          stopOnReply: state.stop_on_reply,
        })
        toast.success(t("toasts.created"))
        router.replace(`/automations/${newId}/edit`)
      }
    } catch (err) {
      // `convex/automations.ts`'s `update`/`create` DO run the same
      // `VALIDATION_FAILED` activation gate `saveBlocked` pre-empts below
      // (see that file's `assertActivatable`) — this stale comment used to
      // claim otherwise, from before that gate existed. `saveBlocked`
      // covers the step-level issues `useStepIssues` computes, but not
      // `validateTriggerForActivation`'s trigger-config checks (out of
      // this task's scope — see step-issues.tsx), so a trigger-only
      // failure can still reach here; `convexErrorMessage` surfaces it as
      // a readable toast rather than a raw Convex error.
      toast.error(convexErrorMessage(err) || t("toasts.saveFailed"))
    } finally {
      setSaving(false)
    }
  }

  // Same reasoning as `saveButtonEl` below: factored out so the
  // tooltip-wrapped (I-3 fix, unattached issues) and bare branches in the
  // header render the identical button rather than two copies to keep in
  // sync by hand.
  const issuesBadgeEl = (
    <button
      type="button"
      onClick={scrollToFirstIssue}
      className="shrink-0 rounded-full bg-amber-500/15 px-2.5 py-1 text-xs font-medium text-amber-700 transition-colors hover:bg-amber-500/25 dark:text-amber-400"
    >
      {stepIssuesList.length === 1
        ? t("issues.one")
        : t("issues.other", { count: stepIssuesList.length })}
    </button>
  )

  // Factored out so the tooltip-wrapped and bare branches in the header
  // below render the identical element rather than two hand-kept-in-sync
  // copies of the same button.
  const saveButtonEl = (
    <Button
      onClick={save}
      disabled={saving || saveBlocked}
      className="bg-primary text-primary-foreground hover:bg-primary/90"
    >
      {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
      {isEditing ? t("save") : t("saveDraft")}
    </Button>
  )

  return (
    // `pt-safe`: full-screen `fixed` overlay outside the shell, so it does not
    // inherit the shell's inset. Without it the top bar — which holds the only
    // way back to /automations — sits under the iOS status bar in the
    // installed PWA and the editor becomes a trap. Inset is 0 on desktop.
    <div className="fixed inset-0 flex flex-col bg-background pt-safe">
      {/* Top bar. At sub-sm widths the "Active" label is hidden and the
          switch moves to the right of the save button, so the name input
          gets maximum width. */}
      <header className="flex flex-shrink-0 items-center gap-2 border-b border-border bg-card/80 px-3 py-3 sm:gap-3 sm:px-4">
        <button
          type="button"
          onClick={() => router.push("/automations")}
          className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          aria-label={t("backToAutomations")}
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <input
          value={state.name}
          onChange={(e) => patchTop("name", e.target.value)}
          placeholder={t("untitled")}
          className="min-w-0 flex-1 rounded-md bg-transparent px-2 py-1 text-sm font-semibold text-foreground placeholder:text-muted-foreground focus:bg-muted focus:outline-none sm:text-base"
        />
        {hasStepIssues && (
          unattachedStepIssues.length > 0 ? (
            // I-3 fix: `firstOffendingPath` is undefined whenever every
            // issue is unattached (the zero-steps case — see
            // `unattachedIssues`'s own comment), so `scrollToFirstIssue`
            // is a silent no-op and there is otherwise no card, tooltip,
            // or badge that shows WHY. Surface the validator's own
            // message(s) verbatim in a tooltip rather than paraphrasing —
            // matches the `activeToggleDisabled`/`saveBlocked` tooltip
            // pattern already used lower in this header.
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger render={<span tabIndex={0} className="inline-flex shrink-0" />}>
                  {issuesBadgeEl}
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  {unattachedStepIssues.map((issue) => issue.message).join(" ")}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          ) : (
            issuesBadgeEl
          )
        )}
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="hidden sm:inline">{t("active")}</span>
          {activeToggleDisabled ? (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger render={<span tabIndex={0} className="inline-flex" />}>
                  <Switch
                    checked={state.is_active}
                    onCheckedChange={(v) => patchTop("is_active", !!v)}
                    aria-label={t("activeAria")}
                    disabled
                  />
                </TooltipTrigger>
                <TooltipContent side="bottom">{t("issues.cannotActivate")}</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          ) : (
            <Switch
              checked={state.is_active}
              onCheckedChange={(v) => patchTop("is_active", !!v)}
              aria-label={t("activeAria")}
            />
          )}
        </div>
        {saveBlocked ? (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger render={<span tabIndex={0} className="inline-flex" />}>
                {saveButtonEl}
              </TooltipTrigger>
              <TooltipContent side="bottom">{t("issues.cannotActivate")}</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        ) : (
          saveButtonEl
        )}
      </header>

      {/* Canvas */}
      <div className="relative flex-1 overflow-y-auto">
        <div className="absolute inset-0 bg-[radial-gradient(circle,var(--border)_1px,transparent_1px)] [background-size:20px_20px] pointer-events-none" />
        <div className="relative mx-auto flex max-w-2xl flex-col items-center gap-0 px-4 py-10">
          <ResourcesProvider>
            <StepStatsContext.Provider value={stepStatsMap}>
              {/* Automation-level settings — deliberately NOT wired into
                  the trigger→step connector chain below (no dashed line
                  in/out of it): it describes the automation as a whole,
                  not a point in its flow, so `mb-6` just separates it
                  from where that flow visually begins. */}
              <SettingsCard
                stopOnReply={state.stop_on_reply}
                onChange={(v) => patchTop("stop_on_reply", v)}
                t={t}
              />
              <TriggerCard
                type={state.trigger_type}
                config={state.trigger_config}
                onTypeChange={(tVal) => patchTop("trigger_type", tVal)}
                onConfigChange={(c) => patchTop("trigger_config", c)}
                t={t}
              />
              <StepList
                steps={state.steps}
                parentPath={[]}
                stepPathPrefix=""
                issuesByPath={stepIssuesByPath}
                expandedId={expandedId}
                setExpandedId={setExpandedId}
                updateStep={updateStep}
                addStepAt={addStepAt}
                deleteStepAt={deleteStepAt}
                moveStepAt={moveStepAt}
              />
            </StepStatsContext.Provider>
          </ResourcesProvider>
        </div>
      </div>
    </div>
  )
}

// ------------------------------------------------------------
// Settings card (Task 8) — automation-level toggles that apply to the
// whole automation rather than to any one step or the trigger. Styled
// like `TriggerCard`/a step card (same rounded-lg/border/shadow shell)
// so it reads as part of the same card language, but rendered without a
// connector line above or below it: unlike the trigger and steps, it
// isn't a point in the automation's flow, so a dashed connector into it
// would imply an execution order that doesn't apply here.
// ------------------------------------------------------------

function SettingsCard({
  stopOnReply,
  onChange,
  t,
}: {
  stopOnReply: boolean
  onChange: (v: boolean) => void
  t: ReturnType<typeof useTranslations>
}) {
  return (
    <div className="z-10 mb-6 w-full max-w-[320px] sm:w-80">
      <div className="rounded-lg border border-border bg-card shadow-lg">
        <div className="px-4 py-3">
          <div className="text-[12px] uppercase tracking-wide text-muted-foreground">
            {t("settings.title")}
          </div>
          <div className="mt-2 flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm font-medium text-foreground">
                {t("settings.stopOnReply")}
              </div>
              <p className="mt-1 text-[12px] text-muted-foreground">
                {t("settings.stopOnReplyHelp")}
              </p>
            </div>
            <Switch
              checked={stopOnReply}
              onCheckedChange={(v) => onChange(!!v)}
              aria-label={t("settings.stopOnReply")}
            />
          </div>
        </div>
      </div>
    </div>
  )
}

// ------------------------------------------------------------
// Trigger card
// ------------------------------------------------------------

function TriggerCard({
  type,
  config,
  onTypeChange,
  onConfigChange,
  t,
}: {
  type: AutomationTriggerType
  config: Record<string, unknown>
  onTypeChange: (t: AutomationTriggerType) => void
  onConfigChange: (c: Record<string, unknown>) => void
  t: ReturnType<typeof useTranslations>
}) {
  const [open, setOpen] = useState(false)
  return (
    // Card width: full on mobile, fixed 320px on sm+. The canvas wrapper
    // (max-w-2xl + px-4) keeps this tidy on tablet/desktop.
    <div className="z-10 w-full max-w-[320px] sm:w-80">
      <div className="rounded-lg border border-border border-l-4 border-l-blue-500 bg-card shadow-lg">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex w-full items-center gap-3 px-4 py-3 text-left"
        >
          <div className="flex h-8 w-8 items-center justify-center rounded-md bg-blue-500/10 text-blue-400">
            <Zap className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[12px] uppercase tracking-wide text-blue-300">{t("trigger")}</div>
            <div className="truncate text-sm font-medium text-foreground">
              {t(`triggers.${type}.label`)}
            </div>
          </div>
          <ChevronDown
            className={cn("h-4 w-4 text-muted-foreground transition-transform", open && "rotate-180")}
          />
        </button>
        {open && (
          <div className="space-y-3 border-t border-border px-4 py-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                {t("triggerType")}
              </label>
              <select
                value={type}
                onChange={(e) => onTypeChange(e.target.value as AutomationTriggerType)}
                className="w-full rounded-md border border-border bg-muted px-2 py-1.5 text-sm text-foreground focus:border-primary focus:outline-none"
              >
                {TRIGGER_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {t(`triggers.${o.value}.label`)}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-[12px] text-muted-foreground">
                {t(`triggers.${type}.hint`)}
              </p>
            </div>
            {type === "keyword_match" && (
              <KeywordMatchConfig
                config={config as unknown as KeywordMatchTriggerConfig}
                onChange={onConfigChange}
                t={t}
              />
            )}
            {type === "interactive_reply" && (
              <InteractiveReplyConfig config={config} onChange={onConfigChange} t={t} />
            )}
            {type === "tag_added" && (
              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground">
                  Tag
                </label>
                <TagSelect
                  value={(config.tag_id as string) ?? ""}
                  onChange={(v) => onConfigChange({ ...config, tag_id: v })}
                  t={t}
                />
              </div>
            )}
            {type === "time_based" && (
              <div className="space-y-3">
                <div>
                  <label className="mb-1 block text-xs font-medium text-muted-foreground">
                    {t("schedule")}
                  </label>
                  {/* A native time input, not free text: the engine
                      accepts a daily 24-hour "HH:mm" only, and the old
                      "Cron expression or HH:mm" placeholder invited
                      values that activated cleanly and never fired. */}
                  <Input
                    type="time"
                    value={(config.schedule as string) ?? ""}
                    onChange={(e) =>
                      onConfigChange({ ...config, schedule: e.target.value })
                    }
                    className="bg-muted text-foreground"
                  />
                  <p className="mt-1 text-[12px] text-muted-foreground">
                    Runs once a day at this time, in your account&apos;s local
                    time.
                  </p>
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-muted-foreground">
                    Send to contacts tagged
                  </label>
                  <TagSelect
                    value={(config.tag_id as string) ?? ""}
                    onChange={(v) => onConfigChange({ ...config, tag_id: v })}
                    t={t}
                  />
                  <p className="mt-1 text-[12px] text-muted-foreground">
                    A time-based automation has no triggering contact, so it
                    runs once per contact holding this tag.
                  </p>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function KeywordMatchConfig({
  config,
  onChange,
  t,
}: {
  config: KeywordMatchTriggerConfig
  onChange: (c: Record<string, unknown>) => void
  t: ReturnType<typeof useTranslations>
}) {
  const keywords = config?.keywords ?? []
  // Keep a local draft string so the comma and trailing space aren't
  // stripped on every keystroke (which made multi-word, comma-separated
  // entry like "SEO, search engine optimization" impossible to type).
  // We only parse into the keywords array on blur, then re-display the
  // cleaned, rejoined form. Seeded once on mount; this component remounts
  // when the trigger type changes, so the seed stays in sync.
  const [draft, setDraft] = useState(keywords.join(", "))

  // Persist the default the <select> displays. The dropdown falls back to
  // "contains" for display, but leaving it untouched would otherwise omit
  // match_type from the saved config — and activation validation then
  // rejected it (trigger.match_type). Seed once on mount; the component
  // remounts when the trigger type changes, matching the keywords draft.
  useEffect(() => {
    if (config?.match_type == null) {
      onChange({ ...config, match_type: "contains" })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function commit() {
    const parsed = draft
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
    setDraft(parsed.join(", "))
    onChange({ ...config, keywords: parsed })
  }

  return (
    <div className="space-y-2">
      <div>
        <label className="mb-1 block text-xs font-medium text-muted-foreground">
          {t("keywords")}
        </label>
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault()
              commit()
            }
          }}
          placeholder={t("keywordsHint")}
          className="bg-muted text-foreground"
        />
      </div>
      <div>
        <label className="mb-1 block text-xs font-medium text-muted-foreground">
          {t("config.matchType")}
        </label>
        <select
          value={config?.match_type ?? "contains"}
          onChange={(e) => onChange({ ...config, match_type: e.target.value as "exact" | "contains" })}
          className="w-full rounded-md border border-border bg-muted px-2 py-1.5 text-sm text-foreground focus:outline-none"
        >
          <option value="contains">{t("config.matchContains")}</option>
          <option value="exact">{t("config.matchExact")}</option>
        </select>
      </div>
    </div>
  )
}

function InteractiveReplyConfig({
  config,
  onChange,
  t,
}: {
  config: Record<string, unknown>
  onChange: (c: Record<string, unknown>) => void
  t: ReturnType<typeof useTranslations>
}) {
  const ids = (config?.reply_ids as string[] | undefined) ?? []
  // Same local-draft-then-commit pattern as KeywordMatchConfig so
  // commas + spaces survive keystrokes.
  const [draft, setDraft] = useState(ids.join(", "))

  function commit() {
    const parsed = draft
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
    setDraft(parsed.join(", "))
    onChange({ ...config, reply_ids: parsed })
  }

  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-muted-foreground">
        {t("replyIds")}
      </label>
      <Input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault()
            commit()
          }
        }}
        placeholder={t("replyIdsHint")}
        className="bg-muted font-mono text-foreground"
      />
      <p className="mt-1 text-[12px] text-muted-foreground">{t("replyIdsHelp")}</p>
    </div>
  )
}

// ------------------------------------------------------------
// Step list + card + connectors
// ------------------------------------------------------------

type ParentScope =
  | { kind: "root" }
  | { kind: "branch"; parentCid: string; branch: "yes" | "no" }

type StepPath = (
  | { kind: "root"; index: number }
  | { kind: "branch"; parentCid: string; branch: "yes" | "no"; index: number }
)[]

interface StepListProps {
  steps: BuilderStep[]
  parentPath: StepPath
  /** Dot-path prefix for items in THIS list — `""` at the root,
   *  `"steps[0].yes."` / `"steps[0].no."` inside a condition's branches.
   *  Mirrors `convex/lib/automations/validate.ts`'s own `walk()` prefix
   *  exactly (see step-issues.tsx's header comment), so a step's computed
   *  path always matches the `path` on any `ValidationIssue` it produced. */
  stepPathPrefix: string
  /** Every step's validation issues, keyed by its own dot-path — computed
   *  once at the builder root by `useStepIssues` and threaded down
   *  unchanged, same pattern as `updateStep`/`deleteStepAt` below. */
  issuesByPath: Map<string, ValidationIssue[]>
  expandedId: string | null
  setExpandedId: (id: string | null) => void
  updateStep: (path: StepPath, updater: (s: BuilderStep) => BuilderStep) => void
  addStepAt: (parent: ParentScope, index: number, type: AutomationStepType) => void
  deleteStepAt: (path: StepPath) => void
  moveStepAt: (path: StepPath, direction: -1 | 1) => void
}

function StepList(props: StepListProps) {
  const { steps, parentPath, stepPathPrefix, ...rest } = props
  const parentScope: ParentScope =
    parentPath.length === 0
      ? { kind: "root" }
      : (() => {
          const last = parentPath[parentPath.length - 1]
          if (last.kind !== "branch") return { kind: "root" } as const
          return { kind: "branch", parentCid: last.parentCid, branch: last.branch } as const
        })()

  return (
    <div className="flex flex-col items-center">
      <AddButton onPick={(t) => props.addStepAt(parentScope, 0, t)} />
      {steps.map((step, idx) => (
        <StepRenderer
          key={step.cid}
          step={step}
          index={idx}
          total={steps.length}
          parentScope={parentScope}
          parentPath={parentPath}
          stepPath={`${stepPathPrefix}steps[${idx}]`}
          {...rest}
        />
      ))}
    </div>
  )
}

function StepRenderer({
  step,
  index,
  total,
  parentScope,
  parentPath,
  stepPath,
  ...props
}: {
  step: BuilderStep
  index: number
  total: number
  parentScope: ParentScope
  parentPath: StepPath
  /** This step's own dot-path, e.g. `steps[0]` or `steps[0].yes.steps[1]`
   *  — computed by `StepList` from `stepPathPrefix` + its index in the
   *  array. Used to look this step's own issues up in `issuesByPath`, and
   *  to key its DOM node for "scroll to first offending card". */
  stepPath: string
} & Omit<StepListProps, "steps" | "parentPath" | "stepPathPrefix">) {
  const t = useTranslations("Automations.builder")
  const path: StepPath = [
    ...parentPath,
    parentScope.kind === "root"
      ? { kind: "root", index }
      : { kind: "branch", parentCid: parentScope.parentCid, branch: parentScope.branch, index },
  ]
  const meta = STEP_META[step.step_type]
  const Icon = meta.icon
  const expanded = props.expandedId === step.cid
  const isCondition = step.step_type === "condition"
  const stepIssues = props.issuesByPath.get(stepPath) ?? []
  // Task 8 — a step added this session and never yet saved has no
  // `effective_step_key` (see `BuilderStep`'s own comment), so it can
  // never match a row here; that's correct, not a bug — there is nothing
  // to report yet.
  const stepStats = useStepStats()
  const statsEntry = resolveStepStats(step.effective_step_key, stepStats)
  // Card widths on mobile fill the full canvas column (max-w-2xl px-4
  // still keeps them reasonable). On sm+ the original fixed widths
  // come back so the flow visual stays recognisable.
  //
  // Collapsed cards keep the narrow flow-diagram look. An EXPANDED card
  // widens because the config forms inside it — the interactive payload
  // builder above all — need real horizontal room; at 320px the button
  // editor collapsed to one character per line.
  const width = expanded
    ? "w-full max-w-[560px] sm:w-[560px]"
    : isCondition
      ? "w-full max-w-[400px] sm:w-[400px]"
      : "w-full max-w-[320px] sm:w-80"

  return (
    <>
      <div id={`automation-step-${stepPath}`} className={cn("z-10 flex flex-col", width)}>
        <div
          className={cn(
            "rounded-lg border border-border border-l-4 bg-card shadow-lg",
            meta.border,
          )}
        >
          <button
            type="button"
            onClick={() => props.setExpandedId(expanded ? null : step.cid)}
            className="flex w-full items-center gap-3 px-4 py-3 text-left"
          >
            <GripVertical className="h-4 w-4 flex-shrink-0 text-muted-foreground" aria-hidden />
            <div className="relative flex h-8 w-8 items-center justify-center rounded-md bg-muted text-muted-foreground">
              <Icon className="h-4 w-4" />
              {/* Presence-only signal (no count) so a problem deep in a
                  long automation is visible without expanding every card —
                  the amber strip inside the expanded card has the detail.
                  The dot itself is aria-hidden (decorative), paired with an
                  sr-only line so a screen-reader user gets the same signal
                  a sighted one gets from the visual dot. */}
              {stepIssues.length > 0 && (
                <>
                  <span
                    className="absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full bg-amber-500 ring-2 ring-card"
                    aria-hidden
                  />
                  <span className="sr-only">{t("issues.stepHasIssues")}</span>
                </>
              )}
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[12px] uppercase tracking-wide text-muted-foreground">
                {isCondition ? "Condition" : step.step_type === "wait" ? "Wait" : "Action"}
              </div>
              <div className="truncate text-sm font-medium text-foreground">{t(`steps.${meta.label}`)}</div>
              <div className="truncate text-[12px] text-muted-foreground">{previewFor(step)}</div>
              {statsEntry && <StepStatsChips entry={statsEntry} t={t} />}
            </div>
            <ChevronDown
              className={cn("h-4 w-4 text-muted-foreground transition-transform", expanded && "rotate-180")}
            />
          </button>
          {expanded && (
            <div className="border-t border-border px-4 py-3">
              <StepEditor
                step={step}
                onChange={(next) => props.updateStep(path, () => next)}
              />
              <StepIssues issues={stepIssues} />
              <div className="mt-3 flex items-center justify-between gap-2 border-t border-border pt-3">
                <div className="flex gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    disabled={index === 0}
                    aria-label="Move up"
                    onClick={() => props.moveStepAt(path, -1)}
                  >
                    <ArrowUp className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    disabled={index === total - 1}
                    aria-label="Move down"
                    onClick={() => props.moveStepAt(path, 1)}
                  >
                    <ArrowDown className="h-4 w-4" />
                  </Button>
                </div>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => props.deleteStepAt(path)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  {t("delete")}
                </Button>
              </div>
            </div>
          )}
        </div>

        {isCondition && (
          <ConditionBranches step={step} parentPath={path} stepPath={stepPath} {...props} />
        )}
      </div>

      {/* A condition branches into Yes/No (rendered above by
          ConditionBranches), so it has no linear "continue" path — adding
          the trailing connector here would produce a spurious third output. */}
      {!isCondition && (
        <AddButton
          onPick={(t) => props.addStepAt(parentScope, index + 1, t)}
        />
      )}
    </>
  )
}

/**
 * Looks a step up in the per-automation stats map by its EFFECTIVE key
 * (`stepKey ?? _id` — see `BuilderStep.effective_step_key`'s own
 * comment), not its raw `step_key`. Pulled out of `StepRenderer` as a
 * plain function so this join — the exact mechanism this task's fix
 * round exists for — is unit-testable in isolation: a step saved before
 * Task 10's stepKey migration has `step_key === undefined` but a real,
 * non-empty `effective_step_key` (its row's own `_id`), and its
 * accumulated stats are filed under that same value by
 * `automationsEngine.ts`'s own `step.stepKey ?? step._id` at write time.
 * Using `step_key` here instead would make every pre-migration step's
 * chip render nothing, forever, regardless of how much real traffic it
 * has seen.
 */
export function resolveStepStats(
  effectiveStepKey: string | undefined,
  stats: Map<string, StepStatsEntry>,
): StepStatsEntry | undefined {
  return effectiveStepKey ? stats.get(effectiveStepKey) : undefined
}

/**
 * Which of a step's stats to show, in display order, omitting anything
 * at zero — pulled out of `StepStatsChips` as a plain function so the
 * "omit zero-valued figures... rather than three zeroes" rule (this
 * task's brief, Step 3) is unit-testable without rendering the 2000-line
 * builder tree it lives in.
 *
 * `sent` is deliberately never surfaced here even though `stepStats`
 * returns it: the automation-level `RunStatsBar` already uses "Sent" for
 * a *run* completing end-to-end (`RunCounts.completed`), a different
 * count than "this one step executed without error" — showing a
 * same-named figure with a different meaning right below it would read
 * as one number, not two. `reached`/`waiting`/`failed` don't collide
 * with anything else on this page.
 */
export function stepStatsChipParts(
  entry: StepStatsEntry,
): Array<{ kind: "reached" | "waiting" | "failed"; count: number }> {
  const parts: Array<{ kind: "reached" | "waiting" | "failed"; count: number }> = []
  if (entry.reached > 0) parts.push({ kind: "reached", count: entry.reached })
  if (entry.waiting > 0) parts.push({ kind: "waiting", count: entry.waiting })
  if (entry.failed > 0) parts.push({ kind: "failed", count: entry.failed })
  return parts
}

/** The `142 reached · 18 waiting · 3 failed` chip row under a step's
 *  preview text. Waiting gets an amber pulsing dot on top of its colour
 *  — the brief's "style it so it reads as live" — reusing the exact
 *  ping-dot markup `automations/page.tsx` already uses for an active
 *  automation, so "something is happening right now" reads the same way
 *  in both places. */
function StepStatsChips({
  entry,
  t,
}: {
  entry: StepStatsEntry
  t: ReturnType<typeof useTranslations>
}) {
  const parts = stepStatsChipParts(entry)
  if (parts.length === 0) return null
  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-1.5 text-[11px] text-muted-foreground">
      {parts.map((p, i) => (
        <span key={p.kind} className="inline-flex items-center gap-1">
          {i > 0 && <span aria-hidden>·</span>}
          {p.kind === "waiting" && (
            <span className="relative flex h-1.5 w-1.5" aria-hidden>
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-500 opacity-75" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-amber-500" />
            </span>
          )}
          <span
            className={cn(
              p.kind === "waiting" && "font-medium text-amber-500",
              p.kind === "failed" && "text-destructive",
            )}
          >
            {t(`stepStats.${p.kind}`, { count: p.count })}
          </span>
        </span>
      ))}
    </div>
  )
}

function ConditionBranches({
  step,
  parentPath,
  stepPath,
  ...props
}: {
  step: BuilderStep
  parentPath: StepPath
  /** This condition step's own dot-path (see `StepRenderer`'s comment) —
   *  the base that `.yes.` / `.no.` extend for its children, exactly
   *  matching how `validate.ts`'s `walk()` recurses into `branches`. */
  stepPath: string
} & Omit<StepListProps, "steps" | "parentPath" | "stepPathPrefix">) {
  const t = useTranslations("Automations.builder")
  const yes = step.branches?.yes ?? []
  const no = step.branches?.no ?? []
  // Build the child scope by appending a branch marker. The scope the
  // StepList uses is driven by the LAST element of parentPath, so the
  // tail's `index` doesn't matter — it's replaced per child during walks.
  const yesPath: StepPath = [
    ...parentPath,
    { kind: "branch", parentCid: step.cid, branch: "yes", index: 0 },
  ]
  const noPath: StepPath = [
    ...parentPath,
    { kind: "branch", parentCid: step.cid, branch: "no", index: 0 },
  ]
  return (
    // Stack Yes/No vertically on mobile — two columns at 375px would
    // cram each branch to ~170px which is too narrow for the nested
    // cards. Two-column grid returns on sm+.
    <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
      <BranchColumn label={t("branches.yes")} color="text-primary">
        <StepList {...props} steps={yes} parentPath={yesPath} stepPathPrefix={`${stepPath}.yes.`} />
      </BranchColumn>
      <BranchColumn label={t("branches.no")} color="text-rose-400">
        <StepList {...props} steps={no} parentPath={noPath} stepPathPrefix={`${stepPath}.no.`} />
      </BranchColumn>
    </div>
  )
}

function BranchColumn({
  label,
  color,
  children,
}: {
  label: string
  color: string
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col items-center">
      <div className={cn("mb-2 text-[12px] font-semibold uppercase", color)}>{label}</div>
      {children}
    </div>
  )
}

function AddButton({ onPick }: { onPick: (t: AutomationStepType) => void }) {
  return (
    <div className="relative flex flex-col items-center">
      <div className="h-4 w-[2px] bg-border" aria-hidden />
      <ActionPicker onPick={onPick} />
      <div className="h-4 w-[2px] bg-border" aria-hidden />
    </div>
  )
}

// ------------------------------------------------------------
// Per-step config editor
// ------------------------------------------------------------

function StepEditor({
  step,
  onChange,
}: {
  step: BuilderStep
  onChange: (s: BuilderStep) => void
}) {
  const t = useTranslations("Automations.builder")
  const cfg = step.step_config
  const set = (patch: Record<string, unknown>) =>
    onChange({ ...step, step_config: { ...cfg, ...patch } })

  switch (step.step_type) {
    case "send_message":
      return (
        <SendComposer
          value={asSendConfig(cfg)}
          onChange={(next) => onChange({ ...step, step_config: toSendConfig(next) })}
        />
      )
    case "send_buttons":
    case "send_list":
      // Legacy step types: the whole step_config IS the interactive
      // payload. Upgrade on open — seed the composer with just that
      // payload, and any edit rewrites this ONE step to send_message.
      // Steps the user never opens are left exactly as stored.
      return (
        <SendComposer
          value={{ interactive: asInteractive(cfg) }}
          onChange={(next) =>
            onChange({ ...step, step_type: "send_message", step_config: toSendConfig(next) })
          }
        />
      )
    case "send_template":
      return (
        <SendTemplateFields
          cfg={asSendTemplateConfig(cfg)}
          onChange={(next) => onChange({ ...step, step_config: toSendTemplateConfig(next) })}
          t={t}
        />
      )
    case "add_tag":
    case "remove_tag":
      return (
        <FieldBlock label={t("config.tagLabel")}>
          <TagSelect
            value={(cfg.tag_id as string) ?? ""}
            onChange={(v) => set({ tag_id: v })}
            t={t}
          />
        </FieldBlock>
      )
    case "assign_conversation":
      return (
        <>
          <FieldBlock label={t("config.modeLabel")}>
            <select
              value={(cfg.mode as string) ?? "round_robin"}
              onChange={(e) => set({ mode: e.target.value })}
              className="w-full rounded-md border border-border bg-muted px-2 py-1.5 text-sm text-foreground"
            >
              <option value="round_robin">{t("config.modes.round_robin")}</option>
              <option value="specific">{t("config.modes.specific")}</option>
            </select>
          </FieldBlock>
          {cfg.mode === "specific" && (
            <FieldBlock label={t("config.agentLabel")}>
              <AgentSelect
                value={(cfg.agent_id as string) ?? ""}
                onChange={(v) => set({ agent_id: v })}
                t={t}
              />
            </FieldBlock>
          )}
        </>
      )
    case "update_contact_field":
      return (
        <>
          <FieldBlock label={t("config.fieldLabel")}>
            <ContactFieldSelect
              value={(cfg.field as string) ?? "name"}
              onChange={(v) => set({ field: v })}
              t={t}
            />
          </FieldBlock>
          <FieldBlock label={t("config.valueLabel")}>
            <Input
              value={(cfg.value as string) ?? ""}
              onChange={(e) => set({ value: e.target.value })}
              placeholder={t("config.placeholderValue")}
              className="bg-muted text-foreground"
            />
          </FieldBlock>
        </>
      )
    case "create_deal":
      return (
        <>
          <DealPipelineFields
            pipelineId={(cfg.pipeline_id as string) ?? ""}
            stageId={(cfg.stage_id as string) ?? ""}
            onChange={(patch) => set(patch)}
            t={t}
          />
          <FieldBlock label={t("config.titleLabel")}>
            <Input
              value={(cfg.title as string) ?? ""}
              onChange={(e) => set({ title: e.target.value })}
              className="bg-muted text-foreground"
            />
          </FieldBlock>
          <FieldBlock label={t("config.valueLabel")}>
            <Input
              type="number"
              value={(cfg.value as number) ?? 0}
              onChange={(e) => set({ value: Number(e.target.value) })}
              className="bg-muted text-foreground"
            />
          </FieldBlock>
        </>
      )
    case "wait":
      return (
        <div className="grid grid-cols-2 gap-2">
          <FieldBlock label={t("config.amountLabel")}>
            <Input
              type="number"
              min={1}
              value={(cfg.amount as number) ?? 1}
              onChange={(e) => set({ amount: Math.max(1, Number(e.target.value)) })}
              className="bg-muted text-foreground"
            />
          </FieldBlock>
          <FieldBlock label={t("config.unitLabel")}>
            <select
              value={(cfg.unit as string) ?? "hours"}
              onChange={(e) => set({ unit: e.target.value })}
              className="w-full rounded-md border border-border bg-muted px-2 py-1.5 text-sm text-foreground"
            >
              <option value="minutes">{t("config.units.minutes")}</option>
              <option value="hours">{t("config.units.hours")}</option>
              <option value="days">{t("config.units.days")}</option>
            </select>
          </FieldBlock>
        </div>
      )
    case "condition":
      return (
        <>
          <FieldBlock label={t("config.subjectLabel")}>
            <select
              value={(cfg.subject as string) ?? "tag_presence"}
              onChange={(e) => {
                const subject = e.target.value
                // session_window's operand is a fixed open/closed choice,
                // not free text — write the same "open" default the
                // operand <select> below already displays, so activation
                // validation (which requires a non-empty operand) never
                // disagrees with what the dropdown appears to show.
                if (subject === "session_window" && cfg.operand !== "open" && cfg.operand !== "closed") {
                  set({ subject, operand: "open" })
                } else {
                  set({ subject })
                }
              }}
              className="w-full rounded-md border border-border bg-muted px-2 py-1.5 text-sm text-foreground"
            >
              <option value="tag_presence">{t("config.subjects.tag_presence")}</option>
              <option value="contact_field">{t("config.subjects.contact_field")}</option>
              <option value="message_content">{t("config.subjects.message_content")}</option>
              <option value="time_of_day">{t("config.subjects.time_of_day")}</option>
              <option value="session_window">{t("config.subjects.session_window")}</option>
            </select>
          </FieldBlock>
          <FieldBlock label={t("config.operandLabel")}>
            {cfg.subject === "session_window" ? (
              <select
                value={(cfg.operand as string) === "closed" ? "closed" : "open"}
                onChange={(e) => set({ operand: e.target.value })}
                className="w-full rounded-md border border-border bg-muted px-2 py-1.5 text-sm text-foreground"
              >
                <option value="open">{t("config.windowStates.open")}</option>
                <option value="closed">{t("config.windowStates.closed")}</option>
              </select>
            ) : (
              <Input
                placeholder={
                  cfg.subject === "time_of_day"
                    ? t("config.placeholderTime")
                    : cfg.subject === "contact_field"
                    ? t("config.placeholderContact")
                    : cfg.subject === "tag_presence"
                    ? t("config.placeholderTag")
                    : ""
                }
                value={(cfg.operand as string) ?? ""}
                onChange={(e) => set({ operand: e.target.value })}
                className="bg-muted text-foreground"
              />
            )}
          </FieldBlock>
          {(cfg.subject === "contact_field" || cfg.subject === "message_content") && (
            <FieldBlock label="Value">
              <Input
                value={(cfg.value as string) ?? ""}
                onChange={(e) => set({ value: e.target.value })}
                className="bg-muted text-foreground"
              />
            </FieldBlock>
          )}
        </>
      )
    case "send_webhook":
      return (
        <>
          <FieldBlock label={t("config.urlLabel")}>
            <Input
              value={(cfg.url as string) ?? ""}
              onChange={(e) => set({ url: e.target.value })}
              className="bg-muted text-foreground"
            />
          </FieldBlock>
          <FieldBlock label={t("config.bodyTemplateLabel")}>
            <Textarea
              value={(cfg.body_template as string) ?? ""}
              onChange={(e) => set({ body_template: e.target.value })}
              className="min-h-20 bg-muted font-mono text-xs text-foreground"
            />
          </FieldBlock>
        </>
      )
    case "close_conversation":
      return (
        <p className="text-xs text-muted-foreground">
          {t("config.closeConversationHint", { defaultValue: "Sets the conversation status to \"closed\". No configuration needed." })}
        </p>
      )
    default:
      return null
  }
}

function FieldBlock({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="mb-2 last:mb-0">
      <label className="mb-1 block text-xs font-medium text-muted-foreground">{label}</label>
      {children}
    </div>
  )
}

function previewFor(step: BuilderStep): string {
  switch (step.step_type) {
    case "send_message": {
      const cfg = asSendConfig(step.step_config)
      if (cfg.media) return `📎 ${cfg.media.type}`
      if (cfg.interactive) return interactivePayloadPreviewText(cfg.interactive) || "no body yet"
      return cfg.text || "no text yet"
    }
    case "send_buttons":
    case "send_list":
      return interactivePayloadPreviewText(asInteractive(step.step_config)) || "no body yet"
    case "send_template":
      return (step.step_config.template_name as string) || "pick a template"
    case "wait":
      return `${step.step_config.amount ?? "?"} ${step.step_config.unit ?? ""}`
    case "condition":
      return `when ${step.step_config.subject ?? "?"}`
    case "send_webhook":
      return (step.step_config.url as string) || "no url"
    default:
      return ""
  }
}

// ------------------------------------------------------------
// Tree mutation helpers
// ------------------------------------------------------------

function insertAt(
  steps: BuilderStep[],
  parent: ParentScope,
  index: number,
  node: BuilderStep,
): BuilderStep[] {
  if (parent.kind === "root") {
    const copy = [...steps]
    copy.splice(index, 0, node)
    return copy
  }
  return steps.map((s) => {
    if (s.cid !== parent.parentCid || !s.branches) return s
    const list = [...s.branches[parent.branch]]
    list.splice(index, 0, node)
    return { ...s, branches: { ...s.branches, [parent.branch]: list } }
  })
}

function mapAtPath(
  steps: BuilderStep[],
  path: StepPath,
  updater: (s: BuilderStep) => BuilderStep,
): BuilderStep[] {
  if (path.length === 0) return steps
  const head = path[0]
  const rest = path.slice(1)

  if (head.kind === "root") {
    return steps.map((s, i) => {
      if (i !== head.index) return s
      return rest.length === 0
        ? updater(s)
        : { ...s, branches: walkBranches(s.branches, rest, updater) }
    })
  }
  return steps.map((s) => {
    if (s.cid !== head.parentCid || !s.branches) return s
    const bucket = s.branches[head.branch]
    const updated = bucket.map((child, i) => {
      if (i !== head.index) return child
      return rest.length === 0
        ? updater(child)
        : { ...child, branches: walkBranches(child.branches, rest, updater) }
    })
    return { ...s, branches: { ...s.branches, [head.branch]: updated } }
  })
}

function walkBranches(
  branches: BuilderStep["branches"],
  path: StepPath,
  updater: (s: BuilderStep) => BuilderStep,
): BuilderStep["branches"] {
  if (!branches) return branches
  const head = path[0]
  if (head.kind !== "branch") return branches
  const bucket = branches[head.branch]
  const rest = path.slice(1)
  const updated = bucket.map((child, i) => {
    if (i !== head.index) return child
    return rest.length === 0
      ? updater(child)
      : { ...child, branches: walkBranches(child.branches, rest, updater) }
  })
  return { ...branches, [head.branch]: updated }
}

function removeAt(steps: BuilderStep[], path: StepPath): BuilderStep[] {
  if (path.length === 0) return steps
  const head = path[0]
  const rest = path.slice(1)
  if (head.kind === "root") {
    if (rest.length === 0) return steps.filter((_, i) => i !== head.index)
    return steps.map((s, i) =>
      i !== head.index ? s : { ...s, branches: removeFromBranches(s.branches, rest) },
    )
  }
  return steps.map((s) => {
    if (s.cid !== head.parentCid || !s.branches) return s
    const bucket = s.branches[head.branch]
    const next =
      rest.length === 0
        ? bucket.filter((_, i) => i !== head.index)
        : bucket.map((child, i) =>
            i !== head.index
              ? child
              : { ...child, branches: removeFromBranches(child.branches, rest) },
          )
    return { ...s, branches: { ...s.branches, [head.branch]: next } }
  })
}

function removeFromBranches(
  branches: BuilderStep["branches"],
  path: StepPath,
): BuilderStep["branches"] {
  if (!branches) return branches
  const head = path[0]
  if (head.kind !== "branch") return branches
  const rest = path.slice(1)
  const bucket = branches[head.branch]
  const next =
    rest.length === 0
      ? bucket.filter((_, i) => i !== head.index)
      : bucket.map((child, i) =>
          i !== head.index
            ? child
            : { ...child, branches: removeFromBranches(child.branches, rest) },
        )
  return { ...branches, [head.branch]: next }
}

function moveAt(
  steps: BuilderStep[],
  path: StepPath,
  direction: -1 | 1,
): BuilderStep[] {
  if (path.length === 0) return steps
  const head = path[0]
  const rest = path.slice(1)
  const swap = <T,>(arr: T[], i: number) => {
    const j = i + direction
    if (j < 0 || j >= arr.length) return arr
    const copy = [...arr]
    ;[copy[i], copy[j]] = [copy[j], copy[i]]
    return copy
  }
  if (head.kind === "root") {
    if (rest.length === 0) return swap(steps, head.index)
    return steps.map((s, i) =>
      i !== head.index ? s : { ...s, branches: moveInBranches(s.branches, rest, direction) },
    )
  }
  return steps.map((s) => {
    if (s.cid !== head.parentCid || !s.branches) return s
    const bucket = s.branches[head.branch]
    const next = rest.length === 0 ? swap(bucket, head.index) : bucket
    return { ...s, branches: { ...s.branches, [head.branch]: next } }
  })
}

function moveInBranches(
  branches: BuilderStep["branches"],
  path: StepPath,
  direction: -1 | 1,
): BuilderStep["branches"] {
  if (!branches) return branches
  const head = path[0]
  if (head.kind !== "branch") return branches
  const rest = path.slice(1)
  const bucket = branches[head.branch]
  const swap = <T,>(arr: T[], i: number) => {
    const j = i + direction
    if (j < 0 || j >= arr.length) return arr
    const copy = [...arr]
    ;[copy[i], copy[j]] = [copy[j], copy[i]]
    return copy
  }
  const next = rest.length === 0 ? swap(bucket, head.index) : bucket
  return { ...branches, [head.branch]: next }
}

/**
 * Finds the `cid` of the step at a given dot-path (validate.ts's scheme,
 * e.g. `steps[0].yes.steps[1]` — see step-issues.tsx's `collectStepPaths`,
 * which this mirrors) — the bridge from `useStepIssues`'s string paths
 * back to the `cid`-keyed `expandedId` state, so "scroll to the first
 * offending card" can also expand it. Kept here rather than in
 * step-issues.tsx because it's specific to this file's `BuilderStep`
 * shape (it reads `cid`, which the deliberately-minimal `StepTreeNode`
 * that file's pure functions operate on does not have).
 */
export function findCidForStepPath(
  steps: BuilderStep[],
  targetPath: string,
  prefix = "",
): string | undefined {
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]
    const path = `${prefix}steps[${i}]`
    if (path === targetPath) return step.cid
    if (step.step_type === "condition" && step.branches) {
      const yesMatch = findCidForStepPath(step.branches.yes, targetPath, `${path}.yes.`)
      if (yesMatch) return yesMatch
      const noMatch = findCidForStepPath(step.branches.no, targetPath, `${path}.no.`)
      if (noMatch) return noMatch
    }
  }
  return undefined
}

// ------------------------------------------------------------
// Serialize builder tree → API payload (flattened shape)
// ------------------------------------------------------------

interface ApiStep {
  id?: string
  step_type: string
  step_config: Record<string, unknown>
  branches?: { yes?: ApiStep[]; no?: ApiStep[] }
}

export function toApiSteps(steps: BuilderStep[]): ApiStep[] {
  return steps.map((s) => ({
    // Round-trips the server's stable key so a save preserves per-step
    // stats. `s.cid` is the client-local fallback for a step added in this
    // editing session that has never been saved.
    id: s.step_key ?? s.cid,
    step_type: s.step_type,
    step_config: s.step_config,
    branches: s.branches
      ? { yes: toApiSteps(s.branches.yes), no: toApiSteps(s.branches.no) }
      : undefined,
  }))
}

/**
 * Convert server-returned step tree (from loadStepsTree) into the
 * builder-local shape with client ids.
 */
export interface ServerStepNode {
  id: string
  /** `automationSteps.stepKey`, round-tripped by `fromServerSteps` below
   *  into `BuilderStep.step_key`. Always populated by `automations.get`,
   *  which resolves the schema's `stepKey ?? _id` fallback in `toStepRow`
   *  for a row saved before the field existed — so a step that came from
   *  the server always has a key that matches whatever the engine recorded
   *  its stats under. Optional only because the tree shape is shared. */
  stepKey?: string
  /** `stepsTree.ts`'s `BuilderStepNode.effectiveStepKey` (`stepKey ?? id`)
   *  — round-tripped below into `BuilderStep.effective_step_key`. See
   *  that field's own comment for why it's separate from `stepKey`. */
  effectiveStepKey: string
  step_type: string
  step_config: Record<string, unknown>
  branches: { yes: ServerStepNode[]; no: ServerStepNode[] }
}

export function fromServerSteps(nodes: ServerStepNode[]): BuilderStep[] {
  return nodes.map((n) => ({
    cid: cid(),
    step_key: n.stepKey,
    effective_step_key: n.effectiveStepKey,
    step_type: n.step_type as AutomationStepType,
    step_config: n.step_config ?? {},
    branches:
      n.step_type === "condition"
        ? {
            yes: fromServerSteps(n.branches?.yes ?? []),
            no: fromServerSteps(n.branches?.no ?? []),
          }
        : undefined,
  }))
}
