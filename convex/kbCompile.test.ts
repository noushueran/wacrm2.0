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

/**
 * Runs `trigger` — a mutation that schedules a `kbCompile` action — and
 * drains that action to completion.
 *
 * This is convex-test's own documented two-step (see
 * `finishInProgressScheduledFunctions`'s doc comment in
 * `convex-test/dist/index.d.ts`): advance timers so the function is
 * scheduled, THEN await it. Fake timers exist here only for step one —
 * `publish`/`unpublish` enqueue their compile via
 * `ctx.scheduler.runAfter(0, ...)`, and `vi.runAllTimers()` fires that
 * synchronously, which is what puts the action into convex-test's
 * in-flight set. Without it there is nothing in flight to await (real
 * timers alone leave the scheduler empty and the drain returns a no-op).
 *
 * Step two deliberately does NOT use
 * `t.finishAllScheduledFunctions(vi.runAllTimers)`, which is what made
 * this suite flaky. That helper never awaits the in-flight promises — it
 * BUSY-SPINS on them, re-pumping timers between `MessageChannel`
 * macrotasks against a hard-coded 10000-pump budget, then throws
 * "scheduled function did not complete after 10000 timer pumps". That
 * budget is really an implicit timeout on whatever the action is waiting
 * for, and the first thing this action waits for is convex-test lazily
 * `import()`ing the `convex/` module graph that `import.meta.glob` names
 * above — a Vite transform, not a cheap await.
 *
 * Measured on this exact test: that COLD first import burns ~900-4300 of
 * the 10000 pumps on an idle machine, while the identical measurement
 * once the modules are cached costs 3-15. Under full-suite load, with
 * workers contending for CPU and for the transform pipeline, the cold
 * import overruns the budget — a failure that reproduces under load and
 * vanishes in isolation. Time is handed back to real timers before the
 * await so that import (and any real timer the action may use) proceeds
 * normally; awaiting the in-flight promises has no budget to overrun.
 *
 * NB the seeded embeddings key is NOT the culprit, tempting though it is
 * to blame `aiConfig.loadDecrypted` -> `decrypt()` -> Web Crypto: the
 * same measurement WITHOUT a key configured is if anything worse
 * (~2400-4300 cold pumps), and the decrypt itself costs ~10 warm pumps.
 * Do not "fix" a recurrence by dropping the key seeding — that would
 * only stop the embedding assertion below from covering anything.
 */
async function drainScheduledCompile(
  t: ReturnType<typeof convexTest>,
  trigger: () => Promise<unknown>,
): Promise<void> {
  vi.useFakeTimers();
  try {
    await trigger();
    // Start the scheduled compile (fires the `runAfter(0)`).
    vi.runAllTimers();
  } finally {
    // Restore real time before awaiting, so Web Crypto can settle.
    vi.useRealTimers();
  }
  await t.finishInProgressScheduledFunctions();
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
  await drainScheduledCompile(t, () =>
    asUser.mutation(api.kbEntries.publish, { entryId }));
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
  await drainScheduledCompile(t, () =>
    asUser.mutation(api.kbOps.publish, { serviceKey: "georgia", kind: "purchase" }));
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
  await drainScheduledCompile(t, () =>
    asUser.mutation(api.kbOps.unpublish, { serviceKey: "georgia", kind: "purchase" }));
  chunks = await t.run((ctx) =>
    ctx.db.query("kbChunks")
      .withIndex("by_ops_block", (q) => q.eq("opsBlockId", ops!._id)).collect());
  expect(chunks).toEqual([]);
});
