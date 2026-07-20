# Voice-note transcripts in the inbox — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the Whisper transcript under inbound voice notes in the inbox, so an agent can read what a customer said without playing the clip.

**Architecture:** The transcript already exists in `messages.aiTranscription` but never reaches the browser. Task 1 carries it through the projection layer (`Message` type + `toUiMessage`). Task 2 adds a small presentational component and renders it in the audio bubble.

**Tech Stack:** Next.js (see `AGENTS.md` — this is not the Next.js you may know), React, Tailwind, next-intl, Convex, vitest.

Spec: `docs/superpowers/specs/2026-07-19-voice-note-transcript-inbox-design.md`.

## Global Constraints

- **NEVER run `npx convex dev`, `npx convex deploy`, or `npx convex codegen`.** One live self-hosted Convex; all three push to PRODUCTION. **This change needs no Convex work at all** — `aiTranscription` already exists in the schema and is already populated.
- **No new dependency.** This repo has **no jsdom and no `@testing-library/react`**. The only component test (`src/components/ui/dropdown-menu-group-label.test.tsx`) uses `renderToStaticMarkup` from `react-dom/server`, and the design is shaped to suit that. Do not add a test library.
- **Voice notes only.** `case "image"` in `message-bubble.tsx` must not change. The same column holds gpt-4o-mini image descriptions, which stay hidden by explicit decision.
- **Additive and display-only.** A message with no `aiTranscription` must render byte-identically to today — that covers every outbound message, every text message, and all history.
- One locale file: `messages/en.json`. The bubble's namespace is `Inbox.bubble` (`message-bubble.tsx:392`).
- **Baselines measured on this branch (`feat/voice-transcript-inbox` @ 5979d03), 2026-07-19:** `npm test` → **1965 passed / 152 files**; `npm run lint` → **0 errors, 15 warnings**, all pre-existing. The lint gate is "no NEW findings". `npm install` has already been run in this worktree.

---

### Task 1: Carry the transcription through the projection layer

**Files:**
- Modify: `src/types/index.ts` (the `Message` interface, from `:321`)
- Modify: `src/lib/convex/adapters.ts` (`toUiMessage`, from `:338`)
- Create: `src/lib/convex/adapters.test.ts`

**Interfaces:**
- Produces: `Message.ai_transcription?: string`, populated by `toUiMessage`. Task 2 consumes it.

- [ ] **Step 1: Write the failing test**

Create `src/lib/convex/adapters.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { toUiMessage } from "./adapters";
import type { Doc } from "../../../convex/_generated/dataModel";

/**
 * `messages.aiTranscription` is written for every inbound voice note
 * (Whisper) and image (vision), but had NO reader under `src/` — the
 * projection layer simply dropped it, so no component could ever show
 * it. These pin that it now survives the trip to the client.
 */
function messageDoc(over: Partial<Doc<"messages">> = {}): Doc<"messages"> {
  return {
    _id: "m1" as Doc<"messages">["_id"],
    _creationTime: 1_700_000_000_000,
    accountId: "a1" as Doc<"messages">["accountId"],
    conversationId: "c1" as Doc<"messages">["conversationId"],
    senderType: "contact",
    contentType: "audio",
    status: "delivered",
    ...over,
  } as Doc<"messages">;
}

describe("toUiMessage carries the AI transcription", () => {
  it("maps aiTranscription to ai_transcription", () => {
    const ui = toUiMessage(messageDoc({ aiTranscription: "Hello, I want a Dubai package." }));
    expect(ui.ai_transcription).toBe("Hello, I want a Dubai package.");
  });

  it("leaves ai_transcription undefined when the document has none", () => {
    expect(toUiMessage(messageDoc()).ai_transcription).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/convex/adapters.test.ts`
Expected: FAIL — `ai_transcription` does not exist on `Message`, so this is a type error and the first assertion receives `undefined`.

- [ ] **Step 3: Add the field to the `Message` interface**

In `src/types/index.ts`, inside `export interface Message {` (starts `:321`), add after `content_text?: string;`:

```ts
  /**
   * Whisper's transcript of an inbound voice note, or gpt-4o-mini's
   * description of an inbound image — both written to
   * `messages.aiTranscription` by the assistant's media pipeline
   * (`convex/aiReply.ts`). The inbox renders it for AUDIO only; image
   * descriptions stay hidden by design (they describe a picture the
   * agent can already see).
   */
  ai_transcription?: string;
```

- [ ] **Step 4: Map it in `toUiMessage`**

In `src/lib/convex/adapters.ts`, inside `toUiMessage` (from `:338`), add immediately after the `content_text: doc.contentText,` line:

```ts
    ai_transcription: doc.aiTranscription,
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run src/lib/convex/adapters.test.ts && npx tsc --noEmit`
Expected: PASS, tsc clean.

- [ ] **Step 6: Commit**

```bash
git add src/types/index.ts src/lib/convex/adapters.ts src/lib/convex/adapters.test.ts
git commit -m "feat(inbox): carry the AI transcription through to the client"
```

---

### Task 2: Render the transcript under the voice-note player

**Files:**
- Create: `src/components/inbox/voice-transcript.tsx`
- Create: `src/components/inbox/voice-transcript.test.tsx`
- Modify: `src/components/inbox/message-bubble.tsx` (`case "audio"`, from `:186`)
- Modify: `messages/en.json` (four keys under `Inbox.bubble`)

**Interfaces:**
- Consumes: `Message.ai_transcription` from Task 1.
- Produces: `VoiceTranscript({ text, label, labelTitle, moreLabel, lessLabel })`.

- [ ] **Step 1: Write the failing test**

Create `src/components/inbox/voice-transcript.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { VoiceTranscript } from "./voice-transcript";

/**
 * Static-render tests, matching this repo's only other component test
 * (`src/components/ui/dropdown-menu-group-label.test.tsx`) — there is
 * no jsdom and no Testing Library here.
 *
 * These are not a formality. `line-clamp` is CSS-only, so the FULL
 * transcript is always present in the DOM regardless of collapse
 * state; asserting on the markup therefore verifies the text was
 * genuinely delivered to the browser, which is the bug being fixed.
 * The expand/collapse interaction itself is not reachable without a
 * DOM and is verified in the browser instead.
 */
const LONG = "I would like to book a family holiday to Dubai in December. ".repeat(6);

function render(props: Partial<React.ComponentProps<typeof VoiceTranscript>> = {}) {
  return renderToStaticMarkup(
    React.createElement(VoiceTranscript, {
      text: "Hello, I want a Dubai package.",
      label: "AI transcript",
      labelTitle: "Transcribed automatically from the voice note",
      moreLabel: "Show more",
      lessLabel: "Show less",
      ...props,
    }),
  );
}

describe("VoiceTranscript", () => {
  it("renders the transcript text", () => {
    expect(render()).toContain("Hello, I want a Dubai package.");
  });

  it("marks the text as machine-generated", () => {
    const html = render();
    expect(html).toContain("AI transcript");
    expect(html).toContain("Transcribed automatically from the voice note");
  });

  it("delivers the WHOLE transcript even when collapsed", () => {
    // the tail of a long transcript, i.e. past the 3-line clamp
    expect(render({ text: LONG })).toContain("in December.");
  });

  it("offers an expand toggle only when the text can actually overflow", () => {
    expect(render({ text: LONG })).toContain("Show more");
    expect(render({ text: "Yes please." })).not.toContain("Show more");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/components/inbox/voice-transcript.test.tsx`
Expected: FAIL — `./voice-transcript` does not exist.

- [ ] **Step 3: Create the component**

Create `src/components/inbox/voice-transcript.tsx`:

```tsx
"use client";

import { useState } from "react";
import { Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Below this many characters a transcript cannot fill three clamped
 * lines at the bubble's width, so a toggle would be pure noise.
 *
 * A character count is a deliberate approximation: measuring real
 * overflow needs `scrollHeight` from a live DOM, and this repo has no
 * jsdom to test that with. Being slightly wrong here costs a visible
 * "Show more" that expands to nothing — cheap, and testable as a pure
 * function of the text.
 */
const OVERFLOW_THRESHOLD = 180;

interface VoiceTranscriptProps {
  /** The transcript itself. Callers guard against empty strings. */
  text: string;
  /**
   * Already-translated strings. This component deliberately takes no
   * i18n context so it can be rendered in a test without a NextIntl
   * provider — see the note in its test file.
   */
  label: string;
  labelTitle: string;
  moreLabel: string;
  lessLabel: string;
}

/**
 * Whisper's transcript of an inbound voice note, shown under the
 * player so a thread can be read rather than listened to.
 *
 * Collapsed to three lines by default so a long note cannot swamp the
 * conversation. Marked as machine-generated on purpose: Whisper
 * mis-hears, and this text must never read as verbatim customer
 * speech.
 */
export function VoiceTranscript({
  text,
  label,
  labelTitle,
  moreLabel,
  lessLabel,
}: VoiceTranscriptProps) {
  const [expanded, setExpanded] = useState(false);
  const canOverflow = text.length > OVERFLOW_THRESHOLD;

  return (
    <div className="mt-1.5 border-t border-current/10 pt-1.5">
      <span
        className="inline-flex items-center gap-0.5 text-[9px] font-semibold uppercase leading-none tracking-wide opacity-70"
        title={labelTitle}
      >
        <Sparkles className="h-2.5 w-2.5" />
        {label}
      </span>
      <p
        className={cn(
          "mt-1 whitespace-pre-wrap text-xs opacity-80",
          canOverflow && !expanded && "line-clamp-3",
        )}
      >
        {text}
      </p>
      {canOverflow && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-0.5 text-[10px] underline opacity-70 hover:opacity-100"
        >
          {expanded ? lessLabel : moreLabel}
        </button>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run the component tests**

Run: `npx vitest run src/components/inbox/voice-transcript.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 5: Add the i18n keys**

In `messages/en.json`, inside the `Inbox.bubble` object (it already holds `aiBadge` / `aiBadgeTitle`), add:

```json
    "aiTranscript": "AI transcript",
    "aiTranscriptTitle": "Transcribed automatically from the voice note — may contain errors",
    "transcriptShowMore": "Show more",
    "transcriptShowLess": "Show less",
```

- [ ] **Step 6: Render it in the audio bubble**

In `src/components/inbox/message-bubble.tsx`, add the import beside the other local component imports (near `import { ReplyQuote } from "./reply-quote";`):

```tsx
import { VoiceTranscript } from "./voice-transcript";
```

Then replace the whole `case "audio":` block (from `:186`) with:

```tsx
    case "audio":
      return (
        <div>
          {message.media_url ? (
            <audio src={message.media_url} controls className="max-w-60" />
          ) : (
            <MediaUnavailable label={t("audio")} t={t} />
          )}
          {/* Whisper already transcribed this on the way in (see
              `convex/aiReply.ts`); until now only the bot could read
              it. Audio only — the same column holds image
              descriptions, which stay hidden by design. */}
          {message.ai_transcription && (
            <VoiceTranscript
              text={message.ai_transcription}
              label={t("aiTranscript")}
              labelTitle={t("aiTranscriptTitle")}
              moreLabel={t("transcriptShowMore")}
              lessLabel={t("transcriptShowLess")}
            />
          )}
        </div>
      );
```

- [ ] **Step 7: Run the full gate**

```bash
npm test
npx tsc --noEmit
npm run build
npm run lint 2>&1 | tail -5
```

Expected: **1971 tests passing** (the 1965 baseline + 2 adapter + 4 component tests), tsc clean, Next build green, lint **0 errors / 15 warnings** — the pre-existing baseline — with none in the new or changed files.

- [ ] **Step 8: Verify in the browser**

The expand/collapse interaction is not unit-testable here, so prove it by driving the app. Start the dev server via the preview tooling (never `npm run dev` in a bash call), open a conversation containing an inbound voice note, and confirm: the transcript renders under the player, is marked as AI, clamps to three lines when long, and expands and re-collapses on click. Capture a screenshot as evidence.

If no conversation in the dev data has a voice note with a transcription, seed one rather than skipping this step — and say so in the report.

- [ ] **Step 9: Commit**

```bash
git add src/components/inbox/voice-transcript.tsx src/components/inbox/voice-transcript.test.tsx \
  src/components/inbox/message-bubble.tsx messages/en.json
git commit -m "feat(inbox): show the AI transcript under inbound voice notes"
```

---

## Deploy runbook (owner-gated — do NOT run during implementation)

1. `git fetch origin && git merge origin/main`, then re-run the Task 2 gate. Check `gh pr list --state merged --limit 5` for surprises (deploy-collision lesson, 2026-07-18).
2. **No `convex deploy` is required** — this change adds no backend functions and no schema fields. Merging to `main` and letting Netlify rebuild is the whole deployment.
3. The change is visible immediately for any voice note received since the transcription feature shipped. Older messages have an empty column and render exactly as before.
4. Rollback is a plain revert; nothing is persisted and no data is written by this feature.
