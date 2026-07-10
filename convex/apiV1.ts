import { query, mutation, action } from "./_generated/server";
import { internal } from "./_generated/api";
import { v, ConvexError } from "convex/values";
import { encrypt } from "./lib/whatsappEncryption";
import { normalizePhone, isValidE164 } from "./lib/phone";
import { findOrCreateContactByPhone } from "./contacts";
import { loadActiveApiKey } from "./apiKeys";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx, MutationCtx, ActionCtx } from "./_generated/server";

// ============================================================
// Public REST API (`/api/v1/*`) data functions — Phase 8, Task 5, the
// last server surface still on Supabase before this migration. Every
// function here is PUBLIC (reachable via `ConvexHttpClient` from
// `src/app/api/v1/*`'s route handlers) but NONE is built on
// `accountQuery`/`accountMutation`: a public-API caller authenticates
// with a bearer API key, not a Convex Auth session, so there is no
// `ctx.accountId` for those wrappers to derive in the first place (the
// same reason `apiKeys.lookupByHash`/`resolveByHash` are plain
// `internalQuery`/`query`, not `accountQuery`). Instead, EVERY function
// below takes a `keyHash` (the SHA-256 of the caller's presented key,
// hashed Next-side by `src/lib/auth/api-context.ts` — the plaintext key
// itself never reaches Convex) and re-resolves the account + scopes
// from it ITSELF via `requireScope`/`requireScopeAction` below — NEVER
// from a client-supplied `accountId` (there is no such argument
// anywhere in this file). This re-resolution is deliberate
// defense-in-depth: `requireApiKey` already checked the key/scope once
// in the Next.js route, but the actual data operation re-derives
// tenancy from the credential itself rather than trusting a value that
// crossed a process boundary.
//
// Two shapes of function, chosen per op by what it needs to do:
//   - `query`/`mutation` (contacts, conversations, messages-list,
//     webhooks, me, get-broadcast): these have `ctx.db` directly, so
//     `requireScope` below calls `loadActiveApiKey` (a plain function,
//     `convex/apiKeys.ts`) straight against `ctx.db` — no `runQuery`
//     hop needed.
//   - `action` (`sendMessage`, `createBroadcast`): these need
//     `ctx.runAction` (to reach `metaSend.*`'s Meta calls) and/or
//     `ctx.scheduler` (to fan out a broadcast), neither of which exists
//     off a plain `query`/`mutation` ctx. Actions have no `ctx.db`, so
//     `requireScopeAction` below goes through
//     `ctx.runQuery(internal.apiKeys.lookupByHash, ...)` instead, and
//     every subsequent data operation is a `ctx.runQuery`/`runMutation`/
//     `runAction` into an existing (or newly added, account-explicit)
//     internal helper — see `convex/contacts.ts`'s
//     `findOrCreateByPhoneInternal`, `convex/broadcasts.ts`'s
//     `createInternal`, and the already-existing
//     `conversations.findOrCreateForContactInternal` /
//     `conversations.resolveSendTarget` / `metaSend.*` / `broadcasts
//     .startSendingInternal` / `broadcasts.deliverOne`.
//
// Return values are plain domain data (Convex doc shape: `_id`, camelCase
// fields) — NOT the public REST wire shape (snake_case `id`,
// `created_at`, etc.). `src/lib/api/v1/*.ts`'s serializers own that
// final projection, same division of labor the dashboard's Convex
// queries already have with their React consumers.
// ============================================================

// ---- shared auth helpers ------------------------------------------

/**
 * Resolves `keyHash` to its account + enforces `scope`, for every
 * `query`/`mutation`-shaped op below. Throws `UNAUTHORIZED` for an
 * unknown/revoked/expired key, `FORBIDDEN` (with the missing `scope`)
 * for a live key that lacks it. Returns the FULL key doc (not just
 * `{accountId, scopes}`) since a couple of callers need more —
 * `createWebhook` wants `createdByUserId`, `getMe` wants `_id`.
 */
async function requireScope(
  ctx: { db: QueryCtx["db"] },
  keyHash: string,
  scope: string,
): Promise<Doc<"apiKeys">> {
  const key = await loadActiveApiKey(ctx, keyHash);
  if (!key) throw new ConvexError({ code: "UNAUTHORIZED" });
  if (!key.scopes.includes(scope)) {
    throw new ConvexError({ code: "FORBIDDEN", scope });
  }
  return key;
}

/** `action`-shaped counterpart to `requireScope` — see file header. */
async function requireScopeAction(
  ctx: { runQuery: ActionCtx["runQuery"] },
  keyHash: string,
  scope: string,
): Promise<{ accountId: Id<"accounts">; scopes: string[] }> {
  const key = await ctx.runQuery(internal.apiKeys.lookupByHash, { keyHash });
  if (!key) throw new ConvexError({ code: "UNAUTHORIZED" });
  if (!key.scopes.includes(scope)) {
    throw new ConvexError({ code: "FORBIDDEN", scope });
  }
  return key;
}

/** Throws a `BAD_REQUEST` `ConvexError` — `never` so callers narrow. */
function badRequest(message: string): never {
  throw new ConvexError({ code: "BAD_REQUEST", message });
}

// ---- shared pagination helper --------------------------------------
//
// `listContacts`/`listConversations` need to filter (search/tag,
// status/contact) in JS BEFORE paginating (Convex's own `.paginate()`
// only works on an unfiltered index range scan), so they can't use
// Convex's native cursor. Instead the "cursor" for these two ops is
// simply a stringified offset into the filtered, `_creationTime`-desc-
// ordered array — still an OPAQUE string as far as the public API
// contract is concerned (clients already only ever pass a cursor back
// verbatim; nothing promises a specific encoding). `listMessages` has no
// filters, so it uses Convex's native `.paginate()` cursor directly
// instead (see that function). Trades a full per-account collect+filter
// for implementation simplicity/correctness during this migration; worth
// revisiting with a pushed-down index scan if accounts grow very large.

function decodeOffset(cursor: string | undefined): number {
  if (!cursor) return 0;
  const n = Number(cursor);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

function offsetPage<T>(
  all: T[],
  offset: number,
  limit: number,
): { page: T[]; nextCursor: string | null } {
  const page = all.slice(offset, offset + limit);
  const nextCursor = offset + limit < all.length ? String(offset + limit) : null;
  return { page, nextCursor };
}

// ---- contacts --------------------------------------------------------

const DEFAULT_TAG_COLOR = "#3b82f6";

/** Mirrors `contacts.ts`'s private `embedTags` — see that file's own
 * comment on why this is duplicated rather than imported. */
async function embedContactTags(ctx: { db: QueryCtx["db"] }, contact: Doc<"contacts">) {
  const links = await ctx.db
    .query("contactTags")
    .withIndex("by_contact", (q) => q.eq("contactId", contact._id))
    .collect();
  const tags = (
    await Promise.all(links.map((link) => ctx.db.get(link.tagId)))
  ).filter((tag): tag is Doc<"tags"> => tag !== null);
  return { ...contact, tags };
}

/**
 * Replaces a contact's tags to exactly match `tagNames` (case-
 * insensitive; missing names are created) — the Convex counterpart to
 * the old `src/lib/api/v1/contacts.ts`'s `setContactTags` (which called
 * Postgres's `resolveImportTagIds`). Diffs against the current joins
 * (mirrors that function's own "diff, don't delete-all-then-insert"
 * reasoning) so a mid-operation failure can't wipe tags meant to stay.
 */
async function setContactTagsByName(
  ctx: { db: MutationCtx["db"] },
  accountId: Id<"accounts">,
  contactId: Id<"contacts">,
  tagNames: string[],
): Promise<void> {
  const existingTags = await ctx.db
    .query("tags")
    .withIndex("by_account", (q) => q.eq("accountId", accountId))
    .collect();
  const byLowerName = new Map(existingTags.map((t) => [t.name.toLowerCase(), t._id]));

  const desiredIds: Id<"tags">[] = [];
  const seenNames = new Set<string>();
  for (const raw of tagNames) {
    const name = raw.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seenNames.has(key)) continue;
    seenNames.add(key);

    let tagId = byLowerName.get(key);
    if (!tagId) {
      tagId = await ctx.db.insert("tags", { accountId, name, color: DEFAULT_TAG_COLOR });
      byLowerName.set(key, tagId);
    }
    desiredIds.push(tagId);
  }

  const desired = new Set(desiredIds);
  const currentLinks = await ctx.db
    .query("contactTags")
    .withIndex("by_contact", (q) => q.eq("contactId", contactId))
    .collect();
  const current = new Set(currentLinks.map((l) => l.tagId));

  for (const link of currentLinks) {
    if (!desired.has(link.tagId)) await ctx.db.delete(link._id);
  }
  for (const tagId of desiredIds) {
    if (!current.has(tagId)) {
      await ctx.db.insert("contactTags", { accountId, contactId, tagId });
    }
  }
}

export const listContacts = query({
  args: {
    keyHash: v.string(),
    limit: v.number(),
    cursor: v.optional(v.string()),
    search: v.optional(v.string()),
    tag: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const key = await requireScope(ctx, args.keyHash, "contacts:read");

    let contacts = await ctx.db
      .query("contacts")
      .withIndex("by_account", (q) => q.eq("accountId", key.accountId))
      .order("desc")
      .collect();

    const term = args.search?.trim().toLowerCase();
    if (term) {
      contacts = contacts.filter(
        (c) =>
          (c.name ?? "").toLowerCase().includes(term) ||
          c.phone.toLowerCase().includes(term),
      );
    }

    if (args.tag) {
      const tagId = ctx.db.normalizeId("tags", args.tag);
      if (!tagId) {
        contacts = [];
      } else {
        const links = await ctx.db
          .query("contactTags")
          .withIndex("by_tag", (q) => q.eq("tagId", tagId))
          .collect();
        const withTag = new Set(links.map((l) => l.contactId));
        contacts = contacts.filter((c) => withTag.has(c._id));
      }
    }

    const { page, nextCursor } = offsetPage(contacts, decodeOffset(args.cursor), args.limit);
    const items = await Promise.all(page.map((c) => embedContactTags(ctx, c)));
    return { items, nextCursor };
  },
});

export const getContact = query({
  args: { keyHash: v.string(), contactId: v.string() },
  handler: async (ctx, args) => {
    const key = await requireScope(ctx, args.keyHash, "contacts:read");
    const id = ctx.db.normalizeId("contacts", args.contactId);
    const contact = id ? await ctx.db.get(id) : null;
    if (!contact || contact.accountId !== key.accountId) return null;
    return await embedContactTags(ctx, contact);
  },
});

export const createContact = mutation({
  args: {
    keyHash: v.string(),
    phone: v.string(),
    name: v.optional(v.string()),
    email: v.optional(v.string()),
    company: v.optional(v.string()),
    tags: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const key = await requireScope(ctx, args.keyHash, "contacts:write");

    const phone = args.phone.trim();
    if (!phone) badRequest("'phone' is required");
    if (!isValidE164(normalizePhone(phone))) {
      badRequest(
        "'phone' must be a valid phone number in E.164 format (e.g. +14155550123)",
      );
    }

    const { contactId, created } = await findOrCreateContactByPhone(ctx, key.accountId, {
      phone,
      name: args.name,
      email: args.email,
      company: args.company,
    });

    if (args.tags) {
      await setContactTagsByName(ctx, key.accountId, contactId, args.tags);
    }

    const contact = (await ctx.db.get(contactId))!;
    return { contact: await embedContactTags(ctx, contact), created };
  },
});

export const updateContact = mutation({
  args: {
    keyHash: v.string(),
    contactId: v.string(),
    // Present-vs-absent (not just nullish) matters here — see
    // `src/app/api/v1/contacts/[id]/route.ts`'s PATCH handler, which
    // only forwards a key when the caller's JSON body actually contains
    // it (`'field' in body`), so a field the caller never mentioned
    // stays untouched, `null` clears it, and a string sets it.
    name: v.optional(v.union(v.string(), v.null())),
    email: v.optional(v.union(v.string(), v.null())),
    company: v.optional(v.union(v.string(), v.null())),
    tags: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const key = await requireScope(ctx, args.keyHash, "contacts:write");
    const id = ctx.db.normalizeId("contacts", args.contactId);
    const contact = id ? await ctx.db.get(id) : null;
    if (!contact || contact.accountId !== key.accountId) return null;

    const patch: Partial<{ name: string; email: string; company: string }> = {};
    if ("name" in args) patch.name = args.name ?? undefined;
    if ("email" in args) patch.email = args.email ?? undefined;
    if ("company" in args) patch.company = args.company ?? undefined;
    if (Object.keys(patch).length > 0) {
      await ctx.db.patch(contact._id, patch);
    }

    if (args.tags) {
      await setContactTagsByName(ctx, key.accountId, contact._id, args.tags);
    }

    const updated = (await ctx.db.get(contact._id))!;
    return await embedContactTags(ctx, updated);
  },
});

/**
 * New — there is no pre-existing `DELETE /api/v1/contacts/{id}` REST
 * route (see the Phase 8 Task 5 report), but the task brief calls for a
 * `deleteContact` op alongside the other four. Cascades `contactTags`
 * (Convex has no `ON DELETE`), mirroring `contacts.remove`'s own cascade.
 */
export const deleteContact = mutation({
  args: { keyHash: v.string(), contactId: v.string() },
  handler: async (ctx, args) => {
    const key = await requireScope(ctx, args.keyHash, "contacts:write");
    const id = ctx.db.normalizeId("contacts", args.contactId);
    const contact = id ? await ctx.db.get(id) : null;
    if (!contact || contact.accountId !== key.accountId) return null;

    const links = await ctx.db
      .query("contactTags")
      .withIndex("by_contact", (q) => q.eq("contactId", contact._id))
      .collect();
    for (const link of links) await ctx.db.delete(link._id);
    await ctx.db.delete(contact._id);
    return { id: contact._id };
  },
});

// ---- conversations + messages ---------------------------------------

async function embedConversationContact(
  ctx: { db: QueryCtx["db"] },
  conversation: Doc<"conversations">,
) {
  const contact = await ctx.db.get(conversation.contactId);
  return {
    ...conversation,
    contact: contact ? await embedContactTags(ctx, contact) : null,
  };
}

export const listConversations = query({
  args: {
    keyHash: v.string(),
    limit: v.number(),
    cursor: v.optional(v.string()),
    status: v.optional(v.string()),
    contactId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const key = await requireScope(ctx, args.keyHash, "conversations:read");

    // `by_account` (NOT `by_account_last_message`) — the REST contract
    // orders by creation time (`order('created_at', {ascending:false})`),
    // not by recency-of-activity the dashboard's own `conversations.list`
    // uses; `_creationTime` via `by_account` + `.order("desc")` matches
    // that exactly.
    let conversations = await ctx.db
      .query("conversations")
      .withIndex("by_account", (q) => q.eq("accountId", key.accountId))
      .order("desc")
      .collect();

    if (args.status) {
      conversations = conversations.filter((c) => c.status === args.status);
    }
    if (args.contactId) {
      const contactId = ctx.db.normalizeId("contacts", args.contactId);
      conversations = contactId
        ? conversations.filter((c) => c.contactId === contactId)
        : [];
    }

    const { page, nextCursor } = offsetPage(
      conversations,
      decodeOffset(args.cursor),
      args.limit,
    );
    const items = await Promise.all(page.map((c) => embedConversationContact(ctx, c)));
    return { items, nextCursor };
  },
});

export const getConversation = query({
  args: { keyHash: v.string(), conversationId: v.string() },
  handler: async (ctx, args) => {
    const key = await requireScope(ctx, args.keyHash, "conversations:read");
    const id = ctx.db.normalizeId("conversations", args.conversationId);
    const conversation = id ? await ctx.db.get(id) : null;
    if (!conversation || conversation.accountId !== key.accountId) return null;
    return await embedConversationContact(ctx, conversation);
  },
});

export const listMessages = query({
  args: {
    keyHash: v.string(),
    conversationId: v.string(),
    limit: v.number(),
    cursor: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const key = await requireScope(ctx, args.keyHash, "messages:read");
    const id = ctx.db.normalizeId("conversations", args.conversationId);
    const conversation = id ? await ctx.db.get(id) : null;
    if (!conversation || conversation.accountId !== key.accountId) return null;

    // No filters on this endpoint — Convex's own `.paginate()` cursor is
    // used directly (unlike `listContacts`/`listConversations` above).
    const result = await ctx.db
      .query("messages")
      .withIndex("by_conversation", (q) => q.eq("conversationId", conversation._id))
      .order("desc")
      .paginate({ numItems: args.limit, cursor: args.cursor ?? null });

    return {
      items: result.page,
      nextCursor: result.isDone ? null : result.continueCursor,
    };
  },
});

const VALID_MESSAGE_TYPES = [
  "text",
  "template",
  "image",
  "video",
  "document",
  "audio",
  "interactive",
] as const;
const MEDIA_KINDS = ["image", "video", "document", "audio"] as const;

export const sendMessage = action({
  args: {
    keyHash: v.string(),
    to: v.string(),
    // Names a newly-created contact for this phone (ignored when an
    // existing contact already matches `to`) — mirrors the pre-migration
    // route's own top-level `name` body field, passed through to
    // `resolveConversationByPhone`'s `name` param.
    name: v.optional(v.string()),
    type: v.string(),
    text: v.optional(v.string()),
    mediaUrl: v.optional(v.string()),
    filename: v.optional(v.string()),
    template: v.optional(
      v.object({
        name: v.string(),
        language: v.optional(v.string()),
        params: v.optional(v.array(v.string())),
      }),
    ),
    interactive: v.optional(v.any()),
    replyToMessageId: v.optional(v.id("messages")),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    messageId: Id<"messages"> | null;
    whatsappMessageId: string;
    conversationId: Id<"conversations">;
    contactId: Id<"contacts">;
    contactCreated: boolean;
  }> => {
    const key = await requireScopeAction(ctx, args.keyHash, "messages:send");

    if (!(VALID_MESSAGE_TYPES as readonly string[]).includes(args.type)) {
      badRequest(`Unsupported message_type "${args.type}"`);
    }
    if (args.type === "text" && !args.text) {
      badRequest("content_text is required for text messages");
    }
    const isMediaKind = (MEDIA_KINDS as readonly string[]).includes(args.type);
    if (isMediaKind && !args.mediaUrl) {
      badRequest("media_url is required for media messages");
    }
    if (args.type === "template" && !args.template?.name) {
      badRequest("template.name is required for template messages");
    }
    if (args.type === "interactive" && !args.interactive) {
      badRequest("interactive payload is required for interactive messages");
    }
    if (!isValidE164(normalizePhone(args.to))) {
      badRequest("'to' must be a valid phone number in E.164 format (e.g. +14155550123)");
    }

    const { contactId, created: contactCreated } = await ctx.runMutation(
      internal.contacts.findOrCreateByPhoneInternal,
      { accountId: key.accountId, phone: args.to, name: args.name },
    );
    const conversationId = await ctx.runMutation(
      internal.conversations.findOrCreateForContactInternal,
      { accountId: key.accountId, contactId },
    );
    const target = await ctx.runQuery(internal.conversations.resolveSendTarget, {
      accountId: key.accountId,
      conversationId,
      replyToMessageId: args.replyToMessageId,
    });

    let whatsappMessageId: string;
    if (args.type === "text") {
      const result = await ctx.runAction(internal.metaSend.sendText, {
        accountId: key.accountId,
        conversationId,
        to: target.to,
        text: args.text!,
        contextMessageId: target.contextMessageId,
        senderType: "agent",
      });
      whatsappMessageId = result.whatsappMessageId;
    } else if (args.type === "template") {
      const result = await ctx.runAction(internal.metaSend.sendTemplate, {
        accountId: key.accountId,
        conversationId,
        to: target.to,
        templateName: args.template!.name,
        language: args.template!.language,
        params: args.template!.params,
        contextMessageId: target.contextMessageId,
        senderType: "agent",
      });
      whatsappMessageId = result.whatsappMessageId;
    } else if (args.type === "interactive") {
      const result = await ctx.runAction(internal.metaSend.sendInteractive, {
        accountId: key.accountId,
        conversationId,
        to: target.to,
        payload: args.interactive,
        contextMessageId: target.contextMessageId,
        senderType: "agent",
      });
      whatsappMessageId = result.whatsappMessageId;
    } else {
      const result = await ctx.runAction(internal.metaSend.sendMedia, {
        accountId: key.accountId,
        conversationId,
        to: target.to,
        kind: args.type as "image" | "video" | "document" | "audio",
        link: args.mediaUrl!,
        caption: args.text,
        filename: args.filename,
        contextMessageId: target.contextMessageId,
        senderType: "agent",
      });
      whatsappMessageId = result.whatsappMessageId;
    }

    const message = await ctx.runQuery(internal.messages.latestForConversationInternal, {
      accountId: key.accountId,
      conversationId,
    });

    return {
      messageId: message?._id ?? null,
      whatsappMessageId,
      conversationId,
      contactId,
      contactCreated,
    };
  },
});

// ---- broadcasts -------------------------------------------------------

const MAX_BROADCAST_RECIPIENTS = 1000;
// Mirrors `convex/broadcasts.ts`'s own private `DELIVER_STAGGER_MS` —
// duplicated (not imported/exported) since it's an implementation detail
// of that file's `send` action; see this file's header on the general
// "small helpers are duplicated per-file" convention.
const DELIVER_STAGGER_MS = 100;

export const createBroadcast = action({
  args: {
    keyHash: v.string(),
    name: v.optional(v.string()),
    templateName: v.string(),
    templateLanguage: v.optional(v.string()),
    recipients: v.array(
      v.object({ to: v.string(), params: v.optional(v.array(v.string())) }),
    ),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    broadcastId: Id<"broadcasts">;
    totalRecipients: number;
    rejected: number;
  }> => {
    const key = await requireScopeAction(ctx, args.keyHash, "broadcasts:send");

    if (!args.templateName) badRequest("'template_name' is required");
    if (args.recipients.length === 0) {
      badRequest("'recipients' must be a non-empty array of { to, params? }");
    }
    if (args.recipients.length > MAX_BROADCAST_RECIPIENTS) {
      badRequest(
        `A broadcast is capped at ${MAX_BROADCAST_RECIPIENTS} recipients per request; split larger sends`,
      );
    }

    const templateLanguage = args.templateLanguage || "en_US";

    let rejected = 0;
    const resolved: { contactId: Id<"contacts">; params: string[] | undefined }[] = [];
    for (const recipient of args.recipients) {
      if (!isValidE164(normalizePhone(recipient.to))) {
        rejected++;
        continue;
      }
      const { contactId } = await ctx.runMutation(
        internal.contacts.findOrCreateByPhoneInternal,
        { accountId: key.accountId, phone: recipient.to },
      );
      resolved.push({ contactId, params: recipient.params });
    }

    // Collapse recipients that resolved to the SAME contact, keeping the
    // first occurrence — mirrors `src/lib/whatsapp/broadcast-core.ts`'s
    // own dedupe (a caller listing the same phone twice, or two numbers
    // matching one contact, must be messaged once).
    const seen = new Set<Id<"contacts">>();
    const deduped: { contactId: Id<"contacts">; params: string[] | undefined }[] = [];
    for (const r of resolved) {
      if (seen.has(r.contactId)) continue;
      seen.add(r.contactId);
      deduped.push(r);
    }

    if (deduped.length === 0) {
      badRequest("No recipients had a valid E.164 phone number");
    }

    // KNOWN GAP (see the Phase 8 Task 5 report): the existing delivery
    // engine (`broadcasts.deliverOne`) only supports ONE shared
    // `templateVariables` array applied to every recipient — there is no
    // per-recipient personalization slot on `broadcastRecipients` yet.
    // Only use recipient params when every recipient that specified any
    // agrees on the exact same array; otherwise silently sending
    // recipient A's params to recipient B would be a real correctness
    // bug, so personalization is dropped rather than risk that.
    const distinctParams = new Set(
      deduped
        .map((r) => (r.params ? JSON.stringify(r.params) : null))
        .filter((p): p is string => p !== null),
    );
    const templateVariables =
      distinctParams.size === 1 ? deduped.find((r) => r.params)?.params : undefined;

    const broadcastId: Id<"broadcasts"> = await ctx.runMutation(
      internal.broadcasts.createInternal,
      {
        accountId: key.accountId,
        name: args.name || `API broadcast (${args.templateName})`,
        templateName: args.templateName,
        templateLanguage,
        contactIds: deduped.map((r) => r.contactId),
        templateVariables,
      },
    );

    // Trigger delivery immediately — reuses the exact same fan-out
    // `broadcasts.send` (the dashboard-authed action) uses, minus the
    // session-derived auth step (already done above via the API key).
    const pendingRecipientIds = await ctx.runMutation(
      internal.broadcasts.startSendingInternal,
      { accountId: key.accountId, broadcastId },
    );
    for (const [i, recipientId] of pendingRecipientIds.entries()) {
      await ctx.scheduler.runAfter(i * DELIVER_STAGGER_MS, internal.broadcasts.deliverOne, {
        accountId: key.accountId,
        recipientId,
      });
    }

    return { broadcastId, totalRecipients: deduped.length, rejected };
  },
});

export const getBroadcast = query({
  args: { keyHash: v.string(), broadcastId: v.string() },
  handler: async (ctx, args) => {
    const key = await requireScope(ctx, args.keyHash, "broadcasts:send");
    const id = ctx.db.normalizeId("broadcasts", args.broadcastId);
    const broadcast = id ? await ctx.db.get(id) : null;
    if (!broadcast || broadcast.accountId !== key.accountId) return null;
    return broadcast;
  },
});

// ---- webhooks ----------------------------------------------------------

// Duplicated from `src/lib/webhooks/events.ts`/`src/lib/webhooks/
// endpoints.ts`'s `normalizeWebhookUrl` rather than imported — Convex
// bundles `convex/` separately from `src/` (see `convex/lib/phone.ts`'s
// header for the same constraint), so a cross-directory import isn't
// available here.
const WEBHOOK_EVENTS = [
  "message.received",
  "message.status_updated",
  "conversation.created",
] as const;

function normalizeWebhookUrl(input: string): string | null {
  try {
    const u = new URL(input.trim());
    if (u.protocol !== "https:") return null;
    return u.toString();
  } catch {
    return null;
  }
}

function normalizeWebhookEvents(input: string[]): string[] | null {
  if (input.length === 0) return null;
  const out: string[] = [];
  for (const entry of input) {
    if (!(WEBHOOK_EVENTS as readonly string[]).includes(entry)) return null;
    if (!out.includes(entry)) out.push(entry);
  }
  return out;
}

const WEBHOOK_SECRET_PREFIX = "whsec_";
const BASE64URL_CHARS =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

// Manual 3-bytes-in/4-chars-out base64url loop — `btoa`/`Buffer` aren't
// assumed available in Convex's default runtime; byte-for-byte the same
// approach as `convex/lib/apiKey.ts`'s own (unexported) `bytesToBase64Url`,
// duplicated here rather than imported per that file's own convention.
function bytesToBase64Url(bytes: Uint8Array): string {
  let result = "";
  let i = 0;
  for (; i + 3 <= bytes.length; i += 3) {
    const chunk = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    result += BASE64URL_CHARS[(chunk >> 18) & 0x3f];
    result += BASE64URL_CHARS[(chunk >> 12) & 0x3f];
    result += BASE64URL_CHARS[(chunk >> 6) & 0x3f];
    result += BASE64URL_CHARS[chunk & 0x3f];
  }
  const remaining = bytes.length - i;
  if (remaining === 1) {
    const chunk = bytes[i]! << 16;
    result += BASE64URL_CHARS[(chunk >> 18) & 0x3f];
    result += BASE64URL_CHARS[(chunk >> 12) & 0x3f];
  } else if (remaining === 2) {
    const chunk = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    result += BASE64URL_CHARS[(chunk >> 18) & 0x3f];
    result += BASE64URL_CHARS[(chunk >> 12) & 0x3f];
    result += BASE64URL_CHARS[(chunk >> 6) & 0x3f];
  }
  return result;
}

function generateWebhookSecretPlaintext(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `${WEBHOOK_SECRET_PREFIX}${bytesToBase64Url(bytes)}`;
}

export const listWebhooks = query({
  args: { keyHash: v.string() },
  handler: async (ctx, args) => {
    const key = await requireScope(ctx, args.keyHash, "webhooks:manage");
    return await ctx.db
      .query("webhookEndpoints")
      .withIndex("by_account", (q) => q.eq("accountId", key.accountId))
      .order("desc")
      .collect();
  },
});

/**
 * Single-endpoint read by id — the backing function for
 * `GET /api/v1/webhooks/{id}` (not itself named in the task brief's op
 * list, which only calls out list/create/update/delete, but needed for
 * parity with that pre-existing REST route — see the Phase 8 Task 5
 * report). Mirrors `getBroadcast`'s shape exactly.
 */
export const getWebhook = query({
  args: { keyHash: v.string(), endpointId: v.string() },
  handler: async (ctx, args) => {
    const key = await requireScope(ctx, args.keyHash, "webhooks:manage");
    const id = ctx.db.normalizeId("webhookEndpoints", args.endpointId);
    const endpoint = id ? await ctx.db.get(id) : null;
    if (!endpoint || endpoint.accountId !== key.accountId) return null;
    return endpoint;
  },
});

/**
 * Generates + AES-256-GCM-encrypts (`convex/lib/whatsappEncryption.ts`'s
 * `encrypt`, Web-Crypto based) the signing secret INLINE — unlike the old
 * Supabase route (which generated + encrypted Node-side before the
 * insert), this migration keeps the whole op, secret included, in one
 * Convex call, matching every other write in this file. Returns the
 * PLAINTEXT secret exactly once, same one-time-reveal contract as
 * `apiKeys.create`'s own key plaintext.
 */
export const createWebhook = mutation({
  args: { keyHash: v.string(), url: v.string(), events: v.array(v.string()) },
  handler: async (ctx, args) => {
    const key = await requireScope(ctx, args.keyHash, "webhooks:manage");

    const url = normalizeWebhookUrl(args.url);
    if (!url) badRequest("'url' must be a valid https:// URL");
    const events = normalizeWebhookEvents(args.events);
    if (!events) badRequest("'events' must be a non-empty array of known event names");

    const secret = generateWebhookSecretPlaintext();
    const encryptedSecret = await encrypt(secret);

    const endpointId = await ctx.db.insert("webhookEndpoints", {
      accountId: key.accountId,
      createdByUserId: key.createdByUserId,
      url,
      secret: encryptedSecret,
      events,
      isActive: true,
      failureCount: 0,
    });

    const doc = (await ctx.db.get(endpointId))!;
    return { ...doc, secret };
  },
});

export const updateWebhook = mutation({
  args: {
    keyHash: v.string(),
    endpointId: v.string(),
    url: v.optional(v.string()),
    events: v.optional(v.array(v.string())),
    isActive: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const key = await requireScope(ctx, args.keyHash, "webhooks:manage");
    const id = ctx.db.normalizeId("webhookEndpoints", args.endpointId);
    const endpoint = id ? await ctx.db.get(id) : null;
    if (!endpoint || endpoint.accountId !== key.accountId) return null;

    const patch: Partial<{
      url: string;
      events: string[];
      isActive: boolean;
      failureCount: number;
    }> = {};
    if (args.url !== undefined) {
      const url = normalizeWebhookUrl(args.url);
      if (!url) badRequest("'url' must be a valid https:// URL");
      patch.url = url;
    }
    if (args.events !== undefined) {
      const events = normalizeWebhookEvents(args.events);
      if (!events) badRequest("'events' must be a non-empty array of known event names");
      patch.events = events;
    }
    if (args.isActive !== undefined) {
      patch.isActive = args.isActive;
      // Re-enabling a disabled endpoint clears its failure streak so
      // it isn't instantly re-disabled by a single stale failure —
      // mirrors the pre-migration Postgres route's own behavior.
      if (args.isActive) patch.failureCount = 0;
    }

    if (Object.keys(patch).length > 0) {
      await ctx.db.patch(endpoint._id, patch);
    }
    return await ctx.db.get(endpoint._id);
  },
});

export const deleteWebhook = mutation({
  args: { keyHash: v.string(), endpointId: v.string() },
  handler: async (ctx, args) => {
    const key = await requireScope(ctx, args.keyHash, "webhooks:manage");
    const id = ctx.db.normalizeId("webhookEndpoints", args.endpointId);
    const endpoint = id ? await ctx.db.get(id) : null;
    if (!endpoint || endpoint.accountId !== key.accountId) return null;
    await ctx.db.delete(endpoint._id);
    return { id: endpoint._id };
  },
});

// ---- me ------------------------------------------------------------

/** No required scope — any live key (even with zero scopes) can call
 * `GET /api/v1/me` to verify itself, per `docs/public-api.md`. */
export const getMe = query({
  args: { keyHash: v.string() },
  handler: async (ctx, args) => {
    const key = await loadActiveApiKey(ctx, args.keyHash);
    if (!key) throw new ConvexError({ code: "UNAUTHORIZED" });
    const account = await ctx.db.get(key.accountId);
    return {
      accountId: key.accountId,
      accountName: account?.name ?? null,
      keyId: key._id,
      scopes: key.scopes,
    };
  },
});
