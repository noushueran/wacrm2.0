import { ConvexError } from "convex/values";
import type { QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { canAccessConversation, type AccountRole } from "./roles";

/**
 * Loads a conversation and throws `NOT_FOUND` unless the caller's role
 * may reach it in `mode` (see `canAccessConversation`). Same error for
 * "doesn't exist", "another account's", and "out of your scope" — a
 * probe can't distinguish them (mirrors `contacts.ts`'s
 * `requireOwnContact`). Shared by `conversations.ts` and `messages.ts`.
 */
export async function requireConversationAccess(
  ctx: {
    db: QueryCtx["db"];
    accountId: Id<"accounts">;
    role: AccountRole;
    userId: Id<"users">;
  },
  conversationId: Id<"conversations">,
  mode: "view" | "own",
): Promise<Doc<"conversations">> {
  const conversation = await ctx.db.get(conversationId);
  if (!conversation || conversation.accountId !== ctx.accountId) {
    throw new ConvexError({ code: "NOT_FOUND", entity: "conversation" });
  }
  const allowed = canAccessConversation(
    ctx.role,
    {
      isMine: conversation.assignedToUserId === ctx.userId,
      isUnassigned: conversation.assignedToUserId === undefined,
    },
    mode,
  );
  if (!allowed) {
    throw new ConvexError({ code: "NOT_FOUND", entity: "conversation" });
  }
  return conversation;
}
