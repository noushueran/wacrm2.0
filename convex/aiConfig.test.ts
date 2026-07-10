/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import type { AccountRole } from "./lib/roles";
import { decrypt } from "./lib/whatsappEncryption";

// Convex function modules for convex-test to resolve `api.*`/`internal.*`
// references against. Absolute, from-project-root pattern (matches every
// other `convex/*.test.ts` suite — see `convex/lib/auth.test.ts`'s
// comment for why this must be absolute rather than a relative "./**").
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

// Minimal valid upsert payload — every REQUIRED arg (per the brief:
// provider/model/isActive/autoReplyEnabled/autoReplyMaxPerConversation
// are required on every call; systemPrompt/handoffAgentId/apiKey/
// embeddingsApiKey are optional).
const BASE_ARGS = {
  provider: "openai" as const,
  model: "gpt-4o-mini",
  isActive: true,
  autoReplyEnabled: false,
  autoReplyMaxPerConversation: 3,
};

// ============================================================
// get — never leaks the encrypted keys, only hasKey/hasEmbeddingsKey
// ============================================================

test("get returns null when the account has never configured AI", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });

  const config = await asUser.query(api.aiConfig.get, {});
  expect(config).toBeNull();
});

test("get never returns apiKey/embeddingsApiKey, and reports hasKey/hasEmbeddingsKey correctly", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });

  await asUser.mutation(api.aiConfig.upsert, {
    ...BASE_ARGS,
    apiKey: "sk-plaintext-chat-key",
    embeddingsApiKey: "sk-plaintext-embeddings-key",
  });

  const config = await asUser.query(api.aiConfig.get, {});
  expect(config).not.toBeNull();
  expect(config).not.toHaveProperty("apiKey");
  expect(config).not.toHaveProperty("embeddingsApiKey");
  expect(config!.hasKey).toBe(true);
  expect(config!.hasEmbeddingsKey).toBe(true);
  expect(config!.provider).toBe("openai");
  expect(config!.model).toBe("gpt-4o-mini");
  expect(config!.isActive).toBe(true);
  expect(config!.autoReplyEnabled).toBe(false);
  expect(config!.autoReplyMaxPerConversation).toBe(3);
});

test("get reports hasEmbeddingsKey false when no embeddings key was ever set", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });

  await asUser.mutation(api.aiConfig.upsert, {
    ...BASE_ARGS,
    apiKey: "sk-plaintext-chat-key",
  });

  const config = await asUser.query(api.aiConfig.get, {});
  expect(config!.hasKey).toBe(true);
  expect(config!.hasEmbeddingsKey).toBe(false);
});

test("get is visible to a non-admin member of the same account", async () => {
  const t = convexTest(schema, modules);
  const { asUser: asAdmin, accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });
  await asAdmin.mutation(api.aiConfig.upsert, {
    ...BASE_ARGS,
    apiKey: "sk-plaintext-chat-key",
  });
  const viewerId = await seedTeammate(t, {
    accountId,
    name: "Vic",
    email: "vic@example.com",
    role: "viewer",
  });
  const asViewer = t.withIdentity({ subject: `${viewerId}|session-Vic` });

  const config = await asViewer.query(api.aiConfig.get, {});
  expect(config!.hasKey).toBe(true);
});

// ============================================================
// upsert — admin+ gate, insert-or-patch, encrypt-when-provided /
// reuse-when-omitted
// ============================================================

test("upsert throws FORBIDDEN for a caller below the admin role", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });

  await expect(
    asUser.mutation(api.aiConfig.upsert, {
      ...BASE_ARGS,
      apiKey: "sk-plaintext-chat-key",
    }),
  ).rejects.toMatchObject({ data: { code: "FORBIDDEN", min: "admin" } });
});

test("upsert throws API_KEY_REQUIRED on the first save with no apiKey supplied", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });

  await expect(
    asUser.mutation(api.aiConfig.upsert, { ...BASE_ARGS }),
  ).rejects.toMatchObject({ data: { code: "API_KEY_REQUIRED" } });
});

test("upsert creates a new row with the apiKey encrypted at rest", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId, userId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });

  const configId = await asUser.mutation(api.aiConfig.upsert, {
    ...BASE_ARGS,
    systemPrompt: "Be nice",
    apiKey: "sk-plaintext-chat-key",
  });

  const row = await t.run((ctx) => ctx.db.get(configId));
  expect(row!.accountId).toBe(accountId);
  expect(row!.createdByUserId).toBe(userId);
  expect(row!.provider).toBe("openai");
  expect(row!.model).toBe("gpt-4o-mini");
  expect(row!.systemPrompt).toBe("Be nice");
  expect(row!.updatedAt).toBeTypeOf("number");
  // Never stored as plaintext...
  expect(row!.apiKey).not.toBe("sk-plaintext-chat-key");
  // ...but genuinely round-trips back to the original via decrypt().
  await expect(decrypt(row!.apiKey)).resolves.toBe("sk-plaintext-chat-key");
});

test("upsert is idempotent per account: a second call patches the same row", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });

  const firstId = await asUser.mutation(api.aiConfig.upsert, {
    ...BASE_ARGS,
    apiKey: "sk-plaintext-chat-key",
  });
  const secondId = await asUser.mutation(api.aiConfig.upsert, {
    ...BASE_ARGS,
    model: "gpt-4o",
    apiKey: "sk-plaintext-chat-key-v2",
  });

  expect(secondId).toBe(firstId);

  const rows = await t.run((ctx) =>
    ctx.db
      .query("aiConfigs")
      .withIndex("by_account", (q) => q.eq("accountId", accountId))
      .collect(),
  );
  expect(rows).toHaveLength(1);
  expect(rows[0]!.model).toBe("gpt-4o");
});

test("upsert reuses the existing encrypted apiKey when omitted on a later call", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });

  const configId = await asUser.mutation(api.aiConfig.upsert, {
    ...BASE_ARGS,
    apiKey: "sk-plaintext-chat-key",
  });
  const firstRow = await t.run((ctx) => ctx.db.get(configId));
  const firstCiphertext = firstRow!.apiKey;

  // Second call flips `isActive` and omits `apiKey` entirely — the
  // stored ciphertext must be reused byte-for-byte (encrypt() draws a
  // fresh random IV every call, so if this had re-encrypted anything
  // the ciphertext string would differ even for the same plaintext).
  await asUser.mutation(api.aiConfig.upsert, {
    ...BASE_ARGS,
    isActive: false,
  });

  const secondRow = await t.run((ctx) => ctx.db.get(configId));
  expect(secondRow!.apiKey).toBe(firstCiphertext);
  expect(secondRow!.isActive).toBe(false);

  // And it still decrypts to the ORIGINAL plaintext via loadDecrypted.
  const decrypted = await t.query(internal.aiConfig.loadDecrypted, {
    accountId: firstRow!.accountId,
  });
  expect(decrypted!.apiKey).toBe("sk-plaintext-chat-key");
});

test("upsert reuses the existing encrypted embeddingsApiKey when omitted on a later call", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });

  const configId = await asUser.mutation(api.aiConfig.upsert, {
    ...BASE_ARGS,
    apiKey: "sk-plaintext-chat-key",
    embeddingsApiKey: "sk-plaintext-embeddings-key",
  });
  const firstRow = await t.run((ctx) => ctx.db.get(configId));
  const firstCiphertext = firstRow!.embeddingsApiKey;
  expect(firstCiphertext).toBeDefined();

  await asUser.mutation(api.aiConfig.upsert, {
    ...BASE_ARGS,
    apiKey: "sk-plaintext-chat-key", // supplied again, doesn't matter
  });

  const secondRow = await t.run((ctx) => ctx.db.get(configId));
  expect(secondRow!.embeddingsApiKey).toBe(firstCiphertext);
});

test("upsert patches only the optional fields supplied, leaving the rest untouched", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });
  const agentId = await seedTeammate(t, {
    accountId,
    name: "Handoff Agent",
    email: "handoff@example.com",
    role: "agent",
  });

  const configId = await asUser.mutation(api.aiConfig.upsert, {
    ...BASE_ARGS,
    systemPrompt: "Be nice",
    handoffAgentId: agentId,
    apiKey: "sk-plaintext-chat-key",
  });

  // Omit systemPrompt/handoffAgentId this time — both must survive.
  await asUser.mutation(api.aiConfig.upsert, {
    ...BASE_ARGS,
    model: "gpt-4o",
  });

  const row = await t.run((ctx) => ctx.db.get(configId));
  expect(row!.model).toBe("gpt-4o");
  expect(row!.systemPrompt).toBe("Be nice");
  expect(row!.handoffAgentId).toBe(agentId);
});

// ============================================================
// loadDecrypted — internalQuery, decrypts apiKey/embeddingsApiKey
// ============================================================

test("loadDecrypted returns null when the account has no config", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });

  const result = await t.query(internal.aiConfig.loadDecrypted, {
    accountId,
  });
  expect(result).toBeNull();
});

test("loadDecrypted returns the decrypted apiKey and embeddingsApiKey", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });

  await asUser.mutation(api.aiConfig.upsert, {
    ...BASE_ARGS,
    apiKey: "sk-plaintext-chat-key",
    embeddingsApiKey: "sk-plaintext-embeddings-key",
  });

  const result = await t.query(internal.aiConfig.loadDecrypted, {
    accountId,
  });
  expect(result!.apiKey).toBe("sk-plaintext-chat-key");
  expect(result!.embeddingsApiKey).toBe("sk-plaintext-embeddings-key");
  expect(result!.provider).toBe("openai");
  expect(result!.isActive).toBe(true);
  expect(result!.autoReplyMaxPerConversation).toBe(3);
});

test("loadDecrypted swallows an embeddings-decrypt failure to null, without affecting apiKey", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });

  const configId = await asUser.mutation(api.aiConfig.upsert, {
    ...BASE_ARGS,
    apiKey: "sk-plaintext-chat-key",
    embeddingsApiKey: "sk-plaintext-embeddings-key",
  });

  // Simulate a corrupted/undecryptable embeddings ciphertext (e.g. a
  // rotated ENCRYPTION_KEY) by patching the row directly with garbage
  // that isn't valid GCM/CBC ciphertext at all.
  await t.run((ctx) =>
    ctx.db.patch(configId, { embeddingsApiKey: "not-a-real-ciphertext" }),
  );

  const result = await t.query(internal.aiConfig.loadDecrypted, {
    accountId,
  });
  expect(result!.embeddingsApiKey).toBeNull();
  // The chat key is untouched by the embeddings key's corruption.
  expect(result!.apiKey).toBe("sk-plaintext-chat-key");
});

// ============================================================
// cross-account denial
// ============================================================

test("cross-account denial: B's get never sees A's config, and B's upsert never touches A's row", async () => {
  const t = convexTest(schema, modules);
  const { asUser: asAlice, accountId: aliceAccountId } =
    await seedAccountMember(t, {
      name: "Alice",
      email: "alice@example.com",
      role: "admin",
    });
  const { asUser: asBob } = await seedAccountMember(t, {
    name: "Bob",
    email: "bob@example.com",
    role: "admin",
  });

  await asAlice.mutation(api.aiConfig.upsert, {
    ...BASE_ARGS,
    apiKey: "alice-key",
  });

  const bobsConfig = await asBob.query(api.aiConfig.get, {});
  expect(bobsConfig).toBeNull();

  await asBob.mutation(api.aiConfig.upsert, {
    ...BASE_ARGS,
    provider: "anthropic",
    apiKey: "bob-key",
  });

  // Alice's config is still hers, untouched by Bob's own upsert.
  const alicesConfig = await asAlice.query(api.aiConfig.get, {});
  expect(alicesConfig!.provider).toBe("openai");

  const aliceRows = await t.run((ctx) =>
    ctx.db
      .query("aiConfigs")
      .withIndex("by_account", (q) => q.eq("accountId", aliceAccountId))
      .collect(),
  );
  expect(aliceRows).toHaveLength(1);
  expect(aliceRows[0]!.provider).toBe("openai");
});

// ============================================================
// testConnection — admin-gated "Test key" action (transitive-Supabase
// gap-fill task). Convex port of `POST /api/ai/test`: validates a
// provider/model/key combo WITHOUT saving it, falling back to the
// account's own saved (decrypted) key when `apiKey` is omitted.
// ============================================================

function okChatCompletion(content: string): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content } }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    }),
    { status: 200 },
  );
}

function errChatCompletion(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: { message } }), { status });
}

test("testConnection returns {ok:true} when the provider accepts a body-supplied key", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => okChatCompletion("OK")));
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });

  const result = await asUser.action(api.aiConfig.testConnection, {
    provider: "openai",
    model: "gpt-4o-mini",
    apiKey: "sk-fresh-key",
  });

  expect(result).toEqual({ ok: true });
  vi.unstubAllGlobals();
});

test("testConnection falls back to the account's saved (decrypted) key when apiKey is omitted", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => okChatCompletion("OK")));
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });
  await asUser.mutation(api.aiConfig.upsert, {
    ...BASE_ARGS,
    apiKey: "sk-saved-key",
  });

  const result = await asUser.action(api.aiConfig.testConnection, {
    provider: "openai",
    model: "gpt-4o-mini",
  });

  expect(result).toEqual({ ok: true });
  vi.unstubAllGlobals();
});

test("testConnection returns an error (never throws) when no apiKey is supplied and none is saved", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });

  const result = await asUser.action(api.aiConfig.testConnection, {
    provider: "openai",
    model: "gpt-4o-mini",
  });

  expect(result).toEqual({ error: "Enter an API key to test." });
});

test("testConnection returns {error, code} on a bad key (provider 401), without throwing", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => errChatCompletion(401, "Incorrect API key provided")),
  );
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });

  const result = await asUser.action(api.aiConfig.testConnection, {
    provider: "openai",
    model: "gpt-4o-mini",
    apiKey: "sk-bad-key",
  });

  expect(result).toMatchObject({ code: "invalid_key" });
  expect((result as { error: string }).error).toContain("Incorrect API key provided");
  vi.unstubAllGlobals();
});

test("testConnection throws FORBIDDEN for a caller below the admin role", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });

  await expect(
    asUser.action(api.aiConfig.testConnection, {
      provider: "openai",
      model: "gpt-4o-mini",
      apiKey: "sk-whatever",
    }),
  ).rejects.toMatchObject({ data: { code: "FORBIDDEN", min: "admin" } });
});

test("testConnection throws UNAUTHENTICATED when there is no identity", async () => {
  const t = convexTest(schema, modules);

  await expect(
    t.action(api.aiConfig.testConnection, {
      provider: "openai",
      model: "gpt-4o-mini",
      apiKey: "sk-whatever",
    }),
  ).rejects.toMatchObject({ data: { code: "UNAUTHENTICATED" } });
});

test("cross-account isolation: testConnection never falls back to a different account's saved key", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => okChatCompletion("OK")));
  const t = convexTest(schema, modules);
  const { asUser: asAlice } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });
  await asAlice.mutation(api.aiConfig.upsert, {
    ...BASE_ARGS,
    apiKey: "alice-saved-key",
  });
  const { asUser: asBob } = await seedAccountMember(t, {
    name: "Bob",
    email: "bob@example.com",
    role: "admin",
  });

  // Bob has no config of his own — must get "Enter an API key", never
  // silently succeed by falling back to Alice's saved key.
  const result = await asBob.action(api.aiConfig.testConnection, {
    provider: "openai",
    model: "gpt-4o-mini",
  });

  expect(result).toEqual({ error: "Enter an API key to test." });
  vi.unstubAllGlobals();
});
