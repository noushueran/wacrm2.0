# Inbox tag groups, labels & follow-ups — design

- **Date:** 2026-07-15
- **Status:** Approved (pending spec review)
- **Branch:** `feat/inbox-tag-label-system` (based on `main`)

## Problem

The inbox handles a high volume of chats, but there is no efficient way to
segment them. Concretely:

1. **You can't label a chat from the inbox.** Tags exist (`tags` /
   `contactTags`), but the inbox contact sidebar only *displays* them — there is
   no way to add or remove a tag while working a chat. They're created in
   Settings and can only be attached from the Contacts page.
2. **There is no categorisation structure.** Tags are a single flat list. A
   travel agency needs to segment by *product* (UAE Visa, Global Visa, Packages),
   and Packages further by *destination* — plus "many other things in the future".
   A flat list can't express these dimensions.
3. **Custom fields can't be set from the inbox** and are text-only. The schema
   already carries `fieldType` / `fieldOptions`, but the UI renders plain text
   inputs, and values are editable only from the Contacts page — not while
   working a chat.
4. **No time awareness.** Nothing distinguishes a brand-new enquiry from a stale
   one. An agent can't focus on "new today", "needs follow-up", or "gone cold".
5. **Filtering doesn't scale.** The tag/company filters in
   `conversation-list.tsx` run **client-side over only the ~30 loaded rows**, so
   they silently miss any matching chat deeper in the list. This is the core
   efficiency gap for a large account.

## Goals

- **Grouped tags:** organise tags under account-defined **dimensions** ("Product",
  "Destination", "Priority", …), each single- or multi-select, extensible at will.
- **Label from the inbox:** assign/remove a chat's tags directly in the chat
  sidebar and via a quick affordance on the chat header.
- **Editable + typed custom fields in the inbox:** set field values while working
  a chat, with real dropdowns for `select` / `multiselect` fields (plus `date`,
  `number`).
- **Time smart-labels:** derived, zero-storage labels — **New** (≤24h), **This
  week**, **Stale** (no activity > *N* days, configurable) — as one-tap filters
  and per-row badges.
- **Follow-ups:** flag a chat for follow-up with an optional **due date**, powering
  **Due today / Overdue / Flagged** views and a per-row indicator.
- **Server-side filtering** by any dimension/tag + time + follow-up, correctly
  paginated, so segmentation is accurate regardless of account size.

## Non-goals

- No move of tags to a per-conversation model — tags stay on the **contact**
  (see Approved decisions #1). One tag system, not two.
- No bulk tagging / bulk actions across many chats in Phase 1 (possible later).
- No reminders/notifications engine for follow-ups — the due date drives an
  in-app view and badge only, not push/email (a later enhancement).
- No reporting/analytics dashboards on tags (the existing Campaigns analytics are
  untouched).
- No change to role-visibility rules (`conversationScope`) — new filters slice
  *within* what a role may already see.

## Approved decisions

1. **Tags stay on the contact.** In this CRM one customer ≈ one ongoing chat, and
   interests (visa vs. package) belong to the person and persist across the
   relationship. "Chat tags" = the chat's contact's tags, made assignable from
   the inbox. Keeps a single source of truth (`contactTags`); the inbox gets a
   derived read-model for fast filtering (see Scaling).
2. **Categorisation = tag groups** (chosen over structured select-fields or a
   hybrid). Fast visual multi-select chips, filterable, and a new dimension is
   just a new group — best fit for open-ended future segmentation.
3. **Per-group selection mode.** Each group is `single` (Priority = High *or*
   Medium) or `multi` (Destination = Thailand + Bali).
4. **Follow-up = flag + optional due date** (chosen over a bare flag or a chat
   status), enabling a "Due today / Overdue" view.
5. **Time labels are derived, never stored** — always accurate, zero maintenance.
   **Stale** threshold defaults to **7 days**, configurable in Settings.

## Architecture

### Data model (`convex/schema.ts`)

**New — `tagGroups`:**
```ts
tagGroups: defineTable({
  accountId: v.id("accounts"),
  name: v.string(),
  color: v.optional(v.string()),                 // group accent
  selectionMode: v.union(v.literal("single"), v.literal("multi")),
  position: v.number(),                           // manual ordering
}).index("by_account", ["accountId"]),
```

**Extend `tags`** (backward-compatible — both fields optional, existing rows valid):
```ts
tags: defineTable({
  accountId: v.id("accounts"),
  name: v.string(),
  color: v.string(),
  groupId: v.optional(v.id("tagGroups")),         // NEW — ungrouped tags still allowed
  position: v.optional(v.number()),               // NEW — order within group
}).index("by_account", ["accountId"])
  .index("by_group", ["groupId"]),                // NEW
```

**New — `conversationTags`** (derived read-model for scalable inbox filtering):
```ts
conversationTags: defineTable({
  accountId: v.id("accounts"),
  conversationId: v.id("conversations"),
  contactId: v.id("contacts"),
  tagId: v.id("tags"),
  lastActivityAt: v.optional(v.number()),         // mirrors conversations.lastMessageAt
})
  .index("by_account_tag_activity", ["accountId", "tagId", "lastActivityAt"])
  .index("by_conversation", ["conversationId"])
  .index("by_tag", ["tagId"]),
```

**Extend `conversations`** for follow-ups:
```ts
// added to the existing conversations table:
followUpPending: v.optional(v.boolean()),         // presence/true = flagged
followUpDueAt: v.optional(v.number()),            // optional due date/time
followUpNote: v.optional(v.string()),
followUpSetByUserId: v.optional(v.id("users")),
// new index:
.index("by_account_followup", ["accountId", "followUpPending", "followUpDueAt"])
```

**Custom fields** — no schema change (`fieldType` / `fieldOptions` already exist).
We begin *using* them: `fieldType ∈ { text, select, multiselect, date, number }`;
for `select`/`multiselect`, `fieldOptions` holds `{ options: string[] }`.
`contactCustomValues.value` stays a string (multiselect encoded as JSON array).

### Backend (`convex/`)

**`tagGroups.ts` (new):** `list`, `create`, `rename`, `setColor`, `setSelectionMode`,
`reorder`, `remove` (cascade: on delete, ungroup its tags — set `tags.groupId`
undefined — rather than delete the tags). Create/mutate = `requireRole("supervisor")`,
read = any member (mirrors `tags.ts`).

**`tags.ts` (extend):** `create` gains optional `groupId` + `position`;
add `update` (rename/recolor/move group/reorder). `remove` already cascades
`contactTags`; extend the cascade to delete `conversationTags` rows too.

**`contacts.ts` (extend):** `assignTag` already exists (agent-gated); add
`unassignTag` if not present. **Both must also sync `conversationTags`:** on
assign, upsert a row per conversation of the contact (with current
`lastActivityAt`); on unassign, delete matching rows. When `selectionMode` is
`single`, assigning a tag from that group first removes any other tag the contact
holds from the same group (both in `contactTags` and `conversationTags`).

**`conversationTags` sync — the read-model's correctness hinges on these points:**
- Tag assigned/removed on a contact → upsert/delete rows (above).
- A tag deleted, or a group deleted → cascade already covers the tags.
- **New message** → every path that denormalises `conversations.lastMessageAt`
  (inbound webhook ingest + outbound send) must also bump `lastActivityAt` on that
  chat's `conversationTags` rows. Centralise in one helper
  (`bumpConversationActivity(ctx, conversationId, at)`) called wherever
  `lastMessageAt` is written, so the two never drift.
- New conversation created for an already-tagged contact → seed its rows.

**`conversations.list` (extend):** add optional args `tagIds?: Id<"tags">[]`
(OR within a group, AND across groups — see below), `time?: "new" | "week" | "stale"`,
`followUp?: "flagged" | "dueToday" | "overdue"`. Filtering strategy:
- **No tag filter** → today's `by_account_last_message` scan + composed predicates
  (unchanged path; time/follow-up added as range bounds / predicates).
- **Tag filter** → drive pagination from `conversationTags.by_account_tag_activity`
  (`eq(accountId)`, `eq(tagId)`, `.order("desc")`) — already recency-sorted and
  paginated. Multiple tags in one group = OR (merge a few streams); tags across
  groups = AND (intersect / post-filter each candidate's full tag set). Time +
  follow-up apply as additional predicates on the candidate conversations.
- **Follow-up views** → `by_account_followup` (`eq(followUpPending, true)`,
  ordered by `followUpDueAt`; range-bound for `dueToday` / `overdue`).

**`conversations.ts` follow-up mutations (new):** `setFollowUp({ conversationId,
dueAt?, note? })`, `clearFollowUp({ conversationId })` — agent-gated,
`requireConversationAccess(..., "write")`.

**`customFields.ts` (extend):** `create` (and a new `update`) accept `fieldType`
+ optional `fieldOptions` (`{ options: string[] }` for select/multiselect);
validate `value` against the field's type in `setForContact` (multiselect stored
as a JSON-encoded string array). Read/gate model unchanged.

**`account`/settings (extend):** store the **stale threshold** (days).
Add `staleDays: v.optional(v.number())` to `accounts` (default 7 when unset) +
a supervisor mutation to set it.

### Inbox frontend (`src/components/inbox/`, `src/app/(dashboard)/inbox/`)

**Filter bar** (new, above the list in `conversation-list.tsx`): one dropdown per
tag group (`Product ▾`, `Destination ▾`, multi-select), a **Time** quick filter
(New · This week · Stale), and a **Follow-ups** filter (Due today · Overdue ·
Flagged), alongside the existing status filter + All/Mine/Unassigned tabs. Active
selections render as removable chips. Selections flow up to `inbox/page.tsx` and
into the `conversations.list` args (server-side; replaces the client-side
tag/company filter).

**Chat row** (`ConversationItem`): render up to ~2 tag chips (group-coloured), a
**"New" badge** when `_creationTime` ≤ 24h (computed client-side, no query), and a
**follow-up clock** (amber = due, red = overdue).

**Chat sidebar** (`contact-sidebar.tsx`):
- **Labels** section becomes interactive — grouped tag picker; tapping a group
  opens its tags, respecting single/multi. Calls `assignTag` / `unassignTag`.
- **Details** section becomes editable inline — text inputs, real `<select>`
  dropdowns for select-type fields, date & number inputs. Calls
  `customFields.setForContact`. A "＋ New field" shortcut (admin) links to Settings.
- **Follow-up** control — toggle flag, optional date picker, optional note. Calls
  `setFollowUp` / `clearFollowUp`.

`toUiConversation` / the `Conversation` type extend with the chat's tags,
`followUpPending`/`followUpDueAt`, and `createdAt` (for the New badge).

### Settings frontend (`src/components/settings/`)

- **Tag groups manager** (evolves `tag-manager.tsx`): create/rename/recolour
  groups, set single/multi, reorder, and add/remove/recolour tags within each
  group. Ungrouped tags shown under a default "Ungrouped" section.
- **Custom fields** (evolves `custom-fields-manager.tsx`): choose a **type**
  on create; for select types, manage the option list.
- **Inbox rules:** a small card to set the **Stale after N days** threshold.

### Time smart-labels (derived)

- **New** = `_creationTime ≥ now − 24h`.
- **This week** = `lastMessageAt ≥ now − 7d`.
- **Stale** = `lastMessageAt < now − staleDays` (default 7).

Row badges are computed client-side from timestamps already on the row. As
filters they map to index range-bounds server-side (§ `conversations.list`).

## Scaling / performance

The `conversationTags` read-model is what makes filtering correct at scale: a
tag filter reads a **recency-ordered, paginated index** (`by_account_tag_activity`)
directly, instead of client-side-filtering a 30-row page. Trade-off: each inbound/
outbound message bumps `lastActivityAt` on the chat's (typically 1–4)
`conversationTags` rows — bounded write amplification, centralised in one helper.

**Alternative considered:** denormalise a `tagIds` array onto `conversations`
(written only on tag change, no per-message cost) and filter the recency index
in-handler. Rejected as primary because Convex `.filter()` has no array-contains
and manual over-fetch pagination is error-prone; the join-table gives clean
cursor pagination. The exact multi-tag AND/OR pagination mechanics are the main
technical risk and will be pinned down with tests in the plan.

## Roles & permissions

- **Supervisor/admin:** create/edit tag groups, tags, field definitions, stale
  threshold. (Matches existing `tags`/`customFields` gates.)
- **Agent:** assign/unassign tags, set field values, set/clear follow-ups.
- **Viewer:** read-only (sees labels, badges, follow-up state; no edits).

## i18n

Every new string gets a `next-intl` key in all existing locales (the app has had
i18n regressions before — no hard-coded copy). New namespaces under
`Inbox.filters`, `Inbox.labels`, `Inbox.followUp`, `Settings.tagGroups`,
`Settings.customFields`, `Settings.inboxRules`.

## Testing

TDD with `convex-test` (runs offline). Cover: tagGroups CRUD + cascade;
single-select displacement; `assignTag`/`unassignTag` ↔ `conversationTags` sync;
`bumpConversationActivity` on new message; `conversations.list` filtering (single
tag, multi-tag OR/AND, time bounds, follow-up views) incl. pagination; follow-up
set/clear; role gates; stale-threshold read. Component tests kept light per repo
norm; focus coverage on backend logic and the sync invariants.

## Deployment & migration

- Built **offline** by hand-editing `convex/_generated/` (new tables →
  `schema.ts`; new modules → `api.d.ts`) per the "codegen pushes prod" constraint.
- Ship requires a manual **`convex deploy`** to `convex-api.holidayys.co` +
  Netlify for the frontend (backend is a separate deploy from CI).
- **One-time backfill:** populate `conversationTags` from existing `contactTags`
  joined to each contact's conversation(s), seeding `lastActivityAt` from
  `conversations.lastMessageAt`. Idempotent `convex run` script.
- Additive/backward-compatible: existing flat tags become "Ungrouped"; no
  destructive change.

## Phasing

Each phase is independently shippable:

1. **Grouped tags + inbox labelling + typed/editable custom fields.** Closes the
   two gaps named directly (label a chat, set a field, both from the inbox) and
   introduces `tagGroups`. Filtering can stay as-is until Phase 2.
2. **Server-side filter bar + `conversationTags` read-model + time smart-labels.**
   The segmentation/efficiency layer, incl. the backfill.
3. **Follow-ups** (flag + due date) and the Due today / Overdue / Flagged views.

## Phase 1 — status & deploy checklist (2026-07-16)

**Phase 1 is implemented and merged-ready** on `feat/inbox-tag-label-system`
(grouped tags + inbox labelling + typed/editable custom fields). Full suite
1542 passing, `tsc` clean, `next build` succeeds. Phases 2 (server-side
filtering + time smart-labels) and 3 (follow-ups) remain — separate plans.

**To ship Phase 1:**
1. **`convex deploy`** to `convex-api.holidayys.co` — publishes the additive
   `tagGroups` table + `tags.groupId`/`position` fields. Additive/backward-
   compatible; **no backfill** (existing flat tags become "Ungrouped").
2. **Merge to `main`** → Netlify builds the frontend. (Convex is a *separate*
   manual deploy from Netlify — do step 1 too, or Mine/typed-field calls 404.)
3. **Owner spot-check (data safety):** before relying on typed validation,
   confirm prod `customFields` has no pre-existing `select`/`multiselect` rows
   lacking `fieldOptions` (they'd reject every value). The base UI only ever
   wrote `fieldType: "text"`, so none should exist — verify anyway.
4. **Auth-gated click-test** (couldn't be verified headlessly): Settings →
   create a Product group (single-select) + a Destination group (multi);
   in a chat, assign labels (confirm single-select displacement) and set a
   typed custom field (dropdown + multiselect chips) and confirm it persists.

**Deferred polish (non-blocking, from review):** prune orphaned i18n keys
(`Inbox.sidebar.tags/noTags`, `Settings.tagGroups.title/desc`, flat
`tagsAndFields.*`); add an equality guard to `OptionsEditor`'s blur-save; add
an in-flight guard to the label-picker toggle; require ≥1 option to create a
select/multiselect field.
