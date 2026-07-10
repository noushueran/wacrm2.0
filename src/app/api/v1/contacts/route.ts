// ============================================================
// GET  /api/v1/contacts  — list contacts (scope: contacts:read)
// POST /api/v1/contacts  — create a contact  (scope: contacts:write)
//
// List is paginated (see src/lib/api/v1/pagination.ts) and supports
// `?search=` (name/phone) and `?tag=<tagId>` filters. Create is
// find-or-create by phone: an existing match returns 200 with
// `created: false`; a new row returns 201 with `created: true`.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { getConvexClient, api } from '@/lib/convex/server-client';
import { ok, okList, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import { parseListParams } from '@/lib/api/v1/pagination';
import { serializeContact } from '@/lib/api/v1/contacts';

export async function GET(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'contacts:read');
    const { limit, cursor } = parseListParams(request);
    const url = new URL(request.url);
    const search = url.searchParams.get('search') ?? undefined;
    const tag = url.searchParams.get('tag') ?? undefined;

    const result = await getConvexClient().query(api.apiV1.listContacts, {
      keyHash: ctx.keyHash,
      limit,
      cursor,
      search,
      tag,
    });

    return okList(result.items.map(serializeContact), result.nextCursor);
  } catch (err) {
    return toApiErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'contacts:write');

    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body || typeof body !== 'object') {
      return fail('bad_request', 'Request body must be a JSON object', 400);
    }

    const phone = typeof body.phone === 'string' ? body.phone.trim() : '';
    if (!phone) {
      return fail('bad_request', "'phone' is required", 400);
    }

    const result = await getConvexClient().mutation(api.apiV1.createContact, {
      keyHash: ctx.keyHash,
      phone,
      name: typeof body.name === 'string' ? body.name : undefined,
      email: typeof body.email === 'string' ? body.email : undefined,
      company: typeof body.company === 'string' ? body.company : undefined,
      tags: Array.isArray(body.tags)
        ? body.tags.filter((t): t is string => typeof t === 'string')
        : undefined,
    });

    return ok(serializeContact(result.contact), result.created ? 201 : 200);
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
