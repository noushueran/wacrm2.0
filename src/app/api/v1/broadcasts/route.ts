// ============================================================
// POST /api/v1/broadcasts — launch a template broadcast
// (scope: broadcasts:send).
//
// Body:
//   {
//     "name": "July promo",                 // optional label
//     "template_name": "promo_july",        // required, approved template
//     "template_language": "en_US",         // optional (default en_US)
//     "recipients": [                        // required, 1..1000
//       { "to": "+14155550123", "params": ["Jane"] },
//       { "to": "+14155550124" }
//     ]
//   }
//
// The broadcast + its recipient rows are persisted synchronously (each
// recipient resolved-or-created by phone), then delivery is triggered
// immediately via Convex's own scheduler (`convex/apiV1.ts`'s
// `createBroadcast`, reusing `broadcasts.deliverOne`'s existing
// fan-out) — independent of this request's lifetime, unlike the old
// Postgres-backed `after()` callback. Poll `GET /api/v1/broadcasts/{id}`
// for progress.
//
// KNOWN GAP: per-recipient template params are only honored when every
// recipient that specifies any agrees on the same array — the existing
// Convex delivery engine has no per-recipient personalization slot yet
// (see `convex/apiV1.ts`'s own comment). Previously each recipient's
// own `params` was always sent to Meta individually.
//
// Response (202):
//   { "data": { "broadcast_id", "status": "sending",
//               "total_recipients", "accepted", "rejected" } }
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { getConvexClient, api } from '@/lib/convex/server-client';
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';

// The recipient-resolution loop below (find-or-create a contact per
// recipient, up to 1 000) runs synchronously inside the awaited Convex
// action — same bound the old Postgres-backed route documented for its
// own (also-synchronous) contact-resolution phase; only the actual
// Meta sends were ever deferred, and still are (now via Convex's
// scheduler instead of `after()`).
export const maxDuration = 60;

interface RawRecipient {
  to?: unknown;
  params?: unknown;
}

export async function POST(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'broadcasts:send');

    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body || typeof body !== 'object') {
      return fail('bad_request', 'Request body must be a JSON object', 400);
    }

    const templateName =
      typeof body.template_name === 'string' ? body.template_name : '';
    const recipients = (
      Array.isArray(body.recipients) ? body.recipients : []
    ) as RawRecipient[];

    const result = await getConvexClient().action(api.apiV1.createBroadcast, {
      keyHash: ctx.keyHash,
      name: typeof body.name === 'string' ? body.name : undefined,
      templateName,
      templateLanguage:
        typeof body.template_language === 'string'
          ? body.template_language
          : undefined,
      recipients: recipients.map((r) => ({
        to: typeof r.to === 'string' ? r.to : '',
        params: Array.isArray(r.params)
          ? r.params.filter((p): p is string => typeof p === 'string')
          : undefined,
      })),
    });

    return ok(
      {
        broadcast_id: result.broadcastId,
        status: 'sending',
        total_recipients: result.totalRecipients,
        accepted: result.totalRecipients,
        rejected: result.rejected,
      },
      202
    );
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
