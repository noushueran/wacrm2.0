// ============================================================
// GET /api/v1/broadcasts/{id} — broadcast status + counts
// (scope: broadcasts:send).
//
// Poll this after POST /api/v1/broadcasts to watch the fan-out
// progress. `status` moves 'sending' → 'sent'; the delivered/read
// counts continue to climb as Meta delivery webhooks arrive.
// Account-scoped: a foreign id → 404.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { getConvexClient, api } from '@/lib/convex/server-client';
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import { serializeBroadcast } from '@/lib/api/v1/broadcasts';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireApiKey(request, 'broadcasts:send');
    const { id } = await params;

    const broadcast = await getConvexClient().query(api.apiV1.getBroadcast, {
      keyHash: ctx.keyHash,
      broadcastId: id,
    });
    if (!broadcast) return fail('not_found', 'Broadcast not found', 404);

    return ok(serializeBroadcast(broadcast));
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
