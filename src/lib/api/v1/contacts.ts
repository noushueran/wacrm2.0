// ============================================================
// Shared contact logic for the public API (v1) contact endpoints.
//
// Data ops (find-or-create by phone, tag sync, ownership checks) now
// live in Convex (`convex/apiV1.ts`'s `listContacts`/`getContact`/
// `createContact`/`updateContact`/`deleteContact`) — this module is
// down to the ONE thing the Next layer still owns: projecting a Convex
// contact doc into the stable public wire shape. `ApiContact`'s output
// fields are UNCHANGED from the pre-migration Postgres-backed version;
// only `serializeContact`'s INPUT shape changed (Convex doc, camelCase
// + `_id`/`_creationTime`, instead of a Postgres row).
// ============================================================

export interface ApiContact {
  id: string;
  phone: string;
  name: string | null;
  email: string | null;
  company: string | null;
  avatar_url: string | null;
  tags: { id: string; name: string; color: string }[];
  created_at: string;
  updated_at: string;
}

/** Thrown by the helpers below; routes map `.status`/`.message`. */
export class ContactError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ContactError';
    this.status = status;
  }
}

/** The shape `convex/apiV1.ts`'s contact ops return: a `contacts` doc
 *  with its `tags` (a `tags` doc array) embedded. */
export interface ConvexApiContact {
  _id: string;
  _creationTime: number;
  phone: string;
  name?: string;
  email?: string;
  company?: string;
  avatarUrl?: string;
  tags: { _id: string; name: string; color: string }[];
}

/** Project a Convex contact doc (+ embedded tags) into the public
 *  contact shape. Convex's `contacts` table has no `updatedAt` column
 *  yet (see `src/lib/convex/adapters.ts`'s `toUiContact` for the same
 *  gap on the dashboard side) — backfilled from `_creationTime`, same
 *  convention that adapter already established. */
export function serializeContact(doc: ConvexApiContact): ApiContact {
  const createdAt = new Date(doc._creationTime).toISOString();
  return {
    id: doc._id,
    phone: doc.phone,
    name: doc.name ?? null,
    email: doc.email ?? null,
    company: doc.company ?? null,
    avatar_url: doc.avatarUrl ?? null,
    tags: doc.tags.map((t) => ({ id: t._id, name: t.name, color: t.color })),
    created_at: createdAt,
    updated_at: createdAt,
  };
}
