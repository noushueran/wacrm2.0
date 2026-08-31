# Contact panel — checklist reach + decluttering

Date: 2026-08-14
Status: designed

Two complaints, one surface:

1. "There is no checklist showing on the contact info card" — for any chat.
2. "The contact info card has so many things" — it feels crowded.

They are unrelated causes with a shared home, so they ship together.

## Why no checklist appears

Two reasons, and the first hides the second.

**It is not deployed.** `salesChecklists.forConversation` does not exist on the
live Convex deployment yet. The query throws `Could not find public function`,
`OptionalFeatureBoundary` catches it, and the section renders nothing —
verified in the browser console. So today *even the chats that have a checklist
show nothing.* Deploying fixes that much.

**Only qualified leads ever get one.** `generateForSession` is scheduled from
exactly one place — `completeQualification`
(`convex/qualificationEngine.ts:1012`). Measured, from the sales-coach spec:

| | |
|---|---|
| Conversations | 1,802 |
| Sales checklists | **188** |

So after a deploy, roughly one chat in ten would show a checklist and the other
1,614 would show nothing, permanently. That is what the earlier spec called for
and it is not what the owner wants.

## Part 1 — a checklist on any lead

### Where generation moves to

A second trigger, at the moment a session's `serviceName` is first set —
`convex/qualificationEngine.ts:481`, `if (analysis.serviceName)
patch.serviceName = analysis.serviceName`. That fires during `collecting`, off
the LLM's analysis of the customer's opening messages, long before the lead
qualifies.

**Why that hook and not session creation.** The checklist's value comes from KB
retrieval keyed on `serviceName`; `generateForSession` passes it into
`aiKnowledge.retrieve` and into `buildChecklistPrompt`. At session creation
(`ensureSession`, line 439) there is no `serviceName` — the insert does not set
one — so generating there produces a generic checklist. And because
`generateForSession` early-returns on `info.hasChecklist`, that generic version
would **permanently block** the service-tailored one. Firing on
serviceName-known preserves exactly today's quality and only moves it earlier.

**The existing call stays.** `completeQualification` keeps scheduling
`generateForSession`. It is already idempotent, so it no-ops once a checklist
exists, and it still covers a lead that qualifies without a service ever being
identified. Two triggers, one generation.

**The read side needs no change.** `forConversation` already walks the recent
sessions newest-first and returns the first that has a checklist row.

### The cost, stated plainly

More sessions reach "service identified" than reach "qualified", so this
generates more checklists than today. Each is **one judge-tier LLM call, and
only when the KB returns excerpts** — `generateForSession` falls back to the
built-in six-step default at zero token cost when the account has no AI config,
no knowledge chunks, or no matching excerpt.

The cheaper alternative, if that spend shows up: generate lazily the first time
a human opens the chat, bounding it by attention rather than traffic. Not
chosen now because it needs a client-triggered write on render, and the
server-side hook is predictable. Revisit if `aiUsage` shows `mode: "checklist"`
climbing.

### What does NOT change

No checklist for a conversation with no qualification session — admin threads,
staff chats, wrong numbers and one-word pings stay clean. "Every chat, no
exceptions" was considered and rejected on that ground.

## Part 2 — decluttering the panel

The panel stacks **fourteen** blocks in a ~300px column: header, status strip,
key facts, activity, contact, acquisition, funnel, location, travel profile,
about, tag-suggestion banner, labels, sales checklist, deals.

### Pinned, always visible

1. **Identity** — avatar, name, company, phone, Edit toggle. This **absorbs the
   old standalone "Contact" section**, which existed only to hold the WhatsApp
   number under its own heading; the number moves up beside the name, and the
   section disappears rather than becoming collapsible. One block fewer.
2. **Status strip** — `ContactStatusHeader`, already built and already exactly
   this: assignee, stage, last contacted, next follow-up, do-not-contact
   indicator.
3. **Funnel stage, compacted.** Today this renders all seven stages as a stacked
   list, which is one of the largest single contributors to the crowding. It
   stays pinned — moving a lead along the funnel is a primary action, not
   reference detail — but collapses to **the current stage plus a control to
   change it**, with the seven options shown on demand rather than permanently.
   No stage is removed and the transition logic is untouched; only the resting
   presentation changes.
4. **Sales checklist** — when there is one.
5. **Labels**, with the AI tag-suggestion banner.

That is what a salesperson needs while actually reading a conversation.

### Collapsible, collapsed by default

Travel profile · Location · Acquisition · Key facts (custom fields) · Deals ·
Activity.

Two rules make collapsing safe rather than lossy:

**A collapsed section that has content shows a marker** — a count, or a filled
dot where a count is meaningless. Without it, "collapsed" and "empty" look
identical and hiding six sections just hides information.

**Edit mode auto-expands every section holding editable fields.** Otherwise
editing a contact means hunting through chevrons for the field you want.

Open/closed state persists per section in `localStorage`, so an agent who wants
Travel profile permanently open gets it.

### Deliberately not doing

**No tabs.** The checklist and the travel details have to be readable at the
same time while working a lead; tabs make that two clicks apart.

**No reordering of fields inside a section.** Only whole sections move. Field
order is someone else's decision and not what "crowded" refers to.

## File structure

`src/components/inbox/contact-sidebar.tsx` is 958 lines carrying layout, data
wiring, edit state, photo staging and every field group. This change touches all
of it, so it gets split the way a good developer splits code they are already in:

- **`contact-collapsible-section.tsx`** (new) — the collapsible primitive: label,
  chevron, content marker, `localStorage` persistence, force-open in edit mode.
- **`contact-detail-sections.tsx`** (new) — the travel, location, acquisition and
  about field groups, moved out whole.
- **`contact-sidebar.tsx`** — composition, queries and edit state only.

`contact-status-header.tsx`, `contact-key-facts.tsx` and the existing
`ChecklistSection` are already extracted and stay as they are.

## Testing

- **Generation trigger:** a session whose `serviceName` is set for the first time
  schedules `generateForSession`; a session already carrying a `serviceName` does
  not re-schedule; a session that reaches `qualified` with a checklist already
  present generates nothing further (the idempotence that makes two triggers
  safe).
- **Reach:** `forConversation` returns a checklist for a `collecting` session,
  and still returns null for a conversation with no session at all.
- **Collapsible primitive** (pure, unit-tested): default state, persisted state
  wins over default, edit mode forces open regardless of persisted state, and the
  content marker appears only when the section has content.
- Existing suites stay green — `salesChecklists`, `qualificationEngine`,
  `qualification`, `contactActivity`.

## Deployment note

None of Part 1 or the checklist half of Part 2 is observable until
`npx convex deploy` runs — `forConversation` does not exist on the live
deployment. The panel degrades to "no checklist section" until then, which is
the boundary working as designed, not a bug.
