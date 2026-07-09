// ============================================================
// Embeddings (OpenAI) — Convex port of the network-calling half of
// `src/lib/ai/embeddings.ts`. Used by `convex/aiKnowledge.ts`'s
// `ingest`/`retrieve` internal actions for the knowledge base's optional
// semantic-search path: embed each chunk at ingest, and embed the query
// at retrieval time. Anthropic has no embeddings endpoint, so this is
// always OpenAI's — the account supplies a (possibly separate)
// embeddings key via `aiConfig.upsert`.
//
// Simplified relative to the source in the same way
// `convex/lib/whatsapp/metaApi.ts` simplifies `src/lib/whatsapp/
// meta-api.ts`: a plain `Error` on failure instead of the source's
// typed `AiError` (`code`/`status` fields) — those exist in the source
// to map cleanly onto an HTTP response in the Next.js draft route,
// which has no equivalent here (`convex/aiKnowledge.ts`'s `ingest` only
// needs to know THAT the call failed, to fall back to lexical-only
// chunks; `retrieve` is best-effort and never surfaces the error at
// all). Batching, index-based reordering, and the "reject a malformed/
// misaligned response outright rather than silently mis-embedding a
// chunk" validation are all kept, since those protect real data
// integrity regardless of error-type fidelity.
//
// `toVectorLiteral` is NOT ported: that helper existed only to format a
// vector for a pgvector column / PostgREST RPC parameter
// (`[0.1,0.2,...]` text). `aiKnowledgeChunks.embedding` is a plain
// `v.array(v.float64())` in Convex (`convex/schema.ts`), so the
// `number[]` this module returns is already the exact shape to store —
// no serialization step needed.
// ============================================================

const OPENAI_EMBEDDINGS_URL = "https://api.openai.com/v1/embeddings";

export const EMBEDDING_MODEL = "text-embedding-3-small";
export const EMBEDDING_DIMENSIONS = 1536;

// OpenAI accepts an array input; keep batches modest so a big re-index
// stays under request-size limits and partial failures are cheap.
const BATCH_SIZE = 96;

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/** Per-call provider timeout. Override with `AI_REQUEST_TIMEOUT_MS` —
 *  same env var name as the source's `aiRequestTimeoutMs()`, so a
 *  forker's existing override still applies to this Convex path. */
function requestTimeoutMs(): number {
  const raw = Number(process.env.AI_REQUEST_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_REQUEST_TIMEOUT_MS;
}

interface EmbeddingResponse {
  data?: { embedding?: number[]; index?: number }[];
}

/**
 * Embed a list of strings, preserving input order. Batched; throws a
 * plain `Error` on provider/network failure so callers (`ingest`) can
 * decide whether to degrade (store lexical-only chunks) or surface the
 * failure.
 */
export async function embedTexts(
  apiKey: string,
  inputs: string[],
): Promise<number[][]> {
  if (inputs.length === 0) return [];
  const timeoutMs = requestTimeoutMs();
  const out: number[][] = [];

  for (let start = 0; start < inputs.length; start += BATCH_SIZE) {
    const batch = inputs.slice(start, start + BATCH_SIZE);

    let res: Response;
    try {
      res = await fetch(OPENAI_EMBEDDINGS_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model: EMBEDDING_MODEL, input: batch }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Could not reach OpenAI embeddings: ${msg}`);
    }

    if (!res.ok) {
      let detail = "";
      try {
        const body = (await res.json()) as {
          error?: { message?: string } | string;
        };
        detail =
          typeof body?.error === "string"
            ? body.error
            : (body?.error?.message ?? "");
      } catch {
        // Non-JSON error body — fall back to the status line.
      }
      throw new Error(
        `OpenAI embeddings API error (${res.status})${detail ? `: ${detail}` : ""}`,
      );
    }

    const data = (await res.json().catch(() => null)) as EmbeddingResponse | null;
    const rows = data?.data;
    if (!rows || rows.length !== batch.length) {
      throw new Error("OpenAI embeddings response was malformed.");
    }

    // Require a real numeric index — defaulting a missing one to 0
    // would silently misalign chunks with their vectors (chunk N gets
    // chunk M's embedding), so fail loud instead.
    if (rows.some((r) => typeof r.index !== "number")) {
      throw new Error("OpenAI embeddings response was missing result indices.");
    }
    const ordered = [...rows].sort((a, b) => a.index! - b.index!);
    for (const r of ordered) {
      if (!Array.isArray(r.embedding)) {
        throw new Error("OpenAI embeddings response missing a vector.");
      }
      out.push(r.embedding);
    }
  }

  return out;
}
