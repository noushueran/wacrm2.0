import type { ChatMessage } from "./types";

// ============================================================
// Convex port of `src/lib/ai/handoff.ts` — pure, copied verbatim bar
// the quote style (same "no Postgres/Supabase dependency" precedent as
// `query.ts`/`chunk.ts`). Builds the short internal note
// `convex/aiReply.ts`'s `dispatchInbound` writes to a conversation's
// `aiHandoffSummary` when it hands off to a human.
// ============================================================

/** Longest the quoted customer message runs before we ellipsize it —
 *  keeps the internal note to a glanceable one-liner. */
const MAX_QUOTE_LEN = 160;

/**
 * Build the short internal note the auto-reply bot leaves on a
 * conversation when it hands off to a human. Deterministic — composed
 * from context already on hand (no extra LLM call / token spend), so it
 * can't fail or add latency to the handoff.
 *
 * Reads as, e.g.:
 *   "🤖 AI agent handed off after 2 replies. Last customer message:
 *    “can I speak to a manager about my refund?”"
 *
 * `replyCount` is the bot's auto-reply tally for the thread (0 when it
 * bailed on the very first inbound without answering). `reason: "cap"`
 * marks the reply-budget stop (`autoReplyMaxPerConversation` spent) —
 * that handoff isn't the model's own judgement, and the note must tell
 * the human WHY the bot stopped mid-conversation.
 */
export function buildHandoffSummary(args: {
  messages: ChatMessage[];
  replyCount: number;
  reason?: "cap";
}): string {
  const { messages, replyCount, reason } = args;

  const lastCustomer = [...messages]
    .reverse()
    .find((m) => m.role === "user" && m.content.trim());

  const replies =
    replyCount === 0
      ? "without replying"
      : `after ${replyCount} ${replyCount === 1 ? "reply" : "replies"}`;

  const base =
    reason === "cap"
      ? `🤖 AI agent reached its reply limit ${replies} — a human needs to continue.`
      : `🤖 AI agent handed off ${replies}.`;

  if (!lastCustomer) return base;

  const quote = truncate(lastCustomer.content.trim(), MAX_QUOTE_LEN);
  return `${base} Last customer message: “${quote}”`;
}

function truncate(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, " ");
  if (collapsed.length <= max) return collapsed;
  return `${collapsed.slice(0, max - 1).trimEnd()}…`;
}
