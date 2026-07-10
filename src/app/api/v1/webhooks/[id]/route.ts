// ============================================================
// GET    /api/v1/webhooks/{id} — read an endpoint   (webhooks:manage)
// PATCH  /api/v1/webhooks/{id} — update url/events/is_active
// DELETE /api/v1/webhooks/{id} — remove an endpoint
//
// All account-scoped: a foreign id → 404 (never 403). The signing
// secret is never returned here — it's shown once at creation only.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { getConvexClient, api } from '@/lib/convex/server-client';
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import { serializeWebhookEndpoint } from '@/lib/webhooks/endpoints';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireApiKey(request, 'webhooks:manage');
    const { id } = await params;

    const endpoint = await getConvexClient().query(api.apiV1.getWebhook, {
      keyHash: ctx.keyHash,
      endpointId: id,
    });
    if (!endpoint) return fail('not_found', 'Webhook not found', 404);

    return ok(serializeWebhookEndpoint(endpoint));
  } catch (err) {
    return toApiErrorResponse(err);
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireApiKey(request, 'webhooks:manage');
    const { id } = await params;

    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body || typeof body !== 'object') {
      return fail('bad_request', 'Request body must be a JSON object', 400);
    }

    const args: {
      keyHash: string;
      endpointId: string;
      url?: string;
      events?: string[];
      isActive?: boolean;
    } = { keyHash: ctx.keyHash, endpointId: id };

    if ('url' in body) {
      if (typeof body.url !== 'string') {
        return fail('bad_request', "'url' must be a valid https:// URL", 400);
      }
      args.url = body.url;
    }

    if ('events' in body) {
      if (
        !Array.isArray(body.events) ||
        body.events.length === 0 ||
        body.events.some((e) => typeof e !== 'string')
      ) {
        return fail(
          'bad_request',
          "'events' must be a non-empty array of known event names",
          400
        );
      }
      args.events = body.events as string[];
    }

    if ('is_active' in body) {
      if (typeof body.is_active !== 'boolean') {
        return fail('bad_request', "'is_active' must be a boolean", 400);
      }
      args.isActive = body.is_active;
    }

    if (args.url === undefined && args.events === undefined && args.isActive === undefined) {
      return fail('bad_request', 'No updatable fields provided', 400);
    }

    const endpoint = await getConvexClient().mutation(api.apiV1.updateWebhook, args);
    if (!endpoint) return fail('not_found', 'Webhook not found', 404);

    return ok(serializeWebhookEndpoint(endpoint));
  } catch (err) {
    return toApiErrorResponse(err);
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireApiKey(request, 'webhooks:manage');
    const { id } = await params;

    const result = await getConvexClient().mutation(api.apiV1.deleteWebhook, {
      keyHash: ctx.keyHash,
      endpointId: id,
    });
    if (!result) return fail('not_found', 'Webhook not found', 404);

    return ok({ id: result.id, deleted: true });
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
