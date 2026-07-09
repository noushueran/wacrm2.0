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
// get — the caller's own account's single config, or null
// ============================================================

test("get returns null when the account has never configured WhatsApp", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });

  const config = await asUser.query(api.whatsappConfig.get, {});
  expect(config).toBeNull();
});

// ============================================================
// upsert — admin+ gate, insert-or-patch, schema-matching fields
// ============================================================

test("upsert throws FORBIDDEN for a caller below the admin role", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });

  await expect(
    asUser.mutation(api.whatsappConfig.upsert, {
      phoneNumberId: "1000000000",
      accessToken: "encrypted-token",
      status: "connected",
    }),
  ).rejects.toMatchObject({ data: { code: "FORBIDDEN", min: "admin" } });
});

test("upsert creates a new row matching the supplied fields", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId, userId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });

  const configId = await asUser.mutation(api.whatsappConfig.upsert, {
    phoneNumberId: "1000000000",
    wabaId: "waba-1",
    accessToken: "encrypted-token-v1",
    verifyToken: "verify-1",
    status: "connected",
    connectedAt: 1000,
  });

  const row = await t.run((ctx) => ctx.db.get(configId));
  expect(row!.accountId).toBe(accountId);
  expect(row!.createdByUserId).toBe(userId);
  expect(row!.phoneNumberId).toBe("1000000000");
  expect(row!.wabaId).toBe("waba-1");
  expect(row!.accessToken).toBe("encrypted-token-v1");
  expect(row!.verifyToken).toBe("verify-1");
  expect(row!.status).toBe("connected");
  expect(row!.connectedAt).toBe(1000);
  expect(row!.updatedAt).toBeTypeOf("number");

  const fetched = await asUser.query(api.whatsappConfig.get, {});
  expect(fetched!._id).toBe(configId);
});

test("upsert is idempotent per account: a second call patches the same row", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });

  const firstId = await asUser.mutation(api.whatsappConfig.upsert, {
    phoneNumberId: "1000000000",
    accessToken: "encrypted-token-v1",
    status: "connected",
  });
  const secondId = await asUser.mutation(api.whatsappConfig.upsert, {
    phoneNumberId: "1000000000",
    accessToken: "encrypted-token-v2",
    status: "connected",
  });

  expect(secondId).toBe(firstId);

  const rows = await t.run((ctx) =>
    ctx.db
      .query("whatsappConfig")
      .withIndex("by_account", (q) => q.eq("accountId", accountId))
      .collect(),
  );
  expect(rows).toHaveLength(1);
  expect(rows[0]!.accessToken).toBe("encrypted-token-v2");
});

test("upsert patches only the fields supplied, leaving the rest untouched", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });

  const configId = await asUser.mutation(api.whatsappConfig.upsert, {
    phoneNumberId: "1000000000",
    wabaId: "waba-1",
    accessToken: "encrypted-token-v1",
    status: "connected",
    connectedAt: 1000,
  });

  // Rotate only the access token this time — `wabaId`/`connectedAt` are
  // omitted, not cleared.
  await asUser.mutation(api.whatsappConfig.upsert, {
    phoneNumberId: "1000000000",
    accessToken: "encrypted-token-v2",
    status: "connected",
  });

  const row = await t.run((ctx) => ctx.db.get(configId));
  expect(row!.accessToken).toBe("encrypted-token-v2");
  expect(row!.wabaId).toBe("waba-1");
  expect(row!.connectedAt).toBe(1000);
});

test("upsert rejects a phoneNumberId already claimed by another account", async () => {
  const t = convexTest(schema, modules);
  const { asUser: asAlice } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });
  const { asUser: asBob, accountId: bobAccountId } = await seedAccountMember(
    t,
    { name: "Bob", email: "bob@example.com", role: "admin" },
  );

  await asAlice.mutation(api.whatsappConfig.upsert, {
    phoneNumberId: "1000000000",
    accessToken: "alice-token",
    status: "connected",
  });

  await expect(
    asBob.mutation(api.whatsappConfig.upsert, {
      phoneNumberId: "1000000000",
      accessToken: "bob-token",
      status: "connected",
    }),
  ).rejects.toMatchObject({ data: { code: "PHONE_NUMBER_CLAIMED" } });

  // Bob's account gets no row out of the rejected attempt.
  const bobsRows = await t.run((ctx) =>
    ctx.db
      .query("whatsappConfig")
      .withIndex("by_account", (q) => q.eq("accountId", bobAccountId))
      .collect(),
  );
  expect(bobsRows).toHaveLength(0);
});

test("upsert accepts a different, unclaimed phoneNumberId for another account", async () => {
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

  await asAlice.mutation(api.whatsappConfig.upsert, {
    phoneNumberId: "1000000000",
    accessToken: "alice-token",
    status: "connected",
  });

  const bobConfigId = await asBob.mutation(api.whatsappConfig.upsert, {
    phoneNumberId: "2000000000",
    accessToken: "bob-token",
    status: "connected",
  });

  const row = await t.run((ctx) => ctx.db.get(bobConfigId));
  expect(row!.phoneNumberId).toBe("2000000000");
});

test("upsert re-saving the same account's own phoneNumberId is not a conflict", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });

  await asUser.mutation(api.whatsappConfig.upsert, {
    phoneNumberId: "1000000000",
    accessToken: "encrypted-token-v1",
    status: "connected",
  });

  // Re-saving the SAME number the caller's own account already owns
  // must not trip PHONE_NUMBER_CLAIMED.
  await expect(
    asUser.mutation(api.whatsappConfig.upsert, {
      phoneNumberId: "1000000000",
      accessToken: "encrypted-token-v2",
      status: "connected",
    }),
  ).resolves.toBeDefined();
});

// ============================================================
// cross-account denial
// ============================================================

test("cross-account denial: B's get never sees A's config", async () => {
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

  await asAlice.mutation(api.whatsappConfig.upsert, {
    phoneNumberId: "1000000000",
    accessToken: "alice-token",
    status: "connected",
  });

  const bobsConfig = await asBob.query(api.whatsappConfig.get, {});
  expect(bobsConfig).toBeNull();

  // Alice still sees her own.
  const alicesConfig = await asAlice.query(api.whatsappConfig.get, {});
  expect(alicesConfig!.phoneNumberId).toBe("1000000000");
});

test("get is visible to a non-admin member of the same account", async () => {
  const t = convexTest(schema, modules);
  const { asUser: asAdmin, accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });
  await asAdmin.mutation(api.whatsappConfig.upsert, {
    phoneNumberId: "1000000000",
    accessToken: "alice-token",
    status: "connected",
  });
  const viewerId = await seedTeammate(t, {
    accountId,
    name: "Vic",
    email: "vic@example.com",
    role: "viewer",
  });
  const asViewer = t.withIdentity({ subject: `${viewerId}|session-Vic` });

  const config = await asViewer.query(api.whatsappConfig.get, {});
  expect(config!.phoneNumberId).toBe("1000000000");
});
