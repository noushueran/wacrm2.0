/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { AccountRole } from "./lib/roles";

// Convex function modules for convex-test to resolve `api.*`/`internal.*`
// references against. Absolute, from-project-root pattern (matches every
// other `convex/*.test.ts` suite — see `convex/lib/auth.test.ts`'s
// comment for why this must be absolute rather than a relative "./**").
const modules = import.meta.glob("/convex/**/*.ts");

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
// kbEntries.{list,save,publish,unpublish,remove} — draft/publish
// lifecycle: save always demotes an edited row to draft and bumps its
// version (compiled chunks stay pinned to the last published version
// until an explicit publish); publish/unpublish both schedule
// `internal.kbCompile.compileEntry`; remove cascades kbChunks deletion.
// ============================================================

test("save creates a draft; edit bumps version and demotes to draft", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, { name: "A", email: "a@x.co", role: "admin" });
  await asUser.mutation(api.kbServices.upsert, { key: "georgia", name: "Georgia", aliases: [] });
  const entryId = await asUser.mutation(api.kbEntries.save, {
    scope: "service", serviceKey: "georgia", type: "requirements",
    title: "Visa requirements", body: "Passport valid 6 months.", audience: "customer",
  });
  await asUser.mutation(api.kbEntries.publish, { entryId });
  let [row] = await asUser.query(api.kbEntries.list, { serviceKey: "georgia" });
  expect(row.status).toBe("published");
  await asUser.mutation(api.kbEntries.save, {
    entryId, scope: "service", serviceKey: "georgia", type: "requirements",
    title: "Visa requirements", body: "Passport valid 6 months. PCR no longer needed.",
    audience: "customer",
  });
  [row] = await asUser.query(api.kbEntries.list, { serviceKey: "georgia" });
  expect(row.status).toBe("draft");
  expect(row.version).toBe(2);
});

test("service-scope save without an existing service is NOT_FOUND", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, { name: "A", email: "a@x.co", role: "admin" });
  await expect(asUser.mutation(api.kbEntries.save, {
    scope: "service", serviceKey: "ghost", type: "overview",
    title: "t", body: "b", audience: "customer",
  })).rejects.toThrow(/NOT_FOUND/);
});

test("lint error (blank body) rejects; remove deletes row + chunks", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId } = await seedAccountMember(t, { name: "A", email: "a@x.co", role: "admin" });
  await expect(asUser.mutation(api.kbEntries.save, {
    scope: "company", type: "note", title: "t", body: "   ", audience: "internal",
  })).rejects.toThrow(/BAD_REQUEST/);
  const entryId = await asUser.mutation(api.kbEntries.save, {
    scope: "company", type: "note", title: "t", body: "b", audience: "internal",
  });
  await t.run(async (ctx) => {
    await ctx.db.insert("kbChunks", {
      accountId, sourceKind: "entry", entryId, audience: "internal",
      chunkIndex: 0, content: "[Company — t]\nb",
    });
  });
  await asUser.mutation(api.kbEntries.remove, { entryId });
  const leftover = await t.run((ctx) =>
    ctx.db.query("kbChunks")
      .withIndex("by_entry", (q) => q.eq("entryId", entryId)).collect());
  expect(leftover).toEqual([]);
});
