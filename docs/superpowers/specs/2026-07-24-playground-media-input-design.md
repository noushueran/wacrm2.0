# Playground media input — voice notes & images

**Date:** 2026-07-24
**Surface:** `/agents` → Playground tab (`src/components/agents/ai-playground.tsx` + `convex/aiReply.ts`'s `playground` action)
**Status:** Approved design, ready for implementation planning

## Problem

The AI agent Playground lets an admin test the bot as if they were a customer, but
it only accepts **text**. Real customers also send **voice notes** (often Malayalam)
and **images** (passports, tickets, screenshots). Today there is no way to test how
the agent responds to those without sending a real WhatsApp message to the live
number. We want to add voice-note and image sending to the Playground so the agent's
media handling can be tested in place.

## Key architectural fact (why the naive approach is wrong)

The production bot **never feeds raw media to the language model.** In
`aiReply.dispatchInbound`, an inbound voice note is transcribed with Whisper
(`transcribeAudioFromUrl`) and an inbound image is described by a vision model
(`describeImageFromUrl`); the resulting **text** is stored as `messages.aiTranscription`
and rendered by `toChatMessages` as `"[voice note] <transcript>"` /
`"[image] <caption> — <description>"`. Only that text reaches the model, which always
replies in text (owner rule: the bot "listens" and "reads", then answers in text; it
never sends media back — see `amani-bot-philosophy`).

Therefore a faithful Playground test must run **the same transcribe/describe step** and
feed the model the **same placeholder text**. Sending the raw image/audio to a model a
different way would test something the real bot never does.

The Playground already "runs the real auto-reply path minus adContext and minus
qualification steering" (`amani-agent-config-state`). Media understanding currently
lives only in `dispatchInbound`, not in the `playground` action — this change adds it to
the Playground so the two paths match.

## Decisions (locked)

1. **Voice input:** record in the browser only (mic → record → stop → send). No file
   upload for audio. (Chrome records `audio/webm;codecs=opus`; Safari `audio/mp4`;
   Firefox `audio/ogg` — Whisper accepts all.)
2. **Image input:** file picker (`accept="image/*"`), upload from device.
3. **Display:** show what the bot understood **and** the reply. Under a voice note,
   show the Whisper transcript ("Heard: …"); under an image, the vision description
   ("Bot saw: …"); then the bot's reply bubble.

## Chosen approach: R2 upload (production-faithful)

The production media helpers take a **fetchable URL**. A browser blob is not fetchable
by the Convex backend, so media must land where the server can `fetch()` it. We reuse
the app's existing R2 media pipeline — the exact path a real WhatsApp voice note/image
takes — rather than inventing a new transport.

Rejected alternatives:
- **Inline bytes in the action args** — diverges from the production helpers, risks
  Convex-runtime `fetch(data:)` incompatibility and argument-size limits.
- **Send the raw image to a vision model in-chat** — not faithful; the real bot does
  not do this.

## Design

### 1. Client — UI (`ai-playground.tsx`)

Add two icon buttons to the left of the textarea in the composer:

- **Mic button.** Click starts recording via `MediaRecorder`; the button turns red and
  shows a running timer plus a cancel ✕. Click again to stop → a voice-note user turn is
  created and sent immediately (WhatsApp voice notes carry no caption). Requesting mic
  permission is handled on first use; a denial shows a toast and no turn is created.
- **Image button.** Click opens a file picker. On pick, the image is shown as a
  **thumbnail chip above the composer**; the user may type an optional caption in the
  existing textarea; Send (or Enter) dispatches the image + caption together. An ✕ on the
  chip clears the staged image. Only one staged image at a time.

Transcript rendering:
- A user **voice-note** turn renders an inline `<audio controls>` (using a local
  `URL.createObjectURL` preview) with a "Voice note" label. After the reply returns, a
  muted line beneath it reads `Heard: <transcript>` (or a "couldn't transcribe" hint).
- A user **image** turn renders the thumbnail (local object URL) + optional caption.
  After the reply, a muted line reads `Bot saw: <description>`.
- The assistant bubble is unchanged (reply text + existing handoff note).
- The existing "Thinking…" indicator gains a media-aware label while understanding runs
  ("Transcribing…" / "Reading image…"), then "Thinking…".

Local previews use `URL.createObjectURL(blob)` so the bubble keeps rendering for the whole
session **independently of R2** — the R2 object is transient and deleted right after
understanding. Object URLs are revoked on Reset and on unmount.

### 2. Client — data flow (per media send)

1. Record/pick → `Blob`; wrap as a `File` with a stable `type`; make a local object URL
   for the preview.
2. `uploadAccountMedia(convex, startUpload, file, "inbound")` → `{ key }`. (R2 kind is
   the storage prefix; `"inbound"` denotes a simulated customer message. Content type and
   extension are derived by `buildMediaKey` from `file.type`.)
3. Call `playground({ messages: [...priorTurns, { role: "user", content: caption ?? "",
   media: { kind, key } }] })`, where `kind` is `"audio" | "image"`.
4. On success: store the returned `understanding.transcription` and
   `understanding.historyContent` on that turn; render "Heard/saw …". Then
   `deleteAccountMedia(convex, key)` fire-and-forget (the existing GC pattern for
   staged-but-unsent media). Clear the turn's live `key`.
5. On **subsequent** sends, replay that turn as **plain text** using the stored
   `historyContent` (`{ role: "user", content: historyContent }`, no `media`) so nothing
   is transcribed twice and the model sees byte-identical history.

Client size limits reuse `MEDIA_MAX_BYTES_BY_KIND` (image 5 MB). Recording length is
soft-capped (e.g. auto-stop at 60 s) to bound Whisper cost.

### 3. Server — `playground` action (`convex/aiReply.ts`)

Extend the `messages` arg so a `user` turn may optionally carry
`media: { kind: v.union(v.literal("audio"), v.literal("image")), key: v.string() }`.

Per turn:
- **No media** → treated exactly as today (`{ role, content }`).
- **Has media** →
  1. Verify ownership: `parseMediaKey(key)?.accountId === accountId`, else return a
     domain error (do not throw) — same non-leaky discipline as `files.remove`.
  2. Resolve the URL: `resolveMediaUrlLazy(r2ConfigFromEnv, { key })`.
  3. Select the OpenAI key exactly as `dispatchInbound` does:
     `config.provider === "openai" ? config.apiKey : (config.embeddingsApiKey ?? null)`.
     If null → skip understanding (transcription `null`), degrade to the bare placeholder
     — same as production keeping the placeholder.
  4. Understand: audio → `transcribeAudioFromUrl({ apiKey, mediaUrl })`; image →
     `describeImageFromUrl({ apiKey, model: config.provider === "openai" ? config.model :
     DESCRIBE_FALLBACK_MODEL, mediaUrl, caption })`.
  5. Build the history line by **reusing `toChatMessages`** on a synthetic
     `HistoryMessage { senderType: "customer", contentType: kind, contentText: caption,
     transcription }` so the string is identical to production (`"[voice note] …"` /
     `"[image] …"`).

The action then runs the **existing** path unchanged (KB retrieval, `buildSystemPrompt`
with `mode: "auto_reply"`, `generateReply`).

Return shape extends the current one:
`{ reply, handoff, understanding?: { transcription: string | null; historyContent: string } }`
on success; `{ error, code? }` unchanged for domain failures. `understanding` describes
the single media turn that carried a live key this call (the client only ever sends one).

No DRY-RUN branch. By deliberate existing design (`aiReply.test.ts:866-875`),
`playground`/`draft` never check `CONVEX_AI_DRY_RUN` — they always call the real helpers,
and tests stub `global.fetch`. Media understanding follows the same rule: it just calls
`transcribeAudioFromUrl`/`describeImageFromUrl`, and tests stub `fetch` (see Testing).

### 4. Production-code tweak — `transcribeAudioFromUrl` (`convex/lib/ai/media.ts`)

Today the Whisper multipart filename is hard-coded `voice-note.ogg` because WhatsApp
voice notes are always OGG/Opus. Browser recordings are webm/mp4/ogg, and Whisper keys
format detection on the filename extension. Change the helper to derive the extension from
the **fetched response `Content-Type`** via a small local map
(`audio/ogg`→ogg, `audio/webm`→webm, `audio/mp4`→m4a, `audio/mpeg`→mp3, `audio/wav`→wav),
**defaulting to `ogg`** so production (WhatsApp OGG) behavior is byte-for-byte unchanged.
This is the only production behavior change and is covered by a unit test.

### 5. Cleanup & security

- **Cleanup:** R2 objects are deleted immediately after the action returns
  (`deleteAccountMedia`, client-side, best-effort) — the Playground is stateless and
  persists no message rows, so an undeleted object would be an orphan.
- **Ownership:** keys are minted under the caller's account by `startUpload`; the action
  re-verifies `parseMediaKey(key).accountId === accountId` before resolving/fetching.
- **Role:** `playground` stays Admin+; `startUpload`/`remove` are Agent+, so an admin
  clears both floors.

## Components & boundaries

- `ai-playground.tsx` — UI + client media lifecycle (record, stage, preview, upload,
  call action, cleanup). One file; grows but stays cohesive. If recording logic gets
  large, extract a `useVoiceRecorder` hook.
- `convex/aiReply.ts` `playground` — media understanding + transcript assembly, delegating
  to existing helpers.
- `convex/lib/ai/media.ts` — content-type→extension derivation (pure, tested).
- Reused unchanged: `files.startUpload`/`remove`, `uploadAccountMedia`/`deleteAccountMedia`,
  `resolveMediaUrlLazy`, `toChatMessages`, `describeImageFromUrl`, `buildSystemPrompt`,
  `generateReply`, `aiKnowledge.retrieve`.

## Testing

- **`convex/aiReply.test.ts`** — new `playground` cases with an `audio` and an `image`
  media turn, following the existing playground pattern of stubbing `global.fetch`
  (`aiReply.test.ts:877-905`). The stub dispatches by endpoint/order: audio needs the R2
  download (GET the media URL → a blob), then `POST /audio/transcriptions` → `{ text }`,
  then `POST /chat/completions` → the reply; image needs `POST /chat/completions` twice
  (vision describe, then reply — distinguished by call order or the `image_url` in the
  body, since `describeImageFromUrl` does not itself download the image). Assert
  `understanding.historyContent` equals the `toChatMessages` rendering and that a reply is
  produced. Assert the account-ownership rejection for a foreign key.
- **`convex/lib/ai/media.test.ts`** (new or extended) — extension derivation: `audio/webm`
  → webm, unknown → ogg default, etc.
- **`convex/lib/ai/context.test.ts`** — already covers `toChatMessages` (reused as-is).
- **Live browser verification** — record a Malayalam voice note and an image against the
  live agent, confirm the transcript/description and reply. Note the browser-testing quirk
  in `amani-agent-config-state` (drive the textarea via the native value setter +
  `.click()` when keystrokes stop landing).

## Out of scope

- Audio file upload (voice is record-only, per decision).
- Video/document/location in the Playground.
- Persisting Playground transcripts or media.
- Any change to the production `dispatchInbound` media path (it already works).
