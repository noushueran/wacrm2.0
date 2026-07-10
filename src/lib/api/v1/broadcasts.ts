// ============================================================
// Public API (v1) serializer for broadcasts.
//
// Data ops (recipient resolution, persistence, immediate delivery
// trigger) now live in Convex (`convex/apiV1.ts`'s `createBroadcast`/
// `getBroadcast`, the counterpart to the old Postgres-backed
// `src/lib/whatsapp/broadcast-core.ts`, removed by this migration).
// This module is down to projecting a Convex `broadcasts` doc into the
// same public shape `GET /api/v1/broadcasts/{id}` has always returned.
// ============================================================

export interface ApiBroadcast {
  id: string;
  name: string;
  template_name: string;
  template_language: string;
  status: string;
  total_recipients: number;
  sent_count: number;
  delivered_count: number;
  read_count: number;
  replied_count: number;
  failed_count: number;
  created_at: string;
  updated_at: string;
}

/** The shape `convex/apiV1.ts`'s `getBroadcast` returns: a bare
 *  `broadcasts` doc. */
export interface ConvexApiBroadcast {
  _id: string;
  _creationTime: number;
  name: string;
  templateName: string;
  templateLanguage: string;
  status: string;
  totalRecipients: number;
  sentCount: number;
  deliveredCount: number;
  readCount: number;
  repliedCount: number;
  failedCount: number;
  updatedAt?: number;
}

/** Project a Convex broadcast doc into the public shape. */
export function serializeBroadcast(doc: ConvexApiBroadcast): ApiBroadcast {
  const createdAt = new Date(doc._creationTime).toISOString();
  return {
    id: doc._id,
    name: doc.name,
    template_name: doc.templateName,
    template_language: doc.templateLanguage,
    status: doc.status,
    total_recipients: doc.totalRecipients,
    sent_count: doc.sentCount,
    delivered_count: doc.deliveredCount,
    read_count: doc.readCount,
    replied_count: doc.repliedCount,
    failed_count: doc.failedCount,
    created_at: createdAt,
    updated_at: doc.updatedAt ? new Date(doc.updatedAt).toISOString() : createdAt,
  };
}
