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

test("me exposes the membership's avatarKey alongside avatarUrl (Task 5 of the R2 migration: dual-read)", async () => {
  // Seeded directly (rather than via `updateProfile`) so this test
  // isolates the READ side from the WRITE side — `updateProfile` gained
  // an `avatarKey` argument in Task 6 (see the dedicated write-path
  // tests below); this test only cares that `me` surfaces whatever is on
  // the row. `me` is a Convex `query`, and this codebase's convention
  // (see
  // `conversionEvents.ts`/`campaignAds.ts`'s own "only an action can
  // read process.env" comments) is that only an action reads deployment
  // env — so `me` does NOT resolve `avatarKey` to a URL itself; it just
  // exposes the raw key alongside the existing `avatarUrl` fallback
  // chain, and the CLIENT (`src/hooks/use-auth.tsx`) resolves it via
  // `resolveMediaUrl` the same way `adapters.ts` does for every other
  // client-facing avatar/media field.
  const t = convexTest(schema, modules);
  const userId = await insertUser(t, {
    name: "Sarah",
    email: "sarah@example.com",
  });
  const asSarah = t.withIdentity({ subject: `${userId}|session-sarah` });
  await asSarah.mutation(api.accounts.bootstrapAccount, {});

  const membership = await t.run((ctx) =>
    ctx.db
      .query("memberships")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .first(),
  );
  await t.run((ctx) =>
    ctx.db.patch(membership!._id, {
      avatarUrl: "https://convex-api.holidayys.co/api/storage/old",
      avatarKey: "acc1/avatars/sarah.png",
    }),
  );

  const profile = await asSarah.query(api.accounts.me, {});
  expect(profile!.avatarKey).toBe("acc1/avatars/sarah.png");
  // Unresolved on purpose (see comment above) — still the raw fallback
  // chain `me` has always returned.
  expect(profile!.avatarUrl).toBe(
    "https://convex-api.holidayys.co/api/storage/old",
  );
});

test("me exposes avatarKey as null (not undefined) when the membership has none", async () => {
  const t = convexTest(schema, modules);
  const userId = await insertUser(t, {
    name: "Sarah",
    email: "sarah@example.com",
  });
  const asSarah = t.withIdentity({ subject: `${userId}|session-sarah` });
  await asSarah.mutation(api.accounts.bootstrapAccount, {});

  const profile = await asSarah.query(api.accounts.me, {});
  expect(profile!.avatarKey).toBeNull();
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

test("updateProfile writes avatarKey (R2 migration: write path) alongside avatarUrl", async () => {
  const t = convexTest(schema, modules);
  const userId = await insertUser(t, {
    name: "Sarah",
    email: "sarah@example.com",
  });
  const asSarah = t.withIdentity({ subject: `${userId}|session-sarah` });
  await asSarah.mutation(api.accounts.bootstrapAccount, {});

  const membershipId = await asSarah.mutation(api.accounts.updateProfile, {
    name: "Sarah Connor",
    avatarUrl: "https://objs.holidayys.co/acc1/avatar/sarah.png",
    avatarKey: "acc1/avatar/sarah.png",
  });

  const membership = await t.run((ctx) => ctx.db.get(membershipId));
  expect(membership!.avatarKey).toBe("acc1/avatar/sarah.png");

  // `me` reads the same row it always has — proves this is a real
  // dual-write, not a key that only the direct DB read above can see.
  const profile = await asSarah.query(api.accounts.me, {});
  expect(profile!.avatarKey).toBe("acc1/avatar/sarah.png");
});

test("updateProfile preserves the existing avatarKey when omitted on a later call", async () => {
  const t = convexTest(schema, modules);
  const userId = await insertUser(t, {
    name: "Sarah",
    email: "sarah@example.com",
  });
  const asSarah = t.withIdentity({ subject: `${userId}|session-sarah` });
  await asSarah.mutation(api.accounts.bootstrapAccount, {});
  const membershipId = await asSarah.mutation(api.accounts.updateProfile, {
    name: "Sarah Connor",
    avatarKey: "acc1/avatar/sarah.png",
  });

  // Second call omits `avatarKey` entirely (a name-only save) — it must
  // not be cleared, mirroring `avatarUrl`'s own omitted-arg contract.
  await asSarah.mutation(api.accounts.updateProfile, { name: "Sarah C." });

  const membership = await t.run((ctx) => ctx.db.get(membershipId));
  expect(membership!.fullName).toBe("Sarah C.");
  expect(membership!.avatarKey).toBe("acc1/avatar/sarah.png");
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

// ============================================================
// setLeadValue — admin+ action; sets the account-wide flat per-lead
// charge (Phase 2, Task 1). Stricter floor than setDefaultCurrency
// ("admin", not "supervisor") — only admins configure money charged to
// agents. Same identity-inline / shared-row-patch shape as
// setDefaultCurrency above, but the input guard is "value >= 0" rather
// than a currency whitelist.
// ============================================================

test("setLeadValue: admin sets the account lead value", async () => {
  const t = convexTest(schema, modules);
  const adminId = await insertUser(t, { name: "Ad", email: "ad@x.com" });
  const asAdmin = t.withIdentity({ subject: `${adminId}|s` });
  await asAdmin.mutation(api.accounts.bootstrapAccount, {}); // creates account + owner membership
  // bootstrap makes them owner; owner is admin+ so setLeadValue is allowed
  const accountId = await asAdmin.mutation(api.accounts.setLeadValue, { value: 5 });
  const acct = await t.run((ctx) => ctx.db.get(accountId));
  expect(acct?.leadValue).toBe(5);
});

test("setLeadValue: rejects a value below zero", async () => {
  const t = convexTest(schema, modules);
  const adminId = await insertUser(t, { name: "Ad", email: "ad@x.com" });
  const asAdmin = t.withIdentity({ subject: `${adminId}|s` });
  await asAdmin.mutation(api.accounts.bootstrapAccount, {});
  await expect(
    asAdmin.mutation(api.accounts.setLeadValue, { value: -1 }),
  ).rejects.toMatchObject({ data: { code: "INVALID_INPUT" } });
});

test("setLeadValue: FORBIDDEN below admin", async () => {
  const t = convexTest(schema, modules);
  const ownerId = await insertUser(t, { name: "O", email: "o@x.com" });
  const asOwner = t.withIdentity({ subject: `${ownerId}|s` });
  await asOwner.mutation(api.accounts.bootstrapAccount, {});
  const { userId: supId } = await insertTeammate(t, {
    accountId: (await t.run((ctx) => ctx.db.query("accounts").first()))!._id,
    name: "Su", email: "su@x.com", role: "supervisor",
  });
  const asSup = t.withIdentity({ subject: `${supId}|s` });
  await expect(
    asSup.mutation(api.accounts.setLeadValue, { value: 5 }),
  ).rejects.toMatchObject({ data: { code: "FORBIDDEN", min: "admin" } });
});
