import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { embedTexts } from "./lib/ai/embeddings";
import { isDryRun, syntheticEmbeddings } from "./aiKnowledge";
import { planEntryChunks, planOpsChunks } from "./lib/kb/compilePure";

// ============================================================
// Knowledge Engine v2 (Phase 1) — the publish-time compiler. Turns a
// published `kbEntries`/`kbOpsBlocks` row into the `kbChunks` rows
// retrieval actually searches: it reads the published row, plans its
// chunks (`planEntryChunks`/`planOpsChunks` — pure, Tasks 2-4), best-
// effort embeds them, and replaces that source's chunk set in one
// delete-then-insert transaction.
//
// `kbEntries.publish`/`unpublish` (Task 6) and `kbOps.publish`/
// `unpublish` (Task 7) both `ctx.scheduler.runAfter(0, ...)` into
// `compileEntry`/`compileOps` — publish AND unpublish alike, since
// unpublishing is exactly "recompile this source's now-non-published
// row", which naturally resolves to an empty chunk set (see below).
//
// Design rules (mirrors `aiKnowledge.ts`'s `ingest`/`replaceChunks`
// throughout — see that file's own header comment):
//   - Delete-then-insert (`replaceEntryChunks`/`replaceOpsChunks`) is
//     what makes recompiling idempotent: a source's OLD chunk set is
//     always deleted before its new one is inserted, so recompiling
//     never leaves duplicate/stale rows behind regardless of whether
//     the chunk count changed.
//   - A row that is missing, OR present but not `status: "published"`,
//     compiles to `chunks: []` — that is not an error path, it is how
//     unpublishing (or a since-deleted row racing a stale scheduled
//     compile) takes content OUT of retrieval.
//   - Ops chunks are unconditionally `audience: "internal"`
//     (`replaceOpsChunks` hardcodes it) — checklists and purchase
//     criteria are engine steering, never customer-facing text, so this
//     is never taken from an argument.
//   - Embedding is best-effort with the exact failure contract
//     `ingest` (lines ~285-318) already established: DRY-RUN substitutes
//     deterministic synthetic vectors instead of calling OpenAI; a real
//     embed failure still lets the lexical-only chunks persist, and the
//     error is rethrown only AFTER that insert succeeds — a failed embed
//     must never cost the content its searchability.
// ============================================================

const chunkPayload = v.array(v.object({
  chunkIndex: v.number(),
  content: v.string(),
  embedding: v.optional(v.array(v.float64())),
}));

/**
 * Loads a `kbEntries` row plus its service's display name (an
 * `internalAction` has no `ctx.db` of its own — every read `compileEntry`
 * needs goes through `ctx.runQuery`). Returns `null` when the row is
 * gone — `compileEntry` treats that as "nothing to compile", not an
 * error (see this module's header comment). `serviceName` is `null` for
 * a `scope: "company"` entry (no `serviceKey` at all); `planEntryChunks`
 * falls back to "Company" in that case.
 */
export const getEntryContext = internalQuery({
  args: { entryId: v.id("kbEntries") },
  handler: async (ctx, args) => {
    const entry = await ctx.db.get(args.entryId);
    if (!entry) return null;
    let serviceName: string | null = null;
    if (entry.serviceKey) {
      const service = await ctx.db.query("kbServices")
        .withIndex("by_account_key", (q) =>
          q.eq("accountId", entry.accountId).eq("key", entry.serviceKey!))
        .unique();
      serviceName = service?.name ?? null;
    }
    return { entry, serviceName };
  },
});

/**
 * Loads a `kbOpsBlocks` row plus its service's display name, same
 * `ctx.runQuery`-only shape as `getEntryContext`. Unlike an entry, an
 * ops block always has a `serviceKey` (required, not optional, on
 * `kbOpsBlocks`) — but the service row itself could still be missing
 * (e.g. deleted out from under it), so this falls back to the raw
 * `serviceKey` slug rather than ever returning a `null` name, matching
 * `kbEntries.ts`'s own comment that a rendered heading must always name
 * something.
 */
export const getOpsContext = internalQuery({
  args: { opsBlockId: v.id("kbOpsBlocks") },
  handler: async (ctx, args) => {
    const ops = await ctx.db.get(args.opsBlockId);
    if (!ops) return null;
    const service = await ctx.db.query("kbServices")
      .withIndex("by_account_key", (q) =>
        q.eq("accountId", ops.accountId).eq("key", ops.serviceKey))
      .unique();
    return { ops, serviceName: service?.name ?? ops.serviceKey };
  },
});

/**
 * Delete-then-insert one entry's `kbChunks` set (sourceKind `"entry"`)
 * via the `by_entry` index — the same idempotency pattern as
 * `aiKnowledge.ts`'s `replaceChunks`. An `internalMutation` so
 * `compileEntry` can call it via `ctx.runMutation` after planning/
 * embedding outside a transaction. Called with `chunks: []` to clear an
 * entry's chunks entirely (the unpublish/missing-row path).
 */
export const replaceEntryChunks = internalMutation({
  args: {
    entryId: v.id("kbEntries"),
    accountId: v.id("accounts"),
    serviceKey: v.optional(v.string()),
    entryType: v.string(),
    audience: v.union(v.literal("customer"), v.literal("internal")),
    chunks: chunkPayload,
  },
  handler: async (ctx, args) => {
    const old = await ctx.db.query("kbChunks")
      .withIndex("by_entry", (q) => q.eq("entryId", args.entryId)).collect();
    for (const c of old) await ctx.db.delete(c._id);
    for (const chunk of args.chunks) {
      await ctx.db.insert("kbChunks", {
        accountId: args.accountId,
        sourceKind: "entry",
        entryId: args.entryId,
        serviceKey: args.serviceKey,
        entryType: args.entryType,
        audience: args.audience,
        chunkIndex: chunk.chunkIndex,
        content: chunk.content,
        embedding: chunk.embedding,
      });
    }
  },
});

/**
 * Delete-then-insert one ops block's `kbChunks` set (sourceKind
 * `"ops"`) via the `by_ops_block` index — same idempotency pattern as
 * `replaceEntryChunks` above. `audience: "internal"` is HARDCODED here,
 * not taken from an argument: checklists and purchase criteria are
 * engine steering, never customer-facing text (this module's header
 * comment).
 */
export const replaceOpsChunks = internalMutation({
  args: {
    opsBlockId: v.id("kbOpsBlocks"),
    accountId: v.id("accounts"),
    serviceKey: v.string(),
    chunks: chunkPayload,
  },
  handler: async (ctx, args) => {
    const old = await ctx.db.query("kbChunks")
      .withIndex("by_ops_block", (q) => q.eq("opsBlockId", args.opsBlockId)).collect();
    for (const c of old) await ctx.db.delete(c._id);
    for (const chunk of args.chunks) {
      await ctx.db.insert("kbChunks", {
        accountId: args.accountId,
        sourceKind: "ops",
        opsBlockId: args.opsBlockId,
        serviceKey: args.serviceKey,
        audience: "internal",
        chunkIndex: chunk.chunkIndex,
        content: chunk.content,
        embedding: chunk.embedding,
      });
    }
  },
});

/**
 * Best-effort embed, identical semantics to `aiKnowledge.ingest`
 * (lines ~285-318): no account embeddings key configured → skip
 * embedding entirely (lexical-only, not an error); DRY-RUN → deterministic
 * synthetic vectors instead of calling OpenAI; a real `embedTexts`
 * failure → `embeddings: null` plus the caught error, so the caller can
 * still persist the lexical-only chunks and rethrow only afterward.
 * `ctx` is narrowed to just `runQuery` (the only capability this helper
 * needs) rather than the full `ActionCtx`, mirroring how `aiKnowledge.ts`
 * narrows its own action helpers (e.g. `deleteChunksForDocument`'s
 * `{ db: MutationCtx["db"] }`).
 */
async function embedPlans(
  ctx: Pick<ActionCtx, "runQuery">,
  accountId: Id<"accounts">,
  contents: string[],
): Promise<{ embeddings: number[][] | null; embedError: unknown }> {
  if (contents.length === 0) return { embeddings: null, embedError: null };
  const config = await ctx.runQuery(internal.aiConfig.loadDecrypted, { accountId });
  const embeddingsApiKey = config?.embeddingsApiKey ?? null;
  if (!embeddingsApiKey) return { embeddings: null, embedError: null };
  if (isDryRun()) return { embeddings: syntheticEmbeddings(contents), embedError: null };
  try {
    return { embeddings: await embedTexts(embeddingsApiKey, contents), embedError: null };
  } catch (err) {
    return { embeddings: null, embedError: err };
  }
}

/**
 * (Re)builds one entry's `kbChunks` — scheduled by both
 * `kbEntries.publish` and `kbEntries.unpublish`. A missing row (e.g.
 * `remove` raced a still-pending scheduled compile — `kbEntries.remove`
 * does not cancel one) or one that isn't `status: "published"` (the
 * unpublish path) both resolve to replacing with `chunks: []`, clearing
 * the entry out of retrieval rather than throwing. Otherwise: plan via
 * `planEntryChunks`, best-effort embed, replace — then rethrow any embed
 * error AFTER the (lexical-only, if embedding failed) chunks are safely
 * persisted.
 */
export const compileEntry = internalAction({
  args: { entryId: v.id("kbEntries") },
  handler: async (ctx, args): Promise<void> => {
    const context = await ctx.runQuery(internal.kbCompile.getEntryContext, {
      entryId: args.entryId,
    });
    if (!context) return;
    const { entry, serviceName } = context;
    if (entry.status !== "published") {
      await ctx.runMutation(internal.kbCompile.replaceEntryChunks, {
        entryId: args.entryId, accountId: entry.accountId,
        serviceKey: entry.serviceKey, entryType: entry.type,
        audience: entry.audience, chunks: [],
      });
      return;
    }
    const plans = planEntryChunks({ serviceName, title: entry.title, body: entry.body });
    const { embeddings, embedError } = await embedPlans(
      ctx, entry.accountId, plans.map((p) => p.content));
    await ctx.runMutation(internal.kbCompile.replaceEntryChunks, {
      entryId: args.entryId,
      accountId: entry.accountId,
      serviceKey: entry.serviceKey,
      entryType: entry.type,
      audience: entry.audience,
      chunks: plans.map((p, i) => ({
        chunkIndex: p.chunkIndex,
        content: p.content,
        embedding: embeddings ? embeddings[i] : undefined,
      })),
    });
    if (embedError) throw embedError;
  },
});

/**
 * (Re)builds one ops block's `kbChunks` — scheduled by both
 * `kbOps.publish` and `kbOps.unpublish`. Same missing-row/not-published
 * → `chunks: []` shape as `compileEntry` above; otherwise plans via
 * `planOpsChunks` (always at most ONE sentinel chunk — see that
 * function's own comment on why a checklist is never split), best-
 * effort embeds, replaces, and rethrows any embed error after that
 * insert succeeds.
 */
export const compileOps = internalAction({
  args: { opsBlockId: v.id("kbOpsBlocks") },
  handler: async (ctx, args): Promise<void> => {
    const context = await ctx.runQuery(internal.kbCompile.getOpsContext, {
      opsBlockId: args.opsBlockId,
    });
    if (!context) return;
    const { ops, serviceName } = context;
    if (ops.status !== "published") {
      await ctx.runMutation(internal.kbCompile.replaceOpsChunks, {
        opsBlockId: args.opsBlockId, accountId: ops.accountId,
        serviceKey: ops.serviceKey, chunks: [],
      });
      return;
    }
    const plans = planOpsChunks(serviceName, {
      kind: ops.kind, criteria: ops.criteria, steps: ops.steps,
      conditions: ops.conditions, reportValue: ops.reportValue, currency: ops.currency,
    });
    const { embeddings, embedError } = await embedPlans(
      ctx, ops.accountId, plans.map((p) => p.content));
    await ctx.runMutation(internal.kbCompile.replaceOpsChunks, {
      opsBlockId: args.opsBlockId,
      accountId: ops.accountId,
      serviceKey: ops.serviceKey,
      chunks: plans.map((p, i) => ({
        chunkIndex: p.chunkIndex,
        content: p.content,
        embedding: embeddings ? embeddings[i] : undefined,
      })),
    });
    if (embedError) throw embedError;
  },
});
