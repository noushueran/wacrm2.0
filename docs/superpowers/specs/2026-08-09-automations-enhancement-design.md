# Automations enhancement — design

Date: 2026-08-09
Status: awaiting approval

## Problem

The automations builder ships thirteen step types and a working engine, but three
of the four send actions are unusable in practice, nothing in the system knows
about Meta's 24-hour customer-service window, and a queued contact is invisible.

The trigger for this work was a live automation
(`mn7bry9z4hqtm4rnh9k805n14x8c4b65`) shaped
`Tag Added → Wait 1m → Send Message → Wait 1m → Send Message → Wait 1m → Send Template`.
Every one of the defects below is on its path.

### What was verified, not assumed

Each finding below was reproduced against the running app or read out of the
source. None is inferred.

**1. The action menu is complete; discovery is the problem.**
All thirteen types are addable and correctly labelled ("Send Buttons", "Send
List", "Send Template" — `messages/en.json`, `Automations.builder.steps`). They
render as one flat, ungrouped, scrolling list anchored under the `+` button, with
no descriptions and no search. The list *reads* as "send a message and some
odds and ends".

**2. `send_buttons` / `send_list` are visually broken.**
`src/components/interactive/interactive-builder.tsx:91` lays out
`flex flex-col gap-4 md:flex-row` with a `md:w-[280px]` preview column at line
164. Those are **viewport** breakpoints. The step card is a fixed 320px
(`sm:w-80`, `automation-builder.tsx:1109`), leaving ~288px of content box. On any
desktop viewport the `md:` rules apply, the component goes two-column, the 280px
preview consumes the row, and the form column collapses to near-zero — labels
render one character per line. Reproduced in-app.

**3. `send_template` cannot fill template variables.**
`SendTemplateFields` (`automation-builder.tsx:543`) edits `template_name` and
`language` only. The engine reads `cfg.variables` and sorts them numerically
(`automationsEngine.ts:771`), but nothing in the builder ever writes that key.
Any template with `{{1}}` fails at Meta. The live automation's `hello_world`
works only because it has zero variables.

**4. `sendTemplateMessage` emits body components only.**
`convex/lib/whatsapp/metaApi.ts:721` builds `components: [{ type: "body", ... }]`
and nothing else. Templates with an image/video/document header cannot be sent
by any code path in this repo.

**5. There is no media action.**
`send_media` is fully built for flows — R2 key, cross-account ownership check,
caption, filename (`flowsEngine.ts:754`). Automations never got an equivalent.
Flows' version also omits audio.

**6. Nothing knows about the 24-hour window.**
`ConditionSubject` is `contact_field | tag_presence | message_content |
time_of_day` (`src/types/index.ts:772`). The engine never reads
`conversations.lastInboundAt`, which is in the schema at line 312. A
`Wait 1 day → Send Message` sequence therefore fails silently at Meta once the
window closes — which is the exact shape of the live automation.

**7. `time_of_day` evaluates in UTC.**
`automationsEngine.ts:679` calls `new Date().getHours()` on the Convex runtime.
For a Dubai account (UTC+4) an `18:00-09:00` out-of-office window is four hours
wrong. The `time_based` *trigger* already solved this correctly by reading
`qualificationConfigs.utcOffsetMinutes` per account
(`automationsEngine.ts:1045`); the condition never adopted it. The bundled
`out_of_office` template ships an `18:00-09:00` window
(`convex/automations.ts:91`), so any account using it is affected.

**8. Pending work is unrepresentable.**
A `wait` step calls `ctx.scheduler.runAfter` and persists nothing
(`automationsEngine.ts:595`). No row anywhere represents a contact queued between
steps. "How many are waiting" cannot be answered, a queued send cannot be
cancelled, and deleting an automation leaves its scheduled resumes to fire into
the void. The list page shows `execution_count` and `last_executed_at` and
nothing else.

## Goal

Make the automations section trustworthy to build with and to run:

- One send step that composes text, media and buttons, with a template fallback
  for when the window is shut.
- Templates that actually work, variables and media headers included.
- Every queued contact visible, countable and cancellable.
- Enough on-screen numbers to tell whether an automation is working.

## Non-goals

- **Test/dry-run execution.** Considered and dropped — not selected during
  design. The per-step counters in Phase 2 cover the same need retrospectively.
- **Reworking triggers.** All eight dispatch correctly as of 2026-08-09.
- **Touching the flows builder.** It shares `interactive-builder.tsx`, so it
  inherits the container-query fix, but its own UX is out of scope.
- **Media headers on interactive messages.** Excluded deliberately — see §1.2 for
  why it is a separate change.

## Design

### Phase 1 — Make sending correct

#### 1.1 The unified send step

One `Send message` action in the menu. **`automationSteps.stepType` does not
change** — the union stays as it is and `send_message`'s config grows:

```ts
interface SendMessageStepConfig {
  text?: string;
  media?: {
    key?: string;                                    // R2 key, account-scoped
    url?: string;                                    // legacy/external
    type: "image" | "video" | "audio" | "document";
    filename?: string;                               // document only
  };
  interactive?: InteractiveMessagePayload;           // buttons or list
  fallback?: {                                       // used when CSW is closed
    template_name: string;
    language: string;
    variables?: Record<string, string>;
    header?: { type: "image" | "video" | "document"; key?: string; url?: string };
  };
}
```

This is the property that makes the change safe: an existing `{ text: "hello" }`
config is already a valid instance of the new shape. **No data migration, no
schema union change, zero risk to the live automation.**

`send_buttons` and `send_list` keep their engine cases (existing steps continue
to run) but leave the add menu. Opening one in the builder loads it into the
composer with `interactive` populated; saving writes it back as `send_message`.
Upgrade-on-edit, never a bulk rewrite.

#### 1.2 Send dispatch

`runStep`'s `send_message` case resolves the window first (§1.4), then picks one
transport. **Evaluated top-down, first match wins:**

| # | Config | Transport |
|---|---|---|
| 1 | `media.type === "audio"`, `text` non-empty | `sendMedia` then `sendText` — two messages |
| 2 | `media` present | `sendMedia`, `text` as caption |
| 3 | `interactive` present | `sendInteractive` |
| 4 | otherwise | `sendText` |

Row 1 exists because Meta 400s on a captioned audio; `metaApi.ts:655` already
drops caption and filename for `kind === "audio"`, so the split into two
messages is the only new behaviour needed. Audio with no text takes row 2 and
sends a single message.

**Media and interactive are mutually exclusive**, enforced in the composer:
selecting one disables the other with an inline explanation. The reason is
concrete — `InteractiveMessagePayload.header` is typed `string`
(`convex/lib/whatsapp/interactive.ts:44`) and `sendInteractiveButtons` accepts
only `headerText` (`metaApi.ts:923`), so this repo cannot currently put an image
on an interactive message. Meta itself supports it, so image-plus-buttons is a
genuine follow-up; it is excluded here because it means widening the shared
interactive payload type, its validator and its transport, all of which are also
on the flows, conversations and broadcast paths. That is a change those surfaces
should be reviewed for on its own, not a rider on this one.

Media ownership follows the flows precedent verbatim: `parseMediaKey`, compare
`accountId`, and gate `kind` through a new
`AUTOMATION_SENDABLE_MEDIA_KINDS = new Set(["automation"])` so an internal
`note` object can never be sent to a customer. `"automation"` is added to
`MEDIA_KINDS` in `convex/lib/r2/keys.ts`.

#### 1.3 Templates, properly

- The composer reads the selected template's body, extracts `{{n}}` placeholders,
  and renders one labelled input per variable into `cfg.variables`.
- `sendTemplateMessage` gains an optional header component so
  image/video/document-header templates can be sent. Body-only calls emit
  byte-identical payloads to today.
- `send_template` **stays a separate action.** It is the right step for a
  proactive re-engagement send where there is no in-window message to fall back
  from.

#### 1.4 The 24-hour window

`convex/lib/whatsapp/messagingWindow.ts` already provides exactly what is
needed — a pure, dependency-free `resolveWindowState` returning
`canSendFreeForm`, `csw.open`, `csw.expiresAt`, `csw.remainingMs`. It is reused
as-is; nothing about it is reimplemented.

A new internal query resolves the window for a contact's conversation. Then, per
send:

1. `canSendFreeForm` → send as composed.
2. Closed, `fallback` set → send the fallback template.
3. Closed, no fallback → fail the step with
   `"24h window closed and no fallback template configured"`, not a raw Meta 400.

Case 3 is a behaviour change: sends that fail today with an opaque Meta error
will fail with a legible one. That is the point.

Additionally, `session_window` joins `ConditionSubject` (operand `open` /
`closed`, same resolver) for operators who want the branch visible on the canvas
rather than buried in a step's config.

#### 1.5 Two bug fixes

- **`time_of_day` timezone.** No new config field. The condition reads the
  account's `qualificationConfigs.utcOffsetMinutes` — the exact source the
  `time_based` trigger already uses (`automationsEngine.ts:1045`), including its
  fallback to UTC for accounts with no qualification row, so `time_based` keeps
  working without the qualification feature enabled. This **is** a deliberate
  behaviour change for any account that has an offset configured: an
  `18:00-09:00` window starts meaning 18:00 local instead of 18:00 UTC. That is
  the fix, and it aligns the condition with the promise the trigger UI already
  prints ("in your account's local time",
  `automation-builder.tsx:877`).
- **`interactive-builder.tsx` layout.** Viewport `md:` breakpoints become
  container queries (`@container`), so the component adapts to its container
  rather than the window. Expanded step cards widen to ~520px. The fix is at the
  component, not the call site, so flows benefit too and no future embedding can
  reintroduce the collapse.

### Phase 2 — Make it observable

#### 2.1 `automationRuns`

One row per enrolled contact — the thing that does not exist today:

```ts
automationRuns: defineTable({
  accountId: v.id("accounts"),
  automationId: v.id("automations"),
  contactId: v.optional(v.id("contacts")),
  conversationId: v.optional(v.id("conversations")),
  status: v.union(
    v.literal("running"), v.literal("waiting"), v.literal("completed"),
    v.literal("failed"), v.literal("cancelled"),
  ),
  currentStepId: v.optional(v.id("automationSteps")),
  parentStepId: v.optional(v.id("automationSteps")),
  branch: v.optional(v.union(v.literal("yes"), v.literal("no"))),
  nextPosition: v.number(),
  resumeAt: v.optional(v.number()),
  scheduledFnId: v.optional(v.id("_scheduled_functions")),
  logId: v.optional(v.id("automationLogs")),
  context: v.optional(v.any()),
  startedAt: v.number(),
  updatedAt: v.number(),
  endedAt: v.optional(v.number()),
  errorMessage: v.optional(v.string()),
})
  .index("by_account_automation", ["accountId", "automationId"])
  .index("by_account_automation_status", ["accountId", "automationId", "status"])
  .index("by_account_status_resume", ["accountId", "status", "resumeAt"])
  .index("by_account_contact", ["accountId", "contactId"])
```

`accountId` leads every index so tenancy is enforced by the index rather than by
a post-scan `.filter()` — the convention already argued for `automationLogs` in
`schema.ts:1492`.

Storing `scheduledFnId` is what makes a wait cancellable. This mirrors
`flowRuns.fallbackTimeoutId` (`schema.ts:1625`), which already does exactly this
and is cancelled at `flowsEngine.ts:1197`.

#### 2.2 Cancellation

A waiting run is cancelled when:

- its automation is deactivated or deleted (today these resumes still fire),
- the contact is marked `doNotContact`,
- optionally, the contact replies — a new per-automation
  `stopOnReply` flag, **default off**.

`stopOnReply` earns its place: `Wait → Send → Wait → Send` is the most common
automation shape and, without it, a customer who has already answered keeps
receiving scheduled nags. Default-off means no existing automation changes
behaviour until someone opts in.

#### 2.3 `automationStepStats`

Cumulative per-step counters (`reached`, `sent`, `failed`) keyed by
`(automationId, stepId)`, incremented where `appendLogResults` already writes.
Kept out of `automationSteps` so execution traffic never contends with the
definition rows.

"Waiting at this step" needs no counter — it is a live index read against
`automationRuns` on `status = "waiting"` grouped by `currentStepId`.

#### 2.4 Where the numbers appear

- **List page** — per automation: enrolled · waiting · sent · failed, replacing
  the bare run count.
- **Canvas** — a chip per step: `142 reached · 18 waiting · 3 failed`.
- **Logs page** — a summary bar, plus a new **Waiting** tab listing queued
  contacts with a countdown to `resumeAt` and a per-row cancel action.

### Phase 3 — Make it pleasant

- **Grouped, searchable add menu** with one-line descriptions:
  **Message** (Send message, Send template) ·
  **Contact** (Add tag, Remove tag, Update field, Create deal, Assign) ·
  **Flow** (Wait, Condition) ·
  **Advanced** (Send webhook, Close conversation).
- **Live WhatsApp-style preview** on every send step.
- **Inline validation** against Meta's limits — 3 buttons max, 20-char button
  titles, 1024-char body, 60-char list-row titles — surfaced while editing
  instead of at runtime.

## What is removed

`Send Buttons` and `Send List` leave the add menu, folded into the composer.
Their engine cases and stored steps remain. Nothing else is removed.

## Data flow

```
trigger fires
  └─ executeAutomation → creates automationRuns row (status: running)
       └─ per step:
            wait      → status: waiting, resumeAt, scheduledFnId; suspend
            condition → resolve (incl. session_window); recurse into branch
            send      → resolveWindowState(conversation)
                          open   → sendMedia | sendInteractive | sendText
                          closed → fallback template, or fail legibly
            other     → runDbStep (unchanged)
       └─ each step: append to automationLogs, bump automationStepStats
  └─ terminal → status: completed | failed; endedAt set

cancel path (deactivate | delete | doNotContact | stopOnReply)
  └─ scheduler.cancel(scheduledFnId) → status: cancelled
```

## Testing

Following the repo convention that a module's `*.test.ts` is its specification:

- **Pure units, no ctx** — send-transport selection from a config, covering every
  row of §1.2's table in order (audio-with-text splits, audio-without-text does
  not, media beats interactive, empty config falls through to text); `{{n}}`
  extraction and numeric ordering past `{{9}}`; `session_window` condition
  resolution; `time_of_day` across offsets and over-midnight ranges.
- **Engine** — window open sends free-form; window closed sends the fallback;
  closed with no fallback fails with the specific message; a foreign `media_key`
  is rejected; a `note`-kind key is rejected.
- **Runs** — a wait persists `resumeAt` + `scheduledFnId`; resume clears them;
  each of the four cancel paths cancels the scheduled function and sets
  `cancelled`; a run nested in a condition branch resumes into that branch.
- **Back-compat** — a legacy `{ text }` config still sends; a stored
  `send_buttons` step still executes; a body-only template call produces a
  payload byte-identical to today's.
- **Counters** — `automationStepStats` increments once per step execution, and
  the waiting count matches the `automationRuns` index read.

## Risks

| Risk | Mitigation |
|---|---|
| Live automation breaks mid-edit | No schema union change and no data migration; old configs are valid new configs |
| Sends that "worked" now fail | They were already failing at Meta post-window; the change is a legible error instead of an opaque one. Surfaced in the logs page |
| `scheduler.cancel` on an already-run function | Convex tolerates this; `flowsEngine.ts:1429` documents the same case |
| Counter drift on partial failures | Counters increment where `appendLogResults` already writes, inside the same transaction |
| Phase 2 is the bulk of the work | It is independent of Phase 1 — Phase 1 alone fixes every defect on the live automation's path |

## Sequencing

Phase 1 → Phase 2 → Phase 3, each independently shippable and reviewable.
Phase 1 resolves findings 2–7. Phase 2 resolves finding 8. Phase 3 resolves
finding 1.
