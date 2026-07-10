import { accountMutation, accountQuery } from "./lib/auth";
import { internalMutation, internalQuery } from "./_generated/server";
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
export interface AppendMessageArgs {
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
  // Inbound-only in practice (the customer's reply to a `interactive`
  // message we sent) — schema.ts's `interactiveReplyId` column existed
  // since Task 1 but neither `append` nor `appendInternal` ever
  // threaded it through until now (Phase 6, Task 2 needs it for
  // `ingest.ingestInbound`). Added here, not just on `ingestInbound`'s
  // own call site, so `append`/`appendInternal` stay identical in what
  // they can insert — see this file's own "so the two entry points
  // can't drift" comment on `insertMessageAndUpdateConversation`.
  interactiveReplyId?: string;
  aiGenerated?: boolean;
}

export async function insertMessageAndUpdateConversation(
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
    interactiveReplyId,
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
    interactiveReplyId,
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
    interactiveReplyId: v.optional(v.string()),
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
    interactiveReplyId: v.optional(v.string()),
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

/**
 * Server-only counterpart to a `requireOwnMessage`-style lookup, for
 * `reactions.reactToMeta` (Phase 8, Task 4) — a public `action` has no
 * `ctx.db` to check message ownership inline the way
 * `reactions.ts`'s own private `requireOwnMessage` does for its
 * `accountQuery`/`accountMutation` siblings, so `accountId` is an
 * explicit, caller-supplied argument instead (same treatment as
 * `whatsappConfig.getForAccount`, this codebase's established naming
 * for "the internal, caller-supplied-accountId counterpart of a public
 * `get`"). Returns the full `Doc<"messages">` — `reactToMeta` reads both
 * `conversationId` (to call `metaSend.sendReaction`) and `messageId`
 * (Meta's wamid, to know what to react to) off it.
 */
export const getForAccount = internalQuery({
  args: { accountId: v.id("accounts"), messageId: v.id("messages") },
  handler: async (ctx, args) => {
    const message = await ctx.db.get(args.messageId);
    if (!message || message.accountId !== args.accountId) {
      throw new ConvexError({ code: "NOT_FOUND", entity: "message" });
    }
    return message;
  },
});

/**
 * Meta delivery-status webhook handler (Phase 8, Task 4) — Convex port
 * of the `messages` mirror in `src/app/api/whatsapp/webhook/route.ts`'s
 * `handleStatusUpdate` (step 1, lines ~358-370). Meta's own status
 * values (`sent`/`delivered`/`read`/`failed`) already match this
 * table's `status` union 1:1 — no translation table needed, same as
 * the source's own comment on this ("Meta's status values already
 * match the CHECK constraint on messages.status").
 *
 * `wamid` (`messages.messageId`) is NOT unique — `by_message_id` has no
 * uniqueness guarantee (see `ingest.ts`'s own comment on this exact
 * index: Meta ids can repeat across different WhatsApp numbers /
 * accounts) — so this matches 0..N rows via `.collect()`, mirroring the
 * source's own "updates 0..N rows and must not assume a single row".
 * `accountId` is OPTIONAL and, when supplied, filters out any row that
 * doesn't belong to it — an IMPROVEMENT over the source (whose
 * `handleStatusUpdate` has no accountId in scope at all for this call,
 * see `processWebhook`) that keeps a same-string wamid collision across
 * two tenants from ever patching the wrong one's message once the
 * caller (the httpAction, resolved via `phone_number_id`) has an
 * accountId on hand. Omitted, it falls back to the source's own
 * account-agnostic sweep.
 */
export const updateDeliveryStatusByWamid = internalMutation({
  args: {
    wamid: v.string(),
    status: v.union(
      v.literal("sent"),
      v.literal("delivered"),
      v.literal("read"),
      v.literal("failed"),
    ),
    accountId: v.optional(v.id("accounts")),
  },
  handler: async (ctx, args) => {
    const matches = await ctx.db
      .query("messages")
      .withIndex("by_message_id", (q) => q.eq("messageId", args.wamid))
      .collect();

    let updated = 0;
    for (const message of matches) {
      if (args.accountId && message.accountId !== args.accountId) continue;
      await ctx.db.patch(message._id, { status: args.status });
      updated += 1;
    }
    return { matched: matches.length, updated };
  },
});
