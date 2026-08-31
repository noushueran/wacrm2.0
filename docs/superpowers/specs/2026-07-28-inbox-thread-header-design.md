# Inbox Thread Header — Reorganisation — Design

**Date:** 2026-07-28
**Status:** Draft, awaiting owner review
**Touches:** `src/components/inbox/message-thread.tsx` (header block, lines ~945–1352)

## Problem

The thread header is a single wrapping flex row carrying up to thirteen elements:

**State (left):** avatar · name/phone · `23h remaining` · `Ad lead` · `Free 65h` ·
`4/5 · 65` · up to six tag chips + an overflow counter.

**Actions (right):** Stop chasing · Chase now · Snooze (split) · Archive · Stage ▾ ·
Status ▾ · Assignee ▾ · ⋮ (Mark unread).

Two structural faults follow from that:

- **State and actions share one wrapping row.** The row silently reflows — on the owner's
  screenshot `4/5 · 65` has already dropped to a second line — so the header's height and the
  position of every control change per conversation, depending on which conditional badges
  happen to render. Controls that move are controls that get mis-clicked.

- **The two time windows read as one concept.** `23h remaining` (the 24h service window:
  *may I free-text?*) and `Free 65h` (the 72h free-entry-point window: *does this cost
  money?*) render as near-identical outline pills side by side. They are independent — either
  can be open alone — and the code comment at `message-thread.tsx:1001` exists precisely
  because they are confusable. Rendering them as siblings invites the confusion the comment
  warns about.

Reported by the owner, 2026-07-28: "these are all the things scattered in the headline".

## Principle

**The header shows what changes what you can do next. Everything else is one click away.**

The two windows govern whether a reply is possible and whether it is free — they stay.
Status is the field the owner changes constantly — it stays. Stage, assignee, ad-provenance,
qualification and tags all answer *"what kind of lead is this?"*, which is one question and
deserves one home, not five chips and two dropdowns.

## Decisions taken with the owner

1. **Status stays a visible labelled dropdown.** Stage and assignee collapse — changed rarely.
2. **Both time windows stay glanceable.** Ad lead and qualification do not.
3. **Snooze stays outside the overflow menu**, as an icon-only split button. It is frequent
   and was just built (`cd0983f`, `0fefa19`); burying it to save ~28px is the wrong trade.

## Scope

**In scope.** Header markup and layout; a merged window pill; a lead popover; an overflow
menu; extraction of the header out of `message-thread.tsx`; new i18n keys; unit tests for the
new pure label helpers.

**Out of scope.** Any Convex function, schema, or mutation. Any change to what the controls
*do* — stage/status/assign/snooze/archive/chase/mark-unread all keep their current handlers,
role gating, and server contracts. The contact sidebar. The composer. Mobile back-button
behaviour.

## Layout

One row, three zones, never wraps. `min-w-0` on the identity zone; `shrink-0` on the rest.

```
[←] (K) Krishna              ⏱ 23h │ free 65h        [Pending ⌄] [New lead · KB ⌄] [⏱⌄] [⋮]
        +971 54 427 6505
   └── identity (shrinks) ──┘ └── window pill ──┘     └────────── actions (fixed) ─────────┘
```

### Identity zone

Unchanged: back button (`lg:hidden`), avatar initial, and the name/phone button that opens
the contact slide-over. Keeps `min-w-0` and `truncate` so a long name yields space rather
than pushing the row.

### Window pill

One bordered pill with up to two segments, replacing the `sessionInfo` and
`freeWindowRemaining` badges.

| Segment | Renders when | Content | Colour |
|---|---|---|---|
| Service | always | clock icon + `sessionInfo.remaining` | `text-primary`; `text-red-400` when `sessionInfo.expired` |
| Free | `freeWindowRemaining` is truthy | `free {remaining}` | `text-emerald-400` |

The segments are divided by a `border-l border-border`. When only the service segment
renders, the pill is a plain single-value pill — no empty divider.

Carried over verbatim: the free segment's `title` still switches between
`Inbox.messagingWindow.freeBadgeTitle` and `freeBadgeEstimatedTitle` on
`windows.fep.source === "meta"`. The pill stays `hidden sm:inline-flex`, as both badges are
today.

### Actions zone

**Status** — the existing dropdown, unchanged: same `STATUS_OPTIONS`, same
`handleStatusChange`, same `currentStatus.color` on the trigger, same
`accountRole !== "viewer"` gate.

**Lead button** — trigger label, in order of precedence:

| State | Label |
|---|---|
| stage set, assignee set | `{stage} · {initials}` |
| stage set, unassigned | `{stage}` |
| no stage, assignee set | `{Inbox.funnel.label} · {initials}` |
| neither | `{Inbox.funnel.label}` |

Trigger colour follows the current stage dropdown: `text-primary` when a stage is set,
`text-muted-foreground` otherwise. Below `sm` the trigger renders icon + chevron only.

Opens a popover (`@/components/ui/popover`, already used by `LabelPicker`) with four sections
top to bottom:

1. **Stage** — the `UI_FUNNEL_STAGES` list, current one checked, `handleStageSelect` on click.
2. **Assignee** — the existing assign menu body moved wholesale: supervisor+ gets the teammate
   list with `PresenceDot` and Unassign; an agent gets Claim or Release; both keep
   `canAssignToOthers` and the `isPool` disabled rule.
3. **Context** (read-only) — `Ad lead` when `conversation.ad_referral`, and the
   `QualificationChip`.
4. **Tags** — `headerChips.visible` plus the `+N` overflow, same `tagChipRow(groups, tags, 6)`.

Sections 3 and 4 are separated from 1–2 by a `DropdownMenuSeparator`-equivalent divider and
render nothing when empty — a conversation with no ad, no qualification session and no tags
shows a popover with just Stage and Assignee.

Because Radix unmounts popover content while closed, `QualificationChip`'s
`api.qualification.getSessionForConversation` query no longer fires on every thread open —
it runs only when the popover is opened. That is a deliberate, and favourable, side effect.

**Snooze** — the existing split button, icon-only: clock icon + chevron, no `Snooze` text
label, `aria-label` retained. Primary click still snoozes three hours; the dropdown still
carries tomorrow / next week / custom. Swaps to a single **Wake now** button (text, not icon)
when `overrides.wake` — the two never render together, as today.

**Overflow `⋮`** — in order, each with its existing condition:

| Item | Condition today |
|---|---|
| Chase now | `overrides.chaseNow` |
| Stop chasing | `canStopChasing && conversation.sequenceStatus === "running"` |
| Archive | `canArchive && !conversation.archived_at` |
| Mark unread | `accountRole !== "viewer" && onMarkUnread && conversationId` |

**The `⋮` trigger does not render when every item is hidden.** This is load-bearing for
viewers: a viewer has no status control, no lead button, and no menu items, so their header
correctly reduces to identity + window pill rather than an empty menu that opens onto nothing.

## Structure

`message-thread.tsx` is 1687 lines and this adds a popover. The header moves out:

- **`src/components/inbox/thread-header.tsx`** — the row. Props are the values the header
  already derives or receives: `contact`, `conversation`, `conversationId`, `accountRole`,
  `sessionInfo`, `freeWindowRemaining`, `windows`, `funnelState`, `currentStatus`,
  `assignedAgentId`, `profiles`, `overrides`, `headerChips`, and the handlers
  (`onBack`, `onToggleContactPanel`, `onMarkUnread`, `handleStageSelect`,
  `handleStatusChange`, `handleAssignChange`, `handleSnooze`, `handleWake`, `handleArchive`,
  `handleChaseNow`, `handleStopChasing`).
- **`src/components/inbox/lead-popover.tsx`** — stage + assignee + context + tags.
- **`src/lib/inbox/threadHeader.ts`** — two pure functions, `windowPill()` and
  `leadButtonLabel()`, so the branching above is unit-testable without rendering.

The derivations stay in `message-thread.tsx` — they feed other consumers (`sessionInfo` and
`freeWindowRemaining` are read again at lines 1506 and 1516 for the composer).

## i18n

New keys under `Inbox.messageThread`: `leadButton` (the `{stage} · {initials}` template),
`leadSectionStage`, `leadSectionAssignee`, `leadSectionContext`, `leadSectionTags`.
Existing keys reused unchanged: `snooze`, `snoozeThreeHours`, `snoozeTomorrow`,
`snoozeNextWeek`, `snoozeCustom`, `wake`, `archive`, `archiveTooltip`, `chaseNow`,
`chaseNowTooltip`, `stopChasing`, `markUnread`, `more`, `adLeadBadge`, and everything under
`Inbox.funnel`, `Inbox.qualification`, `Inbox.messagingWindow`.

`messages/en.json` is currently the only locale file, so the new keys go there and nowhere
else.

## Testing

`src/lib/inbox/threadHeader.test.ts`, matching the `view.ts` / `view.test.ts` and
`labels.ts` / `labels.test.ts` pattern already in the repo:

- `windowPill()` — service only; service + free; expired service; expired service + open free
  (the case where the pill is red and green at once, which is legitimate).
- `leadButtonLabel()` — all four rows of the precedence table, plus a long assignee name
  reducing to initials.

Manual verification against `localhost:3000/inbox`, on a conversation with every badge
present and one with none:

- the row does not wrap at any width from 1440px down to 375px;
- the header's height is identical on a conversation with all badges and one with none;
- a viewer account sees no `⋮`;
- an archived thread shows no Snooze and no Archive item;
- opening the lead popover changes stage, then assignee, and both persist after a reload.

## Risks

**A rarely-opened popover hides state an agent was scanning.** Qualification progress is the
real candidate — an agent watching a bot qualify a lead currently sees `4/5` tick up without
clicking. Mitigation if it bites: a dot on the lead trigger when the qualification session is
`collecting`. Not built now; it re-introduces the eager query the popover just removed.

**Prop count on `ThreadHeader`.** ~20 props is a lot. The alternative — passing the whole
`conversation` plus a handlers bag — hides the dependency surface rather than reducing it.
Explicit props are the right trade for a component with exactly one call site.
