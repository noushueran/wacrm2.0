"use client";

import {
  useState,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type ChangeEvent,
} from "react";
import { useConvex, useMutation, useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { convexErrorData, toUiDeal, toUiMemberProfile } from "@/lib/convex/adapters";
import { uploadAccountMedia } from "@/lib/storage/upload-media";
import { mediaUrlFromKey } from "@/lib/storage/media-url";
import { ContactAvatar } from "./contact-avatar";
import type { Contact } from "@/types";
import { formatPhoneIntl } from "@/lib/whatsapp/phone-utils";
import { useAuth } from "@/hooks/use-auth";
import { hasMinRole } from "@/lib/auth/roles";
import { LeadChecklist } from "@/components/leads/lead-checklist";
import { OptionalFeatureBoundary } from "@/components/inbox/optional-feature-boundary";
import { LabelPicker } from "./label-picker";
import { TagSuggestionBanner } from "./tag-suggestion-banner";
import { ContactStatusHeader } from "./contact-status-header";
import { ContactKeyFacts } from "./contact-key-facts";
import { ContactActivity } from "./contact-activity";
import { SectionLabel } from "./section-label";
import { ContactCollapsibleSection } from "./contact-collapsible-section";
import {
  inputCls,
  ContactAcquisitionFields,
  ContactLocationFields,
  ContactTravelFields,
  ContactAboutFields,
  type EditForm,
} from "./contact-detail-sections";
import {
  Phone,
  Copy,
  Check,
  Tag as TagIcon,
  DollarSign,
  Pencil,
  MapPin,
  Plane,
  Info,
  Megaphone,
  ListChecks,
  SlidersHorizontal,
  History,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { buildFunnelSteps } from "@/lib/inbox/funnelView";
import {
  PANEL_SECTION_STORAGE_KEY,
  parseSectionState,
  resolveSectionOpen,
  serializeSectionState,
  type PanelSectionKey,
  type PanelSectionState,
} from "@/lib/inbox/panelSections";
import { listSectionState } from "@/lib/inbox/view";

interface ContactSidebarProps {
  contact: Contact | null;
  conversationId?: string;
}

/** Matches `Settings.profile`'s own avatar limits — a contact photo is
 *  the same kind of object in the same bucket, displayed at 64px. */
const MAX_PHOTO_BYTES = 2 * 1024 * 1024;
const ALLOWED_PHOTO_MIME = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

function formToState(c: Contact): EditForm {
  return {
    name: c.name ?? "",
    company: c.company ?? "",
    email: c.email ?? "",
    altPhone: c.alt_phone ?? "",
    address: c.address ?? "",
    city: c.city ?? "",
    country: c.country ?? "",
    nationality: c.nationality ?? "",
    preferredDestination: c.preferred_destination ?? "",
    travelDates: c.travel_dates ?? "",
    travelers: c.travelers ?? "",
    budget: c.budget ?? "",
    notes: c.notes ?? "",
  };
}

export function ContactSidebar({ contact, conversationId }: ContactSidebarProps) {
  const tSidebar = useTranslations("Inbox.sidebar");
  const tThread = useTranslations("Inbox.messageThread");
  const tFunnel = useTranslations("Inbox.funnel");
  const tLabels = useTranslations("Inbox.labels");
  // Key facts and Activity used to draw their own headings; the
  // collapsible header draws them now, so their copy is read here.
  const tCustom = useTranslations("Inbox.customFields");
  const tActivity = useTranslations("Inbox.activity");

  const { user, accountRole } = useAuth();

  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState<EditForm | null>(null);

  // One stored object for all seven sections. Read once on mount rather
  // than per section: `localStorage` is synchronous and this component
  // never unmounts (it lives inside the always-mounted drawer). Reading
  // in an effect rather than a `useState` initializer is deliberate —
  // the initializer would run during SSR, where `window` is undefined.
  const [sectionState, setSectionState] = useState<PanelSectionState>({});
  useEffect(() => {
    setSectionState(
      parseSectionState(window.localStorage.getItem(PANEL_SECTION_STORAGE_KEY)),
    );
  }, []);

  // The next state is computed HERE, not inside a `setSectionState`
  // updater. React requires updaters to be pure, and StrictMode
  // double-invokes them in development — a `localStorage.setItem` in
  // there is a side effect that happens to be idempotent, which is luck
  // rather than correctness. Reading `sectionState` from the closure
  // instead costs a same-tick coalescing risk that cannot arise: the
  // only callers are seven separate section headers, and a user cannot
  // click two of them inside one React batch.
  const toggleSection = useCallback(
    (key: PanelSectionKey, next: boolean) => {
      const updated = { ...sectionState, [key]: next };
      setSectionState(updated);
      try {
        window.localStorage.setItem(
          PANEL_SECTION_STORAGE_KEY,
          serializeSectionState(updated),
        );
      } catch {
        // Private mode or a full quota — the preference is a convenience,
        // never a correctness requirement, so a failed write is ignored
        // and the session keeps its in-memory choice.
      }
    },
    [sectionState],
  );

  // The open/forced/onToggle triple every collapsible section needs,
  // derived from ONE key so `sectionState[key]` and `toggleSection(key)`
  // cannot drift apart — seven inline copies of this meant seven chances
  // of a key mismatch, and two reviewers have hand-checked them.
  // `forced` mirrors `resolveSectionOpen`'s own precedence rule, which is
  // why it is computed alongside `open` rather than at the call sites.
  const sectionProps = (key: PanelSectionKey, editable: boolean) => ({
    open: resolveSectionOpen({
      editing,
      editable,
      persisted: sectionState[key],
      defaultOpen: false,
    }),
    forced: editing && editable,
    onToggle: (next: boolean) => toggleSection(key, next),
  });

  // The funnel stays pinned but rests at its current stage; the other
  // rows are one click away. This is about height, not about hiding it.
  const [showAllStages, setShowAllStages] = useState(false);

  // Contact photo. Staged in edit mode and committed by Save, like every
  // other field here — the upload itself only runs on save, so picking a
  // file and then cancelling leaves nothing behind in the bucket.
  const [pendingPhoto, setPendingPhoto] = useState<File | null>(null);
  const [photoObjectUrl, setPhotoObjectUrl] = useState<string | null>(null);
  const [removePhoto, setRemovePhoto] = useState(false);
  const photoInputRef = useRef<HTMLInputElement>(null);

  const contactId = contact ? (contact.id as Id<"contacts">) : undefined;

  const resetPhotoDraft = useCallback(() => {
    setPendingPhoto(null);
    setRemovePhoto(false);
    setPhotoObjectUrl(null);
  }, []);

  // Leave edit mode + drop the draft whenever the active contact changes.
  useEffect(() => {
    setEditing(false);
    setForm(null);
    resetPhotoDraft();
  }, [contactId, resetPhotoDraft]);

  // Revoke each preview once it is replaced or dropped — the cleanup
  // closes over the OLD url, so nothing revokes the one on screen. Same
  // shape as `src/components/settings/profile-form.tsx`, which is why no
  // call site revokes by hand.
  useEffect(() => {
    return () => {
      if (photoObjectUrl) URL.revokeObjectURL(photoObjectUrl);
    };
  }, [photoObjectUrl]);

  // Deals is a reactive Convex query keyed on the contact — switching
  // contacts (or another tab editing the same contact) updates it
  // automatically, no fetch-on-mount effect needed. (Notes moved to
  // `ContactActivity`, which owns its own query.)
  const dealDocs = useQuery(
    api.deals.listByContact,
    contactId ? { contactId } : "skip",
  );
  const deals = (dealDocs ?? []).map(toUiDeal);
  // Distinguish "still loading" (dealDocs === undefined) from "loaded, no
  // deals" so the section never flashes "No deals yet" during the cold
  // round-trip on first open — a falsehood an agent could act on.
  const dealsState = listSectionState(dealDocs);

  const funnelState = useQuery(
    api.funnel.getState,
    conversationId ? { conversationId: conversationId as Id<"conversations"> } : "skip",
  );

  // Status-header data (Task 6, conversation-notes-p2): the conversation
  // doc for `assignedToUserId`/`lastMessageAt`, the member list to turn
  // an id into a name (same mapping `message-thread.tsx` uses for its
  // assign dropdown), and the qualification session for
  // `nextFollowUpAt`.
  const conversation = useQuery(
    api.conversations.get,
    conversationId ? { conversationId: conversationId as Id<"conversations"> } : "skip",
  );
  const memberDocs = useQuery(api.members.list);
  const profiles = useMemo(
    () => (memberDocs ?? []).map(toUiMemberProfile),
    [memberDocs],
  );
  const assignedName = useMemo(() => {
    const assignedToUserId = conversation?.assignedToUserId;
    if (!assignedToUserId) return null;
    return profiles.find((p) => p.user_id === assignedToUserId)?.full_name ?? null;
  }, [conversation?.assignedToUserId, profiles]);
  const qualificationSession = useQuery(
    api.qualification.getSessionForConversation,
    conversationId ? { conversationId: conversationId as Id<"conversations"> } : "skip",
  );

  // Whether this caller may TICK the checklist (`ChecklistSection` below
  // renders it either way). Deliberately looser than the server's
  // `requireConversationAccess(..., "own")`, which is supervisor+ OR
  // (`role === "agent"` AND assigned): this only asks "assigned to me, or
  // supervisor+", omitting the agent-role half. The gap — an assigned
  // `viewer` — is unreachable, because `canAccessConversation` grants a
  // viewer "view" only on UNASSIGNED threads, so an assigned viewer
  // cannot open this thread at all. Left as-is rather than widened, since
  // adding the role check here would only restate an impossible case.
  //
  // `!!user?.id` guards the `undefined === undefined` false positive an
  // unassigned thread would otherwise produce while auth is loading —
  // the same trap `message-thread.tsx` documents for note ownership.
  const canWorkThisLead =
    (!!user?.id && conversation?.assignedToUserId === user.id) ||
    (accountRole ? hasMinRole(accountRole, "supervisor") : false);

  const doNotContact = useMemo(() => {
    const dnc = contact?.do_not_contact;
    if (!dnc) return null;
    const byName = dnc.byUserId
      ? (profiles.find((p) => p.user_id === dnc.byUserId)?.full_name ?? null)
      : null;
    return { at: dnc.at, byName };
  }, [contact?.do_not_contact, profiles]);

  const tags = contact?.tags ?? [];

  const updateContact = useMutation(api.contacts.update);
  const convex = useConvex();
  const startUpload = useMutation(api.files.startUpload);

  const handleCopyPhone = useCallback(async () => {
    if (!contact?.phone) return;
    await navigator.clipboard.writeText(formatPhoneIntl(contact.phone));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [contact]);

  const startEdit = useCallback(() => {
    if (!contact) return;
    setForm(formToState(contact));
    setEditing(true);
  }, [contact]);

  const cancelEdit = useCallback(() => {
    setEditing(false);
    setForm(null);
    resetPhotoDraft();
  }, [resetPhotoDraft]);

  const onPickPhoto = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = ""; // reset so the same file can be re-picked
      if (!file) return;

      if (!ALLOWED_PHOTO_MIME.has(file.type)) {
        toast.error(tSidebar("unsupportedImage"), {
          description: tSidebar("unsupportedImageDesc"),
        });
        return;
      }
      if (file.size > MAX_PHOTO_BYTES) {
        toast.error(tSidebar("imageTooLarge"), {
          description: tSidebar("imageTooLargeDesc"),
        });
        return;
      }

      setPendingPhoto(file);
      setPhotoObjectUrl(URL.createObjectURL(file));
      setRemovePhoto(false);
    },
    [tSidebar],
  );

  const onRemovePhoto = useCallback(() => {
    setPendingPhoto(null);
    setPhotoObjectUrl(null);
    setRemovePhoto(true);
  }, []);

  const handleSave = useCallback(async () => {
    if (!contact || !form) return;
    setSaving(true);
    try {
      // `undefined` = leave the photo alone; the mutation patches
      // `avatarKey`/`avatarUrl` only when supplied.
      let avatarKey: string | undefined;
      let avatarUrl: string | undefined;

      if (pendingPhoto) {
        const uploaded = await uploadAccountMedia(
          convex,
          startUpload,
          pendingPhoto,
          "avatar",
        );
        // Same guard the other upload flows use: without it a save with
        // `NEXT_PUBLIC_R2_PUBLIC_HOST` unset still "succeeds" (the key is
        // patched fine) but `resolveMediaUrl` can't turn that key into a
        // URL, so the agent sees the old avatar after a successful save
        // with only a console error to explain it.
        if (!mediaUrlFromKey(uploaded.key)) {
          throw new Error(
            "Uploaded, but the public media host isn't configured yet.",
          );
        }
        avatarKey = uploaded.key;
      } else if (removePhoto) {
        // Clear BOTH: a stale key would keep winning `resolveMediaUrl`'s
        // key-over-url precedence and silently undo the removal.
        avatarKey = "";
        avatarUrl = "";
      }

      await updateContact({
        ...(avatarKey !== undefined ? { avatarKey } : {}),
        ...(avatarUrl !== undefined ? { avatarUrl } : {}),
        contactId: contact.id as Id<"contacts">,
        name: form.name.trim() || undefined,
        company: form.company.trim() || undefined,
        email: form.email.trim() || undefined,
        // Normalize the alternate number to +E.164 on save.
        altPhone: form.altPhone.trim()
          ? formatPhoneIntl(form.altPhone)
          : undefined,
        address: form.address.trim() || undefined,
        city: form.city.trim() || undefined,
        country: form.country.trim() || undefined,
        nationality: form.nationality.trim() || undefined,
        preferredDestination: form.preferredDestination.trim() || undefined,
        travelDates: form.travelDates.trim() || undefined,
        travelers: form.travelers.trim() || undefined,
        budget: form.budget.trim() || undefined,
        notes: form.notes.trim() || undefined,
      });
      toast.success(tSidebar("saved"));
      setEditing(false);
      setForm(null);
      resetPhotoDraft();
    } catch (err) {
      console.error("Failed to update contact:", err);
      // The photo leg fails for its own reasons (upload rejected, media
      // host unset) and "Couldn't save contact" would send an agent
      // hunting through the text fields instead.
      toast.error(pendingPhoto ? tSidebar("photoUploadError") : tSidebar("saveError"));
    } finally {
      setSaving(false);
    }
  }, [
    contact,
    form,
    updateContact,
    tSidebar,
    pendingPhoto,
    removePhoto,
    convex,
    startUpload,
    resetPhotoDraft,
  ]);

  if (!contact) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-card">
        <p className="text-sm text-muted-foreground">
          {tThread("selectConversation")}
        </p>
      </div>
    );
  }

  const displayName = contact.name || formatPhoneIntl(contact.phone);
  // Staged photo wins, then a pending removal blanks it, else what's saved.
  const photoPreview =
    photoObjectUrl ?? (removePhoto ? null : contact.avatar_url);
  const set =
    (k: keyof EditForm) =>
    (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setForm((f) => (f ? { ...f, [k]: e.target.value } : f));

  // Closed-section markers. Every one is derived from data the panel has
  // already fetched — a marker must never cost a round-trip, or
  // collapsing would trade height for latency. Key facts and Activity own
  // their own queries and can't be counted from here, so they mark
  // unconditionally: a dot that says "there is something in here".
  const hasTravelDetail = Boolean(
    contact.nationality ||
      contact.preferred_destination ||
      contact.travel_dates ||
      contact.travelers ||
      contact.budget,
  );
  const hasLocationDetail = Boolean(
    contact.address || contact.city || contact.country,
  );
  const hasAcquisitionDetail = contact.acquisition_source === "ad";
  const hasAboutDetail = Boolean(
    contact.notes || contact.alt_phone || contact.email,
  );

  // The funnel's resting view. `buildFunnelSteps` is untouched — this
  // only picks how many of its rows render.
  //
  // The fallback is not defensive padding, it is the COMMON case. A
  // conversation that did not arrive from an ad or a tracked link has no
  // `conversation.funnel` at all: `convex/ingest.ts` seeds a lead only
  // when a HY- ref code or a `ctwa_clid` is present, and `funnel.getState`
  // reports `conversation.funnel?.stage ?? null`. With a null
  // `currentStage`, `buildFunnelSteps` marks NO step `current`, so
  // filtering on `current` alone would rest this pinned block on nothing
  // but its own header — worse than the seven `○` rows it replaced. The
  // status strip above cannot cover for it either: it renders the stage
  // only when there is one. So fall back to the first step, which is
  // where an unstaged conversation actually sits.
  const funnelSteps = funnelState ? buildFunnelSteps(funnelState) : [];
  const currentFunnelSteps = funnelSteps.filter((step) => step.current);
  const visibleFunnelSteps = showAllStages
    ? funnelSteps
    : currentFunnelSteps.length > 0
      ? currentFunnelSteps
      : funnelSteps.slice(0, 1);

  return (
    <div className="flex h-full w-full flex-col bg-card">
      <ScrollArea className="min-h-0 flex-1">
        <div className="p-4">
          {/* Header: avatar + name/company + Edit toggle */}
          <div className="flex flex-col items-center text-center">
            <ContactAvatar
              displayName={displayName}
              seed={contact.phone_normalized || contact.phone}
              photoUrl={photoPreview}
              size="lg"
            />

            {/* Photo controls — edit mode only. The picked file is staged
                and uploaded by Save, so Cancel leaves the bucket clean. */}
            {editing && (
              <div className="mt-2 flex flex-col items-center gap-1">
                <input
                  ref={photoInputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/gif"
                  className="hidden"
                  onChange={onPickPhoto}
                />
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => photoInputRef.current?.click()}
                    disabled={saving}
                    className="text-xs text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline disabled:opacity-50"
                  >
                    {photoPreview
                      ? tSidebar("changePhoto")
                      : tSidebar("uploadPhoto")}
                  </button>
                  {photoPreview && (
                    <button
                      type="button"
                      onClick={onRemovePhoto}
                      disabled={saving}
                      className="text-xs text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline disabled:opacity-50"
                    >
                      {tSidebar("removePhoto")}
                    </button>
                  )}
                </div>
                <p className="max-w-[15rem] text-[11px] leading-snug text-muted-foreground">
                  {tSidebar("photoHint")}
                </p>
              </div>
            )}

            {editing && form ? (
              <input
                value={form.name}
                onChange={set("name")}
                placeholder={tSidebar("name")}
                className={`mt-3 text-center ${inputCls}`}
              />
            ) : (
              <h3 className="mt-3 text-sm font-semibold text-foreground">
                {displayName}
              </h3>
            )}
            {editing && form ? (
              <input
                value={form.company}
                onChange={set("company")}
                placeholder={tSidebar("company")}
                className={`mt-2 text-center ${inputCls}`}
              />
            ) : (
              contact.company && (
                <p className="text-xs text-muted-foreground">
                  {contact.company}
                </p>
              )
            )}

            {/* WhatsApp number — the routing key for this whole
                conversation, read-only and copyable. Pinned here because
                it is the one contact detail read on every conversation;
                the standalone Contact section that used to hold it is
                gone, and its other two rows moved into About.

                `displayName` falls back to this same formatted number
                when the contact has no saved name — a large share of a
                WhatsApp CRM's contacts — which would print it twice, two
                elements apart, at the very top of the panel. In that case
                the heading IS the number, so the chip drops to its verb
                and stays a copy affordance for every contact. */}
            <button
              type="button"
              onClick={handleCopyPhone}
              // Named explicitly because in the common branch the label IS
              // the number: a screen reader would otherwise announce a bare
              // string of digits with nothing to say it copies them.
              aria-label={`${tSidebar("copyNumber")} ${formatPhoneIntl(contact.phone)}`}
              className="mt-2 inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <Phone className="h-3 w-3 shrink-0" />
              <span>
                {contact.name
                  ? formatPhoneIntl(contact.phone)
                  : tSidebar("copyNumber")}
              </span>
              {copied ? (
                <Check className="h-3 w-3 text-primary" />
              ) : (
                <Copy className="h-3 w-3" />
              )}
            </button>

            {!editing ? (
              <button
                type="button"
                onClick={startEdit}
                className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <Pencil className="h-3 w-3" />
                {tSidebar("edit")}
              </button>
            ) : (
              <div className="mt-3 flex items-center gap-2">
                <Button size="sm" onClick={handleSave} disabled={saving}>
                  {saving ? tSidebar("saving") : tSidebar("save")}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={cancelEdit}
                  disabled={saving}
                >
                  {tSidebar("cancel")}
                </Button>
              </div>
            )}
          </div>

          <Divider />

          {/* Status header (Task 3) — "where does this customer stand
              right now", before anything else in the panel. Every value
              is resolved here; the component itself is presentational. */}
          <ContactStatusHeader
            assignedName={assignedName}
            stage={funnelState?.currentStage ?? null}
            lastContactedAt={conversation?.lastMessageAt ?? null}
            nextFollowUpAt={qualificationSession?.nextFollowUpAt ?? null}
            doNotContact={doNotContact}
          />

          {/* Funnel — pinned, but resting at the current stage. Seven
              stacked rows were one of the largest single contributors to
              the panel's height. `buildFunnelSteps` is untouched; only
              how many of its rows render at rest changed, and the
              CRM-only note and the sale value stay visible either way.
              `visibleFunnelSteps` above owns which rows those are, and
              why an unstaged conversation still shows one. */}
          {conversationId && funnelState && (
            <Section icon={ListChecks} label={tFunnel("label")}>
              <div className="px-3 py-2 space-y-1.5">
                {!funnelState.attributed && (
                  <p className="text-xs text-muted-foreground">{tFunnel("crmOnly")}</p>
                )}
                {visibleFunnelSteps.map((step) => (
                  <div
                    key={step.key}
                    className="flex items-center justify-between gap-2"
                  >
                    <span
                      className={cn(
                        "text-sm",
                        step.current
                          ? "font-medium text-primary"
                          : step.done
                            ? "text-foreground"
                            : "text-muted-foreground",
                      )}
                    >
                      {step.done ? "✓ " : step.current ? "• " : "○ "}
                      {tFunnel(`stage.${step.key}`)}
                    </span>
                    {step.reportsToMeta && (step.done || step.current) && (
                      <span
                        className="text-[11px] text-muted-foreground"
                        title={
                          step.metaStatus === "sent"
                            ? tFunnel("reportedToMeta")
                            : tFunnel("notReportedYet")
                        }
                      >
                        {step.metaStatus === "sent" ? "✓ Meta" : "– Meta"}
                      </span>
                    )}
                  </div>
                ))}
                <button
                  type="button"
                  onClick={() => setShowAllStages((v) => !v)}
                  aria-expanded={showAllStages}
                  className="text-xs text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline"
                >
                  {showAllStages
                    ? tFunnel("hideAllStages")
                    : tFunnel("showAllStages")}
                </button>
                {funnelState.saleValue !== undefined && (
                  <p className="pt-1 text-sm text-foreground">
                    {funnelState.saleCurrency} {funnelState.saleValue}
                  </p>
                )}
              </div>
            </Section>
          )}

          {/* Sales checklist — see `ChecklistSection`. Wrapped rather than
              inlined so an absent `salesChecklists.forConversation` costs
              this one panel instead of the whole Inbox route. */}
          {conversationId && (
            <OptionalFeatureBoundary feature="salesChecklists.forConversation">
              <ChecklistSection
                conversationId={conversationId as Id<"conversations">}
                canEdit={canWorkThisLead}
              />
            </OptionalFeatureBoundary>
          )}

          <Divider />

          {/* AI tag suggestion banner — conversationId-scoped (a pending
              classification is keyed by conversation, not contact), so
              only rendered once a conversation is actually selected,
              same `conversationId &&` guard the funnel Section above
              uses. */}
          {conversationId && (
            <TagSuggestionBanner contactId={contact.id} conversationId={conversationId} />
          )}

          {/* Labels */}
          <div>
            <SectionLabel icon={TagIcon} label={tLabels("title")} />
            <LabelPicker contactId={contact.id} tags={tags} />
          </div>

          {/* Everything below this line is reference detail: read when
              something is being looked up, not while working the
              conversation. Each one collapses, remembers its own last
              state, and shows a marker when shut over content — so
              "collapsed" never reads as "empty". The second argument to
              `sectionProps` is `editable`: it is what stops Edit from
              force-opening Acquisition, Deals and Activity, which hold no
              editable fields and would only re-crowd the panel at the
              moment the user is trying to focus on one. It also decides
              which headers go inert during Edit — a forced-open section
              cannot honour a toggle, so it stops offering one. */}
          <div className="mt-4">
            <ContactCollapsibleSection
              sectionKey="travel"
              icon={Plane}
              label={tSidebar("sectionTravel")}
              marker={hasTravelDetail}
              {...sectionProps("travel", true)}
            >
              <ContactTravelFields
                form={form}
                editing={editing}
                set={set}
                contact={contact}
              />
            </ContactCollapsibleSection>

            <ContactCollapsibleSection
              sectionKey="location"
              icon={MapPin}
              label={tSidebar("sectionLocation")}
              marker={hasLocationDetail}
              {...sectionProps("location", true)}
            >
              <ContactLocationFields
                form={form}
                editing={editing}
                set={set}
                contact={contact}
              />
            </ContactCollapsibleSection>

            {contact.acquisition_source === "ad" && (
              <ContactCollapsibleSection
                sectionKey="acquisition"
                icon={Megaphone}
                label={tSidebar("sectionAcquisition")}
                marker={hasAcquisitionDetail}
                {...sectionProps("acquisition", false)}
              >
                <ContactAcquisitionFields contact={contact} />
              </ContactCollapsibleSection>
            )}

            <ContactCollapsibleSection
              sectionKey="about"
              icon={Info}
              label={tSidebar("sectionAbout")}
              marker={hasAboutDetail}
              {...sectionProps("about", true)}
            >
              <ContactAboutFields
                form={form}
                editing={editing}
                set={set}
                contact={contact}
              />
            </ContactCollapsibleSection>

            {/* Key facts (custom fields) — see contact-key-facts.tsx for
                the remount-on-contact-switch rationale. */}
            <ContactCollapsibleSection
              sectionKey="keyFacts"
              icon={SlidersHorizontal}
              label={tCustom("title")}
              marker
              {...sectionProps("keyFacts", true)}
            >
              <ContactKeyFacts contactId={contact.id} />
            </ContactCollapsibleSection>

            <ContactCollapsibleSection
              sectionKey="deals"
              icon={DollarSign}
              label={tSidebar("deals")}
              marker={deals.length}
              {...sectionProps("deals", false)}
            >
              <div className="mt-2 space-y-2">
                {dealsState === "loading" ? (
                  <div className="space-y-2" aria-hidden>
                    <div className="h-14 animate-pulse rounded-lg bg-muted" />
                    <div className="h-14 animate-pulse rounded-lg bg-muted" />
                  </div>
                ) : dealsState === "empty" ? (
                  <p className="px-1 text-xs text-muted-foreground">
                    {tSidebar("noDeals")}
                  </p>
                ) : (
                  deals.map((deal) => (
                    <div key={deal.id} className="rounded-lg bg-muted px-3 py-2">
                      <p className="text-sm font-medium text-foreground">
                        {deal.title}
                      </p>
                      <div className="mt-1 flex items-center justify-between text-xs text-muted-foreground">
                        <span>
                          {deal.currency ?? "$"}
                          {deal.value.toLocaleString()}
                        </span>
                        {deal.stage && (
                          <span
                            className="rounded-full px-1.5 py-0.5 text-[11px]"
                            style={{
                              backgroundColor: `${deal.stage.color}20`,
                              color: deal.stage.color,
                            }}
                          >
                            {deal.stage.name}
                          </span>
                        )}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </ContactCollapsibleSection>

            {/* Activity (Task 5) — the numbered "everything that has
                happened" feed. Replaces the sidebar's old inline notes
                block — one place to add a note, not two that look
                different. */}
            <ContactCollapsibleSection
              sectionKey="activity"
              icon={History}
              label={tActivity("title")}
              marker
              {...sectionProps("activity", false)}
            >
              <ContactActivity
                contactId={contact.id as Id<"contacts">}
                canManageNote={(note) =>
                  (!!note.createdByUserId && note.createdByUserId === user?.id) ||
                  (!!accountRole && hasMinRole(accountRole, "admin"))
                }
              />
            </ContactCollapsibleSection>
          </div>
        </div>
      </ScrollArea>
    </div>
  );
}

/**
 * The post-qualification sales checklist, worked inside the chat instead
 * of on the Leads page (Task 7, inbox-assignment-trail-and-checklist).
 *
 * Renders NOTHING when `forConversation` returns null — this conversation
 * never qualified, or its checklist has not been generated — which is
 * most chats: the panel stays calm, the same rule `QualificationChip`
 * follows in the header.
 *
 * A component of its own for two reasons. It owns the ONLY subscription
 * to `salesChecklists.forConversation`, so wrapping it in
 * `OptionalFeatureBoundary` actually catches that query's render-time
 * throw (a hook throws in the component that calls it, so a boundary
 * placed around markup inside `ContactSidebar` would catch nothing). And
 * `LeadChecklist` already draws its own header — icon, title, source
 * badge, progress bar — so this section deliberately adds no
 * `SectionLabel`; the two together rendered the words "Sales checklist"
 * twice, eight pixels apart. The `<Divider />` stays, so the section
 * still separates from the funnel above it.
 */
function ChecklistSection({
  conversationId,
  canEdit,
}: {
  conversationId: Id<"conversations">;
  canEdit: boolean;
}) {
  const t = useTranslations("Leads.checklist");
  const checklist = useQuery(api.salesChecklists.forConversation, {
    conversationId,
  });
  const setItemDone = useMutation(api.salesChecklists.setItemDone);
  const reopenItem = useMutation(api.salesChecklists.reopenItem);

  const handleCompleteItem = useCallback(
    async (itemKey: string, note: string) => {
      if (!checklist) return;
      try {
        await setItemDone({
          checklistId: checklist.checklistId as Id<"salesChecklists">,
          itemKey,
          note,
        });
      } catch (err) {
        // Same reason mapping the Leads board uses — the server rejects a
        // completion with no note, and the agent must be told which rule
        // they hit rather than a generic failure.
        const reason = convexErrorData(err)?.reason;
        toast.error(
          reason === "note_required" ? t("noteRequired") : t("updateError"),
        );
      }
    },
    [checklist, setItemDone, t],
  );

  const handleReopenItem = useCallback(
    async (itemKey: string) => {
      if (!checklist) return;
      try {
        await reopenItem({
          checklistId: checklist.checklistId as Id<"salesChecklists">,
          itemKey,
        });
      } catch {
        toast.error(t("updateError"));
      }
    },
    [checklist, reopenItem, t],
  );

  if (!checklist) return null;

  return (
    <>
      <Divider />
      <LeadChecklist
        checklist={checklist}
        canEdit={canEdit}
        onCompleteItem={handleCompleteItem}
        onReopenItem={handleReopenItem}
      />
    </>
  );
}

function Divider() {
  return <div className="my-4 border-t border-border" />;
}

function Section({
  icon,
  label,
  children,
}: {
  icon: typeof TagIcon;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <>
      <Divider />
      <div>
        <SectionLabel icon={icon} label={label} />
        <div className="mt-2 space-y-1">{children}</div>
      </div>
    </>
  );
}
