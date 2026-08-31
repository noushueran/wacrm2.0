import { AiError, type ChatMessage, type ProviderResult } from "../types";
import { MAX_OUTPUT_TOKENS } from "../defaults";
import {
  mergeConsecutive,
  normalizeUsage,
  providerHttpError,
  toNetworkError,
  type ProviderArgs,
} from "./shared";

// ============================================================
// Convex port of `src/lib/ai/providers/anthropic.ts` — pure network
// client, copied verbatim bar the quote style. See `openai.ts`'s own
// header for why a plain `fetch` call is fine in Convex's default action
// runtime.
// ============================================================

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

interface AnthropicResponse {
  content?: { type?: string; text?: string }[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    /** Anthropic's prefix-cache counterpart to OpenAI's
     *  `cached_tokens`. NOTE it is reported ALONGSIDE `input_tokens`
     *  rather than inside it — see the call site for the adjustment. */
    cache_read_input_tokens?: number;
    /** Tokens written INTO the cache on this call (billed at a premium,
     *  not a discount). Counted toward the prompt total for the same
     *  reason as the read count, but deliberately NOT reported as
     *  `cachedPromptTokens` — it is a cache miss, not a hit. */
    cache_creation_input_tokens?: number;
  };
}

/**
 * Anthropic's Messages API requires strictly alternating roles that
 * begin with `user`. Merge consecutive turns, then drop any leading
 * assistant turns (an agent greeting before the customer said anything)
 * so the transcript always starts on the customer. Guarantees a valid,
 * non-empty payload.
 */
function normalizeForAnthropic(messages: ChatMessage[]): ChatMessage[] {
  const merged = mergeConsecutive(messages);
  while (merged.length > 0 && merged[0].role === "assistant") {
    merged.shift();
  }
  if (merged.length === 0) {
    return [{ role: "user", content: "(The customer has not sent a message yet.)" }];
  }
  return merged;
}

/**
 * Call Anthropic's Messages endpoint with the caller's own key.
 * Returns the raw assistant text + token usage (handoff parsing happens
 * in `generate.ts`'s `generateReply`).
 */
export async function generateAnthropic(args: ProviderArgs): Promise<ProviderResult> {
  const { apiKey, model, systemPrompt, messages, timeoutMs } = args;

  let res: Response;
  try {
    res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        system: systemPrompt,
        max_tokens: MAX_OUTPUT_TOKENS,
        messages: normalizeForAnthropic(messages),
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw toNetworkError(err);
  }

  if (!res.ok) {
    throw await providerHttpError("Anthropic", res);
  }

  const data = (await res.json().catch(() => null)) as AnthropicResponse | null;
  const text = data?.content
    ?.filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("")
    .trim();
  if (!text) {
    throw new AiError("Anthropic returned an empty response.", {
      code: "empty_response",
    });
  }
  // Anthropic reports input/output but no total — normalizeUsage sums.
  //
  // Unlike OpenAI (whose `cached_tokens` sits INSIDE `prompt_tokens`),
  // Anthropic reports `input_tokens` net of cache, with the cached and
  // cache-written halves as siblings. Summing all three restores the
  // "cachedPromptTokens is a subset of promptTokens" invariant `AiUsage`
  // documents and `normalizeUsage` clamps to — without this the clamp
  // would silently truncate every cache hit to the uncached remainder.
  const cacheRead = data?.usage?.cache_read_input_tokens ?? 0;
  const cacheWrite = data?.usage?.cache_creation_input_tokens ?? 0;
  const usage = normalizeUsage({
    prompt: (data?.usage?.input_tokens ?? 0) + cacheRead + cacheWrite,
    completion: data?.usage?.output_tokens,
    cached: cacheRead,
  });
  return { text, usage };
}
