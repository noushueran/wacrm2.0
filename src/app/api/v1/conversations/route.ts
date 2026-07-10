// ============================================================
// GET /api/v1/conversations — list conversations (scope: conversations:read)
//
// Paginated, newest-first. Filters: `?status=` (open/pending/closed)
// and `?contact_id=`. Each conversation embeds its contact + tags.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { getConvexClient, api } from '@/lib/convex/server-client';
import { okList, toApiErrorResponse } from '@/lib/api/v1/respond';
import { parseListParams } from '@/lib/api/v1/pagination';
import { serializeConversation } from '@/lib/api/v1/conversations';

export async function GET(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'conversations:read');
    const { limit, cursor } = parseListParams(request);
    const url = new URL(request.url);
    const status = url.searchParams.get('status') ?? undefined;
    const contactId = url.searchParams.get('contact_id') ?? undefined;

    const result = await getConvexClient().query(api.apiV1.listConversations, {
      keyHash: ctx.keyHash,
      limit,
      cursor,
      status,
      contactId,
    });

    return okList(result.items.map(serializeConversation), result.nextCursor);
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
