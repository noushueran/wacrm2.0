import { internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { normalizePhone } from "./lib/phone";
import {
  insertMessageAndUpdateConversation,
  type AppendMessageArgs,
} from "./messages";
import type { Doc, Id } from "./_generated/dataModel";

// ============================================================
// Inbound ingestion (Phase 6, Task 2) — the one door every inbound
// WhatsApp message passes through before the automations/flows engines
// (Tasks 3/4) fan out from it. Called by the Next.js webhook route
// AFTER Meta's `x-hub-signature-256` has already been verified there
// (mirrors `src/app/api/whatsapp/webhook/route.ts`'s own
// `processMessage`, minus everything Tasks 3/4 own — see below); this
// module trusts its caller completely, the same way `metaSend.ts`'s
// actions trust the engine that invokes them.
//
// `internalMutation`, not `accountMutation`: there is no user session on
// an inbound webhook delivery, so `accountId` is an explicit,
// caller-supplied argument (resolved by the webhook route from the
// matched `whatsappConfig` row by `phone_number_id`) instead of
// `ctx.accountId` — every lookup below is scoped to THAT account, never
// a session-derived one.
//
// Deliberately narrow: contact find-or-create, conversation
// find-or-create, message insert + conversation denorm, and
// first-inbound-message detection — full stop. No automations/flows/AI
// auto-reply dispatch, no reaction handling, no broadcast-reply
// flagging, no Meta media download — Tasks 3/4 read THIS mutation's
// return value (`isFirstInboundMessage` in particular) to decide what
// to do next; that fan-out is their concern, not this one's.
// ============================================================

export const ingestInbound = internalMutation({
  args: {
    accountId: v.id("accounts"),
    from: v.string(),
    name: v.optional(v.string()),
    // Flattened inbound-message shape, modeled after what
    // `processMessage`'s `parseMessageContent` resolves a raw WhatsApp
    // webhook payload down to (`contentText`/`mediaUrl`/
    // `interactiveReplyId`) rather than the nested Meta JSON itself —
    // the caller (webhook route) does that flattening, same as it
    // already does today. `mediaId` (Meta's raw, unresolved media-object
    // id) is accepted for shape-fidelity with `processMessage`'s inbound
    // payload, but NOT resolved here: turning it into a fetchable
    // `mediaUrl` needs a signed Meta Graph API call with the account's
    // access token — real network I/O a plain `internalMutation` can't
    // do (no `fetch` inside a mutation). A caller that only has
    // `mediaId` and needs `mediaUrl` persisted must resolve it first
    // (e.g. via an action, the same `getMediaUrl` Meta call
    // `processMessage` itself makes) and pass the result as `mediaUrl`.
    message: v.object({
      type: v.union(
        v.literal("text"),
        v.literal("image"),
        v.literal("document"),
        v.literal("audio"),
        v.literal("video"),
        v.literal("location"),
        v.literal("interactive"),
      ),
      text: v.optional(v.string()),
      mediaId: v.optional(v.string()),
      mediaUrl: v.optional(v.string()),
      wamid: v.string(),
      interactiveReplyId: v.optional(v.string()),
    }),
  },
  handler: async (ctx, args) => {
    const { accountId, from, name, message } = args;
    const phoneNormalized = normalizePhone(from);

    // ---- (1) find-or-create the contact, scoped to `accountId` ----
    // Same `by_account_phone` dedupe lookup `contacts.create` uses;
    // reimplemented directly against `ctx.db` (not by calling
    // `contacts.create`) since that mutation is an `accountMutation`
    // gated on a user session/role this inbound path doesn't have.
    const existingContact = await ctx.db
      .query("contacts")
      .withIndex("by_account_phone", (q) =>
        q.eq("accountId", accountId).eq("phoneNormalized", phoneNormalized),
      )
      .first();

    let contactId: Id<"contacts">;
    const wasCreated = existingContact === null;
    if (existingContact) {
      contactId = existingContact._id;
    } else {
      // `name` is only ever set on CREATE — an existing contact's name
      // (possibly hand-edited by an agent since) is never overwritten by
      // a later inbound message's WhatsApp profile name.
      contactId = await ctx.db.insert("contacts", {
        accountId,
        phone: from,
        phoneNormalized,
        name,
      });
    }

    // ---- (2) find-or-create the conversation, scoped to `accountId` ----
    // `by_contact` isn't itself account-scoped (see schema.ts), so the
    // match is additionally filtered to `accountId` — the same
    // defense-in-depth `conversations.findOrCreateForContact` already
    // applies for this exact lookup.
    let conversation: Doc<"conversations"> | null = await ctx.db
      .query("conversations")
      .withIndex("by_contact", (q) => q.eq("contactId", contactId))
      .filter((q) => q.eq(q.field("accountId"), accountId))
      .first();

    let conversationId: Id<"conversations">;
    if (conversation) {
      conversationId = conversation._id;
    } else {
      conversationId = await ctx.db.insert("conversations", {
        accountId,
        contactId,
        status: "open",
        unreadCount: 0,
      });
      // Re-read so `insertMessageAndUpdateConversation` below gets a
      // real `Doc` (it reads `.unreadCount` off it) — `ctx.db.get`
      // immediately after `ctx.db.insert` in the same transaction is
      // always non-null.
      conversation = await ctx.db.get(conversationId);
    }
    if (!conversation) {
      throw new Error(
        "ingestInbound: conversation missing immediately after upsert",
      );
    }

    // ---- (3) first-inbound-message detection — BEFORE inserting ----
    // "First inbound" = no prior CUSTOMER-authored message already
    // exists in this conversation. Checked directly against `messages`
    // rather than inferred from `conversation` having just been created:
    // an agent could in principle open a conversation (or send an
    // outbound template) before the customer ever replies, so
    // "conversation is new" and "no customer message yet" aren't
    // actually the same condition.
    const priorCustomerMessage = await ctx.db
      .query("messages")
      .withIndex("by_conversation", (q) =>
        q.eq("conversationId", conversationId),
      )
      .filter((q) => q.eq(q.field("senderType"), "customer"))
      .first();
    const isFirstInboundMessage = priorCustomerMessage === null;

    // ---- (4) insert the inbound message + conversation denorm ----
    // Reuses `messages.ts`'s shared insert-and-denormalize core as a
    // plain function call (not `ctx.runMutation(internal.messages.
    // appendInternal, ...)`) so contact-create + conversation-create +
    // message-insert + denorm all commit as ONE transaction — see that
    // module's own doc comment on `appendInternal`, which foreshadows
    // exactly this caller.
    const appendArgs: AppendMessageArgs = {
      accountId,
      conversationId,
      senderType: "customer",
      contentType: message.type,
      contentText: message.text,
      mediaUrl: message.mediaUrl,
      messageId: message.wamid,
      interactiveReplyId: message.interactiveReplyId,
    };
    const messageId = await insertMessageAndUpdateConversation(
      ctx,
      appendArgs,
      conversation,
    );

    return {
      contactId,
      conversationId,
      messageId,
      wasCreated,
      isFirstInboundMessage,
    };
  },
});
