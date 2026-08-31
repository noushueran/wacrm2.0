# Playground Media Input (Voice Notes & Images) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the `/agents` Playground send **recorded voice notes** and **uploaded images**, run them through the same Whisper-transcribe / vision-describe step the production auto-reply bot uses, and show both what the bot understood and its text reply.

**Architecture:** The browser records/picks media → uploads to R2 via the existing `files.startUpload` pipeline → the `playground` Convex action resolves the key, runs the **same** `transcribeAudioFromUrl` / `describeImageFromUrl` helpers with the **same** key/model selection production uses, renders the history line via the **same** `toChatMessages`, then runs the existing reply path. The transient R2 object is deleted right after. The model only ever sees text — exactly as in production.

**Tech Stack:** Next.js (App Router) + React client component, Convex actions, Cloudflare R2, OpenAI (Whisper + vision), vitest.

## Global Constraints

- **Faithfulness:** media understanding must reuse `transcribeAudioFromUrl`, `describeImageFromUrl`, `DESCRIBE_FALLBACK_MODEL` (`convex/lib/ai/media.ts`) and `toChatMessages` (`convex/lib/ai/context.ts`) — do not re-implement any of them.
- **OpenAI key selection (verbatim from `dispatchInbound`):** `config.provider === "openai" ? config.apiKey : (config.embeddingsApiKey ?? null)`. Null ⇒ skip understanding, keep the placeholder.
- **Vision model selection (verbatim):** `config.provider === "openai" ? config.model : DESCRIBE_FALLBACK_MODEL`.
- **Ownership:** any client-supplied media key must satisfy `parseMediaKey(key)?.accountId === accountId`, else return `{ error, code: "media_not_found" }` (never throw, never leak — same discipline as `files.remove`).
- **R2 upload kind** is the storage prefix `"inbound"` (simulated customer message), NOT the content type. Content kind (`"audio"|"image"`) is a separate field on the message.
- **Playground never uses `CONVEX_AI_DRY_RUN`** (see `convex/aiReply.test.ts:866-875`) — tests stub `global.fetch`.
- **`playground` stays Admin+**; role/auth logic in the action is unchanged.
- **Commit trailer:** every commit ends with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

## Before You Start

⚠️ `convex/aiReply.ts` and `convex/aiReply.test.ts` **already have uncommitted changes** in the working tree (pre-existing, unrelated to this plan). Tasks 2 modifies both files. Resolve the pre-existing changes first (commit, stash, or confirm they belong with this work) so your `git add` of those files does not sweep in unrelated WIP. Do this work on a feature branch (e.g. `git switch -c feat/playground-media`).

## File Structure

- **Modify** `convex/lib/ai/media.ts` — derive the Whisper upload filename from the media's content type (Task 1).
- **Create** `convex/lib/ai/media.test.ts` — unit-test the filename helper (Task 1).
- **Modify** `convex/aiReply.ts` — extend the `playground` action's `messages` arg + return shape; add the media-understanding loop (Task 2).
- **Modify** `convex/aiReply.test.ts` — playground media tests (Task 2).
- **Modify** `src/components/agents/ai-playground.tsx` — data model + `runTurn` refactor + media rendering (Task 3), image input (Task 4), voice recording (Task 5).

Client tasks (3–5) have no unit-test harness in this repo (React components are not unit-tested here); they are verified by `npm run typecheck`, `npm run lint`, and live browser checks.

---

### Task 1: Whisper upload filename from content type

**Files:**
- Modify: `convex/lib/ai/media.ts`
- Test: `convex/lib/ai/media.test.ts` (create)

**Interfaces:**
- Produces: `export function whisperUploadFilename(contentType: string | null): string`

**Why:** `transcribeAudioFromUrl` hard-codes `voice-note.ogg` (WhatsApp is always OGG). Chrome records `audio/webm`; Whisper keys format detection on the filename extension. Derive the extension from the fetched content type, defaulting to `ogg` so production behavior is unchanged.

- [ ] **Step 1: Write the failing test** — create `convex/lib/ai/media.test.ts`:

```ts
import { expect, test } from "vitest";
import { whisperUploadFilename } from "./media";

test("maps browser and WhatsApp audio content types to Whisper-friendly extensions", () => {
  expect(whisperUploadFilename("audio/webm;codecs=opus")).toBe("voice-note.webm");
  expect(whisperUploadFilename("audio/webm")).toBe("voice-note.webm");
  expect(whisperUploadFilename("audio/mp4")).toBe("voice-note.m4a");
  expect(whisperUploadFilename("audio/mpeg")).toBe("voice-note.mp3");
  expect(whisperUploadFilename("audio/ogg")).toBe("voice-note.ogg");
});

test("defaults to .ogg (WhatsApp's format) for unknown or missing content types", () => {
  expect(whisperUploadFilename(null)).toBe("voice-note.ogg");
  expect(whisperUploadFilename("")).toBe("voice-note.ogg");
  expect(whisperUploadFilename("application/octet-stream")).toBe("voice-note.ogg");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- convex/lib/ai/media.test.ts`
Expected: FAIL — `whisperUploadFilename` is not exported.

- [ ] **Step 3: Add the helper and wire it in.** In `convex/lib/ai/media.ts`, add after the `DESCRIBE_FALLBACK_MODEL` constant (around line 29):

```ts
/** OpenAI Whisper keys audio-format detection on the upload filename's
 *  extension. WhatsApp voice notes are always OGG/Opus, but browser
 *  recordings (the /agents Playground) arrive as webm/mp4, so derive the
 *  extension from the media's own content type. Defaults to `ogg` so the
 *  WhatsApp path is byte-for-byte unchanged. */
const WHISPER_EXT_BY_CONTENT_TYPE: Record<string, string> = {
  "audio/ogg": "ogg",
  "audio/webm": "webm",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
};

export function whisperUploadFilename(contentType: string | null): string {
  const base = contentType?.split(";")[0]?.trim().toLowerCase() ?? "";
  const ext = WHISPER_EXT_BY_CONTENT_TYPE[base] ?? "ogg";
  return `voice-note.${ext}`;
}
```

- [ ] **Step 4: Use it in `transcribeAudioFromUrl`.** Replace the blob + form-append block (currently lines ~44-50):

```ts
    if (!media.ok) return null;
    const blob = await media.blob();

    const form = new FormData();
    // WhatsApp voice notes are OGG/Opus; the filename extension is what
    // OpenAI keys the format detection on.
    form.append("file", blob, "voice-note.ogg");
    form.append("model", TRANSCRIBE_MODEL);
```

with:

```ts
    if (!media.ok) return null;
    const blob = await media.blob();

    const form = new FormData();
    // The filename extension is what OpenAI keys format detection on.
    // Prefer the response's own content type (WhatsApp OGG, browser webm),
    // falling back to the blob's, then to OGG.
    const contentType = media.headers.get("content-type") || blob.type || null;
    form.append("file", blob, whisperUploadFilename(contentType));
    form.append("model", TRANSCRIBE_MODEL);
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -- convex/lib/ai/media.test.ts`
Expected: PASS (both tests).

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add convex/lib/ai/media.ts convex/lib/ai/media.test.ts
git commit -m "feat(ai): derive Whisper upload filename from content type" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: `playground` action — media understanding

**Files:**
- Modify: `convex/aiReply.ts` (imports; `playgroundMessageValidator`; `PlaygroundResult`; the `playground` handler)
- Test: `convex/aiReply.test.ts`

**Interfaces:**
- Consumes: `parseMediaKey` (`convex/lib/r2/keys.ts`), `resolveMediaUrlLazy` + `r2ConfigFromEnv` (already imported), `transcribeAudioFromUrl`/`describeImageFromUrl`/`DESCRIBE_FALLBACK_MODEL` (already imported), `toChatMessages` (already imported), `ChatMessage` (`convex/lib/ai/types.ts`).
- Produces: `playground` now accepts `messages: { role, content, media?: { kind: "audio"|"image", key: string } }[]` and returns `{ reply, handoff, understanding?: { transcription: string | null, historyContent: string } } | { error, code? }`.

- [ ] **Step 1: Write the failing tests.** In `convex/aiReply.test.ts`, add after the existing playground tests (after the test at line ~906, before the `ai_not_configured` test or at the end of the playground block). Note `seedAccountMember` returns `{ asUser, accountId }` (see the `bob.accountId` usage elsewhere in the file):

```ts
test("playground rejects a media key from another account (never leaks)", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
  });
  await configureAi(asUser);

  const result = await asUser.action(api.aiReply.playground, {
    messages: [
      { role: "user", content: "", media: { kind: "audio", key: "other-account/inbound/x.webm" } },
    ],
  });

  expect(result).toEqual({
    error: "That attachment could not be found.",
    code: "media_not_found",
  });
});

test("playground transcribes a recorded voice note, then replies (mirrors auto-reply)", async () => {
  process.env.R2_BUCKET = "test-bucket";
  process.env.R2_ENDPOINT = "https://test.r2.cloudflarestorage.com";
  process.env.R2_ACCESS_KEY_ID = "test-key";
  process.env.R2_SECRET_ACCESS_KEY = "test-secret";
  process.env.R2_PUBLIC_HOST = "https://objs.amaniworld.com";
  try {
    const t = convexTest(schema, modules);
    const { asUser, accountId } = await seedAccountMember(t, {
      name: "Alice",
      email: "alice@example.com",
    });
    await configureAi(asUser);

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("objs.amaniworld.com")) {
          // R2 download inside transcribeAudioFromUrl
          return new Response(new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm" }), {
            status: 200,
            headers: { "content-type": "audio/webm" },
          });
        }
        if (url.includes("/audio/transcriptions")) {
          return new Response(JSON.stringify({ text: "Dubai visa venam" }), { status: 200 });
        }
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: "Sure — happy to help with a Dubai visa!" } }],
            usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
          }),
          { status: 200 },
        );
      }),
    );

    const result = await asUser.action(api.aiReply.playground, {
      messages: [
        { role: "user", content: "", media: { kind: "audio", key: `${accountId}/inbound/v.webm` } },
      ],
    });

    expect(result).toEqual({
      reply: "Sure — happy to help with a Dubai visa!",
      handoff: false,
      understanding: {
        transcription: "Dubai visa venam",
        historyContent: "[voice note] Dubai visa venam",
      },
    });
    vi.unstubAllGlobals();
  } finally {
    delete process.env.R2_BUCKET;
    delete process.env.R2_ENDPOINT;
    delete process.env.R2_ACCESS_KEY_ID;
    delete process.env.R2_SECRET_ACCESS_KEY;
    delete process.env.R2_PUBLIC_HOST;
  }
});

test("playground describes an image with its caption, then replies", async () => {
  process.env.R2_BUCKET = "test-bucket";
  process.env.R2_ENDPOINT = "https://test.r2.cloudflarestorage.com";
  process.env.R2_ACCESS_KEY_ID = "test-key";
  process.env.R2_SECRET_ACCESS_KEY = "test-secret";
  process.env.R2_PUBLIC_HOST = "https://objs.amaniworld.com";
  try {
    const t = convexTest(schema, modules);
    const { asUser, accountId } = await seedAccountMember(t, {
      name: "Alice",
      email: "alice@example.com",
    });
    await configureAi(asUser);

    let chatCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/chat/completions")) {
          chatCalls += 1;
          // 1st chat call = vision describe; 2nd = the reply.
          const content =
            chatCalls === 1
              ? "A UAE tourist visa document."
              : "Thanks — that looks like a valid UAE visa.";
          return new Response(
            JSON.stringify({
              choices: [{ message: { content } }],
              usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
            }),
            { status: 200 },
          );
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    const result = await asUser.action(api.aiReply.playground, {
      messages: [
        { role: "user", content: "is this valid?", media: { kind: "image", key: `${accountId}/inbound/p.jpg` } },
      ],
    });

    expect(result).toEqual({
      reply: "Thanks — that looks like a valid UAE visa.",
      handoff: false,
      understanding: {
        transcription: "A UAE tourist visa document.",
        historyContent: "[image] is this valid? — A UAE tourist visa document.",
      },
    });
    vi.unstubAllGlobals();
  } finally {
    delete process.env.R2_BUCKET;
    delete process.env.R2_ENDPOINT;
    delete process.env.R2_ACCESS_KEY_ID;
    delete process.env.R2_SECRET_ACCESS_KEY;
    delete process.env.R2_PUBLIC_HOST;
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- convex/aiReply.test.ts -t "playground"`
Expected: the three new tests FAIL (media not accepted by the validator / no `understanding` in the result).

- [ ] **Step 3: Add the `parseMediaKey` import + `ChatMessage` type.** In `convex/aiReply.ts`:

Change line 31 from:
```ts
import type { GenerateResult } from "./lib/ai/types";
```
to:
```ts
import type { GenerateResult, ChatMessage } from "./lib/ai/types";
```

And add after line 32 (`import { r2ConfigFromEnv } from "./lib/r2/config";`):
```ts
import { parseMediaKey } from "./lib/r2/keys";
```

- [ ] **Step 4: Extend the validator and result type.** Replace (around lines 1362-1371):

```ts
const playgroundMessageValidator = v.object({
  role: v.union(v.literal("user"), v.literal("assistant")),
  content: v.string(),
});

/** Matches `src/app/api/ai/playground/route.ts`'s JSON body exactly
 *  (`{reply, handoff}` on success; `{error, code?}` — never thrown —
 *  for the same domain failures the route itself returns as a body
 *  rather than raising). */
type PlaygroundResult = { reply: string; handoff: boolean } | { error: string; code?: string };
```

with:

```ts
const playgroundMessageValidator = v.object({
  role: v.union(v.literal("user"), v.literal("assistant")),
  content: v.string(),
  // A user turn may carry a recorded voice note / uploaded image as a live
  // R2 key for the server to transcribe/describe. The client replays
  // already-understood media turns as plain text (no `media`), so at most
  // one key is present per call.
  media: v.optional(
    v.object({
      kind: v.union(v.literal("audio"), v.literal("image")),
      key: v.string(),
    }),
  ),
});

/** `{reply, handoff}` on success (plus `understanding` when the newest turn
 *  carried media); `{error, code?}` — never thrown — for domain failures. */
type PlaygroundResult =
  | {
      reply: string;
      handoff: boolean;
      understanding?: { transcription: string | null; historyContent: string };
    }
  | { error: string; code?: string };
```

- [ ] **Step 5: Rewrite the handler's turn-processing block.** In the `playground` handler, replace this span (currently lines ~1417-1437, from the `const messages = ...` filter through `const queryText = latestUserMessage(messages);`):

```ts
    const messages = args.messages
      .filter((m) => m.content.trim().length > 0)
      .slice(-PLAYGROUND_MAX_TURNS);
    if (messages.length === 0) {
      return { error: "Send a message to test the agent." };
    }

    let config;
    try {
      config = await ctx.runQuery(internal.aiConfig.loadDecrypted, { accountId });
    } catch {
      return { error: "Stored API key could not be decrypted.", code: "key_decrypt_failed" };
    }
    if (!config) {
      return {
        error: "No agent configured yet. Add your provider key in Setup.",
        code: "ai_not_configured",
      };
    }

    const queryText = latestUserMessage(messages);
```

with:

```ts
    // Keep turns that carry text OR media; drop pure blanks; bound the
    // window. A media turn can legitimately have empty text (a voice note
    // with no caption), so it must survive the blank filter.
    const rawTurns = args.messages
      .filter((m) => m.content.trim().length > 0 || m.media !== undefined)
      .slice(-PLAYGROUND_MAX_TURNS);
    if (rawTurns.length === 0) {
      return { error: "Send a message to test the agent." };
    }

    let config;
    try {
      config = await ctx.runQuery(internal.aiConfig.loadDecrypted, { accountId });
    } catch {
      return { error: "Stored API key could not be decrypted.", code: "key_decrypt_failed" };
    }
    if (!config) {
      return {
        error: "No agent configured yet. Add your provider key in Setup.",
        code: "ai_not_configured",
      };
    }

    // Media understanding — the SAME transcribe/describe step
    // `dispatchInbound` runs, so the Playground exercises exactly what a
    // real WhatsApp voice note / image produces. Only turns carrying a live
    // R2 key are understood; already-understood media turns arrive as plain
    // text. Key/model selection and the rendered history line are identical
    // to production (`toChatMessages`), so the model sees the same string.
    const openAiKey =
      config.provider === "openai" ? config.apiKey : (config.embeddingsApiKey ?? null);
    let understanding: { transcription: string | null; historyContent: string } | undefined;
    const messages: ChatMessage[] = [];
    for (const turn of rawTurns) {
      if (!turn.media) {
        messages.push({ role: turn.role, content: turn.content });
        continue;
      }
      // Ownership: never resolve/fetch a key that isn't this account's —
      // same non-leaky NOT_FOUND treatment as `files.remove`.
      const owner = parseMediaKey(turn.media.key);
      if (!owner || owner.accountId !== accountId) {
        return { error: "That attachment could not be found.", code: "media_not_found" };
      }
      const caption = turn.content.trim() || undefined;
      let transcription: string | null = null;
      if (openAiKey) {
        const mediaUrl = resolveMediaUrlLazy(r2ConfigFromEnv, { key: turn.media.key });
        if (mediaUrl) {
          transcription =
            turn.media.kind === "audio"
              ? await transcribeAudioFromUrl({ apiKey: openAiKey, mediaUrl })
              : await describeImageFromUrl({
                  apiKey: openAiKey,
                  model:
                    config.provider === "openai" ? config.model : DESCRIBE_FALLBACK_MODEL,
                  mediaUrl,
                  caption,
                });
        }
      }
      // Reuse the production renderer so the string is byte-identical.
      const [rendered] = toChatMessages([
        {
          senderType: "customer",
          contentType: turn.media.kind,
          contentText: caption,
          transcription: transcription ?? undefined,
        },
      ]);
      const historyContent =
        rendered?.content ?? (turn.media.kind === "audio" ? "[voice note]" : "[image]");
      messages.push({ role: turn.role, content: historyContent });
      understanding = { transcription, historyContent };
    }
    if (messages.length === 0) {
      return { error: "Send a message to test the agent." };
    }

    const queryText = latestUserMessage(messages);
```

- [ ] **Step 6: Return `understanding`.** Change the success return (around line 1464) from:
```ts
      return { reply: text, handoff };
```
to:
```ts
      return { reply: text, handoff, understanding };
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npm test -- convex/aiReply.test.ts -t "playground"`
Expected: all playground tests PASS (existing + 3 new).

- [ ] **Step 8: Full check**

Run: `npm test -- convex/aiReply.test.ts && npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 9: Commit**

```bash
git add convex/aiReply.ts convex/aiReply.test.ts
git commit -m "feat(ai): understand voice notes & images in the agent playground" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Client — data model, `runTurn`, media rendering (text still works)

**Files:**
- Modify: `src/components/agents/ai-playground.tsx`

**Interfaces:**
- Consumes: `api.aiReply.playground` (now returns `understanding`), `api.files.startUpload`, `uploadAccountMedia`/`deleteAccountMedia` (`@/lib/storage/upload-media`).
- Produces: `runTurn(userTurn, liveMedia)` and `sendText()` used by Tasks 4–5; `Turn.media` shape.

This task refactors the send flow and adds the (currently unreachable) media rendering. **No mic/image buttons yet** — the deliverable is that the text playground works exactly as before, with the media plumbing in place.

- [ ] **Step 1: Replace the whole file** `src/components/agents/ai-playground.tsx` with:

```tsx
'use client';

import { useEffect, useRef, useState } from 'react';
import { useAction, useMutation, useConvex } from 'convex/react';
import { toast } from 'sonner';
import { Bot, RotateCcw, Send, Loader2, UserCircle2, ArrowRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { uploadAccountMedia, deleteAccountMedia } from '@/lib/storage/upload-media';

import { api } from '../../../convex/_generated/api';

/** A media attachment on a user turn. `previewUrl` is a LOCAL object URL
 *  (never the R2 URL), so the bubble keeps rendering after the transient R2
 *  object is deleted. `understanding` is what the bot heard/saw;
 *  `historyContent` is the exact `[voice note] …` / `[image] …` line the
 *  server built, replayed as plain text on later sends so nothing is
 *  transcribed twice. */
interface MediaAttachment {
  kind: 'audio' | 'image';
  previewUrl: string;
  understanding?: string;
  understoodFailed?: boolean;
  historyContent?: string;
}

interface Turn {
  role: 'user' | 'assistant';
  content: string;
  /** assistant-only: the agent signalled a human handoff on this turn. */
  handoff?: boolean;
  /** user-only: an attached voice note or image. */
  media?: MediaAttachment;
}

/** The message shape the `playground` action accepts. */
type PlaygroundMessage = {
  role: 'user' | 'assistant';
  content: string;
  media?: { kind: 'audio' | 'image'; key: string };
};

export function AiPlayground({ onGoToSetup }: { onGoToSetup?: () => void }) {
  const playground = useAction(api.aiReply.playground);
  const startUpload = useMutation(api.files.startUpload);
  const convex = useConvex();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  /** Every object URL we create, revoked on reset/unmount. */
  const objectUrlsRef = useRef<string[]>([]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [turns, sending]);

  // Revoke all local preview URLs on unmount.
  useEffect(() => {
    return () => {
      objectUrlsRef.current.forEach((u) => URL.revokeObjectURL(u));
      objectUrlsRef.current = [];
    };
  }, []);

  /**
   * Run one user turn: optimistically append it, send the full transcript
   * (replaying prior media turns as plain text; passing the new turn's live
   * R2 key if any), then append the reply and store what the bot understood.
   */
  const runTurn = async (
    userTurn: Turn,
    liveMedia: { kind: 'audio' | 'image'; key: string } | null,
  ) => {
    const priorTurns = turns;
    const nextTurns: Turn[] = [...priorTurns, userTurn];
    setTurns(nextTurns);
    setSending(true);
    try {
      const messages: PlaygroundMessage[] = nextTurns.map((t, i) => {
        const isNew = i === nextTurns.length - 1;
        if (isNew && liveMedia) {
          return { role: t.role, content: t.content, media: liveMedia };
        }
        if (t.media) {
          // Already-understood media turn → replay as plain text.
          return { role: t.role, content: t.media.historyContent ?? t.content };
        }
        return { role: t.role, content: t.content };
      });

      const data = await playground({ messages });
      if ('error' in data) {
        if (data.code === 'ai_not_configured') {
          toast.error('No agent configured yet — finish Setup first.');
        } else {
          toast.error(data.error ?? "Couldn't get a reply.");
        }
        setTurns(priorTurns);
        if (!userTurn.media) setInput(userTurn.content);
        return;
      }

      const understood = data.understanding;
      const committed: Turn[] = nextTurns.map((t, i) => {
        if (i === nextTurns.length - 1 && liveMedia && t.media) {
          return {
            ...t,
            media: {
              ...t.media,
              understanding: understood?.transcription ?? undefined,
              understoodFailed: understood ? understood.transcription === null : true,
              historyContent: understood?.historyContent,
            },
          };
        }
        return t;
      });
      setTurns([
        ...committed,
        {
          role: 'assistant',
          content: data.reply.trim() ? data.reply : '',
          handoff: Boolean(data.handoff),
        },
      ]);
    } catch {
      toast.error("Couldn't reach the agent.");
      setTurns(priorTurns);
      if (!userTurn.media) setInput(userTurn.content);
    } finally {
      setSending(false);
      // The R2 object was only needed for the server to understand it; its
      // text is now cached on the turn. Best-effort GC.
      if (liveMedia) void deleteAccountMedia(convex, liveMedia.key);
    }
  };

  const sendText = async () => {
    const text = input.trim();
    if (!text || sending) return;
    setInput('');
    await runTurn({ role: 'user', content: text }, null);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void sendText();
    }
  };

  const reset = () => {
    objectUrlsRef.current.forEach((u) => URL.revokeObjectURL(u));
    objectUrlsRef.current = [];
    setTurns([]);
  };

  return (
    <div className="flex h-[60vh] min-h-[420px] flex-col rounded-xl border border-border bg-card">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <Bot className="h-4 w-4 text-primary" />
          <span className="text-sm font-medium text-foreground">Playground</span>
          <span className="text-xs text-muted-foreground">
            — test replies as if you were a customer
          </span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={reset}
          disabled={turns.length === 0 || sending}
          className="text-muted-foreground"
        >
          <RotateCcw className="mr-1.5 h-3.5 w-3.5" /> Reset
        </Button>
      </div>

      {/* Transcript */}
      <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto p-4">
        {turns.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center text-center text-sm text-muted-foreground">
            <Bot className="mb-2 h-8 w-8 text-muted-foreground/60" />
            <p>Send a message to see how your agent would reply.</p>
            <p className="mt-1 text-xs">
              It uses your knowledge base and behaves exactly like the
              auto-reply bot — including handoff.
            </p>
            {onGoToSetup && (
              <Button
                variant="link"
                size="sm"
                onClick={onGoToSetup}
                className="mt-1 h-auto p-0 text-xs"
              >
                Not set up yet? Go to Setup <ArrowRight className="ml-1 h-3 w-3" />
              </Button>
            )}
          </div>
        )}

        {turns.map((t, i) => (
          <div
            key={i}
            className={cn(
              'flex gap-2',
              t.role === 'user' ? 'justify-end' : 'justify-start',
            )}
          >
            {t.role === 'assistant' && (
              <Bot className="mt-1 h-5 w-5 shrink-0 text-primary" />
            )}
            <div
              className={cn(
                'max-w-[80%] rounded-2xl px-3.5 py-2 text-sm',
                t.role === 'user'
                  ? 'rounded-br-sm bg-primary text-primary-foreground'
                  : 'rounded-bl-sm bg-muted text-foreground',
              )}
            >
              {/* Media preview (user turns) */}
              {t.media?.kind === 'image' && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={t.media.previewUrl}
                  alt="Sent attachment"
                  className="mb-1.5 max-h-48 rounded-lg object-cover"
                />
              )}
              {t.media?.kind === 'audio' && (
                <audio
                  controls
                  src={t.media.previewUrl}
                  className="mb-1.5 w-56 max-w-full"
                />
              )}
              {t.content && <p className="whitespace-pre-wrap">{t.content}</p>}

              {/* What the bot understood (user media turns) */}
              {t.media && (t.media.understanding || t.media.understoodFailed) && (
                <p
                  className={cn(
                    'mt-1.5 border-t pt-1.5 text-xs',
                    t.role === 'user'
                      ? 'border-primary-foreground/25 text-primary-foreground/80'
                      : 'border-border/50 text-muted-foreground',
                  )}
                >
                  {t.media.understanding
                    ? `${t.media.kind === 'audio' ? 'Heard' : 'Bot saw'}: ${t.media.understanding}`
                    : t.media.kind === 'audio'
                      ? "Couldn't transcribe this (needs an OpenAI key, or the audio was unclear)."
                      : "Couldn't read this image (needs an OpenAI key, or it wasn't readable)."}
                </p>
              )}

              {t.role === 'assistant' && t.handoff && (
                <p
                  className={cn(
                    'flex items-center gap-1 text-xs text-amber-500',
                    t.content && 'mt-1.5 border-t border-border/50 pt-1.5',
                  )}
                >
                  <UserCircle2 className="h-3.5 w-3.5" />
                  Would hand off to a human here
                </p>
              )}
            </div>
            {t.role === 'user' && (
              <UserCircle2 className="mt-1 h-5 w-5 shrink-0 text-muted-foreground" />
            )}
          </div>
        ))}

        {sending && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Bot className="h-5 w-5 text-primary" />
            <Loader2 className="h-4 w-4 animate-spin" /> Thinking…
          </div>
        )}
      </div>

      {/* Composer */}
      <div className="flex items-end gap-2 border-t border-border p-3">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Type a customer message…"
          rows={1}
          className="flex-1 resize-none rounded-xl border border-border bg-muted px-4 py-2.5 text-sm text-foreground placeholder-muted-foreground outline-none focus:border-primary/50"
        />
        <Button
          size="sm"
          onClick={sendText}
          disabled={!input.trim() || sending}
          className="h-9 w-9 shrink-0 p-0"
        >
          {sending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Send className="h-4 w-4" />
          )}
        </Button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck & lint**

Run: `npm run typecheck && npx eslint src/components/agents/ai-playground.tsx`
Expected: no type errors; no new lint errors on this file. (Repo lint has pre-existing debt elsewhere, so lint the changed file specifically rather than the whole project.)

- [ ] **Step 3: Browser verification** — open `/agents` → Playground, send a text message, confirm the reply appears and Reset works (unchanged behavior).

- [ ] **Step 4: Commit**

```bash
git add src/components/agents/ai-playground.tsx
git commit -m "refactor(agents): playground runTurn + media rendering plumbing" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Client — image input (stage, caption, send)

**Files:**
- Modify: `src/components/agents/ai-playground.tsx`

**Interfaces:**
- Consumes: `runTurn`, `trackObjectUrl`, `uploadAccountMedia`, `MEDIA_MAX_BYTES_BY_KIND`.

- [ ] **Step 1: Update imports.** Change the lucide import line to add `ImageIcon` and `X`:

```tsx
import { Bot, RotateCcw, Send, Loader2, UserCircle2, ArrowRight, ImageIcon, X } from 'lucide-react';
```

And extend the upload-media import to include the size limits:

```tsx
import { uploadAccountMedia, deleteAccountMedia, MEDIA_MAX_BYTES_BY_KIND } from '@/lib/storage/upload-media';
```

- [ ] **Step 2: Add staged-image state.** Immediately after the `objectUrlsRef` declaration, add:

```tsx
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [stagedImage, setStagedImage] = useState<{ file: File; previewUrl: string } | null>(null);
```

- [ ] **Step 3: Add image handlers.** Immediately after `sendText`, add (this also introduces `trackObjectUrl`, used here and in Task 5):

```tsx
  /** Track a local object URL so it can be revoked on reset/unmount. */
  const trackObjectUrl = (url: string) => {
    objectUrlsRef.current.push(url);
    return url;
  };

  const onPickImage = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-picking the same file
    if (!file) return;
    if (file.size > MEDIA_MAX_BYTES_BY_KIND.image) {
      toast.error('Image is too large (max 5 MB).');
      return;
    }
    const previewUrl = trackObjectUrl(URL.createObjectURL(file));
    setStagedImage({ file, previewUrl });
  };

  const sendStagedImage = async () => {
    if (!stagedImage || sending) return;
    const caption = input.trim();
    const { file, previewUrl } = stagedImage;
    setStagedImage(null);
    setInput('');
    setSending(true);
    let key: string;
    try {
      ({ key } = await uploadAccountMedia(convex, startUpload, file, 'inbound'));
    } catch {
      toast.error('Upload failed.');
      setSending(false);
      return;
    }
    await runTurn(
      { role: 'user', content: caption, media: { kind: 'image', previewUrl } },
      { kind: 'image', key },
    );
  };
```

- [ ] **Step 4: Route Send/Enter to the staged image.** Replace `handleKeyDown` and add a unified `handleSend`:

```tsx
  const handleSend = () => {
    if (stagedImage) void sendStagedImage();
    else void sendText();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };
```

- [ ] **Step 5: Render the composer controls.** Replace the entire `{/* Composer */}` block with:

```tsx
      {/* Composer */}
      <div className="border-t border-border p-3">
        {stagedImage && (
          <div className="mb-2 flex items-center gap-2 rounded-lg bg-muted p-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={stagedImage.previewUrl}
              alt="Staged"
              className="h-12 w-12 rounded object-cover"
            />
            <span className="flex-1 text-xs text-muted-foreground">
              Image attached — add a caption (optional) and send.
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setStagedImage(null)}
              className="h-7 w-7 shrink-0 p-0 text-muted-foreground"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        )}
        <div className="flex items-end gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={onPickImage}
          />
          <Button
            variant="ghost"
            size="sm"
            onClick={() => fileInputRef.current?.click()}
            disabled={sending || !!stagedImage}
            className="h-9 w-9 shrink-0 p-0 text-muted-foreground"
            title="Attach an image"
          >
            <ImageIcon className="h-4 w-4" />
          </Button>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={stagedImage ? 'Add a caption…' : 'Type a customer message…'}
            rows={1}
            className="flex-1 resize-none rounded-xl border border-border bg-muted px-4 py-2.5 text-sm text-foreground placeholder-muted-foreground outline-none focus:border-primary/50"
          />
          <Button
            size="sm"
            onClick={handleSend}
            disabled={sending || (!input.trim() && !stagedImage)}
            className="h-9 w-9 shrink-0 p-0"
          >
            {sending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Send className="h-4 w-4" />
            )}
          </Button>
        </div>
      </div>
```

- [ ] **Step 6: Typecheck & lint**

Run: `npm run typecheck && npx eslint src/components/agents/ai-playground.tsx`
Expected: no type errors; no new lint errors on this file.

- [ ] **Step 7: Browser verification** — open `/agents` → Playground: click the image button, pick an image, add a caption, Send. Confirm the thumbnail renders, "Bot saw: …" appears, and the reply follows. Confirm the ✕ cancels a staged image.

- [ ] **Step 8: Commit**

```bash
git add src/components/agents/ai-playground.tsx
git commit -m "feat(agents): send images in the playground" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Client — voice recording (record, stop, cancel, send)

**Files:**
- Modify: `src/components/agents/ai-playground.tsx`

**Interfaces:**
- Consumes: `runTurn`, `trackObjectUrl`, `uploadAccountMedia`.

- [ ] **Step 1: Update imports.** Add `Mic` and `Square` to the lucide import:

```tsx
import { Bot, RotateCcw, Send, Loader2, UserCircle2, ArrowRight, ImageIcon, X, Mic, Square } from 'lucide-react';
```

- [ ] **Step 2: Add a max-recording constant** just above the `AiPlayground` function:

```tsx
/** Soft cap on a Playground voice note; auto-stops to bound Whisper cost. */
const MAX_RECORDING_SECONDS = 60;
```

- [ ] **Step 3: Add recorder state/refs** immediately after the `stagedImage` state:

```tsx
  const [recording, setRecording] = useState(false);
  const [recSeconds, setRecSeconds] = useState(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recChunksRef = useRef<Blob[]>([]);
  const recTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
```

- [ ] **Step 4: Add recording handlers.** Immediately after `sendStagedImage`, add:

```tsx
  const pickAudioMime = (): MediaRecorderOptions | undefined => {
    const candidates = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/mp4',
      'audio/ogg;codecs=opus',
    ];
    for (const mimeType of candidates) {
      if (
        typeof MediaRecorder !== 'undefined' &&
        MediaRecorder.isTypeSupported(mimeType)
      ) {
        return { mimeType };
      }
    }
    return undefined; // let the browser choose
  };

  const clearRecTimer = () => {
    if (recTimerRef.current) clearInterval(recTimerRef.current);
    recTimerRef.current = null;
  };

  const sendVoiceNote = async (blob: Blob) => {
    const type = blob.type || 'audio/webm';
    const ext = type.includes('mp4')
      ? 'm4a'
      : type.includes('ogg')
        ? 'ogg'
        : 'webm';
    const file = new File([blob], `voice-note.${ext}`, { type });
    const previewUrl = trackObjectUrl(URL.createObjectURL(blob));
    setSending(true);
    let key: string;
    try {
      ({ key } = await uploadAccountMedia(convex, startUpload, file, 'inbound'));
    } catch {
      toast.error('Upload failed.');
      setSending(false);
      return;
    }
    await runTurn(
      { role: 'user', content: '', media: { kind: 'audio', previewUrl } },
      { kind: 'audio', key },
    );
  };

  // Defined before `startRecording` so the interval callback inside it can
  // reference `stopRecording` without tripping no-use-before-define.
  const stopRecording = () => {
    clearRecTimer();
    setRecording(false);
    mediaRecorderRef.current?.stop(); // fires onstop → sends
    mediaRecorderRef.current = null;
  };

  const cancelRecording = () => {
    clearRecTimer();
    setRecording(false);
    const recorder = mediaRecorderRef.current;
    mediaRecorderRef.current = null;
    if (recorder) {
      // Discard: drop chunks and stop tracks without sending.
      recChunksRef.current = [];
      recorder.onstop = () => recorder.stream.getTracks().forEach((tr) => tr.stop());
      recorder.stop();
    }
  };

  const startRecording = async () => {
    if (sending || recording) return;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      toast.error('Microphone access was denied.');
      return;
    }
    const recorder = new MediaRecorder(stream, pickAudioMime());
    recChunksRef.current = [];
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) recChunksRef.current.push(e.data);
    };
    recorder.onstop = () => {
      stream.getTracks().forEach((tr) => tr.stop());
      const blob = new Blob(recChunksRef.current, { type: recorder.mimeType });
      recChunksRef.current = [];
      if (blob.size > 0) void sendVoiceNote(blob);
    };
    recorder.start();
    mediaRecorderRef.current = recorder;
    setRecording(true);
    setRecSeconds(0);
    recTimerRef.current = setInterval(() => {
      setRecSeconds((s) => {
        if (s + 1 >= MAX_RECORDING_SECONDS) stopRecording();
        return s + 1;
      });
    }, 1000);
  };
```

- [ ] **Step 5: Update Reset for media.** Replace the whole `reset` function (from Task 3) with the version below — it now cancels an in-progress recording and clears a staged image:

```tsx
  const reset = () => {
    if (recording) cancelRecording();
    objectUrlsRef.current.forEach((u) => URL.revokeObjectURL(u));
    objectUrlsRef.current = [];
    setTurns([]);
    setStagedImage(null);
  };
```

- [ ] **Step 6: Add the mic control + recording bar.** In the composer's inner `<div className="flex items-end gap-2">`, add the mic button immediately after the image `<Button>` (before the `<textarea>`):

```tsx
          <Button
            variant="ghost"
            size="sm"
            onClick={recording ? stopRecording : startRecording}
            disabled={sending || !!stagedImage}
            className={cn(
              'h-9 w-9 shrink-0 p-0',
              recording ? 'text-red-500' : 'text-muted-foreground',
            )}
            title={recording ? 'Stop & send' : 'Record a voice note'}
          >
            {recording ? <Square className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
          </Button>
```

Then, so recording state is visible, replace the `<textarea>` element with a conditional: when `recording`, show a recording bar instead of the textarea. Wrap them:

```tsx
          {recording ? (
            <div className="flex flex-1 items-center gap-2 rounded-xl border border-red-500/40 bg-muted px-4 py-2.5 text-sm">
              <span className="h-2 w-2 animate-pulse rounded-full bg-red-500" />
              <span className="flex-1 text-foreground">
                Recording… {Math.floor(recSeconds / 60)}:
                {String(recSeconds % 60).padStart(2, '0')}
              </span>
              <Button
                variant="ghost"
                size="sm"
                onClick={cancelRecording}
                className="h-7 w-7 shrink-0 p-0 text-muted-foreground"
                title="Discard"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          ) : (
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={stagedImage ? 'Add a caption…' : 'Type a customer message…'}
              rows={1}
              className="flex-1 resize-none rounded-xl border border-border bg-muted px-4 py-2.5 text-sm text-foreground placeholder-muted-foreground outline-none focus:border-primary/50"
            />
          )}
```

Finally, disable the Send button while recording — change its `disabled` to:

```tsx
            disabled={sending || recording || (!input.trim() && !stagedImage)}
```

- [ ] **Step 7: Typecheck & lint**

Run: `npm run typecheck && npx eslint src/components/agents/ai-playground.tsx`
Expected: no type errors; no new lint errors on this file. `DOM` lib types (`MediaRecorder`, `navigator.mediaDevices`) are available in the Next.js client `tsconfig`.

- [ ] **Step 8: Browser verification** — open `/agents` → Playground: click the mic (grant permission), record a few seconds (Malayalam if possible), click stop. Confirm the audio player renders, "Heard: …" shows the transcript, and the reply follows. Confirm the ✕ discards a recording, the 60s auto-stop works, and Reset stops an in-progress recording.

- [ ] **Step 9: Full build check**

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 10: Commit**

```bash
git add src/components/agents/ai-playground.tsx
git commit -m "feat(agents): record & send voice notes in the playground" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review Notes (author)

- **Spec coverage:** voice record-only (Task 5), image upload (Task 4), transcript+reply display (Tasks 3–5 render), R2-faithful path + `toChatMessages` reuse + key/model selection (Task 2), extension tweak (Task 1), cleanup via `deleteAccountMedia` (Task 3 `runTurn` finally), ownership check (Task 2), tests (Tasks 1–2) + live browser (Tasks 3–5). All spec sections map to a task.
- **Type consistency:** `PlaygroundMessage`/`Turn.media`/`understanding` shapes match between client (Task 3) and server (Task 2). `runTurn(userTurn, liveMedia)` and `trackObjectUrl` are defined in Task 3 and consumed in Tasks 4–5.
- **Open verification risk:** live browser checks need R2 (`NEXT_PUBLIC_R2_PUBLIC_HOST`), an OpenAI key on the account, and mic/camera permissions — available on the deployed/live env per project notes; a bare local dev without R2 env can't exercise upload.
