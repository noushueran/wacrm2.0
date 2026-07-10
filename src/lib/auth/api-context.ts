// ============================================================
// Public API authentication — resolve a request's API key into an
// account context.
//
// This is the machine-to-machine counterpart of `getCurrentAccount`
// (cookie session → account). Where the dashboard authenticates a
// human via Supabase cookies, the public API authenticates a caller
// via `Authorization: Bearer wacrm_live_…`.
//
// Calling convention — every `/api/v1` route does:
//
//   try {
//     const ctx = await requireApiKey(request, "messages:send");
//     // ctx.accountId  — the key's account (informational only — every
//     //                  api.apiV1.* call below re-derives it from
//     //                  ctx.keyHash server-side, never trusts this)
//     // ctx.keyHash    — pass this to every api.apiV1.* call so Convex
//     //                  can re-resolve the account + re-check scope
//     // ctx.scopes     — granted scopes
//   } catch (err) {
//     return toApiErrorResponse(err);   // maps ApiError → envelope
//   }
//
// Backend: the account + scope lookup itself now lives in Convex
// (`api.apiKeys.resolveByHash`, a PUBLIC by-secret query — same safety
// pattern as `invitations.peek`: the key HASH is the credential, so no
// Convex Auth session is needed or possible here). This module calls it
// over HTTP via `ConvexHttpClient` (`src/lib/convex/server-client.ts`),
// the same way `findActiveKeyByHash` used to call Postgres directly.
// Every downstream `/api/v1/*` data call passes `ctx.keyHash` (NEVER
// `ctx.accountId`) to its `api.apiV1.*` function, which re-resolves the
// account and re-checks scope itself — defense-in-depth against a value
// that crossed a process boundary being trusted blindly.
// ============================================================

import { api, getConvexClient } from '@/lib/convex/server-client';
import { hashApiKey, looksLikeApiKey } from '@/lib/api-keys/keys';
import { hasScope, type ApiScope } from '@/lib/api-keys/scopes';
import { forbidden, rateLimited, unauthorized } from '@/lib/api/v1/respond';
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit';

export interface ApiKeyContext {
  /** Discriminant — lets shared logic tell key auth from cookie auth. */
  authType: 'api_key';
  /** The account this key belongs to. */
  accountId: string;
  /** SHA-256 hex digest of the presented key — pass to every
   *  `api.apiV1.*` call; Convex re-resolves the account from this,
   *  never from `accountId` above directly. */
  keyHash: string;
  /** Scopes granted to this key. */
  scopes: string[];
}

/**
 * Extract the bearer token from the `Authorization` header.
 * Tolerates the `Bearer ` prefix being absent (some clients send the
 * bare key) but requires the value to look like one of our keys.
 */
function extractKey(request: Request): string | null {
  const header = request.headers.get('authorization');
  if (!header) return null;
  const value = header.startsWith('Bearer ')
    ? header.slice('Bearer '.length).trim()
    : header.trim();
  return value.length > 0 ? value : null;
}

/**
 * Authenticate a public-API request and (optionally) enforce a
 * single scope. Throws an `ApiError` (mapped to the envelope by
 * `toApiErrorResponse`) on any failure:
 *
 *   401 unauthorized — no key, malformed, unknown, revoked, expired
 *   403 forbidden    — valid key without the required scope
 *   429 rate_limited — per-key budget exhausted
 *
 * On success, bumps `lastUsedAt` (fire-and-forget, via Convex) and
 * returns the account context.
 */
export async function requireApiKey(
  request: Request,
  scope?: ApiScope
): Promise<ApiKeyContext> {
  const presented = extractKey(request);
  if (!presented || !looksLikeApiKey(presented)) {
    throw unauthorized();
  }

  const keyHash = hashApiKey(presented);
  const resolved = await getConvexClient().query(api.apiKeys.resolveByHash, {
    keyHash,
  });
  if (!resolved) {
    // Covers unknown, revoked, and expired keys alike — we don't
    // distinguish them on the wire so a probe can't learn whether a
    // key ever existed.
    throw unauthorized();
  }

  // Rate-limit per key, before the scope check, so an unauthorized-
  // scope caller still can't hammer the endpoint for free. Bucketed by
  // the key's hash (a stable, unique-per-key value) rather than a
  // database row id — `resolveByHash` deliberately never returns one
  // (see that function's own doc comment on why).
  const limit = checkRateLimit(`apikey:${keyHash}`, RATE_LIMITS.publicApi);
  if (!limit.success) {
    throw rateLimited(limit);
  }

  if (scope && !hasScope(resolved.scopes, scope)) {
    throw forbidden(`This API key is missing the '${scope}' scope`);
  }

  // Best-effort `lastUsedAt` bump — never allowed to fail the caller's
  // actual request (mirrors the old `touchLastUsed`'s own fire-and-
  // forget contract).
  void getConvexClient()
    .mutation(api.apiKeys.touchLastUsedByHash, { keyHash })
    .catch((err: unknown) => {
      console.warn('[api-context] touchLastUsedByHash failed:', err);
    });

  return {
    authType: 'api_key',
    accountId: resolved.accountId,
    keyHash,
    scopes: resolved.scopes,
  };
}
