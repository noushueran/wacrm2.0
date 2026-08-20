import { AiError, type AiUsage, type ChatMessage } from "../types";
import type { ReasoningEffort } from "../defaults";

// ============================================================
// Convex port of `src/lib/ai/providers/shared.ts` — bits shared by the
// OpenAI + Anthropic adapters. Pure, copied verbatim bar the quote
// style (same "no Postgres/Supabase dependency" precedent as the rest
// of `convex/lib/ai/`).
// ============================================================

export interface ProviderArgs {
  apiKey: string;
  model: string;
  systemPrompt: string;
  messages: ChatMessage[];
  timeoutMs: number;
  /**
   * How hard a reasoning model should think before answering. Passed
   * straight through to OpenAI's `reasoning_effort` when the model
   * supports it (`defaults.ts`'s `supportsReasoningEffort`) and ignored
   * otherwise; Anthropic's adapter ignores it entirely.
   *
   * Optional so existing callers/tests keep their exact request body.
   * Absent = send nothing = the model's own default, which is what every
   * chat call did before the 2026-07-27 audit — and why reasoning tokens
   * were silently eating the 320-token output budget.
   */
  reasoningEffort?: ReasoningEffort;
  /**
   * Cache-routing hint (OpenAI `prompt_cache_key`). On GPT-5.6 and later
   * this is what actually makes prefix caching land: without it requests
   * sharing a prefix scatter across cache shards and miss. Measured on
   * this account before it existed — a 6% hit rate against a ~3.9k-token
   * static prefix that should have cached almost every call.
   *
   * Optional so existing callers/tests keep their exact request body;
   * ignored by the Anthropic adapter, which caches via explicit
   * `cache_control` breakpoints rather than routing.
   */
  promptCacheKey?: string;
}

/**
 * Coerce a provider's usage block into our normalized `AiUsage`, tolerant
 * of missing/partial fields (providers differ and older API versions may
 * omit counts). Returns null when there's nothing usable, so logging can
 * distinguish "no usage reported" from "zero tokens". `total` falls back
 * to prompt + completion when the provider doesn't send it (Anthropic).
 */
export function normalizeUsage(raw: {
  prompt?: unknown;
  completion?: unknown;
  total?: unknown;
  /** Cached prompt tokens — a subset of `prompt`, see `AiUsage`. */
  cached?: unknown;
  /** Reasoning tokens — a subset of `completion`, see `AiUsage`. */
  reasoning?: unknown;
}): AiUsage | null {
  const num = (v: unknown): number =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
  const promptTokens = num(raw.prompt);
  const completionTokens = num(raw.completion);
  const total = num(raw.total);
  const totalTokens = total > 0 ? total : promptTokens + completionTokens;
  // The emptiness test deliberately ignores `cached`/`reasoning`: both
  // are subsets of counts already tested above, so they can never be the
  // only thing a provider reported, and letting them keep a row alive
  // would resurrect exactly the all-zero rows `aiUsage.log` drops.
  if (promptTokens === 0 && completionTokens === 0 && totalTokens === 0) {
    return null;
  }
  // Clamped to their parent counts: a provider that reported more cached
  // tokens than prompt tokens (or more reasoning than completion) is
  // reporting nonsense, and an out-of-range subset would make the usage
  // page's cache-hit rate read above 100%.
  return {
    promptTokens,
    completionTokens,
    totalTokens,
    cachedPromptTokens: Math.min(num(raw.cached), promptTokens),
    reasoningTokens: Math.min(num(raw.reasoning), completionTokens),
  };
}

/** Map a fetch rejection (timeout / DNS / offline) to a typed AiError. */
export function toNetworkError(err: unknown): AiError {
  if (err instanceof DOMException && err.name === "TimeoutError") {
    return new AiError("The AI provider took too long to respond.", {
      code: "timeout",
      status: 504,
    });
  }
  const msg = err instanceof Error ? err.message : String(err);
  return new AiError(`Could not reach the AI provider: ${msg}`, {
    code: "network_error",
    status: 502,
  });
}

/** Build a typed AiError from a non-2xx provider response, pulling the
 *  provider's own error message out of the JSON body when present. */
export async function providerHttpError(
  provider: string,
  res: Response,
): Promise<AiError> {
  let detail = "";
  try {
    const body = (await res.json()) as { error?: { message?: string } | string };
    detail =
      typeof body?.error === "string" ? body.error : (body?.error?.message ?? "");
  } catch {
    // Non-JSON error body — fall back to the status line.
  }

  const { status } = res;
  const code =
    status === 401 || status === 403
      ? "invalid_key"
      : status === 429
        ? "rate_limited"
        : "provider_error";
  const base =
    code === "invalid_key"
      ? `${provider} rejected the API key`
      : code === "rate_limited"
        ? `${provider} rate limit reached`
        : `${provider} API error (${status})`;

  return new AiError(detail ? `${base}: ${detail}` : base, {
    code,
    // Surface an auth failure as 401 so a future "test this key" action
    // can show "invalid key"; everything else is an upstream 502.
    status: code === "invalid_key" ? 401 : 502,
  });
}

/**
 * Collapse consecutive same-role turns into one (joined with blank
 * lines). Anthropic requires strictly alternating roles; merging is
 * also harmless for OpenAI and keeps the transcript compact.
 */
export function mergeConsecutive(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of messages) {
    const last = out[out.length - 1];
    if (last && last.role === m.role) {
      last.content = `${last.content}\n\n${m.content}`;
    } else {
      out.push({ role: m.role, content: m.content });
    }
  }
  return out;
}
