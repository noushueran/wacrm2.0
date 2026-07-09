import { accountMutation, accountQuery } from "./lib/auth";
import { internalQuery } from "./_generated/server";
import { v, ConvexError } from "convex/values";
import { generateApiKey } from "./lib/apiKey";

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
 * Server-only lookup by hash — the Convex counterpart to
 * `src/lib/api-keys/store.ts`'s `findActiveKeyByHash`. An `internalQuery`
 * (never exposed to any client): a future public-API HTTP handler
 * hashes the caller-supplied key (`convex/lib/apiKey.ts`'s `hashApiKey`)
 * and calls this via `ctx.runQuery(internal.apiKeys.lookupByHash, {
 * keyHash })` to resolve which account — and which scopes — the key
 * authenticates. Returns `null` (never throws) for "no such key", a
 * revoked key, or an expired key, so callers never have to re-check
 * liveness themselves — same contract as `findActiveKeyByHash`.
 */
export const lookupByHash = internalQuery({
  args: { keyHash: v.string() },
  handler: async (ctx, args) => {
    const key = await ctx.db
      .query("apiKeys")
      .withIndex("by_key_hash", (q) => q.eq("keyHash", args.keyHash))
      .first();
    if (!key) return null;

    // Liveness checks mirror `findActiveKeyByHash`'s own comment: kept
    // as explicit JS checks rather than folded into the index query, so
    // the failure modes stay obvious and the index itself stays a
    // simple equality lookup.
    if (key.revokedAt !== undefined) return null;
    if (key.expiresAt !== undefined && key.expiresAt <= Date.now()) {
      return null;
    }

    return { accountId: key.accountId, scopes: key.scopes };
  },
});
