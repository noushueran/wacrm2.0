# Conversation Notes & Activity Trail — Design

**Date:** 2026-07-29
**Status:** Draft, awaiting owner review
**Branch:** `worktree-inbox-conversation-notes` (worktree, branched from `origin/main`)

## Problem

Sales talks to a customer through channels this system cannot see: a phone call, a
personal WhatsApp, a walk-in at the office, an email. None of it is recorded. The
thread in `/inbox` shows only what went over the business WhatsApp number, so:

- Nobody can reconstruct what was actually agreed. "I called him, he wants to travel
  in March" exists in one agent's head and nowhere else.
- A customer who said "don't contact me again" over the phone keeps getting chased by
  the automation, because the automation never heard it.
- Handover between agents loses everything. The next person opens the thread and sees
  a gap.

`contactNotes` exists and is close to the right shape — five backend engines already
write into it (funnel transitions, AI tag acceptance, sales-checklist steps,
qualification, invitations), which makes it the account's de-facto audit trail. But
the human-facing half is a bare textarea at the bottom of the contact sidebar
([`contact-sidebar.tsx:582`](../../../src/components/inbox/contact-sidebar.tsx)),
storing free text and nothing else. A note has no type, no author on screen, no
attachments, no link to the conversation it belongs to, and nothing reads it back.

Reported by the owner, 2026-07-29: "we don't have any track of what is happening
there, so we need to have a note-taking area."

## Principle

**A note is an event that happened outside this system, recorded so both a human and
a machine can act on it later.**

Two consequences run through every decision below. A note must be *fast* to write, or
agents will not write it — logging a phone call is two clicks and a sentence, never a
form. And a note must be *unmistakably internal* — it lives in a different table from
`messages`, renders as a different object, and has no code path to Meta.

## Decisions taken with the owner

1. **Notes render inline in the conversation timeline**, interleaved with WhatsApp
   messages in time order, not hidden in a separate drawer. The thread becomes one
   story: customer said X → I called, they said Y → sent the quote.
2. **Two independent tag dimensions.** *Channel* (how the contact happened) and
   *outcome* (what it means). An agent picks one channel chip and optionally one
   outcome chip.
3. **Do-not-contact is a hard gate, not a hint.** Automation stops. Humans are warned,
   not blocked.
4. **The customer-facing reply generator never sees raw note text.** It receives
   derived flags only. Full note text goes only to AI jobs whose output an agent
   reads. Rationale in "AI integration" below — this reverses nothing, it extends an
   existing safety decision.
5. **The work lands in new files.** `message-thread.tsx` (1687 lines) and
   `contact-sidebar.tsx` (704 lines) are both oversized, and another session is
   mid-flight in the former's header block
   ([`2026-07-28-inbox-thread-header-design.md`](2026-07-28-inbox-thread-header-design.md)).
   New components, minimal edits to the two existing ones.

## Scope

**In scope.** `contactNotes` schema extension; a `doNotContact` flag on `contacts`; note
CRUD with attachments; R2 `note` media kind; inline note cards in the thread; a floating
note composer; the contact sidebar restructured into status header / key facts /
activity; a merged activity query; three automation gates; derived note signals in the
reply prompt; full note text in the internal AI jobs; i18n keys; unit tests.

**Out of scope.** The thread header (another session owns it). The composer and the
WhatsApp send path — untouched, by design. Notes on anything other than a contact.
Note templates, mentions, threading, or reactions on notes. Changing what the existing
five engines write. Backfilling old notes with a `kind`.

## Data model

Every new field is optional, so existing rows stay valid and nothing needs a backfill.

```ts
// convex/schema.ts — contactNotes (existing table, extended)
contactNotes: defineTable({
  accountId: v.id("accounts"),
  contactId: v.id("contacts"),
  createdByUserId: v.optional(v.id("users")),
  noteText: v.string(),

  // NEW — which thread this was written in. Absent on engine-written
  // rows and on notes added from the contacts page.
  conversationId: v.optional(v.id("conversations")),

  // NEW — how the contact happened.
  kind: v.optional(v.union(
    v.literal("call"),
    v.literal("whatsapp_external"),
    v.literal("meeting"),
    v.literal("email"),
    v.literal("payment"),
    v.literal("general"),
  )),

  // NEW — what it means. Drives the gates below.
  outcome: v.optional(v.union(
    v.literal("no_answer"),
    v.literal("follow_up"),
    v.literal("do_not_contact"),
    v.literal("not_interested"),
  )),

  // NEW — R2 objects. Bounded at 5 by the mutation.
  attachments: v.optional(v.array(v.object({
    key: v.string(),
    filename: v.string(),
    contentType: v.string(),
    size: v.number(),
  }))),

  editedAt: v.optional(v.number()),
})
  .index("by_contact", ["contactId"])
  .index("by_account", ["accountId"])
  // NEW — the thread's inline query wants one conversation's notes.
  .index("by_conversation", ["conversationId"]),
```

**Rendering old rows.** A row with no `kind` and no `createdByUserId` is
engine-written and renders as a system entry. A row with no `kind` but with a
`createdByUserId` is a legacy human note and renders as `general`. Derived at read
time; nothing is rewritten.

```ts
// convex/schema.ts — contacts (existing table, one new field)
doNotContact: v.optional(v.object({
  at: v.number(),
  byUserId: v.optional(v.id("users")),
  noteId: v.id("contactNotes"),   // the note that set it — the "why"
})),
```

**Why denormalise.** The gates run on every inbound message and on every chase sweep.
They need an O(1) field read, not a per-contact note scan. The sidebar also needs
something to render a banner from, and the banner must name who set it and when.

Set when a note carrying `outcome: "do_not_contact"` is added. **One path clears it:**
`contactNotes.clearDoNotContact`, which writes its own audit note. Two paths
deliberately do *not* — deleting the note that set it, and editing that note's
`outcome` (which `update` refuses when the current value is `do_not_contact`). A
customer's stated wish must not evaporate because an agent tidied up a note.

**Attachments.** `"note"` joins `MEDIA_KINDS` in
[`convex/lib/r2/keys.ts:13`](../../../convex/lib/r2/keys.ts). That is the whole
storage change: note files land under `{accountId}/note/{uuid}.{ext}`, so the existing
tenant-isolation contract (`parseMediaKey(key).accountId` must match the caller's)
covers them unchanged. The browser PUTs straight to R2 via `files.startUpload`'s
presigned URL — bytes never transit Convex.

Limits: **5 files per note, 25 MB each**, any content type. `uploadAccountMedia` states
that "size validation is the caller's responsibility (limits can differ per feature)",
so `upload-media.ts` needs no change at all — the note composer owns its own
`NOTE_ATTACHMENT_MAX_BYTES` constant. The 16 MB `MEDIA_MAX_BYTES` and the per-category
`MEDIA_MAX_BYTES_BY_KIND` map both exist to mirror Meta's WhatsApp caps, and note
attachments are never sent to Meta, so neither applies. The file count is enforced in
`contactNotes.add`/`update`; the byte ceiling in the composer.

**Why notes can never reach a customer.** `send.ts` and `metaSend.ts` read the
`messages` table. Notes are not in it. There is no branch to disable and no flag to get
wrong — the isolation is structural.

## Backend surface

`convex/contactNotes.ts` (extended):

| Function | Change |
| --- | --- |
| `listForContact` | Joins `memberships` for author name/avatar; returns `kind`/`outcome`/`attachments`. |
| `listForConversation` | **New.** Ranges `by_conversation`; feeds the inline thread. |
| `add` | Takes `kind`, `outcome`, `attachments`, `conversationId`. Validates ≤5 attachments and that every key parses to the caller's own account. Sets `contacts.doNotContact` when `outcome === "do_not_contact"`. |
| `update` | **New.** Author-only (or `admin`+). Edits `noteText`/`kind`/`outcome`/attachments; stamps `editedAt`. Refuses to change `outcome` when it is already `do_not_contact`. |
| `remove` | Tightened from any `agent` to **author-only, or `admin`+**. Deletes the R2 objects. Never clears `doNotContact`. |

Engine-written rows have no `createdByUserId`, so "author-only" makes them
`admin`+-only for edit and delete — correct, since they are the audit trail, not
someone's memo.
| `clearDoNotContact` | **New.** `supervisor`+. Clears the flag, writes an audit note recording who cleared it. |

`convex/contactActivity.ts` (**new**) — `listForContact` merges five sources into one
sorted, discriminated-union feed so the sidebar makes a single query:
`contactNotes`, `funnelTransitions`, `contactTags`, `salesChecklists` items, and
`deals` outcomes. Paginated at 50, newest first.

**Role floors.** Writing a note stays at `agent`, matching `messages.append` — recording
what you did is the same class of action as sending. Reading stays at plain membership.
Clearing do-not-contact is `supervisor`+ because it overrides a customer's stated wish.

## Automation gates

`contacts.doNotContact` blocks three paths. In every case the block is silent to the
customer and visible to the team.

1. **Auto-reply** — [`aiReply.ts:680`](../../../convex/aiReply.ts), beside the existing
   `config.autoReplyEnabled` check. New outcome `skipped_do_not_contact` joins the
   existing `skipped_*` union at line 190, so it shows up in the AI usage log rather
   than vanishing.
2. **Chase sweep** — `inboxChaseAssign.sweepChaseAssign`
   ([`inboxChaseAssign.ts:49`](../../../convex/inboxChaseAssign.ts)) skips flagged
   contacts when selecting threads to chase.
3. **Broadcasts** — `broadcasts.create`
   ([`broadcasts.ts:292`](../../../convex/broadcasts.ts)) already resolves every
   `contactId` through `requireOwnContact`. Flagged contacts are **dropped from the
   recipient list, not rejected**: the mutation returns `{ broadcastId, skipped: n }`
   and the composer surfaces "3 contacts skipped (do not contact)". Rejecting the whole
   broadcast because one recipient opted out would be the wrong failure mode.

A human agent sending manually is **not** blocked. They see a red banner in the sidebar
and a red strip above the composer. Machines are stopped; people are informed.

## AI integration

The reply generator deliberately excludes internal content today.
[`aiReply.ts:1070`](../../../convex/aiReply.ts) filters `audience: "internal"` knowledge
chunks out of every customer-facing generation, and the comment states why: the model
cannot self-censor, so the filter is the only thing keeping agent-only material
(pricing floors, "route to a human" playbooks) out of a customer's WhatsApp.

Notes are exactly that class of content. Piping "he's a time-waster, quote him high"
into the reply prompt reintroduces the leak that filter exists to prevent, and a
"never quote this" instruction is not a guarantee. So the note stream forks by
audience:

**To the customer-facing reply generator — derived signals only, never prose:**

```
CUSTOMER STATE (internal, do not mention):
- do_not_contact: false
- last_offline_contact: phone call, 2 days ago
- pending_follow_up: 2026-08-02
- marked_not_interested: false
```

A fixed, machine-generated vocabulary. No agent-authored string can reach it, so no
agent-authored string can be echoed back.

**To internal AI jobs — the full note text.** Lead analysis
(`leadAnalysisEngine.ts`), follow-up decisions, and thread summarisation all produce
output that only an agent reads. They receive the last 10 notes verbatim with author,
timestamp, channel and outcome. Capped at ~1500 characters total, oldest truncated
first, so a chatty thread cannot inflate token spend without bound (the usage card
already shows a 30-day window; this keeps it honest).

## UI

### Floating note button

A round amber FAB pinned bottom-right inside the thread scroll area, clear of the
composer. Clicking opens a popover anchored to the button — not a modal, so the
conversation stays readable while writing:

- Row 1: channel chips — Call · WhatsApp · Meeting · Email · Payment · Note.
- Row 2 (optional): outcome chips — No answer · Follow up · Not interested ·
  **Do not contact** (red, with a confirm step, since it stops automation).
- Textarea, paperclip, Save. `⌘↵` saves.

Logging a call is: tap FAB, tap **Call**, type a sentence, Save.

### Inline note cards

[`message-thread.tsx:1355`](../../../src/components/inbox/message-thread.tsx) groups
messages by date and renders `MessageBubble`s. Notes merge into those same date groups
by timestamp, and render as a deliberately different object:

- Full-width and centred — never left/right aligned like a chat bubble.
- Amber tint, dashed border, lock icon, and the words **Internal · not sent**.
- Author avatar + name, exact time, channel chip, outcome chip if present.
- Attachment chips: thumbnail for images, filename + size otherwise.
- `⋮` → Edit / Delete, shown only on your own notes (or to `admin`+).

**Pagination.** The thread is cursor-paginated (`loadMore(30)`), so a note older than
the loaded window has no message to sit beside. Those collapse into a single
"3 earlier notes" pill at the top of the loaded range, expanding in place. The pill is
derived by comparing note timestamps against the oldest loaded message — no extra query.

### Contact sidebar, restructured

[`contact-sidebar.tsx`](../../../src/components/inbox/contact-sidebar.tsx) currently
runs tags → custom fields → deals → notes-textarea. New order:

1. **Status header** — assigned agent, stage, last contacted, next follow-up. When
   `doNotContact` is set this is replaced entirely by a red banner naming who set it,
   when, and the note text, with a Clear button (`supervisor`+).
2. **Key facts** — the existing custom-fields section, moved to the top. No new data
   model; these are already `contactCustomValues`.
3. **Activity** — the merged feed from `contactActivity.listForContact`. Numbered,
   newest first, with a Notes-only filter toggle.
4. Tags and Deals, unchanged, below.

### New files

| File | Purpose |
| --- | --- |
| `src/components/inbox/note-card.tsx` | One note, in the timeline or the sidebar. |
| `src/components/inbox/note-composer.tsx` | FAB + popover + upload handling. |
| `src/components/inbox/contact-status-header.tsx` | Status strip / do-not-contact banner. |
| `src/components/inbox/contact-activity.tsx` | Merged activity feed. |
| `src/lib/inbox/notes.ts` | Pure helpers: kind/outcome labels, timeline merge, earlier-notes split. |
| `convex/contactActivity.ts` | Merged activity query. |

`message-thread.tsx` gains only the merge call and two component mounts.
`contact-sidebar.tsx` loses its notes block and gains three mounts.

## Testing

- **`src/lib/inbox/notes.ts`** — pure functions, unit-tested without rendering, in the
  style the header spec established: merging notes into date groups, splitting off
  notes older than the loaded window, label derivation for legacy rows (no `kind`,
  no author → system; no `kind`, author → general).
- **`convex/contactNotes.test.ts`** (extended) — attachment count and ownership
  validation; author-only edit/delete; `admin` override; do-not-contact set on add;
  the flag surviving deletion of its own note; `clearDoNotContact` role floor and its
  audit note; cross-account probes returning `NOT_FOUND` (not `FORBIDDEN`), matching
  the file's existing non-leaky contract.
- **`convex/contactActivity.test.ts`** (new) — merge ordering across five sources,
  pagination, account isolation.
- **Gates** — `aiReply` emits `skipped_do_not_contact`; the chase sweep skips flagged
  contacts; `broadcasts.create` drops rather than rejects and reports `skipped`.
- **Leak regression** — an assertion that the customer-facing prompt builder never
  contains `noteText`. This is the test that protects decision 4 from a future edit.

## Phases

Each phase is independently shippable and leaves the app working.

**Phase 1 — the trail.** Schema extension, `note` media kind, note CRUD with
attachments, `listForConversation`. Inline note cards and the floating composer. This
alone solves "record what happened on the phone".

**Phase 2 — the panel.** `contactActivity.listForContact`, status header, key facts
moved up, merged activity feed, sidebar split into components.

**Phase 3 — the machine.** `doNotContact` gates on the three automation paths, derived
signals into the reply prompt, full note text into the internal AI jobs, the leak
regression test.

## Risks

| Risk | Mitigation |
| --- | --- |
| A note is mistaken for a sent message. | Structurally impossible to send; visually distinct by shape, colour, alignment and an explicit "not sent" label. |
| Agents skip the tags and everything is `general`. | Channel chips are one tap and pre-selected on the most recent choice; the note saves fine without an outcome. |
| `doNotContact` set by accident stops a live deal. | The red outcome chip requires a confirm; the banner is unmissable; `supervisor`+ can clear it, and clearing is itself audited. |
| Note text inflates AI token spend. | Internal jobs cap at ~1500 chars, oldest truncated first. The customer-facing prompt takes fixed-length derived flags only. |
| Collision with the in-flight thread-header work. | Separate worktree off `origin/main`; new files; `message-thread.tsx` edits confined to the scroll-area body, which that spec lists as out of scope. |
