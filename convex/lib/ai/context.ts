import type { ChatMessage } from "./types";

// ============================================================
// Convex counterpart of `src/lib/ai/context.ts`'s `buildConversationContext`
// — split in two, unlike this directory's other ports, because the
// source function does two things in one shot against a live Supabase
// client: (1) fetch the last N text messages and (2) map them to the
// provider-neutral chat shape. Convex has no direct equivalent of "a
// function that both queries the DB and transforms the result" that
// stays unit-testable without the full `convex-test` harness — DB
// access belongs in an `internalQuery` (see `convex/aiReply.ts`'s
// `recentMessages`, which does the `by_conversation` index scan +
// ordering), so only the pure transform (this file) lives here,
// exercised directly by `context.test.ts` the same way `chunk.test.ts`
// exercises `chunkText`.
// ============================================================

/**
 * Media content types the AI transcript can "see" — rendered as
 * placeholders (below) so the model can acknowledge a voice note or an
 * image instead of the row being invisible (which previously meant a
 * media-only inbound produced NO reply at all). Also the set
 * `convex/ingest.ts`'s `shouldDispatchAiReply` treats as reply-worthy
 * without any text. Deliberately excludes `template`/`interactive`
 * (outbound machinery, not customer content).
 */
export const AI_VISIBLE_MEDIA_TYPES = [
  "image",
  "document",
  "audio",
  "video",
  "location",
] as const;

/** What each media row reads as in the transcript. The model is taught
 *  (see `defaults.ts`'s attachment guidance) that it cannot open these —
 *  acknowledge, never pretend to have seen/heard the content. */
const MEDIA_PLACEHOLDER: Record<string, string> = {
  image: "[image]",
  video: "[video]",
  audio: "[voice note]",
  document: "[document]",
  location: "[location shared]",
};

/**
 * One row of conversation history as read off `messages` — the exact
 * fields `recentMessages` selects (text + the media types above; that
 * query's filter is the DB half of this contract). `contentType` is
 * optional so plain text callers/tests stay untouched: absent means
 * `"text"`.
 */
export interface HistoryMessage {
  senderType: "customer" | "agent" | "bot";
  contentText?: string;
  contentType?: string;
  /** AI transcription of a voice note / vision description of an image
   *  (`messages.aiTranscription`) — rendered after the placeholder so
   *  the model can answer the actual content. */
  transcription?: string;
}

/**
 * Maps message rows — already ordered oldest → newest by the caller
 * (`recentMessages` reverses its newest-first index scan before
 * returning) — to the provider-neutral chat shape. Customer messages
 * become `user`; agent and bot messages become `assistant`, exactly
 * like the source. Text rows keep their (trimmed) text; media rows
 * render as a placeholder followed by any caption; rows with neither
 * text nor a known placeholder are dropped.
 */
export function toChatMessages(rows: HistoryMessage[]): ChatMessage[] {
  return rows.flatMap((m) => {
    const placeholder =
      m.contentType && m.contentType !== "text"
        ? (MEDIA_PLACEHOLDER[m.contentType] ?? null)
        : null;
    const text = (m.contentText ?? "").trim();
    let content: string;
    if (placeholder) {
      // Media row: placeholder, then caption and/or the AI transcript —
      // "[voice note] <transcript>" / "[image] <caption> — <description>".
      const transcription = (m.transcription ?? "").trim();
      const detail = [text, transcription].filter(Boolean).join(" — ");
      content = detail ? `${placeholder} ${detail}` : placeholder;
    } else {
      content = text;
    }
    if (!content) return [];
    return [
      {
        role: m.senderType === "customer" ? ("user" as const) : ("assistant" as const),
        content,
      },
    ];
  });
}
