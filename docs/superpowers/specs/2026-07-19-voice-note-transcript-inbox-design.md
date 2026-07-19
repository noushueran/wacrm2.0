# Voice-note transcripts in the inbox — design

**Date:** 2026-07-19
**Status:** approved, implementation plan pending
**Branch:** `feat/voice-transcript-inbox` (from `origin/main` @ 5979d03)

## Problem

Every inbound voice note is transcribed by Whisper and every inbound image is
described by gpt-4o-mini. Both land in `messages.aiTranscription`
(`convex/schema.ts:323`), written by `convex/aiReply.ts:437`.

**No human ever sees any of it.** `aiTranscription` has zero readers under
`src/` — verified against `origin/main`. It is read only by
`convex/lib/ai/context.ts` when assembling the assistant's prompt. The account
pays for transcription on every voice note, and the only consumer is the bot.

The cost falls on agents: to learn what a customer said, an agent must play the
clip. A thread with several voice notes cannot be skimmed, caught up on at a
glance, or read in a noisy room — even though the text already exists in the
database.

This was the top item of the 2026-07-19 AI-opportunity audit's "plumb what's
already bought" recommendation: value available with **no new model calls**.

### Why it is not merely a rendering fix

The transcription never reaches the browser. The client-facing `Message` type
(`src/types/index.ts:321`) has no transcription field, and `toUiMessage`
(`src/lib/convex/adapters.ts:338`) does not map it. The projection layer must
carry it before any component can render it.

## Scope

**Voice notes only.** The same column holds two different kinds of content: for
audio it is a *transcript* — the words the customer actually said, which the
agent cannot otherwise obtain without playing the clip. For images it is a
*description* of a picture the agent can already see, which is largely
redundant and would put AI-written prose under every image in the thread.
Image descriptions stay hidden; the data continues to be written and continues
to feed the assistant.

## Design

### Data path

| File | Change |
|---|---|
| `src/types/index.ts` | `Message` gains `ai_transcription?: string` |
| `src/lib/convex/adapters.ts` | `toUiMessage` maps `doc.aiTranscription` |
| `messages/en.json` | three keys under `Inbox.bubble` (label, show-more, show-less) |

There is **one** locale file, `messages/en.json`; the bubble's namespace is
`Inbox.bubble` (`message-bubble.tsx:392`).

No Convex function changes, no schema change, no migration, no new dependency.
The column already exists and is already populated.

### New component

`src/components/inbox/voice-transcript.tsx` — purely presentational:

```
{ text: string; label: string; moreLabel: string; lessLabel: string }
```

Renders a `Sparkles` marker, the label, and the transcript text: `line-clamp-3`
when collapsed, with a toggle to expand and re-collapse.

**Why a separate component rather than inline JSX in the bubble.**
`message-bubble.tsx` is a client component that calls `useTranslations`, so
rendering it in a test would require a NextIntl provider. A component that
receives already-translated strings needs no context, no data, and no provider
— it is directly testable with the tooling this repo actually has (see
Testing). The bubble passes `t(...)` down.

### Integration

`message-bubble.tsx`, `case "audio"` (`:186`): after the existing `<audio>`
element, render `<VoiceTranscript>` when `message.ai_transcription` is present.
`case "image"` is untouched.

### Presentation

Collapsed to three lines by default, expandable. An agent scanning the thread
gets the gist without pressing play — the entire point — while a long voice
note cannot swamp the conversation.

The transcript is explicitly marked as machine-generated and styled muted. This
is not decoration: Whisper mis-hears, and "not three adults, two" transcribed
wrongly and acted on as the customer's own words is a real error path. It must
never read as verbatim customer speech.

**Follow the marker convention that already exists** rather than inventing one:
`message-bubble.tsx:435-438` already badges AI-authored messages with a
`Sparkles` icon plus `t("aiBadge")` ("AI") and a `title` of
`t("aiBadgeTitle")`. The transcript marker mirrors that pairing — same icon,
same muted treatment, its own label and hover title, since the claim being made
is different ("this text was transcribed by AI" rather than "this message was
sent by AI").

## Testing

This repo has **no jsdom and no `@testing-library/react`**. The one existing
component test (`src/components/ui/dropdown-menu-group-label.test.tsx`) uses
`renderToStaticMarkup` from `react-dom/server`. The design is shaped to suit
that constraint rather than to require new test infrastructure.

- **New** `src/components/inbox/voice-transcript.test.tsx` — the full transcript
  text appears in the rendered markup, the AI label appears, and long text does
  not throw. This is a real assertion rather than a formality: `line-clamp` is
  CSS-only, so the complete text is always in the DOM, and the test therefore
  verifies the transcript was genuinely delivered — not just its first lines.
- **New** `src/lib/convex/adapters.test.ts` — `toUiMessage` carries
  `aiTranscription` through as `ai_transcription`, and omits it when the source
  document has none. This file has no tests today.

**Known gap, stated rather than papered over:** the expand/collapse interaction
cannot be unit-tested without adding jsdom or Testing Library, which is not
worth bundling into this change. It will be verified in the browser preview and
evidenced with a screenshot.

## Deliberate omissions

- **No image descriptions.** See Scope.
- **No search over transcripts.** Making them visible is the prerequisite;
  indexing them is a separate change with its own cost.
- **No re-transcription or editing.** The transcript is an artifact of the
  assistant's pipeline, not a document the agent owns.
- **No backfill concern.** Messages predating the transcription feature simply
  have no value in the column and render exactly as they do today.

## Risk

Low. The change is additive and display-only: a message with no
`aiTranscription` renders byte-identically to today, which covers every
outbound message, every text message, and all history. The worst failure mode
is a visual regression in the audio bubble, which the browser check covers.
