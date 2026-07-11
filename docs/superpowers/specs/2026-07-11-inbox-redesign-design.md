# Inbox Redesign — Design Spec

**Date:** 2026-07-11
**Branch:** `feat/inbox-redesign`
**Status:** Approved (design), pending implementation plan

## Goal

Make the Inbox (`/inbox`) more efficient, attractive, and easy to use by
reworking three surfaces:

1. **Left navigation menu** — add a collapsible icon-rail mode.
2. **Contact information panel** — stop showing it permanently; open it only
   when the agent clicks the contact name/number in the chat header, as a
   slide-over drawer.
3. **Contact panel content** — richer, editable contact fields, with phone
   numbers always displayed in `+<country code>` form (default `+971`).

Non-goals: no changes to conversation-list logic, message sending, WhatsApp
routing, or the standalone Contacts section (`/contacts`). No data migration.

## Constraints

- The app is a **customized Next.js** (`wacrm2.0/AGENTS.md`): read the bundled
  docs under `node_modules/next/dist/docs/` before writing framework code.
- Code retrieval must go through the Augment (`auggie`) MCP server first
  (project `CLAUDE.md`).
- Backend is **self-hosted Convex**. New contact fields are additive and
  optional → backward-compatible, no migration required.
- Hydration safety: any localStorage-backed default must render the
  server-default first, then reconcile after mount (mirror the existing
  `CONTACT_PANEL_STORAGE_KEY` pattern in `inbox/page.tsx`).

## A. Collapsible left menu (icon rail)

**File:** `src/components/layout/sidebar.tsx`

- New self-contained `collapsed` boolean state, persisted to localStorage key
  `wacrm:sidebar:collapsed`. Desktop (`lg+`) only; mobile drawer behavior is
  unchanged.
- Default expanded on server render; reconcile from localStorage after mount
  (no hydration mismatch).
- **Expanded:** current look — `lg:w-60`, icon + label + beta/unread/notification
  badges.
- **Collapsed:** `lg:w-16` icon rail. Icons centered; labels hidden; each nav
  item wrapped in a **tooltip** that shows its label on hover. Unread dot and
  notification badge collapse to a small corner indicator on the icon. Logo row
  shows only the mark. User footer shows only the avatar (dropdown menu still
  works, opens on click).
- A **chevron toggle** (`«` expanded / `»` collapsed) lives in the sidebar logo
  row, desktop-only, flips `collapsed`.
- Requires a Tooltip primitive. Verify `@/components/ui/tooltip` exists; if not,
  add the shadcn tooltip component (follow existing `src/components/ui`
  conventions).

## B. Contact panel: click-to-open slide-over

**Files:** `src/app/(dashboard)/inbox/page.tsx`,
`src/components/inbox/message-thread.tsx`, and a small drawer wrapper
(`src/components/inbox/contact-panel-drawer.tsx` or inline in the page).

- **Default closed.** Panel state resets to closed whenever the active
  conversation changes (open/switch a chat ⇒ collapsed). Replaces today's
  `contactPanelOpen` default of `true`; the localStorage "remember open"
  behavior is removed (the panel is on-demand, not sticky).
- **Trigger:** the name + phone block in the thread header
  (`message-thread.tsx:598-601`) becomes a `<button>` with a hover affordance
  (subtle background + a "view details" chevron cue). Clicking toggles the
  panel. Existing separate toggle button (if any) is removed or folded into
  this.
- **Close:** clicking the ✕ in the drawer header, pressing **Esc**, or clicking
  the chat area (light scrim over the thread region catches the outside click).
- **Style — slide-over drawer:**
  - Desktop: absolutely positioned over the right edge of the thread
    (`absolute inset-y-0 right-0`, width ~360px, left border + shadow,
    slide/fade transition). The chat does **not** resize underneath it.
  - Mobile: full-width sheet sliding in from the right, with a light scrim.
    (Today the panel is fully hidden on mobile; the drawer makes contact
    details reachable on mobile for the first time.)
  - The thread/center container becomes `relative` to anchor the absolute
    drawer; ensure the drawer's z-index sits above message content.

## C. Contact panel: enhanced & editable content

**File:** `src/components/inbox/contact-sidebar.tsx` (panel content).

Reorganized into labeled sections. A **pencil "Edit" button** in the panel
header flips the info fields into a single form (inputs), with **Save / Cancel**.
Save issues one `contacts.update` mutation call with the changed fields.

Sections:

- **Identity** — avatar, `name`*, `company`*.
- **Contact** — WhatsApp number (**read-only**, formatted with `+`, copyable —
  it is the conversation routing key, so not editable in this panel),
  `altPhone`*, `email`*.
- **Location** — `address`*, `city`*, `country`*.
- **Travel profile** — `nationality`*, `preferredDestination`*.
- **About** — a single persistent freeform `notes`* field, shown above the
  **existing timestamped notes log** (the `contactNotes` add/list system stays
  as-is; the new `notes` field is a persistent "about this contact" scratchpad,
  distinct from the dated log).
- **Tags** and **Deals** — unchanged.

(*= editable via the Edit form.)

Empty editable fields render a muted "Add …" affordance rather than nothing, so
agents can discover them.

## D. Phone formatting (`+971` default, international allowed)

**File:** `src/lib/whatsapp/phone-utils.ts` (new helper), consumed by the panel
and any contact input.

- **Display helper** `formatPhoneIntl(phone: string, opts?: { defaultCc?: string })`:
  - Strip non-digits; if the input had a leading `00`, drop it; return
    `"+" + digits`. Result always begins with `+`, never `00` or bare digits.
  - Applied to existing stored numbers at render time (WhatsApp numbers are
    already stored with country code), so no migration is needed.
- **Input** (alternate phone field, and any add-contact form path):
  - Field shows a fixed `+` adornment; prefills `971` when empty (UAE default).
  - Accepts any country code (travel agency has international clients).
  - Validates the digits with the existing `isValidE164`; on `00`/bare input,
    normalize to `+<digits>` before save. Stored in `+E.164` form.
- Reuse existing `normalizePhone` / `isValidE164`; do not add a phone library.

## E. Data model & backend changes

- **`convex/schema.ts`** — `contacts` table gains optional fields:
  `altPhone`, `address`, `city`, `country`, `nationality`,
  `preferredDestination`, `notes`. All `v.optional(v.string())`.
- **`convex/contacts.ts`** — `update` mutation args extended to accept the new
  fields (all optional); patched through to `ctx.db.patch`. `create` /
  `findOrCreateContactByPhone` unchanged (new fields are edit-only).
- **`src/types/index.ts`** — `Contact` interface gains the new optional fields
  (snake_case to match the type's convention: `alt_phone`, `address`, `city`,
  `country`, `nationality`, `preferred_destination`, `notes`).
- **`src/lib/convex/adapters.ts`** — contact adapter maps the new Convex fields
  onto the UI `Contact` type.

## F. Files touched (summary)

| File | Change |
| --- | --- |
| `src/components/layout/sidebar.tsx` | collapse state, icon-rail mode, tooltips, chevron toggle |
| `src/app/(dashboard)/inbox/page.tsx` | default-closed panel, reset on conversation change, mount drawer |
| `src/components/inbox/message-thread.tsx` | header name/phone becomes the panel trigger button |
| `src/components/inbox/contact-sidebar.tsx` | sectioned, editable content; new fields; phone formatting |
| `src/components/inbox/contact-panel-drawer.tsx` (new, optional) | slide-over wrapper (overlay, Esc, scrim, animation) |
| `src/lib/whatsapp/phone-utils.ts` | `formatPhoneIntl` display helper |
| `convex/schema.ts` | new optional `contacts` fields |
| `convex/contacts.ts` | `update` accepts new fields |
| `src/types/index.ts` | `Contact` gains new fields |
| `src/lib/convex/adapters.ts` | map new fields |
| `src/components/ui/tooltip.tsx` (maybe) | add if missing |

## Testing / verification

- Unit: `formatPhoneIntl` (bare digits, `00` prefix, already-`+`, empty, UAE
  default) alongside the existing `phone-utils.test.ts`.
- Backend: extend `convex/contacts.test.ts` for `update` persisting the new
  fields.
- Manual (preview): collapse/expand the menu (tooltips, persistence across
  reload); open a chat → panel is closed → click the header name → drawer slides
  in → Esc / scrim / ✕ close it; edit fields → Save → values persist and
  re-render; confirm the WhatsApp number renders with a leading `+`.

## Open items to confirm during planning

- Presence/behavior of a `Tooltip` UI primitive.
- Exact shape of the contact adapter in `src/lib/convex/adapters.ts`.
- Whether `message-thread.tsx` currently renders a standalone panel-toggle
  button that should be removed once the header name is the trigger.
