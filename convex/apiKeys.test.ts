/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { hashApiKey } from "./lib/apiKey";
import type { Id } from "./_generated/dataModel";
import type { AccountRole } from "./lib/roles";

// Convex function modules for convex-test to resolve `api.*`/`internal.*`
// references against. Absolute, from-project-root pattern (matches every
// other `convex/*.test.ts` suite — see `convex/lib/auth.test.ts`'s
// comment for why this must be absolute rather than a relative "./**").
const modules = import.meta.glob("/convex/**/*.ts");

const API_KEY_PREFIX = "wacrm_live_";

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

/**
 * Adds a second membership row to an *existing* account — matches
 * `convex/conversations.test.ts`'s own `seedTeammate`.
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

// ============================================================
// create — admin+ gate, returns plaintext once, stores only the hash
// ============================================================

test("create throws FORBIDDEN for a caller below the admin role", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });

  await expect(
    asUser.mutation(api.apiKeys.create, {
      name: "CI bot",
      scopes: ["contacts:read"],
    }),
  ).rejects.toMatchObject({ data: { code: "FORBIDDEN", min: "admin" } });
});

test("create returns the plaintext key exactly once and persists only its hash", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId, userId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });

  const result = await asUser.mutation(api.apiKeys.create, {
    name: "CI bot",
    scopes: ["contacts:read", "messages:send"],
  });

  expect(result.plaintext.startsWith(API_KEY_PREFIX)).toBe(true);
  expect(result.keyPrefix.startsWith(API_KEY_PREFIX)).toBe(true);
  expect(result.plaintext.startsWith(result.keyPrefix)).toBe(true);
  expect(result.expiresAt).toBeUndefined();

  const row = await t.run((ctx) => ctx.db.get(result.apiKeyId));
  expect(row!.accountId).toBe(accountId);
  expect(row!.createdByUserId).toBe(userId);
  expect(row!.name).toBe("CI bot");
  expect(row!.scopes).toEqual(["contacts:read", "messages:send"]);
  expect(row!.keyPrefix).toBe(result.keyPrefix);
  // The hash is deterministic (SHA-256 of the plaintext) — recompute
  // independently and assert it matches what got stored, rather than
  // merely asserting *some* hash-shaped string is there.
  expect(row!.keyHash).toBe(await hashApiKey(result.plaintext));
  expect(row!.revokedAt).toBeUndefined();
  expect(row!.expiresAt).toBeUndefined();
});

test("create clamps a supplied expiresInDays into a concrete expiresAt", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });

  const before = Date.now();
  const result = await asUser.mutation(api.apiKeys.create, {
    name: "Temp key",
    scopes: [],
    expiresInDays: 30,
  });

  expect(result.expiresAt).toBeGreaterThan(before + 29 * 24 * 60 * 60 * 1000);
  expect(result.expiresAt).toBeLessThanOrEqual(
    Date.now() + 30 * 24 * 60 * 60 * 1000,
  );

  const row = await t.run((ctx) => ctx.db.get(result.apiKeyId));
  expect(row!.expiresAt).toBe(result.expiresAt);
});

test("create ignores a non-positive/invalid expiresInDays (key never expires)", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });

  const result = await asUser.mutation(api.apiKeys.create, {
    name: "Temp key",
    scopes: [],
    expiresInDays: -5,
  });
  expect(result.expiresAt).toBeUndefined();
});

// ============================================================
// list — any member can read the roster, keyHash never included
// ============================================================

test("list never returns keyHash for any key", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });
  await asUser.mutation(api.apiKeys.create, { name: "CI bot", scopes: [] });

  const keys = await asUser.query(api.apiKeys.list, {});
  expect(keys).toHaveLength(1);
  expect(keys[0]).not.toHaveProperty("keyHash");
  expect(keys[0]!.name).toBe("CI bot");
});

test("list is visible to a non-admin member of the same account", async () => {
  const t = convexTest(schema, modules);
  const { asUser: asAdmin, accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });
  await asAdmin.mutation(api.apiKeys.create, { name: "CI bot", scopes: [] });
  const viewerId = await seedTeammate(t, {
    accountId,
    name: "Vic",
    email: "vic@example.com",
    role: "viewer",
  });
  const asViewer = t.withIdentity({ subject: `${viewerId}|session-Vic` });

  const keys = await asViewer.query(api.apiKeys.list, {});
  expect(keys).toHaveLength(1);
});

// ============================================================
// revoke — admin+ gate, ownership
// ============================================================

test("revoke throws FORBIDDEN for a caller below the admin role", async () => {
  const t = convexTest(schema, modules);
  const { asUser: asAdmin, accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });
  const { apiKeyId } = await asAdmin.mutation(api.apiKeys.create, {
    name: "CI bot",
    scopes: [],
  });
  const viewerId = await seedTeammate(t, {
    accountId,
    name: "Vic",
    email: "vic@example.com",
    role: "viewer",
  });
  const asViewer = t.withIdentity({ subject: `${viewerId}|session-Vic` });

  await expect(
    asViewer.mutation(api.apiKeys.revoke, { apiKeyId }),
  ).rejects.toMatchObject({ data: { code: "FORBIDDEN", min: "admin" } });
});

test("revoke sets revokedAt on the caller's own account's key", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });
  const { apiKeyId } = await asUser.mutation(api.apiKeys.create, {
    name: "CI bot",
    scopes: [],
  });

  const before = Date.now();
  await asUser.mutation(api.apiKeys.revoke, { apiKeyId });

  const row = await t.run((ctx) => ctx.db.get(apiKeyId));
  expect(row!.revokedAt).toBeGreaterThanOrEqual(before);
});

// ============================================================
// cross-account denial
// ============================================================

test("cross-account denial: B cannot list into or revoke A's key", async () => {
  const t = convexTest(schema, modules);
  const { asUser: asAlice } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });
  const { asUser: asBob } = await seedAccountMember(t, {
    name: "Bob",
    email: "bob@example.com",
    role: "admin",
  });
  const { apiKeyId } = await asAlice.mutation(api.apiKeys.create, {
    name: "Alice's key",
    scopes: [],
  });

  // Bob's own list never contains Alice's key — proves account
  // isolation, not just "revoke fails".
  const bobsKeys = await asBob.query(api.apiKeys.list, {});
  expect(bobsKeys).toHaveLength(0);

  await expect(
    asBob.mutation(api.apiKeys.revoke, { apiKeyId }),
  ).rejects.toMatchObject({ data: { code: "NOT_FOUND", entity: "apiKey" } });

  // Untouched by Bob's rejected attempt.
  const row = await t.run((ctx) => ctx.db.get(apiKeyId));
  expect(row!.revokedAt).toBeUndefined();

  // Alice herself can still revoke it — proves the throw above is
  // really about cross-account isolation, not a broken revoke.
  await asAlice.mutation(api.apiKeys.revoke, { apiKeyId });
  const revoked = await t.run((ctx) => ctx.db.get(apiKeyId));
  expect(revoked!.revokedAt).not.toBeUndefined();
});

// ============================================================
// lookupByHash — internalQuery, server-only auth-path lookup
// ============================================================

test("lookupByHash returns the account + scopes for an active key", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });
  const { plaintext } = await asUser.mutation(api.apiKeys.create, {
    name: "CI bot",
    scopes: ["contacts:read"],
  });

  const keyHash = await hashApiKey(plaintext);
  const result = await t.query(internal.apiKeys.lookupByHash, { keyHash });
  expect(result).toEqual({ accountId, scopes: ["contacts:read"] });
});

test("lookupByHash returns null for an unknown hash", async () => {
  const t = convexTest(schema, modules);
  const result = await t.query(internal.apiKeys.lookupByHash, {
    keyHash: "0".repeat(64),
  });
  expect(result).toBeNull();
});

test("lookupByHash returns null for a revoked key", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });
  const { plaintext, apiKeyId } = await asUser.mutation(api.apiKeys.create, {
    name: "CI bot",
    scopes: [],
  });
  await asUser.mutation(api.apiKeys.revoke, { apiKeyId });

  const keyHash = await hashApiKey(plaintext);
  const result = await t.query(internal.apiKeys.lookupByHash, { keyHash });
  expect(result).toBeNull();
});

test("lookupByHash returns null for an expired key", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });
  const { plaintext, apiKeyId } = await asUser.mutation(api.apiKeys.create, {
    name: "CI bot",
    scopes: [],
    expiresInDays: 1,
  });
  // Force it into the past directly — faster/more reliable than
  // waiting a real day for the natural expiry.
  await t.run((ctx) =>
    ctx.db.patch(apiKeyId, { expiresAt: Date.now() - 1_000 }),
  );

  const keyHash = await hashApiKey(plaintext);
  const result = await t.query(internal.apiKeys.lookupByHash, { keyHash });
  expect(result).toBeNull();
});
