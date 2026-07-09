/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { AccountRole } from "./lib/roles";

// Convex function modules for convex-test to resolve `api.*` references
// against. Absolute, from-project-root pattern (matches every other
// `convex/*.test.ts` suite — see `convex/lib/auth.test.ts`'s comment for
// why this must be absolute rather than a relative "./**").
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

/**
 * Adds a second membership row to an *existing* account — matches
 * `convex/apiKeys.test.ts`'s own `seedTeammate`.
 */
async function seedTeammate(
  t: ReturnType<typeof convexTest>,
  opts: {
    accountId: Awaited<ReturnType<typeof seedAccountMember>>["accountId"];
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
// create — admin+ gate, inserts with schema-matching defaults
// ============================================================

test("create throws FORBIDDEN for a caller below the admin role", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });

  await expect(
    asUser.mutation(api.webhookEndpoints.create, {
      url: "https://example.com/hook",
      events: ["message.received"],
      secret: "whsec_test",
    }),
  ).rejects.toMatchObject({ data: { code: "FORBIDDEN", min: "admin" } });
});

test("create inserts a new endpoint active with a clean failure streak", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId, userId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });

  const endpointId = await asUser.mutation(api.webhookEndpoints.create, {
    url: "https://example.com/hook",
    events: ["message.received", "message.sent"],
    secret: "whsec_test_plaintext",
  });

  const row = await t.run((ctx) => ctx.db.get(endpointId));
  expect(row!.accountId).toBe(accountId);
  expect(row!.createdByUserId).toBe(userId);
  expect(row!.url).toBe("https://example.com/hook");
  expect(row!.events).toEqual(["message.received", "message.sent"]);
  expect(row!.secret).toBe("whsec_test_plaintext");
  expect(row!.isActive).toBe(true);
  expect(row!.failureCount).toBe(0);
  expect(row!.lastDeliveryAt).toBeUndefined();
});

// ============================================================
// list — any member can read the roster, secret never included
// ============================================================

test("list never returns secret for any endpoint", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });
  await asUser.mutation(api.webhookEndpoints.create, {
    url: "https://example.com/hook",
    events: ["message.received"],
    secret: "whsec_super_secret",
  });

  const endpoints = await asUser.query(api.webhookEndpoints.list, {});
  expect(endpoints).toHaveLength(1);
  expect(endpoints[0]).not.toHaveProperty("secret");
  expect(endpoints[0]!.url).toBe("https://example.com/hook");
});

test("list is visible to a non-admin member of the same account", async () => {
  const t = convexTest(schema, modules);
  const { asUser: asAdmin, accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });
  await asAdmin.mutation(api.webhookEndpoints.create, {
    url: "https://example.com/hook",
    events: ["message.received"],
    secret: "whsec_test",
  });
  const viewerId = await seedTeammate(t, {
    accountId,
    name: "Vic",
    email: "vic@example.com",
    role: "viewer",
  });
  const asViewer = t.withIdentity({ subject: `${viewerId}|session-Vic` });

  const endpoints = await asViewer.query(api.webhookEndpoints.list, {});
  expect(endpoints).toHaveLength(1);
});

test("list orders newest-first and scopes strictly to the caller's account", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });
  await asUser.mutation(api.webhookEndpoints.create, {
    url: "https://example.com/first",
    events: ["message.received"],
    secret: "whsec_first",
  });
  await asUser.mutation(api.webhookEndpoints.create, {
    url: "https://example.com/second",
    events: ["message.received"],
    secret: "whsec_second",
  });

  const endpoints = await asUser.query(api.webhookEndpoints.list, {});
  expect(endpoints).toHaveLength(2);
  expect(endpoints[0]!.url).toBe("https://example.com/second");
  expect(endpoints[1]!.url).toBe("https://example.com/first");
});

// ============================================================
// update — admin+ gate, ownership, patch-only-what's-provided
// ============================================================

test("update throws FORBIDDEN for a caller below the admin role", async () => {
  const t = convexTest(schema, modules);
  const { asUser: asAdmin, accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });
  const endpointId = await asAdmin.mutation(api.webhookEndpoints.create, {
    url: "https://example.com/hook",
    events: ["message.received"],
    secret: "whsec_test",
  });
  const agentId = await seedTeammate(t, {
    accountId,
    name: "Gary",
    email: "gary@example.com",
    role: "agent",
  });
  const asAgent = t.withIdentity({ subject: `${agentId}|session-Gary` });

  await expect(
    asAgent.mutation(api.webhookEndpoints.update, {
      endpointId,
      isActive: false,
    }),
  ).rejects.toMatchObject({ data: { code: "FORBIDDEN", min: "admin" } });
});

test("update patches only the fields supplied, leaving the rest untouched", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });
  const endpointId = await asUser.mutation(api.webhookEndpoints.create, {
    url: "https://example.com/hook",
    events: ["message.received"],
    secret: "whsec_original",
  });

  await asUser.mutation(api.webhookEndpoints.update, {
    endpointId,
    isActive: false,
  });

  const row = await t.run((ctx) => ctx.db.get(endpointId));
  expect(row!.isActive).toBe(false);
  // Untouched — `update` was called with only `isActive` this time.
  expect(row!.url).toBe("https://example.com/hook");
  expect(row!.events).toEqual(["message.received"]);
  expect(row!.secret).toBe("whsec_original");
});

test("update can rotate url/events/secret together", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });
  const endpointId = await asUser.mutation(api.webhookEndpoints.create, {
    url: "https://example.com/hook",
    events: ["message.received"],
    secret: "whsec_original",
  });

  await asUser.mutation(api.webhookEndpoints.update, {
    endpointId,
    url: "https://example.com/hook-v2",
    events: ["message.received", "message.failed"],
    secret: "whsec_rotated",
  });

  const row = await t.run((ctx) => ctx.db.get(endpointId));
  expect(row!.url).toBe("https://example.com/hook-v2");
  expect(row!.events).toEqual(["message.received", "message.failed"]);
  expect(row!.secret).toBe("whsec_rotated");
  expect(row!.isActive).toBe(true);
});

// ============================================================
// remove — admin+ gate, ownership
// ============================================================

test("remove throws FORBIDDEN for a caller below the admin role", async () => {
  const t = convexTest(schema, modules);
  const { asUser: asAdmin, accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });
  const endpointId = await asAdmin.mutation(api.webhookEndpoints.create, {
    url: "https://example.com/hook",
    events: ["message.received"],
    secret: "whsec_test",
  });
  const viewerId = await seedTeammate(t, {
    accountId,
    name: "Vic",
    email: "vic@example.com",
    role: "viewer",
  });
  const asViewer = t.withIdentity({ subject: `${viewerId}|session-Vic` });

  await expect(
    asViewer.mutation(api.webhookEndpoints.remove, { endpointId }),
  ).rejects.toMatchObject({ data: { code: "FORBIDDEN", min: "admin" } });
});

test("remove deletes the caller's own account's endpoint", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });
  const endpointId = await asUser.mutation(api.webhookEndpoints.create, {
    url: "https://example.com/hook",
    events: ["message.received"],
    secret: "whsec_test",
  });

  await asUser.mutation(api.webhookEndpoints.remove, { endpointId });

  const row = await t.run((ctx) => ctx.db.get(endpointId));
  expect(row).toBeNull();
});

// ============================================================
// cross-account denial
// ============================================================

test("cross-account denial: B cannot list, update, or remove A's endpoint", async () => {
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
  const endpointId = await asAlice.mutation(api.webhookEndpoints.create, {
    url: "https://alice.example.com/hook",
    events: ["message.received"],
    secret: "whsec_alice",
  });

  // Bob's own list never contains Alice's endpoint — proves account
  // isolation, not just "update/remove fail".
  const bobsEndpoints = await asBob.query(api.webhookEndpoints.list, {});
  expect(bobsEndpoints).toHaveLength(0);

  await expect(
    asBob.mutation(api.webhookEndpoints.update, {
      endpointId,
      isActive: false,
    }),
  ).rejects.toMatchObject({
    data: { code: "NOT_FOUND", entity: "webhookEndpoint" },
  });
  await expect(
    asBob.mutation(api.webhookEndpoints.remove, { endpointId }),
  ).rejects.toMatchObject({
    data: { code: "NOT_FOUND", entity: "webhookEndpoint" },
  });

  // Untouched by Bob's rejected attempts.
  const row = await t.run((ctx) => ctx.db.get(endpointId));
  expect(row!.isActive).toBe(true);
  expect(row!.url).toBe("https://alice.example.com/hook");

  // Alice herself can still manage it — proves the throws above are
  // really about cross-account isolation, not a broken update/remove.
  await asAlice.mutation(api.webhookEndpoints.update, {
    endpointId,
    isActive: false,
  });
  const updated = await t.run((ctx) => ctx.db.get(endpointId));
  expect(updated!.isActive).toBe(false);

  await asAlice.mutation(api.webhookEndpoints.remove, { endpointId });
  const removed = await t.run((ctx) => ctx.db.get(endpointId));
  expect(removed).toBeNull();
});
