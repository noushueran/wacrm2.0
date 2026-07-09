/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

// Convex function modules for convex-test to resolve `api.*` references
// against (mirrors the pattern from the Convex testing docs).
const modules = import.meta.glob("./**/*.ts");

/**
 * convex-test has no real sign-in flow to drive, so we simulate "a user
 * is already authenticated" the way the Convex Auth internals expect:
 * insert a `users` row ourselves, then hand convex-test an identity whose
 * `subject` is `"<userId>|<sessionId>"`. `getAuthUserId` (see
 * node_modules/@convex-dev/auth/dist/server/implementation/index.js)
 * does exactly `identity.subject.split(TOKEN_SUB_CLAIM_DIVIDER)[0]` where
 * `TOKEN_SUB_CLAIM_DIVIDER === "|"`, so this round-trips to our seeded
 * user id.
 */
async function insertUser(
  t: ReturnType<typeof convexTest>,
  user: { name: string; email: string },
) {
  return await t.run(async (ctx) => ctx.db.insert("users", user));
}

test("bootstrapAccount creates exactly one account + one owner membership", async () => {
  const t = convexTest(schema, modules);
  const userId = await insertUser(t, {
    name: "Sarah",
    email: "sarah@example.com",
  });
  const asSarah = t.withIdentity({ subject: `${userId}|test-session` });

  const accountId = await asSarah.mutation(api.accounts.bootstrapAccount, {});

  const accounts = await t.run((ctx) => ctx.db.query("accounts").collect());
  const memberships = await t.run((ctx) =>
    ctx.db.query("memberships").collect(),
  );

  expect(accounts).toHaveLength(1);
  expect(accounts[0]!._id).toBe(accountId);
  expect(accounts[0]!.ownerUserId).toBe(userId);
  expect(accounts[0]!.defaultCurrency).toBe("USD");
  expect(accounts[0]!.name).toBe("sarah@example.com");

  expect(memberships).toHaveLength(1);
  expect(memberships[0]!.userId).toBe(userId);
  expect(memberships[0]!.accountId).toBe(accountId);
  expect(memberships[0]!.role).toBe("owner");
  expect(memberships[0]!.email).toBe("sarah@example.com");
});

test("bootstrapAccount is idempotent — second call is a no-op returning the same account", async () => {
  const t = convexTest(schema, modules);
  const userId = await insertUser(t, {
    name: "Sarah",
    email: "sarah@example.com",
  });
  const asSarah = t.withIdentity({ subject: `${userId}|test-session` });

  const firstAccountId = await asSarah.mutation(
    api.accounts.bootstrapAccount,
    {},
  );
  const secondAccountId = await asSarah.mutation(
    api.accounts.bootstrapAccount,
    {},
  );

  expect(secondAccountId).toBe(firstAccountId);

  const accounts = await t.run((ctx) => ctx.db.query("accounts").collect());
  const memberships = await t.run((ctx) =>
    ctx.db.query("memberships").collect(),
  );

  expect(accounts).toHaveLength(1);
  expect(memberships).toHaveLength(1);
});

test("bootstrapAccount throws when called without an authenticated identity", async () => {
  const t = convexTest(schema, modules);

  await expect(
    t.mutation(api.accounts.bootstrapAccount, {}),
  ).rejects.toThrow();

  const accounts = await t.run((ctx) => ctx.db.query("accounts").collect());
  expect(accounts).toHaveLength(0);
});

test("currentUser returns { user, accountId, role } for a bootstrapped member", async () => {
  const t = convexTest(schema, modules);
  const userId = await insertUser(t, { name: "Lee", email: "lee@example.com" });
  const asLee = t.withIdentity({ subject: `${userId}|session-lee` });

  const accountId = await asLee.mutation(api.accounts.bootstrapAccount, {});
  const result = await asLee.query(api.accounts.currentUser, {});

  expect(result).not.toBeNull();
  expect(result!.accountId).toBe(accountId);
  expect(result!.role).toBe("owner");
  expect(result!.user?._id).toBe(userId);
  expect(result!.user?.email).toBe("lee@example.com");
});

test("currentUser returns null when unauthenticated", async () => {
  const t = convexTest(schema, modules);
  const result = await t.query(api.accounts.currentUser, {});
  expect(result).toBeNull();
});

test("currentUser returns null when authenticated but not yet bootstrapped", async () => {
  const t = convexTest(schema, modules);
  const userId = await insertUser(t, {
    name: "NoAccount",
    email: "noaccount@example.com",
  });
  const asUser = t.withIdentity({ subject: `${userId}|session-none` });

  const result = await asUser.query(api.accounts.currentUser, {});
  expect(result).toBeNull();
});
