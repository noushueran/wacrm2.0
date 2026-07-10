// ============================================================
// GET  /api/v1/webhooks — list webhook endpoints (scope: webhooks:manage)
// POST /api/v1/webhooks — register an endpoint    (scope: webhooks:manage)
//
// POST returns the signing `secret` in plaintext exactly once — store
// it to verify the `X-Wacrm-Signature` on deliveries. wacrm keeps only
// an encrypted copy (generated + encrypted inside Convex — see
// `convex/apiV1.ts`'s `createWebhook`) and can never show it again.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { getConvexClient, api } from '@/lib/convex/server-client';
import { ok, okList, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import { serializeWebhookEndpoint } from '@/lib/webhooks/endpoints';

export async function GET(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'webhooks:manage');

    const endpoints = await getConvexClient().query(api.apiV1.listWebhooks, {
      keyHash: ctx.keyHash,
    });

    // The roster is small and settings-class — return it whole (the
    // list envelope's cursor is always null here).
    return okList(endpoints.map(serializeWebhookEndpoint), null);
  } catch (err) {
    return toApiErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'webhooks:manage');

    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body || typeof body !== 'object') {
      return fail('bad_request', 'Request body must be a JSON object', 400);
    }

    if (typeof body.url !== 'string') {
      return fail('bad_request', "'url' must be a valid https:// URL", 400);
    }
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

    const created = await getConvexClient().mutation(api.apiV1.createWebhook, {
      keyHash: ctx.keyHash,
      url: body.url,
      events: body.events as string[],
    });

    // Secret shown exactly once.
    return ok({ ...serializeWebhookEndpoint(created), secret: created.secret }, 201);
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
