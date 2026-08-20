import { internalAction, internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { normalizePhone } from "./lib/phone";
import { AI_VISIBLE_MEDIA_TYPES } from "./lib/ai/context";
import { debounceMsForText } from "./lib/ai/pacing";
import { hasMinRole } from "./lib/roles";
import { insertNotification } from "./notifications";
import { allocateContactCode } from "./contacts";
import { insertConversation } from "./conversations";
import {
  insertMessageAndUpdateConversation,
  type AppendMessageArgs,
} from "./messages";
import { extractRefCode, extractCtwaClid } from "./lib/attribution";
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
//
// `ctwaClid` (Task B4/B2): Meta's ad-referral click id, threaded onto the
// flattened message by `webhookParse.ts`'s `flattenInboundMessage` when
// the inbound carries a `referral.ctwa_clid`. Declared here (not just on
// `processInbound`'s own args) so the SAME validator both functions
// share actually accepts it end-to-end from the httpAction — otherwise
// Convex would reject the field as unexpected before it ever reached
// `processInbound`'s attribution step below. `ingestInbound` itself
// still ignores it: the message row has no column for it, and only
// `processInbound`'s new attribution step (via `extractCtwaClid`)
// reads it.
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
  contextWamid: v.optional(v.string()),
  ctwaClid: v.optional(v.string()),
  referral: v.optional(
    v.object({
      sourceType: v.optional(v.union(v.literal("ad"), v.literal("post"))),
      sourceId: v.optional(v.string()),
      sourceUrl: v.optional(v.string()),
      headline: v.optional(v.string()),
      body: v.optional(v.string()),
      mediaType: v.optional(v.union(v.literal("image"), v.literal("video"))),
      imageUrl: v.optional(v.string()),
      videoUrl: v.optional(v.string()),
      thumbnailUrl: v.optional(v.string()),
    }),
  ),
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
        // Dead on this path in practice — `processInbound` early-returns
        // on `duplicate` before ever reading it — kept only so both
        // return shapes stay identical rather than diverging.
        conversationAdReferral: existingConversation.adReferral !== undefined,
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
      const contactCode = await allocateContactCode(ctx.db, accountId);
      contactId = await ctx.db.insert("contacts", {
        accountId,
        phone: from,
        phoneNormalized,
        contactCode,
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
      // Through `insertConversation` like every other create path. This
      // is the ONE site where the `awaitingReply: true` it writes is not
      // load-bearing: `insertMessageAndUpdateConversation` runs below in
      // this same transaction and sets the field from the message's own
      // direction (`true` here, since this branch only ever runs for an
      // inbound). It still goes through the helper so there is no
      // second, hand-rolled shape of a new `conversations` row to keep
      // in sync — do NOT "optimise" it back to a bare `ctx.db.insert`.
      conversationId = await insertConversation(ctx, {
        accountId,
        contactId,
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
    // Ranged on `by_conversation_sender` (NOT `by_conversation` + a
    // post-scan `.filter()`): a conversation that only ever carried
    // outbound bot/agent messages — a staff-alert channel gets them daily
    // — was otherwise walked end-to-end here, and past Convex's read limit
    // this mutation ITSELF would fail and the customer's message be lost.
    // The current inbound is not inserted until step (4) below, so this
    // still sees only PRIOR customer messages; `.first()` on the customer
    // partition is the oldest one (or null), identical to the old filter.
    const priorCustomerMessage = await ctx.db
      .query("messages")
      .withIndex("by_conversation_sender", (q) =>
        q.eq("conversationId", conversationId).eq("senderType", "customer"),
      )
      .first();
    const isFirstInboundMessage = priorCustomerMessage === null;

    // ---- (4) insert the inbound message + conversation denorm ----
    // Reuses `messages.ts`'s shared insert-and-denormalize core as a
    // plain function call (not `ctx.runMutation(internal.messages.
    // appendInternal, ...)`) so contact-create + conversation-create +
    // message-insert + denorm all commit as ONE transaction — see that
    // module's own doc comment on `appendInternal`, which foreshadows
    // exactly this caller.
    // Reply linkage: the webhook's `context.id` (surfaced as `contextWamid`)
    // is the wamid of the message the customer replied to. Map it to that
    // message's internal id, scoped to THIS conversation — wamids aren't
    // globally unique (see the dedup guard above) and a reply always targets
    // a message in the same chat. Not found (e.g. a reply to a pre-CRM
    // message we never stored) → left undefined, and the bubble renders
    // plainly instead of a quote.
    let replyToMessageId: Id<"messages"> | undefined;
    const parentWamid = message.contextWamid;
    if (parentWamid) {
      const parent = await ctx.db
        .query("messages")
        .withIndex("by_message_id", (q) => q.eq("messageId", parentWamid))
        .filter((q) => q.eq(q.field("conversationId"), conversationId))
        .first();
      replyToMessageId = parent?._id;
    }

    const appendArgs: AppendMessageArgs = {
      accountId,
      conversationId,
      senderType: "customer",
      contentType: message.type,
      contentText: message.text,
      mediaUrl: message.mediaUrl,
      messageId: message.wamid,
      interactiveReplyId: message.interactiveReplyId,
      replyToMessageId,
      referral: message.referral,
    };
    const messageId = await insertMessageAndUpdateConversation(
      ctx,
      appendArgs,
      conversation,
    );

    // ---- (4b) ad-lead denorm + contact acquisition (set once) ----
    // `conversation` is the pre-patch doc, so `.adReferral` reflects state
    // BEFORE this message — the correct "already an ad lead?" check.
    if (message.referral) {
      if (!conversation.adReferral) {
        await ctx.db.patch(conversationId, {
          adReferral: {
            headline: message.referral.headline,
            body: message.referral.body,
            sourceUrl: message.referral.sourceUrl,
            sourceType: message.referral.sourceType,
            imageUrl: message.referral.imageUrl ?? message.referral.thumbnailUrl,
            startedAt: Date.now(),
          },
        });
      }
      const contactForAcq = existingContact ?? (await ctx.db.get(contactId));
      if (contactForAcq && !contactForAcq.acquisitionSource) {
        await ctx.db.patch(contactId, {
          acquisitionSource: "ad",
          acquisitionAd: {
            headline: message.referral.headline,
            sourceId: message.referral.sourceId,
            sourceUrl: message.referral.sourceUrl,
            firstSeenAt: Date.now(),
          },
        });
      }
    }

    return {
      contactId,
      conversationId,
      messageId,
      wasCreated,
      isFirstInboundMessage,
      duplicate: false,
      // Whether this conversation carries the ad-lead display denorm —
      // set from `conversation`, the PRE-patch doc read in step (2)/(4b)
      // above (not a fresh read), so a follow-up message on an
      // already-ad-tagged conversation still reports true even though
      // this call didn't touch the field itself. `processInbound` reads
      // this to decide whether a non-referral message is a follow-up on
      // an ad lead worth a retry ad→service tagging pass — see there.
      conversationAdReferral: conversation.adReferral !== undefined,
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
// CLOSED (Phase 8, Task 4b): the "stand down when an active
// new_message_received/keyword_match automation exists" check inside
// the SOURCE's `dispatchInboundToAiReply` (src/lib/ai/auto-reply.ts:
// 53-68), which avoids double-texting the customer when both an
// automation and the AI would otherwise reply to the same inbound.
// `processMessage` itself has no such check in its own body (it lives
// one layer deeper, inside the AI reply function) — but this Convex
// port's architecture puts ALL cross-engine dispatch precedence in
// THIS orchestrator (mirroring how `flowConsumed`/`automationTriggers`
// are already decided here, not inside `flowsEngine`/`automationsEngine`
// themselves), so the check lives here too, as `shouldDispatchAiReply`
// below, rather than inside `aiReply.dispatchInbound` — closing the
// gap `convex/aiReply.ts`'s own header comment explicitly deferred to
// "a future integration task". See `shouldDispatchAiReply`'s own
// comment for the exact precedence and its test coverage.
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
 * src/lib/ai/auto-reply.ts:53-68 — the "stand down when an active
 * message-level automation exists" precedence (see this file's header
 * comment above for why it now lives here rather than inside
 * `aiReply.dispatchInbound` itself). `new_message_received`/
 * `keyword_match` automations are dispatched independently for this
 * same inbound (see `determineAutomationTriggers` above) and may send
 * their own reply, so when the account has ANY active one, the AI
 * stands down entirely to avoid double-texting the customer —
 * regardless of whether that automation's own trigger actually matched
 * THIS message's content (the source's own check is exactly this
 * coarse: an account-wide existence check, not a per-message match —
 * see `automationsEngine.hasActiveAutoResponder`'s own comment). Pure,
 * so the whole precedence is directly testable without a live query;
 * `hasActiveAutoResponder` is supplied by the caller (that internal
 * query's result) since this function has no `ctx` and cannot read the
 * DB itself.
 */
export function shouldDispatchAiReply(input: {
  flowConsumed: boolean;
  interactiveReplyId?: string;
  inboundText: string;
  hasActiveAutoResponder: boolean;
  contentType: string;
}): boolean {
  if (input.flowConsumed) return false;
  if (input.interactiveReplyId) return false;
  if (input.hasActiveAutoResponder) return false;
  if (input.inboundText.trim()) return true;
  // No text: a customer-content attachment (voice note, image, …) still
  // deserves a reply — the transcript renders it as a placeholder the
  // model can acknowledge (`lib/ai/context.ts`). Anything else textless
  // (empty text row, unsupported type) stays a no-op.
  return (AI_VISIBLE_MEDIA_TYPES as readonly string[]).includes(input.contentType);
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

    // ---- Inbound media resolution ----
    // A media message (voice note / image / video / document) arrives as
    // a bare Meta `mediaId`: `flattenInboundMessage` can't resolve it (a
    // signed Graph fetch is real network I/O), and neither can the
    // `ingestInbound` mutation, so the row was just persisted with no
    // `mediaKey`/`mediaUrl` — which the inbox renders as an "unavailable"
    // bubble. Now — AFTER the dedup check, so a Meta retry can't
    // re-download and orphan a second copy in R2 — pull the bytes into
    // Cloudflare R2 and attach the resulting object KEY (not a resolved
    // URL — R2-migration Task 7, completing the cutover `resolveInboundMedia`
    // started in Task 6) to the already-persisted message. Readers
    // resolve `mediaKey ?? mediaUrl` lazily wherever the media is
    // actually rendered/fetched (`convex/lib/r2/url.ts`'s
    // `resolveMediaUrl`, Task 5), so nothing downstream needs an
    // eagerly-resolved URL. Best-effort: `resolveInboundMedia` returns
    // null on any failure, leaving the "unavailable" bubble rather than
    // derailing the fan-out below (a media that won't fetch must not
    // cost the customer their flow/automation/AI reply).
    if (message.mediaId && !message.mediaUrl) {
      const resolved = await ctx.runAction(
        internal.whatsappConfig.resolveInboundMedia,
        { accountId, mediaId: message.mediaId },
      );
      if (resolved) {
        await ctx.runMutation(internal.messages.setMediaKey, {
          messageId: res.messageId,
          mediaKey: resolved.key,
        });
      }
    }

    // ---- Ad-referral image → storage ----
    // The referral gives a DIRECT public CDN url (not a Meta mediaId), so a
    // plain `storeFromUrl` (no auth headers) re-hosts it into Cloudflare R2
    // — same durability the inbound-media block gives voice notes/photos,
    // so the ad card never breaks when Meta's CDN url expires. After the
    // dedup guard above, so a Meta retry can't orphan a second copy.
    //
    // R2-migration write path (Task 7, completing what Task 6 staged):
    // `storeFromUrl` returns `{ key }`, and that key is now handed
    // straight to `messages.setAdReferralImage` as `storedImageKey` — NO
    // `publicUrl`/`r2ConfigFromEnv` resolution happens here anymore (it
    // used to, as a behavior-preserving shim while the mutation still
    // expected a URL). The inbox reads
    // `referral.storedImageKey ?? referral.storedImageUrl` lazily
    // (`src/lib/convex/adapters.ts`'s `toUiMessage`, Task 5), so eagerly
    // resolving a URL at ingest time bought nothing but an extra way for
    // this best-effort step to fail. `setAdReferralImage` no longer
    // denormalizes onto `conversation.adReferral` either — see that
    // mutation's own doc comment for why (no `storedImageKey` field on
    // that denorm, and nothing ever rendered its image).
    const adImageSrc = message.referral?.imageUrl ?? message.referral?.thumbnailUrl;
    if (adImageSrc) {
      await runBestEffort("ingest.storeAdReferralImage", async () => {
        const { key } = await ctx.runAction(internal.files.storeFromUrl, {
          url: adImageSrc,
          accountId,
          kind: "ad",
        });
        await ctx.runMutation(internal.messages.setAdReferralImage, {
          messageId: res.messageId,
          storedImageKey: key,
        });
      });
    }

    // ---- Ad landing-page prefetch (ad-aware AI replies) ----
    // The referral's `source_url` is the page the ad linked out to — the
    // thing that actually names the package the customer clicked. Warm
    // `adLandingPages` now so the AI dispatch (one debounce away) finds
    // the extraction ready and the FIRST reply can greet with the actual
    // offer. Scheduled, not awaited — ingest latency stays flat, and the
    // dispatch side re-ensures lazily anyway if this loses the race.
    const adLandingUrl = message.referral?.sourceUrl;
    if (adLandingUrl) {
      await runBestEffort("adLanding.ensureFresh", () =>
        ctx.scheduler.runAfter(0, internal.adLanding.ensureFresh, {
          accountId,
          url: adLandingUrl,
        }),
      );
    }

    // ---- Qualification session tracking (P0 — spec §6). Every
    // non-duplicate inbound counts as customer activity: upsert the
    // session and bump the 24h/72h clocks BEFORE the reply engines run,
    // so nothing downstream (flow-consumed or not) can lose the signal.
    // Dormant-safe: no enabled config → the mutation no-ops. P1 adds
    // the analysis step separately (after flows, before the AI reply).
    await runBestEffort("qualificationEngine.onInbound", () =>
      ctx.runMutation(internal.qualificationEngine.onInbound, {
        accountId,
        conversationId: res.conversationId,
        contactId: res.contactId,
        phoneNormalized: normalizePhone(from),
      }),
    );

    // ---- Lead Analysis (spec 2026-07-26 §Scoring engine). Every inbound
    // customer message re-arms the debounced re-score timer. Dormant-safe
    // (no enabled config → the mutation no-ops) and best-effort: scoring
    // is an analytics concern and must never fail message ingestion.
    await runBestEffort("leadAnalysisEngine.onInbound", () =>
      ctx.runMutation(internal.leadAnalysisEngine.onInbound, {
        accountId,
        conversationId: res.conversationId,
        contactId: res.contactId,
        // Fix 6: the admin alert channel is not a lead — see
        // `onInbound`'s own doc comment for why this is excluded here
        // rather than filtered at read time.
        phoneNormalized: normalizePhone(from),
      }),
    );

    // ---- Un-archive: NOT here any more (fix 2026-07-28). A customer
    // reply always brings an archived thread back, and that is a
    // correctness property of the Inbox rather than a courtesy — so it
    // now runs inside `messages.ts`'s
    // `insertMessageAndUpdateConversation`, in the same transaction as
    // the message insert.
    //
    // It lived here, in `runBestEffort`, from P2 until 2026-07-28,
    // contradicting P2's own spec. The failure mode was silent and bad:
    // a swallowed error left an archived customer invisible in every
    // lane while they were actively writing in, with nothing to retry
    // it. Do not restore this call.

    // ---- Stop the follow-up sequence (spec 2026-07-26 §"Stopping and
    // returning"). Any inbound customer message means the customer is
    // no longer quiet, so the sequence (if one is running) stops right
    // here — the mirror image of `messages.ts`'s `armOnOutbound`, which
    // arms it on our own outbound sends. Dormant-safe (no `leadAnalyses`
    // row → the mutation no-ops) and best-effort: stopping a sequence
    // must never fail message ingestion.
    await runBestEffort("leadAnalysisEngine.stopOnInbound", () =>
      ctx.runMutation(internal.leadAnalysisEngine.stopOnInbound, {
        accountId,
        conversationId: res.conversationId,
      }),
    );

    // ---- Ask-admin relay (v3): an inbound from a configured admin
    // number is the team ANSWERING the assistant's latest question —
    // record it and schedule the customer-facing relay. Self-guarding
    // (non-admin numbers exit on one indexed read); best-effort.
    if ((message.text ?? "").trim()) {
      await runBestEffort("qualificationEngine.onAdminInbound", () =>
        ctx.runMutation(internal.qualificationEngine.onAdminInbound, {
          accountId,
          phoneNormalized: normalizePhone(from),
          text: message.text ?? "",
        }),
      );
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

    const inboundText = message.text ?? "";

    // ---- Qualification ANALYSIS (P1 — spec §7). DEBOUNCED, not inline:
    // this used to be awaited on every inbound text, so a customer
    // fragmenting one thought across four messages bought four full
    // extraction calls while the reply beside it collapsed to one. Same
    // token + staleness pattern as the reply — at fire time only the run
    // whose trigger is still the newest customer message proceeds.
    //
    // The ordering this replaces still holds. It used to be structural:
    // the analysis was awaited HERE, so it always finished before the
    // reply's debounce clock even started, which is what keeps the
    // assistant from re-asking a question the customer just answered.
    // Scheduling alone would have raced that away, so `dispatchInbound`
    // now awaits the analysis itself before it reads objectives — and
    // `analyzeInbound`'s watermark makes that second call free when this
    // scheduled one already did the work.
    //
    // Still runs when a flow consumed the message or a human owns the
    // thread: extraction is passive tracking, not replying, and those are
    // exactly the cases where no dispatch will run it. Text-only:
    // media/interactive taps carry nothing to extract (their activity
    // bump already happened in `qualificationEngine.onInbound` above).
    if (inboundText.trim() && !message.interactiveReplyId) {
      await runBestEffort("qualificationEngine.analyzeInbound", () =>
        ctx.scheduler.runAfter(
          debounceMsForText(inboundText),
          internal.qualificationEngine.analyzeInbound,
          {
            accountId,
            conversationId: res.conversationId,
            contactId: res.contactId,
            triggerMessageId: res.messageId,
          },
        ),
      );
    }

    // ---- Automations (route.ts:756-797). Every trigger in the set
    // dispatches independently and best-effort — one failing (or
    // matching zero automations) must never affect the others.
    const automationTriggers = determineAutomationTriggers({
      flowConsumed,
      wasCreated: res.wasCreated,
      isFirstInboundMessage: res.isFirstInboundMessage,
      interactiveReplyId: message.interactiveReplyId,
    });
    await Promise.all([
      ...automationTriggers.map((triggerType) =>
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
      // Task 5, cancellation path 5: any inbound message is "the contact
      // replied", so this runs unconditionally on which (if any)
      // triggers matched above — `cancelRunsForContact`'s own
      // `onlyStopOnReply` filter is what narrows this to automations
      // that opted in via `stopOnReply`. This is an action (this
      // function's own ctx has `runMutation`), so the cancellation
      // happens inline rather than via a scheduled hop — no race with
      // the run's own scheduled resume the way a plain mutation's
      // `ctx.scheduler.runAfter` path would risk.
      runBestEffort("automationsEngine.cancelRunsForContact", () =>
        ctx.runMutation(internal.automationsEngine.cancelRunsForContact, {
          accountId,
          contactId: res.contactId,
          reason: "contact replied",
          onlyStopOnReply: true,
        }),
      ),
    ]);

    // ---- Media understanding (voice note → transcript, image →
    // description). Deliberately OUTSIDE the auto-reply branch below and
    // gated only on the attachment type: understanding what a customer
    // sent is for the humans working the inbox, so it must not depend on
    // `autoReplyEnabled`, on flows having stood down, or on there being
    // no active auto-responder. Before 2026-07-25 it lived inside
    // `dispatchInbound` below that gate, so an account with auto-reply
    // off — the default — never got a transcript at all and every voice
    // note stayed a bare "[voice note]" in the inbox.
    //
    // Best-effort and fire-and-forget: it sends nothing to the customer,
    // and `dispatchInbound` re-runs the same idempotent step if it needs
    // the text and this hasn't landed yet.
    if ((AI_VISIBLE_MEDIA_TYPES as readonly string[]).includes(message.type)) {
      await runBestEffort("aiReply.understandInboundMedia", () =>
        ctx.scheduler.runAfter(0, internal.aiReply.understandInboundMedia, {
          accountId,
          conversationId: res.conversationId,
          contactId: res.contactId,
        }),
      );
    }

    // ---- AI auto-reply (route.ts:799-811) — flows win over the LLM,
    // an interactive tap never reaches the LLM either, and (closing
    // this file's previously-flagged gap — see the header comment
    // above) the AI stands down when the account has an active
    // new_message_received/keyword_match automation, avoiding a
    // double-text with that automation's own reply. Text OR
    // customer-content media (voice note, image, …) qualifies — a
    // media-only inbound previously got no reply at all.
    if (
      !flowConsumed &&
      !message.interactiveReplyId &&
      (inboundText.trim() ||
        (AI_VISIBLE_MEDIA_TYPES as readonly string[]).includes(message.type))
    ) {
      await runBestEffort("aiReply.dispatchInbound", async () => {
        const hasActiveAutoResponder: boolean = await ctx.runQuery(
          internal.automationsEngine.hasActiveAutoResponder,
          { accountId },
        );
        if (
          !shouldDispatchAiReply({
            flowConsumed,
            interactiveReplyId: message.interactiveReplyId,
            inboundText,
            hasActiveAutoResponder,
            contentType: message.type,
          })
        ) {
          return;
        }
        // Acknowledge instantly — blue tick + "typing…" within a second,
        // rather than after the debounce. Separate from the dispatch
        // because the whole point is that it does NOT wait.
        //
        // Isolated in its own try/catch (whole-branch review Fix F7):
        // this whole callback already runs inside `runBestEffort`, whose
        // try/catch wraps the ENTIRE callback — without this inner
        // guard, a failure scheduling the ack would throw PAST the
        // dispatch scheduling below it and cost the customer their reply
        // entirely, not just the read receipt. The inline `markRead`
        // this replaced had its own try/catch for exactly this reason
        // (an ack failure must never be able to cost a reply).
        try {
          await ctx.scheduler.runAfter(0, internal.aiReply.ackInbound, {
            accountId,
            conversationId: res.conversationId,
            contactId: res.contactId,
            triggerWamid: message.wamid,
          });
        } catch (ackErr) {
          console.error("[ingest] ackInbound scheduling failed:", ackErr);
        }
        // Debounced, not inline: WhatsApp users fragment one thought
        // across quick messages, and one racy dispatch per fragment
        // used to produce multiple partial replies. Each inbound
        // schedules a delayed dispatch carrying its own message id;
        // at fire time only the dispatch whose trigger is still the
        // NEWEST customer message replies (see `dispatchInbound`'s
        // debounce gate) — one reply per burst, at human pace.
        await ctx.scheduler.runAfter(
          debounceMsForText(inboundText),
          internal.aiReply.dispatchInbound,
          {
            accountId,
            conversationId: res.conversationId,
            contactId: res.contactId,
            triggerMessageId: res.messageId,
            // Wall-clock time of THIS inbound — `deliverReply` subtracts
            // time-already-spent from its typing-pace target so model
            // think time is absorbed rather than stacked on top.
            inboundAt: Date.now(),
            // Carried through only so a scheduled retry can resend it —
            // the initial blue-tick + "typing…" already fired above via
            // `ackInbound`.
            triggerWamid: message.wamid,
          },
        );
      });
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

    // ---- Web Push (PWA) — OUTSIDE every guard above, best-effort.
    // Notifies the assigned agent (else owner/admin/supervisor) on their
    // installed devices. A push failure never blocks ingestion.
    await runBestEffort("pushSend.deliverForMessage", () =>
      ctx.runAction(internal.pushSend.deliverForMessage, {
        accountId,
        conversationId: res.conversationId,
        contentType: message.type,
        text: message.text,
        flowConsumed,
      }),
    );

    // ---- Agent-reply SLA (owner requirement 2026-07-18): if a HUMAN
    // has taken this chat and leaves this customer message unanswered,
    // supervisors get escalated. Stateless scheduled check, same
    // pattern as the AI-reply debounce: every inbound books a check; at
    // fire time it no-ops for bot-owned threads (the bot always
    // replies), stands down when a newer customer message exists (its
    // own check owns the cycle), and otherwise notifies + books one
    // repeat.
    await runBestEffort("ingest.checkAgentReplySla", () =>
      ctx.scheduler.runAfter(agentReplySlaMs(), internal.ingest.checkAgentReplySla, {
        accountId,
        conversationId: res.conversationId,
        inboundMessageId: res.messageId,
        stage: 1,
      }),
    );

    // ---- Conversion funnel: first-touch (new_lead) — OUTSIDE every guard
    // above, best-effort. Classify the lead source from the inbound
    // identifiers (our HY- zero-width code → website/code lane, else Meta's
    // ctwa_clid → ad/ctwa lane), set `conversation.attribution` once, seed the
    // ONE new_lead conversion event for that lane, and dispatch it. Replaces
    // the old attribution.recordSignal/sendSignal step: `code` → Platform A
    // only, `ctwa` → direct CAPI only (no more double-fire). Never blocks.
    await runBestEffort("conversionEvents.newLead", async () => {
      const code = extractRefCode(message.text);
      const ctwaClid = extractCtwaClid(message);
      if (!code && !ctwaClid) return;
      const seeded = await ctx.runMutation(
        internal.conversionEvents.seedNewLead,
        {
          accountId,
          contactId: res.contactId,
          conversationId: res.conversationId,
          waMessageId: message.wamid,
          phone: normalizePhone(from),
          firstMessageAt: Date.now(),
          code: code ?? undefined,
          ctwaClid: ctwaClid ?? undefined,
        },
      );
      if (seeded) {
        await ctx.scheduler.runAfter(
          0,
          internal.conversionEvents.deliverConversionEvent,
          { conversionEventId: seeded.conversionEventId },
        );
      }
    });

    // ---- CTWA ad-referral capture (adReferrals + campaignAds) — OUTSIDE
    // every guard above, best-effort like the conversion-funnel step above.
    // Records the raw referral + first-touch and seeds ad->campaign
    // resolution. The `ctwa_clid` it persists is the durable per-conversation
    // source the funnel's ad lane reads later. Separate from the
    // `conversation.adReferral` display denorm written in `ingestInbound`.
    // Never blocks the pipeline.
    if (message.referral || message.ctwaClid) {
      await runBestEffort("adReferrals.recordAdReferral", () =>
        ctx.runMutation(internal.adReferrals.recordAdReferral, {
          accountId,
          contactId: res.contactId,
          conversationId: res.conversationId,
          waMessageId: message.wamid,
          ctwaClid: message.ctwaClid,
          referral: message.referral ?? {},
        }),
      );

      // ---- Ad→service tagging, first (rule) pass. Scheduled rather
      // than inline: the landing-page fetch and the Meta ad-name
      // resolution this benefits from are both still in flight right
      // now, and neither is worth waiting for — the retry pass below
      // picks them up. Best-effort like everything else in this
      // fan-out. See convex/adServiceTagging.ts.
      await runBestEffort("adServiceTagging.tagFromAd(referral)", () =>
        ctx.scheduler.runAfter(0, internal.adServiceTagging.tagFromAd, {
          accountId,
          contactId: res.contactId,
          conversationId: res.conversationId,
          trigger: "referral" as const,
        }),
      );
    }

    // ---- Ad→service tagging, retry (rule) pass. Fires on a FOLLOW-UP
    // message in a conversation that started from an ad — the click
    // itself is handled above. Gated on the `conversation.adReferral`
    // display denorm, which is already on the doc `ingestInbound`
    // returned, so a non-ad inbound costs no extra read at all.
    // `tagFromAd`'s own status/attempt guards make a redundant
    // schedule a no-op, so this needs no cleverness about whether the
    // earlier pass already succeeded.
    //
    // Excludes BOTH `message.referral` and `message.ctwaClid` — matching
    // the capture block's own `message.referral || message.ctwaClid`
    // guard above, not just half of it. `webhookParse.ts` can hand back
    // a `ctwaClid` with no `referral` (a creative-less ad click still
    // carries the click id but has nothing previewable to surface), so
    // a `referral`-only check would let a SECOND such click into an
    // already-ad-tagged conversation satisfy this gate too — booking
    // the retry pass on the same inbound as the first pass instead of
    // reserving it for the customer's own next words, and burning both
    // rule-pass attempts (plus triggering the paid AI fallback) on one
    // message.
    if (!message.referral && !message.ctwaClid && res.conversationAdReferral) {
      await runBestEffort("adServiceTagging.tagFromAd(followup)", () =>
        ctx.scheduler.runAfter(0, internal.adServiceTagging.tagFromAd, {
          accountId,
          contactId: res.contactId,
          conversationId: res.conversationId,
          trigger: "followup" as const,
        }),
      );
    }

    return { duplicate: false, flowConsumed };
  },
});

// ============================================================
// Agent-reply SLA (owner requirement 2026-07-18): "if the agent has
// taken the chat and is not replying, notify the supervisor; if the
// agent still has not replied, notify again."
// ============================================================

const DEFAULT_AGENT_REPLY_SLA_MS = 10 * 60_000;
const DEFAULT_AGENT_REPLY_SLA_REPEAT_MS = 20 * 60_000;

/** How long an ASSIGNED chat may leave a customer message unanswered
 *  before supervisors are alerted. Override with `AGENT_REPLY_SLA_MS`. */
export function agentReplySlaMs(): number {
  const raw = Number(process.env.AGENT_REPLY_SLA_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_AGENT_REPLY_SLA_MS;
}

/** Delay before the still-silent repeat alert (measured from the first
 *  alert). Override with `AGENT_REPLY_SLA_REPEAT_MS`. */
export function agentReplySlaRepeatMs(): number {
  const raw = Number(process.env.AGENT_REPLY_SLA_REPEAT_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_AGENT_REPLY_SLA_REPEAT_MS;
}

/**
 * Fires `agentReplySlaMs()` after every inbound (booked by
 * `processInbound`'s fan-out). Stands down unless ALL of:
 *   - a human owns the thread (`assignedToUserId` — bot threads always
 *     get a bot reply, so they never escalate),
 *   - the conversation is still open/pending,
 *   - the checked inbound is still the NEWEST customer message (a newer
 *     one's own check owns the cycle — the debounce-staleness pattern),
 *   - no agent message was sent after it.
 * Then: one `sla_alert` bell per supervisor+ member (never the silent
 * assignee), a staff-WhatsApp nudge to those with a phone on file, and
 * — on stage 1 — one booked repeat check.
 */
export const checkAgentReplySla = internalMutation({
  args: {
    accountId: v.id("accounts"),
    conversationId: v.id("conversations"),
    inboundMessageId: v.id("messages"),
    stage: v.number(),
  },
  handler: async (ctx, args): Promise<void> => {
    const conversation = await ctx.db.get(args.conversationId);
    if (!conversation || conversation.accountId !== args.accountId) return;
    if (!conversation.assignedToUserId) return; // bot-owned — bot always replies
    if (conversation.status === "closed") return;
    // Archived (P2 final-fixes Fix 7): a thread archived inside the SLA
    // window is a dead conversation, same as a closed one — nobody is
    // meant to be watching it, so the alert must not fire even though
    // `status` itself is untouched by archiving.
    if (conversation.archivedAt !== undefined) return;
    const inbound = await ctx.db.get(args.inboundMessageId);
    if (!inbound || inbound.conversationId !== args.conversationId) return;

    const recent = await ctx.db
      .query("messages")
      .withIndex("by_conversation", (q) => q.eq("conversationId", args.conversationId))
      .order("desc")
      .take(30);
    // The unanswered run = customer messages newer than the last
    // outbound of ANY kind (agent or bot — a bot reply before the
    // takeover means the customer wasn't left hanging). The OLDEST
    // message of that run anchors the cycle: only ITS check fires, and
    // the wait is measured from it — so rapid follow-up pings can never
    // keep resetting the clock while the customer grows angrier.
    const lastOutboundIdx = recent.findIndex((m) => m.senderType !== "customer");
    const unansweredRun = (
      lastOutboundIdx === -1 ? recent : recent.slice(0, lastOutboundIdx)
    ).filter((m) => m.senderType === "customer");
    if (unansweredRun.length === 0) return; // answered — nothing to escalate
    const anchor = unansweredRun[unansweredRun.length - 1];
    if (anchor._id !== args.inboundMessageId) return; // the anchor's check owns the cycle

    const memberships = await ctx.db
      .query("memberships")
      .withIndex("by_account", (q) => q.eq("accountId", args.accountId))
      .collect();
    const assignee = memberships.find((m) => m.userId === conversation.assignedToUserId);
    const assigneeName = assignee?.fullName ?? assignee?.email ?? "the assigned agent";
    const contact = await ctx.db.get(conversation.contactId);
    const customerName = contact?.name?.trim() || contact?.phone || "A customer";
    const waitedMin = Math.max(1, Math.round((Date.now() - inbound._creationTime) / 60_000));

    const title =
      args.stage === 1
        ? "Customer waiting on an assigned chat"
        : "Still waiting: assigned chat unanswered";
    const body = `${customerName} messaged ${waitedMin} min ago and ${assigneeName} hasn't replied yet.`;

    for (const member of memberships) {
      if (!hasMinRole(member.role, "supervisor")) continue;
      if (member.userId === conversation.assignedToUserId) continue; // never the silent assignee
      await insertNotification(ctx, {
        accountId: args.accountId,
        userId: member.userId,
        type: "sla_alert",
        conversationId: args.conversationId,
        contactId: conversation.contactId,
        title,
        body,
      });
      if (member.phone) {
        await ctx.scheduler.runAfter(0, internal.qualificationEngine.notifyStaffText, {
          accountId: args.accountId,
          phone: member.phone,
          text: `⚠️ ${body} Please check the inbox.`,
          // The `insertNotification` bell above already covers this
          // alert, so a skip on a closed window loses nothing — unlike
          // `notifyStaffText`'s other callers, which default to always
          // attempting (see that action's doc comment for why).
          skipWhenWindowClosed: true,
        });
      }
    }

    if (args.stage === 1) {
      await ctx.scheduler.runAfter(
        agentReplySlaRepeatMs(),
        internal.ingest.checkAgentReplySla,
        { ...args, stage: 2 },
      );
    }
  },
});
