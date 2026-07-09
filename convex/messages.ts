import { accountMutation, accountQuery } from "./lib/auth";
import { internalMutation } from "./_generated/server";
import { v, ConvexError } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";

// ============================================================
// Messages — the Inbox thread view (`listByConversation`) plus the
// two write paths every inbound/outbound/bot message goes through:
// `append` (user-facing, built on `accountMutation`) and
// `appendInternal` (server-only, built on the raw `internalMutation` —
// see its own doc comment for why). Every PUBLIC function here is
// built on `accountQuery`/`accountMutation` (never the raw
// `query`/`mutation`), mirroring `conversations.ts`/`contacts.ts`:
// `ctx.accountId` always comes from the caller's own `memberships`
// row, never a client-supplied argument (there is no `accountId`
// field in either public args validator below). A message can never
// be read or written without first proving its parent conversation
// belongs to the target account — see `requireOwnConversation`.
// ============================================================

/**
 * Loads a conversation and throws `NOT_FOUND` unless it belongs to
 * `accountId` — the same error for "doesn't exist" and "exists but
 * isn't yours" on purpose (mirrors `contacts.ts`'s `requireOwnContact`
 * and `conversations.ts`'s `get`), so a cross-account probe can't
 * distinguish the two. Shared by `listByConversation`, `append`, and
 * `appendInternal` below, since every message read/write starts by
 * proving ownership of its parent conversation.
 *
 * Takes `accountId` as an explicit parameter (not read off `ctx`) so
 * the SAME check serves both callers: `append` passes its
 * `accountMutation` ctx's own `ctx.accountId` (the caller's own
 * account, proven via their `memberships` row), while `appendInternal`
 * passes its caller-supplied `args.accountId` (there is no user
 * session — and therefore no `ctx.accountId` — inside an
 * `internalMutation`). Typed to accept any ctx with a `db` (only
 * `db.get` is used), same treatment as `contacts.ts`'s
 * `requireOwnContact`.
 */
async function requireOwnConversation(
  ctx: { db: QueryCtx["db"] },
  accountId: Id<"accounts">,
  conversationId: Id<"conversations">,
) {
  const conversation = await ctx.db.get(conversationId);
  if (!conversation || conversation.accountId !== accountId) {
    throw new ConvexError({ code: "NOT_FOUND", entity: "conversation" });
  }
  return conversation;
}

/**
 * Shared insert-then-denormalize core for both `append` and
 * `appendInternal` — see `append`'s own doc comment for what each
 * field/effect means; this is a straight extraction so the two entry
 * points can't drift.
 */
interface AppendMessageArgs {
  accountId: Id<"accounts">;
  conversationId: Id<"conversations">;
  senderType: "customer" | "agent" | "bot";
  contentType:
    | "text"
    | "image"
    | "document"
    | "audio"
    | "video"
    | "location"
    | "template"
    | "interactive";
  contentText?: string;
  mediaUrl?: string;
  templateName?: string;
  messageId?: string;
  interactivePayload?: unknown;
  aiGenerated?: boolean;
}

async function insertMessageAndUpdateConversation(
  ctx: { db: MutationCtx["db"] },
  args: AppendMessageArgs,
  conversation: Doc<"conversations">,
): Promise<Id<"messages">> {
  const {
    accountId,
    conversationId,
    senderType,
    contentType,
    contentText,
    mediaUrl,
    templateName,
    messageId,
    interactivePayload,
    aiGenerated,
  } = args;

  const newMessageId = await ctx.db.insert("messages", {
    accountId,
    conversationId,
    senderType,
    contentType,
    contentText,
    mediaUrl,
    templateName,
    messageId,
    interactivePayload,
    aiGenerated,
    status: "sent",
  });

  // Denormalized preview fields the Inbox list reads directly off
  // `conversations` (see `conversations.ts`'s `list`) so it never has
  // to join into `messages` just to render a snippet. `unreadCount`
  // only climbs for inbound (`"customer"`) messages — an agent/bot
  // message is one the account itself just sent, not one waiting to
  // be read.
  const patch: Partial<{
    lastMessageText: string;
    lastMessageAt: number;
    updatedAt: number;
    unreadCount: number;
  }> = {
    lastMessageText: contentText ?? `[${contentType}]`,
    lastMessageAt: Date.now(),
    updatedAt: Date.now(),
  };
  if (senderType === "customer") {
    patch.unreadCount = conversation.unreadCount + 1;
  }
  await ctx.db.patch(conversationId, patch);

  return newMessageId;
}

export const listByConversation = accountQuery({
  args: {
    conversationId: v.id("conversations"),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    await requireOwnConversation(ctx, ctx.accountId, args.conversationId);

    // `by_conversation` binds its only field via `.eq` below, so the
    // sole remaining sort key is the implicit `_creationTime` —
    // `.order("desc")` gives newest-first without needing a separate
    // timestamp field on `messages` (there isn't one; see schema.ts).
    return await ctx.db
      .query("messages")
      .withIndex("by_conversation", (q) =>
        q.eq("conversationId", args.conversationId),
      )
      .order("desc")
      .paginate(args.paginationOpts);
  },
});

export const append = accountMutation({
  args: {
    conversationId: v.id("conversations"),
    senderType: v.union(
      v.literal("customer"),
      v.literal("agent"),
      v.literal("bot"),
    ),
    contentType: v.union(
      v.literal("text"),
      v.literal("image"),
      v.literal("document"),
      v.literal("audio"),
      v.literal("video"),
      v.literal("location"),
      v.literal("template"),
      v.literal("interactive"),
    ),
    contentText: v.optional(v.string()),
    mediaUrl: v.optional(v.string()),
    templateName: v.optional(v.string()),
    messageId: v.optional(v.string()),
    interactivePayload: v.optional(v.any()),
    aiGenerated: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    ctx.requireRole("agent");
    const conversation = await requireOwnConversation(
      ctx,
      ctx.accountId,
      args.conversationId,
    );
    return await insertMessageAndUpdateConversation(
      ctx,
      { accountId: ctx.accountId, ...args },
      conversation,
    );
  },
});

/**
 * Server-only counterpart to `append`, for the automations/flows
 * engines (Phase 6, Tasks 3/4) and `convex/metaSend.ts`'s send actions
 * — none of which have a user session to derive `ctx.accountId` from
 * the way `accountMutation` does. Built on the raw `internalMutation`
 * (never exposed to any client) with `accountId` as an explicit,
 * caller-supplied argument instead: the engine already knows which
 * account it's running for (the trigger/webhook that started it came
 * in scoped to one `whatsappConfig`/account), so there's no session to
 * bypass — only the auth WRAPPER (`ctx.requireRole`, `getAuthUserId`)
 * is skipped, not the tenancy check itself: `requireOwnConversation`
 * still verifies `conversationId` belongs to the passed `accountId`
 * before writing anything, exactly like `append` does for its caller's
 * own account. `senderType` is expected to be `"bot"` for every real
 * caller (engine sends), but isn't hard-coded so future internal
 * callers (e.g. inbound ingestion persisting a `"customer"` message,
 * Phase 6 Task 2) can reuse this same effect rather than a third
 * copy-pasted insert-and-denormalize block.
 */
export const appendInternal = internalMutation({
  args: {
    accountId: v.id("accounts"),
    conversationId: v.id("conversations"),
    senderType: v.union(
      v.literal("customer"),
      v.literal("agent"),
      v.literal("bot"),
    ),
    contentType: v.union(
      v.literal("text"),
      v.literal("image"),
      v.literal("document"),
      v.literal("audio"),
      v.literal("video"),
      v.literal("location"),
      v.literal("template"),
      v.literal("interactive"),
    ),
    contentText: v.optional(v.string()),
    mediaUrl: v.optional(v.string()),
    templateName: v.optional(v.string()),
    messageId: v.optional(v.string()),
    interactivePayload: v.optional(v.any()),
    aiGenerated: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const conversation = await requireOwnConversation(
      ctx,
      args.accountId,
      args.conversationId,
    );
    return await insertMessageAndUpdateConversation(ctx, args, conversation);
  },
});
