# Revival agent — design

Date: 2026-08-09
Status: awaiting approval

## Problem

Leads answer once and go quiet, and nothing chases them. All three existing
follow-up engines are dormant in production, each for a different reason: Flows
has never executed, Lead Analysis bands have `steps: []`, and qualification
nudges have `outboundNudgesEnabled: false` with `reengagementTemplateName` still
set to Meta's `hello_world` sample.

The leads are already paid for — they arrived through Meta ads. Nothing about
reviving them costs new acquisition budget.

## What the data says

Sampled every conversation in production on 2026-08-09 (n=1,767):

| Last activity | Count | Share | Channel available |
|---|---|---|---|
| under 24h | 174 | 10% | free text |
| 1–7 days | 573 | 32% | approved template only |
| 7–30 days | 1,020 | 58% | approved template only |

90% sit outside Meta's 24-hour customer-service window, and the account has
exactly one approved template — `hello_world`, whose body is Meta's own sample
text. It cannot be used to chase anyone.

This splits the problem in two, and the split drives the whole design:

- **The flow** — each lead as it goes quiet, caught inside its first 24 hours in
  free text. No external dependency. Ships now, works forever.
- **The stock** — the 1,593 already-cold leads. Template-only, so blocked on
  Meta approval. Designed for, dormant until templates exist.

Building the flow first is not a compromise. A lead that stopped replying three
hours ago is warmer than one from three weeks ago, so the in-window path is also
the higher-converting one.

## Goal

An agent that decides which quiet leads deserve a chase, writes a message
grounded in that lead's actual trip, and puts it in a queue for one-tap human
approval. Auto-send is deliberately not built in v1.

Non-goals: auto-sending; reviving the cold stock (blocked); replacing the three
existing engines; media templates (`sendTemplateMessage` builds no header
component — a known, separate gap).

## Selection

A 30-minute cron sweeps for candidates. A conversation qualifies when **all** of:

- last message was inbound from the customer (they spoke last, we did not)
- quiet for at least `minQuietMinutes` (default 180) and still inside the 24h
  window, leaving `windowSafetyMinutes` (default 60) of headroom so a draft
  cannot be approved into an expired window
- no `revivalDrafts` row for this conversation within `cooldownHours` (default
  72), in any status
- not snoozed, not do-not-contact, not archived
- no qualification session in `collecting` — that engine has its own ladder, and
  two agents nudging the same lead is worse than neither

Assignment is **not** a disqualifier. A lead assigned to a salesperson still gets
a draft; it routes to that assignee for approval rather than the shared queue.
Skipping assigned threads would skip most of the Chasing lane, which is exactly
the population worth reviving.

Candidates are ordered by lead score descending, so the caps spend themselves on
the best leads first, and any candidate below `minLeadScore` is skipped outright.

Two bounds apply, and both are checked before generation because generation is
what costs money: `draftsPerRun` (default 20) caps one sweep, and
`dailyDraftCap` (default 50) caps drafts created since local midnight, counted
from `revivalDrafts` by `createdAt`. Hitting either ends the sweep early; hitting
the daily cap is logged so a silently truncated run never reads as "nobody
qualified".

## Generation

Per candidate, one LLM call at the judge tier: the thread's recent messages, the
qualification profile (destination, dates, pax, budget), and the matched service
from the KB.

The prompt asks for a short WhatsApp-shaped nudge that references the lead's
actual trip, in the language they were speaking (including Manglish), and that
does not invent prices, availability, or commitments. It returns the message, a one-line
`reason` — why this lead, now — and its own `confidence` of `high`/`medium`/`low`,
exactly as `aiTagging`'s classifier does. The reason is shown to the approver so
they are accepting a judgement, not just a sentence; the confidence is what a
later auto-send unlock would threshold on, which is why it is recorded from day
one even though nothing reads it yet.

Usage logs under a new `aiUsageLog.mode` of `revive`, giving the agent its own
timesheet line on the roster. Dry-run mode returns a synthetic draft, matching
`aiReply`/`aiTagging`.

## The queue

New table `revivalDrafts`, modelled on `tagSuggestions` — the same
propose-then-accept shape already proven in the inbox:

```
accountId, conversationId, contactId
body: string              // the drafted message
reason: string            // why this lead, now
channel: "free_text" | "template"
status: "pending" | "sent" | "dismissed" | "expired"
assignedToUserId?         // routes to the lead's owner when there is one
model, confidence
reviewedByUserId?, reviewedAt?
createdAt, expiresAt      // when the 24h window closes
```

Indexed `by_account_status` and `by_conversation`.

`expiresAt` is what keeps the queue honest: a draft whose window has closed is
swept to `expired` rather than sitting there looking sendable.

## Sending

Approval calls a `send` mutation that **re-checks every guard at send time** —
window still open, customer has not replied since, not snoozed, not
do-not-contact, still `pending`. This is the discipline
`qualificationEngine.sendFollowUp` already follows, and it is what makes a
mid-flight crash or a stale browser tab safe.

Guards that fail return a typed reason the UI can show ("the customer replied —
open the thread instead"), never a silent no-op.

Working hours from `qualificationConfigs` (Mon–Sat, 10:00–21:00 local) gate when
drafts are *generated*, not when a human may send one. A human choosing to send
at 22:00 is a human decision.

## Approval surface

A **Revival** queue on the `/agents` page, beside Roster: pending drafts as
cards — contact, why, the drafted text — with Send, Edit and send, and Dismiss.
Editing before sending is first-class; the fastest way to learn the agent writes
badly is to watch what humans change.

Plus an inbox banner on any conversation with a pending draft, so someone already
in the thread sees it without leaving.

Dismissals record `reviewedByUserId`. A dismissal rate that stays high is the
signal not to unlock auto-send.

## Templates for the cold stock

Out of scope to send, in scope to prepare. This design ships **drafted template
bodies** — re-engagement copy matched to the top services (UAE Visa Services, UAE
Visa Change, International & Global Holiday Packages, Freelance Visa) in English
and Manglish-friendly phrasing — seeded into `messageTemplates` as `DRAFT`.

Submitting them to Meta stays a human action. It is the owner's business account
and the owner's name on the copy, and approval is Meta's to give.

Once templates are approved, the `channel: "template"` path activates with no
further code: selection widens past 24h and generation picks a template plus
parameters instead of free text.

## Configuration and dormancy

New `revivalConfigs`, one row per account, `enabled` defaulting **false**. With no
enabled config the sweep finds nothing, so the feature costs nothing until turned
on — the same dormant-safe pattern as Lead Analysis.

Fields: `enabled`, `minQuietMinutes`, `windowSafetyMinutes`, `cooldownHours`,
`draftsPerRun`, `dailyDraftCap`, `minLeadScore`.

## Roster integration

`convex/lib/agentRegistry.ts`'s `revival` entry flips to `built: true` with
`modes: ["revive"]` and `cronName: "revival-sweep"`. It then reports live status
on the roster with no other change — which is the point of having built the
roster first.

## Access control

Drafting is server-only. Approving requires `agent` role and passes the same
per-conversation RBAC as `aiReply.draft` (assignee or unassigned pool; supervisor
and above see everything). A viewer may read the queue and send nothing.

## Testing

`convex/revivalEngine.test.ts` and `convex/lib/revival/*.test.ts`, with the pure
selection and guard logic extracted so it tests without a ctx:

- each selection rule excludes what it should, including the window-safety margin
- an assigned lead routes to its assignee, not the shared queue
- cooldown suppresses a second draft for the same conversation
- send re-checks guards: a customer reply since drafting blocks the send with a
  typed reason
- an expired draft can never be sent
- dry-run generates without touching a provider
- `revive` usage rows count to the revival agent on the roster

## Out of scope

- Auto-send (deliberate; unlocked later on evidence)
- Submitting templates to Meta
- Media/header templates
- Reviving the 1,593 cold leads before templates are approved
