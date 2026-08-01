// ============================================================
// Which `reasoning_effort` to send on an OpenAI chat call, keyed on the
// model id.
//
// `max_completion_tokens` is a SINGLE budget shared between reasoning
// tokens and the visible reply. On a model that reasons by default, a
// request can spend the entire budget thinking and return HTTP 200 with
// empty `content` — no error, just silence — which `generateOpenAi`
// surfaces as an `empty_response` AiError and the customer experiences
// as no reply at all.
//
// This is not hypothetical. Reproduced against the live API on
// `gpt-5.4-mini` at the qualification analysis's own budget:
//
//   max_completion_tokens: 320, reasoning_effort: "medium"
//     -> finish_reason "length", reasoning_tokens 320, content ""
//
// Our budgets are deliberately tight (`MAX_OUTPUT_TOKENS` is 320 for a
// WhatsApp reply), so that failure is well within reach — and
// `aiConfigs.model` is FREE TEXT in the settings form, so a single model
// string edit can flip an account from working to silently empty with no
// code change and no deploy. Pinning the value makes that impossible.
//
// This lives in its own module rather than beside the image-description
// helper in `media.ts` because both the chat provider
// (`providers/openai.ts`) and that vision call need it, and the chat
// path must handle an ARBITRARY caller-supplied model id.
// ============================================================

export type ReasoningEffort = "none" | "minimal";

/**
 * The `reasoning_effort` to pin for `model`, or `null` when the argument
 * must be omitted entirely because the model would reject it.
 *
 * Returns a VALUE rather than a boolean because "none" is not universally
 * accepted: the GPT-5.0 models (`gpt-5`, `gpt-5-mini`, `gpt-5-nano`)
 * predate it and bottom out at "minimal". Sending an unsupported value is
 * a hard 400 — strictly worse than the latent empty-response risk — so
 * anything unrecognized gets the argument omitted rather than guessed.
 */
export function reasoningEffortFor(model: string): ReasoningEffort | null {
  const id = model.trim().toLowerCase();
  // `gpt-5-chat-latest` and friends sit in the gpt-5 namespace but are
  // non-reasoning models — they 400 on the argument.
  if (id.includes("-chat")) return null;
  // Anchor on the major version and refuse to match `gpt-50…`; the
  // optional group captures the minor version (absent ⇒ 5.0).
  const match = /^gpt-5(\.(\d+))?(?![\d.])/.exec(id);
  if (!match) return null;
  const minor = match[2] === undefined ? 0 : Number(match[2]);
  return minor >= 1 ? "none" : "minimal";
}
