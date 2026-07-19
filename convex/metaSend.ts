import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import type { ActionCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { decrypt } from "./lib/whatsappEncryption";
import {
  sendTextMessage,
  sendContactsMessage,
  buildContactsPayload,
  type ContactCard,
  sendMediaMessage,
  sendTemplateMessage,
  sendInteractiveButtons,
  sendInteractiveList,
  sendReactionMessage,
  markMessageRead,
} from "./lib/whatsapp/metaApi";
import {
  validateInteractivePayload,
  type InteractiveMessagePayload,
} from "./lib/whatsapp/interactive";

// ============================================================
// Meta-send actions — the engine's one and only door to the outside
// world (Meta's Cloud API), plus the persistence every send goes
// through afterward. Combines what the ORIGINAL app split across two
// files per engine (`src/lib/automations/meta-send.ts`,
// `src/lib/flows/meta-send.ts` — "load config, decrypt, POST to Meta,
// INSERT the sent message, patch the conversation") into ONE
// engine-agnostic module both the automations engine (Task 3) and the
// flows engine (Task 4) call, since neither engine's send behavior
// actually differs.
//
// Every action here:
//   1. loads the account's `whatsappConfig` via the internal
//      `whatsappConfig.getForAccount` query (never the client-facing
//      `accountQuery` `get` — there is no user session inside an
//      action triggered by the engine);
//   2. decrypts `accessToken` (`lib/whatsappEncryption.ts`'s Web-Crypto
//      `decrypt` — see that file's header for the GCM/CBC wire format);
//   3. POSTs to Meta via `lib/whatsapp/metaApi.ts` — UNLESS
//      `CONVEX_META_DRY_RUN` is set, in which case the network call is
//      skipped entirely and a synthetic `dry-run-<random>` wamid is
//      used instead (mirrors the app's own `WHATSAPP_TEMPLATES_DRY_RUN`
//      pattern per the Phase 6 plan). This is what makes the engine
//      testable end-to-end without a live Meta account: Tasks 3/4's
//      tests run with the env var set and assert on the DB-persist side
//      effects (`messages.appendInternal`'s insert + conversation
//      denorm), never on an actual Meta response.
//   4. persists via `messages.appendInternal` (Phase 2's `append`,
//      minus the auth wrapper — see that function's own doc comment)
//      with `senderType` defaulting to `"bot"` (automations/flows),
//      overridable to `"agent"` by a caller acting on a human's behalf
//      (`convex/send.ts`'s dashboard-initiated `send`, Phase 8 Task 4)
//      — either way the send shows up in the Inbox exactly like a real
//      agent/customer message would.
//
// Intentionally NOT reproduced from the original engine senders: the
// contact-phone lookup + phone-variant retry (trunk-0 dialing quirks)
// in `src/lib/{automations,flows}/meta-send.ts`'s `sendViaMeta`/
// `engineSend*`. Those callers resolved `to` from a `contactId`
// themselves; here `to` is supplied directly by the caller (the
// engine already has the contact's phone on hand from its own
// `contacts` lookup). Phone-variant retry is an engine-level
// orchestration nicety Tasks 3/4 can layer on top of these primitives
// if they find they need it — it's not part of "load config, decrypt,
// send, persist," which is what this task's brief scopes these
// actions to.
// ============================================================

function isDryRun(): boolean {
  return !!process.env.CONVEX_META_DRY_RUN;
}

/**
 * Synthetic wamid used in DRY-RUN mode. Random suffix generated via
 * `crypto.getRandomValues` (not `crypto.randomUUID`) — matching this
 * codebase's own convention (`convex/lib/inviteToken.ts`/`apiKey.ts`)
 * of not assuming `randomUUID` over the more conservatively-supported
 * Web Crypto primitive.
 */
function dryRunWamid(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return `dry-run-${hex}`;
}

/**
 * Load + decrypt the account's WhatsApp config. Throws the same
 * "WhatsApp not configured for this account" message the original
 * `src/lib/{automations,flows}/meta-send.ts` senders used, for
 * familiarity across the two codebases during the migration.
 */
async function loadDecryptedConfig(
  ctx: ActionCtx,
  accountId: Id<"accounts">,
): Promise<{ phoneNumberId: string; accessToken: string }> {
  const config = await ctx.runQuery(internal.whatsappConfig.getForAccount, {
    accountId,
  });
  if (!config) {
    throw new Error("WhatsApp not configured for this account");
  }
  return {
    phoneNumberId: config.phoneNumberId,
    accessToken: await decrypt(config.accessToken),
  };
}

export const sendText = internalAction({
  args: {
    accountId: v.id("accounts"),
    conversationId: v.id("conversations"),
    to: v.string(),
    text: v.string(),
    contextMessageId: v.optional(v.string()),
    // Defaults to "bot" (automations/flows engines); dashboard-initiated
    // sends (`convex/send.ts`) pass "agent" so the message persists as a
    // human send rather than an automation's.
    senderType: v.optional(v.union(v.literal("agent"), v.literal("bot"))),
    // Internal id of the message being replied to (WhatsApp quoted reply).
    // Persisted on the outbound row so the inbox renders the quote — Meta
    // itself is told via `contextMessageId` (the wamid), resolved upstream.
    replyToMessageId: v.optional(v.id("messages")),
  },
  handler: async (ctx, args): Promise<{ whatsappMessageId: string }> => {
    let whatsappMessageId: string;
    if (isDryRun()) {
      whatsappMessageId = dryRunWamid();
    } else {
      const { phoneNumberId, accessToken } = await loadDecryptedConfig(
        ctx,
        args.accountId,
      );
      const result = await sendTextMessage({
        phoneNumberId,
        accessToken,
        to: args.to,
        text: args.text,
        contextMessageId: args.contextMessageId,
      });
      whatsappMessageId = result.messageId;
    }

    await ctx.runMutation(internal.messages.appendInternal, {
      accountId: args.accountId,
      conversationId: args.conversationId,
      senderType: args.senderType ?? "bot",
      replyToMessageId: args.replyToMessageId,
      contentType: "text",
      contentText: args.text,
      messageId: whatsappMessageId,
    });

    return { whatsappMessageId };
  },
});

export const sendTemplate = internalAction({
  args: {
    accountId: v.id("accounts"),
    conversationId: v.id("conversations"),
    to: v.string(),
    templateName: v.string(),
    language: v.optional(v.string()),
    params: v.optional(v.array(v.string())),
    // The template body already rendered with `params` substituted in, for
    // local display only. Meta itself receives the structured
    // name+params payload (see `sendTemplateMessage`), never this string —
    // but the persisted row needs it so the chat bubble shows the sent
    // text and the conversation list preview isn't a bare `[template]`.
    // Optional: callers without a pre-rendered body (see the broadcast /
    // automation / REST callers) simply fall back to that placeholder.
    contentText: v.optional(v.string()),
    contextMessageId: v.optional(v.string()),
    // Defaults to "bot" (automations/flows engines); dashboard-initiated
    // sends (`convex/send.ts`) pass "agent" so the message persists as a
    // human send rather than an automation's.
    senderType: v.optional(v.union(v.literal("agent"), v.literal("bot"))),
    // Internal id of the message being replied to (WhatsApp quoted reply).
    // Persisted on the outbound row so the inbox renders the quote — Meta
    // itself is told via `contextMessageId` (the wamid), resolved upstream.
    replyToMessageId: v.optional(v.id("messages")),
  },
  handler: async (ctx, args): Promise<{ whatsappMessageId: string }> => {
    let whatsappMessageId: string;
    if (isDryRun()) {
      whatsappMessageId = dryRunWamid();
    } else {
      const { phoneNumberId, accessToken } = await loadDecryptedConfig(
        ctx,
        args.accountId,
      );
      const result = await sendTemplateMessage({
        phoneNumberId,
        accessToken,
        to: args.to,
        templateName: args.templateName,
        language: args.language,
        params: args.params,
        contextMessageId: args.contextMessageId,
      });
      whatsappMessageId = result.messageId;
    }

    await ctx.runMutation(internal.messages.appendInternal, {
      accountId: args.accountId,
      conversationId: args.conversationId,
      senderType: args.senderType ?? "bot",
      replyToMessageId: args.replyToMessageId,
      contentType: "template",
      contentText: args.contentText,
      templateName: args.templateName,
      messageId: whatsappMessageId,
    });

    return { whatsappMessageId };
  },
});

export const sendInteractive = internalAction({
  args: {
    accountId: v.id("accounts"),
    conversationId: v.id("conversations"),
    to: v.string(),
    payload: v.any(),
    contextMessageId: v.optional(v.string()),
    // Defaults to "bot" (automations/flows engines); dashboard-initiated
    // sends (`convex/send.ts`) pass "agent" so the message persists as a
    // human send rather than an automation's.
    senderType: v.optional(v.union(v.literal("agent"), v.literal("bot"))),
    // Internal id of the message being replied to (WhatsApp quoted reply).
    // Persisted on the outbound row so the inbox renders the quote — Meta
    // itself is told via `contextMessageId` (the wamid), resolved upstream.
    replyToMessageId: v.optional(v.id("messages")),
  },
  handler: async (ctx, args): Promise<{ whatsappMessageId: string }> => {
    // Validate before send (dry-run or not) so a misconfigured
    // step/node fails with a clean error rather than a confusing 400
    // from Meta mid-conversation — mirrors
    // `src/lib/whatsapp/send-message.ts`'s own "validate up front" step.
    const payload = args.payload as InteractiveMessagePayload;
    const validation = validateInteractivePayload(payload);
    if (!validation.ok) {
      throw new Error(validation.error);
    }

    let whatsappMessageId: string;
    if (isDryRun()) {
      whatsappMessageId = dryRunWamid();
    } else {
      const { phoneNumberId, accessToken } = await loadDecryptedConfig(
        ctx,
        args.accountId,
      );
      if (payload.kind === "buttons") {
        const result = await sendInteractiveButtons({
          phoneNumberId,
          accessToken,
          to: args.to,
          bodyText: payload.body,
          headerText: payload.header,
          footerText: payload.footer,
          buttons: payload.buttons,
          contextMessageId: args.contextMessageId,
        });
        whatsappMessageId = result.messageId;
      } else {
        const result = await sendInteractiveList({
          phoneNumberId,
          accessToken,
          to: args.to,
          bodyText: payload.body,
          buttonLabel: payload.button_label,
          headerText: payload.header,
          footerText: payload.footer,
          sections: payload.sections,
          contextMessageId: args.contextMessageId,
        });
        whatsappMessageId = result.messageId;
      }
    }

    await ctx.runMutation(internal.messages.appendInternal, {
      accountId: args.accountId,
      conversationId: args.conversationId,
      senderType: args.senderType ?? "bot",
      replyToMessageId: args.replyToMessageId,
      contentType: "interactive",
      contentText: payload.body,
      interactivePayload: payload,
      messageId: whatsappMessageId,
    });

    return { whatsappMessageId };
  },
});

export const sendMedia = internalAction({
  args: {
    accountId: v.id("accounts"),
    conversationId: v.id("conversations"),
    to: v.string(),
    kind: v.union(
      v.literal("image"),
      v.literal("video"),
      v.literal("document"),
      v.literal("audio"),
    ),
    link: v.string(),
    // R2 object key the caller already resolved `link` from (Task 5's
    // dual-read: `send.ts`/`flowsEngine.ts` both call
    // `resolveMediaUrlLazy` before reaching this action). Persisted
    // alongside `mediaUrl` below so the durable key isn't discarded the
    // moment it's resolved to a URL — see this file's own
    // `appendInternal` call for why both are kept. Absent for a legacy
    // caller that only ever had a `mediaUrl` (no key to carry).
    mediaKey: v.optional(v.string()),
    caption: v.optional(v.string()),
    filename: v.optional(v.string()),
    contextMessageId: v.optional(v.string()),
    // Defaults to "bot" (automations/flows engines); dashboard-initiated
    // sends (`convex/send.ts`) pass "agent" so the message persists as a
    // human send rather than an automation's.
    senderType: v.optional(v.union(v.literal("agent"), v.literal("bot"))),
    // Internal id of the message being replied to (WhatsApp quoted reply).
    // Persisted on the outbound row so the inbox renders the quote — Meta
    // itself is told via `contextMessageId` (the wamid), resolved upstream.
    replyToMessageId: v.optional(v.id("messages")),
  },
  handler: async (ctx, args): Promise<{ whatsappMessageId: string }> => {
    let whatsappMessageId: string;
    if (isDryRun()) {
      whatsappMessageId = dryRunWamid();
    } else {
      const { phoneNumberId, accessToken } = await loadDecryptedConfig(
        ctx,
        args.accountId,
      );
      const result = await sendMediaMessage({
        phoneNumberId,
        accessToken,
        to: args.to,
        kind: args.kind,
        link: args.link,
        caption: args.caption,
        filename: args.filename,
        contextMessageId: args.contextMessageId,
      });
      whatsappMessageId = result.messageId;
    }

    await ctx.runMutation(internal.messages.appendInternal, {
      accountId: args.accountId,
      conversationId: args.conversationId,
      senderType: args.senderType ?? "bot",
      replyToMessageId: args.replyToMessageId,
      // `MediaKind` ("image"/"video"/"document"/"audio") is a strict
      // subset of `messages.contentType` — every value maps straight
      // across with no translation.
      contentType: args.kind,
      contentText: args.caption,
      mediaUrl: args.link,
      // Persisted alongside `mediaUrl`, not instead of it: `mediaUrl` is
      // what Meta was actually POSTed (`args.link`), and the read
      // resolver (`convex/lib/r2/url.ts`'s `resolveMediaUrl`) prefers
      // the key anyway when both are present. Final-review fix:
      // previously this was `mediaUrl: args.link` unconditionally with
      // no `mediaKey` field at all, so a caller's already-minted key
      // was resolved to a URL one call earlier and then silently
      // dropped — see this action's own args doc comment on `mediaKey`.
      mediaKey: args.mediaKey,
      messageId: whatsappMessageId,
    });

    return { whatsappMessageId };
  },
});

/**
 * Reacts to (or, with `emoji: ""`, removes a reaction from) a
 * previously-exchanged message on Meta's side — the one metaSend action
 * with NO `messages.appendInternal` persistence step, since a reaction
 * is its own row (`convex/schema.ts`'s `messageReactions`) already
 * written by the public `reactions.set`/`remove` mutations; this action
 * only notifies Meta. Deliberately takes `conversationId` instead of a
 * `to` phone (unlike every sibling action above) — there is no contact
 * lookup left for a caller to have already done the way there is for
 * text/template/interactive/media (see this file's header comment on
 * why THOSE take `to` directly), so `conversations.resolveSendTarget`
 * resolves it here instead. That same call is also this action's
 * tenancy gate — run UNCONDITIONALLY (not just on the real-Meta-call
 * branch) so a cross-account `conversationId` is rejected in DRY-RUN
 * too, mirroring `sendText`'s own "account-scoped" guarantee even
 * though there's no `appendInternal` write here to carry that check.
 */
export const sendReaction = internalAction({
  args: {
    accountId: v.id("accounts"),
    conversationId: v.id("conversations"),
    targetWhatsappMessageId: v.string(),
    emoji: v.string(),
  },
  handler: async (ctx, args): Promise<{ whatsappMessageId: string }> => {
    const { to } = await ctx.runQuery(
      internal.conversations.resolveSendTarget,
      { accountId: args.accountId, conversationId: args.conversationId },
    );

    let whatsappMessageId: string;
    if (isDryRun()) {
      whatsappMessageId = dryRunWamid();
    } else {
      const { phoneNumberId, accessToken } = await loadDecryptedConfig(
        ctx,
        args.accountId,
      );
      const result = await sendReactionMessage({
        phoneNumberId,
        accessToken,
        to,
        targetMessageId: args.targetWhatsappMessageId,
        emoji: args.emoji,
      });
      whatsappMessageId = result.messageId;
    }

    return { whatsappMessageId };
  },
});

/**
 * Marks an inbound message as read on WhatsApp (blue ticks) and, with
 * `typingIndicator`, shows "typing…" until the next send (Meta
 * auto-dismisses it after ~25s). Customer-facing polish only —
 * deliberately NO `messages.appendInternal` step and NO local state:
 * the CRM's own unread counters track what the TEAM has read, and the
 * bot acknowledging a thread must never clear the agent-facing badge.
 */
export const markRead = internalAction({
  args: {
    accountId: v.id("accounts"),
    whatsappMessageId: v.string(),
    typingIndicator: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<void> => {
    if (isDryRun()) return;
    const { phoneNumberId, accessToken } = await loadDecryptedConfig(
      ctx,
      args.accountId,
    );
    await markMessageRead({
      phoneNumberId,
      accessToken,
      messageId: args.whatsappMessageId,
      typingIndicator: args.typingIndicator,
    });
  },
});

/**
 * Phase 6: send a WhatsApp CONTACT CARD (Cloud API `type: "contacts"`,
 * WhatsApp's native vCard) — used when a lead is assigned so the
 * customer can save the agent's full details. Beyond the required
 * name+phone, every extra field (title, company, email, website,
 * address) enriches the card the customer taps to save. Persists a
 * `"contacts"` row with the exact payload sent (the inbox renders it as
 * a card bubble) plus a readable `contentText` fallback for previews.
 */
export const sendContactCard = internalAction({
  args: {
    accountId: v.id("accounts"),
    conversationId: v.id("conversations"),
    to: v.string(),
    cardName: v.string(),
    cardPhone: v.string(),
    jobTitle: v.optional(v.string()),
    company: v.optional(v.string()),
    email: v.optional(v.string()),
    website: v.optional(v.string()),
    companyPhone: v.optional(v.string()),
    address: v.optional(
      v.object({
        street: v.optional(v.string()),
        city: v.optional(v.string()),
        state: v.optional(v.string()),
        zip: v.optional(v.string()),
        country: v.optional(v.string()),
        countryCode: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx, args): Promise<{ whatsappMessageId: string }> => {
    const card: ContactCard = {
      name: args.cardName,
      phone: args.cardPhone,
      jobTitle: args.jobTitle,
      company: args.company,
      email: args.email,
      website: args.website,
      companyPhone: args.companyPhone,
      address: args.address,
    };
    let whatsappMessageId: string;
    if (isDryRun()) {
      whatsappMessageId = dryRunWamid();
    } else {
      const { phoneNumberId, accessToken } = await loadDecryptedConfig(
        ctx,
        args.accountId,
      );
      const result = await sendContactsMessage({
        phoneNumberId,
        accessToken,
        to: args.to,
        card,
      });
      whatsappMessageId = result.messageId;
    }
    const titleLine = [args.jobTitle, args.company]
      .map((s) => s?.trim())
      .filter(Boolean)
      .join(" · ");
    await ctx.runMutation(internal.messages.appendInternal, {
      accountId: args.accountId,
      conversationId: args.conversationId,
      senderType: "bot",
      contentType: "contacts",
      contentText:
        `📇 ${args.cardName}` +
        (titleLine ? `\n${titleLine}` : "") +
        `\n${args.cardPhone}`,
      contactsPayload: [buildContactsPayload(card)],
      messageId: whatsappMessageId,
    });
    return { whatsappMessageId };
  },
});
