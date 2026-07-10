import { internalAction, internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
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
//
// Idempotent against Meta webhook retries (Phase 6 review fix —
// stronger than the original Supabase app, which had no such guard):
// Meta redelivers a webhook whenever it doesn't get a fast-enough ack,
// with no dedupe guarantee of its own, so the SAME inbound message can
// reach this mutation more than once carrying the same `wamid`. The
// handler's first step checks for a prior message with that `wamid`
// (scoped to `accountId`) and, if found, short-circuits before any
// find-or-create/insert, returning the ALREADY-persisted row with
// `duplicate: true` instead of writing a second copy or double-bumping
// `unreadCount`. The Phase 8 webhook wiring reads `duplicate` to skip
// the automations/flows fan-out on a retry, the same way it already
// reads `isFirstInboundMessage` to decide whether to run it at all.
// ============================================================

// Flattened inbound-message shape, modeled after what `processMessage`'s
// `parseMessageContent` resolves a raw WhatsApp webhook payload down to
// (`contentText`/`mediaUrl`/`interactiveReplyId`) rather than the nested
// Meta JSON itself — the caller (webhook route) does that flattening,
// same as it already does today. `mediaId` (Meta's raw, unresolved
// media-object id) is accepted for shape-fidelity with `processMessage`'s
// inbound payload, but NOT resolved here: turning it into a fetchable
// `mediaUrl` needs a signed Meta Graph API call with the account's access
// token — real network I/O a plain `internalMutation` can't do (no
// `fetch` inside a mutation). A caller that only has `mediaId` and needs
// `mediaUrl` persisted must resolve it first (e.g. via an action, the
// same `getMediaUrl` Meta call `processMessage` itself makes) and pass
// the result as `mediaUrl`. Extracted to a module-level const (rather
// than declared inline in `ingestInbound`'s own args) so `processInbound`
// below can share the identical validator instead of a second,
// drift-prone copy.
const inboundMessageValidator = v.object({
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
});

export const ingestInbound = internalMutation({
  args: {
    accountId: v.id("accounts"),
    from: v.string(),
    name: v.optional(v.string()),
    message: inboundMessageValidator,
  },
  handler: async (ctx, args) => {
    const { accountId, from, name, message } = args;
    const phoneNormalized = normalizePhone(from);

    // ---- (0) wamid idempotency — BEFORE any find-or-create/insert,
    // guard against Meta webhook retries re-delivering the identical
    // message (Meta redelivers whenever it doesn't get a fast-enough
    // ack, and offers no dedupe guarantee of its own). `by_message_id`
    // indexes `messageId` alone (see schema.ts) — not compound with
    // `accountId` — the same query `flowsEngine.findMessageIdByWamid`
    // runs — so a hit is only trusted once confirmed to belong to THIS
    // account; a different account is a different WhatsApp Business
    // number drawing wamids from its own namespace, so a same-string
    // match across accounts is coincidental, not a real retry, and
    // must fall through to the normal insert path below. A genuine
    // retry can only ever hit a message an EARLIER run of this same
    // mutation already inserted, so the contact + conversation it
    // belongs to are guaranteed to already exist — short-circuiting
    // here, before step (1), skips those lookups entirely rather than
    // just skipping the final insert.
    const existingMessage = await ctx.db
      .query("messages")
      .withIndex("by_message_id", (q) => q.eq("messageId", message.wamid))
      .first();
    if (existingMessage && existingMessage.accountId === accountId) {
      const existingConversation = await ctx.db.get(
        existingMessage.conversationId,
      );
      if (!existingConversation) {
        throw new Error(
          "ingestInbound: conversation missing for existing message on wamid retry",
        );
      }
      return {
        contactId: existingConversation.contactId,
        conversationId: existingMessage.conversationId,
        messageId: existingMessage._id,
        wasCreated: false,
        isFirstInboundMessage: false,
        duplicate: true,
      };
    }

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
      duplicate: false,
    };
  },
});

// ============================================================
// Inbound-processing orchestrator (Phase 8, Task 4) — Convex port of
// `src/app/api/whatsapp/webhook/route.ts`'s `processMessage` fan-out
// (lines ~710-826, AFTER the message row itself is inserted, which
// `ingestInbound` above already owns): ingest, then Flows -> (if not
// consumed) Automations + AI reply -> webhook delivery, in that exact
// order. Called by the (not-yet-built) httpAction webhook entrypoint;
// this file has no knowledge of Meta's raw JSON or signature
// verification — same trust boundary `ingestInbound` already documents.
//
// Precedence ported EXACTLY from the source (confirmed against
// route.ts's actual line numbers, not just the plan doc's approximate
// range):
//   - route.ts:729-749  Flows dispatch runs FIRST and is AWAITED — the
//     `consumed` result gates what follows.
//   - route.ts:764-775  Content-level automation triggers
//     (`new_message_received`, `keyword_match`, and — only for an
//     interactive tap — `interactive_reply`) are pushed ONLY when
//     `!flowConsumed`. Relationship triggers are NOT gated on
//     `flowConsumed` at all:
//   - route.ts:782-783  `new_contact_created` (`wasCreated`) and
//     `first_inbound_message` (`isFirstInboundMessage`) are unshifted
//     unconditionally, wasCreated first then isFirstInboundMessage
//     (so when both are true, `first_inbound_message` ends up at index
//     0) — still fire even when a flow consumed the message, since
//     they're about WHO is messaging, not what they said.
//   - route.ts:784-797  Every trigger in the resulting set dispatches to
//     `runAutomationsForTrigger`. Fire-and-forget in the source
//     (`.catch()`, never awaited) — see `runBestEffort`'s own comment
//     below for why this port awaits each one instead.
//   - route.ts:799-811  AI auto-reply dispatches only when
//     `!flowConsumed && !interactiveReplyId && inboundText.trim()`.
//   - route.ts:813-826  The `message.received` webhook fan-out sits
//     OUTSIDE every one of the guards above — it is the last thing
//     `processMessage` does and always runs, whether or not a flow
//     consumed the message, whether or not any automation or AI reply
//     fired.
//
// NOT ported (a pre-existing, already-flagged gap, not an oversight of
// this task): the "stand down when an active new_message_received/
// keyword_match automation exists" check inside the SOURCE's
// `dispatchInboundToAiReply` (src/lib/ai/auto-reply.ts) that avoids
// double-texting the customer when both an automation and the AI would
// otherwise reply to the same inbound. `processMessage` itself has NO
// such check in its own body (it lives one layer deeper, inside the AI
// reply function) — and `convex/aiReply.ts`'s own header comment
// documents this exact check as a deliberate Phase 7 scope cut,
// explicitly deferring the decision of "when to call
// aiReply.dispatchInbound at all" to "a future integration task". This
// task's brief calls for exactly the dispatch shape used below (no
// extra gating query); closing that gap is flagged in this task's own
// report as a follow-up, not silently absorbed here.
// ============================================================

type FlowDispatchMessage =
  | { kind: "text"; text: string; metaMessageId: string }
  | {
      kind: "interactive_reply";
      replyId: string;
      replyTitle: string;
      metaMessageId: string;
    };

/**
 * route.ts:734-746 — builds the payload `dispatchInboundToFlows` gets,
 * from the SAME flattened `message` arg `ingestInbound` already
 * consumed (not a second, independently-parsed shape): an interactive
 * tap becomes `interactive_reply` (using the tapped option's id +
 * title), anything else becomes plain `text`. Exported so the mapping
 * itself is directly unit-testable, matching this codebase's
 * established convention for pure decision logic (`colsForStatus`,
 * `triggerMatches`, `matchesKeywordTrigger`, ...).
 */
export function buildFlowDispatchMessage(message: {
  text?: string;
  wamid: string;
  interactiveReplyId?: string;
}): FlowDispatchMessage {
  return message.interactiveReplyId
    ? {
        kind: "interactive_reply",
        replyId: message.interactiveReplyId,
        replyTitle: message.text ?? "",
        metaMessageId: message.wamid,
      }
    : {
        kind: "text",
        text: message.text ?? "",
        metaMessageId: message.wamid,
      };
}

/**
 * route.ts:756-783 — the exact trigger-set precedence described in this
 * file's header comment above, extracted to a pure function so every
 * combination (consumed/not, created/not, first/not, interactive/not)
 * is directly unit-testable without spinning up a full convex-test
 * action run.
 */
export function determineAutomationTriggers(input: {
  flowConsumed: boolean;
  wasCreated: boolean;
  isFirstInboundMessage: boolean;
  interactiveReplyId?: string;
}): string[] {
  const triggers: string[] = [];
  if (!input.flowConsumed) {
    triggers.push("new_message_received", "keyword_match");
    // route.ts:768-774 — only meaningful when a button/list reply
    // actually arrived; skipped (along with its siblings above) when a
    // Flow consumed the tap instead.
    if (input.interactiveReplyId) {
      triggers.push("interactive_reply");
    }
  }
  // route.ts:782-783 — unconditional on `flowConsumed`; `wasCreated`
  // unshifted before `isFirstInboundMessage`, exactly matching the
  // source's own order of these two lines.
  if (input.wasCreated) triggers.unshift("new_contact_created");
  if (input.isFirstInboundMessage) triggers.unshift("first_inbound_message");
  return triggers;
}

/**
 * route.ts:820-825 — the `message.received` public-webhook payload.
 * Deliberately snake_case (unlike `AutomationContext`'s camelCase):
 * this crosses the wire to external subscribers of the ALREADY
 * documented `message.received` event contract, not an internal
 * Convex-only shape. `text` defaults to `null` (never `undefined`) so
 * the field survives `JSON.stringify` for non-text content, matching
 * `contentText`'s own `string | null` shape in the source.
 */
export function buildMessageReceivedPayload(input: {
  conversationId: Id<"conversations">;
  contactId: Id<"contacts">;
  wamid: string;
  contentType: string;
  text?: string;
}): Record<string, unknown> {
  return {
    conversation_id: input.conversationId,
    contact_id: input.contactId,
    whatsapp_message_id: input.wamid,
    content_type: input.contentType,
    text: input.text ?? null,
  };
}

/**
 * Runs `fn` and swallows any rejection, logging instead of throwing.
 * Every fan-out step in `processInbound` below is wrapped in this: a
 * throw in one (flows, automations, AI reply, webhook delivery) must
 * never block the others or bubble into the caller, mirroring
 * `processMessage`'s own fire-and-forget contract in the source.
 *
 * Unlike the source's literal un-awaited `automations(...).catch(...)`
 * (safe there only because Vercel's `after()` keeps the route's
 * function alive for a detached promise), every call site below AWAITS
 * `runBestEffort` instead of firing it loose: a Convex action's
 * lifecycle ends the moment its handler's returned promise resolves, so
 * an un-awaited `ctx.runAction`/`ctx.runMutation` inside one is not
 * guaranteed to complete — see `aiReply.ts`'s own `aiUsage.log` call for
 * this exact same reasoning applied to a single Convex mutation. In
 * practice this rarely fires at all: `flowsEngine.dispatchInbound`,
 * `automationsEngine.runForTrigger`, `aiReply.dispatchInbound`, and
 * `webhookDelivery.dispatch` each already wrap their own body in a
 * top-level try/catch and are documented to never throw — this is
 * belt-and-braces for the one layer none of them own: `ctx.runAction`/
 * `ctx.runMutation` itself failing (a bad reference, an infra hiccup).
 * Exported so the isolation behavior itself is directly unit-testable
 * with a plain rejecting `fn`, independent of any Convex machinery.
 */
export async function runBestEffort(
  label: string,
  fn: () => Promise<unknown>,
): Promise<void> {
  try {
    await fn();
  } catch (err) {
    console.error(
      `[webhook] ${label} failed:`,
      err instanceof Error ? err.message : err,
    );
  }
}

export const processInbound = internalAction({
  args: {
    accountId: v.id("accounts"),
    from: v.string(),
    name: v.optional(v.string()),
    message: inboundMessageValidator,
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ duplicate: boolean; flowConsumed: boolean }> => {
    const { accountId, from, name, message } = args;

    const res = await ctx.runMutation(internal.ingest.ingestInbound, {
      accountId,
      from,
      name,
      message,
    });

    // route.ts's own comment on `duplicate` (see `ingestInbound` above):
    // a Meta retry re-delivering an already-persisted wamid — skip ALL
    // fan-out, not just the insert.
    if (res.duplicate) {
      return { duplicate: true, flowConsumed: false };
    }

    // ---- Flows FIRST (route.ts:729-749). Awaited: the `consumed`
    // result gates the content-level automation triggers + AI reply
    // below, so it must be known before either dispatches.
    let flowConsumed = false;
    await runBestEffort("flowsEngine.dispatchInbound", async () => {
      const flowResult = await ctx.runAction(
        internal.flowsEngine.dispatchInbound,
        {
          accountId,
          contactId: res.contactId,
          message: buildFlowDispatchMessage(message),
          isFirstInboundMessage: res.isFirstInboundMessage,
        },
      );
      flowConsumed = flowResult.consumed;
    });

    // ---- Automations (route.ts:756-797). Every trigger in the set
    // dispatches independently and best-effort — one failing (or
    // matching zero automations) must never affect the others.
    const automationTriggers = determineAutomationTriggers({
      flowConsumed,
      wasCreated: res.wasCreated,
      isFirstInboundMessage: res.isFirstInboundMessage,
      interactiveReplyId: message.interactiveReplyId,
    });
    const inboundText = message.text ?? "";
    await Promise.all(
      automationTriggers.map((triggerType) =>
        runBestEffort(`automationsEngine.runForTrigger(${triggerType})`, () =>
          ctx.runAction(internal.automationsEngine.runForTrigger, {
            accountId,
            triggerType,
            contactId: res.contactId,
            context: {
              messageText: inboundText,
              conversationId: res.conversationId,
              interactiveReplyId: message.interactiveReplyId ?? undefined,
            },
          }),
        ),
      ),
    );

    // ---- AI auto-reply (route.ts:799-811) — flows win over the LLM,
    // and an interactive tap never reaches the LLM either.
    if (!flowConsumed && !message.interactiveReplyId && inboundText.trim()) {
      await runBestEffort("aiReply.dispatchInbound", () =>
        ctx.runAction(internal.aiReply.dispatchInbound, {
          accountId,
          conversationId: res.conversationId,
          contactId: res.contactId,
        }),
      );
    }

    // ---- message.received webhook (route.ts:813-826) — OUTSIDE every
    // guard above; always fires, flow-consumed or not.
    await runBestEffort("webhookDelivery.dispatch", () =>
      ctx.runAction(internal.webhookDelivery.dispatch, {
        accountId,
        event: "message.received",
        payload: buildMessageReceivedPayload({
          conversationId: res.conversationId,
          contactId: res.contactId,
          wamid: message.wamid,
          contentType: message.type,
          text: message.text,
        }),
      }),
    );

    return { duplicate: false, flowConsumed };
  },
});
