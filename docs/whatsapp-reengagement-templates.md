# Re-engagement templates for the cold stock

Date: 2026-08-09
Status: drafted, awaiting submission to Meta

## Why these exist

1,593 of 1,767 conversations (90%) sit outside Meta's 24-hour customer-service
window. Outside it, only an **approved template** may be sent. The account has
exactly one approved template — `hello_world`, whose body is Meta's own sample
text — so today those leads are unreachable.

These five templates make them reachable. Each one has a single job: **earn a
reply.** A reply reopens the 24-hour window, and from that moment the Reply agent
and your salespeople can speak freely. Nothing here tries to close a sale.

## Constraints these are written to

- **Body-only, no header, no buttons.** `sendTemplateMessage`
  (`convex/lib/whatsapp/metaApi.ts`) builds only a `body` component — the
  media-header builder was never ported. A template with a header cannot be sent
  by this codebase even once Meta approves it.
- **Category: Marketing.** Re-engagement is promotional. Submitting it as Utility
  gets rejected, and repeated miscategorisation damages account standing.
- **No variable may open or close the body, and no two may sit adjacent** — Meta
  rejects on all three.
- **No invented prices, discounts, availability, or commitments.** Nothing here
  states a commercial fact the business has not agreed.
- Language `en_US`, matching the existing `hello_world` row.

## The templates

Volumes are the tag counts as of 2026-08-01, so they show which are worth
submitting first.

### 1. `revive_uae_visa` — ~696 leads

**Category:** Marketing · **Language:** en_US

> Hi {{1}}, this is Amani Travel in Dubai. You asked us about a UAE visa a while
> back and we never got to finish. Are you still planning the trip? Reply here
> and we'll pick up where we left off.

**Footer:** Tell us to stop and we won't message again.
**Sample values:** `{{1}}` = Ravi

### 2. `revive_visa_change` — ~295 leads

**Category:** Marketing · **Language:** en_US

> Hi {{1}}, Amani Travel here in Dubai. You were asking about changing your visa
> status inside the UAE. The rules and timelines move around a lot, so if you're
> still considering it, reply and we'll tell you where things stand now.

**Footer:** Tell us to stop and we won't message again.
**Sample values:** `{{1}}` = Ravi

### 3. `revive_holiday_package` — ~224 leads

**Category:** Marketing · **Language:** en_US

> Hi {{1}}, this is Amani Travel in Dubai. You were looking at a holiday to
> {{2}} with us. If that plan is still alive, reply with your rough dates and
> we'll put fresh options together for you.

**Footer:** Tell us to stop and we won't message again.
**Sample values:** `{{1}}` = Ravi, `{{2}}` = Baku

Two variables, neither at an edge and not adjacent. `{{2}}` comes from
`contacts.preferredDestination`; **do not send this template to a contact whose
destination is empty** — a blank slot reads as broken and Meta counts the
complaint against you. Use `revive_general` for those.

### 4. `revive_freelance_visa` — ~201 leads

**Category:** Marketing · **Language:** en_US

> Hi {{1}}, Amani Travel here in Dubai. You enquired about a freelance visa in
> the UAE. If you're still weighing it up, reply and we'll walk you through what
> it takes at the moment.

**Footer:** Tell us to stop and we won't message again.
**Sample values:** `{{1}}` = Ravi

### 5. `revive_general` — everyone else

**Category:** Marketing · **Language:** en_US

> Hi {{1}}, this is Amani Travel in Dubai. We were helping you with a travel plan
> a while ago and the conversation went quiet. If you're still thinking about it,
> just reply and we'll take it from there.

**Footer:** Tell us to stop and we won't message again.
**Sample values:** `{{1}}` = Ravi

## Why the copy reads the way it does

**It names the business in the first line.** These people last spoke to you weeks
ago, from a number they never saved. An unidentified message is a block.

**It says what they asked about.** "Just checking in" is the message everyone
ignores. "You asked about a UAE visa" proves this is a real thread, not a blast —
which is also the honest description of what it is.

**It asks one question they can answer in three words.** The template's only job
is to get any reply at all; the conversation itself happens afterwards, in free
text, where the agent is far better.

**It offers a way out.** The footer costs one line and buys a lower block rate.
Blocks and reports drive your quality rating, and a damaged rating cuts your
messaging limits across the whole number — a far bigger loss than a few
unsubscribes.

## Before you send any of these — read this

**Broadcasts do not honour a bot-detected opt-out.** `convex/broadcasts.ts`
checks `blockedReason(contact)`, which reads only `contacts.doNotContact` — a
field set exclusively by a human writing a note. When a customer tells the bot to
stop, the qualification engine sets the session to `opted_out` and
`conversation.aiAutoreplyDisabled` instead, and **neither is checked by
broadcasts**. Six contacts in production are in that state today.

This is pre-existing and separate from the Revival agent, where the same gap was
fixed on 2026-08-09.

**FIXED 2026-08-09** on branch `fix/revival-respect-opt-out`. All three broadcast
gate sites (`create`, `createInternal`, `deliverOne`) now also consult
`optedOutReason` from `convex/lib/notes/gate.ts`, which reads
`qualificationSessions.status`. Not yet deployed — the fix must ship before the
first broadcast.

One trap found while fixing it, recorded so nobody re-introduces it:
`conversations.aiAutoreplyDisabled` looks like an opt-out flag and **is not**. It
is written by three unrelated paths — an agent pausing AI to take a thread over,
a staff-initiated outbound thread, and a genuine opt-out — so gating on it would
silently drop every human-handled lead from broadcasts, which are the most
engaged leads there are. `qualificationSessions.status === "opted_out"` is the
only trustworthy signal.

**Do not send all five at once.** Submit them, then send the smallest segment
first and watch the reply and block rates for a day. A 1,593-message blast from a
number that has never sent marketing before is exactly the pattern that triggers
a quality-rating drop.

## Wiring one of these in afterwards

`qualificationConfigs.reengagementTemplateName` is still set to `hello_world`,
which is why the qualification engine's own re-engagement path has never sent
anything useful. Once `revive_general` is approved, point that field at it —
the follow-up ladder starts working with no code change.

## Manglish variants

Deliberately not drafted here. Manglish is Malayalam in Latin script, and Meta has
no locale for it: submitted under `ml` it fails the script check, and under
`en_US` it collides with the English template of the same name. It needs separate
template names (`revive_uae_visa_ml_latin`), and the copy should be written or
reviewed by a native speaker rather than by me — a stiff or slightly wrong
register reads worse than plain English to the audience it is meant to warm up.

Worth doing once the English set is approved and you can see whether the reply
rate justifies it.
