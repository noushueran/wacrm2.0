// ============================================================
// Cursor pagination for public API (v1) list endpoints.
//
// Every `/api/v1` list route (contacts, conversations, messages)
// pages the same way so integrators write one loop:
//
//   GET /api/v1/contacts?limit=50
//   → { "data": [...], "meta": { "next_cursor": "…" } }
//   GET /api/v1/contacts?limit=50&cursor=…      // next page
//   → { "data": [...], "meta": { "next_cursor": null } }   // last page
//
// The cursor is an OPAQUE string — clients pass it back verbatim and
// never parse it. Before the Convex migration this was a bespoke
// base64-encoded `(created_at, id)` keyset cursor this module minted
// and validated itself (PostgREST doesn't page for you). Now that every
// list op's actual paging happens INSIDE `convex/apiV1.ts` (either
// Convex's own native `.paginate()` cursor for unfiltered scans, or a
// stringified offset for the filtered contacts/conversations lists —
// see that file's own pagination-helper comment), this module no
// longer mints or interprets the cursor at all: it just carries
// whatever opaque string `api.apiV1.*` returned as `nextCursor` back
// out to `?cursor=`, and passes whatever the client sent back in
// straight through as an arg. The wire contract (opaque string,
// `null` = last page) is unchanged.
// ============================================================

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 100;

export interface ListParams {
  /** Clamped to [1, MAX_LIMIT]. */
  limit: number;
  /** The raw cursor string from `?cursor=`, or null on the first page. */
  cursor: string | undefined;
}

/**
 * Parse `?limit` and `?cursor` off a request URL. `limit` is clamped
 * to [1, MAX_LIMIT] (default {@link DEFAULT_LIMIT}). `cursor` is
 * passed through untouched — an empty/absent value becomes `undefined`
 * so it can be spread straight into an `api.apiV1.*` args object
 * without ever sending a stray empty string.
 */
export function parseListParams(request: Request): ListParams {
  const url = new URL(request.url);

  const rawLimit = Number(url.searchParams.get('limit'));
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(Math.floor(rawLimit), MAX_LIMIT)
      : DEFAULT_LIMIT;

  const cursor = url.searchParams.get('cursor');
  return { limit, cursor: cursor && cursor.length > 0 ? cursor : undefined };
}
