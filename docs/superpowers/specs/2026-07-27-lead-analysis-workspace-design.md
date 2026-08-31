# Lead Analysis Workspace — Split-Pane Chat — Design

**Date:** 2026-07-27
**Status:** Approved, ready for implementation plan
**Parent:** `docs/superpowers/specs/2026-07-26-lead-analysis-design.md`,
`docs/superpowers/specs/2026-07-27-lead-analysis-p2-design.md`
**Baseline:** `origin/main` — the deployed tree. Every file and line reference below is
against `main`, not the branch this document was written on. See §Branching.

## Problem

The board diagnoses leads but cannot work them. Every row's "Open chat" link navigates to
`/inbox?c=<id>`, which throws away the thing that made the board useful — the score, the
reason, the queue position, and the filter the person was working. Coming back means a
second navigation and re-finding your place.

The queue is sorted best-first for a reason. Working it should be a loop: read the top
lead, reply or dismiss it, move to the next. Today that loop crosses two routes on every
iteration.

## Principle

**The verdict and the conversation belong on one screen.** A person working the queue
should never navigate away, and should never lose the reason a lead scored 8 while they
are writing the reply to it.

Corollary, and the reason the right pane is not a reimplementation: the thread on this page
is the *same component* the inbox renders, not a lookalike. Any inbox capability that is
missing here is a bug, not a scope decision.

## Scope

**In scope.** A split-pane layout on `/lead-analysis`; the inbox's `MessageThread` and
`ContactPanelDrawer` in the right pane; per-row and per-thread Re-analyze / Archive /
Restore; `?c=` deep linking; auto-advance to the next lead after archiving; score and
reason surfaced in the thread header; the two query denormalizations below and their
backfill.

**Out of scope.** Any change to `/inbox` beyond extracting one shared component. Bulk
actions. Template sends from the board. Keyboard queue navigation (`j`/`k`) — a natural
follow-up once the layout exists, deliberately deferred. Changes to scoring, banding, or
the sequence engine.

## Layout

The page escapes the padded dashboard shell exactly as the inbox does
(`-m-4 flex h-app-content flex-col overflow-hidden sm:-m-6`, `src/app/(dashboard)/inbox/page.tsx:420`).

```
┌─────────────────────────────────────────────────────────┐
│ Lead Analysis   [Active|Archived]                       │
│ Hot 1  Warm 7  Cold 1  Awaiting us 0  Unscored 13  5.4  │  ← summary band
│ Band [All ▾]  Lane [All ▾]  [Search………]                 │  ← filter band
├──────────────────────┬──────────────────────────────────┤
│ 8  Sarfaraz Ali      │  8 · Sarfaraz Ali                │  ← thread header
│    Genuine enquiry…  │  Genuine enquiry with applicant… │     carries score+reason
│ ─────────────────── │  [Re-analyze] [Archive]          │
│ 7  Sham's Studio  ⟳🗄│                                  │
│ ─────────────────── │  ┌────────────────────────────┐  │
│ 7  Busy              │  │  MessageThread             │  │
│ ─────────────────── │  │  (+ ContactPanelDrawer)    │  │
│ 6  Pinto Dev         │  └────────────────────────────┘  │
│                      │  [composer………………………] [Send]     │
└──────────────────────┴──────────────────────────────────┘
   left: fixed width        right: flex-1 min-w-0
```

The summary tiles compact to a single shorter row than today's six cards, buying vertical
space for the thread. `min-w-0` on the right pane is load-bearing for the same reason it is
in the inbox (issue #165): one long URL in a message otherwise pushes the contact drawer
off-screen.

**Below `lg`,** one pane at a time. Selecting a lead hides the list *and both header bands*;
a back control in the thread header returns to the list. This mirrors the inbox's existing
rule rather than inventing a second responsive idiom.

**No auto-open.** The right pane shows a "select a lead" empty state until a row is clicked.
Rendering `MessageThread` marks a conversation read as a side effect
(`src/components/inbox/message-thread.tsx:380` — an effect, not a click handler), so
auto-opening the top lead would clear the unread badge on the hottest lead every time
anyone loaded the page. The list is already sorted best-first, so the top lead is one click
away.

## Data flow

Selection is a single piece of page state, `selectedConversationId`, mirrored to `?c=<id>`
so links are shareable and survive reload. The param name matches the inbox's existing
convention.

**The right pane never reads from the board payload.** It issues its own
`api.conversations.get(selectedConversationId)` and adapts the result with
`toUiConversation` (`src/lib/convex/adapters.ts:302`), which returns the conversation with
its contact embedded and enforces `requireConversationAccess` server-side.

This independence is the design's load-bearing decision, and it buys three things:

1. **The thread is immune to the list re-sorting under it.** The board is a live reactive
   query; sending a reply flips the lead's lane and can move its row. Because the pane is
   keyed by conversation id rather than by list position, the open thread never flickers or
   swaps.
2. **Archiving the open lead advances selection instead of leaving the thread pinned.** The
   row leaves the Active list and auto-advance (below) immediately selects the row that
   followed it in the filtered list — or clears selection if none remain. Because the pane
   is keyed by conversation id and always fetches independently, the newly selected
   conversation is fetched fresh rather than reused from stale list data.
3. **No fallback-fetcher machinery.** The inbox needs `DeepLinkFallbackFetcher` because its
   list is paginated and a deep-linked conversation may not be on the loaded page. Here the
   pane always fetches independently, so that complexity does not reappear.

### Rows and actions

Rows carry signal only: score chip, contact name, reason snippet, lane badge, silence
label. Re-analyze and Archive/Restore render as icon buttons revealed on hover/focus, and
again in the thread header for the open lead. Both call the mutations already wired in
today's page (`leadAnalysis.reanalyze` / `archive` / `restore`) with their existing toasts.

Archive/Restore stay supervisor+ in the UI, mirroring the server's own
`requireRole("supervisor")`. The client check is a display concern; the server call remains
the real gate.

### Auto-advance after archive

Specified precisely, because it drives selection tests:

- Archiving the **currently selected** lead selects the row that immediately followed it in
  the filtered, sorted list **as that list stood at click time**. If it was the last row,
  the preceding row is selected. If no rows remain, selection clears.
- Archiving a lead that is **not** selected leaves selection untouched.
- **Restore never auto-advances.**
- The next row is computed from a snapshot taken at click time, not after the reactive
  update lands, so the choice cannot race the board's re-sort.

This is a pure function — `nextSelectionAfterArchive(rows, archivedId, selectedId)` — which
is what makes it testable in a repo with no jsdom.

### Thread header context

The header of the right pane shows the open lead's score chip and full reason text. This is
the one thing the inbox structurally cannot show, and it costs a prop.

## Query cost and the two denormalizations

`leadAnalysis.board` performs **four reads per row** inside a loop — `conversation`,
`contact`, newest `message`, `qualificationSession` — bounded by `BOARD_LIMITS.cap = 400`
(`convex/leadAnalysis.ts:106`, `:191`).

A Convex query re-runs when any document it read changes. Once a live chat shares the page,
every message sent and every inbound webhook re-runs the whole board. At today's 22 leads
that is ~90 reads and irrelevant; as backfill fills the board toward the cap it approaches
~1,600 reads per send.

### `lastMessageSenderType` on `conversations`

Optional field, written in `insertMessageAndUpdateConversation` alongside `lastMessageText`
and `lastMessageAt` (`convex/messages.ts:238`). That function is the backend's single
`insert("messages")` site — its own comment notes the rollup "cannot drift from the raw
rows unless a second insert site is added" — so the denormalization inherits that
guarantee.

**This field feeds a safety primitive, not just a badge.** `leadLane` is documented as
*"the safety primitive the whole automation rests on — a customer waiting on US is never
sequenced and never archived"* (`convex/lib/leadAnalysis/priority.ts:4`). Three rules
confine the risk:

1. **Absent means fall back.** When the field is undefined the board runs the original
   per-row `messages` query. `undefined` is never coerced to a sender type, so a missing
   value can never manufacture an `awaiting_them` verdict — the lane that automation is
   allowed to act on.
2. **Only `leadAnalysis.board` reads it.** The sequence engine keeps deriving eligibility
   from actual message rows. A display lane and an automation gate stay on separate
   evidence, so a bug in the denormalization cannot cause an unwanted send.
3. **Backfill is optional for correctness.** A paginated one-off internal mutation
   populates existing conversations. Until it runs, results are unchanged and only the cost
   saving is deferred.

### `serviceName` on `leadAnalyses`

Optional field cached at `applyScore` time from the qualification session, with the same
absent-means-fall-back rule so already-scored rows do not blank out. Removes the per-row
`qualificationSessions` query.

Net effect once backfilled: four reads per row become two point-gets.

## Module layout

| File | Change | Role |
|---|---|---|
| `src/app/(dashboard)/lead-analysis/page.tsx` | rewrite | Container: selection, URL sync, mutations, auto-advance |
| `src/components/lead-analysis/lead-analysis-list.tsx` | renamed from `lead-analysis-board.tsx` | Presentational list: narrow rows, selected state, row actions |
| `src/components/lead-analysis/lead-analysis-list.test.tsx` | renamed from `lead-analysis-board.test.tsx` | Follows its component |
| `src/components/lead-analysis/lead-analysis-summary.tsx` | new | Tiles + filters band, split out so the list file stays focused |
| `src/components/lead-analysis/lead-analysis-filter.ts` | new | `filterLeadRows`, lifted out of the board file where it lives on `main` |
| `src/components/lead-analysis/lead-analysis-selection.ts` | new | `nextSelectionAfterArchive` and friends — pure, unit-tested |
| `src/components/inbox/conversation-fetch-boundary.tsx` | new | `DeepLinkFallbackBoundary` extracted from the inbox page for reuse by both routes |
| `convex/messages.ts` | edit | Write `lastMessageSenderType` |
| `convex/leadAnalysis.ts` | edit | Read denormalized fields with fallback |
| `convex/leadAnalysisEngine.ts` | edit | Cache `serviceName` in `applyScore` |
| `convex/schema.ts` | edit | Two optional fields |
| `messages/en.json` | edit | `selectLead`, `back` under `LeadAnalysis` |

The existing presentational/container split is preserved throughout: the list stays free of
`useQuery`/`useMutation` so it can be rendered with mock data and asserted on as static
markup.

`MessageThread` is used **unmodified**. It already fetches its own messages, reactions,
funnel state, members and tags, and owns every send/react/assign mutation internally; its
props are just `conversation`, `contact`, and four optional callbacks
(`src/components/inbox/message-thread.tsx:104`).

## Error handling

`api.conversations.get` throws `ConvexError NOT_FOUND` for an id that does not exist,
belongs to another account, or sits outside the caller's role scope — including an agent's
`?c=` link to a lead since reassigned. A malformed id fails Convex's own argument validator
first. Both throw at render time, which is why a class error boundary rather than
`try`/`catch` is required (a `try` around the hook would trip `rules-of-hooks`).

The extracted `ConversationFetchBoundary` renders `null` on catch, so the pane falls back to
its "select a lead" empty state. It is keyed by conversation id so one bad link cannot
permanently disable the pane for links that follow.

Mutation failures keep the existing pattern: `console.error` plus a `sonner` toast from the
`LeadAnalysis` namespace.

## Testing

This repo has no jsdom and no Testing Library; `src/**` tests run in plain `node` and assert
on `renderToStaticMarkup`. Behaviour therefore lives in pure functions.

**Pure (`*.test.ts`)**
- `nextSelectionAfterArchive`: archiving the selected lead advances to the next row;
  archiving the last row falls back to the previous; archiving the only row clears
  selection; archiving an unselected row leaves selection untouched; restore never advances.
- `filterLeadRows` keeps its existing coverage unchanged across the move out of the board
  file — the extraction is mechanical and must not alter behaviour.

**Markup (`*.test.tsx`)**
- A row renders score, reason, lane and silence.
- The selected row carries `aria-current`.
- Row actions render for supervisor+ and are absent for an agent.
- The empty right pane renders the select-a-lead state.

**Convex (`*.test.ts`)**
- `insertMessageAndUpdateConversation` writes `lastMessageSenderType` for `customer`,
  `agent` and `bot`.
- `leadAnalysis.board` returns identical results with the field present and absent —
  the fallback path is asserted directly, not assumed.
- A conversation with no messages still lands `awaiting_us`.
- The backfill mutation is idempotent and resumable.
- `applyScore` caches `serviceName`.

## Rollout

1. Schema first: both fields are `v.optional(...)`, so existing documents still validate and
   `convex deploy` reports no index deletions. Per repo policy, the deploy happens only when
   the owner explicitly asks.
2. Ship the write path and the board's fallback reads together — the board must tolerate the
   field being absent before anything depends on it.
3. Run the backfill.
4. Ship the UI.

Steps 1–3 are invisible to users and independently revertible; only step 4 changes the page.

## Branching

**Implement from `origin/main`, not from `feat/media-understanding`.**

The two have diverged inside this very feature. On `main`, `filterLeadRows` is defined
inside `lead-analysis-board.tsx`; on `feat/media-understanding` it has already been lifted
into a separate `lead-analysis-filter.ts` with its own test. `main` also carries the P2/P3
work — archive/restore, the sequence engine, the settings screen — that the branch does not.
`main` is what is deployed and what this design was read against.

Branching this work off `feat/media-understanding` would reintroduce the older board and
silently drop archive/restore from the page.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Denormalized sender type feeds `leadLane`, which gates automation | Board-only read; engine untouched; absent falls back to the real query; `undefined` never coerced |
| Board still re-runs on every message | Unavoidable — the board genuinely depends on message arrival for lane and silence. The fix halves the cost per run; it does not remove invalidation |
| Two heavy subtrees on one route | `MessageThread` mounts only when a lead is selected, so the page stays cheap for a glance at the tiles |
| Vertical space on laptops | Summary tiles compact to one row; both header bands hide on mobile when a thread is open |
| `src/components/inbox/message-thread.tsx`, `conversation-list.tsx` and `inbox/page.tsx` currently carry uncommitted changes from a concurrent session | Implementation rebases on whatever lands; the boundary extraction is the only edit this design makes to those files, and it is additive |
