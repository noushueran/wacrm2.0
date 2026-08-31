# Inbox assignment trail + in-thread sales checklist — design

Date: 2026-08-13
Status: designed

Two asks, one surface. Both land in the Inbox and neither may disturb what is
already there.

1. When a chat changes hands, the thread shows a small line saying who assigned
   it to whom, and when.
2. The post-qualification sales checklist becomes workable from the Inbox, so
   the assigned salesperson never has to walk back to Leads to tick an item.

## What already exists

Measured before designing, so the plan builds on the code rather than beside it.

| | |
|---|---|
| Stores of assignment history | **none** |
| Code paths that write `conversations.assignedToUserId` | **7** |
| What an assignment produces today | one private `notifications` row to the recipient |
| Timeline already merges non-message items | yes — `contactNotes`, via `mergeNotesIntoGroups` |
| `salesChecklists` rows keyed per qualification session | yes, `by_session` |
| `LeadChecklist` component coupling to the Leads page | none — presentational, mutations via callbacks |
| Checklist mutations' permission gate | `requireConversationAccess(..., "own")` |

Two facts decide most of this design.

**Assignment is a bare field with no history.** `conversations.assignedToUserId`
is patched and nothing records that it moved. The only trace is a notification
sent to the new owner — private, unread-able by anyone else, and gone from the
thread. Nobody can answer "who gave this to me, and when" today.

**The thread is already a merged timeline, not a message list.**
`message-thread.tsx` merges contact notes into the message date-groups through a
pure, tested function over a `TimelineItem` union. A third variant is an
extension of an existing mechanism, not a new one.

## Part 1 — the assignment trail

### Why a new table and not a note

`contactNotes` is the tempting shortcut: it already renders inline, needs no new
subscription, and engine-written rows already display as `system`. It is the
wrong home, for four reasons.

**Notes are deletable.** `contactNotes.remove` is author-or-admin gated. A record
of a reassignment that an admin can delete is not an audit trail, and audit is
the entire point of the request.

**Notes store a baked sentence.** The app renders through next-intl, and member
names change. Storing `"Noushad assigned to Fathima"` freezes both the language
and the names. Storing `actorUserId` / `targetUserId` lets the line be translated
at render and stay correct after a rename.

**Notes are the AI-processable trail.** `salesChecklists.ts` says so in its
header, and `contactActivity.listForContact` feeds the contact panel from it.
Assignment churn there is noise in both consumers, and it would surface across
every thread the contact has, not just the one that changed hands.

**Notes render as a card.** The ask is explicitly for something tiny. An event is
a centered pill in the language the date separator already speaks.

### The table

```ts
conversationEvents: defineTable({
  accountId:      v.id("accounts"),
  conversationId: v.id("conversations"),
  contactId:      v.id("contacts"),
  kind: v.union(v.literal("assigned"), v.literal("unassigned")),
  // Who did it. Absent = the system did (sweep, automation, cron).
  actorUserId:    v.optional(v.id("users")),
  // Who owns it now. Present on "assigned".
  targetUserId:   v.optional(v.id("users")),
  // Who owned it before — what makes "moved from X to Y" expressible.
  previousUserId: v.optional(v.id("users")),
  source: v.union(
    v.literal("manual"),       // the Assign dropdown
    v.literal("takeover"),     // "Take over" banner, self-assign
    v.literal("release"),      // "Resume AI" released the thread
    v.literal("auto_assign"),  // inboxChaseAssign sweep
    v.literal("automation"),   // the assign_conversation step
    v.literal("offer_accept"), // agent accepted the WhatsApp offer
  ),
}).index("by_conversation", ["conversationId"])
```

`kind` is what happened to ownership — the sentence. `source` is which machinery
did it — the subject and the phrasing. They are separate fields on purpose: an
eighth entry point should add one `source` literal, not a branch in the renderer.

`contactId` is carried because every peer table (`notifications`, `contactNotes`,
`salesChecklists`) carries both, and the writer always has it in hand.

Timestamps come from `_creationTime`, the same field `splitEarlierNotes` and
`mergeNotesIntoGroups` already sort notes by.

### One write path

Seven places patch `assignedToUserId`:

| Path | Source |
|---|---|
| `conversations.assign` | `manual` |
| `conversations.unassign` | `manual` |
| `conversations.setAutoreplyPaused` (`assignToMe`) | `takeover` |
| `conversations.setAutoreplyPaused` (`paused: false`) | `release` |
| `inboxChaseAssign` sweep | `auto_assign` |
| `qualificationEngine` offer accept | `offer_accept` |
| `automationsEngine` `assign_conversation` step | `automation` |

Seven inserts would be seven chances to forget. Instead one helper —
`convex/lib/assignment.ts` → `applyAssignment(ctx, {conversation, nextAssignee,
actorUserId, source, bumpUpdatedAt?})` — where `nextAssignee` is
`Id<"users"> | undefined`, and `undefined` is the release case that writes
`kind: "unassigned"` with `previousUserId` set and no `targetUserId`. It:

1. returns immediately when the assignee is unchanged (the double-click guard
   `conversations.assign` already carries, now in one place for all seven),
2. patches `assignedToUserId`,
3. inserts the `conversationEvents` row.

All seven call sites route through it. A future eighth path cannot move the field
without writing the event.

Two behaviours it deliberately does **not** absorb, because absorbing them would
change what ships today:

- **`status` is never touched by the helper.** `assign` bumps it to `pending`;
  `setAutoreplyPaused` documents that it deliberately does not. That divergence
  is intentional and stays with the callers.
- **`bumpUpdatedAt` defaults true, and `automationsEngine` passes false.** Its
  comment records that matching the legacy path's "no status/updatedAt bump" is
  deliberate.

`chargeLeadIfAgent`, `insertNotification` and `dispatchConversationAssigned` stay
exactly where they are and keep firing on exactly the conditions they do now.
Lead charging, notifications and automation triggers are unchanged.

### Reading and rendering

`conversations.listEvents` — an `accountQuery` gated by
`requireConversationAccess(..., "view")`, mirroring `contactNotes.
listForConversation`. One `by_conversation` index range, `.collect()`: assignment
events are bounded by human actions, the same reasoning that lets notes collect.

It resolves `userId` → display name server-side using the `fullName ?? "Member"`
fallback `leadsBoard` uses, and **never** the email — `members.list` nulls email
below admin as staff PII, and that rule holds here.

The subscription goes through `@/lib/convex/cached`, like the thread's other
per-conversation queries, so switching threads does not pay a cold round trip.

**Merging.** `mergeNotesIntoGroups` generalises to accept pre-tagged entries, so
notes and events interleave in one sorted pass rather than two sequential merges
that could drift. `TimelineItem` gains an `event` variant. `splitEarlierNotes` is
already generic over `{_id, _creationTime}` and is reused unchanged; the "N
earlier notes" pill counts events too, so nothing above the fold is silently
dropped.

**The pill.** A new `assignment-event.tsx`: small icon, one translated sentence,
the time — centred, in the date separator's visual language. Not a card.

## Part 2 — the sales checklist in the Inbox

Nearly all assembly. The component and the mutations already exist and already
enforce the right rule.

**Read.** New `salesChecklists.forConversation`: session `by_conversation` →
checklist `by_session`. The `LeadChecklistData` projection currently sits inline
in `qualification.leadsBoard`; it moves into the existing
`convex/lib/salesChecklist.ts` so the board and the Inbox share one shape. Two
copies of that projection would drift the first time an item field is added.

**UI.** A `<Section icon={ListChecks}>` in `ContactSidebar` rendering the
existing `LeadChecklist` unchanged. It renders **nothing at all** when there is
no checklist — the same calm-by-default rule `QualificationChip` follows — so the
large majority of chats that never qualify see no change whatsoever.
`contact-panel-drawer.tsx` already reuses `ContactSidebar`, so mobile gets it
without additional work.

**Mutations.** `setItemDone` / `reopenItem` are reused as they are. Their
`requireConversationAccess(..., "own")` gate already means *the assigned person
completes the checklist* — the owner's stated rule — with supervisor+ able to
work any lead and viewers read-only. The note-required rule on completion is
enforced server-side and unchanged.

**Tick trail.** Both mutations already insert a `contactNotes` row but omit
`conversationId`, so those completions currently appear in **no** thread. Adding
that one field — the checklist row already stores it — makes each completion
appear inline through the existing note rendering, with no new component, and
scopes it to the correct thread for contacts who have several.

## Scope

**In:** the seven assignment paths, the events table and read, the timeline
merge, the pill, the per-conversation checklist read and its sidebar section, and
the `conversationId` stamp on checklist notes.

**Out, deliberately:**

- **No backfill.** Assignment history was never written anywhere, so there is
  nothing to reconstruct. History begins at deploy; existing chats show no line
  until their next handover.
- No change to the conversation list, lanes, indexes or pagination.
- No new automation trigger, notification type, or webhook event.
- No edit or delete path for events.

## Operational note

`convex/lib/assignment.ts` is a new module under `convex/`. Per
`convex/generatedApi.test.ts`, a new file fails the codegen drift guard until
`npx convex codegen` is run — the owner runs that, per the repo's standing rule
that codegen and deploys are never run unprompted. Adding exports to existing
modules (`conversations.listEvents`, `salesChecklists.forConversation`) does not
trip the guard; only new files do.

## Testing

- `conversationEvents` read: RBAC (an agent cannot read a thread they cannot
  access) and account isolation.
- `applyAssignment`: exactly one event per real change; **none** on a
  same-assignee re-save; the correct `source` from each of the seven paths;
  `bumpUpdatedAt: false` honoured for the automation path; `status` untouched by
  the helper.
- `src/lib/inbox/notes.test.ts`: events interleaved with notes and messages in
  timestamp order, event-only groups, and the out-of-window split.
- `salesChecklists.forConversation`: null when there is no session and when a
  session has no checklist; projection parity with `leadsBoard`.
- Existing suites stay green — `conversations`, `automationsEngine`,
  `qualificationEngine`, `inboxChaseAssign`, `salesChecklists`, `contactNotes`.
