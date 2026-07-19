/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import type { AccountRole } from "./lib/roles";
import { decrypt } from "./lib/whatsappEncryption";

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
      accessToken: "plaintext-token",
      status: "connected",
    }),
  ).rejects.toMatchObject({ data: { code: "FORBIDDEN", min: "admin" } });
});

test("upsert creates a new row matching the supplied fields, with accessToken encrypted at rest", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId, userId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });

  const configId = await asUser.mutation(api.whatsappConfig.upsert, {
    phoneNumberId: "1000000000",
    wabaId: "waba-1",
    accessToken: "plaintext-token-v1",
    verifyToken: "verify-1",
    status: "connected",
    connectedAt: 1000,
  });

  const row = await t.run((ctx) => ctx.db.get(configId));
  expect(row!.accountId).toBe(accountId);
  expect(row!.createdByUserId).toBe(userId);
  expect(row!.phoneNumberId).toBe("1000000000");
  expect(row!.wabaId).toBe("waba-1");
  expect(row!.verifyToken).toBe("verify-1");
  expect(row!.status).toBe("connected");
  expect(row!.connectedAt).toBe(1000);
  expect(row!.updatedAt).toBeTypeOf("number");
  // Never stored as plaintext...
  expect(row!.accessToken).not.toBe("plaintext-token-v1");
  // ...but genuinely round-trips back to the original via decrypt().
  await expect(decrypt(row!.accessToken)).resolves.toBe("plaintext-token-v1");

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
    accessToken: "plaintext-token-v1",
    status: "connected",
  });
  const secondId = await asUser.mutation(api.whatsappConfig.upsert, {
    phoneNumberId: "1000000000",
    accessToken: "plaintext-token-v2",
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
  await expect(decrypt(rows[0]!.accessToken)).resolves.toBe(
    "plaintext-token-v2",
  );
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
    accessToken: "plaintext-token-v1",
    status: "connected",
    connectedAt: 1000,
  });

  // Rotate only the access token this time — `wabaId`/`connectedAt` are
  // omitted, not cleared.
  await asUser.mutation(api.whatsappConfig.upsert, {
    phoneNumberId: "1000000000",
    accessToken: "plaintext-token-v2",
    status: "connected",
  });

  const row = await t.run((ctx) => ctx.db.get(configId));
  await expect(decrypt(row!.accessToken)).resolves.toBe("plaintext-token-v2");
  expect(row!.wabaId).toBe("waba-1");
  expect(row!.connectedAt).toBe(1000);
});

test("upsert reuses the existing encrypted accessToken when omitted on a later call", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });

  const configId = await asUser.mutation(api.whatsappConfig.upsert, {
    phoneNumberId: "1000000000",
    accessToken: "plaintext-token-v1",
    status: "connected",
  });
  const firstRow = await t.run((ctx) => ctx.db.get(configId));
  const firstCiphertext = firstRow!.accessToken;

  // Second call flips `status` and omits `accessToken` entirely — the
  // stored ciphertext must be reused byte-for-byte (encrypt() draws a
  // fresh random IV every call, so if this had re-encrypted anything
  // the ciphertext string would differ even for the same plaintext).
  await asUser.mutation(api.whatsappConfig.upsert, {
    phoneNumberId: "1000000000",
    status: "disconnected",
  });

  const secondRow = await t.run((ctx) => ctx.db.get(configId));
  expect(secondRow!.accessToken).toBe(firstCiphertext);
  expect(secondRow!.status).toBe("disconnected");
  await expect(decrypt(secondRow!.accessToken)).resolves.toBe(
    "plaintext-token-v1",
  );
});

test("upsert throws ACCESS_TOKEN_REQUIRED on the first save with no accessToken supplied", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });

  await expect(
    asUser.mutation(api.whatsappConfig.upsert, {
      phoneNumberId: "1000000000",
      status: "connected",
    }),
  ).rejects.toMatchObject({ data: { code: "ACCESS_TOKEN_REQUIRED" } });

  const rows = await t.run((ctx) => ctx.db.query("whatsappConfig").collect());
  expect(rows).toHaveLength(0);
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
    accessToken: "plaintext-token-v1",
    status: "connected",
  });

  // Re-saving the SAME number the caller's own account already owns
  // must not trip PHONE_NUMBER_CLAIMED.
  await expect(
    asUser.mutation(api.whatsappConfig.upsert, {
      phoneNumberId: "1000000000",
      accessToken: "plaintext-token-v2",
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

// ============================================================
// remove — admin+ clears the caller's own account's config, if any
// ============================================================

test("remove deletes the caller's account's config row", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });
  await asUser.mutation(api.whatsappConfig.upsert, {
    phoneNumberId: "1000000000",
    accessToken: "plaintext-token-v1",
    status: "connected",
  });

  await asUser.mutation(api.whatsappConfig.remove, {});

  const rows = await t.run((ctx) =>
    ctx.db
      .query("whatsappConfig")
      .withIndex("by_account", (q) => q.eq("accountId", accountId))
      .collect(),
  );
  expect(rows).toHaveLength(0);
  expect(await asUser.query(api.whatsappConfig.get, {})).toBeNull();
});

test("remove is a no-op when the account has never configured WhatsApp", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });

  await expect(
    asUser.mutation(api.whatsappConfig.remove, {}),
  ).resolves.not.toThrow();
});

test("remove throws FORBIDDEN for a caller below the admin role, and leaves the config in place", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  // An agent can't create a config either (both are admin-gated), so
  // seed one directly, bypassing `upsert` — mirrors
  // `pipelines.test.ts`'s own raw-insert approach for the analogous
  // "remove throws FORBIDDEN" test.
  await t.run((ctx) =>
    ctx.db.insert("whatsappConfig", {
      accountId,
      phoneNumberId: "1000000000",
      accessToken: "irrelevant-for-this-test",
      status: "connected",
      updatedAt: Date.now(),
    }),
  );

  await expect(
    asUser.mutation(api.whatsappConfig.remove, {}),
  ).rejects.toMatchObject({ data: { code: "FORBIDDEN", min: "admin" } });

  const rows = await t.run((ctx) =>
    ctx.db
      .query("whatsappConfig")
      .withIndex("by_account", (q) => q.eq("accountId", accountId))
      .collect(),
  );
  expect(rows).toHaveLength(1);
});

test("cross-account denial: remove only clears the caller's own account's config", async () => {
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
    accessToken: "alice-plaintext-token",
    status: "connected",
  });
  await asBob.mutation(api.whatsappConfig.upsert, {
    phoneNumberId: "2000000000",
    accessToken: "bob-plaintext-token",
    status: "connected",
  });

  // Bob clears his own config — there is no `configId` argument for
  // him to (mis)target Alice's row with even if he tried.
  await asBob.mutation(api.whatsappConfig.remove, {});

  expect(await asBob.query(api.whatsappConfig.get, {})).toBeNull();
  const alicesConfig = await asAlice.query(api.whatsappConfig.get, {});
  expect(alicesConfig!.phoneNumberId).toBe("1000000000");
});

// ============================================================
// accountByPhoneNumberId — the webhook's own tenancy lookup (Phase 8,
// Task 4): every inbound Meta delivery carries phone_number_id
// ============================================================

test("accountByPhoneNumberId returns the config row (encrypted accessToken as-is) for a matching phoneNumberId", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });
  await asUser.mutation(api.whatsappConfig.upsert, {
    phoneNumberId: "1000000000",
    accessToken: "plaintext-token-v1",
    status: "connected",
  });

  const config = await t.query(internal.whatsappConfig.accountByPhoneNumberId, {
    phoneNumberId: "1000000000",
  });

  expect(config).not.toBeNull();
  expect(config!.accountId).toBe(accountId);
  expect(config!.phoneNumberId).toBe("1000000000");
  // Returned as-is — still ciphertext, never decrypted by this query.
  expect(config!.accessToken).not.toBe("plaintext-token-v1");
  await expect(decrypt(config!.accessToken)).resolves.toBe("plaintext-token-v1");
});

test("accountByPhoneNumberId returns null when no config matches", async () => {
  const t = convexTest(schema, modules);

  const config = await t.query(internal.whatsappConfig.accountByPhoneNumberId, {
    phoneNumberId: "unknown-number",
  });
  expect(config).toBeNull();
});

// ============================================================
// matchVerifyToken — the GET-verification check (Phase 8, Task 4),
// ported from route.ts's GET handler
// ============================================================

test("matchVerifyToken returns the accountId of the config whose decrypted verifyToken matches, and null otherwise", async () => {
  const t = convexTest(schema, modules);
  const { asUser: asAlice, accountId: aliceAccountId } = await seedAccountMember(t, {
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
    verifyToken: "alices-secret-verify-token",
    status: "connected",
  });
  await asBob.mutation(api.whatsappConfig.upsert, {
    phoneNumberId: "2000000000",
    accessToken: "bob-token",
    verifyToken: "bobs-secret-verify-token",
    status: "connected",
  });

  const matched = await t.query(internal.whatsappConfig.matchVerifyToken, {
    verifyToken: "alices-secret-verify-token",
  });
  expect(matched).toBe(aliceAccountId);

  const noMatch = await t.query(internal.whatsappConfig.matchVerifyToken, {
    verifyToken: "some-random-token-nobody-has",
  });
  expect(noMatch).toBeNull();
});

test("matchVerifyToken skips a config with no verifyToken set at all", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });
  // No `verifyToken` supplied.
  await asUser.mutation(api.whatsappConfig.upsert, {
    phoneNumberId: "1000000000",
    accessToken: "alice-token",
    status: "connected",
  });

  const matched = await t.query(internal.whatsappConfig.matchVerifyToken, {
    verifyToken: "anything",
  });
  expect(matched).toBeNull();
});

test("matchVerifyToken scans past non-matching rows (incl. one with no verifyToken at all) to find the right one", async () => {
  const t = convexTest(schema, modules);
  const { accountId: unconfiguredAccountId } = await seedAccountMember(t, {
    name: "Unconfigured",
    email: "unconfigured@example.com",
    role: "admin",
  });
  // A row with no verifyToken at all — inserted directly since `upsert`
  // requires one on first save only when `accessToken` needs a
  // fallback; simplest to just seed the shape directly here.
  await t.run((ctx) =>
    ctx.db.insert("whatsappConfig", {
      accountId: unconfiguredAccountId,
      phoneNumberId: "9999999999",
      accessToken: "irrelevant-for-this-test",
      status: "connected",
      updatedAt: Date.now(),
    }),
  );
  const { asUser: asOther } = await seedAccountMember(t, {
    name: "Other",
    email: "other@example.com",
    role: "admin",
  });
  await asOther.mutation(api.whatsappConfig.upsert, {
    phoneNumberId: "8888888888",
    accessToken: "other-token",
    verifyToken: "some-other-unrelated-token",
    status: "connected",
  });

  const { asUser: asHealthy, accountId: healthyAccountId } = await seedAccountMember(t, {
    name: "Healthy",
    email: "healthy@example.com",
    role: "admin",
  });
  await asHealthy.mutation(api.whatsappConfig.upsert, {
    phoneNumberId: "1000000000",
    accessToken: "healthy-token",
    verifyToken: "healthy-verify-token",
    status: "connected",
  });

  const matched = await t.query(internal.whatsappConfig.matchVerifyToken, {
    verifyToken: "healthy-verify-token",
  });
  expect(matched).toBe(healthyAccountId);
});

/**
 * The empty token is the one seam where "skip falsy stored tokens" and "look
 * the token up by equality" disagree: a stored `""` is falsy (so the scan form
 * skips it) but is a perfectly matchable index key. An unguarded lookup would
 * hand an accountId to a caller who supplied no token at all. Seeded directly
 * because `upsert` would not normally write an empty token.
 */
test("matchVerifyToken never matches an empty verify token, even against a config that stored one", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });
  await t.run((ctx) =>
    ctx.db.insert("whatsappConfig", {
      accountId,
      phoneNumberId: "1000000000",
      accessToken: "alice-token",
      verifyToken: "",
      status: "connected",
      updatedAt: Date.now(),
    }),
  );

  const matched = await t.query(internal.whatsappConfig.matchVerifyToken, {
    verifyToken: "",
  });

  expect(matched).toBeNull();
});

/**
 * Two accounts holding the same verify token is a misconfiguration rather than
 * a supported state, but it resolves to *something* and which one it resolves
 * to decides whose account a webhook is attributed to. Pinning "oldest wins"
 * keeps that tie-break from silently flipping — a scan walks creation order,
 * and so does the index, whose key is (verifyToken, _creationTime).
 */
test("matchVerifyToken resolves a duplicated verify token to the oldest config", async () => {
  const t = convexTest(schema, modules);
  const { accountId: firstAccountId } = await seedAccountMember(t, {
    name: "First",
    email: "first@example.com",
    role: "admin",
  });
  const { accountId: secondAccountId } = await seedAccountMember(t, {
    name: "Second",
    email: "second@example.com",
    role: "admin",
  });
  await t.run((ctx) =>
    ctx.db.insert("whatsappConfig", {
      accountId: firstAccountId,
      phoneNumberId: "1000000000",
      accessToken: "first-token",
      verifyToken: "shared-verify-token",
      status: "connected",
      updatedAt: Date.now(),
    }),
  );
  await t.run((ctx) =>
    ctx.db.insert("whatsappConfig", {
      accountId: secondAccountId,
      phoneNumberId: "2000000000",
      accessToken: "second-token",
      verifyToken: "shared-verify-token",
      status: "connected",
      updatedAt: Date.now(),
    }),
  );

  const matched = await t.query(internal.whatsappConfig.matchVerifyToken, {
    verifyToken: "shared-verify-token",
  });

  expect(matched).toBe(firstAccountId);
  expect(matched).not.toBe(secondAccountId);
});

// ============================================================
// verifyRegistration — admin-gated diagnostic action (transitive-
// Supabase gap-fill task). Convex port of `GET /api/whatsapp/config/
// verify-registration`.
// ============================================================

test("verifyRegistration in DRY-RUN reports a synthetic success, without ever calling Meta", async () => {
  process.env.CONVEX_META_DRY_RUN = "1";
  // Any network attempt is a bug in the DRY-RUN branch — fail loudly and
  // fast instead of hanging on a real request with no network access.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("fetch should never be called in DRY-RUN");
    }),
  );
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });
  await asUser.mutation(api.whatsappConfig.upsert, {
    phoneNumberId: "1000000000",
    wabaId: "waba-1",
    accessToken: "plaintext-token",
    status: "connected",
    registeredAt: 1000,
  });

  const result = await asUser.action(api.whatsappConfig.verifyRegistration, {});

  expect(result).toMatchObject({
    live: true,
    checks: {
      config_exists: true,
      token_decryptable: true,
      phone_metadata_ok: true,
      waba_subscribed_to_app: true,
      locally_marked_registered: true,
    },
    errors: [],
    registered_at: 1000,
  });

  vi.unstubAllGlobals();
  delete process.env.CONVEX_META_DRY_RUN;
});

test("verifyRegistration reports config_exists:false (never throws) when nothing is saved yet", async () => {
  delete process.env.CONVEX_META_DRY_RUN;
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });

  const result = await asUser.action(api.whatsappConfig.verifyRegistration, {});

  expect(result).toEqual({
    live: false,
    checks: { config_exists: false },
    message: "No WhatsApp configuration saved yet.",
  });
});

test("verifyRegistration performs the real Meta calls when not in DRY-RUN, via a mocked fetch", async () => {
  delete process.env.CONVEX_META_DRY_RUN;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/subscribed_apps")) {
        return new Response(
          JSON.stringify({ data: [{ whatsapp_business_api_data: { id: "app-1" } }] }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({ id: "1000000000", display_phone_number: "+15551234567" }),
        { status: 200 },
      );
    }),
  );
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });
  await asUser.mutation(api.whatsappConfig.upsert, {
    phoneNumberId: "1000000000",
    wabaId: "waba-1",
    accessToken: "plaintext-token",
    status: "connected",
    registeredAt: 1000,
  });

  const result = await asUser.action(api.whatsappConfig.verifyRegistration, {});

  expect(result).toMatchObject({
    live: true,
    checks: {
      phone_metadata_ok: true,
      waba_subscribed_to_app: true,
      locally_marked_registered: true,
    },
    errors: [],
  });

  vi.unstubAllGlobals();
});

test("verifyRegistration throws FORBIDDEN for a caller below the admin role", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });

  await expect(
    asUser.action(api.whatsappConfig.verifyRegistration, {}),
  ).rejects.toMatchObject({ data: { code: "FORBIDDEN", min: "admin" } });
});

test("verifyRegistration throws UNAUTHENTICATED when there is no identity", async () => {
  const t = convexTest(schema, modules);

  await expect(
    t.action(api.whatsappConfig.verifyRegistration, {}),
  ).rejects.toMatchObject({ data: { code: "UNAUTHENTICATED" } });
});

test("cross-account isolation: verifyRegistration never reads a different account's config", async () => {
  process.env.CONVEX_META_DRY_RUN = "1";
  const t = convexTest(schema, modules);
  const { asUser: asAlice } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });
  await asAlice.mutation(api.whatsappConfig.upsert, {
    phoneNumberId: "1000000000",
    wabaId: "waba-1",
    accessToken: "alice-token",
    status: "connected",
    registeredAt: 1000,
  });
  const { asUser: asBob } = await seedAccountMember(t, {
    name: "Bob",
    email: "bob@example.com",
    role: "admin",
  });

  const result = await asBob.action(api.whatsappConfig.verifyRegistration, {});

  expect(result).toEqual({
    live: false,
    checks: { config_exists: false },
    message: "No WhatsApp configuration saved yet.",
  });

  delete process.env.CONVEX_META_DRY_RUN;
});

// ============================================================
// fetchMedia — inbound-media-proxy action
// ============================================================

test("fetchMedia resolves an agent teammate's media via a mocked two-step Meta fetch, without ever returning the access token", async () => {
  const t = convexTest(schema, modules);
  // Admin sets up the WhatsApp config (`upsert` itself is admin-gated)...
  const { asUser: asAdmin, accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });
  await asAdmin.mutation(api.whatsappConfig.upsert, {
    phoneNumberId: "1000000000",
    wabaId: "waba-1",
    accessToken: "plaintext-token",
    status: "connected",
  });
  // ...but `fetchMedia`'s own floor is "agent": a non-admin teammate
  // viewing an inbox attachment must still succeed.
  const bobUserId = await seedTeammate(t, {
    accountId,
    name: "Bob",
    email: "bob@example.com",
    role: "agent",
  });
  const asBob = t.withIdentity({ subject: `${bobUserId}|session-Bob` });

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      // Step one — `getMediaUrl`: resolve the media id against Meta's
      // Graph API to a short-lived CDN URL + MIME type.
      if (url.includes("graph.facebook.com")) {
        return new Response(
          JSON.stringify({
            url: "https://cdn.example.com/media/abc",
            mime_type: "image/png",
          }),
          { status: 200 },
        );
      }
      // Step two — `downloadMedia`: download the bytes from that CDN URL.
      return new Response(new Uint8Array([1, 2, 3, 4]).buffer, {
        status: 200,
        headers: { "content-type": "image/png" },
      });
    }),
  );

  const result = await asBob.action(api.whatsappConfig.fetchMedia, {
    mediaId: "media-123",
  });

  expect(result.contentType).toBe("image/png");
  expect(new Uint8Array(result.data)).toEqual(new Uint8Array([1, 2, 3, 4]));
  // The decrypted access token must never be part of the return value.
  expect(Object.keys(result).sort()).toEqual(["contentType", "data"]);

  vi.unstubAllGlobals();
});

test("fetchMedia throws FORBIDDEN for a caller below the agent role", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "viewer",
  });

  await expect(
    asUser.action(api.whatsappConfig.fetchMedia, { mediaId: "media-123" }),
  ).rejects.toMatchObject({ data: { code: "FORBIDDEN", min: "agent" } });
});

test("fetchMedia throws UNAUTHENTICATED when there is no identity", async () => {
  const t = convexTest(schema, modules);

  await expect(
    t.action(api.whatsappConfig.fetchMedia, { mediaId: "media-123" }),
  ).rejects.toMatchObject({ data: { code: "UNAUTHENTICATED" } });
});

test("fetchMedia throws a clear error when the caller's own account has no WhatsApp config (also proves cross-account isolation)", async () => {
  const t = convexTest(schema, modules);
  const { asUser: asAlice } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });
  await asAlice.mutation(api.whatsappConfig.upsert, {
    phoneNumberId: "1000000000",
    wabaId: "waba-1",
    accessToken: "alice-token",
    status: "connected",
  });
  // Bob is a different account with no WhatsApp config of his own —
  // he must never be served Alice's media.
  const { asUser: asBob } = await seedAccountMember(t, {
    name: "Bob",
    email: "bob@example.com",
    role: "agent",
  });

  await expect(
    asBob.action(api.whatsappConfig.fetchMedia, { mediaId: "media-123" }),
  ).rejects.toThrow(/WhatsApp not configured/);
});

// ============================================================
// connectAndSave — Convex port of POST /api/whatsapp/config's
// verify -> register -> subscribe -> persist pipeline (connect-flow
// regression fix: the settings form's Save button had been wired
// straight onto `upsert` above, which only ever stored the row and
// never actually registered a saved production number for inbound
// webhooks).
// ============================================================

/**
 * Routes a stubbed `fetch` across the three Meta endpoints
 * `connectAndSave`/`connectionStatus` call, keyed by URL/method — same
 * "one mock, multiple endpoints" style as `verifyRegistration`'s own
 * tests above, extended to also handle the two WRITE endpoints
 * (`/register`, POST `/subscribed_apps`) those tests never needed.
 */
function mockConnectFetch(
  opts: {
    verifyOk?: boolean;
    verifyMessage?: string;
    registerOk?: boolean;
    registerMessage?: string;
    subscribeOk?: boolean;
  } = {},
) {
  const {
    verifyOk = true,
    verifyMessage = "Invalid OAuth access token",
    registerOk = true,
    registerMessage = "Two-step verification PIN required.",
    subscribeOk = true,
  } = opts;
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";

    if (url.includes("/register")) {
      if (registerOk) {
        return new Response(JSON.stringify({ success: true }), {
          status: 200,
        });
      }
      return new Response(
        JSON.stringify({ error: { message: registerMessage } }),
        { status: 400 },
      );
    }

    if (url.includes("/subscribed_apps") && method === "POST") {
      if (subscribeOk) {
        return new Response(JSON.stringify({ success: true }), {
          status: 200,
        });
      }
      return new Response(
        JSON.stringify({ error: { message: "subscribe failed" } }),
        { status: 400 },
      );
    }

    // verifyPhoneNumber (phone metadata GET).
    if (verifyOk) {
      return new Response(
        JSON.stringify({
          id: "1000000000",
          display_phone_number: "+15551234567",
        }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify({ error: { message: verifyMessage } }), {
      status: 401,
    });
  });
}

test("connectAndSave verifies, registers (with a PIN), subscribes the WABA, and persists a connected row on a first save", async () => {
  delete process.env.CONVEX_META_DRY_RUN;
  vi.stubGlobal("fetch", mockConnectFetch());
  const t = convexTest(schema, modules);
  const { asUser, accountId, userId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });

  const result = await asUser.action(api.whatsappConfig.connectAndSave, {
    phoneNumberId: "1000000000",
    wabaId: "waba-1",
    accessToken: "plaintext-token",
    verifyToken: "verify-1",
    pin: "123456",
  });

  expect(result).toMatchObject({
    success: true,
    saved: true,
    registered: true,
    registration_skipped: false,
    phone_info: { id: "1000000000" },
  });

  const row = await t.run((ctx) =>
    ctx.db
      .query("whatsappConfig")
      .withIndex("by_account", (q) => q.eq("accountId", accountId))
      .first(),
  );
  expect(row!.accountId).toBe(accountId);
  expect(row!.createdByUserId).toBe(userId);
  expect(row!.phoneNumberId).toBe("1000000000");
  expect(row!.wabaId).toBe("waba-1");
  expect(row!.verifyToken).toBe("verify-1");
  expect(row!.status).toBe("connected");
  expect(row!.connectedAt).toBeTypeOf("number");
  expect(row!.registeredAt).toBeTypeOf("number");
  expect(row!.subscribedAppsAt).toBeTypeOf("number");
  expect(row!.lastRegistrationError).toBeUndefined();
  await expect(decrypt(row!.accessToken)).resolves.toBe("plaintext-token");

  vi.unstubAllGlobals();
});

test("connectAndSave skips /register on a re-save of the same already-registered number with no PIN, falling back to the stored token when accessToken is omitted", async () => {
  delete process.env.CONVEX_META_DRY_RUN;
  vi.stubGlobal("fetch", mockConnectFetch());
  const t = convexTest(schema, modules);
  const { asUser, accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });

  await asUser.action(api.whatsappConfig.connectAndSave, {
    phoneNumberId: "1000000000",
    accessToken: "plaintext-token",
    pin: "123456",
  });

  // Second save: no accessToken (must fall back to the stored,
  // decrypted token) and no pin — /register must NOT be attempted
  // again since the number is already registered.
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/register")) {
        throw new Error("/register should not be called on this re-save");
      }
      return new Response(
        JSON.stringify({
          id: "1000000000",
          display_phone_number: "+15551234567",
        }),
        { status: 200 },
      );
    }),
  );

  const result = await asUser.action(api.whatsappConfig.connectAndSave, {
    phoneNumberId: "1000000000",
  });

  expect(result).toMatchObject({
    success: true,
    registered: true,
    registration_skipped: false,
  });

  const row = await t.run((ctx) =>
    ctx.db
      .query("whatsappConfig")
      .withIndex("by_account", (q) => q.eq("accountId", accountId))
      .first(),
  );
  await expect(decrypt(row!.accessToken)).resolves.toBe("plaintext-token");

  vi.unstubAllGlobals();
});

test("connectAndSave marks registration_skipped (not a failure) when saving with no PIN and no prior registration", async () => {
  delete process.env.CONVEX_META_DRY_RUN;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/register")) {
        throw new Error("/register should not be called with no PIN");
      }
      return new Response(
        JSON.stringify({
          id: "1000000000",
          display_phone_number: "+15551234567",
        }),
        { status: 200 },
      );
    }),
  );
  const t = convexTest(schema, modules);
  const { asUser, accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });

  const result = await asUser.action(api.whatsappConfig.connectAndSave, {
    phoneNumberId: "1000000000",
    accessToken: "plaintext-token",
  });

  expect(result).toMatchObject({
    success: true,
    registered: false,
    registration_skipped: true,
  });

  const row = await t.run((ctx) =>
    ctx.db
      .query("whatsappConfig")
      .withIndex("by_account", (q) => q.eq("accountId", accountId))
      .first(),
  );
  expect(row!.status).toBe("connected");
  expect(row!.registeredAt).toBeUndefined();

  vi.unstubAllGlobals();
});

test("connectAndSave still saves (as disconnected, with the error recorded) when /register fails", async () => {
  delete process.env.CONVEX_META_DRY_RUN;
  vi.stubGlobal(
    "fetch",
    mockConnectFetch({
      registerOk: false,
      registerMessage: "Two-step verification PIN required.",
    }),
  );
  const t = convexTest(schema, modules);
  const { asUser, accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });

  const result = await asUser.action(api.whatsappConfig.connectAndSave, {
    phoneNumberId: "1000000000",
    accessToken: "plaintext-token",
    pin: "000000",
  });

  expect(result).toMatchObject({
    success: false,
    saved: true,
    registered: false,
    registration_error: "Two-step verification PIN required.",
  });

  const row = await t.run((ctx) =>
    ctx.db
      .query("whatsappConfig")
      .withIndex("by_account", (q) => q.eq("accountId", accountId))
      .first(),
  );
  expect(row!.status).toBe("disconnected");
  expect(row!.connectedAt).toBeUndefined();
  expect(row!.registeredAt).toBeUndefined();
  expect(row!.lastRegistrationError).toBe("Two-step verification PIN required.");

  vi.unstubAllGlobals();
});

test("connectAndSave clears a previously recorded registration error once a retry succeeds", async () => {
  delete process.env.CONVEX_META_DRY_RUN;
  vi.stubGlobal("fetch", mockConnectFetch({ registerOk: false }));
  const t = convexTest(schema, modules);
  const { asUser, accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });

  await asUser.action(api.whatsappConfig.connectAndSave, {
    phoneNumberId: "1000000000",
    accessToken: "plaintext-token",
    pin: "000000",
  });
  let row = await t.run((ctx) =>
    ctx.db
      .query("whatsappConfig")
      .withIndex("by_account", (q) => q.eq("accountId", accountId))
      .first(),
  );
  expect(row!.lastRegistrationError).toBe("Two-step verification PIN required.");

  // Retry with a fresh PIN, this time succeeding.
  vi.stubGlobal("fetch", mockConnectFetch({ registerOk: true }));
  const result = await asUser.action(api.whatsappConfig.connectAndSave, {
    phoneNumberId: "1000000000",
    pin: "123456",
  });
  expect(result).toMatchObject({ success: true, registered: true });

  row = await t.run((ctx) =>
    ctx.db
      .query("whatsappConfig")
      .withIndex("by_account", (q) => q.eq("accountId", accountId))
      .first(),
  );
  expect(row!.status).toBe("connected");
  expect(row!.lastRegistrationError).toBeUndefined();
  expect(row!.registeredAt).toBeTypeOf("number");

  vi.unstubAllGlobals();
});

test("connectAndSave rejects a phoneNumberId already claimed by a different account, without ever calling Meta", async () => {
  delete process.env.CONVEX_META_DRY_RUN;
  const t = convexTest(schema, modules);
  const { asUser: asAlice } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });
  await asAlice.mutation(api.whatsappConfig.upsert, {
    phoneNumberId: "1000000000",
    accessToken: "alice-token",
    status: "connected",
  });

  const { asUser: asBob, accountId: bobAccountId } = await seedAccountMember(
    t,
    { name: "Bob", email: "bob@example.com", role: "admin" },
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("Meta should never be called for a rejected claim");
    }),
  );

  await expect(
    asBob.action(api.whatsappConfig.connectAndSave, {
      phoneNumberId: "1000000000",
      accessToken: "bob-token",
      pin: "123456",
    }),
  ).rejects.toMatchObject({ data: { code: "PHONE_NUMBER_CLAIMED" } });

  const bobsRows = await t.run((ctx) =>
    ctx.db
      .query("whatsappConfig")
      .withIndex("by_account", (q) => q.eq("accountId", bobAccountId))
      .collect(),
  );
  expect(bobsRows).toHaveLength(0);

  vi.unstubAllGlobals();
});

test("connectAndSave throws FORBIDDEN for a caller below the admin role", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });

  await expect(
    asUser.action(api.whatsappConfig.connectAndSave, {
      phoneNumberId: "1000000000",
      accessToken: "plaintext-token",
    }),
  ).rejects.toMatchObject({ data: { code: "FORBIDDEN", min: "admin" } });
});

test("connectAndSave throws UNAUTHENTICATED when there is no identity", async () => {
  const t = convexTest(schema, modules);
  await expect(
    t.action(api.whatsappConfig.connectAndSave, {
      phoneNumberId: "1000000000",
    }),
  ).rejects.toMatchObject({ data: { code: "UNAUTHENTICATED" } });
});

test("connectAndSave throws ACCESS_TOKEN_REQUIRED when no accessToken is supplied and none is stored yet", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });

  await expect(
    asUser.action(api.whatsappConfig.connectAndSave, {
      phoneNumberId: "1000000000",
    }),
  ).rejects.toMatchObject({ data: { code: "ACCESS_TOKEN_REQUIRED" } });
});

test("connectAndSave returns a structured error (and saves nothing) when Meta rejects the credentials", async () => {
  delete process.env.CONVEX_META_DRY_RUN;
  vi.stubGlobal(
    "fetch",
    mockConnectFetch({
      verifyOk: false,
      verifyMessage: "Invalid OAuth access token",
    }),
  );
  const t = convexTest(schema, modules);
  const { asUser, accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });

  const result = await asUser.action(api.whatsappConfig.connectAndSave, {
    phoneNumberId: "1000000000",
    accessToken: "plaintext-token",
    pin: "123456",
  });

  expect(result).toEqual({
    error: "Meta API error: Invalid OAuth access token",
  });

  const rows = await t.run((ctx) =>
    ctx.db
      .query("whatsappConfig")
      .withIndex("by_account", (q) => q.eq("accountId", accountId))
      .collect(),
  );
  expect(rows).toHaveLength(0);

  vi.unstubAllGlobals();
});

test("connectAndSave rejects a malformed PIN before ever calling Meta", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("Meta should never be called for a malformed PIN");
    }),
  );
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });

  const result = await asUser.action(api.whatsappConfig.connectAndSave, {
    phoneNumberId: "1000000000",
    accessToken: "plaintext-token",
    pin: "12ab",
  });

  expect(result).toEqual({ error: "PIN must be exactly 6 digits." });

  vi.unstubAllGlobals();
});

// ============================================================
// WABA-ID-equals-Phone-Number-ID guard + Meta "#100" humanization.
// A WhatsApp Business Account ID and a Phone Number ID are two DIFFERENT
// Meta objects; pasting the same value into both is the copy-paste
// mistake that used to surface only as Meta's opaque "#100" once a
// WABA-scoped call ran. Reject it up front (before any Meta call), on
// BOTH the store-only `upsert` path and the `connectAndSave` action,
// and translate a genuine Meta #100 into plain English.
// ============================================================

test("connectAndSave rejects a wabaId equal to the phoneNumberId before ever calling Meta", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("Meta should never be called when WABA == phone number");
    }),
  );
  const t = convexTest(schema, modules);
  const { asUser, accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });

  const result = await asUser.action(api.whatsappConfig.connectAndSave, {
    phoneNumberId: "1000000000",
    wabaId: "1000000000",
    accessToken: "plaintext-token",
    pin: "123456",
  });

  expect(result).toHaveProperty("error");
  expect((result as { error: string }).error).toMatch(
    /WhatsApp Business Account ID and Phone Number ID must be different/i,
  );

  // Nothing persisted — the guard runs before verify/register/persist.
  const rows = await t.run((ctx) =>
    ctx.db
      .query("whatsappConfig")
      .withIndex("by_account", (q) => q.eq("accountId", accountId))
      .collect(),
  );
  expect(rows).toHaveLength(0);

  vi.unstubAllGlobals();
});

test("upsert rejects a wabaId equal to the phoneNumberId with WABA_EQUALS_PHONE_NUMBER", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });

  await expect(
    asUser.mutation(api.whatsappConfig.upsert, {
      phoneNumberId: "1000000000",
      wabaId: "1000000000",
      accessToken: "alice-token",
      status: "connected",
    }),
  ).rejects.toMatchObject({ data: { code: "WABA_EQUALS_PHONE_NUMBER" } });

  const rows = await t.run((ctx) =>
    ctx.db
      .query("whatsappConfig")
      .withIndex("by_account", (q) => q.eq("accountId", accountId))
      .collect(),
  );
  expect(rows).toHaveLength(0);
});

test("connectAndSave surfaces a plain-English message when Meta returns error #100", async () => {
  delete process.env.CONVEX_META_DRY_RUN;
  const metaRaw =
    "Unsupported get request. Object with ID '1000000000' does not exist, " +
    "cannot be loaded due to missing permissions, or does not support this operation.";
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({ error: { message: metaRaw, code: 100 } }),
          { status: 400 },
        ),
    ),
  );
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });

  const result = await asUser.action(api.whatsappConfig.connectAndSave, {
    phoneNumberId: "1000000000",
    wabaId: "waba-1",
    accessToken: "plaintext-token",
    pin: "123456",
  });

  expect(result).toHaveProperty("error");
  const message = (result as { error: string }).error;
  // Friendly, actionable text — not just Meta's opaque string.
  expect(message).toMatch(/#100/);
  expect(message).toMatch(/access token/i);
  // Meta's own text is preserved in-line for debugging.
  expect(message).toContain(metaRaw);

  vi.unstubAllGlobals();
});

test("connectAndSave still succeeds when WABA subscription fails (non-fatal)", async () => {
  delete process.env.CONVEX_META_DRY_RUN;
  vi.stubGlobal("fetch", mockConnectFetch({ subscribeOk: false }));
  const t = convexTest(schema, modules);
  const { asUser, accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });

  const result = await asUser.action(api.whatsappConfig.connectAndSave, {
    phoneNumberId: "1000000000",
    wabaId: "waba-1",
    accessToken: "plaintext-token",
    pin: "123456",
  });

  expect(result).toMatchObject({ success: true, registered: true });

  const row = await t.run((ctx) =>
    ctx.db
      .query("whatsappConfig")
      .withIndex("by_account", (q) => q.eq("accountId", accountId))
      .first(),
  );
  expect(row!.status).toBe("connected");
  expect(row!.subscribedAppsAt).toBeUndefined();

  vi.unstubAllGlobals();
});

test("connectAndSave in DRY-RUN synthesizes a full success without ever calling Meta", async () => {
  process.env.CONVEX_META_DRY_RUN = "1";
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("fetch should never be called in DRY-RUN");
    }),
  );
  const t = convexTest(schema, modules);
  const { asUser, accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });

  const result = await asUser.action(api.whatsappConfig.connectAndSave, {
    phoneNumberId: "1000000000",
    wabaId: "waba-1",
    accessToken: "plaintext-token",
    pin: "123456",
  });

  expect(result).toMatchObject({
    success: true,
    registered: true,
    registration_skipped: false,
    phone_info: { verified_name: "DRY-RUN" },
  });

  const row = await t.run((ctx) =>
    ctx.db
      .query("whatsappConfig")
      .withIndex("by_account", (q) => q.eq("accountId", accountId))
      .first(),
  );
  expect(row!.status).toBe("connected");
  expect(row!.registeredAt).toBeTypeOf("number");
  expect(row!.subscribedAppsAt).toBeTypeOf("number");

  vi.unstubAllGlobals();
  delete process.env.CONVEX_META_DRY_RUN;
});

// ============================================================
// connectionStatus — Convex port of GET /api/whatsapp/config's health
// check (connect-flow regression fix companion: the settings form's
// health banner/"Test API Connection" button and
// settings-overview.tsx's WhatsApp tile both still hit the legacy
// Supabase-backed route before this).
// ============================================================

test("connectionStatus reports no_config when nothing is saved yet", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });

  const result = await asUser.action(api.whatsappConfig.connectionStatus, {});
  expect(result).toEqual({
    connected: false,
    reason: "no_config",
    message:
      "No WhatsApp configuration saved yet. Fill in the form and click Save Configuration.",
  });
});

test("connectionStatus reports connected:true with phone_info for a healthy config", async () => {
  delete process.env.CONVEX_META_DRY_RUN;
  vi.stubGlobal("fetch", mockConnectFetch());
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });
  await asUser.mutation(api.whatsappConfig.upsert, {
    phoneNumberId: "1000000000",
    accessToken: "plaintext-token",
    status: "connected",
  });

  const result = await asUser.action(api.whatsappConfig.connectionStatus, {});
  expect(result).toMatchObject({
    connected: true,
    phone_info: { id: "1000000000" },
  });

  vi.unstubAllGlobals();
});

test("connectionStatus reports meta_api_error when Meta rejects the credentials", async () => {
  delete process.env.CONVEX_META_DRY_RUN;
  vi.stubGlobal(
    "fetch",
    mockConnectFetch({
      verifyOk: false,
      verifyMessage: "Invalid OAuth access token",
    }),
  );
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });
  await asUser.mutation(api.whatsappConfig.upsert, {
    phoneNumberId: "1000000000",
    accessToken: "plaintext-token",
    status: "connected",
  });

  const result = await asUser.action(api.whatsappConfig.connectionStatus, {});
  expect(result).toMatchObject({
    connected: false,
    reason: "meta_api_error",
    message: "Meta API rejected the credentials: Invalid OAuth access token",
  });

  vi.unstubAllGlobals();
});

test("connectionStatus reports token_corrupted + needs_reset when the stored token can't be decrypted", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });
  await t.run((ctx) =>
    ctx.db.insert("whatsappConfig", {
      accountId,
      phoneNumberId: "1000000000",
      accessToken: "not-a-valid-ciphertext",
      status: "connected",
      updatedAt: Date.now(),
    }),
  );

  const result = await asUser.action(api.whatsappConfig.connectionStatus, {});
  expect(result).toMatchObject({
    connected: false,
    reason: "token_corrupted",
    needs_reset: true,
  });
});

test("connectionStatus in DRY-RUN reports a synthetic success without ever calling Meta", async () => {
  process.env.CONVEX_META_DRY_RUN = "1";
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("fetch should never be called in DRY-RUN");
    }),
  );
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });
  await asUser.mutation(api.whatsappConfig.upsert, {
    phoneNumberId: "1000000000",
    accessToken: "plaintext-token",
    status: "connected",
  });

  const result = await asUser.action(api.whatsappConfig.connectionStatus, {});
  expect(result).toMatchObject({
    connected: true,
    phone_info: { verified_name: "DRY-RUN" },
  });

  vi.unstubAllGlobals();
  delete process.env.CONVEX_META_DRY_RUN;
});

test("connectionStatus is reachable by a non-admin viewer (role floor)", async () => {
  process.env.CONVEX_META_DRY_RUN = "1";
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

  const result = await asViewer.action(api.whatsappConfig.connectionStatus, {});
  expect(result).toMatchObject({ connected: true });

  delete process.env.CONVEX_META_DRY_RUN;
});

test("connectionStatus throws UNAUTHENTICATED when there is no identity", async () => {
  const t = convexTest(schema, modules);
  await expect(
    t.action(api.whatsappConfig.connectionStatus, {}),
  ).rejects.toMatchObject({ data: { code: "UNAUTHENTICATED" } });
});

test("cross-account isolation: connectionStatus never reads a different account's config", async () => {
  const t = convexTest(schema, modules);
  const { asUser: asAlice } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });
  await asAlice.mutation(api.whatsappConfig.upsert, {
    phoneNumberId: "1000000000",
    accessToken: "alice-token",
    status: "connected",
  });
  const { asUser: asBob } = await seedAccountMember(t, {
    name: "Bob",
    email: "bob@example.com",
    role: "admin",
  });

  const result = await asBob.action(api.whatsappConfig.connectionStatus, {});
  expect(result).toMatchObject({ connected: false, reason: "no_config" });
});

// ============================================================
// resolveInboundMedia — inbound-media resolver (internal action).
// Best-effort: returns null (never throws) when the account has no
// config so a media that can't be fetched degrades to an "unavailable"
// bubble in the inbox rather than derailing inbound processing.
// ============================================================

test("resolveInboundMedia returns null when the account has no WhatsApp config", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "owner",
  });

  const result = await t.action(internal.whatsappConfig.resolveInboundMedia, {
    accountId,
    mediaId: "meta-audio-1",
  });
  expect(result).toBeNull();
});

test("resolveInboundMedia downloads Meta media into R2 and returns its key (not a URL)", async () => {
  // R2-migration cutover (Task 7): `resolveInboundMedia` used to resolve
  // the R2 key it got from `files.storeFromUrl` (Task 6) straight into a
  // public URL (`publicUrl(r2ConfigFromEnv(), key)`) as a behavior-
  // preserving shim. That shim is retired — this test locks in the new
  // `{ key }` contract directly, independent of `ingest.test.ts`'s own
  // full `processInbound` coverage of the same path.
  process.env.R2_BUCKET = "test-bucket";
  process.env.R2_ENDPOINT = "https://test.r2.cloudflarestorage.com";
  process.env.R2_ACCESS_KEY_ID = "test-key";
  process.env.R2_SECRET_ACCESS_KEY = "test-secret";
  process.env.R2_PUBLIC_HOST = "https://objs.holidayys.co";
  const t = convexTest(schema, modules);
  const { asUser: asAdmin, accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });
  await asAdmin.mutation(api.whatsappConfig.upsert, {
    phoneNumberId: "1000000000",
    wabaId: "waba-1",
    accessToken: "plaintext-token",
    status: "connected",
  });

  // Same three-leg mock `ingest.test.ts`'s voice-note test uses: Meta's
  // getMediaUrl (id -> CDN url + mime), the authenticated CDN download,
  // then the R2 PUT `files.storeFromUrl` now makes — that PUT goes
  // through `aws4fetch`, which signs a `Request` and invokes the global
  // `fetch` with that single `Request` object as its only argument, so
  // this mock must handle both calling conventions.
  const bytes = new TextEncoder().encode("png-bytes");
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    if (input instanceof Request) {
      return new Response(null, { status: 200 });
    }
    const url = String(input);
    if (url.includes("graph.facebook.com")) {
      return new Response(
        JSON.stringify({ url: "https://cdn.example.com/media/abc", mime_type: "image/png" }),
        { status: 200 },
      );
    }
    return new Response(bytes, {
      status: 200,
      headers: { "content-type": "image/png" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);

  const result = await t.action(internal.whatsappConfig.resolveInboundMedia, {
    accountId,
    mediaId: "media-123",
  });

  // The fix (Task 7): a raw R2 object key, shaped
  // `<accountId>/inbound/<random><ext>` (`convex/lib/r2/keys.ts`'s
  // `buildMediaKey`) — NOT a resolved `{ url }`. The caller
  // (`convex/ingest.ts`) persists this key directly; resolving it to a
  // public URL is left entirely to the read path
  // (`convex/lib/r2/url.ts`'s `resolveMediaUrl`, Task 5).
  expect(result).not.toBeNull();
  expect(result!.key).toMatch(/^[^/]+\/inbound\//);
  expect(Object.keys(result!)).toEqual(["key"]);

  vi.unstubAllGlobals();
  delete process.env.R2_BUCKET;
  delete process.env.R2_ENDPOINT;
  delete process.env.R2_ACCESS_KEY_ID;
  delete process.env.R2_SECRET_ACCESS_KEY;
  delete process.env.R2_PUBLIC_HOST;
});

// ============================================================
// connectionState — member-safe connection state query
// ============================================================

test("connectionState exposes only status and configured-ness", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser: asOwner } = await seedAccountMember(t, {
    name: "Owner",
    email: "owner@example.com",
    role: "owner",
  });
  await asOwner.mutation(api.whatsappConfig.upsert, {
    phoneNumberId: "123456789",
    wabaId: "987654321",
    accessToken: "EAA-secret-token",
    status: "connected",
  });

  const viewerId = await seedTeammate(t, {
    accountId,
    name: "Vee",
    email: "vee@example.com",
    role: "viewer",
  });
  const asViewer = t.withIdentity({ subject: `${viewerId}|session-Vee` });

  const state = await asViewer.query(api.whatsappConfig.connectionState, {});
  expect(state).toEqual({ status: "connected", isConfigured: true });
  // The identifiers the raw row carries must not ride along.
  expect(state).not.toHaveProperty("phoneNumberId");
  expect(state).not.toHaveProperty("wabaId");
  expect(state).not.toHaveProperty("accessToken");
});

test("connectionState reports an unconfigured account without throwing", async () => {
  const t = convexTest(schema, modules);
  const { asUser: asOwner } = await seedAccountMember(t, {
    name: "Owner",
    email: "owner@example.com",
    role: "owner",
  });

  const state = await asOwner.query(api.whatsappConfig.connectionState, {});
  expect(state).toEqual({ status: null, isConfigured: false });
});
