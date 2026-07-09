import { accountMutation, accountQuery } from "./lib/auth";
import { v, ConvexError } from "convex/values";
import type { Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";

// ============================================================
// Webhook endpoints — admin-managed HTTPS targets wacrm POSTs account
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
 * value wacrm itself needs back at delivery time, so it really is
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
