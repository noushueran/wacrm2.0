import { accountMutation, accountQuery } from "./lib/auth";
import { internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { v, ConvexError } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { requireConversationAccess } from "./lib/conversationAccess";
import { loadEnabledConfig, recordOutboundSend } from "./lib/qualification/track";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { AdReferral } from "./lib/whatsapp/webhookParse";
import { hourStartMs, HOUR_MS } from "./lib/messageStats";

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
// field in either public args validator below). The PUBLIC read/write
// paths (`listByConversation`/`append`) gate on the role-aware
// `requireConversationAccess` (`convex/lib/conversationAccess.ts`) —
// "view" to read, "own" to write — not on `requireOwnConversation`
// below, which is a plainer account-tenancy-only check now used only
// by the internal (no-user-session) paths; see that function's own
// doc comment.
// ============================================================

/**
 * Loads a conversation and throws `NOT_FOUND` unless it belongs to
 * `accountId` — the same error for "doesn't exist" and "exists but
 * isn't yours" on purpose (mirrors `contacts.ts`'s `requireOwnContact`
 * and `conversations.ts`'s `get`), so a cross-account probe can't
 * distinguish the two. Account-tenancy only — unlike
 * `requireConversationAccess`, it has no role/mode awareness at all.
 *
 * Guards only the INTERNAL paths below that have no user session to
 * derive a role from — `appendInternal` and
 * `latestForConversationInternal` — since the PUBLIC
 * `listByConversation`/`append` moved onto the role-aware
 * `requireConversationAccess` ("view"/"own") once per-conversation
 * access shipped. Kept (rather than deleted) because those two
 * internal callers still only need the plain "same account" check —
 * neither has a caller role to apply "view" vs "own" against.
 *
 * Takes `accountId` as an explicit parameter (not read off `ctx`) so
 * the SAME check serves both remaining callers: `appendInternal`
 * passes its caller-supplied `args.accountId`, and
 * `latestForConversationInternal` does the same — neither has a user
 * session, and therefore no `ctx.accountId`, being an
 * `internalMutation`/`internalQuery`. Typed to accept any ctx with a
 * `db` (only `db.get` is used), same treatment as `contacts.ts`'s
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
    | "interactive"
    | "contacts";
  contentText?: string;
  mediaUrl?: string;
  /** R2 object key for this message's media — the durable replacement
   *  for `mediaUrl` (`schema.ts`'s `messages.mediaKey`). Currently
   *  threaded through only by `metaSend.sendMedia`'s `appendInternal`
   *  call (composer attachment / agent voice note / flow send); every
   *  other caller of this shared insert core simply never has one to
   *  pass, which is why this stays optional rather than required. */
  mediaKey?: string;
  templateName?: string;
  messageId?: string;
  interactivePayload?: unknown;
  /** Outbound contact cards (`contentType === "contacts"`): the Cloud API
   *  `contacts` array we sent, rendered by the inbox as a card bubble. */
  contactsPayload?: unknown;
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
  /** Click-to-WhatsApp ad referral (inbound-only), stored verbatim on the
   *  message row. `storedImageKey` is filled later (Task 3 originally
   *  wrote `storedImageUrl`; R2-migration Task 7 cut it over to a key —
   *  see `setAdReferralImage`). */
  referral?: AdReferral;
  /** Internal id of the message this one replies to (WhatsApp quoted reply).
   *  Outbound: the agent's reply target, threaded from `send`/`metaSend`.
   *  Inbound: resolved from the webhook's `context.id` in `ingest`. The
   *  inbox reads it back as `reply_to_message_id` to render the quote. */
  replyToMessageId?: Id<"messages">;
}

/**
 * Fold one message into the account's hourly rollup, the read-bounded
 * source for the dashboard's messages-per-day chart (see
 * `lib/messageStats.ts` and the `messageHourlyStats` comment in schema.ts).
 *
 * PATCHes an open bucket rather than inserting per message — a row per
 * message would just reproduce the unbounded read this exists to remove.
 *
 * Keyed off `Date.now()` rather than the row's `_creationTime`, which is
 * not known until after the insert and would cost a read-back to obtain.
 * The two differ by microseconds; the only way that matters is a message
 * landing within a hair of an hour boundary, which misplaces that single
 * message by one hour in the chart.
 */
async function recordMessageInHourlyStats(
  ctx: { db: MutationCtx["db"] },
  accountId: Id<"accounts">,
  senderType: AppendMessageArgs["senderType"],
): Promise<void> {
  const bucketStart = hourStartMs(Date.now());
  // `senderType === "customer"` is inbound; agent and bot are both
  // outgoing, matching what the chart counted when it read raw messages.
  const inbound = senderType === "customer";

  const existing = await ctx.db
    .query("messageHourlyStats")
    .withIndex("by_account_hour", (q) =>
      q.eq("accountId", accountId).eq("hourStartMs", bucketStart),
    )
    .unique();

  if (existing) {
    await ctx.db.patch(existing._id, {
      incoming: existing.incoming + (inbound ? 1 : 0),
      outgoing: existing.outgoing + (inbound ? 0 : 1),
    });
    return;
  }

  await ctx.db.insert("messageHourlyStats", {
    accountId,
    hourStartMs: bucketStart,
    incoming: inbound ? 1 : 0,
    outgoing: inbound ? 0 : 1,
  });
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
    mediaKey,
    templateName,
    messageId,
    interactivePayload,
    contactsPayload,
    interactiveReplyId,
    aiGenerated,
    referral,
    replyToMessageId,
  } = args;

  const newMessageId = await ctx.db.insert("messages", {
    accountId,
    conversationId,
    senderType,
    contentType,
    contentText,
    mediaUrl,
    mediaKey,
    templateName,
    messageId,
    interactivePayload,
    contactsPayload,
    interactiveReplyId,
    aiGenerated,
    referral,
    replyToMessageId,
    status: "sent",
  });

  // Maintained here because this is the single `insert("messages")` in the
  // backend — every path funnels through it, so the rollup cannot drift
  // from the raw rows unless a second insert site is added without one.
  await recordMessageInHourlyStats(ctx, accountId, senderType);

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
    await requireConversationAccess(ctx, args.conversationId, "view");

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
      v.literal("contacts"),
    ),
    contentText: v.optional(v.string()),
    mediaUrl: v.optional(v.string()),
    templateName: v.optional(v.string()),
    messageId: v.optional(v.string()),
    interactivePayload: v.optional(v.any()),
    contactsPayload: v.optional(v.any()),
    interactiveReplyId: v.optional(v.string()),
    aiGenerated: v.optional(v.boolean()),
    replyToMessageId: v.optional(v.id("messages")),
  },
  handler: async (ctx, args) => {
    ctx.requireRole("agent");
    const conversation = await requireConversationAccess(
      ctx,
      args.conversationId,
      "own",
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
      v.literal("contacts"),
    ),
    contentText: v.optional(v.string()),
    mediaUrl: v.optional(v.string()),
    // R2 object key for this message's media, dual-written alongside
    // `mediaUrl` — see `AppendMessageArgs.mediaKey`'s own doc comment
    // above for which callers actually supply one.
    mediaKey: v.optional(v.string()),
    templateName: v.optional(v.string()),
    messageId: v.optional(v.string()),
    interactivePayload: v.optional(v.any()),
    contactsPayload: v.optional(v.any()),
    interactiveReplyId: v.optional(v.string()),
    aiGenerated: v.optional(v.boolean()),
    replyToMessageId: v.optional(v.id("messages")),
  },
  handler: async (ctx, args) => {
    const conversation = await requireOwnConversation(
      ctx,
      args.accountId,
      args.conversationId,
    );
    const result = await insertMessageAndUpdateConversation(ctx, args, conversation);

    // Qualification P0 (spec §6): every outbound send — inbox agent
    // send, automations, flows, broadcasts, AI replies, REST v1 — flows
    // through this one persist step, so this is THE outbound tracking
    // hook. try/catch: a tracking bug must never fail a send that
    // already went out to Meta. Inbound rows persist via
    // `ingest.ingestInbound` (never here), but guard on senderType
    // anyway since this validator also admits "customer".
    if (args.senderType === "agent" || args.senderType === "bot") {
      try {
        const config = await loadEnabledConfig(ctx, args.accountId);
        if (config) {
          await recordOutboundSend(ctx, {
            accountId: args.accountId,
            conversationId: args.conversationId,
            senderType: args.senderType,
            now: Date.now(),
            config,
          });
        }
      } catch (err) {
        console.error("[qualification] outbound tracking failed:", err);
      }
    }
    return result;
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
/**
 * The newest message in `conversationId` (scoped to `accountId`) — used
 * by `convex/apiV1.ts`'s `sendMessage` action to recover the persisted
 * `messages` row `metaSend.*`'s send actions just inserted via
 * `appendInternal` (those actions return only `{whatsappMessageId}`, not
 * the new row's own `_id`, and the public REST send endpoint's response
 * needs BOTH). Reads the same `by_conversation` index + `.order("desc")`
 * as `listByConversation` above, so "newest" here means the same thing
 * it means there. Relies on nothing else concurrently inserting into
 * this exact conversation between the send and this read — true for the
 * single request/response cycle `sendMessage` uses this in.
 */
export const latestForConversationInternal = internalQuery({
  args: { accountId: v.id("accounts"), conversationId: v.id("conversations") },
  handler: async (ctx, args) => {
    await requireOwnConversation(ctx, args.accountId, args.conversationId);
    return await ctx.db
      .query("messages")
      .withIndex("by_conversation", (q) =>
        q.eq("conversationId", args.conversationId),
      )
      .order("desc")
      .first();
  },
});

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

/**
 * Attach a resolved R2 object key to an already-persisted message — the
 * second half of inbound-media resolution. `ingest.processInbound`
 * inserts an inbound media message with no `mediaKey`/`mediaUrl` (the
 * webhook carries only Meta's raw `mediaId`, and turning that into
 * fetchable bytes needs a signed Graph call an action must make), then
 * calls `whatsappConfig.resolveInboundMedia` to download the bytes and
 * PUT them to Cloudflare R2, then calls this to attach the resulting key
 * so the inbox can play/show the media. Split out (rather than folded
 * into `ingestInbound`) precisely because that resolution is async
 * network I/O that can't run inside the insert mutation. No-op if the
 * message was deleted between insert and patch.
 *
 * R2-migration cutover (Task 7): this used to be `setMediaUrl`, taking an
 * already-resolved URL and patching `mediaUrl`. Renamed rather than kept
 * alongside a new key-writing sibling — `ingest.ts`'s inbound-media block
 * is its ONLY caller (confirmed by grep), and that caller now has a key,
 * not a URL, to give it (`resolveInboundMedia` itself stopped resolving
 * one). Readers still fall back to the legacy `mediaUrl` column for
 * pre-cutover rows (`convex/lib/r2/url.ts`'s `resolveMediaUrl`, Task 5) —
 * this mutation itself never writes that column anymore.
 */
export const setMediaKey = internalMutation({
  args: { messageId: v.id("messages"), mediaKey: v.string() },
  handler: async (ctx, args) => {
    const message = await ctx.db.get(args.messageId);
    if (!message) return;
    await ctx.db.patch(args.messageId, { mediaKey: args.mediaKey });
  },
});

/** Attach the R2 object key of a downloaded ad image to the message's OWN
 *  `referral` — every ad message records its own stored image key,
 *  unconditionally. Best-effort partner to `ingest.processInbound`'s
 *  ad-image step.
 *
 *  R2-migration cutover (Task 7): takes `storedImageKey`, not a
 *  pre-resolved `storedImageUrl` — `ingest.ts`'s caller now hands this
 *  mutation the raw key `files.storeFromUrl` returned, with no
 *  `publicUrl`/`r2ConfigFromEnv` resolution in between (that used to
 *  happen in `ingest.ts` itself). The inbox resolves
 *  `referral.storedImageKey ?? referral.storedImageUrl` lazily, at
 *  render time (`src/lib/convex/adapters.ts`'s `toUiMessage`, Task 5).
 *
 *  DROPPED as part of this same cutover: the second, CONVERSATION-level
 *  patch this mutation used to also make (hence the `conversationId` arg
 *  it used to take), pinning the same resolved URL onto
 *  `conversation.adReferral.storedImageUrl` (set-once, "first ad wins" —
 *  mirroring `ingestInbound`'s own pin for the rest of that denorm's
 *  fields). `conversations.adReferral` has no `storedImageKey`
 *  counterpart in the schema (`schema.ts`'s R2-migration additions only
 *  ever covered `messages.mediaKey` / `messages.referral.storedImageKey`
 *  — see the design spec's "Schema changes" table) — so keeping that
 *  second write alive would mean resolving a URL from the key again
 *  right here, reintroducing inside a mutation the exact eager
 *  R2-config-at-write-time dependency this whole task exists to retire,
 *  in service of a field that (confirmed by grep across `src/`) no
 *  reader ever consumes: `conversation.adReferral` is read for its own
 *  presence (the inbox's ad-lead badge) and `startedAt` (the 72h timer)
 *  only — `AdReferralCard`, the one place an ad image actually renders,
 *  takes the MESSAGE-level `referral` this function still patches, never
 *  the conversation-level denorm. If a future feature needs to render
 *  the conversation-level echo, it should add a proper `storedImageKey`
 *  field to `conversations.adReferral` in `schema.ts` rather than revive
 *  eager URL resolution here. */
export const setAdReferralImage = internalMutation({
  args: {
    messageId: v.id("messages"),
    storedImageKey: v.string(),
  },
  handler: async (ctx, args) => {
    const message = await ctx.db.get(args.messageId);
    if (message?.referral) {
      await ctx.db.patch(args.messageId, {
        referral: { ...message.referral, storedImageKey: args.storedImageKey },
      });
    }
  },
});

// ============================================================
// One-shot backfill for `messageHourlyStats`.
//
// The rollup is maintained going forward by
// `recordMessageInHourlyStats`, so without this the dashboard chart is
// simply empty for everything that happened before deploy. Run manually:
//
//   npx convex run messages:backfillMessageHourlyStats
//
// Batched, because `messages` is the largest table in the schema and a
// `.collect()` over it is the very thing this whole change exists to
// avoid — it reschedules itself until every account is done.
//
// IDEMPOTENT, by rebuilding whole hours rather than incrementing: each
// pass SETS a bucket to the count it just measured. A batch that ends
// mid-hour drops that partial hour and rewinds the cursor to its start, so
// the hour is only ever written once it has been seen in full. Re-running
// the whole backfill therefore converges on the same numbers instead of
// doubling them, which an increment-based version would not.
// ============================================================

/** Messages read per batch. Comfortably under the 4096 read limit while
 *  leaving room for the bucket upserts in the same mutation. */
const BACKFILL_BATCH = 500;

export const backfillMessageHourlyStats = internalMutation({
  args: {
    // Absent = start at the first account. Threaded by the self-schedule.
    accountId: v.optional(v.id("accounts")),
    cursorMs: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<void> => {
    const accounts = await ctx.db.query("accounts").collect();
    if (accounts.length === 0) return;

    const index = args.accountId
      ? accounts.findIndex((a) => a._id === args.accountId)
      : 0;
    if (index < 0) return; // account vanished mid-backfill; nothing to resume
    const account = accounts[index]!;

    const advanceToNextAccount = async () => {
      const next = accounts[index + 1];
      if (!next) return; // all accounts done
      await ctx.scheduler.runAfter(0, internal.messages.backfillMessageHourlyStats, {
        accountId: next._id,
      });
    };

    const batch = await ctx.db
      .query("messages")
      .withIndex("by_account", (q) =>
        args.cursorMs === undefined
          ? q.eq("accountId", account._id)
          : q.eq("accountId", account._id).gte("_creationTime", args.cursorMs),
      )
      .take(BACKFILL_BATCH);

    if (batch.length === 0) {
      await advanceToNextAccount();
      return;
    }

    // Group this batch into hour buckets.
    const hours = new Map<number, { incoming: number; outgoing: number }>();
    for (const m of batch) {
      const key = hourStartMs(m._creationTime);
      const bucket = hours.get(key) ?? { incoming: 0, outgoing: 0 };
      if (m.senderType === "customer") bucket.incoming += 1;
      else bucket.outgoing += 1;
      hours.set(key, bucket);
    }

    const sortedHours = [...hours.keys()].sort((a, b) => a - b);
    const isFullBatch = batch.length === BACKFILL_BATCH;

    // A full batch almost certainly stops mid-hour. Withhold that last
    // hour and resume from its start so it gets written only once it has
    // been observed end-to-end — that is what keeps SET idempotent.
    //
    // Unless the whole batch is ONE hour: withholding it would rewind the
    // cursor to where it already is and loop forever. That needs >500
    // messages in a single hour (>12k/day) — far beyond this deployment —
    // so it is handled by writing what was measured and stepping past the
    // hour, with a warning, rather than by growing the batch unboundedly.
    const singleHourOverflow = isFullBatch && sortedHours.length === 1;
    const hoursToWrite =
      isFullBatch && !singleHourOverflow ? sortedHours.slice(0, -1) : sortedHours;

    if (singleHourOverflow) {
      console.warn(
        `[backfill] account ${account._id}: hour ${new Date(sortedHours[0]!).toISOString()} has more than ${BACKFILL_BATCH} messages; its chart bucket may undercount`,
      );
    }

    for (const hour of hoursToWrite) {
      const totals = hours.get(hour)!;
      const existing = await ctx.db
        .query("messageHourlyStats")
        .withIndex("by_account_hour", (q) =>
          q.eq("accountId", account._id).eq("hourStartMs", hour),
        )
        .unique();
      if (existing) await ctx.db.patch(existing._id, totals);
      else
        await ctx.db.insert("messageHourlyStats", {
          accountId: account._id,
          hourStartMs: hour,
          ...totals,
        });
    }

    if (!isFullBatch) {
      await advanceToNextAccount();
      return;
    }

    const nextCursor = singleHourOverflow
      ? sortedHours[0]! + HOUR_MS // step past the oversized hour
      : sortedHours[sortedHours.length - 1]!; // rewind to the withheld hour
    await ctx.scheduler.runAfter(0, internal.messages.backfillMessageHourlyStats, {
      accountId: account._id,
      cursorMs: nextCursor,
    });
  },
});
