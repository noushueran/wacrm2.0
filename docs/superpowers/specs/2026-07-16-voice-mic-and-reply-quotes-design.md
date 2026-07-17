# Voice-note mic button + reply-quote write-path — Design

Date: 2026-07-16
Status: Approved (design)
Scope: Holidayys WA CRM inbox — two independent, self-contained fixes.

## Problem

1. **Voice notes feel missing.** A full in-browser voice recorder already ships
   and works in production (opus-recorder → Ogg/Opus → Convex storage →
   `api.send.send` `messageType:"audio"` → Meta renders a voice note). But its
   only entry point is the 📎 attach menu → "Voice note", so agents can't find
   it. Confirmed with the owner: it works, it's just not discoverable, and the
   desired UX is **tap-mic → tap-stop**.

2. **Replies don't render as quotes in our inbox.** When an agent replies to a
   customer message (or a customer replies to ours), the recipient's phone shows
   the quote correctly, but our own inbox shows a standalone message. Root cause:
   the reply **write path is missing**. `messages.replyToMessageId` exists in the
   schema and the client already renders `<ReplyQuote>` from
   `reply_to_message_id`, but nothing ever writes the field — outbound
   `metaSend.* → appendInternal` drops it, and inbound `context.id` is dropped
   during webhook flattening.

## Non-goals

- No change to the recorder, audio encoding, upload, or the Meta audio-send path
  (all already work).
- No change to how the quote is *rendered* (`ReplyQuote` / `MessageBubble` /
  `buildReplyPreview` already work) — only to how the reference is *stored*.
- No schema migration and no new index (`replyToMessageId` column and the
  `by_message_id` index already exist).

## Design

### Part A — Voice mic button (frontend only)

File: `src/components/inbox/message-composer.tsx`.

- **Send ⇄ Mic swap:** in the default composer row, render a **Mic** button in
  the send slot when `text.trim()` is empty; render the existing **Send** button
  once the agent types. Mirrors WhatsApp; adds no horizontal clutter.
- Mic `onClick` → the existing `startRecording()`. The rest of the flow
  (recording bar with timer + Stop, `finalizeRecording` upload, `MediaDraftPreview`
  with `<audio>` player, Send → `onSendMedia({kind:"audio"})`) is unchanged.
- Mic is disabled (with tooltip) when `inputsDisabled` (viewer role or expired
  24h window), consistent with the current 📎 gating. Voice = free-form media,
  only allowed inside the 24h window.
- Remove the now-redundant "Voice note" item from the 📎 attach menu (the mic is
  its first-class replacement).
- Works on PC + mobile (tap). Mic device selection (incl. headset mic) and
  permission are handled by the browser's `getUserMedia`; the existing
  "Microphone access denied or unavailable" toast covers denial.

### Part B — Reply-quote write path (backend)

Store the internal `Id<"messages">` of the parent on the reply's own row, in both
directions. The client already resolves it (`messagesById.get(reply_to_message_id)`)
and renders the quote.

**B1 — Outbound (agent reply).** `send.ts` already receives `replyToMessageId`
and resolves the Meta `contextMessageId`; it just never persists the reference.

- `convex/messages.ts`: add `replyToMessageId?: Id<"messages">` to
  `AppendMessageArgs`; write it in `insertMessageAndUpdateConversation`'s insert;
  accept it in `append` and `appendInternal` arg validators (both, so the two
  entry points don't drift).
- `convex/metaSend.ts`: add `replyToMessageId: v.optional(v.id("messages"))` to
  `sendText`, `sendMedia`, `sendTemplate`, `sendInteractive`; pass it into each
  `appendInternal` call.
- `convex/send.ts`: pass `replyToMessageId: args.replyToMessageId` into each
  `metaSend.*` dispatch.

**B2 — Inbound (customer reply to us).**

- `convex/lib/whatsapp/webhookParse.ts`: add `contextWamid?: string` to
  `FlattenedInboundMessage`; capture `message.context?.id` in
  `flattenInboundMessage` (the same place `referral`/`ctwaClid` are merged).
- `convex/ingest.ts` (`ingestInbound`): if `message.contextWamid` is set, look up
  the parent message via the `by_message_id` index, filtered to the same
  `accountId` + `conversationId` (wamids aren't globally unique), and set
  `appendArgs.replyToMessageId = parent._id`. Also add `contextWamid` to the
  inbound-message validator that `processInbound` → `ingestInbound` passes.
- Graceful fallback: parent not found → `replyToMessageId` stays undefined → the
  message renders plainly (no crash, no orphan reference).

## Edge cases

- Parent message deleted after the reply is stored → client `messagesById.get`
  returns undefined → renders without a quote. Safe.
- Reply to a message that predates the CRM / was never stored (inbound) → no
  parent found → plain render. Safe.
- Non-reply messages → `replyToMessageId` undefined, unchanged behavior.

## Testing

- **TDD (convex-test, offline):**
  - `flattenInboundMessage` captures `context.id` → `contextWamid`.
  - `ingestInbound` with a matching `contextWamid` stores the parent's `_id`;
    with a non-matching one, stores nothing.
  - `api.send.send` (dry-run) with `replyToMessageId` persists the reference on
    the new row (text + one media type).
- **Browser preview:** verify the Mic ⇄ Send swap, recording bar, preview, and
  disabled state; confirm no regression to typing/Send.

## Rollout

- Part A is frontend-only (Netlify build on push).
- Part B touches Convex functions (no schema/index change) → needs `convex deploy`
  **and** the Netlify build. Build + test + verify locally first; **confirm with
  the owner before any production deploy.**
