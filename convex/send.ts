import { action } from "./_generated/server";
import { internal } from "./_generated/api";
import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError, v } from "convex/values";
import { canAccessConversation, hasMinRole } from "./lib/roles";
import type { Id } from "./_generated/dataModel";

// ============================================================
// `send` — the authed, PUBLIC entrypoint the Inbox + contact-detail
// "send message" UI will call (Phase 8, Task 4; the UI rewire itself is
// a later task). Wraps the already-tested `convex/metaSend.ts` internal
// actions (Meta POST + persist) with the four things a plain `action`
// — unlike `accountQuery`/`accountMutation` — doesn't get for free:
//
//   1. deriving the caller's account + role from their session
//      (`getAuthUserId` + `internal.accounts.accountContextForUser`,
//      since an action has no `ctx.db` to run `lib/auth.ts`'s own
//      membership lookup inline);
//   2. resolving WHICH conversation to send into — an explicit
//      `conversationId`, or a `contactId` that find-or-creates one
//      (`internal.conversations.findOrCreateForContactInternal`);
//   3. enforcing that the caller has "own" access to that resolved
//      conversation (`canAccessConversation`, `convex/lib/roles.ts` —
//      RBAC final review, C1): supervisor+ may send into any
//      conversation; an agent only into one actually assigned to
//      them, never an unclaimed pool conversation or a colleague's —
//      then resolving the Meta recipient phone + optional reply
//      context (`internal.conversations.resolveSendTarget`);
//   4. picking which `metaSend` action matches `messageType` and
//      shaping its args.
//
// Deliberately does NOT reimplement any Meta wire logic or persistence
// — see `metaSend.ts`'s own header comment for what "load config,
// decrypt, send, persist" already means there; this module only routes
// to it via `ctx.runAction`.
// ============================================================

export const send = action({
  args: {
    conversationId: v.optional(v.id("conversations")),
    contactId: v.optional(v.id("contacts")),
    messageType: v.union(
      v.literal("text"),
      v.literal("image"),
      v.literal("document"),
      v.literal("audio"),
      v.literal("video"),
      v.literal("template"),
      v.literal("interactive"),
    ),
    contentText: v.optional(v.string()),
    mediaUrl: v.optional(v.string()),
    filename: v.optional(v.string()),
    templateName: v.optional(v.string()),
    templateLanguage: v.optional(v.string()),
    templateParams: v.optional(v.any()),
    interactivePayload: v.optional(v.any()),
    replyToMessageId: v.optional(v.id("messages")),
  },
  handler: async (ctx, args): Promise<{ whatsappMessageId: string }> => {
    // ---- (1) authenticate + derive account/role — never trust a
    // client-supplied accountId (there is none in this args validator).
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new ConvexError({ code: "UNAUTHENTICATED" });

    const context = await ctx.runQuery(
      internal.accounts.accountContextForUser,
      { userId },
    );
    if (!context) throw new ConvexError({ code: "NO_ACCOUNT" });
    if (!hasMinRole(context.role, "agent")) {
      throw new ConvexError({ code: "FORBIDDEN", min: "agent" });
    }
    const { accountId } = context;

    // ---- (2) resolve the target conversation ----
    let conversationId: Id<"conversations">;
    if (args.conversationId) {
      conversationId = args.conversationId;
    } else if (args.contactId) {
      // `role` gates the CREATE branch inside this mutation (a
      // brand-new conversation is always unassigned, so a sub-
      // supervisor caller who has no existing conversation for this
      // contact is denied here, BEFORE any row is inserted — see that
      // function's own doc comment for why this can't just be left to
      // the "own" check below).
      conversationId = await ctx.runMutation(
        internal.conversations.findOrCreateForContactInternal,
        { accountId, contactId: args.contactId, role: context.role },
      );
    } else {
      throw new Error("send requires a conversationId or a contactId");
    }

    // ---- (2b) per-conversation "own" access check (RBAC final
    // review, C1) — an agent may only send into a conversation
    // actually assigned to them; supervisor+ passes unconditionally.
    // Same NOT_FOUND shape `requireConversationAccess` uses elsewhere
    // (`convex/lib/conversationAccess.ts`) so a denied agent can't
    // distinguish "not yours" from "doesn't exist". Runs AFTER
    // conversation resolution so it uniformly covers BOTH the
    // caller-supplied `conversationId` path and the just-resolved
    // `contactId` path — the latter's "must create" half is already
    // denied above (without creating anything); this is what also
    // catches an agent's `contactId` routing to an EXISTING
    // conversation that's a colleague's, not theirs.
    const conversation = await ctx.runQuery(
      internal.conversations.getForAccountInternal,
      { accountId, conversationId },
    );
    const allowedToSend = canAccessConversation(
      context.role,
      {
        isMine: conversation.assignedToUserId === userId,
        isUnassigned: conversation.assignedToUserId === undefined,
      },
      "own",
    );
    if (!allowedToSend) {
      throw new ConvexError({ code: "NOT_FOUND", entity: "conversation" });
    }

    // Ownership-checks `conversationId` again (covers the caller-supplied
    // branch above; the find-or-create branch is already
    // account-scoped, so this is a defense-in-depth re-check, not
    // load-bearing there) and resolves the Meta recipient phone +
    // optional reply context every dispatch below needs.
    const { to, contextMessageId } = await ctx.runQuery(
      internal.conversations.resolveSendTarget,
      {
        accountId,
        conversationId,
        replyToMessageId: args.replyToMessageId,
      },
    );

    // ---- (3) dispatch to the matching internal metaSend action ----
    switch (args.messageType) {
      case "image":
      case "video":
      case "document":
      case "audio": {
        if (!args.mediaUrl) {
          throw new Error(`mediaUrl is required for ${args.messageType} messages`);
        }
        return await ctx.runAction(internal.metaSend.sendMedia, {
          accountId,
          conversationId,
          to,
          kind: args.messageType,
          link: args.mediaUrl,
          caption: args.contentText,
          filename: args.filename,
          contextMessageId,
          // Dashboard sends are agent-initiated, not automation/flow bot
          // sends — see `metaSend.ts`'s own doc comment on the default.
          senderType: "agent",
          replyToMessageId: args.replyToMessageId,
        });
      }
      case "template": {
        if (!args.templateName) {
          throw new Error("templateName is required for template messages");
        }
        return await ctx.runAction(internal.metaSend.sendTemplate, {
          accountId,
          conversationId,
          to,
          templateName: args.templateName,
          language: args.templateLanguage,
          params: args.templateParams,
          // Client-side rendered body (`message-thread.tsx` substitutes the
          // params into the template text) — persisted for the chat bubble
          // and conversation-list preview; Meta still receives the
          // structured name+params payload, not this string.
          contentText: args.contentText,
          contextMessageId,
          // Dashboard sends are agent-initiated, not automation/flow bot
          // sends — see `metaSend.ts`'s own doc comment on the default.
          senderType: "agent",
          replyToMessageId: args.replyToMessageId,
        });
      }
      case "interactive": {
        if (!args.interactivePayload) {
          throw new Error(
            "interactivePayload is required for interactive messages",
          );
        }
        return await ctx.runAction(internal.metaSend.sendInteractive, {
          accountId,
          conversationId,
          to,
          payload: args.interactivePayload,
          contextMessageId,
          // Dashboard sends are agent-initiated, not automation/flow bot
          // sends — see `metaSend.ts`'s own doc comment on the default.
          senderType: "agent",
          replyToMessageId: args.replyToMessageId,
        });
      }
      case "text": {
        if (!args.contentText) {
          throw new Error("contentText is required for text messages");
        }
        return await ctx.runAction(internal.metaSend.sendText, {
          accountId,
          conversationId,
          to,
          text: args.contentText,
          contextMessageId,
          // Dashboard sends are agent-initiated, not automation/flow bot
          // sends — see `metaSend.ts`'s own doc comment on the default.
          senderType: "agent",
          replyToMessageId: args.replyToMessageId,
        });
      }
    }
  },
});
