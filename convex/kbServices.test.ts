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
// kbServices.{list,upsert,remove} — admin-gated writes, member-readable
// list, account-scoped, referential-integrity-guarded remove.
// ============================================================

test("admin creates, edits, lists; key is immutable identity", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, { name: "A", email: "a@x.co", role: "admin" });
  await asUser.mutation(api.kbServices.upsert, {
    key: "uae-visas", name: "UAE Visa Services", aliases: ["visa"],
  });
  await asUser.mutation(api.kbServices.upsert, {
    key: "uae-visas", name: "UAE Visas", aliases: ["visa", "tourist visa"],
  });
  const rows = await asUser.query(api.kbServices.list, {});
  expect(rows).toHaveLength(1);
  expect(rows[0].name).toBe("UAE Visas");
  expect(rows[0].aliases).toEqual(["visa", "tourist visa"]);
});

test("lint errors reject the write", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, { name: "A", email: "a@x.co", role: "admin" });
  await expect(
    asUser.mutation(api.kbServices.upsert, { key: "Bad Key!", name: "", aliases: [] }),
  ).rejects.toThrow(/BAD_REQUEST/);
});

test("agent role cannot upsert; other account cannot see rows", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, { name: "A", email: "a@x.co", role: "admin" });
  await asUser.mutation(api.kbServices.upsert, { key: "x", name: "X", aliases: [] });
  const { asUser: asAgent } = await seedAccountMember(t, { name: "B", email: "b@x.co", role: "agent" });
  await expect(
    asAgent.mutation(api.kbServices.upsert, { key: "y", name: "Y", aliases: [] }),
  ).rejects.toThrow();
  expect(await asAgent.query(api.kbServices.list, {})).toEqual([]);
});

test("remove refuses while entries reference the service", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId } = await seedAccountMember(t, { name: "A", email: "a@x.co", role: "admin" });
  await asUser.mutation(api.kbServices.upsert, { key: "x", name: "X", aliases: [] });
  await t.run(async (ctx) => {
    await ctx.db.insert("kbEntries", {
      accountId, scope: "service", serviceKey: "x", type: "overview",
      title: "t", body: "b", audience: "customer", status: "draft",
      version: 1, updatedAt: Date.now(),
    });
  });
  await expect(asUser.mutation(api.kbServices.remove, { key: "x" }))
    .rejects.toThrow(/service_in_use/);
});
