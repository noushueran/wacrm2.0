/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";

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

/**
 * Adds a second membership row to an *existing* account, bypassing any
 * invite flow — used only by `updateProfile`'s isolation test, which
 * needs a real teammate row on the SAME account to prove the mutation
 * patches only the CALLER's own membership. Mirrors every other
 * `convex/*.test.ts` suite's own `seedTeammate` helper.
 */
async function insertTeammate(
  t: ReturnType<typeof convexTest>,
  opts: { accountId: Id<"accounts">; name: string; email: string },
) {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {
      name: opts.name,
      email: opts.email,
    });
    const membershipId = await ctx.db.insert("memberships", {
      userId,
      accountId: opts.accountId,
      role: "agent",
      fullName: opts.name,
      email: opts.email,
    });
    return { userId, membershipId };
  });
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

// ============================================================
// updateProfile — caller patches their OWN membership's fullName/
// avatarUrl (Phase 8, Task 3)
// ============================================================

test("updateProfile updates the caller's own fullName and avatarUrl", async () => {
  const t = convexTest(schema, modules);
  const userId = await insertUser(t, {
    name: "Sarah",
    email: "sarah@example.com",
  });
  const asSarah = t.withIdentity({ subject: `${userId}|session-sarah` });
  await asSarah.mutation(api.accounts.bootstrapAccount, {});

  const membershipId = await asSarah.mutation(api.accounts.updateProfile, {
    name: "Sarah Connor",
    avatarUrl: "https://example.com/sarah.png",
  });

  const membership = await t.run((ctx) => ctx.db.get(membershipId));
  expect(membership!.userId).toBe(userId);
  expect(membership!.fullName).toBe("Sarah Connor");
  expect(membership!.avatarUrl).toBe("https://example.com/sarah.png");

  // `me` reads back the very same denormalized fields, proving this is
  // the row it sources `name`/`avatarUrl` from.
  const profile = await asSarah.query(api.accounts.me, {});
  expect(profile!.name).toBe("Sarah Connor");
  expect(profile!.avatarUrl).toBe("https://example.com/sarah.png");
});

test("updateProfile only patches the caller's own membership, not a teammate's in the same account", async () => {
  const t = convexTest(schema, modules);
  const userId = await insertUser(t, {
    name: "Sarah",
    email: "sarah@example.com",
  });
  const asSarah = t.withIdentity({ subject: `${userId}|session-sarah` });
  const accountId = await asSarah.mutation(api.accounts.bootstrapAccount, {});
  const { membershipId: teammateMembershipId } = await insertTeammate(t, {
    accountId,
    name: "Teammate Tom",
    email: "tom@example.com",
  });

  await asSarah.mutation(api.accounts.updateProfile, {
    name: "Sarah Connor",
  });

  const teammateMembership = await t.run((ctx) =>
    ctx.db.get(teammateMembershipId),
  );
  expect(teammateMembership!.fullName).toBe("Teammate Tom");
});

test("updateProfile preserves the existing avatarUrl when omitted on a later call", async () => {
  const t = convexTest(schema, modules);
  const userId = await insertUser(t, {
    name: "Sarah",
    email: "sarah@example.com",
  });
  const asSarah = t.withIdentity({ subject: `${userId}|session-sarah` });
  await asSarah.mutation(api.accounts.bootstrapAccount, {});
  const membershipId = await asSarah.mutation(api.accounts.updateProfile, {
    name: "Sarah Connor",
    avatarUrl: "https://example.com/sarah.png",
  });

  // Second call omits `avatarUrl` entirely — it must not be cleared.
  await asSarah.mutation(api.accounts.updateProfile, { name: "Sarah C." });

  const membership = await t.run((ctx) => ctx.db.get(membershipId));
  expect(membership!.fullName).toBe("Sarah C.");
  expect(membership!.avatarUrl).toBe("https://example.com/sarah.png");
});

test("updateProfile throws UNAUTHENTICATED when called without an authenticated identity", async () => {
  const t = convexTest(schema, modules);

  await expect(
    t.mutation(api.accounts.updateProfile, { name: "Nobody" }),
  ).rejects.toMatchObject({ data: { code: "UNAUTHENTICATED" } });
});

test("updateProfile throws NO_ACCOUNT when authenticated but not yet bootstrapped", async () => {
  const t = convexTest(schema, modules);
  const userId = await insertUser(t, {
    name: "NoAccount",
    email: "noaccount@example.com",
  });
  const asUser = t.withIdentity({ subject: `${userId}|session-none` });

  await expect(
    asUser.mutation(api.accounts.updateProfile, { name: "Someone" }),
  ).rejects.toMatchObject({ data: { code: "NO_ACCOUNT" } });
});

// ============================================================
// accountContextForUser — server-only membership lookup for PUBLIC
// actions (`send.ts`'s `send`, `reactions.reactToMeta`; Phase 8, Task 4)
// that have no `ctx.db` of their own to call `lib/auth.ts`'s
// `withAccount` inline.
// ============================================================

test("accountContextForUser returns the caller's accountId + role", async () => {
  const t = convexTest(schema, modules);
  const userId = await insertUser(t, {
    name: "Sarah",
    email: "sarah@example.com",
  });
  const asSarah = t.withIdentity({ subject: `${userId}|session-sarah` });
  const accountId = await asSarah.mutation(api.accounts.bootstrapAccount, {});

  const result = await t.query(internal.accounts.accountContextForUser, {
    userId,
  });

  expect(result).toEqual({ accountId, role: "owner" });
});

test("accountContextForUser returns null for a user with no membership yet", async () => {
  const t = convexTest(schema, modules);
  const userId = await insertUser(t, {
    name: "Nomad",
    email: "nomad@example.com",
  });

  const result = await t.query(internal.accounts.accountContextForUser, {
    userId,
  });

  expect(result).toBeNull();
});
