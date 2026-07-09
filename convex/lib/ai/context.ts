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
 * One row of conversation history as read off `messages` — the exact
 * fields `recentMessages` selects, already restricted to `contentType
 * === "text"` by that query (mirrors the source's own `.eq('content_type',
 * 'text')` filter, so this function never has to consider media/template/
 * interactive rows).
 */
export interface HistoryMessage {
  senderType: "customer" | "agent" | "bot";
  contentText?: string;
}

/**
 * Maps message rows — already ordered oldest → newest by the caller
 * (`recentMessages` reverses its newest-first index scan before
 * returning) — to the provider-neutral chat shape. Customer messages
 * become `user`; agent and bot messages become `assistant`, exactly
 * like the source. Blank/whitespace-only text is dropped.
 */
export function toChatMessages(rows: HistoryMessage[]): ChatMessage[] {
  return rows
    .filter((m) => m.contentText && m.contentText.trim())
    .map((m) => ({
      role: m.senderType === "customer" ? "user" : ("assistant" as const),
      content: m.contentText!.trim(),
    }));
}
