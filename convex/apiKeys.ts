import { accountMutation, accountQuery } from "./lib/auth";
import { internalQuery, query, mutation } from "./_generated/server";
import { v, ConvexError } from "convex/values";
import { generateApiKey } from "./lib/apiKey";
import type { Doc } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";

// ============================================================
// API keys — machine credentials for the public REST API (`/api/v1/*`,
// `convex/schema.ts`'s `apiKeys`). Convex counterpart to migration
// 026_api_keys.sql: `create`/`list`/`revoke` are the dashboard-facing
// management side (mirrors `invitations.ts`'s create/list/revoke almost
// exactly — same one-time-reveal-then-hash-only contract);
// `lookupByHash` is the server-only auth-path lookup a future public-API
// HTTP handler calls via `ctx.runQuery(internal.apiKeys.lookupByHash,
// ...)`. It is deliberately an `internalQuery`, not `accountQuery`: a
// public-API caller authenticates with the key itself, not a Convex Auth
// session, so there is no `ctx.accountId` to derive in the first place —
// the hash IS the credential that establishes which account the caller
// belongs to, the same role `src/lib/api-keys/store.ts`'s
// `findActiveKeyByHash` plays on the Supabase side (there, via the
// RLS-bypassing service-role client; here, via an `internalQuery` that
// the client SDK can never call directly).
// ============================================================

// Hard ceiling on caller-supplied expiry, mirroring
// `src/app/api/account/api-keys/route.ts`'s own `MAX_EXPIRY_DAYS`.
// Missing/invalid/absent = never expires.
const MAX_EXPIRY_DAYS = 365;

/**
 * Only produces a concrete `expiresAt` for a valid positive finite day
 * count (clamped to `MAX_EXPIRY_DAYS`); otherwise returns `undefined` —
 * "never expires". Mirrors `src/app/api/account/api-keys/route.ts`'s
 * POST handler, which silently ignores a missing/invalid
 * `expiresInDays` rather than substituting some default expiry (unlike
 * `invitations.create`, which DOES default to a 7-day expiry — API keys
 * and invite links have deliberately different default-lifetime
 * semantics: an invite link is meant to be used promptly, a key is
 * meant to run unattended automations indefinitely unless told
 * otherwise).
 */
function computeExpiresAt(
  expiresInDays: number | undefined,
): number | undefined {
  if (
    expiresInDays === undefined ||
    !Number.isFinite(expiresInDays) ||
    expiresInDays <= 0
  ) {
    return undefined;
  }
  const days = Math.min(Math.floor(expiresInDays), MAX_EXPIRY_DAYS);
  return Date.now() + days * 24 * 60 * 60 * 1000;
}

/**
 * Admin+ mints a new API key for the caller's own account. Generates the
 * plaintext + its hash + a display prefix (`convex/lib/apiKey.ts`),
 * persists only the hash, and returns the plaintext exactly once — the
 * same one-time-reveal contract as `invitations.create`'s invite token.
 * If the admin loses it, they must `revoke` and re-issue rather than
 * ever retrieve it again (`list` never returns `keyHash`).
 */
export const create = accountMutation({
  args: {
    name: v.string(),
    scopes: v.array(v.string()),
    expiresInDays: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    ctx.requireRole("admin");

    const { plaintext, hash, prefix } = await generateApiKey();
    const expiresAt = computeExpiresAt(args.expiresInDays);

    const apiKeyId = await ctx.db.insert("apiKeys", {
      accountId: ctx.accountId,
      createdByUserId: ctx.userId,
      name: args.name,
      keyPrefix: prefix,
      keyHash: hash,
      scopes: args.scopes,
      expiresAt,
    });

    return { apiKeyId, plaintext, keyPrefix: prefix, expiresAt };
  },
});

/**
 * Any member lists the caller's own account's API keys, newest-first.
 * The roster (name/prefix/scopes/liveness) is not secret — only the key
 * itself is, and it was never stored — so this is open to viewer+,
 * mirroring migration 026's own `api_keys_select` RLS policy. `keyHash`
 * is explicitly never selected below (explicit field selection, not a
 * destructure-and-omit — mirrors `invitations.list`'s own convention,
 * chosen there specifically to dodge an eslint `no-unused-vars`
 * warning on the omitted field).
 */
export const list = accountQuery({
  args: {},
  handler: async (ctx) => {
    const keys = await ctx.db
      .query("apiKeys")
      .withIndex("by_account", (q) => q.eq("accountId", ctx.accountId))
      .order("desc")
      .collect();

    return keys.map((key) => ({
      _id: key._id,
      _creationTime: key._creationTime,
      accountId: key.accountId,
      createdByUserId: key.createdByUserId,
      name: key.name,
      keyPrefix: key.keyPrefix,
      scopes: key.scopes,
      lastUsedAt: key.lastUsedAt,
      expiresAt: key.expiresAt,
      revokedAt: key.revokedAt,
      // `keyHash` deliberately omitted — see this function's doc comment.
    }));
  },
});

/** Admin+ revokes one of the caller's own account's API keys. */
export const revoke = accountMutation({
  args: { apiKeyId: v.id("apiKeys") },
  handler: async (ctx, args) => {
    ctx.requireRole("admin");

    const key = await ctx.db.get(args.apiKeyId);
    if (!key || key.accountId !== ctx.accountId) {
      throw new ConvexError({ code: "NOT_FOUND", entity: "apiKey" });
    }

    await ctx.db.patch(args.apiKeyId, { revokedAt: Date.now() });
  },
});

/**
 * Shared "is this key hash still live" lookup — the one place that
 * decides what "active" means (unrevoked, unexpired), reused by
 * `lookupByHash` (below), the public `resolveByHash` (below), and
 * `convex/apiV1.ts`'s per-op scope check. Returns the FULL key doc (not
 * just `{accountId, scopes}`) so callers that need more (e.g.
 * `apiV1.getMe`'s `key._id`, `apiV1.createWebhook`'s
 * `key.createdByUserId`) don't need a second lookup — `lookupByHash`/
 * `resolveByHash` simply narrow it down to the public `{accountId,
 * scopes}` contract before returning. Returns `null` (never throws) for
 * "no such key", a revoked key, or an expired key, so every caller gets
 * one uniform "not usable" signal instead of re-deriving liveness itself
 * — same contract `src/lib/api-keys/store.ts`'s `findActiveKeyByHash`
 * establishes on the Supabase side.
 *
 * Typed to accept any ctx with a `db` (only `db.get`/`db.query` are
 * used), so it works unmodified from a `query`, `mutation`, or
 * `internalQuery` handler alike (see `contacts.ts`'s `requireOwnContact`
 * for the same typing convention).
 */
export async function loadActiveApiKey(
  ctx: { db: QueryCtx["db"] },
  keyHash: string,
): Promise<Doc<"apiKeys"> | null> {
  const key = await ctx.db
    .query("apiKeys")
    .withIndex("by_key_hash", (q) => q.eq("keyHash", keyHash))
    .first();
  if (!key) return null;

  // Liveness checks mirror `findActiveKeyByHash`'s own comment: kept as
  // explicit JS checks rather than folded into the index query, so the
  // failure modes stay obvious and the index itself stays a simple
  // equality lookup.
  if (key.revokedAt !== undefined) return null;
  if (key.expiresAt !== undefined && key.expiresAt <= Date.now()) {
    return null;
  }

  return key;
}

/**
 * Server-only lookup by hash — the Convex counterpart to
 * `src/lib/api-keys/store.ts`'s `findActiveKeyByHash`. An `internalQuery`
 * (never exposed to any client): called via
 * `ctx.runQuery(internal.apiKeys.lookupByHash, { keyHash })` from an
 * `action`/`httpAction` context (which has no `ctx.db` of its own) —
 * `convex/apiV1.ts`'s action-shaped ops (`sendMessage`, `createBroadcast`)
 * are exactly that. Query/mutation-shaped `apiV1.ts` ops call
 * `loadActiveApiKey` directly instead (they already have a `ctx.db`, so
 * the extra `runQuery` hop buys nothing) — see that module's own comment.
 */
export const lookupByHash = internalQuery({
  args: { keyHash: v.string() },
  handler: async (ctx, args) => {
    const key = await loadActiveApiKey(ctx, args.keyHash);
    if (!key) return null;
    return { accountId: key.accountId, scopes: key.scopes };
  },
});

/**
 * PUBLIC by-secret resolver — the Convex counterpart to
 * `src/lib/api-keys/store.ts`'s `findActiveKeyByHash`, callable directly
 * from `src/lib/auth/api-context.ts`'s `requireApiKey` via
 * `ConvexHttpClient` (a Next.js server route has no Convex Auth session
 * to authenticate a `query` call — the key HASH is the credential that
 * establishes the account, exactly like `invitations.ts`'s `peek` is
 * public because the invite TOKEN hash is its own credential). Safe to
 * expose with NO auth check for the same reason `peek` is: the caller
 * already possesses the one secret (the plaintext key, hashed
 * client-side before this call) that makes the lookup meaningful — an
 * attacker without a valid key learns nothing more than "no such key"
 * from a wrong guess, exactly like a probing `peek` call. Returns
 * `{accountId, scopes}` for an active key, `null` for anything else
 * (unknown/revoked/expired) — deliberately nothing more (no `name`, no
 * `keyPrefix`, no `_id`): every other `apiV1.*` op re-derives whatever
 * else it needs from its OWN `loadActiveApiKey` call rather than
 * threading extra fields through this shared resolver.
 */
export const resolveByHash = query({
  args: { keyHash: v.string() },
  handler: async (ctx, args) => {
    const key = await loadActiveApiKey(ctx, args.keyHash);
    if (!key) return null;
    return { accountId: key.accountId, scopes: key.scopes };
  },
});

/**
 * Best-effort `lastUsedAt` bump by hash — the Convex counterpart to
 * `src/lib/api-keys/store.ts`'s `touchLastUsed`, called fire-and-forget
 * from `requireApiKey` on every authenticated request (never awaited,
 * never allowed to fail the caller's actual request). PUBLIC (not
 * internal) for the same reason `resolveByHash` is: `requireApiKey` runs
 * in a Next.js route with no Convex Auth session, only the key hash —
 * and, as with `resolveByHash`, presenting a valid hash IS the
 * credential. A miss (unknown/already-revoked hash) is silently a no-op,
 * not an error — a lagging `lastUsedAt` on a dead key is harmless.
 */
export const touchLastUsedByHash = mutation({
  args: { keyHash: v.string() },
  handler: async (ctx, args) => {
    const key = await ctx.db
      .query("apiKeys")
      .withIndex("by_key_hash", (q) => q.eq("keyHash", args.keyHash))
      .first();
    if (!key) return;
    await ctx.db.patch(key._id, { lastUsedAt: Date.now() });
  },
});
