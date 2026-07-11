/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import type { AccountRole } from "./lib/roles";

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
 * invite flow — used by `updateProfile`'s isolation test (which needs a
 * real teammate row on the SAME account to prove the mutation patches
 * only the CALLER's own membership) and by `setDefaultCurrency`'s
 * role-floor tests below. Mirrors every other `convex/*.test.ts`
 * suite's own `seedTeammate` helper. `role` defaults to `"agent"` —
 * every pre-existing call site relied on that implicit default before
 * this param was added, so they're unaffected.
 */
async function insertTeammate(
  t: ReturnType<typeof convexTest>,
  opts: { accountId: Id<"accounts">; name: string; email: string; role?: AccountRole },
) {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {
      name: opts.name,
      email: opts.email,
    });
    const membershipId = await ctx.db.insert("memberships", {
      userId,
      accountId: opts.accountId,
      role: opts.role ?? "agent",
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
// setDefaultCurrency — admin+ action; patches the CALLER's account row
// (Phase 8/9 stragglers: `src/components/settings/deals-settings.tsx`'s
// "Deals" settings panel)
// ============================================================

test("setDefaultCurrency updates the caller's account defaultCurrency", async () => {
  const t = convexTest(schema, modules);
  const userId = await insertUser(t, {
    name: "Sarah",
    email: "sarah@example.com",
  });
  const asSarah = t.withIdentity({ subject: `${userId}|session-sarah` });
  // bootstrapAccount always makes the caller "owner" — owner outranks
  // admin, so this also proves `hasMinRole` accepts the higher role.
  const accountId = await asSarah.mutation(api.accounts.bootstrapAccount, {});

  const result = await asSarah.mutation(api.accounts.setDefaultCurrency, {
    currency: "EUR",
  });
  expect(result).toBe(accountId);

  const account = await t.run((ctx) => ctx.db.get(accountId));
  expect(account!.defaultCurrency).toBe("EUR");

  // `me` reads back the very same field, proving this is the row it
  // sources `account.defaultCurrency` from.
  const profile = await asSarah.query(api.accounts.me, {});
  expect(profile!.account.defaultCurrency).toBe("EUR");
});

test("setDefaultCurrency is denied for a non-supervisor (agent) member", async () => {
  const t = convexTest(schema, modules);
  const userId = await insertUser(t, {
    name: "Sarah",
    email: "sarah@example.com",
  });
  const asSarah = t.withIdentity({ subject: `${userId}|session-sarah` });
  const accountId = await asSarah.mutation(api.accounts.bootstrapAccount, {});
  const { userId: agentUserId } = await insertTeammate(t, {
    accountId,
    name: "Agent Andy",
    email: "andy@example.com",
  });
  const asAgent = t.withIdentity({ subject: `${agentUserId}|session-andy` });

  await expect(
    asAgent.mutation(api.accounts.setDefaultCurrency, { currency: "EUR" }),
  ).rejects.toMatchObject({ data: { code: "FORBIDDEN", min: "supervisor" } });

  const account = await t.run((ctx) => ctx.db.get(accountId));
  expect(account!.defaultCurrency).toBe("USD");
});

test("supervisor can set the default currency; agent cannot", async () => {
  const t = convexTest(schema, modules);
  const userId = await insertUser(t, {
    name: "Sarah",
    email: "sarah@example.com",
  });
  const asSarah = t.withIdentity({ subject: `${userId}|session-sarah` });
  const accountId = await asSarah.mutation(api.accounts.bootstrapAccount, {});
  const { userId: supUserId } = await insertTeammate(t, {
    accountId,
    name: "Sup",
    email: "sup@example.com",
    role: "supervisor",
  });
  const asSup = t.withIdentity({ subject: `${supUserId}|session-sup` });

  await expect(
    asSup.mutation(api.accounts.setDefaultCurrency, { currency: "EUR" }),
  ).resolves.toBe(accountId);

  const { userId: agentUserId } = await insertTeammate(t, {
    accountId,
    name: "Agent Andy",
    email: "andy@example.com",
  });
  const asAgent = t.withIdentity({ subject: `${agentUserId}|session-andy` });
  await expect(
    asAgent.mutation(api.accounts.setDefaultCurrency, { currency: "GBP" }),
  ).rejects.toMatchObject({ data: { code: "FORBIDDEN", min: "supervisor" } });
});

test("setDefaultCurrency only touches the caller's own account, not another account's", async () => {
  const t = convexTest(schema, modules);
  const sarahUserId = await insertUser(t, {
    name: "Sarah",
    email: "sarah@example.com",
  });
  const asSarah = t.withIdentity({ subject: `${sarahUserId}|session-sarah` });
  await asSarah.mutation(api.accounts.bootstrapAccount, {});

  const leeUserId = await insertUser(t, {
    name: "Lee",
    email: "lee@example.com",
  });
  const asLee = t.withIdentity({ subject: `${leeUserId}|session-lee` });
  const leeAccountId = await asLee.mutation(api.accounts.bootstrapAccount, {});

  await asSarah.mutation(api.accounts.setDefaultCurrency, {
    currency: "GBP",
  });

  const leeAccount = await t.run((ctx) => ctx.db.get(leeAccountId));
  expect(leeAccount!.defaultCurrency).toBe("USD");
});

test("setDefaultCurrency throws INVALID_INPUT for an unknown currency code", async () => {
  const t = convexTest(schema, modules);
  const userId = await insertUser(t, {
    name: "Sarah",
    email: "sarah@example.com",
  });
  const asSarah = t.withIdentity({ subject: `${userId}|session-sarah` });
  const accountId = await asSarah.mutation(api.accounts.bootstrapAccount, {});

  await expect(
    asSarah.mutation(api.accounts.setDefaultCurrency, { currency: "XXX" }),
  ).rejects.toMatchObject({ data: { code: "INVALID_INPUT" } });

  const account = await t.run((ctx) => ctx.db.get(accountId));
  expect(account!.defaultCurrency).toBe("USD");
});

test("setDefaultCurrency throws UNAUTHENTICATED when called without an authenticated identity", async () => {
  const t = convexTest(schema, modules);

  await expect(
    t.mutation(api.accounts.setDefaultCurrency, { currency: "EUR" }),
  ).rejects.toMatchObject({ data: { code: "UNAUTHENTICATED" } });
});

test("setDefaultCurrency throws NO_ACCOUNT when authenticated but not yet bootstrapped", async () => {
  const t = convexTest(schema, modules);
  const userId = await insertUser(t, {
    name: "NoAccount",
    email: "noaccount@example.com",
  });
  const asUser = t.withIdentity({ subject: `${userId}|session-none` });

  await expect(
    asUser.mutation(api.accounts.setDefaultCurrency, { currency: "EUR" }),
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
