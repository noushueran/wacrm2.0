import { aiRequestTimeoutMs } from "./defaults";

// ============================================================
// Media understanding — inbound voice notes and images (owner
// requirement 2026-07-18: "listen" to voice notes via transcription and
// "read" images via a vision description, then reply in TEXT; the bot
// never sends voice or generated images back). Both helpers are thin
// OpenAI network clients in the style of `providers/openai.ts` (plain
// fetch, `AbortSignal.timeout`, fine in Convex's default runtime) and
// deliberately return `null` on ANY failure — a media row that can't be
// understood simply keeps its placeholder ("[voice note]"), it must
// never block the reply. Called only from `aiReply.dispatchInbound`,
// never in DRY-RUN (that path substitutes a synthetic transcript).
//
// Key selection lives with the caller: the account's own OpenAI key
// when `provider === "openai"`, else the (also-OpenAI) embeddings key —
// Anthropic has no transcription endpoint, so an Anthropic-only account
// gracefully skips media understanding altogether.
// ============================================================

const OPENAI_BASE = "https://api.openai.com/v1";

/** Long-stable OpenAI transcription model — universally enabled on BYO
 *  keys (newer `gpt-4o-mini-transcribe` is a drop-in upgrade later). */
export const TRANSCRIBE_MODEL = "whisper-1";

/** Vision model used when the account's own configured model can't be
 *  (embeddings-key fallback on an Anthropic-configured account). */
export const DESCRIBE_FALLBACK_MODEL = "gpt-4o-mini";

/** The two "spend as little as possible on thinking" values across the
 *  GPT-5 family. `none` arrived with GPT-5.1; the 5.0 models bottom out
 *  at `minimal` and reject `none`. */
export type ReasoningEffort = "none" | "minimal";

/**
 * The lowest `reasoning_effort` this model will accept, or `null` when
 * the argument must be omitted entirely.
 *
 * Why this exists: reasoning tokens are billed as output tokens and are
 * drawn from the SAME `max_completion_tokens` budget as the visible
 * reply. A model that reasons by default can therefore spend the whole
 * budget thinking and return a 200 with EMPTY content — no error, just
 * silence where the customer expected an answer. Our budgets are tight
 * on purpose (320 for a WhatsApp reply, 150 for an image description),
 * so we pin reasoning off rather than rely on a per-model default.
 *
 * Defaults differ across the family and are NOT stable: `gpt-5.4-mini`
 * (our own settings-form default) already defaults to `none`, but the
 * GPT-5.6 family defaults to `medium`. Since `aiConfigs.model` is free
 * text in the settings UI, one model-string edit is all it takes to go
 * from "fine" to "every auto-reply comes back empty" — pinning the
 * value makes that impossible.
 *
 * Returning `null` (rather than guessing) for everything else is the
 * point of the gate: `gpt-4o-mini`, the o-series, and the non-reasoning
 * `gpt-5-chat-*` variants all reject `reasoning_effort` with a 400, and
 * a hard 400 would be strictly worse than the latent risk we're closing.
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

/** Boolean form of {@link reasoningEffortFor} — true when the model
 *  takes a `reasoning_effort` argument at all. */
export function supportsReasoningEffort(model: string): boolean {
  return reasoningEffortFor(model) !== null;
}

/**
 * Download a WhatsApp voice note (already mirrored into Convex storage
 * at ingest) and transcribe it. Returns the transcript text, or `null`
 * when the media can't be fetched or OpenAI rejects the call.
 */
export async function transcribeAudioFromUrl(args: {
  apiKey: string;
  mediaUrl: string;
}): Promise<string | null> {
  try {
    const media = await fetch(args.mediaUrl, {
      signal: AbortSignal.timeout(aiRequestTimeoutMs()),
    });
    if (!media.ok) return null;
    const blob = await media.blob();

    const form = new FormData();
    // WhatsApp voice notes are OGG/Opus; the filename extension is what
    // OpenAI keys the format detection on.
    form.append("file", blob, "voice-note.ogg");
    form.append("model", TRANSCRIBE_MODEL);

    const res = await fetch(`${OPENAI_BASE}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${args.apiKey}` },
      body: form,
      signal: AbortSignal.timeout(aiRequestTimeoutMs()),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { text?: string };
    const text = typeof data.text === "string" ? data.text.trim() : "";
    return text || null;
  } catch {
    return null;
  }
}

/**
 * Describe a customer-sent image in 1–2 travel-relevant sentences via
 * an OpenAI vision-capable chat model. The stored Convex URL is passed
 * straight through (`image_url` — it is publicly fetchable, same URL
 * the inbox renders). Instructed to NEVER read out passport/ID/card
 * numbers, mirroring the business's golden rules.
 */
export async function describeImageFromUrl(args: {
  apiKey: string;
  model: string;
  mediaUrl: string;
  caption?: string;
}): Promise<string | null> {
  // 150 tokens is a description budget, not a thinking budget — a model
  // left on its default effort could spend all of it reasoning and hand
  // back empty content, which this function would then quietly turn
  // into `null` (placeholder kept, no description). Pin it off.
  const effort = reasoningEffortFor(args.model);
  try {
    const res = await fetch(`${OPENAI_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${args.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: args.model,
        max_completion_tokens: 150,
        ...(effort ? { reasoning_effort: effort } : {}),
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text:
                  "A customer sent this image to a travel agency's WhatsApp." +
                  (args.caption ? ` Their caption: "${args.caption}".` : "") +
                  " Describe what it shows in 1-2 short sentences, focusing on travel-relevant details (destination, document type, dates, any readable text). " +
                  "Never read out passport numbers, ID numbers, or card numbers — if such a document is shown, name the document type only.",
              },
              { type: "image_url", image_url: { url: args.mediaUrl } },
            ],
          },
        ],
      }),
      signal: AbortSignal.timeout(aiRequestTimeoutMs()),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const text = data.choices?.[0]?.message?.content?.trim() ?? "";
    return text || null;
  } catch {
    return null;
  }
}
