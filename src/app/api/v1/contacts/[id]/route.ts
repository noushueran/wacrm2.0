// ============================================================
// GET    /api/v1/contacts/{id} — read a contact  (scope: contacts:read)
// PATCH  /api/v1/contacts/{id} — update a contact (scope: contacts:write)
// DELETE /api/v1/contacts/{id} — remove a contact (scope: contacts:write)
//
// All account-scoped: a contact belonging to another account returns
// 404 (never 403 — don't reveal it exists elsewhere). PATCH updates
// only the fields present in the body; pass `tags` (an array of tag
// names) to replace the contact's tags. DELETE is new in this Convex
// migration — not previously documented in docs/public-api.md — added
// alongside the other CRUD ops (see the Phase 8 Task 5 report).
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { getConvexClient, api } from '@/lib/convex/server-client';
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import { serializeContact } from '@/lib/api/v1/contacts';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireApiKey(request, 'contacts:read');
    const { id } = await params;
    const contact = await getConvexClient().query(api.apiV1.getContact, {
      keyHash: ctx.keyHash,
      contactId: id,
    });
    if (!contact) return fail('not_found', 'Contact not found', 404);
    return ok(serializeContact(contact));
  } catch (err) {
    return toApiErrorResponse(err);
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireApiKey(request, 'contacts:write');
    const { id } = await params;

    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body || typeof body !== 'object') {
      return fail('bad_request', 'Request body must be a JSON object', 400);
    }

    // Only forward a field when the caller's JSON body actually
    // contains the key — Convex's `updateContact` distinguishes
    // "omitted" (untouched) from `null` (clear) from a string (set),
    // so what's built here must mirror that exactly.
    const args: {
      keyHash: string;
      contactId: string;
      name?: string | null;
      email?: string | null;
      company?: string | null;
      tags?: string[];
    } = { keyHash: ctx.keyHash, contactId: id };

    for (const field of ['name', 'email', 'company'] as const) {
      if (!(field in body)) continue;
      const value = body[field];
      if (value === null || typeof value === 'string') {
        args[field] = value;
      } else {
        return fail('bad_request', `'${field}' must be a string or null`, 400);
      }
    }

    if ('tags' in body) {
      if (!Array.isArray(body.tags)) {
        return fail('bad_request', "'tags' must be an array of strings", 400);
      }
      args.tags = body.tags.filter((t): t is string => typeof t === 'string');
    }

    const contact = await getConvexClient().mutation(api.apiV1.updateContact, args);
    if (!contact) return fail('not_found', 'Contact not found', 404);
    return ok(serializeContact(contact));
  } catch (err) {
    return toApiErrorResponse(err);
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireApiKey(request, 'contacts:write');
    const { id } = await params;

    const result = await getConvexClient().mutation(api.apiV1.deleteContact, {
      keyHash: ctx.keyHash,
      contactId: id,
    });
    if (!result) return fail('not_found', 'Contact not found', 404);
    return ok({ id: result.id, deleted: true });
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
