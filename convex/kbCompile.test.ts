/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { AccountRole } from "./lib/roles";

// Convex function modules for convex-test to resolve `api.*`/`internal.*`
// references against. Absolute, from-project-root pattern (matches every
// other `convex/*.test.ts` suite — see `convex/lib/auth.test.ts`'s
// comment for why this must be absolute rather than a relative "./**").
const modules = import.meta.glob("/convex/**/*.ts");

// DRY-RUN for every test in this file — `compileEntry`/`compileOps` skip
// the real OpenAI embeddings call under `CONVEX_AI_DRY_RUN`, substituting
// a deterministic seeded vector instead, same convention as
// `aiKnowledge.test.ts`'s own header comment. This suite (unlike
// `kbEntries.test.ts`/`kbOps.test.ts`) genuinely exercises the embedding
// path, so dry-run belongs in `beforeEach` here.
beforeEach(() => {
  process.env.CONVEX_AI_DRY_RUN = "1";
});
afterEach(() => {
  // Belt-and-suspenders: a thrown assertion could skip a test's own
  // `vi.useRealTimers()` call — guard every other test in this file from
  // inheriting fake timers (mirrors `aiKnowledge.test.ts`'s own afterEach).
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

// ============================================================
// kbCompile.{compileEntry,compileOps} — the publish-time compiler: reads
// a published entry/ops block, plans its chunks (`planEntryChunks`/
// `planOpsChunks`), best-effort embeds them, and delete-then-inserts the
// source's `kbChunks` set. Unpublishing (or a since-deleted row) clears
// the chunk set instead of erroring — see `convex/kbCompile.ts`'s header
// comment for the full design rationale.
// ============================================================

test("publishing an entry compiles header-prefixed chunks with metadata", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId } = await seedAccountMember(t, { name: "A", email: "a@x.co", role: "admin" });
  await asUser.mutation(api.kbServices.upsert, { key: "georgia", name: "Georgia Holiday Packages", aliases: [] });
  // `embedPlans` mirrors `aiKnowledge.ingest` lines ~285-318 EXACTLY (per
  // the Task 8 brief's own citation): dry-run only substitutes a
  // synthetic vector on the branch that would otherwise call OpenAI,
  // which is itself gated on the account having an embeddings key
  // configured — an account with no `aiConfigs` row embeds nothing,
  // dry-run or not (see `aiKnowledge.test.ts`'s own "no embeddings key
  // configured leaves every chunk's embedding unset" test). So this
  // configures one first, exactly like `aiKnowledge.test.ts`'s own
  // `configureEmbeddingsKey` helper, to reach the embedded branch below.
  await asUser.mutation(api.aiConfig.upsert, {
    provider: "openai", model: "gpt-4o-mini", isActive: true, autoReplyEnabled: false,
    apiKey: "sk-chat-key", embeddingsApiKey: "sk-embeddings-key",
  });
  const entryId = await asUser.mutation(api.kbEntries.save, {
    scope: "service", serviceKey: "georgia", type: "requirements",
    title: "Visa requirements", body: "Passport valid 6 months.", audience: "customer",
  });
  vi.useFakeTimers();
  await asUser.mutation(api.kbEntries.publish, { entryId });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  vi.useRealTimers();
  const chunks = await t.run((ctx) =>
    ctx.db.query("kbChunks").withIndex("by_entry", (q) => q.eq("entryId", entryId)).collect());
  expect(chunks).toHaveLength(1);
  expect(chunks[0]).toMatchObject({
    accountId, sourceKind: "entry", serviceKey: "georgia",
    entryType: "requirements", audience: "customer", chunkIndex: 0,
  });
  expect(chunks[0].content).toBe(
    "[Georgia Holiday Packages — Visa requirements]\nPassport valid 6 months.");
  expect(chunks[0].embedding).toHaveLength(1536);
});

test("publishing an ops block compiles ONE internal sentinel chunk; unpublish clears it", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, { name: "A", email: "a@x.co", role: "admin" });
  await asUser.mutation(api.kbServices.upsert, { key: "georgia", name: "Georgia Holiday Packages", aliases: [] });
  await asUser.mutation(api.kbOps.save, {
    serviceKey: "georgia", kind: "purchase",
    conditions: [{ key: "budget", label: "Budget >= AED 3000/person confirmed" }],
    reportValue: 9000, currency: "AED",
  });
  vi.useFakeTimers();
  await asUser.mutation(api.kbOps.publish, { serviceKey: "georgia", kind: "purchase" });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  const ops = await asUser.query(api.kbOps.get, { serviceKey: "georgia", kind: "purchase" });
  let chunks = await t.run((ctx) =>
    ctx.db.query("kbChunks")
      .withIndex("by_ops_block", (q) => q.eq("opsBlockId", ops!._id)).collect());
  expect(chunks).toHaveLength(1);
  expect(chunks[0]).toMatchObject({
    sourceKind: "ops", audience: "internal", serviceKey: "georgia", chunkIndex: 0,
  });
  expect(chunks[0].content).toContain("PURCHASE CRITERIA — Georgia Holiday Packages");
  expect(chunks[0].content).toContain("Report value: 9000 AED");
  await asUser.mutation(api.kbOps.unpublish, { serviceKey: "georgia", kind: "purchase" });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  vi.useRealTimers();
  chunks = await t.run((ctx) =>
    ctx.db.query("kbChunks")
      .withIndex("by_ops_block", (q) => q.eq("opsBlockId", ops!._id)).collect());
  expect(chunks).toEqual([]);
});
