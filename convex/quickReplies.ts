import { accountMutation, accountQuery } from "./lib/auth";
import { v, ConvexError } from "convex/values";
import type { Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";

// ============================================================
// Quick replies (Phase 4, Task 1) — reusable inbox-composer snippets,
// either plain text or a saved interactive (buttons/list) payload (see
// schema.ts's `quickReplies`). Mirrors `src/app/api/quick-replies/
// route.ts`'s GET/POST. Every function is built on
// `accountQuery`/`accountMutation` (never the raw `query`/`mutation`),
// the same isolation model `contacts.ts`/`tags.ts` use.
// `interactivePayload` is accepted as `v.optional(v.any())` here — deep
// structural validation (`validateInteractivePayload` in
// `src/lib/whatsapp/interactive.ts`) is deferred to whatever call site
// eventually sends it to Meta, not this DB layer.
// ============================================================

/**
 * Loads a quick reply and throws `NOT_FOUND` unless it belongs to the
 * caller's own account — same error for "doesn't exist" and "exists
 * but isn't yours" on purpose (mirrors `contacts.ts`'s
 * `requireOwnContact`), so a cross-account probe can't distinguish the
 * two.
 */
async function requireOwnQuickReply(
  ctx: { db: QueryCtx["db"]; accountId: Id<"accounts"> },
  quickReplyId: Id<"quickReplies">,
) {
  const quickReply = await ctx.db.get(quickReplyId);
  if (!quickReply || quickReply.accountId !== ctx.accountId) {
    throw new ConvexError({ code: "NOT_FOUND", entity: "quickReply" });
  }
  return quickReply;
}

export const list = accountQuery({
  args: {},
  handler: async (ctx) => {
    return await ctx.db
      .query("quickReplies")
      .withIndex("by_account", (q) => q.eq("accountId", ctx.accountId))
      .order("desc")
      .collect();
  },
});

export const create = accountMutation({
  args: {
    title: v.string(),
    kind: v.union(v.literal("text"), v.literal("interactive")),
    contentText: v.optional(v.string()),
    interactivePayload: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    ctx.requireRole("supervisor");
    return await ctx.db.insert("quickReplies", {
      accountId: ctx.accountId,
      createdByUserId: ctx.userId,
      title: args.title,
      kind: args.kind,
      contentText: args.contentText,
      interactivePayload: args.interactivePayload,
      updatedAt: Date.now(),
    });
  },
});

/**
 * Patches only the fields the caller supplies — same "patch only
 * what's provided" idiom as `contacts.update`/`deals.update` (an
 * omitted `v.optional(...)` arg carries no key at all through the
 * `...rest` spread, so `ctx.db.patch` leaves that column untouched).
 */
export const update = accountMutation({
  args: {
    quickReplyId: v.id("quickReplies"),
    title: v.optional(v.string()),
    kind: v.optional(v.union(v.literal("text"), v.literal("interactive"))),
    contentText: v.optional(v.string()),
    interactivePayload: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    ctx.requireRole("supervisor");
    const { quickReplyId, ...rest } = args;
    await requireOwnQuickReply(ctx, quickReplyId);

    await ctx.db.patch(quickReplyId, { ...rest, updatedAt: Date.now() });
    return quickReplyId;
  },
});

export const remove = accountMutation({
  args: { quickReplyId: v.id("quickReplies") },
  handler: async (ctx, args) => {
    ctx.requireRole("supervisor");
    await requireOwnQuickReply(ctx, args.quickReplyId);
    await ctx.db.delete(args.quickReplyId);
  },
});
