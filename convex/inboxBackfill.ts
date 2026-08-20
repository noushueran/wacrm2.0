import { v } from "convex/values";
import { internalMutation } from "./_generated/server";

// ============================================================
// One-shot backfill for `conversations.awaitingReply` (spec
// 2026-07-27-inbox-lanes §Rollout step 3). Must reach `patched: 0`
// BEFORE the lane tabs ship: `undefined` is not a lane, and an
// un-backfilled row would be silently swallowed by whichever range it
// happens to sort into.
//
// Internal and paginated. Re-runnable and idempotent — a row already
// holding the right value is skipped, so `patched: 0` on a second pass
// is the signal that the backfill is complete.
//
// DELETE THIS MODULE once the backfill has run in production.
// ============================================================

const DEFAULT_BATCH = 200;

export const backfillAwaitingReply = internalMutation({
  args: {
    cursor: v.optional(v.union(v.string(), v.null())),
    batchSize: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const page = await ctx.db.query("conversations").paginate({
      cursor: args.cursor ?? null,
      numItems: args.batchSize ?? DEFAULT_BATCH,
    });

    let patched = 0;
    for (const conversation of page.page) {
      // Newest message wins. `by_conversation` binds its only field, so
      // the remaining sort key is the implicit `_creationTime` — the
      // same reasoning `messages.listByConversation` documents.
      const newest = await ctx.db
        .query("messages")
        .withIndex("by_conversation", (q) =>
          q.eq("conversationId", conversation._id),
        )
        .order("desc")
        .first();
      // No messages: an agent created this thread to write into, so we
      // owe it the first message — Active, not Waiting. Matches the
      // schema comment on `awaitingReply`.
      const awaitingReply = newest ? newest.senderType === "customer" : true;
      if (conversation.awaitingReply === awaitingReply) continue;
      await ctx.db.patch(conversation._id, { awaitingReply });
      patched++;
    }

    return { cursor: page.continueCursor, isDone: page.isDone, patched };
  },
});
