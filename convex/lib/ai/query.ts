import type { ChatMessage } from "./types";

// ============================================================
// Convex port of `src/lib/ai/query.ts` — pure, copied verbatim bar the
// quote style, exactly like `convex/lib/ai/chunk.ts`'s own precedent
// (no dependency on Postgres/Supabase, so nothing here needed adapting).
// ============================================================

/**
 * The text to retrieve knowledge against: the most recent customer
 * (`user`) turn in the conversation context. Falls back to the last
 * message of any role, then empty string. Shared by `convex/aiReply.ts`'s
 * `dispatchInbound` for both the knowledge-retrieval query text and (in
 * DRY-RUN) the deterministic synthetic-reply decision.
 */
export function latestUserMessage(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") return messages[i].content;
  }
  return messages.length > 0 ? messages[messages.length - 1].content : "";
}
