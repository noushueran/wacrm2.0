import { AiError, type AiProvider, type AiUsage, type ChatMessage, type GenerateResult } from "./types";
import { HANDOFF_SENTINEL, aiRequestTimeoutMs } from "./defaults";
import { generateOpenAi } from "./providers/openai";
import { generateAnthropic } from "./providers/anthropic";

// ============================================================
// Convex port of `src/lib/ai/generate.ts`. `parseGeneration` is a pure
// 1:1 copy. `generateReply` is the "external LLM call" the task brief
// calls out separately: it's not pure (it dispatches to a network-
// calling provider adapter), so it's never invoked directly in DRY-RUN —
// `convex/aiReply.ts`'s `dispatchInbound` checks `isDryRun()` BEFORE
// calling this, producing a synthetic result instead (mirrors
// `convex/aiKnowledge.ts`'s `ingest`/`retrieve`, which likewise never
// call the real `embedTexts` under `CONVEX_AI_DRY_RUN`).
//
// One shape change from the source: `GenerateArgs` here takes
// `provider`/`model`/`apiKey` directly instead of a nested `config:
// AiConfig` object — `convex/lib/ai/types.ts`'s own header explains why
// a full `AiConfig` type has no home in this directory.
// ============================================================

export interface GenerateArgs {
  provider: AiProvider;
  model: string;
  apiKey: string;
  /** Fully-built system prompt (see `defaults.ts`'s `buildSystemPrompt`). */
  systemPrompt: string;
  /** Recent conversation turns, oldest first. */
  messages: ChatMessage[];
}

/**
 * Generate the next reply from the account's configured provider.
 * Dispatches to the right adapter, then parses the handoff sentinel out
 * of the raw text. Throws `AiError` on any provider/network failure —
 * left uncaught here; `dispatchInbound`'s own top-level try/catch is
 * what makes the auto-reply dispatch as a whole never throw.
 */
export async function generateReply(args: GenerateArgs): Promise<GenerateResult> {
  const { provider, model, apiKey, systemPrompt, messages } = args;
  const timeoutMs = aiRequestTimeoutMs();
  const providerArgs = { apiKey, model, systemPrompt, messages, timeoutMs };

  let result: { text: string; usage: AiUsage | null };
  switch (provider) {
    case "openai":
      result = await generateOpenAi(providerArgs);
      break;
    case "anthropic":
      result = await generateAnthropic(providerArgs);
      break;
    default:
      throw new AiError(`Unsupported AI provider: ${provider as string}`, {
        code: "unsupported_provider",
        status: 400,
      });
  }

  return parseGeneration(result.text, result.usage);
}

/**
 * Split the raw model output into `{ text, handoff, usage }`. The
 * sentinel can appear alone or trailing a partial reply; either way we
 * treat the turn as a handoff and strip the marker from any remaining
 * text. `usage` is passed straight through (null when the provider
 * didn't report it). Also used by `convex/aiReply.ts`'s DRY-RUN path to
 * process its own synthetic raw text through the same logic a real
 * provider response would go through.
 */
export function parseGeneration(raw: string, usage: AiUsage | null = null): GenerateResult {
  const handoff = raw.includes(HANDOFF_SENTINEL);
  // Ask-admin marker (qualification v3): `[[ASK_ADMIN: <question>]]` —
  // extracted and stripped like the handoff sentinel. Handoff wins when
  // both appear (the model bailing outranks it wanting information).
  let askAdmin: string | null = null;
  const withoutMarker = raw.replace(
    /\[\[ASK_ADMIN:([\s\S]*?)\]\]/g,
    (_match, question: string) => {
      if (!askAdmin && question.trim()) askAdmin = question.trim();
      return "";
    },
  );
  const text = withoutMarker.split(HANDOFF_SENTINEL).join("").trim();
  return { text, handoff, askAdmin: handoff ? null : askAdmin, usage };
}
