# Lead Analysis P2 — Archive & Restore — Design

**Date:** 2026-07-27
**Status:** Approved, ready for implementation plan
**Parent:** `docs/superpowers/specs/2026-07-26-lead-analysis-design.md` (§Changes to
`conversations`, §Rollout step 2)

## Problem

The parent spec's second failure still stands unfixed: **nothing ever leaves the inbox.**
`conversations.status` has `open | pending | closed`, nothing auto-closes
(`dashboard.metrics`' own comment: *"almost everything is `open`"*), and dead threads
accumulate forever alongside live ones. P1 shipped the diagnosis — every conversation
scored, banded and laned — but gave the owner no way to act on a verdict. A lead scored 2
with no reply in six weeks still sits in the list exactly where it always did.

P2 is the disposal half: a reversible shelf, plus the guarantee that anyone who comes back
is picked up automatically.

## Principle

**Archive is a shelf, not a delete.** Nothing is destroyed, any customer reply brings the
thread back on its own, and in P2 nothing is archived without a person clicking it.

The second half of that sentence is a deliberate scope decision (owner, 2026-07-27). The
`agedOutDays` sweep and the sequence's terminal auto-archive both move to **P3**, so the
two automated archive paths land together and can be judged together. P2's first contact
with a destructive-feeling action is entirely manual.

## Scope

**In scope.** The four `conversations` fields; archive/restore mutations; inbox exclusion
across all three `conversations.list` query plans; an Archived tab; automatic un-archive
on any inbound customer message; the `lead_returned` notification; suspension of
qualification follow-ups while a thread is archived; Archive/Restore controls in the Inbox
and on the Lead Analysis board.

**Out of scope.** The follow-up sequence engine, any automatic archive (including
`agedOutDays`), bulk actions, template sends from the board, and the Lead Analysis config
UI. All P3/P4.

## Data model

### Changes to `conversations`

```ts
archivedAt: v.optional(v.number()),
archivedReason: v.optional(
  v.union(v.literal("manual"), v.literal("no_response"), v.literal("aged_out")),
),
archivedByUserId: v.optional(v.id("users")),   // absent = automation
returnedAt: v.optional(v.number()),            // last un-archive
```

P2 only ever writes `"manual"`. `"no_response"` and `"aged_out"` ship in the union now so
P3 needs no second schema deploy — the same treatment `leadAnalyses.sequenceStatus` got in
P1. Both this union and `notifications.type`'s new `"lead_returned"` literal are additive;
every existing row stays valid.

### Two new indexes

```ts
.index("by_account_archived_last_message", ["accountId", "archivedAt", "lastMessageAt"])
.index("by_account_archived_assigned_last_message",
       ["accountId", "archivedAt", "assignedToUserId", "lastMessageAt"])
```

**Why a timestamp and not a fourth `status` literal.** `conversations.list` applies
`status` as a post-index `.filter()`, which is safe today only because almost every row is
`open` — the predicate matches early and often. Archived rows accumulate forever, so as a
`.filter()` they would make the inbox scan grow without bound: the exact failure `schema.ts`
documents for `broadcastRecipients`, `conversionEvents` and `campaignAds`, and the one
`conversations.list`'s own comment describes as "ordinary, not exotic". `archivedAt` is
optional, and Convex sorts a missing field before every present value, so
`eq("archivedAt", undefined)` is one genuine index range over exactly the active set.

## Inbox exclusion

`conversations.list` has three indexable plans and archived is handled differently in each.
This table is the specification; getting it wrong is the one way P2 can hurt production.

| Plan | Who hits it | Archived handling |
|---|---|---|
| `eq` (single assignee) | Mine / Unassigned tabs, every role | `by_account_archived_assigned_last_message`, bound `eq("archivedAt", undefined)` |
| `any` | supervisor+, no tab | `by_account_archived_last_message`, bound `eq("archivedAt", undefined)` |
| `meOrPool` | an agent's default view | stays a `.filter()` |
| `empty` | viewer clicking "Mine" | unchanged — still answers without a read |

**Why `meOrPool` may keep a filter.** It is already an OR across two disjoint ranges that a
single `.paginate()` cursor cannot express, so assignment is a filter there today and
archived joins it. That stays benign for a reason worth stating explicitly rather than
assuming: a thread is archived *because* it went quiet, so its `lastMessageAt` is old, and
in a `lastMessageAt`-descending scan archived rows cluster at the tail that pagination
never reaches. The front of the scan stays fresh, unarchived rows. If that ever stops
holding — an account that archives threads which then receive outbound-only activity —
the fix is the same composite-cursor split that file already contemplates for assignment.

### The Archived tab

`list` gains one argument:

```ts
archived: v.optional(v.boolean()),   // absent/false = active set, true = archived set
```

The archived branch ranges the complementary set with `gt("archivedAt", 0)` — the same
idiom `qualificationEngine.getDueSessions` uses to mean "field present". Undefined sorts
before every number, so `gt(…, 0)` excludes exactly the active rows.

**One structural consequence to design around, not discover.** A range on `archivedAt`
cannot be followed by an equality on `assignedToUserId` — Convex requires equality on every
field preceding the range and permits nothing after it. So the archived tab filters by
assignee rather than indexing it, in every plan. This is acceptable because the archived
tab is a cold path (opened deliberately, rarely, and ordered newest-archived-first so the
rows a user wants are at the front), whereas the active list is the hot one. The
implementation must not silently "fix" this by reordering the index fields: putting
`assignedToUserId` before `archivedAt` would break the active-set range, which is the case
that actually matters.

## Archive is not gated by the feature flag

`leadAnalysisConfigs.enabled` gates the **automated** paths only (P1's scoring, P3's
sequence). The `archivedAt` field, the `conversations.list` exclusion, and the
return-on-reply hook are unconditional.

This is load-bearing. If exclusion were gated, disabling the feature would resurrect every
archived thread into the inbox; if the return hook were gated, an archived customer could
never come back. Archive is an inbox capability that Lead Analysis happens to surface, not
a Lead Analysis feature.

## Mutations

Both in `convex/conversations.ts`, beside the existing `assign` / `setAutoreplyPaused`:

```ts
conversations.archive({ conversationId })
conversations.restore({ conversationId })
```

`archive` takes no `reason` argument. Every P2 archive is manual by definition, so the
field is written as `"manual"` unconditionally; an argument whose only legal value is its
default is an invitation to pass the wrong thing later. P3 adds its own internal archive
path and supplies `"no_response"` / `"aged_out"` there.

**RBAC: supervisor+.** Mirrors `qualification.leadsBoard` and the parent spec — agents get
read, Open chat and Re-analyze but no archive; viewers have no access at all. Both
mutations go through `requireConversationAccess` so cross-account ids fail as `NOT_FOUND`
exactly like every other conversation mutation.

`archive` sets `archivedAt`, `archivedReason`, `archivedByUserId`, and **zeroes
`unreadCount`**. Without that last part you archive a thread carrying 3 unread and the
sidebar badge keeps counting a conversation you can no longer open — `unreadTotal` ranges
`by_account_unread` and knows nothing about archiving. Zeroing is also what the action
means: "I am done with this."

`restore` clears `archivedAt`, `archivedReason` and `archivedByUserId`, and stamps
`returnedAt`. It deliberately does **not** touch `status`: archiving and the open/pending/
closed lifecycle are orthogonal axes, and a restored thread should return in whatever state
it left.

Both are idempotent — archiving an archived thread, or restoring an active one, is a no-op
rather than an error, so a double-click or a stale client can never produce a wrong state.

## Return on reply

The un-archive belongs **inside `ingest.ingestInbound`'s existing transaction**, next to
`insertMessageAndUpdateConversation` — not in the best-effort scheduled fan-out below it
where the qualification and lead-analysis hooks live.

The distinction matters. Those hooks are analytics and automation: swallowing a failure
costs a score or a nudge. Un-archiving is a correctness property of the inbox itself — a
swallowed failure leaves a thread hidden while its customer is actively writing into it,
and nothing would ever retry. Same transaction as the message insert, or the guarantee is
not a guarantee.

When the conversation being written to has `archivedAt` set:

1. clear `archivedAt` / `archivedReason` / `archivedByUserId`, stamp `returnedAt`
2. insert a `lead_returned` notification to the assignee, or to the supervisor+ pool when
   unassigned — `recipientsForInbound`, the same rule inbound push and lead-qualified
   notifications already use

`lastMessageAt` was just updated by the same helper, so the thread reappears at the top of
the inbox by ordinary recency. No special-casing in `list`, and no "returned" ordering rule
to maintain.

## Qualification engine

Archiving suspends follow-ups; it does not end the lead (owner decision, 2026-07-27).

- `conversations.archive` clears the session's `nextFollowUpAt`.
- `qualificationEngine.followUpContext` gains an archived guard returning
  `{ kind: "reschedule", at: expiryRevisit }`, so an already-armed session can never send
  into an archived thread even if it was armed before the archive landed. It sits beside
  the `aiAutoreplyDisabled` guard and shares its permanence: an archived thread is an
  explicit "I am done here", the same class of signal as an explicit Take over, and
  unlike the incidental assignment/human-touch signals that the 2026-07-26 fix made
  resumable.
- The session stays `collecting`. When the customer replies, the same ingest transaction
  un-archives the thread and the existing `onInbound` re-arms `nextFollowUpAt` exactly as
  it does for any other inbound. The lead picks up where it left off with no new state and
  no new code path.

Expiring the session instead was considered and rejected: a returning customer would not
resume that lead, and would get a fresh session only if the analysis pass judged it a
genuinely new inquiry.

## UI

**Inbox.** An **Archived** tab beside the existing Mine / Unassigned tabs, calling `list`
with `archived: true`. An Archive action in the thread header for supervisor+. A
deep-linked archived thread (`/inbox?c=…`) renders an *Archived* badge and a Restore
button rather than hiding — a link from the board or a notification must always resolve.

**Lead Analysis board.** The row gains an Archive action for supervisor+, and the summary
tiles gain an Archived count. The board component stays presentational: archive is another
callback prop beside `onReanalyze`, and the page wrapper owns the mutation, matching the
split P1 established.

Bulk archive stays in P4.

## Module layout

No new modules. P2 is additive edits to files that already own these concerns:

| File | Change |
|---|---|
| `convex/schema.ts` | four fields, two indexes, one notification literal |
| `convex/conversations.ts` | `archive` / `restore`; archived handling in `list`'s three plans |
| `convex/ingest.ts` | transactional un-archive + `lead_returned` notification |
| `convex/qualificationEngine.ts` | archived guard in `followUpContext` |
| `src/components/inbox/*` | Archived tab, Archive action, archived badge + Restore |
| `src/components/lead-analysis/*` | Archive row action, Archived tile |
| `messages/en.json` | the new strings |

There is no new arithmetic in P2, so unlike P1 there is no pure `lib/` module to add and no
unit-test layer without a database. That is a property of the work, not an omission.

## Testing

**Convex-test** carries this phase:

- archive removes the row from all three `list` plans — `eq`, `any` and `meOrPool` asserted
  separately, since each excludes archived by a different mechanism
- the Archived tab returns exactly the complement, and the two sets never overlap
- archive → inbound → un-archive round trip, asserting `archivedAt` cleared, `returnedAt`
  stamped, and one `lead_returned` notification with the right recipients (assigned and
  unassigned cases)
- an armed follow-up on an archived conversation sends nothing and reschedules
- archiving clears `nextFollowUpAt`; a reply re-arms it and the session is still
  `collecting`
- archive zeroes `unreadCount`, and `unreadTotal` drops accordingly
- RBAC: an agent cannot archive, a viewer cannot archive or restore, and neither mutation
  reaches another account's conversation
- both mutations are idempotent

**Component:** the Archived tab renders its own empty state; an archived thread shows the
badge and Restore. Static-render assertions per this repo's convention — there is no jsdom
and no Testing Library (see `src/components/inbox/conversation-list.test.tsx`).

## Rollout

One deploy, owner-run. The schema changes and both indexes require `convex deploy`; no
agent session runs it. P2 is inert on arrival in the strongest sense: with no archived rows
in existence, `eq("archivedAt", undefined)` matches every conversation and the inbox behaves
exactly as it does today. The first behavioural change happens when a human clicks Archive.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| An index change silently degrades the inbox for every user | The three plans are specified separately above and tested separately; `meOrPool`'s filter is justified by archived rows sorting to the scan's tail, not by assumption |
| A thread is archived and the customer is never heard again | Any inbound un-archives, transactionally with the message insert; the Archived tab and the board's Archived tile both keep the set reachable |
| Archived threads keep inflating the unread badge | `archive` zeroes `unreadCount` |
| The bot messages someone the owner just archived | `followUpContext` gains an archived guard, and `archive` disarms the clock — belt and braces, because the two race |
| Archive is mistaken for delete | Restore is one click from the same rows; nothing is ever removed from the database; `archivedByUserId` and `archivedReason` keep the audit trail |
| A future automated archive lands with no review surface | Deliberately deferred to P3 as a whole, so the sweep, its dry-run preview, and the sequence's terminal archive are designed together |
