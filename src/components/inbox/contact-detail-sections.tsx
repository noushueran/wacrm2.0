"use client";

// ============================================================
// The contact panel's reference detail — travel, location, acquisition
// and about. Extracted from `contact-sidebar.tsx` (958 lines carrying
// layout, queries, edit state, photo staging AND every field group) so
// the sidebar can own composition and these can own fields.
//
// Each component renders only the INSIDE of its section: the heading and
// the collapse control belong to `ContactCollapsibleSection`.
// ============================================================

import type { ChangeEvent } from "react";
import { useTranslations } from "next-intl";
import { Tag as TagIcon, ExternalLink, Smartphone, Mail } from "lucide-react";
import type { Contact } from "@/types";
import { formatPhoneIntl } from "@/lib/whatsapp/phone-utils";

/** The contact panel's edit-mode draft. Lives here rather than in
 *  `contact-sidebar.tsx` because `Field` below needs it and every field
 *  group in this file writes through it — the sidebar imports it back,
 *  so this stays the only cross-file edge instead of a circular one. */
export type EditForm = {
  name: string;
  company: string;
  email: string;
  altPhone: string;
  address: string;
  city: string;
  country: string;
  nationality: string;
  preferredDestination: string;
  travelDates: string;
  travelers: string;
  budget: string;
  notes: string;
};

/** One label/value row, editable in place. Used by the field groups
 *  below (Location, Travel, About). Exported because the row shape is
 *  the panel's rather than any one group's. */
export function Field({
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
        <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
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

/** Shared with `contact-sidebar.tsx`'s name/company edit inputs — moved
 *  here (not duplicated) so the two call sites can't drift. */
export const inputCls =
  "w-full rounded-lg border border-border bg-muted px-3 py-2 text-sm text-foreground placeholder-muted-foreground outline-none focus:border-primary/50";

/** Shared shape for the three editable field groups below. `set` is the
 *  sidebar's existing `set(key)` closure, passed straight through and
 *  kept as a `ChangeEvent` handler-factory — not converted to a
 *  `Partial<EditForm>` patch callback — so every `Field`/`textarea`
 *  wiring here stays byte-identical to what `contact-sidebar.tsx` had
 *  inline. */
interface ContactFieldGroupProps {
  form: EditForm | null;
  editing: boolean;
  set: (
    k: keyof EditForm,
  ) => (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => void;
  contact: Contact;
}

/** Acquisition — read-only Click-to-WhatsApp ad provenance. Only ever
 *  rendered when `contact.acquisition_source === "ad"`; that guard stays
 *  in `contact-sidebar.tsx`, which wraps this in
 *  `ContactCollapsibleSection` — the `<Section>` this used to sit in is
 *  gone. */
export function ContactAcquisitionFields({ contact }: { contact: Contact }) {
  const tSidebar = useTranslations("Inbox.sidebar");

  return (
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
  );
}

/** Location — address, city, country.
 *
 *  The `space-y-1` here (and on Travel and About below) used to come from
 *  the `<Section>` wrapper these groups sat in. `ContactCollapsibleSection`
 *  supplies only its own `pb-3`, so each group now spaces its own rows —
 *  without it, two consecutive edit-mode `<label>`s touch. */
export function ContactLocationFields({
  form,
  editing,
  set,
  contact,
}: ContactFieldGroupProps) {
  const tSidebar = useTranslations("Inbox.sidebar");

  return (
    <div className="space-y-1">
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
    </div>
  );
}

/** Travel profile — nationality, destination, dates, travelers, budget. */
export function ContactTravelFields({
  form,
  editing,
  set,
  contact,
}: ContactFieldGroupProps) {
  const tSidebar = useTranslations("Inbox.sidebar");

  return (
    <div className="space-y-1">
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
      <Field
        label={tSidebar("travelDates")}
        editing={editing}
        value={form?.travelDates ?? ""}
        display={contact.travel_dates ?? ""}
        onChange={set("travelDates")}
        placeholder={tSidebar("travelDates")}
        notFilled={tSidebar("notFilled")}
      />
      <Field
        label={tSidebar("travelers")}
        editing={editing}
        value={form?.travelers ?? ""}
        display={contact.travelers ?? ""}
        onChange={set("travelers")}
        placeholder={tSidebar("travelers")}
        notFilled={tSidebar("notFilled")}
      />
      <Field
        label={tSidebar("budget")}
        editing={editing}
        value={form?.budget ?? ""}
        display={contact.budget ?? ""}
        onChange={set("budget")}
        placeholder={tSidebar("budget")}
        notFilled={tSidebar("notFilled")}
      />
    </div>
  );
}

/** About — persistent freeform notes, plus the alternate number and
 *  email. Those two came from the standalone Contact section, which the
 *  panel reorganization deleted: the WhatsApp number it existed for is
 *  pinned in the identity header now, and a second phone and an email
 *  address are reference detail, not something read on every
 *  conversation. */
export function ContactAboutFields({
  form,
  editing,
  set,
  contact,
}: ContactFieldGroupProps) {
  const tSidebar = useTranslations("Inbox.sidebar");

  return (
    <div className="space-y-1">
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
      <Field
        icon={Smartphone}
        label={tSidebar("altPhone")}
        editing={editing}
        value={form?.altPhone ?? ""}
        display={contact.alt_phone ? formatPhoneIntl(contact.alt_phone) : ""}
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
    </div>
  );
}
