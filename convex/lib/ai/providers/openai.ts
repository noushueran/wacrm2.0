import { AiError, type ChatMessage, type ProviderResult } from "../types";
import { MAX_OUTPUT_TOKENS } from "../defaults";
import { reasoningEffortFor } from "../reasoning";
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
  };
}

/**
 * The exact JSON body sent to Chat Completions. Extracted as a pure
 * builder so the wire shape — specifically the presence/absence of
 * `reasoning_effort` and the effective token cap — is pinned by
 * `openai.test.ts` without any fetch, the same way
 * `whatsapp/metaApi.ts`'s payload builders are.
 */
export function buildOpenAiRequestBody(args: {
  model: string;
  systemPrompt: string;
  messages: ChatMessage[];
  maxTokens?: number;
}): Record<string, unknown> {
  const { model, systemPrompt, messages, maxTokens } = args;
  // `max_completion_tokens` is shared between reasoning tokens and the
  // reply itself. Left unpinned, a reasoning-by-default model can spend
  // the whole budget thinking and return a 200 with empty `content`,
  // which surfaces below as an `empty_response` AiError. `null` ⇒ the
  // model would 400 on the argument, so omit it. See `../reasoning.ts`.
  const effort = reasoningEffortFor(model);
  return {
    model,
    messages: [{ role: "system", content: systemPrompt }, ...mergeConsecutive(messages)],
    max_completion_tokens: maxTokens ?? MAX_OUTPUT_TOKENS,
    ...(effort ? { reasoning_effort: effort } : {}),
  };
}

/**
 * Call OpenAI's Chat Completions endpoint with the caller's own key.
 * Returns the raw assistant text + token usage (handoff parsing happens
 * in `generate.ts`'s `generateReply`).
 */
export async function generateOpenAi(args: ProviderArgs): Promise<ProviderResult> {
  const { apiKey, model, systemPrompt, messages, timeoutMs, maxTokens } = args;

  let res: Response;
  try {
    res = await fetch(OPENAI_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(
        buildOpenAiRequestBody({ model, systemPrompt, messages, maxTokens }),
      ),
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
  });
  return { text, usage };
}
