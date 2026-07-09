/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import type { AccountRole } from "./lib/roles";
import { chunkText } from "./lib/ai/chunk";
import { syntheticEmbedding } from "./aiKnowledge";
import { EMBEDDING_DIMENSIONS } from "./lib/ai/embeddings";

// Convex function modules for convex-test to resolve `api.*`/`internal.*`
// references against. Absolute, from-project-root pattern (matches every
// other `convex/*.test.ts` suite — see `convex/lib/auth.test.ts`'s
// comment for why this must be absolute rather than a relative "./**").
const modules = import.meta.glob("/convex/**/*.ts");

// DRY-RUN for every test in this file — `ingest`/`retrieve` skip the
// real OpenAI embeddings call under `CONVEX_AI_DRY_RUN`, substituting a
// deterministic seeded vector (`syntheticEmbedding`) instead, same env
// var convention as `metaSend.ts`'s `CONVEX_META_DRY_RUN` (see
// `webhookDelivery.test.ts`'s own header comment on why this suite
// otherwise couldn't run under the `edge-runtime` test environment
// anyway).
beforeEach(() => {
  process.env.CONVEX_AI_DRY_RUN = "1";
});
afterEach(() => {
  // Belt-and-suspenders: any test that opts into fake timers (the
  // `create`-schedules-`ingest` test below) restores real ones itself,
  // but a thrown assertion could skip that cleanup — guard every other
  // test in this file from inheriting fake timers (mirrors
  // `automationsEngine.test.ts`'s own afterEach).
  vi.useRealTimers();
  delete process.env.CONVEX_AI_DRY_RUN;
});

/**
 * Seeds a `users` row + an `accounts`/`memberships` row for a fresh
 * account, and returns a convex-test client already authenticated as
 * that user. Duplicated per-suite rather than imported — see
 * `convex/aiConfig.test.ts`'s own comment on this pattern.
 */
async function seedAccountMember(
  t: ReturnType<typeof convexTest>,
  opts: { name: string; email: string; role: AccountRole },
) {
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { name: opts.name, email: opts.email }),
  );
  const accountId = await t.run(async (ctx) => {
    const id = await ctx.db.insert("accounts", {
      name: `${opts.name}'s account`,
      defaultCurrency: "USD",
      ownerUserId: userId,
    });
    await ctx.db.insert("memberships", {
      userId,
      accountId: id,
      role: opts.role,
      fullName: opts.name,
      email: opts.email,
    });
    return id;
  });
  const asUser = t.withIdentity({
    subject: `${userId}|session-${opts.name}`,
  });
  return { userId, accountId, asUser };
}

/**
 * Adds a second membership row to an *existing* account — matches
 * `convex/aiConfig.test.ts`'s own `seedTeammate`.
 */
async function seedTeammate(
  t: ReturnType<typeof convexTest>,
  opts: {
    accountId: Id<"accounts">;
    name: string;
    email: string;
    role: AccountRole;
  },
) {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {
      name: opts.name,
      email: opts.email,
    });
    await ctx.db.insert("memberships", {
      userId,
      accountId: opts.accountId,
      role: opts.role,
      fullName: opts.name,
      email: opts.email,
    });
    return userId;
  });
}

/** Directly inserts an `aiKnowledgeDocuments` row, bypassing `create` —
 *  for tests that want full control over its chunks without driving the
 *  scheduler (matches `schema.test.ts`'s own direct-insert precedent). */
async function seedDocument(
  t: ReturnType<typeof convexTest>,
  opts: { accountId: Id<"accounts">; title: string; content: string },
) {
  return await t.run((ctx) =>
    ctx.db.insert("aiKnowledgeDocuments", {
      accountId: opts.accountId,
      title: opts.title,
      content: opts.content,
      updatedAt: Date.now(),
    }),
  );
}

/** Directly inserts an `aiKnowledgeChunks` row — for isolation tests
 *  that need precise, hand-picked embeddings/content per account. */
async function seedChunk(
  t: ReturnType<typeof convexTest>,
  opts: {
    accountId: Id<"accounts">;
    documentId: Id<"aiKnowledgeDocuments">;
    chunkIndex: number;
    content: string;
    embedding?: number[];
  },
) {
  return await t.run((ctx) =>
    ctx.db.insert("aiKnowledgeChunks", {
      accountId: opts.accountId,
      documentId: opts.documentId,
      chunkIndex: opts.chunkIndex,
      content: opts.content,
      embedding: opts.embedding,
    }),
  );
}

// Minimal valid `aiConfig.upsert` payload — matches `aiConfig.test.ts`'s
// own `BASE_ARGS`.
const BASE_AI_CONFIG_ARGS = {
  provider: "openai" as const,
  model: "gpt-4o-mini",
  isActive: true,
  autoReplyEnabled: false,
  autoReplyMaxPerConversation: 3,
};

/** Configures the caller's account with BOTH a chat key and an
 *  embeddings key, so `ingest`/`retrieve` take the semantic path. */
async function configureEmbeddingsKey(
  asUser: Awaited<ReturnType<typeof seedAccountMember>>["asUser"],
  embeddingsApiKey = "sk-embeddings-key",
) {
  await asUser.mutation(api.aiConfig.upsert, {
    ...BASE_AI_CONFIG_ARGS,
    apiKey: "sk-chat-key",
    embeddingsApiKey,
  });
}

// ============================================================
// documents.{list,create,remove} — admin-gated, account-scoped
// ============================================================

test("create/list/remove all throw FORBIDDEN for a caller below admin", async () => {
  const t = convexTest(schema, modules);
  const { asUser: asAlice, accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });
  const documentId = await asAlice.mutation(api.aiKnowledge.create, {
    title: "Shipping",
    content: "We ship worldwide within 3-5 business days.",
  });

  const bobId = await seedTeammate(t, {
    accountId,
    name: "Bob",
    email: "bob@example.com",
    role: "agent",
  });
  const asBob = t.withIdentity({ subject: `${bobId}|session-Bob` });

  await expect(
    asBob.mutation(api.aiKnowledge.create, {
      title: "x",
      content: "y",
    }),
  ).rejects.toMatchObject({ data: { code: "FORBIDDEN", min: "admin" } });

  await expect(asBob.query(api.aiKnowledge.list, {})).rejects.toMatchObject({
    data: { code: "FORBIDDEN", min: "admin" },
  });

  await expect(
    asBob.mutation(api.aiKnowledge.remove, { documentId }),
  ).rejects.toMatchObject({ data: { code: "FORBIDDEN", min: "admin" } });
});

test("create inserts a document owned by the caller's account; list is newest-first and never another account's docs", async () => {
  const t = convexTest(schema, modules);
  const { asUser: asAlice, accountId: aliceAccountId } =
    await seedAccountMember(t, {
      name: "Alice",
      email: "alice@example.com",
      role: "admin",
    });
  const { asUser: asBob } = await seedAccountMember(t, {
    name: "Bob",
    email: "bob@example.com",
    role: "admin",
  });

  const firstId = await asAlice.mutation(api.aiKnowledge.create, {
    title: "First",
    content: "First document content.",
  });
  const secondId = await asAlice.mutation(api.aiKnowledge.create, {
    title: "Second",
    content: "Second document content.",
  });
  await asBob.mutation(api.aiKnowledge.create, {
    title: "Bob's doc",
    content: "Bob's private content.",
  });

  const aliceDocs = await asAlice.query(api.aiKnowledge.list, {});
  expect(aliceDocs.map((d) => d._id)).toEqual([secondId, firstId]);
  expect(aliceDocs.every((d) => d.accountId === aliceAccountId)).toBe(true);

  const bobDocs = await asBob.query(api.aiKnowledge.list, {});
  expect(bobDocs).toHaveLength(1);
  expect(bobDocs[0]!.title).toBe("Bob's doc");
  expect(bobDocs.some((d) => d._id === firstId || d._id === secondId)).toBe(
    false,
  );
});

test("remove deletes the document and cascades its chunks; a different account gets NOT_FOUND and Alice's data is untouched", async () => {
  const t = convexTest(schema, modules);
  const { asUser: asAlice, accountId: aliceAccountId } =
    await seedAccountMember(t, {
      name: "Alice",
      email: "alice@example.com",
      role: "admin",
    });
  const { asUser: asBob } = await seedAccountMember(t, {
    name: "Bob",
    email: "bob@example.com",
    role: "admin",
  });

  const documentId = await seedDocument(t, {
    accountId: aliceAccountId,
    title: "Doc",
    content: "Some content.",
  });
  await seedChunk(t, {
    accountId: aliceAccountId,
    documentId,
    chunkIndex: 0,
    content: "Some content.",
  });

  // Bob (a different account entirely) cannot remove Alice's document.
  await expect(
    asBob.mutation(api.aiKnowledge.remove, { documentId }),
  ).rejects.toMatchObject({ data: { code: "NOT_FOUND", entity: "document" } });
  expect(await t.run((ctx) => ctx.db.get(documentId))).not.toBeNull();

  await asAlice.mutation(api.aiKnowledge.remove, { documentId });

  expect(await t.run((ctx) => ctx.db.get(documentId))).toBeNull();
  const remainingChunks = await t.run((ctx) =>
    ctx.db
      .query("aiKnowledgeChunks")
      .withIndex("by_document", (q) => q.eq("documentId", documentId))
      .collect(),
  );
  expect(remainingChunks).toHaveLength(0);
});

// ============================================================
// create → scheduled ingest
// ============================================================

test("create schedules ingest, which chunks the document and writes matching chunk rows", async () => {
  vi.useFakeTimers();
  const t = convexTest(schema, modules);
  const { asUser: asAlice, accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });

  // Two paragraphs of 700 chars: 700 + 2 + 700 = 1402 > the default
  // 1200-char budget, so `chunkText` splits them into two chunks —
  // exercises more than the single-chunk trivial case.
  const paraA = "A".repeat(700);
  const paraB = "B".repeat(700);
  const content = `${paraA}\n\n${paraB}`;

  const documentId = await asAlice.mutation(api.aiKnowledge.create, {
    title: "Policies",
    content,
  });

  await t.finishAllScheduledFunctions(vi.runAllTimers);

  const chunks = await t.run((ctx) =>
    ctx.db
      .query("aiKnowledgeChunks")
      .withIndex("by_document", (q) => q.eq("documentId", documentId))
      .collect(),
  );
  chunks.sort((a, b) => a.chunkIndex - b.chunkIndex);

  const expected = chunkText(content);
  expect(expected).toHaveLength(2);
  expect(chunks).toHaveLength(2);
  chunks.forEach((chunk, i) => {
    expect(chunk.chunkIndex).toBe(i);
    expect(chunk.content).toBe(expected[i]);
    expect(chunk.accountId).toBe(accountId);
    // No aiConfig/embeddings key configured — lexical-only.
    expect(chunk.embedding).toBeUndefined();
  });
});

// ============================================================
// ingest — direct invocation (bypassing the scheduler)
// ============================================================

test("ingest with an embeddings key configured writes a synthetic 1536-dim embedding per chunk", async () => {
  const t = convexTest(schema, modules);
  const { asUser: asAlice, accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });
  await configureEmbeddingsKey(asAlice);

  const content = "Our return policy is 30 days from delivery.";
  const documentId = await seedDocument(t, {
    accountId,
    title: "Returns",
    content,
  });

  await t.action(internal.aiKnowledge.ingest, { documentId });

  const chunks = await t.run((ctx) =>
    ctx.db
      .query("aiKnowledgeChunks")
      .withIndex("by_document", (q) => q.eq("documentId", documentId))
      .collect(),
  );
  expect(chunks).toHaveLength(1);
  expect(chunks[0]!.content).toBe(content);
  expect(chunks[0]!.embedding).toHaveLength(EMBEDDING_DIMENSIONS);
  // DRY-RUN embedding is a deterministic function of the chunk's own
  // content, so it matches the same call the test makes directly.
  expect(chunks[0]!.embedding).toEqual(syntheticEmbedding(content));
});

test("ingest with no embeddings key configured leaves every chunk's embedding unset", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });

  const documentId = await seedDocument(t, {
    accountId,
    title: "Hours",
    content: "We are open Monday to Friday, 9am to 5pm.",
  });

  await t.action(internal.aiKnowledge.ingest, { documentId });

  const chunks = await t.run((ctx) =>
    ctx.db
      .query("aiKnowledgeChunks")
      .withIndex("by_document", (q) => q.eq("documentId", documentId))
      .collect(),
  );
  expect(chunks).toHaveLength(1);
  expect(chunks[0]!.embedding).toBeUndefined();
});

test("ingest is delete-then-insert: re-ingesting replaces the chunk set instead of appending to it", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });

  const documentId = await seedDocument(t, {
    accountId,
    title: "Doc",
    content: "Original content, paragraph one.\n\nOriginal, paragraph two.",
  });

  await t.action(internal.aiKnowledge.ingest, { documentId });
  const firstPass = await t.run((ctx) =>
    ctx.db
      .query("aiKnowledgeChunks")
      .withIndex("by_document", (q) => q.eq("documentId", documentId))
      .collect(),
  );
  expect(firstPass.length).toBeGreaterThan(0);

  // Content changes (e.g. an edit) — re-ingest must REPLACE, not append.
  const newContent = "Completely different replacement content.";
  await t.run((ctx) => ctx.db.patch(documentId, { content: newContent }));
  await t.action(internal.aiKnowledge.ingest, { documentId });

  const secondPass = await t.run((ctx) =>
    ctx.db
      .query("aiKnowledgeChunks")
      .withIndex("by_document", (q) => q.eq("documentId", documentId))
      .collect(),
  );
  expect(secondPass).toHaveLength(1);
  expect(secondPass[0]!.content).toBe(newContent);
  // No duplicate/stale rows from the first pass survive.
  const allChunksForAccount = await t.run((ctx) =>
    ctx.db
      .query("aiKnowledgeChunks")
      .withIndex("by_account", (q) => q.eq("accountId", accountId))
      .collect(),
  );
  expect(allChunksForAccount).toHaveLength(1);
});

test("ingest on an already-removed document is a no-op, not a throw", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });
  const documentId = await seedDocument(t, {
    accountId,
    title: "Gone",
    content: "This will be deleted before ingest runs.",
  });
  await t.run((ctx) => ctx.db.delete(documentId));

  // Convex serializes a `void`/no-`return` action result as `null` over
  // the wire (there's no wire representation of JS `undefined`), not
  // `undefined` — the meaningful assertion is just "resolves, not
  // throws".
  await expect(
    t.action(internal.aiKnowledge.ingest, { documentId }),
  ).resolves.toBeNull();
});

// ============================================================
// retrieve — guards, FTS-only, and cross-account isolation
// ============================================================

test("retrieve returns [] immediately for a blank queryText or a non-positive k", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });

  await expect(
    t.action(internal.aiKnowledge.retrieve, {
      accountId,
      queryText: "   ",
      k: 5,
    }),
  ).resolves.toEqual([]);

  await expect(
    t.action(internal.aiKnowledge.retrieve, {
      accountId,
      queryText: "hello",
      k: 0,
    }),
  ).resolves.toEqual([]);
});

test("retrieve with no embeddings key uses FTS only and finds matching content", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });

  const documentId = await seedDocument(t, {
    accountId,
    title: "Warranty",
    content: "Our warranty covers manufacturing defects for one year.",
  });
  await t.action(internal.aiKnowledge.ingest, { documentId });

  const results = await t.action(internal.aiKnowledge.retrieve, {
    accountId,
    queryText: "warranty",
    k: 5,
  });

  expect(results).toEqual([
    "Our warranty covers manufacturing defects for one year.",
  ]);
});

test("retrieve isolation (FTS path): a decoy account's matching chunk is never returned, even though it shares the query keyword", async () => {
  const t = convexTest(schema, modules);
  const { accountId: aliceAccountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });
  const { accountId: bobAccountId } = await seedAccountMember(t, {
    name: "Bob",
    email: "bob@example.com",
    role: "admin",
  });

  const aliceDocId = await seedDocument(t, {
    accountId: aliceAccountId,
    title: "Alice mango doc",
    content: "Alice mango policy: returns accepted within 30 days.",
  });
  await seedChunk(t, {
    accountId: aliceAccountId,
    documentId: aliceDocId,
    chunkIndex: 0,
    content: "Alice mango policy: returns accepted within 30 days.",
  });

  // Decoy: a DIFFERENT account's chunk containing the SAME keyword
  // ("mango") — neither account has an embeddings key configured, so
  // `retrieve` is on the FTS-only branch for both.
  const bobDocId = await seedDocument(t, {
    accountId: bobAccountId,
    title: "Bob mango doc",
    content: "Bob mango secret: confidential supplier is Mango Corp.",
  });
  await seedChunk(t, {
    accountId: bobAccountId,
    documentId: bobDocId,
    chunkIndex: 0,
    content: "Bob mango secret: confidential supplier is Mango Corp.",
  });

  const results = await t.action(internal.aiKnowledge.retrieve, {
    accountId: aliceAccountId,
    queryText: "mango",
    k: 5,
  });

  expect(results).toEqual([
    "Alice mango policy: returns accepted within 30 days.",
  ]);
  expect(results.some((c) => c.includes("Bob"))).toBe(false);
});

test("retrieve isolation (vector path): a decoy account's chunk is never returned, even when it is a PERFECT cosine match", async () => {
  const t = convexTest(schema, modules);
  const { asUser: asAlice, accountId: aliceAccountId } =
    await seedAccountMember(t, {
      name: "Alice",
      email: "alice@example.com",
      role: "admin",
    });
  const { accountId: bobAccountId } = await seedAccountMember(t, {
    name: "Bob",
    email: "bob@example.com",
    role: "admin",
  });
  // Only Alice has an embeddings key — retrieve(Alice, ...) takes the
  // semantic path; whether Bob has one configured is irrelevant, since
  // isolation must hold on Alice's OWN retrieval regardless.
  await configureEmbeddingsKey(asAlice);

  // Deliberately shares NO word with Alice's own content below — if the
  // lexical FTS top-up could ALSO find Alice's chunk for this query, a
  // regression that dropped ONLY `ctx.vectorSearch`'s `accountId`
  // filter (while `getChunksByIds`'s own defense-in-depth re-check
  // stayed intact) would still surface Alice's content via that FTS
  // fallback — silently masking the very regression this test exists
  // to catch. With no lexical overlap, the ONLY way Alice's content can
  // come back at all is via a correctly-scoped vector search.
  const queryText = "telescope aquarium maintenance";

  const aliceDocId = await seedDocument(t, {
    accountId: aliceAccountId,
    title: "Alice shipping",
    content: "Alice shipping policy: ships in 3-5 business days.",
  });
  await seedChunk(t, {
    accountId: aliceAccountId,
    documentId: aliceDocId,
    chunkIndex: 0,
    content: "Alice shipping policy: ships in 3-5 business days.",
    embedding: syntheticEmbedding(
      "Alice shipping policy: ships in 3-5 business days.",
    ),
  });

  // Decoy: a DIFFERENT account's chunk whose embedding is engineered to
  // be the query's EXACT vector — a perfect (cosine similarity 1.0)
  // match, deliberately stronger than Alice's own chunk. If the
  // `accountId` filter on `ctx.vectorSearch` were broken, THIS is what
  // would come back instead of Alice's own (weaker-similarity) chunk.
  const bobDocId = await seedDocument(t, {
    accountId: bobAccountId,
    title: "Bob confidential",
    content: "Bob confidential internal notes — not Alice's account.",
  });
  await seedChunk(t, {
    accountId: bobAccountId,
    documentId: bobDocId,
    chunkIndex: 0,
    content: "Bob confidential internal notes — not Alice's account.",
    embedding: syntheticEmbedding(queryText),
  });

  // k = 1: the semantic pass alone fills the one slot, so the lexical
  // top-up never runs — this result is attributable to the vector path
  // ALONE, with zero ambiguity from FTS mixing in.
  const results = await t.action(internal.aiKnowledge.retrieve, {
    accountId: aliceAccountId,
    queryText,
    k: 1,
  });

  expect(results).toEqual([
    "Alice shipping policy: ships in 3-5 business days.",
  ]);
});
