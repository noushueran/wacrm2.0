"use client";

import { ContactCustomFields } from "./contact-custom-fields";

/** Key-facts section of the contact panel: the custom-fields block.
 *  Extracted verbatim from `contact-sidebar.tsx` so it
 *  can be hoisted within the panel layout independently of the rest of
 *  the sidebar (see task 6 of the conversation-notes-p2 plan). No
 *  behaviour change from the original inline block — same
 *  `Inbox.customFields` copy. Its heading and icon moved out to the
 *  `ContactCollapsibleSection` that now wraps it — two of them stacked
 *  rendered the word "Details" twice, eight pixels apart.
 *
 *  `ContactCustomFields` is keyed on `contactId` so the section fully
 *  remounts on contact switch. `ContactSidebar` (this component's parent)
 *  never unmounts across contacts — it lives inside the always-mounted
 *  `ContactPanelDrawer` — and `FieldInput`'s text/date/number inputs are
 *  uncontrolled (`defaultValue`) for a smooth typing experience, so
 *  without this key they'd keep showing the previous contact's stale
 *  value — and silently resave it — until the user actually edited that
 *  field. */
export function ContactKeyFacts({ contactId }: { contactId: string }) {
  return <ContactCustomFields key={contactId} contactId={contactId} />;
}
