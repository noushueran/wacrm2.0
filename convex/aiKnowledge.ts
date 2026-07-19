import { accountMutation, accountQuery } from "./lib/auth";
import {
  internalAction,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { v, ConvexError } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { chunkText } from "./lib/ai/chunk";
import { embedTexts, EMBEDDING_DIMENSIONS } from "./lib/ai/embeddings";

// ============================================================
// AI knowledge base (RAG) — `convex/schema.ts`'s `aiKnowledgeDocuments`
// (one pasted document per row) + `aiKnowledgeChunks` (retrieval units
// chunked from a document, each optionally embedded). Convex
// counterpart to `src/lib/ai/knowledge.ts` (`ingestDocument`/
// `retrieveKnowledge`), `src/lib/ai/chunk.ts`, `src/lib/ai/embeddings
// .ts`, and `src/app/api/ai/knowledge/route.ts`.
//
// Shape: `list`/`create`/`remove` are `accountQuery`/`accountMutation`
// (admin-gated, same as `aiConfig.upsert`) — the settings-page CRUD
// surface. `create` does NOT chunk/embed inline: it inserts the
// document then `ctx.scheduler.runAfter(0, internal.aiKnowledge.ingest,
// ...)`s the actual work onto an `internalAction`, so a large paste
// doesn't block the mutation the admin's UI is awaiting. `ingest` and
// `retrieve` are `internalAction`s — the ONLY functions here that touch
// the network (OpenAI embeddings) or call `ctx.vectorSearch` (action-
// only capability) — with an explicit `accountId` argument (there is no
// user session inside a scheduled action or an engine-triggered
// retrieval call), exactly like `convex/metaSend.ts`'s actions.
//
// **Isolation is the entire point of this file.** A RAG cross-account
// leak means one tenant's question gets answered using ANOTHER
// tenant's private documents — worse than a normal data leak, since the
// leaked content gets woven into prose an agent might paste straight to
// a customer. So every read in `retrieve` is filtered by `accountId` at
// the SOURCE, not just post-filtered after the fact:
//   - the vector path passes `filter: (q) => q.eq("accountId", ...)`
//     directly to `ctx.vectorSearch` (Convex applies this filter as
//     part of the ANN search itself, not a post-hoc scan — see the
//     `by_embedding` vector index's own `filterFields: ["accountId"]`
//     in `convex/schema.ts`);
//   - the hydration step (`getChunksByIds`) that turns those vector-hit
//     ids into actual chunk content RE-ASSERTS `accountId` again,
//     belt-and-braces against a future caller reusing that query
//     without the same discipline;
//   - the lexical top-up uses the `search_content` search index's own
//     `.eq("accountId", ...)` filter (same `withSearchIndex` shape as
//     `contacts.ts`'s `search_name`).
// `convex/aiKnowledge.test.ts`'s isolation tests seed a DECOY second
// account's chunks — engineered to be an equal-or-stronger match than
// the real account's own content — and assert they never come back,
// for both paths independently.
//
// `retrieve` now merges a SECOND pool ahead of that legacy one — the
// compiled `kbChunks` written by `kbCompile.ts` (Knowledge Engine v2) —
// via `getKbChunksByIds`/`searchKbChunks`. Those two mirror the three
// bullets above one-for-one (vector filter → hydration re-assert →
// search-index filter), so the layering above describes all four
// retrieval arms, not just the legacy pair.
//
// DRY-RUN: `CONVEX_AI_DRY_RUN` (mirrors `metaSend.ts`'s
// `CONVEX_META_DRY_RUN`) skips the real OpenAI call in both `ingest`
// and `retrieve`, substituting a deterministic seeded vector
// (`syntheticEmbedding`) instead of either calling the network or
// skipping embedding outright — this keeps the `ctx.vectorSearch` code
// path (and its `accountId` filter) genuinely exercised in tests,
// rather than only ever testing the lexical fallback.
// ============================================================

export function isDryRun(): boolean {
  return !!process.env.CONVEX_AI_DRY_RUN;
}

/**
 * Deterministic, seeded pseudo-random `EMBEDDING_DIMENSIONS`-length
 * vector for one input string — DRY-RUN's stand-in for a real OpenAI
 * embedding. An FNV-1a hash of `text` seeds a mulberry32 PRNG, so the
 * SAME string always produces the SAME vector (matching `chunkText`'s
 * own determinism — re-ingesting unchanged content re-embeds
 * identically) without ever touching the network. Not cryptographic,
 * not semantically meaningful — it only needs to be a valid, stable
 * float vector so `ctx.vectorSearch` has something real to rank.
 *
 * Exported (like `broadcasts.ts`'s `colsForStatus`) so
 * `aiKnowledge.test.ts` can seed a DECOY account's chunk with a
 * deliberately perfect-cosine-match vector — the strongest possible
 * proof that `retrieve`'s `accountId` filter, not mere data
 * coincidence, is what keeps it out of another account's results.
 */
export function syntheticEmbedding(text: string): number[] {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  let seed = h >>> 0;
  const out = new Array<number>(EMBEDDING_DIMENSIONS);
  for (let i = 0; i < EMBEDDING_DIMENSIONS; i++) {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    out[i] = (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
  }
  return out;
}

export function syntheticEmbeddings(texts: string[]): number[][] {
  return texts.map(syntheticEmbedding);
}

/**
 * Deletes every `aiKnowledgeChunks` row for one document via its
 * `by_document` index. Shared by `remove` (direct `ctx.db`, called from
 * an `accountMutation`) and `replaceChunks` (an `internalMutation`
 * invoked from the `ingest` action) — both need the exact same
 * "delete every chunk belonging to this document" step, just from two
 * different entry points. Typed to accept any ctx with a mutation-grade
 * `db` (delete requires write access), same treatment as
 * `broadcasts.ts`'s `requireOwnBroadcast`/`requireOwnContact`.
 */
async function deleteChunksForDocument(
  ctx: { db: MutationCtx["db"] },
  documentId: Id<"aiKnowledgeDocuments">,
): Promise<void> {
  const chunks = await ctx.db
    .query("aiKnowledgeChunks")
    .withIndex("by_document", (q) => q.eq("documentId", documentId))
    .collect();
  for (const chunk of chunks) {
    await ctx.db.delete(chunk._id);
  }
}

// ============================================================
// Documents — admin-gated tenant CRUD.
// ============================================================

/**
 * Every knowledge document for the caller's own account, newest first.
 * Admin+ only (same gate as `create`/`remove` — knowledge-base content
 * shapes what the AI assistant tells customers, so it gets the same
 * write-level trust as `aiConfig.upsert`, not a plain-member read like
 * `aiConfig.get`).
 */
export const list = accountQuery({
  args: {},
  handler: async (ctx) => {
    ctx.requireRole("admin");
    return await ctx.db
      .query("aiKnowledgeDocuments")
      .withIndex("by_account", (q) => q.eq("accountId", ctx.accountId))
      .order("desc")
      .collect();
  },
});

/**
 * Admin+ pastes in a new knowledge document. Inserts the row, then
 * hands the actual chunk+embed work to `ingest` via
 * `ctx.scheduler.runAfter(0, ...)` — same "insert now, do the slow part
 * async" split `webhookDelivery.ts` uses for outbound deliveries — so
 * this mutation returns immediately regardless of document length or
 * whether the account even has an embeddings key configured (`ingest`
 * itself figures that out).
 */
export const create = accountMutation({
  args: { title: v.string(), content: v.string() },
  handler: async (ctx, args) => {
    ctx.requireRole("admin");
    const documentId = await ctx.db.insert("aiKnowledgeDocuments", {
      accountId: ctx.accountId,
      createdByUserId: ctx.userId,
      title: args.title,
      content: args.content,
      updatedAt: Date.now(),
    });
    await ctx.scheduler.runAfter(0, internal.aiKnowledge.ingest, {
      documentId,
    });
    return documentId;
  },
});

/**
 * Admin+ deletes a document and cascades every chunk it produced
 * (`aiKnowledgeChunks` has no `ON DELETE` in Convex — same explicit-
 * cascade discipline as `broadcasts.remove`). Throws the same
 * `NOT_FOUND` for "doesn't exist" and "exists but isn't yours" on
 * purpose, so a cross-account probe can't distinguish the two (mirrors
 * `broadcasts.ts`'s `requireOwnBroadcast`).
 */
export const remove = accountMutation({
  args: { documentId: v.id("aiKnowledgeDocuments") },
  handler: async (ctx, args) => {
    ctx.requireRole("admin");
    const doc = await ctx.db.get(args.documentId);
    if (!doc || doc.accountId !== ctx.accountId) {
      throw new ConvexError({ code: "NOT_FOUND", entity: "document" });
    }
    await deleteChunksForDocument(ctx, args.documentId);
    await ctx.db.delete(args.documentId);
  },
});

// ============================================================
// Ingest — chunk + (optionally) embed one document, replacing its
// existing chunks.
// ============================================================

/**
 * Server-only load of a document by id (an `internalAction` has no
 * `ctx.db` of its own — every read goes through `ctx.runQuery`). Not
 * account-scoped by a session (there isn't one inside an action): the
 * caller (`ingest`) already has `documentId` from a trusted source
 * (either `create`'s own insert or a caller-supplied id that already
 * passed `remove`'s ownership check upstream), and returns the doc's
 * OWN `accountId` for `ingest` to scope everything else to.
 */
export const getDocument = internalQuery({
  args: { documentId: v.id("aiKnowledgeDocuments") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.documentId);
  },
});

/**
 * Delete-then-insert a document's chunk set in one transaction (an
 * `internalMutation` so `ingest` can call it via `ctx.runMutation`).
 * Re-ingesting the same document is idempotent BECAUSE this always
 * deletes the old set first — a second `ingest` run never leaves
 * duplicate/stale chunks behind, regardless of whether the new chunk
 * count differs from the old one.
 */
export const replaceChunks = internalMutation({
  args: {
    documentId: v.id("aiKnowledgeDocuments"),
    accountId: v.id("accounts"),
    chunks: v.array(
      v.object({
        chunkIndex: v.number(),
        content: v.string(),
        embedding: v.optional(v.array(v.float64())),
      }),
    ),
  },
  handler: async (ctx, args) => {
    await deleteChunksForDocument(ctx, args.documentId);
    for (const chunk of args.chunks) {
      await ctx.db.insert("aiKnowledgeChunks", {
        documentId: args.documentId,
        accountId: args.accountId,
        chunkIndex: chunk.chunkIndex,
        content: chunk.content,
        embedding: chunk.embedding,
      });
    }
  },
});

/**
 * (Re)build the chunks for one document — scheduled by `create`, and
 * safe to invoke again directly (e.g. a future "re-index" action) since
 * it's fully delete-then-insert. Loads the account's decrypted
 * `embeddingsApiKey` (`aiConfig.loadDecrypted`); when one is configured
 * — and this isn't a DRY-RUN — embeds every chunk via OpenAI
 * (`embedTexts`). A DRY-RUN, or an account with no embeddings key,
 * leaves every chunk's `embedding` unset (lexical-only, same as
 * Postgres leaving the column NULL).
 *
 * Best-effort on embed failure, exactly like the source's
 * `ingestDocument`: the lexical-only chunks are inserted regardless (a
 * failed embed must never cost the document its FTS searchability),
 * and the error is rethrown ONLY AFTER that insert succeeds — so it's
 * still visible (this action's own execution shows as failed, e.g. in
 * `npx convex logs`) without blocking persistence.
 */
export const ingest = internalAction({
  args: { documentId: v.id("aiKnowledgeDocuments") },
  handler: async (ctx, args): Promise<void> => {
    const doc = await ctx.runQuery(internal.aiKnowledge.getDocument, {
      documentId: args.documentId,
    });
    // Removed (e.g. `remove` ran) before this scheduled ingest fired —
    // nothing left to chunk.
    if (!doc) return;

    const chunks = chunkText(doc.content);

    let embeddings: number[][] | null = null;
    let embedError: unknown = null;

    if (chunks.length > 0) {
      const config = await ctx.runQuery(internal.aiConfig.loadDecrypted, {
        accountId: doc.accountId,
      });
      const embeddingsApiKey = config?.embeddingsApiKey ?? null;

      if (embeddingsApiKey) {
        if (isDryRun()) {
          embeddings = syntheticEmbeddings(chunks);
        } else {
          try {
            embeddings = await embedTexts(embeddingsApiKey, chunks);
          } catch (err) {
            embedError = err;
            embeddings = null;
          }
        }
      }
    }

    await ctx.runMutation(internal.aiKnowledge.replaceChunks, {
      documentId: args.documentId,
      accountId: doc.accountId,
      chunks: chunks.map((content, i) => ({
        chunkIndex: i,
        content,
        embedding: embeddings ? embeddings[i] : undefined,
      })),
    });

    if (embedError) throw embedError;
  },
});

// ============================================================
// Retrieve — semantic-primary, lexical-topped-up, hybrid search.
// ============================================================

/**
 * Hydrates `ctx.vectorSearch` hit ids into their chunk content
 * (an `internalAction` has no `ctx.db` of its own). RE-ASSERTS
 * `accountId` on every returned row even though `retrieve`'s
 * `ctx.vectorSearch` call already filtered by it — belt-and-braces
 * against a future caller of this query forgetting the same filter
 * (see this file's header comment on why isolation here is layered,
 * not single-point).
 */
export const getChunksByIds = internalQuery({
  args: {
    accountId: v.id("accounts"),
    ids: v.array(v.id("aiKnowledgeChunks")),
  },
  handler: async (ctx, args) => {
    const docs = await Promise.all(args.ids.map((id) => ctx.db.get(id)));
    return docs.filter(
      (doc): doc is Doc<"aiKnowledgeChunks"> =>
        doc !== null && doc.accountId === args.accountId,
    );
  },
});

/**
 * Lexical top-up via the `search_content` search index, filtered by
 * `accountId` — the sole retrieval path when the account has no
 * embeddings key, and a top-up on the semantic path otherwise. Same
 * `withSearchIndex(...).eq("accountId", ...)` shape as `contacts.ts`'s
 * `search_name` usage.
 */
export const searchChunks = internalQuery({
  args: {
    accountId: v.id("accounts"),
    queryText: v.string(),
    limit: v.number(),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("aiKnowledgeChunks")
      .withSearchIndex("search_content", (q) =>
        q.search("content", args.queryText).eq("accountId", args.accountId),
      )
      .take(args.limit);
  },
});

// ---- Knowledge Engine v2: the compiled `kbChunks` pool -------------
// `kbChunks` rows are produced by `kbCompile.ts` at publish time from
// structured `kbEntries`/`kbOpsBlocks`, and carry the metadata the
// legacy pool has no equivalent for: `serviceKey`, `entryType`, and
// `audience` ("customer" vs "internal"). These two queries are the
// `kbChunks` counterparts of `getChunksByIds`/`searchChunks` above and
// hold the same isolation discipline.

/**
 * Hydrates `ctx.vectorSearch` hit ids into the three fields `retrieve`'s
 * compiled semantic arm actually reads: `_id` (dedup key), `content`
 * (the payload) and `audience` (which that arm must post-filter in code
 * — see `retrieve` for why it can't live in the vector query).
 *
 * Projected rather than returning whole `Doc<"kbChunks">` rows on
 * purpose: every row carries a 1536-float `embedding`, and this runs
 * for up to `k * 2` rows on the hottest path in the app (an inbound
 * WhatsApp message). Shipping those vectors back over the action↔query
 * boundary would roughly triple the hydration payload for data the
 * caller discards immediately.
 *
 * RE-ASSERTS `accountId` on every row before projecting, exactly like
 * `getChunksByIds` — same belt-and-braces reasoning as this file's
 * header comment. The projection is a payload optimization layered on
 * top of that check, never a substitute for it.
 */
export const getKbChunksByIds = internalQuery({
  args: {
    accountId: v.id("accounts"),
    ids: v.array(v.id("kbChunks")),
  },
  handler: async (ctx, args) => {
    const docs = await Promise.all(args.ids.map((id) => ctx.db.get(id)));
    return docs
      .filter(
        (doc): doc is Doc<"kbChunks"> =>
          doc !== null && doc.accountId === args.accountId,
      )
      .map((doc) => ({
        _id: doc._id,
        content: doc.content,
        audience: doc.audience,
      }));
  },
});

/**
 * Lexical arm over the compiled pool via `kbChunks`'s own
 * `search_content` index. Unlike the vector index, a SEARCH index
 * supports chained `.eq()` across several `filterFields`, so this can
 * narrow `accountId` AND `audience` inline in one expression —
 * `retrieve`'s semantic arm has to post-filter `audience` in code
 * instead.
 *
 * `audience` is deliberately one-way: it only ever narrows to
 * "customer". There is no "internal" value to pass, because an
 * unfiltered call already sees everything.
 */
export const searchKbChunks = internalQuery({
  args: {
    accountId: v.id("accounts"),
    queryText: v.string(),
    limit: v.number(),
    audience: v.optional(v.literal("customer")),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("kbChunks")
      .withSearchIndex("search_content", (q) => {
        const base = q
          .search("content", args.queryText)
          .eq("accountId", args.accountId);
        return args.audience ? base.eq("audience", "customer") : base;
      })
      .take(args.limit);
  },
});

/**
 * Retrieve up to `k` knowledge excerpts relevant to `queryText`, for
 * the given account ONLY. Best-effort throughout — every external/
 * derived step is individually wrapped, so a failure in one (bad key,
 * provider outage, an empty knowledge base) degrades to fewer results
 * or another arm, and NEVER throws into the caller (Task 3's auto-reply
 * dispatch calls this on every inbound message — a retrieval hiccup
 * must not block the reply).
 *
 * Merges TWO pools, in this order:
 *   1. the COMPILED pool (`kbChunks`) — Knowledge Engine v2's
 *      publish-time output, entity-first and metadata-stamped;
 *   2. the LEGACY pool (`aiKnowledgeChunks`) — pasted documents.
 * Compiled chunks are ranked ahead on purpose (they carry a service /
 * audience header that grounds the model better than anonymous prose),
 * and the legacy pool fills whatever slots are left. Each pool is
 * semantic-primary when the account has an embeddings key configured
 * (`ctx.vectorSearch` over its `by_embedding` index, filtered to
 * `accountId`) and lexically topped up from its `search_content` index
 * (also filtered to `accountId`); lexical-only when there's no key.
 *
 * `audience: "customer"` narrows the COMPILED pool to customer-safe
 * chunks — it is what keeps `kbOpsBlocks`' internal sentinels (PURCHASE
 * CRITERIA and friends) out of a context that grounds a customer-facing
 * reply. It is deliberately ONE-WAY: there is no "internal" value,
 * because omitting the argument already sees everything. It cannot
 * apply to the legacy pool at all — those rows carry no audience
 * metadata — so an audience-filtered call still returns legacy chunks.
 *
 * An account with no `kbChunks` rows, called without `audience` (i.e.
 * every caller as of this phase), gets byte-identical results to the
 * pre-merge implementation: the compiled arms find nothing and the
 * legacy arms run exactly as they did.
 *
 * `k` defaults to 5 (matches `retrieveKnowledge`'s own default). Trims
 * `queryText` and returns `[]` immediately for a blank query or a
 * non-positive `k`, before any embedding/DB work.
 */
export const retrieve = internalAction({
  args: {
    accountId: v.id("accounts"),
    queryText: v.string(),
    k: v.optional(v.number()),
    audience: v.optional(v.literal("customer")),
  },
  handler: async (ctx, args): Promise<string[]> => {
    const k = args.k ?? 5;
    const query = args.queryText.trim();
    if (!query || k <= 0) return [];

    const audience = args.audience;

    // Both pools accumulate here, in rank order, deduped by CHUNK ID —
    // the pre-merge implementation's exact semantics (it kept a
    // `Map<Id<"aiKnowledgeChunks">, string>`, so a chunk surfaced by
    // both the semantic and the lexical arm was picked once). Convex
    // document ids are globally unique, so ONE set spans both pools
    // even though their id types differ.
    //
    // Deliberately NOT content-keyed: two distinct legacy rows with
    // byte-identical text (this account pastes its knowledge base in by
    // hand, so a re-pasted document or a repeated boilerplate paragraph
    // produces exactly that) must still consume two of the caller's `k`
    // slots, as they always have. Nor is dedup done across pools by
    // content — compiled chunks are emitted with a `[<Service> —
    // <Title>]` header a legacy chunk will essentially never byte-
    // match, so the collision isn't a real case and isn't worth the
    // behavioral subtlety.
    const pickedContents: string[] = [];
    const seenIds = new Set<string>();
    /**
     * Appends one chunk's content, at most once per chunk id and never
     * past `k`. Silently no-ops on BOTH conditions — an already-picked
     * id, or a result set that's already full — so every arm can just
     * feed it candidates in rank order and let it hold the contract.
     * That write-time cap is why the final array needs no trailing
     * slice.
     */
    const tryPush = (id: string, content: string) => {
      if (pickedContents.length >= k || seenIds.has(id)) return;
      seenIds.add(id);
      pickedContents.push(content);
    };

    // --- Query embedding — computed ONCE, shared by both pools -------
    // Hoisted above both passes deliberately: `retrieve` runs on every
    // inbound WhatsApp message, so embedding the same query a second
    // time would double this path's OpenAI cost and latency for no
    // benefit. `null` means "no embeddings key configured, or embedding
    // failed" — both semantic arms below are then skipped and the
    // lexical arms carry the whole retrieval, exactly as they already
    // do for a lexical-only account.
    let queryEmbedding: number[] | null = null;
    try {
      const config = await ctx.runQuery(internal.aiConfig.loadDecrypted, {
        accountId: args.accountId,
      });
      const embeddingsApiKey = config?.embeddingsApiKey ?? null;

      if (embeddingsApiKey) {
        const embedded = isDryRun()
          ? syntheticEmbedding(query)
          : (await embedTexts(embeddingsApiKey, [query]))[0];
        if (embedded) queryEmbedding = embedded;
      }
    } catch {
      // Best-effort: bad/rotated key, provider outage, malformed
      // response — degrade to the lexical arms instead of failing the
      // caller.
      queryEmbedding = null;
    }

    // --- Compiled pool (`kbChunks`), semantic arm -------------------
    // Convex vector-search filters support only single-field `eq`/`or`
    // within one expression — there is no cross-field AND — so this arm
    // CANNOT narrow `accountId` and `audience` together. It filters
    // `accountId` in the vector query (the isolation-critical half,
    // applied inside the ANN search itself, never a post-hoc scan) and
    // over-fetches `k * 2` so that post-filtering `audience` in code on
    // the hydrated rows still leaves candidates to fill `k`. Search
    // indexes are different — they DO support chained `.eq()` across
    // filter fields, which is why `searchKbChunks` narrows both inline.
    // Those hydrated rows are PROJECTED (`_id`/`content`/`audience`
    // only) — the 1536-float embeddings never ride back across this
    // boundary just to be discarded here.
    try {
      if (queryEmbedding) {
        const results = await ctx.vectorSearch("kbChunks", "by_embedding", {
          vector: queryEmbedding,
          limit: k * 2,
          filter: (q) => q.eq("accountId", args.accountId),
        });
        if (results.length > 0) {
          const rows = await ctx.runQuery(
            internal.aiKnowledge.getKbChunksByIds,
            { accountId: args.accountId, ids: results.map((r) => r._id) },
          );
          const rowById = new Map(rows.map((r) => [r._id, r]));
          for (const r of results) {
            const row = rowById.get(r._id);
            if (!row) continue;
            if (audience && row.audience !== "customer") continue;
            tryPush(row._id, row.content);
          }
        }
      }
    } catch {
      // Best-effort: fall through to the compiled lexical arm.
    }

    // --- Compiled pool, lexical arm ---------------------------------
    if (pickedContents.length < k) {
      try {
        const rows = await ctx.runQuery(internal.aiKnowledge.searchKbChunks, {
          accountId: args.accountId,
          queryText: query,
          limit: k,
          audience,
        });
        for (const row of rows) tryPush(row._id, row.content);
      } catch {
        // Best-effort: fall through to the legacy pool.
      }
    }

    // --- Legacy pool (`aiKnowledgeChunks`), semantic arm ------------
    // Skipped once the compiled pool has already filled `k` — every
    // `push` from here would be a no-op against the cap anyway, so
    // this saves a vector search plus a hydration query on the hot
    // inbound-message path without changing the result.
    if (pickedContents.length < k) {
      try {
        if (queryEmbedding) {
          // The `filter` below is what stands between this account's
          // question and every OTHER account's knowledge base — see
          // this file's header comment. `by_embedding`'s own
          // `filterFields: ["accountId"]` (convex/schema.ts) is what
          // makes filtering here possible at all.
          const results = await ctx.vectorSearch(
            "aiKnowledgeChunks",
            "by_embedding",
            {
              vector: queryEmbedding,
              limit: k,
              filter: (q) => q.eq("accountId", args.accountId),
            },
          );
          if (results.length > 0) {
            const chunks = await ctx.runQuery(
              internal.aiKnowledge.getChunksByIds,
              { accountId: args.accountId, ids: results.map((r) => r._id) },
            );
            const contentById = new Map(chunks.map((c) => [c._id, c.content]));
            for (const r of results) {
              const content = contentById.get(r._id);
              if (content !== undefined) tryPush(r._id, content);
            }
          }
        }
      } catch {
        // Best-effort: semantic retrieval failed — fall through to the
        // lexical top-up below instead of failing the caller.
      }
    }

    // --- Legacy pool, lexical top-up --------------------------------
    // (Also the sole path for an account with no embeddings key.)
    if (pickedContents.length < k) {
      try {
        const ftsChunks = await ctx.runQuery(internal.aiKnowledge.searchChunks, {
          accountId: args.accountId,
          queryText: query,
          limit: k,
        });
        for (const chunk of ftsChunks) tryPush(chunk._id, chunk.content);
      } catch {
        // Best-effort: return whatever the earlier arms already found.
      }
    }

    return pickedContents;
  },
});
