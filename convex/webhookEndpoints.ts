import { accountMutation, accountQuery } from "./lib/auth";
import { internalMutation, internalQuery } from "./_generated/server";
import { v, ConvexError } from "convex/values";
import type { Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";

// ============================================================
// Webhook endpoints — admin-managed HTTPS targets Holidayys WA CRM POSTs account
// events to (`convex/schema.ts`'s `webhookEndpoints`, Convex
// counterpart to migration 028's `webhook_endpoints` table). This is
// the dashboard-facing management surface only (mirrors `apiKeys.ts`'s
// create/list/revoke almost exactly) — actually signing + delivering
// payloads is a later concern (`src/lib/webhooks/deliver.ts` /
// `sign.ts`), not this module's job. Every function is built on
// `accountQuery`/`accountMutation` (never the raw `query`/`mutation`),
// so `ctx.accountId` always comes from the caller's own `memberships`
// row, never a client-supplied argument.
// ============================================================

/**
 * Loads a webhook endpoint and throws `NOT_FOUND` unless it belongs to
 * the caller's own account — same error for "doesn't exist" and
 * "exists but isn't yours" on purpose (mirrors `contacts.ts`'s
 * `requireOwnContact`), so a cross-account probe can't distinguish the
 * two. Used by every write below.
 */
async function requireOwnWebhookEndpoint(
  ctx: { db: QueryCtx["db"]; accountId: Id<"accounts"> },
  endpointId: Id<"webhookEndpoints">,
) {
  const endpoint = await ctx.db.get(endpointId);
  if (!endpoint || endpoint.accountId !== ctx.accountId) {
    throw new ConvexError({ code: "NOT_FOUND", entity: "webhookEndpoint" });
  }
  return endpoint;
}

/**
 * Any member lists the caller's own account's webhook endpoints,
 * newest-first. `secret` is deliberately never included in the
 * result — the same "shown once, at creation only" contract
 * `src/lib/webhooks/endpoints.ts`'s `WEBHOOK_PUBLIC_COLUMNS` enforces
 * at the REST-API layer (unlike `apiKeys.keyHash`, this `secret` is a
 * value Holidayys WA CRM itself needs back at delivery time, so it really is
 * stored — which makes it more important, not less, to keep it out of
 * a roster a browser session can read). Explicit field selection, not
 * a destructure-and-omit, mirrors `apiKeys.list`'s own convention.
 */
export const list = accountQuery({
  args: {},
  handler: async (ctx) => {
    const endpoints = await ctx.db
      .query("webhookEndpoints")
      .withIndex("by_account", (q) => q.eq("accountId", ctx.accountId))
      .order("desc")
      .collect();

    return endpoints.map((endpoint) => ({
      _id: endpoint._id,
      _creationTime: endpoint._creationTime,
      accountId: endpoint.accountId,
      createdByUserId: endpoint.createdByUserId,
      url: endpoint.url,
      events: endpoint.events,
      isActive: endpoint.isActive,
      lastDeliveryAt: endpoint.lastDeliveryAt,
      failureCount: endpoint.failureCount,
      // `secret` deliberately omitted — see this function's doc comment.
    }));
  },
});

/**
 * Admin+ registers a new webhook endpoint for the caller's own
 * account. `secret` is supplied by the caller (a future HTTP layer
 * generates it via `src/lib/webhooks/endpoints.ts`'s
 * `generateWebhookSecret`, the same way it encrypts `accessToken`
 * before calling `whatsappConfig.upsert`) — this module only persists
 * it. New endpoints always start active with a clean failure streak.
 */
export const create = accountMutation({
  args: {
    url: v.string(),
    events: v.array(v.string()),
    secret: v.string(),
  },
  handler: async (ctx, args) => {
    ctx.requireRole("admin");

    return await ctx.db.insert("webhookEndpoints", {
      accountId: ctx.accountId,
      createdByUserId: ctx.userId,
      url: args.url,
      events: args.events,
      secret: args.secret,
      isActive: true,
      failureCount: 0,
    });
  },
});

/**
 * Admin+ patches url/events/secret/isActive on the caller's own
 * account's endpoint. Each field is patched only when the caller
 * actually supplies it — an omitted `v.optional(...)` arg carries no
 * key at all, so spreading `patch` over `ctx.db.patch` leaves that
 * column untouched (the same "patch only what's provided" idiom
 * `contacts.update`/`templates.upsert` already use).
 */
export const update = accountMutation({
  args: {
    endpointId: v.id("webhookEndpoints"),
    url: v.optional(v.string()),
    events: v.optional(v.array(v.string())),
    secret: v.optional(v.string()),
    isActive: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    ctx.requireRole("admin");
    const { endpointId, ...patch } = args;
    await requireOwnWebhookEndpoint(ctx, endpointId);

    await ctx.db.patch(endpointId, patch);
    return endpointId;
  },
});

/** Admin+ removes one of the caller's own account's webhook endpoints. */
export const remove = accountMutation({
  args: { endpointId: v.id("webhookEndpoints") },
  handler: async (ctx, args) => {
    ctx.requireRole("admin");
    await requireOwnWebhookEndpoint(ctx, args.endpointId);
    await ctx.db.delete(args.endpointId);
  },
});

// ============================================================
// Server-only counterparts (Phase 6, Task 2) for
// `convex/webhookDelivery.ts`'s `dispatch` action — none of which have
// a user session, so each takes its scoping id(s) as an explicit
// argument instead of deriving them from `ctx.accountId`/a membership
// row, mirroring `whatsappConfig.getForAccount`'s relationship to
// `whatsappConfig.get`.
// ============================================================

/**
 * Every ACTIVE endpoint of `accountId` subscribed to `event` — same
 * `by_account` scan `list` above uses, but (unlike `list`) INCLUDES
 * `secret` (the delivery action needs it to sign the payload) and is
 * pre-filtered to `isActive && events.includes(event)`. There is no
 * Convex index on the `events` array field (see schema.ts), so the
 * subscription check is a plain in-memory `.filter` over this account's
 * own rows — the same "collect, then filter in JS for an array-
 * membership check Convex can't express as an index lookup" treatment
 * `contacts.filterByTags` already uses.
 */
export const listActiveForEvent = internalQuery({
  args: { accountId: v.id("accounts"), event: v.string() },
  handler: async (ctx, args) => {
    const endpoints = await ctx.db
      .query("webhookEndpoints")
      .withIndex("by_account", (q) => q.eq("accountId", args.accountId))
      .collect();
    return endpoints.filter(
      (endpoint) => endpoint.isActive && endpoint.events.includes(args.event),
    );
  },
});

/**
 * Bumps `lastDeliveryAt` and clears the failure streak after a
 * successful delivery — the Convex counterpart to `deliver.ts`'s own
 * "Success: clear the failure streak" update.
 */
export const recordDeliverySuccess = internalMutation({
  args: { endpointId: v.id("webhookEndpoints") },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.endpointId, {
      failureCount: 0,
      lastDeliveryAt: Date.now(),
    });
  },
});

/**
 * Bumps `failureCount` by one and, once it reaches `maxFailures`,
 * auto-disables the endpoint (`isActive: false`) so a dead sink stops
 * being hit — the Convex counterpart to `deliver.ts`'s
 * `record_webhook_failure` SQL function (same "atomic increment +
 * auto-disable at threshold" semantics; `maxFailures` is passed in by
 * the caller, mirroring that function's own `max_failures` parameter,
 * rather than hard-coding `MAX_CONSECUTIVE_FAILURES` here — that
 * constant lives in `webhookDelivery.ts`, the direct Convex counterpart
 * of `deliver.ts` where the original constant lives). Unlike Postgres
 * (where a read-modify-write could lose a concurrent increment, hence
 * the original's atomic RPC), Convex mutations already serialize
 * conflicting writes to the same document via OCC — a plain
 * read-then-patch here can't lose an increment the way a naive
 * read-modify-write could under MVCC.
 */
export const recordDeliveryFailure = internalMutation({
  args: { endpointId: v.id("webhookEndpoints"), maxFailures: v.number() },
  handler: async (ctx, args) => {
    const endpoint = await ctx.db.get(args.endpointId);
    if (!endpoint) return;
    const failureCount = endpoint.failureCount + 1;
    await ctx.db.patch(args.endpointId, {
      failureCount,
      isActive: failureCount >= args.maxFailures ? false : endpoint.isActive,
    });
  },
});
