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
