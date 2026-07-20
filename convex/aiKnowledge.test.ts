/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
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

// ============================================================
// retrieve — Knowledge Engine v2 merge: compiled `kbChunks` ranked
// ahead of the legacy `aiKnowledgeChunks` pool, with an optional
// one-way `audience: "customer"` narrowing.
// ============================================================

describe("retrieve merge", () => {
  test("compiled chunks rank ahead of legacy chunks", async () => {
    const t = convexTest(schema, modules);
    const { asUser, accountId } = await seedAccountMember(t, {
      name: "A",
      email: "a@x.co",
      role: "admin",
    });
    // Semantic path for BOTH pools — the compiled pass's lead is a
    // property of pass ORDER, not of one pool happening to be the only
    // one with embeddings.
    await configureEmbeddingsKey(asUser);

    const legacyContent = "Georgia visa notes legacy";
    const compiledContent =
      "[Georgia — Visa requirements]\nGeorgia visa passport rules";

    const documentId = await seedDocument(t, {
      accountId,
      title: "Legacy Georgia",
      content: legacyContent,
    });
    await seedChunk(t, {
      accountId,
      documentId,
      chunkIndex: 0,
      content: legacyContent,
      embedding: syntheticEmbedding(legacyContent),
    });
    await t.run(async (ctx) => {
      const entryId = await ctx.db.insert("kbEntries", {
        accountId,
        scope: "service",
        serviceKey: "georgia",
        type: "requirements",
        title: "Visa requirements",
        body: "x",
        audience: "customer",
        status: "published",
        version: 1,
        updatedAt: Date.now(),
      });
      await ctx.db.insert("kbChunks", {
        accountId,
        sourceKind: "entry",
        entryId,
        serviceKey: "georgia",
        entryType: "requirements",
        audience: "customer",
        chunkIndex: 0,
        content: compiledContent,
        embedding: syntheticEmbedding(compiledContent),
      });
    });

    const results = await t.action(internal.aiKnowledge.retrieve, {
      accountId,
      queryText: "Georgia visa",
      k: 5,
    });

    // Compiled first — it carries the self-identifying service header.
    expect(results[0]).toContain("[Georgia — Visa requirements]");
    // …and the legacy pool is still merged in behind it, not displaced.
    expect(results).toContain(legacyContent);
  });

  test("audience 'customer' excludes internal compiled chunks but keeps legacy", async () => {
    const t = convexTest(schema, modules);
    const { accountId } = await seedAccountMember(t, {
      name: "A",
      email: "a@x.co",
      role: "admin",
    });

    const legacyContent = "Georgia purchase info for customers";

    await t.run(async (ctx) => {
      const opsId = await ctx.db.insert("kbOpsBlocks", {
        accountId,
        serviceKey: "georgia",
        kind: "purchase",
        conditions: [{ key: "b", label: "Budget threshold" }],
        status: "published",
        version: 1,
        updatedAt: Date.now(),
      });
      await ctx.db.insert("kbChunks", {
        accountId,
        sourceKind: "ops",
        opsBlockId: opsId,
        serviceKey: "georgia",
        audience: "internal",
        chunkIndex: 0,
        content: "PURCHASE CRITERIA — Georgia\n- Budget threshold",
      });
    });
    const documentId = await seedDocument(t, {
      accountId,
      title: "Legacy",
      content: legacyContent,
    });
    await seedChunk(t, {
      accountId,
      documentId,
      chunkIndex: 0,
      content: legacyContent,
    });

    const customerSafe = await t.action(internal.aiKnowledge.retrieve, {
      accountId,
      queryText: "Georgia purchase",
      audience: "customer",
    });
    // The internal ops sentinel must never reach a customer-facing
    // grounding context…
    expect(customerSafe.some((c) => c.includes("PURCHASE CRITERIA"))).toBe(
      false,
    );
    // …but legacy chunks carry no audience metadata at all, so the
    // filter cannot apply to them — they still come back. Expected: an
    // unfiltered legacy pool is exactly today's behavior, unchanged.
    expect(customerSafe).toContain(legacyContent);

    const unfiltered = await t.action(internal.aiKnowledge.retrieve, {
      accountId,
      queryText: "Georgia purchase",
    });
    // No `audience` argument → the filter is absent entirely, so the
    // internal chunk is visible (the engine's own retrieval path).
    expect(unfiltered.some((c) => c.includes("PURCHASE CRITERIA"))).toBe(true);
  });

  test("the compiled semantic arm's k*2 over-fetch is still capped by the compiled budget", async () => {
    const t = convexTest(schema, modules);
    const { asUser, accountId } = await seedAccountMember(t, {
      name: "A",
      email: "a@x.co",
      role: "admin",
    });
    await configureEmbeddingsKey(asUser);

    // The compiled semantic arm deliberately over-fetches `k * 2` so
    // that post-filtering `audience` in code still has candidates left.
    // Seed more than that, so an unbounded arm would blow past `k`:
    // `tryPush`'s cap is the ONLY thing holding the contract here (the
    // pre-merge implementation had a second guard — a trailing
    // `.slice(0, k)` — which this rewrite drops).
    await t.run(async (ctx) => {
      for (let i = 0; i < 9; i++) {
        const content = `[Georgia — Note ${i}]\nGeorgia visa detail ${i}`;
        await ctx.db.insert("kbChunks", {
          accountId,
          sourceKind: "entry",
          serviceKey: "georgia",
          entryType: "note",
          audience: "customer",
          chunkIndex: i,
          content,
          embedding: syntheticEmbedding(content),
        });
      }
    });

    const results = await t.action(internal.aiKnowledge.retrieve, {
      accountId,
      queryText: "Georgia visa",
      k: 3,
    });
    // Capped at `k` — never at the 6 rows the `k * 2` over-fetch pulled
    // back, and never at the 9 seeded. `tryPush`'s cap is the ONLY thing
    // holding that contract, including on the final top-up pass, which
    // replays the retained over-fetch candidates against the full `k`.
    // (The migration-window budget bounds only the FIRST compiled pass —
    // `ceil(3 / 2)` = 2 here — and this account has no legacy chunks, so
    // the 1 slot reserved for that pool comes back to compiled rather
    // than going unfilled. See `retrieve`'s `compiledBudget` comment.)
    expect(results).toHaveLength(3);
    expect(new Set(results).size).toBe(3);
  });

  test("audience 'customer' also filters the compiled SEMANTIC arm, which cannot filter it in the vector query", async () => {
    const t = convexTest(schema, modules);
    const { asUser, accountId } = await seedAccountMember(t, {
      name: "A",
      email: "a@x.co",
      role: "admin",
    });
    await configureEmbeddingsKey(asUser);

    // Every row embedded, so the vector arm genuinely runs. Convex
    // vector filters take a single field, so `audience` CANNOT be part
    // of the vector query — it is post-filtered on the hydrated rows.
    // This is the arm that would leak internal content if that
    // post-filter were ever dropped.
    //
    // The internal rows deliberately do NOT contain the query term
    // ("Georgia"), so the compiled LEXICAL arm can never surface them —
    // its `search_content` match would miss. That keeps this test
    // pinned to the arm it is named for: the only way an internal row
    // reaches the `unfiltered` result below is the semantic arm, so the
    // non-vacuity check at the end proves that arm ran, and the
    // customer-safe assertion above proves its post-filter is what
    // withheld them. (Vector search ranks by cosine over the seeded
    // synthetic embeddings and is indifferent to the missing term, so
    // the semantic arm still returns every row.)
    await t.run(async (ctx) => {
      for (let i = 0; i < 4; i++) {
        const content = `INTERNAL ops sentinel ${i} — supplier margin floor`;
        await ctx.db.insert("kbChunks", {
          accountId,
          sourceKind: "ops",
          serviceKey: "georgia",
          audience: "internal",
          chunkIndex: i,
          content,
          embedding: syntheticEmbedding(content),
        });
      }
      for (let i = 0; i < 2; i++) {
        const content = `[Georgia — Visa ${i}]\nGeorgia visa customer detail ${i}`;
        await ctx.db.insert("kbChunks", {
          accountId,
          sourceKind: "entry",
          serviceKey: "georgia",
          entryType: "requirements",
          audience: "customer",
          chunkIndex: i,
          content,
          embedding: syntheticEmbedding(content),
        });
      }
    });

    const customerSafe = await t.action(internal.aiKnowledge.retrieve, {
      accountId,
      queryText: "Georgia",
      k: 5,
      audience: "customer",
    });
    expect(customerSafe.some((c) => c.includes("INTERNAL ops sentinel"))).toBe(
      false,
    );
    expect(customerSafe.length).toBeGreaterThan(0);

    // Unfiltered, the same query DOES reach the internal rows — proof
    // the assertion above is the filter's doing, not the corpus's.
    const unfiltered = await t.action(internal.aiKnowledge.retrieve, {
      accountId,
      queryText: "Georgia",
      k: 5,
    });
    expect(unfiltered.some((c) => c.includes("INTERNAL ops sentinel"))).toBe(
      true,
    );
  });

  test("no kb rows + no audience arg → legacy behavior identical", async () => {
    const t = convexTest(schema, modules);
    const { accountId } = await seedAccountMember(t, {
      name: "A",
      email: "a@x.co",
      role: "admin",
    });

    const documentId = await seedDocument(t, {
      accountId,
      title: "Doc",
      content: "alpha beta gamma",
    });
    await seedChunk(t, {
      accountId,
      documentId,
      chunkIndex: 0,
      content: "alpha beta gamma",
    });

    // The byte-compatibility case: an account that has never published a
    // compiled chunk, called the way every current caller calls it.
    expect(
      await t.action(internal.aiKnowledge.retrieve, {
        accountId,
        queryText: "alpha",
      }),
    ).toEqual(["alpha beta gamma"]);
  });

  test("two legacy chunks with identical content each still consume a slot", async () => {
    const t = convexTest(schema, modules);
    const { accountId } = await seedAccountMember(t, {
      name: "A",
      email: "a@x.co",
      role: "admin",
    });

    // Byte-identical content across two DISTINCT rows is a real shape
    // for this account, whose knowledge base is maintained by pasting
    // documents in by hand: the same document pasted twice, or one
    // boilerplate paragraph repeated across several pasted documents,
    // chunks to exactly this.
    //
    // The pre-merge implementation keyed its dedup on the CHUNK ID (a
    // `Map<Id<"aiKnowledgeChunks">, string>`), so both rows came back
    // and each consumed one of the caller's `k` slots — the same string
    // twice. Content-keyed dedup would instead collapse them into one
    // and hand the freed slot to the next distinct chunk, changing both
    // membership and count. Byte-compatibility of the legacy path means
    // the duplicate must still appear TWICE.
    const content = "refunds are processed within 14 days";
    for (const title of ["Pasted once", "Pasted again"]) {
      const documentId = await seedDocument(t, {
        accountId,
        title,
        content,
      });
      await seedChunk(t, {
        accountId,
        documentId,
        chunkIndex: 0,
        content,
      });
    }

    // No embeddings key and no `audience` — the lexical-only legacy
    // path, exactly how a no-key account has always been served.
    expect(
      await t.action(internal.aiKnowledge.retrieve, {
        accountId,
        queryText: "refunds",
      }),
    ).toEqual([content, content]);
  });

  test("the compiled pool cannot claim every slot — legacy keeps its share at the default k", async () => {
    const t = convexTest(schema, modules);
    const { asUser, accountId } = await seedAccountMember(t, {
      name: "A",
      email: "a@x.co",
      role: "admin",
    });
    await configureEmbeddingsKey(asUser);

    // Eight compiled chunks — more than the default `k`, so an
    // unbudgeted compiled pass fills every slot on its own. This is the
    // shape of a real FIRST publish: one entry compiles to several
    // chunks, and `ctx.vectorSearch` applies no relevance floor, so they
    // come back as best-of-pool however off-topic they are.
    await t.run(async (ctx) => {
      for (let i = 0; i < 8; i++) {
        const content = `[Georgia — Note ${i}]\nGeorgia compiled detail ${i}`;
        await ctx.db.insert("kbChunks", {
          accountId,
          sourceKind: "entry",
          serviceKey: "georgia",
          entryType: "note",
          audience: "customer",
          chunkIndex: i,
          content,
          embedding: syntheticEmbedding(content),
        });
      }
    });

    // …against a section that still lives ONLY in a pasted legacy
    // document. The three engines' checklists are exactly this until
    // Phase 3 migrates them, which is what makes starving this pool a
    // silent, total cutover rather than a ranking nit.
    const legacyContent = "QUALIFICATION CHECKLIST — Georgia\n- Travel dates";
    const documentId = await seedDocument(t, {
      accountId,
      title: "KB 3 — Georgia",
      content: legacyContent,
    });
    await seedChunk(t, {
      accountId,
      documentId,
      chunkIndex: 0,
      content: legacyContent,
      embedding: syntheticEmbedding(legacyContent),
    });

    // Default `k` and no `audience` — what every live caller passes.
    const results = await t.action(internal.aiKnowledge.retrieve, {
      accountId,
      queryText: "Georgia",
    });

    // The point of the guard: publishing to v2 must not silently cut the
    // legacy pool out from under the engines. THIS is the assertion the
    // budget exists for, and it holds simultaneously with the top-up
    // covered by the next test — reserving and reclaiming are not in
    // tension, because legacy gets first refusal on the reserved slots
    // and only what it declines goes back.
    expect(results).toContain(legacyContent);
    // The reserved portion is `ceil(5 / 2)` = 3 compiled, then legacy
    // takes its pick of the remaining 2 — but only one legacy chunk
    // exists, so the slot it leaves unused returns to the compiled pool
    // as a 4th compiled excerpt rather than being forfeited.
    expect(
      results.filter((c) => c.startsWith("[Georgia — Note")),
    ).toHaveLength(4);
    expect(results).toHaveLength(5);
  });

  test("a fully migrated account still gets the full k — unused reserved slots go back to the compiled pool", async () => {
    const t = convexTest(schema, modules);
    const { asUser, accountId } = await seedAccountMember(t, {
      name: "A",
      email: "a@x.co",
      role: "admin",
    });
    await configureEmbeddingsKey(asUser);

    // Eight compiled chunks — more than the default `k` — and NO legacy
    // document at all. That is the far end of the migration, reachable
    // today: publish to v2, then delete the pasted documents through
    // `aiKnowledge.remove` in the settings UI.
    await t.run(async (ctx) => {
      for (let i = 0; i < 8; i++) {
        const content = `[Georgia — Note ${i}]\nGeorgia compiled detail ${i}`;
        await ctx.db.insert("kbChunks", {
          accountId,
          sourceKind: "entry",
          serviceKey: "georgia",
          entryType: "note",
          audience: "customer",
          chunkIndex: i,
          content,
          embedding: syntheticEmbedding(content),
        });
      }
    });

    // Default `k` and no `audience` — what every live caller passes.
    const results = await t.action(internal.aiKnowledge.retrieve, {
      accountId,
      queryText: "Georgia",
    });

    // The budget RESERVES the back half of `k` for legacy; it does not
    // forfeit those slots when legacy has nothing to put in them. An
    // empty legacy pool claims none of them, so they return to the
    // compiled pool and the caller still gets a full `k` — not
    // `ceil(5 / 2)` = 3, which would be a silent 40% cut in grounding
    // context for exactly the accounts furthest along the migration.
    expect(results).toHaveLength(5);
    expect(new Set(results).size).toBe(5);
    expect(results.every((c) => c.startsWith("[Georgia — Note"))).toBe(true);
  });

  test("the top-up works with no embeddings key too — the compiled LEXICAL arm over-fetches for it", async () => {
    const t = convexTest(schema, modules);
    const { accountId } = await seedAccountMember(t, {
      name: "A",
      email: "a@x.co",
      role: "admin",
    });

    // Deliberately NO embeddings key, so the compiled SEMANTIC arm never
    // runs and contributes no retained candidates. Every candidate the
    // top-up replays has to come from the lexical arm — which is why
    // that arm asks for `k` rows while pushing only `compiledBudget` of
    // them. Without that over-fetch a lexical-only account would be
    // pinned at `ceil(k / 2)` no matter how empty its legacy pool is.
    await t.run(async (ctx) => {
      for (let i = 0; i < 8; i++) {
        await ctx.db.insert("kbChunks", {
          accountId,
          sourceKind: "entry",
          serviceKey: "georgia",
          entryType: "note",
          audience: "customer",
          chunkIndex: i,
          content: `[Georgia — Note ${i}]\nGeorgia compiled detail ${i}`,
        });
      }
    });

    const results = await t.action(internal.aiKnowledge.retrieve, {
      accountId,
      queryText: "Georgia",
    });
    expect(results).toHaveLength(5);
    expect(new Set(results).size).toBe(5);
  });
});
