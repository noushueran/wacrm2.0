// ============================================================
// GET /api/v1/conversations/{id}/messages — list a conversation's
// messages (scope: messages:read), newest first, paginated.
//
// The conversation is verified to belong to the key's account before
// any message is returned — a foreign or unknown id → 404.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { getConvexClient, api } from '@/lib/convex/server-client';
import { okList, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import { parseListParams } from '@/lib/api/v1/pagination';
import { serializeMessage } from '@/lib/api/v1/conversations';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireApiKey(request, 'messages:read');
    const { id } = await params;
    const { limit, cursor } = parseListParams(request);

    const result = await getConvexClient().query(api.apiV1.listMessages, {
      keyHash: ctx.keyHash,
      conversationId: id,
      limit,
      cursor,
    });
    if (!result) return fail('not_found', 'Conversation not found', 404);

    return okList(result.items.map(serializeMessage), result.nextCursor);
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
