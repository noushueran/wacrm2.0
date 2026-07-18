# Rich WhatsApp contact cards on lead acceptance — design

**Date:** 2026-07-18 · **Status:** approved (autonomous session; owner request)

## Problem

When a salesperson accepts a qualified lead, `qualificationEngine.announceAssignment`
sends the customer a confirmation text plus a contact card via
`metaSend.sendContactCard`. Today that card carries **only a name and one phone
number** — a "weak card". The owner wants a proper vCard-quality card per
salesperson: full name, job title, company, direct number, company phone/email/
website/address — and the inbox should render it as a card, not the current
plain-text `📇 name\nphone` row.

## Approach

WhatsApp Business (Meta Cloud) API sends contact cards as `type: "contacts"`
messages — a structured JSON contacts array that WhatsApp delivers as the native
tap-to-save vCard card. That is the correct "proper .vcf" mechanism on this API:
uploading a literal `.vcf` file is not possible (`text/vcard` is not an accepted
document MIME type), and the `contacts` payload is exactly WhatsApp's vCard
representation. We therefore **enrich the existing `contacts` send with every
field the Cloud API supports**: name parts, `org` (company + title), multiple
typed phones (`wa_id` for tap-to-chat), emails, urls, and a business address.

**Known platform limitation:** the Cloud API contacts payload has **no photo/logo
field**, so a logo cannot be embedded inside the card itself. The company logo
reaches the customer as the WhatsApp Business profile photo on the chat. Noted
for the owner rather than worked around with a hack.

## Data model (all additive/optional — safe to deploy backend-first)

- `memberships.jobTitle?: string` — per-salesperson title ("Senior Travel
  Consultant"), edited by admins in Settings → Team members next to the existing
  `phone` field.
- `qualificationConfigs.contactCard?: { companyName?, website?, email?, phone?,
  street?, city?, state?, zip?, country?, countryCode? }` — company-wide card
  info, edited in the AI-agent settings panel next to the auto-assign toggle
  (the feature this card decorates). Reuses the existing `updateConfig`
  whitelist+validator save path — no new table, no new module, no
  `_generated` hand-edits.
- `messages.contentType` gains a `"contacts"` literal and the row an optional
  `contactsPayload` (the contacts JSON we sent) so the inbox renders a real
  card bubble. `contentText` still carries a readable fallback (conversation
  previews + older clients mid-deploy render it via the bubble `default` case).

## Flow

`announceContext` additionally loads the account (company-name fallback), the
qualification config's `contactCard`, and the membership's `jobTitle`, and
returns a `card` object. `announceAssignment` passes it to
`metaSend.sendContactCard`, which builds the full Cloud API payload via a new
pure `buildContactsPayload(card)` in `metaApi.ts` (unit-tested), sends it, and
persists `contentType: "contacts"` + `contactsPayload` + text fallback.

With **zero configuration** the card still improves: name + title-less org
(account name) + direct phone. Every configured field enriches it further.

Inbound shared contacts (customer → us) stop rendering as
`[Unsupported message type: contacts]`; `webhookParse` maps them to a readable
`📇 Shared contact: …` text row (full structured inbound cards are out of scope
— rare, and the hot ingest path stays untouched).

## Out of scope

Manual "send my card" from the inbox composer; per-member card email overrides;
inbound structured card storage; any change to offer/acceptance mechanics.

## Testing

Pure-function unit tests for `buildContactsPayload` (field pruning, wa_id
derivation, minimal vs full cards) and `validateConfigPatch`'s `contactCard`
rules; convex-test round-trips for `updateConfig` with `contactCard` and
`members.setJobTitle`; existing suites must stay green. Deploy order:
convex deploy before the Netlify merge (established backend-first rule).
