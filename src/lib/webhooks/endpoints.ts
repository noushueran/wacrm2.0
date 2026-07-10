// ============================================================
// Webhook endpoint serialization for the public management API.
//
// Secret generation + encryption now happen inside Convex
// (`convex/apiV1.ts`'s `createWebhook`, Web-Crypto based — see that
// function's own doc comment) rather than here with Node's
// `node:crypto`; URL/event-vocabulary validation likewise now lives
// there (`normalizeWebhookUrl`/`normalizeWebhookEvents`, duplicated
// Convex-side per `convex/lib/phone.ts`'s "can't cross-import src/"
// convention — see `convex/apiV1.ts`'s own comment). This module is
// down to the one thing the Next layer still owns: projecting a Convex
// `webhookEndpoints` doc into the public (secret-free) wire shape.
// ============================================================

export interface ApiWebhookEndpoint {
  id: string;
  url: string;
  events: string[];
  is_active: boolean;
  last_delivery_at: string | null;
  failure_count: number;
  created_at: string;
}

/** The shape `convex/apiV1.ts`'s webhook ops return: a bare
 *  `webhookEndpoints` doc (never including the plaintext secret — only
 *  `createWebhook`'s response splices that in separately, once). */
export interface ConvexApiWebhookEndpoint {
  _id: string;
  _creationTime: number;
  url: string;
  events: string[];
  isActive: boolean;
  lastDeliveryAt?: number;
  failureCount: number;
}

/** Project a Convex webhook endpoint doc into the public shape. */
export function serializeWebhookEndpoint(
  doc: ConvexApiWebhookEndpoint
): ApiWebhookEndpoint {
  return {
    id: doc._id,
    url: doc.url,
    events: doc.events,
    is_active: doc.isActive,
    last_delivery_at: doc.lastDeliveryAt
      ? new Date(doc.lastDeliveryAt).toISOString()
      : null,
    failure_count: doc.failureCount,
    created_at: new Date(doc._creationTime).toISOString(),
  };
}
