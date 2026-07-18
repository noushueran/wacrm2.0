// ============================================================
// Shared types for the AI auto-reply generation path. Convex port of
// `src/lib/ai/types.ts`, trimmed to what `convex/aiReply.ts` and its
// ported helpers (`generate.ts`, `providers/*`) actually need — the
// source's `AiConfig` interface (the account's whole settings row) has
// no direct counterpart here: `convex/aiConfig.ts`'s `loadDecrypted`
// already returns a Convex-shaped decrypted config (optional rather
// than nullable strings), and `generateReply` below only ever reads
// three of its fields, so `GenerateArgs` (in `generate.ts`) lists
// `provider`/`model`/`apiKey` directly instead of nesting a whole
// second config type in here.
// ============================================================

export type AiProvider = "openai" | "anthropic";

/** A single conversation turn in the shape both providers accept. */
export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

/**
 * Token counts for one provider call, normalized across OpenAI
 * (`prompt`/`completion`) and Anthropic (`input`/`output`). Null when
 * the provider didn't return usage. Logged via `convex/aiUsage.ts`'s
 * `log`.
 */
export interface AiUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/** Raw text + usage a provider adapter returns before handoff parsing. */
export interface ProviderResult {
  text: string;
  usage: AiUsage | null;
}

/** Outcome of a generation call. */
export interface GenerateResult {
  /** The reply text, with any handoff/ask-admin sentinel stripped. */
  text: string;
  /** True when the model asked to hand off to a human (auto-reply mode). */
  handoff: boolean;
  /** The question the model wants the admin/team to answer (qualification
   *  v3 "ask the admin" protocol), or null. Ignored when `handoff`. */
  askAdmin: string | null;
  /** Provider token usage for this call, or null when unavailable. */
  usage: AiUsage | null;
}

/**
 * Typed error for every AI failure mode. Ported verbatim from the
 * source: even though `convex/aiReply.ts`'s `dispatchInbound` never
 * inspects `code`/`status` itself (its outer try/catch just logs and
 * returns, exactly like the source's own top-level catch), keeping the
 * typed error makes the ported `generate.test.ts`/provider behavior
 * faithful and gives a future caller (e.g. a "test this key" action)
 * somewhere to hang a status code without re-deriving one.
 */
export class AiError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(message: string, opts: { code?: string; status?: number } = {}) {
    super(message);
    this.name = "AiError";
    this.code = opts.code ?? "ai_error";
    this.status = opts.status ?? 502;
  }
}
