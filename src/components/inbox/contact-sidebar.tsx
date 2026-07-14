"use client";

import { useState, useCallback, useEffect, type ChangeEvent } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { toUiContactNote, toUiDeal } from "@/lib/convex/adapters";
import type { Contact } from "@/types";
import { formatPhoneIntl } from "@/lib/whatsapp/phone-utils";
import {
  Phone,
  Smartphone,
  Mail,
  Copy,
  Check,
  Tag as TagIcon,
  DollarSign,
  StickyNote,
  Plus,
  Pencil,
  MapPin,
  Plane,
  Info,
  Megaphone,
  ExternalLink,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { format } from "date-fns";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

interface ContactSidebarProps {
  contact: Contact | null;
}

type EditForm = {
  name: string;
  company: string;
  email: string;
  altPhone: string;
  address: string;
  city: string;
  country: string;
  nationality: string;
  preferredDestination: string;
  notes: string;
};

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
    notes: c.notes ?? "",
  };
}

export function ContactSidebar({ contact }: ContactSidebarProps) {
  const tSidebar = useTranslations("Inbox.sidebar");
  const tThread = useTranslations("Inbox.messageThread");

  const [copied, setCopied] = useState(false);
  const [newNote, setNewNote] = useState("");
  const [addingNote, setAddingNote] = useState(false);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState<EditForm | null>(null);

  const contactId = contact ? (contact.id as Id<"contacts">) : undefined;

  // Leave edit mode + drop the draft whenever the active contact changes.
  useEffect(() => {
    setEditing(false);
    setForm(null);
  }, [contactId]);

  // Deals + notes are reactive Convex queries keyed on the contact —
  // switching contacts (or another tab editing the same contact)
  // updates these automatically, no fetch-on-mount effect needed.
  const dealDocs = useQuery(
    api.deals.listByContact,
    contactId ? { contactId } : "skip",
  );
  const deals = (dealDocs ?? []).map(toUiDeal);

  const noteDocs = useQuery(
    api.contactNotes.listForContact,
    contactId ? { contactId } : "skip",
  );
  const notes = (noteDocs ?? []).map(toUiContactNote);

  const tags = contact?.tags ?? [];

  const addNote = useMutation(api.contactNotes.add);
  const updateContact = useMutation(api.contacts.update);

  const handleCopyPhone = useCallback(async () => {
    if (!contact?.phone) return;
    await navigator.clipboard.writeText(formatPhoneIntl(contact.phone));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [contact]);

  const handleAddNote = useCallback(async () => {
    if (!contact || !newNote.trim()) return;
    setAddingNote(true);
    try {
      await addNote({
        contactId: contact.id as Id<"contacts">,
        body: newNote.trim(),
      });
      setNewNote("");
    } catch (err) {
      console.error("Failed to add note:", err);
      toast.error("Failed to add note");
    } finally {
      setAddingNote(false);
    }
  }, [contact, newNote, addNote]);

  const startEdit = useCallback(() => {
    if (!contact) return;
    setForm(formToState(contact));
    setEditing(true);
  }, [contact]);

  const cancelEdit = useCallback(() => {
    setEditing(false);
    setForm(null);
  }, []);

  const handleSave = useCallback(async () => {
    if (!contact || !form) return;
    setSaving(true);
    try {
      await updateContact({
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
        notes: form.notes.trim() || undefined,
      });
      toast.success(tSidebar("saved"));
      setEditing(false);
      setForm(null);
    } catch (err) {
      console.error("Failed to update contact:", err);
      toast.error(tSidebar("saveError"));
    } finally {
      setSaving(false);
    }
  }, [contact, form, updateContact, tSidebar]);

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
  const initials = displayName.charAt(0).toUpperCase();
  const set =
    (k: keyof EditForm) =>
    (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setForm((f) => (f ? { ...f, [k]: e.target.value } : f));

  const inputCls =
    "w-full rounded-lg border border-border bg-muted px-3 py-2 text-sm text-foreground placeholder-muted-foreground outline-none focus:border-primary/50";

  return (
    <div className="flex h-full w-full flex-col bg-card">
      <ScrollArea className="min-h-0 flex-1">
        <div className="p-4">
          {/* Header: avatar + name/company + Edit toggle */}
          <div className="flex flex-col items-center text-center">
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-muted text-lg font-semibold text-foreground">
              {contact.avatar_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={contact.avatar_url}
                  alt={displayName}
                  className="h-16 w-16 rounded-full object-cover"
                />
              ) : (
                initials
              )}
            </div>
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

          {/* Section: Contact */}
          <Section icon={Phone} label={tSidebar("sectionContact")}>
            {/* WhatsApp number — read-only routing key, copyable */}
            <button
              onClick={handleCopyPhone}
              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted"
            >
              <Phone className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="flex-1 text-left">
                {formatPhoneIntl(contact.phone)}
              </span>
              {copied ? (
                <Check className="h-3 w-3 text-primary" />
              ) : (
                <Copy className="h-3 w-3 text-muted-foreground" />
              )}
            </button>

            <Field
              icon={Smartphone}
              label={tSidebar("altPhone")}
              editing={editing}
              value={form?.altPhone ?? ""}
              display={
                contact.alt_phone ? formatPhoneIntl(contact.alt_phone) : ""
              }
              onChange={set("altPhone")}
              placeholder="+971…"
              notFilled={tSidebar("notFilled")}
            />
            <Field
              icon={Mail}
              label={tSidebar("email")}
              editing={editing}
              value={form?.email ?? ""}
              display={contact.email ?? ""}
              onChange={set("email")}
              placeholder={tSidebar("email")}
              notFilled={tSidebar("notFilled")}
            />
          </Section>

          {contact.acquisition_source === "ad" && (
            <Section icon={Megaphone} label={tSidebar("sectionAcquisition")}>
              <div className="px-3 py-2">
                <p className="text-xs text-muted-foreground">
                  {tSidebar("acquiredViaAd")}
                </p>
                {contact.acquisition_ad?.headline && (
                  <p className="mt-0.5 text-sm text-foreground">
                    {contact.acquisition_ad.headline}
                  </p>
                )}
                {contact.acquisition_ad?.source_url && (
                  <a
                    href={contact.acquisition_ad.source_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-0.5 inline-flex items-center gap-0.5 text-xs text-primary hover:underline"
                  >
                    {tSidebar("viewAd")}
                    <ExternalLink className="h-3 w-3" />
                  </a>
                )}
              </div>
            </Section>
          )}

          {/* Section: Location */}
          <Section icon={MapPin} label={tSidebar("sectionLocation")}>
            <Field
              label={tSidebar("address")}
              editing={editing}
              value={form?.address ?? ""}
              display={contact.address ?? ""}
              onChange={set("address")}
              placeholder={tSidebar("address")}
              notFilled={tSidebar("notFilled")}
            />
            <Field
              label={tSidebar("city")}
              editing={editing}
              value={form?.city ?? ""}
              display={contact.city ?? ""}
              onChange={set("city")}
              placeholder={tSidebar("city")}
              notFilled={tSidebar("notFilled")}
            />
            <Field
              label={tSidebar("country")}
              editing={editing}
              value={form?.country ?? ""}
              display={contact.country ?? ""}
              onChange={set("country")}
              placeholder={tSidebar("country")}
              notFilled={tSidebar("notFilled")}
            />
          </Section>

          {/* Section: Travel profile */}
          <Section icon={Plane} label={tSidebar("sectionTravel")}>
            <Field
              label={tSidebar("nationality")}
              editing={editing}
              value={form?.nationality ?? ""}
              display={contact.nationality ?? ""}
              onChange={set("nationality")}
              placeholder={tSidebar("nationality")}
              notFilled={tSidebar("notFilled")}
            />
            <Field
              label={tSidebar("preferredDestination")}
              editing={editing}
              value={form?.preferredDestination ?? ""}
              display={contact.preferred_destination ?? ""}
              onChange={set("preferredDestination")}
              placeholder={tSidebar("preferredDestination")}
              notFilled={tSidebar("notFilled")}
            />
          </Section>

          {/* Section: About (persistent freeform) */}
          <Section icon={Info} label={tSidebar("sectionAbout")}>
            {editing && form ? (
              <textarea
                value={form.notes}
                onChange={set("notes")}
                placeholder={tSidebar("aboutPlaceholder")}
                rows={3}
                className={`resize-none ${inputCls}`}
              />
            ) : contact.notes ? (
              <p className="whitespace-pre-wrap px-1 text-sm text-foreground">
                {contact.notes}
              </p>
            ) : (
              <p className="px-1 text-xs text-muted-foreground">
                {tSidebar("notFilled")}
              </p>
            )}
          </Section>

          <Divider />

          {/* Tags */}
          <div>
            <SectionLabel icon={TagIcon} label={tSidebar("tags")} />
            <div className="mt-2 flex flex-wrap gap-1">
              {tags.length === 0 ? (
                <p className="px-1 text-xs text-muted-foreground">
                  {tSidebar("noTags")}
                </p>
              ) : (
                tags.map((tag) => (
                  <span
                    key={tag.id}
                    className="rounded-full px-2 py-0.5 text-[10px] font-medium"
                    style={{
                      backgroundColor: `${tag.color}20`,
                      color: tag.color,
                    }}
                  >
                    {tag.name}
                  </span>
                ))
              )}
            </div>
          </div>

          <Divider />

          {/* Active Deals */}
          <div>
            <SectionLabel icon={DollarSign} label={tSidebar("deals")} />
            <div className="mt-2 space-y-2">
              {deals.length === 0 ? (
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
                          className="rounded-full px-1.5 py-0.5 text-[10px]"
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
          </div>

          <Divider />

          {/* Notes log (dated entries) */}
          <div>
            <SectionLabel icon={StickyNote} label={tSidebar("notes")} />
            <div className="mt-2">
              <div className="flex gap-2">
                <textarea
                  value={newNote}
                  onChange={(e) => setNewNote(e.target.value)}
                  placeholder={tSidebar("addNotePlaceholder")}
                  rows={2}
                  className="flex-1 resize-none rounded-lg border border-border bg-muted px-3 py-2 text-xs text-foreground placeholder-muted-foreground outline-none focus:border-primary/50"
                />
                <Button
                  size="sm"
                  className="h-auto bg-primary px-2 hover:bg-primary/90"
                  onClick={handleAddNote}
                  disabled={!newNote.trim() || addingNote}
                >
                  <Plus className="h-3 w-3" />
                </Button>
              </div>
              <div className="mt-2 space-y-2">
                {notes.map((note) => (
                  <div key={note.id} className="rounded-lg bg-muted px-3 py-2">
                    <p className="whitespace-pre-wrap text-xs text-muted-foreground">
                      {note.note_text}
                    </p>
                    <p className="mt-1 text-[10px] text-muted-foreground">
                      {format(new Date(note.created_at), "MMM d, yyyy HH:mm")}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </ScrollArea>
    </div>
  );
}

function Divider() {
  return <div className="my-4 border-t border-border" />;
}

function SectionLabel({
  icon: Icon,
  label,
}: {
  icon: typeof TagIcon;
  label: string;
}) {
  return (
    <div className="flex items-center gap-2 px-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
      <Icon className="h-3 w-3" />
      {label}
    </div>
  );
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

function Field({
  icon: Icon,
  label,
  editing,
  value,
  display,
  onChange,
  placeholder,
  notFilled,
}: {
  icon?: typeof TagIcon;
  label: string;
  editing: boolean;
  value: string;
  display: string;
  onChange: (e: ChangeEvent<HTMLInputElement>) => void;
  placeholder: string;
  notFilled: string;
}) {
  if (editing) {
    return (
      <label className="block px-1">
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
          {label}
        </span>
        <input
          value={value}
          onChange={onChange}
          placeholder={placeholder}
          className="mt-1 w-full rounded-lg border border-border bg-muted px-3 py-2 text-sm text-foreground placeholder-muted-foreground outline-none focus:border-primary/50"
        />
      </label>
    );
  }
  return (
    <div className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm">
      {Icon && <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />}
      <span className="min-w-0 flex-1 truncate text-foreground">
        {display || <span className="text-muted-foreground">{notFilled}</span>}
      </span>
    </div>
  );
}
