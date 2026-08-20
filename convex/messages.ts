import { accountMutation, accountQuery } from "./lib/auth";
import { internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { v, ConvexError } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { requireConversationAccess } from "./lib/conversationAccess";
import { loadEnabledConfig, recordOutboundSend } from "./lib/qualification/track";
import { armOnOutbound } from "./leadAnalysisEngine";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { AdReferral } from "./lib/whatsapp/webhookParse";
import { FEP_WINDOW_MS } from "./lib/whatsapp/messagingWindow";
import { hourStartMs, HOUR_MS, utcDayStartMs, DAY_MS } from "./lib/messageStats";
import {
  responseBucketFor,
  addResponseBucket,
  emptyResponseBuckets,
  pricingCategoryKey,
  addPricingCategory,
  type PricingCategoryKey,
} from "./lib/reportStats";
import { unarchiveOnInboundCore } from "./conversations";

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

/**
 * +1 on one conversation counter in the account's hourly rollup — the
 * `conversationsStarted`/`conversationsStartedAd` half of the reports
 * rollup (docs/superpowers/specs/2026-08-05-reports-section-design.md,
 * the `messageHourlyStats` comment in schema.ts).
 *
 * `atMs` is the CONVERSATION's creation instant, not "now": the ad-sourced
 * counter is written when a referral is recorded, which happens after the
 * conversation row already exists (`adReferrals.recordAdReferral`), so it
 * usually patches an hour in the past. That is the same shape
 * `recordResponseSample` above uses and, like it, still a single point
 * lookup on `by_account_hour`. `conversationsStarted` itself is the
 * exception — `conversations.insertConversation` calls this with
 * `Date.now()`, since there the conversation IS just being created.
 *
 * `incoming`/`outgoing` are seeded to 0 on insert because the schema
 * requires them — this may be the first write to the hour, ahead of any
 * message.
 */
export async function bumpConversationStartedStat(
  ctx: { db: MutationCtx["db"] },
  accountId: Id<"accounts">,
  atMs: number,
  field: "conversationsStarted" | "conversationsStartedAd",
): Promise<void> {
  const bucketStart = hourStartMs(atMs);
  const existing = await ctx.db
    .query("messageHourlyStats")
    .withIndex("by_account_hour", (q) =>
      q.eq("accountId", accountId).eq("hourStartMs", bucketStart),
    )
    .unique();

  if (existing) {
    await ctx.db.patch(existing._id, {
      [field]: (existing[field] ?? 0) + 1,
    });
    return;
  }

  await ctx.db.insert("messageHourlyStats", {
    accountId,
    hourStartMs: bucketStart,
    incoming: 0,
    outgoing: 0,
    [field]: 1,
  });
}

/**
 * +1 on `activeConversations` for the hour containing `atMs`.
 *
 * Called only when the caller has established this conversation has not yet
 * been counted for this UTC day — the caller owns the dedup, this function
 * owns the write, exactly like `bumpConversationStartedStat`.
 *
 * `incoming`/`outgoing` are seeded to 0 on insert to satisfy the schema, not
 * because this can be the hour's first write. The bucket almost always
 * exists already: this function's only caller,
 * `insertMessageAndUpdateConversation`, calls `recordMessageInHourlyStats`
 * first, in the same transaction, which unconditionally creates or patches
 * this exact hour's row. It is upserted rather than assumed for the same
 * hairline reason `recordResponseSample` is (see its own comment) — both
 * key off independent `Date.now()` calls a few lines apart, so a message
 * landing within microseconds of an hour boundary could in principle see
 * the two land in adjacent hours. The insert branch is kept in this shape
 * anyway, matching `bumpConversationStartedStat`, because
 * `backfillActiveConversationStats` below needs the identical
 * lookup-or-insert pattern for a rollup row that, during a backfill, may
 * genuinely not exist yet.
 */
async function bumpActiveConversationStat(
  ctx: { db: MutationCtx["db"] },
  accountId: Id<"accounts">,
  atMs: number,
): Promise<void> {
  const bucketStart = hourStartMs(atMs);
  const existing = await ctx.db
    .query("messageHourlyStats")
    .withIndex("by_account_hour", (q) =>
      q.eq("accountId", accountId).eq("hourStartMs", bucketStart),
    )
    .unique();

  if (existing) {
    await ctx.db.patch(existing._id, {
      activeConversations: (existing.activeConversations ?? 0) + 1,
    });
    return;
  }

  await ctx.db.insert("messageHourlyStats", {
    accountId,
    hourStartMs: bucketStart,
    incoming: 0,
    outgoing: 0,
    activeConversations: 1,
  });
}

/** +1 on one billing category, in the hour the MESSAGE was created. */
async function bumpBilledMessageCategory(
  ctx: { db: MutationCtx["db"] },
  accountId: Id<"accounts">,
  messageAtMs: number,
  key: PricingCategoryKey,
): Promise<void> {
  const bucketStart = hourStartMs(messageAtMs);
  const existing = await ctx.db
    .query("messageHourlyStats")
    .withIndex("by_account_hour", (q) =>
      q.eq("accountId", accountId).eq("hourStartMs", bucketStart),
    )
    .unique();

  const next = addPricingCategory(existing?.billedMessagesByCategory, key);
  if (existing) {
    await ctx.db.patch(existing._id, { billedMessagesByCategory: next });
    return;
  }
  await ctx.db.insert("messageHourlyStats", {
    accountId,
    hourStartMs: bucketStart,
    incoming: 0,
    outgoing: 0,
    billedMessagesByCategory: next,
  });
}

/**
 * +1 Meta conversation window (and free-entry-point, when flagged), in the
 * hour the first message of that window was created.
 *
 * "Meta conversation", NOT "billable": the caller's branch fires on any
 * newly-seen `conversationMetaId` and applies no billability test, so a
 * free-entry-point window increments this too — `freeEntryPointConversations`
 * is a SUBSET of it, not a figure beside it. Reporting `metaConversations`
 * as a billable count would overstate Meta's charge by exactly the free
 * count; billable, if ever needed, is the difference. See
 * `messageHourlyStats.metaConversations` in schema.ts.
 */
async function bumpMetaConversationStats(
  ctx: { db: MutationCtx["db"] },
  accountId: Id<"accounts">,
  messageAtMs: number,
  isFreeEntryPoint: boolean,
): Promise<void> {
  const bucketStart = hourStartMs(messageAtMs);
  const existing = await ctx.db
    .query("messageHourlyStats")
    .withIndex("by_account_hour", (q) =>
      q.eq("accountId", accountId).eq("hourStartMs", bucketStart),
    )
    .unique();

  const fepDelta = isFreeEntryPoint ? 1 : 0;
  if (existing) {
    await ctx.db.patch(existing._id, {
      metaConversations: (existing.metaConversations ?? 0) + 1,
      freeEntryPointConversations:
        (existing.freeEntryPointConversations ?? 0) + fepDelta,
    });
    return;
  }
  await ctx.db.insert("messageHourlyStats", {
    accountId,
    hourStartMs: bucketStart,
    incoming: 0,
    outgoing: 0,
    metaConversations: 1,
    freeEntryPointConversations: fepDelta,
  });
}

/**
 * Also fills `responseBuckets`, the histogram the reports SLA panel reads.
 * It is written in the SAME patch as the sum and count, never separately —
 * a histogram that can disagree with the count beside it is a silently
 * wrong percentile, which is the failure this whole rollup exists to avoid.
 *
 * Add one reply-latency sample to the account's hourly rollup, the
 * read-bounded source for `dashboard.responseTime` (see
 * `lib/messageStats.ts` and the `messageHourlyStats` comment in schema.ts).
 *
 * Bucketed by `customerAtMs` — when the customer ASKED — not by when we
 * answered, because that is the axis the chart's bars are keyed on. So unlike
 * `recordMessageInHourlyStats` this usually patches an hour in the past: a
 * question that sat overnight lands on yesterday's bucket. It is still a
 * single point lookup on `by_account_hour`, so the cost is the same.
 *
 * The bucket almost always exists already — the customer's own message
 * created it via `recordMessageInHourlyStats` — but it is upserted rather
 * than assumed, since a message landing within microseconds of an hour
 * boundary can be counted in the adjacent hour (both functions key off
 * `Date.now()`, see the note above).
 */
async function recordResponseSample(
  ctx: { db: MutationCtx["db"] },
  accountId: Id<"accounts">,
  customerAtMs: number,
  respondedAtMs: number,
): Promise<void> {
  // Guard rather than trust the clock: `Date.now()` is not monotonic across
  // machines, and a negative latency would silently drag the average down.
  // The per-message implementation this replaces skipped such samples too.
  const elapsedMs = respondedAtMs - customerAtMs;
  if (elapsedMs < 0) return;

  const bucketStart = hourStartMs(customerAtMs);
  const existing = await ctx.db
    .query("messageHourlyStats")
    .withIndex("by_account_hour", (q) =>
      q.eq("accountId", accountId).eq("hourStartMs", bucketStart),
    )
    .unique();

  const bucketKey = responseBucketFor(elapsedMs);

  if (existing) {
    await ctx.db.patch(existing._id, {
      responseCount: (existing.responseCount ?? 0) + 1,
      responseTotalMs: (existing.responseTotalMs ?? 0) + elapsedMs,
      responseBuckets: addResponseBucket(existing.responseBuckets, bucketKey),
    });
    return;
  }

  await ctx.db.insert("messageHourlyStats", {
    accountId,
    hourStartMs: bucketStart,
    incoming: 0,
    outgoing: 0,
    responseCount: 1,
    responseTotalMs: elapsedMs,
    responseBuckets: addResponseBucket(undefined, bucketKey),
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

  const now = Date.now();

  // Distinct conversations with traffic, deduped per UTC DAY. The comparison
  // IS the dedup: a stored marker equal to today's UTC day means this thread
  // has already been counted, whatever else it does today.
  //
  // Deliberately per-day and not per-hour. Distinct counts are not additive
  // across buckets, so an hourly dedup summed into a day would count a thread
  // active at 09:00 and 15:00 twice — yielding conversation-HOURS, a figure
  // that can exceed the account's total conversation count.
  //
  // Costs nothing extra: `conversation` is already in hand, and
  // `lastActiveDayMs` rides the patch built below that already runs on every
  // message.
  const activeDay = utcDayStartMs(now);
  const alreadyCountedToday = conversation.lastActiveDayMs === activeDay;
  if (!alreadyCountedToday) {
    await bumpActiveConversationStat(ctx, accountId, now);
  }

  // Denormalized preview fields the Inbox list reads directly off
  // `conversations` (see `conversations.ts`'s `list`) so it never has
  // to join into `messages` just to render a snippet. `unreadCount`
  // only climbs for inbound (`"customer"`) messages — an agent/bot
  // message is one the account itself just sent, not one waiting to
  // be read.
  const patch: Partial<{
    lastMessageText: string;
    lastMessageAt: number;
    lastMessageSenderType: "customer" | "agent" | "bot";
    updatedAt: number;
    unreadCount: number;
    lastInboundAt: number;
    firstReplyAt: number;
    awaitingReply: boolean;
    snoozedUntil: number | undefined;
    snoozedByUserId: Id<"users"> | undefined;
    snoozedReason: string | undefined;
    chasingForcedAt: number | undefined;
    chasingForcedByUserId: Id<"users"> | undefined;
    pendingCustomerAtMs: number | undefined;
    lastActiveDayMs: number;
  }> = {
    lastMessageText: contentText ?? `[${contentType}]`,
    lastMessageAt: now,
    // Denormalised for `leadAnalysis.board`'s lane badge — same patch as
    // the other preview fields above, for the same reason: this is the
    // single insert site, so the copy cannot drift from the raw rows.
    lastMessageSenderType: senderType,
    updatedAt: now,
    // The Active/Waiting lane axis. Set here rather than at any call
    // site because this is the single `insert("messages")` in the
    // backend — the same reason `recordMessageInHourlyStats` and
    // `armOnOutbound` hook here. Unconditional, so no send path can
    // leave it stale.
    //
    // Nothing else is needed for the Chasing lane: Chasing is this same
    // `false` plus a RANGE on `lastMessageAt`, which the line above
    // already updates. That is the whole reason v3 has no mirror field
    // to keep in sync.
    awaitingReply: senderType === "customer",
    // Unconditional, like `awaitingReply` above and `snoozedUntil` below:
    // patching the same value over itself is free, and a guard here is one
    // more branch that can go stale.
    lastActiveDayMs: activeDay,
  };
  if (senderType === "customer") {
    patch.unreadCount = conversation.unreadCount + 1;
    // Anchor for Meta's 24h customer service window. `lastMessageAt`
    // cannot serve this — it also moves on outbound messages.
    patch.lastInboundAt = now;
    // A customer coming back outranks every filing decision an agent
    // made. Cleared HERE, in the message transaction, rather than in
    // `ingest`'s best-effort fan-out where `unarchiveOnInbound` lives:
    // that path swallows failures by design, so a swallowed failure
    // would leave a snoozed thread hidden while its customer is
    // actively writing into it. Same class of bug the lanes spec fixed
    // for `chasing`; do not "harmonise" this back to the fan-out.
    //
    // Unconditional rather than guarded on presence — patching
    // `undefined` over `undefined` is free, and a guard is one more
    // branch that can be wrong.
    patch.snoozedUntil = undefined;
    patch.snoozedByUserId = undefined;
    patch.snoozedReason = undefined;
    patch.chasingForcedAt = undefined;
    patch.chasingForcedByUserId = undefined;
    // Reply-latency pairing, inbound half. Set ONLY when nothing is already
    // pending, so a customer who messages three times in a row is one
    // sample timed from their FIRST message rather than three — the dedupe
    // rule `dashboard.responseTime` used to apply on every read. Distinct
    // from `lastInboundAt` above, which moves on every inbound by design.
    if (conversation.pendingCustomerAtMs === undefined) {
      patch.pendingCustomerAtMs = now;
    }
  } else if (
    conversation.adReferral &&
    conversation.firstReplyAt === undefined
  ) {
    // Anchor for the 72h free-entry-point ESTIMATE. Only meaningful on
    // an ad conversation, and only the FIRST reply after the referral —
    // `adReferral` is already set by the time this fires, so an outbound
    // that predates the ad click cannot claim this slot.
    patch.firstReplyAt = now;
  }

  // Reply-latency pairing, outbound half. Deliberately NOT folded into the
  // `else if` above, which fires only for the first reply on an ad
  // conversation: ANY outbound — agent or bot — answers the customer, which
  // is exactly how the per-message implementation counted it. Recorded
  // before the patch below so the sample and the cleared flag land in the
  // same transaction as the message itself.
  if (
    senderType !== "customer" &&
    conversation.pendingCustomerAtMs !== undefined
  ) {
    await recordResponseSample(
      ctx,
      accountId,
      conversation.pendingCustomerAtMs,
      now,
    );
    // `undefined` removes the field in Convex, restoring "nothing is waiting
    // on us" — the state a thread starts in.
    patch.pendingCustomerAtMs = undefined;
  }

  await ctx.db.patch(conversationId, patch);

  // Un-archive, IN THIS TRANSACTION (fix 2026-07-28). A customer writing
  // to us outranks every filing decision, and P2's spec said so — but
  // the shipped code only ran this from `ingest.ts`'s best-effort
  // fan-out, which swallows failures by design. A swallowed failure left
  // an archived customer invisible in every lane while they were
  // actively writing in, and nothing retried.
  //
  // Here it cannot fail independently of the message: either both land
  // or neither does, and neither-does means Meta retries the webhook.
  // See `unarchiveOnInboundCore`'s own comment for why that is the safe
  // direction. Do not move this back to the fan-out.
  if (senderType === "customer" && conversation.archivedAt !== undefined) {
    await unarchiveOnInboundCore(ctx, {
      accountId,
      conversationId,
      contactId: conversation.contactId,
    });
  }

  // Lead Analysis follow-up sequence (P3 Task 6, spec "Follow-up
  // sequence"): arm the sequence the instant we send and the customer
  // goes quiet. Hooked HERE rather than in `append`/`appendInternal`
  // separately because this is the single `insert("messages")` in the
  // backend (see the comment above) — the one place guaranteed to see
  // every agent/bot send regardless of which entry point it came
  // through. `conversation` is the PRE-patch doc read by the caller;
  // `archivedAt`/`lastInboundAt` are untouched by the `patch` above for
  // a non-customer sender, so reading them off it here is exact, not
  // stale. try/catch: an arming bug must never fail — or, since Convex
  // mutations are transactional, roll back — a message that is (or is
  // about to be) persisted as sent; mirrors `appendInternal`'s own
  // try/catch around `recordOutboundSend`.
  if (senderType !== "customer") {
    try {
      await armOnOutbound(ctx, {
        accountId,
        conversationId,
        conversationArchivedAt: conversation.archivedAt,
        lastCustomerMessageAt: conversation.lastInboundAt,
      });
    } catch (err) {
      console.error("[lead analysis] armOnOutbound failed:", err);
    }
  }

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
 * Capture Meta's billing + conversation-window facts for one outbound
 * message. Companion to `updateDeliveryStatusByWamid`, which handles the
 * same webhook's delivery state.
 *
 * Writes twice: the per-message billing outcome onto `messages.pricing`
 * (Phase 4 aggregates it), and the conversation-level window onto
 * `conversations.metaWindow`. Matches 0..N message rows via
 * `by_message_id` for the same reason `updateDeliveryStatusByWamid`
 * does — a wamid is not unique across accounts.
 *
 * `expiresAt` ONLY ADVANCES. Meta's status webhooks are unordered, so a
 * late `delivered` for an older message must never shrink a live window.
 * The single exception is a genuinely different `conversation.id`, which
 * means Meta opened a new conversation and its window supersedes.
 */
export const applyStatusPricing = internalMutation({
  args: {
    wamid: v.string(),
    accountId: v.optional(v.id("accounts")),
    pricing: v.object({
      conversationMetaId: v.optional(v.string()),
      expiresAt: v.optional(v.number()),
      originType: v.optional(v.string()),
      pricingModel: v.optional(v.string()),
      pricingCategory: v.optional(v.string()),
      pricingType: v.optional(v.string()),
      billable: v.optional(v.boolean()),
      isFreeEntryPoint: v.boolean(),
    }),
  },
  handler: async (ctx, args) => {
    const matches = await ctx.db
      .query("messages")
      .withIndex("by_message_id", (q) => q.eq("messageId", args.wamid))
      .collect();

    const now = Date.now();
    const owned = matches.filter(
      (m) => !args.accountId || m.accountId === args.accountId,
    );

    // A conversation-only callback (no `pricing` object) says nothing about
    // this message's billing — writing it would blank facts a previous
    // callback already captured, since `patch` replaces nested objects
    // wholesale.
    const hasPricingFacts =
      args.pricing.billable !== undefined ||
      args.pricing.pricingModel !== undefined ||
      args.pricing.pricingCategory !== undefined ||
      args.pricing.pricingType !== undefined;

    for (const message of owned) {
      if (!hasPricingFacts) continue;
      // Count this message's billing category the FIRST time we learn it.
      // Meta fires a status callback per transition (sent -> delivered ->
      // read), each carrying the same pricing facts; without this guard the
      // panel would report one message as three.
      const isFirstPricingFact = message.pricing === undefined;
      await ctx.db.patch(message._id, {
        pricing: {
          billable: args.pricing.billable ?? message.pricing?.billable,
          model: args.pricing.pricingModel ?? message.pricing?.model,
          category: args.pricing.pricingCategory ?? message.pricing?.category,
          type: args.pricing.pricingType ?? message.pricing?.type,
          capturedAt: now,
        },
      });
      if (isFirstPricingFact) {
        await bumpBilledMessageCategory(
          ctx,
          message.accountId,
          message._creationTime,
          pricingCategoryKey(
            args.pricing.pricingCategory,
            args.pricing.billable,
          ),
        );
      }
    }

    // The window is a property of the conversation, not the message, so
    // it is written once off the first owned match.
    const first = owned[0];
    if (first) {
      const conversation = await ctx.db.get(first.conversationId);
      if (conversation) {
        const prev = conversation.metaWindow;
        const p = args.pricing;
        const differentConversation =
          !!p.conversationMetaId &&
          !!prev?.conversationMetaId &&
          prev.conversationMetaId !== p.conversationMetaId;

        // Only write when this callback actually carries window facts — a
        // pricing-only callback has nothing to say about the window and
        // must not blank it (`patch` replaces nested objects wholesale).
        const hasWindowFacts =
          p.conversationMetaId !== undefined ||
          p.expiresAt !== undefined ||
          p.originType !== undefined ||
          p.isFreeEntryPoint;

        if (hasWindowFacts) {
          if (!prev || differentConversation) {
            // First record, or a genuinely different Meta conversation:
            // replace wholesale. A different conversation IS a different
            // conversation — nothing about the old one carries over.
            await ctx.db.patch(first.conversationId, {
              metaWindow: {
                conversationMetaId: p.conversationMetaId,
                originType: p.originType,
                expiresAt: p.expiresAt,
                isFreeEntryPoint: p.isFreeEntryPoint,
                fepObservedAt: p.isFreeEntryPoint ? now : undefined,
                updatedAt: now,
              },
            });
            // This branch IS the dedup: it runs only when we are recording a
            // Meta conversation we have not seen on this thread before, so a
            // repeated callback for the same conversation falls to the merge
            // branch below and counts nothing.
            await bumpMetaConversationStats(
              ctx,
              first.accountId,
              first._creationTime,
              p.isFreeEntryPoint,
            );
          } else {
            // Same conversation: merge field-wise.
            //
            // `expiresAt` is advance-only ON ITS OWN. It must NOT gate
            // whether the other fields update: Meta sends the SAME expiry
            // on sent/delivered/read and webhooks are unordered, so an
            // out-of-order `delivered` would otherwise permanently discard
            // the `sent` callback that carried the free-entry-point signal.
            //
            // The FEP flag latches — Meta does not reclassify an open
            // conversation — but only while the signal that asserted it is
            // still plausible: `fepObservedAt` (when `isFreeEntryPoint` was
            // last actually true, not merely when the record was last
            // touched) is younger than one window, AND any known
            // `expiresAt` has not already passed. Either check failing
            // means the latch cannot describe a still-open window, so it
            // must not leak into a later conversation.
            // A callback that OMITS the free-entry-point markers says nothing
            // about this conversation's category — Meta reports them on the
            // callback that opens a conversation and may leave them out
            // afterwards, so the latch must survive omission. But a callback
            // carrying an EXPLICIT non-free-entry-point marker is positively
            // asserting that this conversation is billed, and that assertion
            // beats a latch inherited from an earlier one. Absence of
            // evidence is not evidence of absence; an explicit contradiction
            // is.
            //
            // This is what stops a latch from attaching to a later, genuinely
            // billed conversation in the case we can never fully rule out by
            // id alone: a pricing-only callback leaves `conversationMetaId`
            // unset, so `differentConversation` cannot fire.
            const incomingAssertsNotFreeEntryPoint =
              !p.isFreeEntryPoint &&
              (p.originType !== undefined ||
                p.pricingType !== undefined ||
                p.pricingCategory !== undefined);

            const latchStillLive =
              prev.isFreeEntryPoint &&
              !incomingAssertsNotFreeEntryPoint &&
              // A window we KNOW has already expired cannot justify a latch.
              (prev.expiresAt === undefined || prev.expiresAt > now) &&
              // Age the FEP SIGNAL, not the record's last touch: `updatedAt`
              // is rewritten on every merge, so anchoring here would let a
              // latch outlive its window indefinitely while unrelated
              // callbacks kept the record warm. Falls back to `updatedAt`
              // only for rows written before `fepObservedAt` existed.
              now - (prev.fepObservedAt ?? prev.updatedAt) < FEP_WINDOW_MS;
            await ctx.db.patch(first.conversationId, {
              metaWindow: {
                conversationMetaId:
                  p.conversationMetaId ?? prev.conversationMetaId,
                originType: p.originType ?? prev.originType,
                expiresAt: (() => {
                  const known = [p.expiresAt, prev.expiresAt].filter(
                    (v): v is number => typeof v === "number" && Number.isFinite(v),
                  );
                  return known.length ? Math.max(...known) : undefined;
                })(),
                isFreeEntryPoint: latchStillLive || p.isFreeEntryPoint,
                fepObservedAt: p.isFreeEntryPoint
                  ? now
                  : latchStillLive
                    ? (prev.fepObservedAt ?? prev.updatedAt)
                    : undefined,
                updatedAt: now,
              },
            });
          }
        }
      }
    }

    return { matched: matches.length, updated: owned.length };
  },
});

/**
 * Capture Meta's stated reason for a `failed` delivery status. Companion
 * to `applyStatusPricing` right above — same webhook, same
 * match-then-filter shape — but writes only `messages.deliveryError`, a
 * plain diagnostic field with no downstream aggregation: unlike
 * `pricing`, nothing reads this yet. It exists purely so the NEXT
 * silent-failure investigation has a reason to read instead of nothing
 * (see `deliveryError`'s own comment in `schema.ts` for why that mattered
 * enough to add). Matches 0..N message rows via `by_message_id` for the
 * same reason `updateDeliveryStatusByWamid` and `applyStatusPricing` do —
 * a wamid is not unique across accounts.
 *
 * Preserving an earlier callback's facts is TWO separate mechanisms, both
 * required — an earlier version of this mutation had only the first and
 * still blanked fields in ordinary traffic:
 *   1. A callback carrying no actual error facts at all (`hasErrorFacts`
 *      false) is a no-op — same discipline as `applyStatusPricing`'s
 *      `hasPricingFacts` guard — so a wholly information-free callback for
 *      the same wamid can never blank an error an earlier callback already
 *      captured.
 *   2. Every field below falls back to `message.deliveryError?.X` when
 *      `args.error.X` is undefined (`applyStatusPricing`'s own
 *      `args.pricing.billable ?? message.pricing?.billable` pattern,
 *      one function above) — because `patch` replaces the nested
 *      `deliveryError` object WHOLESALE, a callback that carries SOME but
 *      not all facts (Meta redelivering the same webhook with only `code`
 *      present, say — see this module's own comment on `message`/
 *      `error_data.details` being "frequently absent") would otherwise
 *      blank every field it omitted, even though `hasErrorFacts` is true.
 */
export const applyStatusError = internalMutation({
  args: {
    wamid: v.string(),
    accountId: v.optional(v.id("accounts")),
    error: v.object({
      code: v.optional(v.number()),
      title: v.optional(v.string()),
      message: v.optional(v.string()),
      details: v.optional(v.string()),
    }),
  },
  handler: async (ctx, args) => {
    const matches = await ctx.db
      .query("messages")
      .withIndex("by_message_id", (q) => q.eq("messageId", args.wamid))
      .collect();

    const owned = matches.filter(
      (m) => !args.accountId || m.accountId === args.accountId,
    );

    const hasErrorFacts =
      args.error.code !== undefined ||
      args.error.title !== undefined ||
      args.error.message !== undefined ||
      args.error.details !== undefined;
    if (!hasErrorFacts) return { matched: matches.length, updated: 0 };

    const now = Date.now();
    for (const message of owned) {
      await ctx.db.patch(message._id, {
        deliveryError: {
          code: args.error.code ?? message.deliveryError?.code,
          title: args.error.title ?? message.deliveryError?.title,
          message: args.error.message ?? message.deliveryError?.message,
          details: args.error.details ?? message.deliveryError?.details,
          capturedAt: now,
        },
      });
    }
    return { matched: matches.length, updated: owned.length };
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

/** Conversations touched per backfill batch. Small enough to stay well
 *  inside a mutation's transaction budget, since each row costs one
 *  index read on `messages` plus at most one patch. An object (like
 *  `leadAnalysis.BOARD_LIMITS`), not a bare `const`, so a test can
 *  shrink `.batchSize` to reach the tie-boundary path below without
 *  seeding hundreds of rows. */
export const SENDER_TYPE_BACKFILL = { batchSize: 100 };

/**
 * One-off backfill for `conversations.lastMessageSenderType`, added with
 * the field itself so `leadAnalysis.board`'s fallback branch can go cold.
 *
 * Self-scheduling over `_creationTime`, same shape as
 * `backfillMessageHourlyStats` above. Idempotent by construction: a
 * conversation that already has the field is skipped, so a re-run (or a
 * resume after a crash) cannot overwrite a value that live traffic has
 * since written.
 *
 * A conversation with NO messages is deliberately left `undefined`
 * rather than given a default — `leadLane` treats absent as
 * "awaiting us", the lane automation may not act on, and inventing a
 * value here would silently move it out of that protection.
 */
export const backfillLastMessageSenderType = internalMutation({
  args: { cursorMs: v.optional(v.number()) },
  handler: async (ctx, args): Promise<void> => {
    const batch = await ctx.db
      .query("conversations")
      .withIndex("by_creation_time", (q) =>
        args.cursorMs === undefined ? q : q.gt("_creationTime", args.cursorMs),
      )
      .take(SENDER_TYPE_BACKFILL.batchSize);

    if (batch.length === 0) return;

    const tailMs = batch[batch.length - 1]!._creationTime;

    // `.take()` can cut a same-`_creationTime` tie group in half — this
    // table was seeded by a Postgres migration, and bulk inserts
    // routinely land in the same millisecond. A naive resume with
    // `.gt(tailMs)` on the next call would then permanently skip
    // whichever conversations shared `tailMs` but fell after the cut:
    // they're excluded from this batch by `.take`, and excluded from
    // every future batch by `.gt`, with nothing left to ever revisit
    // them. Close that gap the same way `leadAnalysisEngine.backfillAccount`'s
    // straggler drain does: read the WHOLE tie group at `tailMs` via a
    // plain equality index read (bounded by that one group's size, not
    // the table), fold in whatever `batch` didn't already cover, and
    // process all of it BEFORE the cursor advances past `tailMs`. By the
    // time the next call's `.gt(tailMs)` runs, every conversation at
    // `tailMs` has already been considered.
    const tiedAtTail = await ctx.db
      .query("conversations")
      .withIndex("by_creation_time", (q) => q.eq("_creationTime", tailMs))
      .collect();
    const batchIds = new Set(batch.map((c) => c._id));
    const rows = [...batch, ...tiedAtTail.filter((c) => !batchIds.has(c._id))];

    for (const conversation of rows) {
      if (conversation.lastMessageSenderType !== undefined) continue;

      const newest = await ctx.db
        .query("messages")
        .withIndex("by_conversation", (q) =>
          q.eq("conversationId", conversation._id),
        )
        .order("desc")
        .first();
      if (!newest) continue;

      await ctx.db.patch(conversation._id, {
        lastMessageSenderType: newest.senderType,
      });
    }

    await ctx.scheduler.runAfter(0, internal.messages.backfillLastMessageSenderType, {
      cursorMs: tailMs,
    });
  },
});

// ============================================================
// One-shot backfill for the reply-latency half of `messageHourlyStats`.
//
// `recordResponseSample` only pairs messages written after it deploys, so
// without this `dashboard.responseTime` charts a flat "no data" for its whole
// 14-day window until two weeks have passed. Run manually:
//
//   npx convex run messages:backfillResponseHourlyStats
//
// Scoped to the last `RESPONSE_BACKFILL_DAYS` days rather than all history,
// because that is the entire window the chart reads — rebuilding further back
// would cost reads to populate buckets nothing queries.
//
// IDEMPOTENT, by clearing the window's samples before rebuilding them: the
// first pass for an account zeroes `responseCount`/`responseTotalMs` across
// the window, and subsequent passes accumulate into it. Re-running the whole
// backfill therefore converges instead of doubling. Note this is per ACCOUNT
// and per RUN, so it must be started from the top (no `cursorMs`) — resuming
// mid-way with a hand-supplied cursor would skip the clear and double-count.
//
// Batched over CONVERSATIONS, not messages, because the pairing is
// per-conversation: a thread's own chronological order is the only thing that
// decides which question a reply answers, so a batch that split a thread
// would need pairing state carried across schedules.
// ============================================================

/** Days of history rebuilt. `dashboard.responseTime`'s window is 14. */
const RESPONSE_BACKFILL_DAYS = 14;
/** Conversations replayed per batch. Deliberately well under the read limit:
 *  the real cost is `RESPONSE_BACKFILL_MESSAGES` per conversation. */
const RESPONSE_BACKFILL_CONVERSATIONS = 10;
/** Messages replayed per conversation. A thread with more than this many
 *  messages inside a 14-day window is far beyond this deployment; it is
 *  warned about rather than paged, which would need cross-batch state. */
const RESPONSE_BACKFILL_MESSAGES = 1000;

/**
 * Replay one conversation's window through the same pairing rule
 * `insertMessageAndUpdateConversation` applies on write, accumulating each
 * sample into the hour its customer message landed in.
 *
 * Also leaves `pendingCustomerAtMs` consistent with what it replayed, so a
 * thread that is mid-wait when the backfill runs still records its sample
 * when the reply finally arrives.
 */
async function replayConversationResponses(
  ctx: { db: MutationCtx["db"] },
  conversation: Doc<"conversations">,
  sinceMs: number,
): Promise<void> {
  const messages = await ctx.db
    .query("messages")
    .withIndex("by_conversation", (q) =>
      q.eq("conversationId", conversation._id).gte("_creationTime", sinceMs),
    )
    .take(RESPONSE_BACKFILL_MESSAGES);

  if (messages.length === 0) return;
  if (messages.length === RESPONSE_BACKFILL_MESSAGES) {
    console.warn(
      `[backfill] conversation ${conversation._id} has more than ${RESPONSE_BACKFILL_MESSAGES} messages in the window; its later replies are not counted`,
    );
  }

  let pendingAtMs: number | undefined = undefined;
  for (const message of messages) {
    if (message.senderType === "customer") {
      // First unanswered question wins — a customer who messages three times
      // is one sample, timed from the first. Same rule as the write path.
      if (pendingAtMs === undefined) pendingAtMs = message._creationTime;
    } else if (pendingAtMs !== undefined) {
      await recordResponseSample(
        ctx,
        conversation.accountId,
        pendingAtMs,
        message._creationTime,
      );
      pendingAtMs = undefined;
    }
  }

  // A question left open BEFORE the window is invisible here, so this can
  // clear a genuinely-pending flag. That costs at most one uncounted sample
  // whose bucket predates the window and is therefore never charted.
  if (conversation.pendingCustomerAtMs !== pendingAtMs) {
    await ctx.db.patch(conversation._id, { pendingCustomerAtMs: pendingAtMs });
  }
}

export const backfillResponseHourlyStats = internalMutation({
  args: {
    // Absent = start at the first account. Threaded by the self-schedule.
    accountId: v.optional(v.id("accounts")),
    cursorMs: v.optional(v.number()),
    // Pinned by the first invocation and threaded through, so a run that
    // spans hours rebuilds one fixed window rather than a sliding one.
    sinceMs: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<void> => {
    const sinceMs =
      args.sinceMs ?? Date.now() - RESPONSE_BACKFILL_DAYS * 24 * HOUR_MS;

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
      await ctx.scheduler.runAfter(
        0,
        internal.messages.backfillResponseHourlyStats,
        { accountId: next._id, sinceMs },
      );
    };

    // First pass for this account: clear the window so the accumulation
    // below is a rebuild rather than an addition. Bounded by the window
    // (24 rows a day, ~336 for 14 days), not by traffic.
    if (args.cursorMs === undefined) {
      const stale = await ctx.db
        .query("messageHourlyStats")
        .withIndex("by_account_hour", (q) =>
          q
            .eq("accountId", account._id)
            .gte("hourStartMs", hourStartMs(sinceMs)),
        )
        .collect();
      for (const row of stale) {
        if (
          row.responseCount === undefined &&
          row.responseTotalMs === undefined &&
          row.responseBuckets === undefined
        )
          continue;
        // `undefined` removes the field, restoring the "no samples yet" shape
        // a pre-rollup row has. `responseBuckets` must be cleared alongside
        // `responseCount`/`responseTotalMs`, not left as-is: `recordResponseSample`
        // (called by `replayConversationResponses` below, on every run of this
        // backfill) writes it via `addResponseBucket`, which ADDS to whatever
        // histogram is already on the row. Clearing only the count/total let a
        // second run reset those two to zero and rebuild them correctly while
        // the histogram accumulated a second copy on top of the first —
        // breaking the invariant every percentile/within-target figure in
        // convex/reports.ts depends on (the histogram's entries summing to
        // `responseCount`). Pinned by "response backfill is idempotent" in
        // messages.test.ts.
        await ctx.db.patch(row._id, {
          responseCount: undefined,
          responseTotalMs: undefined,
          responseBuckets: undefined,
        });
      }
    }

    // Walked on `by_account` with a strict `_creationTime` cursor: unique per
    // document, so a batch boundary can neither skip a conversation nor
    // replay one twice (which, unlike the hour rebuild above, would
    // double-count).
    const conversations = await ctx.db
      .query("conversations")
      .withIndex("by_account", (q) =>
        args.cursorMs === undefined
          ? q.eq("accountId", account._id)
          : q.eq("accountId", account._id).gt("_creationTime", args.cursorMs),
      )
      .take(RESPONSE_BACKFILL_CONVERSATIONS);

    if (conversations.length === 0) {
      await advanceToNextAccount();
      return;
    }

    for (const conversation of conversations) {
      // Cheap skip for threads that went quiet before the window — avoids a
      // message read per dormant conversation, which for an old account is
      // most of them. An ABSENT `lastMessageAt` means "unknown", not "old"
      // (the field is optional, so a row predating it would otherwise be
      // silently skipped and lose its samples), so those are still replayed.
      if (
        conversation.lastMessageAt !== undefined &&
        conversation.lastMessageAt < sinceMs
      ) {
        continue;
      }
      await replayConversationResponses(ctx, conversation, sinceMs);
    }

    if (conversations.length < RESPONSE_BACKFILL_CONVERSATIONS) {
      await advanceToNextAccount();
      return;
    }

    await ctx.scheduler.runAfter(
      0,
      internal.messages.backfillResponseHourlyStats,
      {
        accountId: account._id,
        cursorMs: conversations[conversations.length - 1]!._creationTime,
        sinceMs,
      },
    );
  },
});

// ============================================================
// One-shot backfill for `conversationsStarted` / `conversationsStartedAd`.
//
// Run manually, after the write paths deploy:
//
//   npx convex run messages:backfillConversationStartedStats
//
// IDEMPOTENT by rebuilding whole hours rather than incrementing — each pass
// SETS a bucket to the count it just measured, exactly as
// `backfillMessageHourlyStats` does and for the same reason. A batch that
// ends mid-hour withholds that partial hour and rewinds the cursor to its
// start, so an hour is only written once seen in full.
//
// `conversationsStartedAd` counts a conversation iff its CHRONOLOGICALLY
// EARLIEST referral is a genuine ad (`sourceType === "ad"`) — the exact
// rule `adReferrals.recordAdReferral` applies on the live write path.
// That mutation's `priorReferrals` (read before deciding whether to bump)
// is collected UNFILTERED by sourceType, so a later ad referral landing on
// a conversation that already has an earlier referral of ANY type is never
// counted — see that mutation's own comment for the full rationale, and
// the ad-set construction below for how this backfill reproduces it. An
// organic Facebook/Instagram "post" tap or a ctwaClid-only referral
// (`sourceType` absent) still counts toward `conversationsStarted` below —
// the conversation did start — it must just not be attributed to an ad,
// whether it's the conversation's only referral or merely an earlier one
// than a later ad. `ingest.ts`'s find-or-create reuses one conversation
// per contact, so a later, different-typed referral landing on an
// already-referred (reused) conversation is the normal case, not an edge
// one.
//
// NOT concurrency-safe: two overlapping runs of the same chain will each
// SET the same buckets, and a bucket measured from a partial view will be
// written as if complete. Trigger one chain and let it finish.
// ============================================================

const CONVERSATION_BACKFILL_BATCH = 500;

export const backfillConversationStartedStats = internalMutation({
  args: {
    accountId: v.optional(v.id("accounts")),
    cursorMs: v.optional(v.number()),
    // Test-only override of CONVERSATION_BACKFILL_BATCH. Seeding 500+ rows
    // to exercise the withheld-partial-hour / single-hour-overflow paths
    // below is impractical, so tests drive a genuine multi-batch chain with
    // a handful of rows instead. Production callers — the self-schedules in
    // this function, and a manual `npx convex run` — never set this, so it
    // always defaults to the real batch size below.
    batchSize: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<void> => {
    const batchSize = args.batchSize ?? CONVERSATION_BACKFILL_BATCH;
    const accounts = await ctx.db.query("accounts").collect();
    if (accounts.length === 0) return;

    const index = args.accountId
      ? accounts.findIndex((a) => a._id === args.accountId)
      : 0;
    if (index < 0) return; // account vanished mid-backfill; nothing to resume
    const account = accounts[index]!;

    const advanceToNextAccount = async () => {
      const next = accounts[index + 1];
      if (!next) return;
      await ctx.scheduler.runAfter(
        0,
        internal.messages.backfillConversationStartedStats,
        { accountId: next._id, batchSize: args.batchSize },
      );
    };

    const batch = await ctx.db
      .query("conversations")
      .withIndex("by_account", (q) =>
        args.cursorMs === undefined
          ? q.eq("accountId", account._id)
          : q.eq("accountId", account._id).gte("_creationTime", args.cursorMs),
      )
      .take(batchSize);

    if (batch.length === 0) {
      await advanceToNextAccount();
      return;
    }

    // Which of these conversations STARTED from a genuine ad — i.e. whose
    // CHRONOLOGICALLY EARLIEST referral (of any type) is an ad. Bounded to
    // THIS BATCH's own contacts, not the account's whole `adReferrals`
    // history — a prior version of this comment argued for reading the
    // account's entire history instead, reasoning that it was "cheap
    // relative to the batch"; that was wrong at scale. That `.collect()`
    // sat inside the per-batch handler, so it re-ran on EVERY hop, and a
    // large account's referral history alone can approach or exceed
    // Convex's 4096-document-per-transaction ceiling — on the FIRST
    // invocation, before any write, so the backfill would abort with zero
    // progress. That is exactly the failure class the whole rollup exists
    // to avoid (see `lib/messageStats.ts`'s account of the two production
    // incidents that motivated it).
    //
    // `adReferrals` has no index on `conversationId` — only `by_contact`,
    // `by_account`, `by_account_ad`, `by_wamid` — so this reads ONE
    // `by_contact` query per DISTINCT contact in the batch (deduplicated:
    // several conversations sharing a contact cost one read, not one each),
    // mirroring `adServiceTagging.ts`'s `referralFor`, which filters the
    // same index in memory for the same reason ("a contact has a handful of
    // referrals at most"). `by_contact` still returns that contact's FULL,
    // untruncated referral history with no time bound — earliest-ness is
    // still computed over everything relevant, exactly as before — but the
    // READ COUNT this costs now scales with `batchSize` (at most one query
    // per conversation in the batch, fewer if contacts repeat) rather than
    // with the account's total referral history, which is what keeps this
    // under the transaction ceiling regardless of account size. See
    // `CONVERSATION_BACKFILL_BATCH`'s own comment above for the same
    // "comfortably under the read limit" reasoning this batch size was
    // chosen for in the first place.
    const contactIds = new Set(batch.map((c) => c.contactId));
    const earliestReferralByConversation = new Map<
      Id<"conversations">,
      Doc<"adReferrals">
    >();
    for (const contactId of contactIds) {
      const referrals = await ctx.db
        .query("adReferrals")
        .withIndex("by_contact", (q) => q.eq("contactId", contactId))
        .collect();
      for (const r of referrals) {
        const earliest = earliestReferralByConversation.get(r.conversationId);
        if (!earliest || r._creationTime < earliest._creationTime) {
          earliestReferralByConversation.set(r.conversationId, r);
        }
      }
    }
    const adConversationIds = new Set(
      [...earliestReferralByConversation.values()]
        .filter((r) => r.sourceType === "ad")
        .map((r) => r.conversationId),
    );

    const hours = new Map<number, { started: number; ad: number }>();
    for (const c of batch) {
      const key = hourStartMs(c._creationTime);
      const bucket = hours.get(key) ?? { started: 0, ad: 0 };
      bucket.started += 1;
      if (adConversationIds.has(c._id)) bucket.ad += 1;
      hours.set(key, bucket);
    }

    const sortedHours = [...hours.keys()].sort((a, b) => a - b);
    const isFullBatch = batch.length === batchSize;
    const singleHourOverflow = isFullBatch && sortedHours.length === 1;
    const hoursToWrite =
      isFullBatch && !singleHourOverflow
        ? sortedHours.slice(0, -1)
        : sortedHours;

    if (singleHourOverflow) {
      console.warn(
        `[backfill] account ${account._id}: hour ${new Date(sortedHours[0]!).toISOString()} has more than ${batchSize} conversations; its bucket may undercount`,
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
      const fields = {
        conversationsStarted: totals.started,
        conversationsStartedAd: totals.ad,
      };
      if (existing) await ctx.db.patch(existing._id, fields);
      else
        await ctx.db.insert("messageHourlyStats", {
          accountId: account._id,
          hourStartMs: hour,
          incoming: 0,
          outgoing: 0,
          ...fields,
        });
    }

    if (!isFullBatch) {
      await advanceToNextAccount();
      return;
    }

    const resumeFrom = singleHourOverflow
      ? sortedHours[0]! + HOUR_MS
      : sortedHours[sortedHours.length - 1]!;
    await ctx.scheduler.runAfter(
      0,
      internal.messages.backfillConversationStartedStats,
      { accountId: account._id, cursorMs: resumeFrom, batchSize: args.batchSize },
    );
  },
});

// ============================================================
// One-shot backfill for `responseBuckets`.
//
//   npx convex run messages:backfillResponseBuckets
//
// APPROXIMATE, and deliberately so. The raw per-reply latencies are not
// retained — only each hour's sum and count — so an historical hour's
// histogram cannot be reconstructed exactly. This places the hour's whole
// sample count in the bucket its stored MEAN falls into, which is right when
// an hour's replies were similar and wrong when they straddled a bucket
// edge. Hours already carrying an exact histogram — written by
// `recordResponseSample`, whether live post-deploy or via
// `backfillResponseHourlyStats`'s replay, which calls that same function —
// are left alone: the guard is `responseBuckets !== undefined`, so a re-run
// never overwrites a real histogram with an estimate.
//
// WALKED PER ACCOUNT, unlike a single forward scan of the whole table. Two
// reasons, not one:
//
// 1. `by_account_hour` leads with `accountId`, and Convex's index-range
//    builder requires binding fields in order — a `.gte("hourStartMs", …)`
//    with `accountId` unbound does not type-check at all (confirmed against
//    `IndexRangeBuilder` in convex's own `index_range_builder.d.ts`: at the
//    index's first field position, only that field's name is a valid
//    argument to `.eq`/`.gt`/`.gte`/`.lt`/`.lte`). So the naive
//    whole-table version isn't just slow, it does not compile.
// 2. Even given a (hypothetical) way to force that range, `hourStartMs`
//    values repeat ACROSS accounts — every account's first tracked hour can
//    be the same wall-clock hour. A cursor compared globally against that
//    column could advance past an hour some OTHER account still has an
//    unprocessed row in, silently dropping it — a paginated cursor that
//    skips rows is worse than a slow scan. Scoping every read to one
//    account via `.eq("accountId", …)` first (exactly like
//    `backfillConversationStartedStats` and `backfillMessageHourlyStats`
//    above) sidesteps this: `(accountId, hourStartMs)` is unique per row
//    (every writer upserts via a `.unique()` lookup on that pair — see
//    `bumpConversationStartedStat` et al. above), so within one account
//    `lastSeen.hourStartMs + 1` cannot skip or repeat a row.
//
// No single-hour-overflow guard, unlike the two backfills above: those
// aggregate many raw rows (messages/conversations) into an hour and so can
// observe that hour incompletely mid-batch. This backfill's unit of work is
// already one complete, previously-written `messageHourlyStats` row — there
// is nothing to accumulate across a batch boundary, so a plain `+ 1` cursor
// is exact.
// ============================================================

/** Rows read per batch. Each is a cheap read plus at most one patch, no
 *  further reads fan out from it (unlike the conversation/message
 *  backfills above), so this can safely match their batch size. */
const RESPONSE_BUCKET_BACKFILL_BATCH = 500;

export const backfillResponseBuckets = internalMutation({
  args: {
    accountId: v.optional(v.id("accounts")),
    cursorMs: v.optional(v.number()),
    // Test-only override of RESPONSE_BUCKET_BACKFILL_BATCH — see
    // `backfillConversationStartedStats`'s identical `batchSize` arg for why.
    batchSize: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<void> => {
    const batchSize = args.batchSize ?? RESPONSE_BUCKET_BACKFILL_BATCH;
    const accounts = await ctx.db.query("accounts").collect();
    if (accounts.length === 0) return;

    const index = args.accountId
      ? accounts.findIndex((a) => a._id === args.accountId)
      : 0;
    if (index < 0) return; // account vanished mid-backfill; nothing to resume
    const account = accounts[index]!;

    const advanceToNextAccount = async () => {
      const next = accounts[index + 1];
      if (!next) return;
      await ctx.scheduler.runAfter(0, internal.messages.backfillResponseBuckets, {
        accountId: next._id,
        batchSize: args.batchSize,
      });
    };

    const batch = await ctx.db
      .query("messageHourlyStats")
      .withIndex("by_account_hour", (q) =>
        args.cursorMs === undefined
          ? q.eq("accountId", account._id)
          : q.eq("accountId", account._id).gte("hourStartMs", args.cursorMs),
      )
      .take(batchSize);

    if (batch.length === 0) {
      await advanceToNextAccount();
      return;
    }

    for (const row of batch) {
      const count = row.responseCount ?? 0;
      if (count <= 0) continue; // nothing to place
      if (row.responseBuckets !== undefined) continue; // exact already
      const meanMs = (row.responseTotalMs ?? 0) / count;
      const key = responseBucketFor(meanMs);
      await ctx.db.patch(row._id, {
        responseBuckets: { ...emptyResponseBuckets(), [key]: count },
      });
    }

    if (batch.length < batchSize) {
      await advanceToNextAccount();
      return;
    }

    await ctx.scheduler.runAfter(0, internal.messages.backfillResponseBuckets, {
      accountId: account._id,
      cursorMs: batch[batch.length - 1]!.hourStartMs + 1,
      batchSize: args.batchSize,
    });
  },
});

// ============================================================
// One-shot backfill for `activeConversations`.
//
//   npx convex run messages:backfillActiveConversationStats
//
// IDEMPOTENT by rebuilding whole UTC DAYS rather than incrementing — each
// pass SETs the buckets it just measured, exactly as its siblings do.
//
// THE STRUCTURAL DIFFERENCE FROM ITS SIBLINGS: they withhold the final
// partial HOUR of a batch, which guarantees an hour never straddles two
// batches. This backfill needs DAY-level distinctness, so it withholds the
// final partial DAY and resumes at that day's start — the same idea one unit
// coarser. Without it, a conversation whose messages for one day span a batch
// boundary would be counted once per batch.
//
// That raises the worst case from an hour of messages to a day of them, which
// is why the batch size below is its own constant rather than the shared
// `BACKFILL_BATCH`.
//
// NOT concurrency-safe: run one chain and let it finish.
// ============================================================

/** Messages read per batch. Sized against a DAY of traffic (see above), not an
 *  hour, while staying well under Convex's 4096-document read ceiling
 *  alongside this mutation's own bucket upserts. */
const ACTIVE_BACKFILL_BATCH = 1000;

export const backfillActiveConversationStats = internalMutation({
  args: {
    accountId: v.optional(v.id("accounts")),
    cursorMs: v.optional(v.number()),
    // Test-only override of ACTIVE_BACKFILL_BATCH — see
    // `backfillConversationStartedStats`'s identical `batchSize` arg for why:
    // seeding 1000+ rows to exercise the withheld-partial-day /
    // single-day-overflow paths below is impractical, so tests drive a
    // genuine multi-batch chain with a handful of rows instead. Production
    // callers — the self-schedules in this function, and a manual
    // `npx convex run` — never set this, so it always defaults to the real
    // batch size below.
    batchSize: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<void> => {
    const batchSize = args.batchSize ?? ACTIVE_BACKFILL_BATCH;
    const accounts = await ctx.db.query("accounts").collect();
    if (accounts.length === 0) return;

    const index = args.accountId
      ? accounts.findIndex((a) => a._id === args.accountId)
      : 0;
    if (index < 0) return; // account vanished mid-backfill; nothing to resume
    const account = accounts[index]!;

    const advanceToNextAccount = async () => {
      const next = accounts[index + 1];
      if (!next) return;
      await ctx.scheduler.runAfter(
        0,
        internal.messages.backfillActiveConversationStats,
        { accountId: next._id, batchSize: args.batchSize },
      );
    };

    const batch = await ctx.db
      .query("messages")
      .withIndex("by_account", (q) =>
        args.cursorMs === undefined
          ? q.eq("accountId", account._id)
          : q.eq("accountId", account._id).gte("_creationTime", args.cursorMs),
      )
      .take(batchSize);

    if (batch.length === 0) {
      await advanceToNextAccount();
      return;
    }

    // For each (conversation, UTC day), the hour of its EARLIEST message —
    // mirroring exactly what the live write path records.
    const firstHourByPair = new Map<string, number>();
    for (const m of batch) {
      const day = utcDayStartMs(m._creationTime);
      const key = `${m.conversationId}:${day}`;
      const hour = hourStartMs(m._creationTime);
      const prior = firstHourByPair.get(key);
      if (prior === undefined || hour < prior) firstHourByPair.set(key, hour);
    }

    // Count those pairs into the hour buckets they belong to.
    const perHour = new Map<number, number>();
    for (const hour of firstHourByPair.values()) {
      perHour.set(hour, (perHour.get(hour) ?? 0) + 1);
    }

    const sortedDays = [
      ...new Set(batch.map((m) => utcDayStartMs(m._creationTime))),
    ].sort((a, b) => a - b);
    const isFullBatch = batch.length === batchSize;

    // A full batch almost certainly stops mid-day. Withhold that last day and
    // resume from its start, so a day is only written once observed
    // end-to-end — that is what keeps SET idempotent AND what makes per-day
    // distinctness correct across batches.
    //
    // Unless the whole batch is ONE day: withholding it would rewind the
    // cursor to where it already is and loop forever. That needs more than
    // ACTIVE_BACKFILL_BATCH messages in a single day; handled by writing what
    // was measured and stepping past, with a warning.
    const singleDayOverflow = isFullBatch && sortedDays.length === 1;
    const daysToWrite = new Set(
      isFullBatch && !singleDayOverflow ? sortedDays.slice(0, -1) : sortedDays,
    );

    if (singleDayOverflow) {
      console.warn(
        `[backfill] account ${account._id}: day ${new Date(sortedDays[0]!).toISOString()} has more than ${batchSize} messages; its active-conversation bucket may undercount`,
      );
    }

    // Only hours belonging to a day we are writing.
    const hoursToWrite = [...perHour.entries()].filter(([hour]) =>
      daysToWrite.has(utcDayStartMs(hour)),
    );

    for (const [hour, count] of hoursToWrite) {
      const existing = await ctx.db
        .query("messageHourlyStats")
        .withIndex("by_account_hour", (q) =>
          q.eq("accountId", account._id).eq("hourStartMs", hour),
        )
        .unique();
      if (existing) {
        await ctx.db.patch(existing._id, { activeConversations: count });
      } else {
        await ctx.db.insert("messageHourlyStats", {
          accountId: account._id,
          hourStartMs: hour,
          incoming: 0,
          outgoing: 0,
          activeConversations: count,
        });
      }
    }

    if (!isFullBatch) {
      await advanceToNextAccount();
      return;
    }

    const resumeFrom = singleDayOverflow
      ? sortedDays[0]! + DAY_MS
      : sortedDays[sortedDays.length - 1]!;
    await ctx.scheduler.runAfter(
      0,
      internal.messages.backfillActiveConversationStats,
      { accountId: account._id, cursorMs: resumeFrom, batchSize: args.batchSize },
    );
  },
});
