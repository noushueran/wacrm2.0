/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { AccountRole } from "./lib/roles";

const modules = import.meta.glob("/convex/**/*.ts");

/**
 * Seeds a `users` row + an `accounts`/`memberships` row for a fresh
 * account, and returns a convex-test client already authenticated as
 * that user. Duplicated per-suite rather than imported — see
 * `convex/contacts.test.ts`'s own comment on this pattern.
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

test("upsert inserts a rate, then patches the same row on a second call", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });

  await asUser.mutation(api.aiModelRates.upsert, {
    provider: "openai",
    model: "gpt-5.6-luna",
    inputPerMTok: 0.5,
    cachedInputPerMTok: 0.05,
    outputPerMTok: 2,
  });
  await asUser.mutation(api.aiModelRates.upsert, {
    provider: "openai",
    model: "gpt-5.6-luna",
    inputPerMTok: 0.6,
    cachedInputPerMTok: 0.06,
    outputPerMTok: 2.4,
  });

  const rows = await t.run((ctx) =>
    ctx.db
      .query("aiModelRates")
      .withIndex("by_account", (q) => q.eq("accountId", accountId))
      .collect(),
  );
  expect(rows).toHaveLength(1);
  expect(rows[0]!.inputPerMTok).toBe(0.6);
  expect(rows[0]!.outputPerMTok).toBe(2.4);
});

test("list returns only the caller's own account rates", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });
  const other = await seedAccountMember(t, {
    name: "Bob",
    email: "bob@example.com",
    role: "admin",
  });

  await asUser.mutation(api.aiModelRates.upsert, {
    provider: "openai",
    model: "gpt-5.6-luna",
    inputPerMTok: 0.5,
    cachedInputPerMTok: 0.05,
    outputPerMTok: 2,
  });
  await other.asUser.mutation(api.aiModelRates.upsert, {
    provider: "anthropic",
    model: "claude-opus-4-8",
    inputPerMTok: 5,
    cachedInputPerMTok: 0.5,
    outputPerMTok: 25,
  });

  const mine = await asUser.query(api.aiModelRates.list, {});
  expect(mine).toHaveLength(1);
  expect(mine[0]!.model).toBe("gpt-5.6-luna");
});

test("upsert rejects a negative rate", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });

  await expect(
    asUser.mutation(api.aiModelRates.upsert, {
      provider: "openai",
      model: "gpt-5.6-luna",
      inputPerMTok: -1,
      cachedInputPerMTok: 0,
      outputPerMTok: 0,
    }),
  ).rejects.toMatchObject({ data: { code: "INVALID_RATE" } });
});

test("upsert rejects a blank model id", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });

  await expect(
    asUser.mutation(api.aiModelRates.upsert, {
      provider: "openai",
      model: "   ",
      inputPerMTok: 1,
      cachedInputPerMTok: 0,
      outputPerMTok: 1,
    }),
  ).rejects.toMatchObject({ data: { code: "INVALID_MODEL" } });
});

// Rates are billing-class data, same trust level as `aiUsage.summary`
// and `apiKeys.list`. A client-side-only guard would be cosmetic — any
// authenticated member could call these functions directly.
test("list throws FORBIDDEN for a caller below the admin role", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });
  const supervisorId = await t.run((ctx) =>
    ctx.db.insert("users", { name: "Sam", email: "sam@example.com" }),
  );
  await t.run((ctx) =>
    ctx.db.insert("memberships", {
      userId: supervisorId,
      accountId,
      role: "supervisor",
      fullName: "Sam",
      email: "sam@example.com",
    }),
  );
  const asSupervisor = t.withIdentity({
    subject: `${supervisorId}|session-Sam`,
  });

  await expect(
    asSupervisor.query(api.aiModelRates.list, {}),
  ).rejects.toMatchObject({ data: { code: "FORBIDDEN", min: "admin" } });
});

test("upsert throws FORBIDDEN for a caller below the admin role", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });
  const supervisorId = await t.run((ctx) =>
    ctx.db.insert("users", { name: "Sam", email: "sam@example.com" }),
  );
  await t.run((ctx) =>
    ctx.db.insert("memberships", {
      userId: supervisorId,
      accountId,
      role: "supervisor",
      fullName: "Sam",
      email: "sam@example.com",
    }),
  );
  const asSupervisor = t.withIdentity({
    subject: `${supervisorId}|session-Sam`,
  });

  await expect(
    asSupervisor.mutation(api.aiModelRates.upsert, {
      provider: "openai",
      model: "gpt-5.6-luna",
      inputPerMTok: 1,
      cachedInputPerMTok: 0.1,
      outputPerMTok: 2,
    }),
  ).rejects.toMatchObject({ data: { code: "FORBIDDEN", min: "admin" } });
});
