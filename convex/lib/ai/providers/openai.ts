import { AiError, type ProviderResult } from "../types";
import { maxOutputTokensFor, supportsReasoningEffort } from "../defaults";
import {
  mergeConsecutive,
  normalizeUsage,
  providerHttpError,
  toNetworkError,
  type ProviderArgs,
} from "./shared";

// ============================================================
// Convex port of `src/lib/ai/providers/openai.ts` — pure network client,
// copied verbatim bar the quote style. Runs from `generate.ts`, called
// only from `convex/aiReply.ts`'s `dispatchInbound` action (never in
// DRY-RUN — see that file's own `isDryRun` gate), so the plain `fetch`
// call below is fine in Convex's default (non-Node) action runtime,
// same as `convex/lib/ai/embeddings.ts`'s `embedTexts`.
// ============================================================

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";

interface OpenAiResponse {
  choices?: { message?: { content?: string } }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    /** Prefix-cache hits. Billed at ~10% of the input rate — see
     *  `AiUsage.cachedPromptTokens`. */
    prompt_tokens_details?: { cached_tokens?: number };
    /** Reasoning tokens, billed at the output rate and drawn from
     *  `max_completion_tokens` — see `AiUsage.reasoningTokens`. */
    completion_tokens_details?: { reasoning_tokens?: number };
  };
}

/**
 * Call OpenAI's Chat Completions endpoint with the caller's own key.
 * Returns the raw assistant text + token usage (handoff parsing happens
 * in `generate.ts`'s `generateReply`).
 */
export async function generateOpenAi(args: ProviderArgs): Promise<ProviderResult> {
  const { apiKey, model, systemPrompt, messages, timeoutMs, reasoningEffort, promptCacheKey } =
    args;

  // `reasoning_effort` is only valid on reasoning models and is rejected
  // outright by older chat models, so it is sent ONLY when both the
  // caller asked for a level and the model can take one — the same guard
  // `media.ts` has always applied to its vision calls.
  const effort =
    reasoningEffort && supportsReasoningEffort(model) ? reasoningEffort : null;

  let res: Response;
  try {
    res = await fetch(OPENAI_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "system", content: systemPrompt }, ...mergeConsecutive(messages)],
        // Sized from the effort level, NOT the flat visible-reply budget:
        // reasoning tokens come out of this same allowance, so a bare 320
        // could be consumed entirely by reasoning, returning empty
        // `content` — which this adapter throws as `empty_response`,
        // costing a full retry and landing the customer on the generic
        // fallback. See `maxOutputTokensFor`.
        max_completion_tokens: maxOutputTokensFor(effort),
        ...(effort ? { reasoning_effort: effort } : {}),
        // Routes this request to the shard already holding its prefix.
        // Omitted entirely when absent so the body stays byte-identical
        // for callers that don't set one.
        ...(promptCacheKey ? { prompt_cache_key: promptCacheKey } : {}),
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw toNetworkError(err);
  }

  if (!res.ok) {
    throw await providerHttpError("OpenAI", res);
  }

  const data = (await res.json().catch(() => null)) as OpenAiResponse | null;
  const text = data?.choices?.[0]?.message?.content;
  if (!text || typeof text !== "string" || !text.trim()) {
    throw new AiError("OpenAI returned an empty response.", {
      code: "empty_response",
    });
  }
  const usage = normalizeUsage({
    prompt: data?.usage?.prompt_tokens,
    completion: data?.usage?.completion_tokens,
    total: data?.usage?.total_tokens,
    cached: data?.usage?.prompt_tokens_details?.cached_tokens,
    reasoning: data?.usage?.completion_tokens_details?.reasoning_tokens,
  });
  return { text, usage };
}
