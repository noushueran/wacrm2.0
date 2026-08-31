# Lead Analysis — Design

**Date:** 2026-07-26
**Status:** Approved, ready for implementation plan

## Problem

The inbox is a single recency-ordered stream. A chat that an agent answered sinks as new
chats arrive, and nothing ever brings it back. Two failures follow:

1. **Leads are lost by scrolling.** A customer who was answered three days ago and never
   replied is indistinguishable from one who replied ten minutes ago and is waiting. Both
   are just rows in the same list, ordered by a timestamp that says nothing about worth.
2. **Nothing ever leaves.** `conversations.status` has `open | pending | closed`, but
   nothing auto-closes (`dashboard.metrics`' own comment: *"almost everything is
   `open`"*). Dead threads accumulate forever alongside live ones.

The owner's current remedy is to read every chat manually, weekly. That does not scale
and it is exactly the work a model should do.

### What already exists (and why it is not enough)

The repo already has a lead system, and this design deliberately does **not** replace it:

- **`/leads`** (`src/app/(dashboard)/leads/page.tsx`) renders `qualification.leadsBoard`
  over `qualificationSessions`. Each session carries `score` + `scoreBreakdown`
  (`criterion / marks / maxMarks / reason`) and a status of
  `collecting | qualified | expired | opted_out | disqualified`.
- **`qualification-follow-ups`** (cron, 5 min) sweeps `qualificationSessions.by_due` and
  sends follow-ups with configurable `followUpDelaysMinutes` / `maxFollowUps`, falling
  back to `reengagementTemplateName` once the 24h window closes.
- **`salesChecklists`**, **`funnelTransitions`**, **`leadOffers`** cover the
  post-qualification pipeline.

Three gaps remain, and they are the whole of this spec:

| Gap | Detail |
|---|---|
| Coverage | A session exists only where the qualification engine created one. Pre-feature history, off-topic enquiries, and organic chats have no score at all. |
| Score meaning | `qualificationSessions.score` measures *"did they answer the checklist"*, not *"is this worth chasing"*. A customer can answer every question and still be a tyre-kicker. |
| Disposal | There is no archive anywhere in the schema. Nothing removes a dead thread from the inbox, and nothing brings it back if the customer returns. |

## Principle

**Every conversation sits in exactly one lane, and the lane is derived — never stored —
from who sent the last message.**

| Lane | Meaning | Auto follow-up | Auto archive |
|---|---|---|---|
| **Awaiting us** | last message is the customer's | never | never |
| **Awaiting them** | we replied; the customer went quiet | yes | yes, at end of sequence |
| **Archived** | removed from the active inbox | no | — |

This is the safety property the entire automation rests on: a marketing template is never
sent to someone waiting on an answer from us, and such a person is never archived.

## Scope

**In scope.** A new `/lead-analysis` section covering every conversation with at least one
customer message; a holistic 1–10 AI score per conversation; archive with automatic return
on reply; a banded, template-based follow-up sequence ending in auto-archive; manual
template sending from the section.

**Out of scope.** `/leads` and the qualification engine are untouched. The funnel stages,
sales checklists, lead offers, purchase signals, and the deals pipeline are untouched.
Outbound-only threads and the admin alert channel never enter the section.

## Data model

### New table: `leadAnalyses`

One row per conversation. `by_conversation` doubles as the 1:1 enforcing index (a single
upsert path), mirroring `qualificationSessions`.

```ts
leadAnalyses: defineTable({
  accountId: v.id("accounts"),
  conversationId: v.id("conversations"),
  contactId: v.id("contacts"),

  // --- scoring ---
  score: v.optional(v.number()),                 // 1–10, absent until first scored
  band: v.optional(v.union(v.literal("hot"), v.literal("warm"), v.literal("cold"))),
  reason: v.optional(v.string()),                // one line: why this score
  signals: v.optional(v.array(v.string())),      // budget_given, dates_given,
                                                 // price_shopping, ghosted,
                                                 // wrong_service, ready_to_book, …
  scoredAt: v.optional(v.number()),
  scoredMessageCount: v.optional(v.number()),    // dedup: skip re-score if unchanged
  model: v.optional(v.string()),
  scoreStatus: v.union(
    v.literal("pending"),   // due for (re)scoring
    v.literal("scored"),
    v.literal("failed"),    // gave up after MAX_SCORE_ATTEMPTS
    v.literal("skipped"),   // ineligible (outbound-only, admin channel)
  ),
  rescoreDueAt: v.optional(v.number()),          // debounce timer
  attempts: v.number(),
  lastError: v.optional(v.string()),

  // --- follow-up sequence ---
  sequenceStatus: v.union(
    v.literal("idle"),       // not eligible / not started
    v.literal("running"),
    v.literal("exhausted"),  // steps spent, band.autoArchive === false
    v.literal("stopped"),    // replied, opted out, human took over, archived
  ),
  followUpsSent: v.number(),
  lastFollowUpAt: v.optional(v.number()),
  nextFollowUpAt: v.optional(v.number()),
  stoppedReason: v.optional(v.string()),
})
  .index("by_conversation", ["conversationId"])
  .index("by_account_score", ["accountId", "score"])
  .index("by_score_due", ["scoreStatus", "rescoreDueAt"])
  .index("by_sequence_due", ["sequenceStatus", "nextFollowUpAt"]),
```

`by_score_due` and `by_sequence_due` are partitioned cron ranges, the same shape as
`qualificationSessions.by_due` and `conversionEvents.by_status`: the sweep reads only its
own partition, and a row that gives up **leaves** that partition (`failed` / `stopped`)
rather than accumulating in front of the rows the sweep still wants.

### Changes to `conversations`

```ts
archivedAt: v.optional(v.number()),
archivedReason: v.optional(v.string()),        // "no_response" | "manual" | "aged_out"
archivedByUserId: v.optional(v.id("users")),   // absent = automation
returnedAt: v.optional(v.number()),            // last un-archive, for the "returned" flag
```

Two new indexes:

```ts
.index("by_account_archived_last_message", ["accountId", "archivedAt", "lastMessageAt"])
.index("by_account_archived_assigned_last_message",
       ["accountId", "archivedAt", "assignedToUserId", "lastMessageAt"])
```

**Why a timestamp field and not a fourth `status` literal.** `conversations.list` applies
`status` as a post-index `.filter()` (`convex/conversations.ts:144`), which is safe today
only because almost every row is `open` — the predicate matches early and often. Archived
rows accumulate forever, so as a `.filter()` they would make the inbox scan grow without
bound, which is the exact failure `schema.ts` documents for `broadcastRecipients`,
`conversionEvents`, and `campaignAds`. `archivedAt` is optional and Convex sorts a missing
field before every present value, so `eq("archivedAt", undefined)` is one genuine index
range over exactly the active set.

Two indexes, not one, because `conversations.list` has two indexable query plans:
`kind: "any"` (supervisor+, no tab) needs global recency order, and `kind: "eq"` (a single
assignee) binds the assignee first. The `meOrPool` plan is already an OR across disjoint
ranges served by a filter; archived stays a filter there too, matching the existing
trade-off documented in that file.

### New table: `leadAnalysisConfigs`

One row per account, `by_account` enforcing — mirrors `qualificationConfigs`, and
**dormant until `enabled`**, so deploying the schema changes nothing user-visible.

```ts
leadAnalysisConfigs: defineTable({
  accountId: v.id("accounts"),
  enabled: v.boolean(),                    // master switch, default false

  // scoring
  rescoreDebounceMinutes: v.number(),      // default 10
  scorePerRun: v.number(),                 // default 25
  backfillEnabled: v.boolean(),            // default true
  backfillPerRun: v.number(),              // default 10

  // sequence
  idleDaysBeforeSequence: v.number(),      // default 3
  humanQuietHours: v.number(),             // default 24 — no agent msg within
  dailySendCap: v.number(),                // default 100
  agedOutDays: v.optional(v.number()),     // hard archive for unscored/ancient; default 120
  bands: v.array(v.object({
    key: v.union(v.literal("hot"), v.literal("warm"), v.literal("cold")),
    minScore: v.number(),
    maxScore: v.number(),
    autoArchive: v.boolean(),
    steps: v.array(v.object({
      delayDays: v.number(),
      templateName: v.string(),
      templateLanguage: v.optional(v.string()),
    })),
  })),
  updatedAt: v.optional(v.number()),
}).index("by_account", ["accountId"]),
```

Approved defaults:

| Band | Score | Steps | End state |
|---|---|---|---|
| **hot** | 8–10 | 3 steps: 2d / 5d / 10d | `exhausted` → *Needs your decision*. **Never auto-archived.** |
| **warm** | 4–7 | 2 steps: 3d / 7d | auto-archive `no_response` |
| **cold** | 1–3 | 1 step: 5d | auto-archive `no_response` |

**How `delayDays` is measured.** Step 1 is measured from the **last customer message**;
every later step from the **previous follow-up send**. `idleDaysBeforeSequence` is an
independent floor on entry, so the effective first touch is
`max(idleDaysBeforeSequence, steps[0].delayDays)` — with the defaults above, a hot lead is
first nudged at day 3 (the floor), a warm lead at day 3, a cold lead at day 5.

### Other schema touches

- `aiUsageLog.mode` gains the literal `"score"`.
- `notifications.type` gains the literal `"lead_returned"`.

Both are additive unions; existing rows stay valid.

## Scoring engine

**Trigger.** `ingest.ingestInbound`, at the point it writes an inbound customer message,
upserts the `leadAnalyses` row and sets `scoreStatus: "pending"`,
`rescoreDueAt: now + rescoreDebounceMinutes`. A burst of five messages pushes the same
timer forward, so it costs one call, not five. A silent thread is never re-scored.

**Sweep.** A new cron `lead-scoring` (5 min), registered through `cronSchedules.ts` like
every other cron so it stamps a `cronRuns` row. It ranges `by_score_due` on
`("pending", <= now)` and takes `scorePerRun`. For each row it skips (and marks `scored`)
when `scoredMessageCount` equals the conversation's current message count — cheap
protection against a re-queue that carries no new content.

**The call.** Prompt input is the last ~40 messages built with the existing transcript
helper in `convex/lib/ai/context.ts`, plus the contact's travel profile
(`travelDates` / `travelers` / `budget` / `preferredDestination`), the matched service
name where a qualification session exists, and the account's KB service list. The model
returns strict JSON `{ score, reason, signals[] }`, generated through
`convex/lib/ai/generate.ts` on the account's BYO key, paced by `lib/aiRateLimit.ts`, and
logged to `aiUsageLog` under mode `"score"`.

**Failure.** `attempts++` with backoff; after `MAX_SCORE_ATTEMPTS` the row moves to
`failed` and leaves the sweep partition. The board renders it as *unscored*; it remains
archivable by the `agedOutDays` rule.

**Backfill.** When the due range is empty, the same cron enqueues `backfillPerRun`
conversations that have no `leadAnalyses` row yet, newest-activity-first.

It must not rediscover its own progress. "Has no row" is not an indexable predicate on
`conversations`, so a naive implementation re-scans from the newest conversation every run
and walks further each time — the unbounded-scan shape this schema repeatedly warns
against. Instead the backfill keeps a **cursor**: one `counters` row per account
(`name: "leadAnalysisBackfill"`, `value:` the `lastMessageAt` of the last conversation
enqueued). Each run resumes with `by_account_last_message` ranged `lt(lastMessageAt,
cursor)` in descending order, so it walks the account exactly once, in bounded slices, and
stops when the range is exhausted. A reset mutation clears the cursor to force a full
re-walk.

Live scoring is always drained first, so backfill never competes with a fresh lead.

**Manual.** `leadAnalysis.reanalyze` (supervisor+) sets `scoreStatus: "pending"`,
`rescoreDueAt: now`, clearing `scoredMessageCount` so the dedup cannot short-circuit it.

**Ranking is free.** The board's sort key — score desc, then *awaiting us* first, then
recency — is computed at query time from `score`, `lastMessageAt`, and the last message's
`senderType`. A lead going stale changes position with no LLM cost.

## Follow-up sequence

### Eligibility

A conversation enters the sequence only when **all** hold. These are pure predicates in
`convex/lib/leadAnalysis/eligibility.ts`, unit-tested without a database:

1. `config.enabled`
2. `conversation.archivedAt` is unset
3. lane is *awaiting them* (last message `senderType !== "customer"`)
4. idle for ≥ `idleDaysBeforeSequence`
5. **qualification has released the outbound clock.** Satisfied when the conversation has
   no qualification session, or its session is no longer `collecting`, **or** the session
   is still `collecting` but has spent its budget (`followUpsSent >= maxFollowUps`).

   The third case is safe by construction rather than by timing: at
   `convex/qualificationEngine.ts:1469` a session that has spent its budget stops sending
   and only reschedules to its expiry revisit, so it never sends again — there is no
   window in which both engines can message the same customer. Without this case a
   half-answered lead would stay invisible to nurture for the whole
   `sessionWindowHours`, which is the opposite of cleaning the inbox
6. not opted out: no `opted_out` session and no stop keyword on record
7. no `senderType: "agent"` message within `humanQuietHours` — never step on an agent
   mid-conversation
8. `conversation.status !== "closed"` — a closed thread is archived directly, no sequence

### Running

A new cron `lead-follow-ups` (15 min) ranges `by_sequence_due` on `("running", <= now)`.
For each due row it **re-checks every gate at send time** (the pattern
`qualification-follow-ups` already uses), then sends the band's step template through
`internal.metaSend.sendTemplate` with `senderType: "bot"`, gated by the working-hours
arithmetic already in `qualificationConfigs` (`utcOffsetMinutes`, `workStartMinute`,
`workEndMinute`, `workDays`). Templates work whether or not the 24h window is open, which
is the entire reason the sequence is template-based.

After a send: `followUpsSent++`, `lastFollowUpAt = now`, and `nextFollowUpAt` set from the
next step's `delayDays` — or, when no step remains, `autoArchive ? archive(no_response)
: sequenceStatus = "exhausted"`.

### Stopping and returning

Any inbound customer message sets `sequenceStatus: "stopped"`,
`stoppedReason: "replied"`, resets `followUpsSent` to 0, and clears `nextFollowUpAt`. The
lead moves to *awaiting us* and rises to the top of the board.

The same `ingest` hook clears `archivedAt`, stamps `returnedAt`, and inserts a
`lead_returned` notification. Because `lastMessageAt` was just updated, the thread
reappears at the top of the Inbox by ordinary recency — no special-casing in
`conversations.list`.

### Rails

- **Daily cap.** `dailySendCap` sequence sends per account per day, counted from
  `messages` written by the sequence. Protects both spend and the WhatsApp quality rating.
- **Kill switch.** `enabled: false` halts every send immediately; due rows simply stop
  being swept.
- **Preview.** A read-only *"who would be messaged in the next 7 days"* query, runnable
  before enabling.
- **No invisible sends.** Every send writes a normal `messages` row, so the whole sequence
  is visible in the thread and in the customer's chat exactly as an agent would see it.

## The section — `/lead-analysis`

Named **Lead Analysis** in the sidebar.

**Summary tiles.** Hot / Warm / Cold · Awaiting us · In sequence · Needs decision ·
Archived · average score · unscored count with backfill progress.

**Filters.** Score range, band, lane, source (`ad` / `website` / `organic`, derived from
`conversation.attribution` and `adReferral` exactly as `leadsBoard` derives it), assignee,
service, signal tag, date range. **Sort:** priority (default), score, last activity, oldest
untouched.

**Row** — dense single line, expandable:

- score chip coloured by band; hover shows `reason` and `signals`
- contact name and phone, service, source badge, assignee
- "6d silent", lane badge, sequence progress (`●●○ 2/3`)
- actions: Open chat · Send template · Archive · Re-analyze · Stop sequence

**Bulk select** → Archive · Start sequence · Send template · Re-analyze.

**Detail drawer.** Score, reason, signals, a message excerpt, links to the qualification
session and funnel stage where present, and the full sequence history.

**Template send** reuses `src/components/inbox/template-picker.tsx` and the existing
`api.send.send` action with `messageType: "template"`, adding a *"window closed — template
required"* hint when the last inbound is older than 24h.

**RBAC.** Supervisor+ get everything. Agents see only conversations assigned to them and
get read, Open chat, and Re-analyze — no archive, no sequence control, no template send.
Viewers have no access. This mirrors `qualification.leadsBoard`'s `ownOnly` rule.

**Inbox changes stay minimal.** `conversations.list` excludes archived rows via the new
indexes; an **Archived** tab reuses the same query with the complementary range; a
deep-linked archived thread shows an *Archived* badge and a Restore button.

## Module layout

Pure logic lives in `convex/lib/leadAnalysis/`, each file with a sibling `.test.ts` and no
database access — the structure `convex/lib/qualification/` already uses:

| File | Responsibility |
|---|---|
| `bands.ts` | score → band; band → steps; default config |
| `eligibility.ts` | the eight gates, as one pure predicate over a plain input record |
| `schedule.ts` | next follow-up instant, including working-hours arithmetic |
| `priority.ts` | the board sort key |
| `prompt.ts` | prompt construction and strict-JSON response parsing/validation |

Convex functions split the same way the codebase already splits them: `leadAnalysis.ts`
holds account-scoped queries and mutations (board, filters, archive, restore, reanalyze,
stop sequence, config CRUD); `leadAnalysisEngine.ts` holds the internal scoring and
sequence machinery driven by the crons.

## Testing

- **Unit** (no DB): every file in `convex/lib/leadAnalysis/`. Band boundaries at 3/4 and
  7/8, each gate in isolation and in combination, schedule arithmetic across a weekend and
  a working-hours boundary, sort-key ties.
- **Convex-test:** debounce collapses a message burst into one score; `scoredMessageCount`
  dedup short-circuits an unchanged thread; both sweeps stay within their `take` bound and
  never read outside their partition; archive → inbound → un-archive round trip;
  stop-on-reply resets the counter; a `collecting` session with follow-ups remaining
  blocks nurture, and the same session with `followUpsSent >= maxFollowUps` releases it;
  RBAC denies an agent archiving someone else's lead; the daily cap halts sends.
- **Component:** board rendering and filter behaviour, following
  `src/components/inbox/conversation-list.test.tsx`.

## Rollout

Four phases, each independently shippable and inert until `enabled` is set:

1. **P1** — schema, scoring engine, backfill, read-only board (score, filter, sort). No
   sends, no archive.
2. **P2** — archive / restore, inbox exclusion, `lead_returned` notification.
3. **P3** — sequence engine, config UI, daily cap, preview query.
4. **P4** — bulk actions, template send from the board, backfill polish.

Schema changes reach production only through the owner's own `convex deploy`; no agent
session runs `convex deploy`, `convex dev`, or `convex codegen` against this repo.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Marketing templates annoy customers, hurting the WhatsApp quality rating | Sequence only reaches people who went quiet on us; daily cap; hot leads never auto-archived; every send visible in-thread; kill switch |
| Backfill spikes the BYO-key bill | `backfillPerRun` bounded, drained after live scoring, and paced by the existing rate limiter |
| The model scores a good lead low and it gets archived | Archive is reversible, any reply un-archives automatically, `agedOutDays` is the only unscored path to archive, and the board keeps an Archived view |
| Nurture and qualification double-message a customer | Gate 5: nurture waits until qualification has either left `collecting` or spent `maxFollowUps`, after which that engine provably never sends again |
| Inbox read cost grows as archived rows accumulate | `archivedAt` is an indexed range, not a filter — the reason for the two new `conversations` indexes |
