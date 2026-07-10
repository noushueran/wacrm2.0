// ============================================================
// GET /api/v1/me — public API identity probe.
//
// The reference endpoint for the public API: it requires nothing
// but a valid key (no scope), and returns the account the key is
// bound to plus the scopes it carries. Integrators use it to verify
// their key works and to discover what it's allowed to do before
// wiring up real calls.
//
// It also exercises the entire public-API stack end to end — bearer
// parse → hash lookup (via Convex) → liveness → rate limit → envelope
// — so a green response here means the plumbing every future endpoint
// depends on is sound.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { getConvexClient, api } from '@/lib/convex/server-client';
import { ok, toApiErrorResponse } from '@/lib/api/v1/respond';

export async function GET(request: Request) {
  try {
    const ctx = await requireApiKey(request);
    const me = await getConvexClient().query(api.apiV1.getMe, {
      keyHash: ctx.keyHash,
    });
    return ok({
      account: { id: me.accountId, name: me.accountName },
      key: { id: me.keyId, scopes: me.scopes },
    });
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
