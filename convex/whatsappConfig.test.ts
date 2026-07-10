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
