import { accountMutation, accountQuery } from "./lib/auth";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { getAuthUserId } from "@convex-dev/auth/server";
import { v, ConvexError } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { hasMinRole } from "./lib/roles";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";

// ============================================================
// Broadcasts + recipients — a bulk template send (`broadcasts`) and its
// per-contact fan-out (`broadcastRecipients`). Built on
// `accountQuery`/`accountMutation` (never the raw `query`/`mutation`),
// mirroring `contacts.ts`/`conversations.ts`/`deals.ts`: `ctx.accountId`
// always comes from the caller's own `memberships` row, never a
// client-supplied argument — there is no `accountId` field in any args
// validator below.
//
// The five `broadcasts` counter columns (`sentCount`/`deliveredCount`/
// `readCount`/`repliedCount`/`failedCount`) were a Postgres aggregate
// TRIGGER (migrations 003/005) that recomputed them from
// `broadcast_recipients` on every recipient status change. Convex has no
// triggers, so `setRecipientStatus` below performs the equivalent as an
// in-mutation incremental update: `colsForStatus` names which counter(s)
// a given recipient status contributes to (cumulative — a "replied"
// recipient still counts toward `sentCount`/`deliveredCount`/
// `readCount`, since it passed through all of them), and every status
// CHANGE walks off the old status's columns (-1) and onto the new
// status's columns (+1), clamped at 0. `create` never seeds these
// counts to anything but 0 — the same "counts are derived, never
// seeded" invariant `src/lib/whatsapp/broadcast-core.ts`'s own header
// comment documents for the Postgres trigger.
// ============================================================

/**
 * The subset of a broadcast's fields the count model touches. Named
 * `counts` to match the brief's `colsForStatus(status): (keyof
 * counts)[]` signature. Every key here is a plain `v.number()` in
 * schema.ts (never optional), so no `?? 0` fallback is needed anywhere
 * below.
 */
type BroadcastCounts = Pick<
  Doc<"broadcasts">,
  "sentCount" | "deliveredCount" | "readCount" | "repliedCount" | "failedCount"
>;

/**
 * The count model from migration 005 (`005_broadcast_counts_incremental
 * .sql`), reproduced here as a pure function rather than a DB trigger:
 * which `broadcasts` counter columns a given recipient `status`
 * contributes to. Cumulative for the "in flight" progression — a
 * `"replied"` recipient still counts toward `sentCount`/
 * `deliveredCount`/`readCount`, since it passed through all of them —
 * but `"failed"` is a separate terminal branch contributing to none of
 * the "in flight" columns.
 *
 * Not wrapped in `accountQuery`/`accountMutation` — it does no I/O and
 * is never part of the public Convex API (`api.broadcasts
 * .colsForStatus` does not exist), so it stays "private" from any
 * client's perspective. It IS a named export so `convex/broadcasts
 * .test.ts` can unit-test it directly (same treatment `convex/lib
 * /roles.ts`'s `roleRank`/`hasMinRole` get in `roles.test.ts`), on top
 * of the integration coverage `setRecipientStatus`'s own tests give it.
 */
export function colsForStatus(
  status: Doc<"broadcastRecipients">["status"],
): (keyof BroadcastCounts)[] {
  switch (status) {
    case "pending":
      return [];
    case "sent":
      return ["sentCount"];
    case "delivered":
      return ["sentCount", "deliveredCount"];
    case "read":
      return ["sentCount", "deliveredCount", "readCount"];
    case "replied":
      return ["sentCount", "deliveredCount", "readCount", "repliedCount"];
    case "failed":
      return ["failedCount"];
  }
}

const COUNT_COLUMNS: (keyof BroadcastCounts)[] = [
  "sentCount",
  "deliveredCount",
  "readCount",
  "repliedCount",
  "failedCount",
];

// The happy-path status ladder — pending -> sent -> delivered -> read ->
// replied. Ported verbatim from `src/app/api/whatsapp/webhook/route.ts`'s
// `RECIPIENT_STATUS_LADDER`/`isValidStatusTransition` (lines ~310-350) —
// used ONLY by `recordRecipientStatusByWamid` below (Phase 8, Task 4),
// the webhook-driven mirror. `setRecipientStatus` (agent-facing, already
// existed) never had this guard and keeps not having it here: an agent
// setting a status by hand is a deliberate override, not a possibly
// out-of-order Meta redelivery. Webhook status deliveries CAN arrive out
// of order (Meta gives no ordering guarantee), so a regression (e.g.
// "sent" arriving after "read" already landed) must be refused there.
// `failed` is a terminal side branch, valid only from the early
// (pending/sent) states — once a recipient has reached any success
// state, a later "failed" is either a bug in Meta's pipeline or a spoof
// and must be ignored.
const RECIPIENT_STATUS_LADDER = [
  "pending",
  "sent",
  "delivered",
  "read",
  "replied",
] as const;

function ladderLevel(status: string): number {
  const idx = (RECIPIENT_STATUS_LADDER as readonly string[]).indexOf(status);
  return idx < 0 ? -1 : idx;
}

/**
 * Can a recipient transition from `current` to `incoming`? Exported so
 * `convex/broadcasts.test.ts` can unit-test it directly, matching
 * `colsForStatus`'s own treatment.
 */
export function isValidStatusTransition(
  current: string,
  incoming: string,
): boolean {
  if (incoming === "failed") {
    return current === "pending" || current === "sent";
  }
  if (current === "failed") {
    return false; // failed is terminal
  }
  const ci = ladderLevel(current);
  const ii = ladderLevel(incoming);
  if (ii < 0) return false; // unknown incoming status
  if (ci < 0) return true; // unknown current — accept anything on the ladder
  return ii > ci;
}

/**
 * Shared core for both `setRecipientStatus` (accountMutation, below) and
 * `recordRecipientStatusByWamid` (internalMutation, Phase 8 webhook
 * status handler, further below): applies a recipient status transition
 * plus the migration-005 incremental count model on the parent
 * broadcast — the exact count-delta logic `setRecipientStatus` always
 * had, factored out so both entry points share one implementation
 * rather than drift. A total no-op (returns `false`, no count math, no
 * patch) when `status` hasn't actually changed — a duplicate webhook
 * delivery (or a duplicate manual call) replaying the same status must
 * never double-count or overwrite fields.
 */
async function applyRecipientStatusChange(
  ctx: { db: MutationCtx["db"] },
  recipient: Doc<"broadcastRecipients">,
  status: Doc<"broadcastRecipients">["status"],
  extra: { whatsappMessageId?: string; errorMessage?: string },
): Promise<boolean> {
  if (status === recipient.status) {
    return false;
  }

  // Incrementally adjust the parent broadcast's counts: -1 for every
  // column the OLD status counted toward, +1 for every column the NEW
  // status counts toward. A column present in both (e.g. `sentCount`
  // when moving between two "in flight" statuses) nets to zero,
  // matching the cumulative count model. Clamped at 0 defensively.
  const broadcast = await ctx.db.get(recipient.broadcastId);
  if (broadcast) {
    const delta: Record<keyof BroadcastCounts, number> = {
      sentCount: 0,
      deliveredCount: 0,
      readCount: 0,
      repliedCount: 0,
      failedCount: 0,
    };
    for (const col of colsForStatus(recipient.status)) delta[col] -= 1;
    for (const col of colsForStatus(status)) delta[col] += 1;

    const countPatch: Partial<BroadcastCounts> = {};
    for (const col of COUNT_COLUMNS) {
      if (delta[col] !== 0) {
        countPatch[col] = Math.max(0, broadcast[col] + delta[col]);
      }
    }
    if (Object.keys(countPatch).length > 0) {
      await ctx.db.patch(recipient.broadcastId, countPatch);
    }
  }

  const patch: Partial<{
    status: Doc<"broadcastRecipients">["status"];
    whatsappMessageId: string;
    errorMessage: string;
    sentAt: number;
    deliveredAt: number;
    readAt: number;
    repliedAt: number;
  }> = { status, ...extra };
  if (status === "sent") patch.sentAt = Date.now();
  else if (status === "delivered") patch.deliveredAt = Date.now();
  else if (status === "read") patch.readAt = Date.now();
  else if (status === "replied") patch.repliedAt = Date.now();

  await ctx.db.patch(recipient._id, patch);
  return true;
}

/**
 * Loads a broadcast and throws `NOT_FOUND` unless it belongs to the
 * caller's own account — the same error for "doesn't exist" and
 * "exists but isn't yours" on purpose (mirrors `contacts.ts`'s
 * `requireOwnContact`), so a cross-account probe can't distinguish the
 * two. Used by every function below that takes a `broadcastId`.
 */
async function requireOwnBroadcast(
  ctx: { db: QueryCtx["db"]; accountId: Id<"accounts"> },
  broadcastId: Id<"broadcasts">,
) {
  const broadcast = await ctx.db.get(broadcastId);
  if (!broadcast || broadcast.accountId !== ctx.accountId) {
    throw new ConvexError({ code: "NOT_FOUND", entity: "broadcast" });
  }
  return broadcast;
}

/**
 * Throws `NOT_FOUND` unless `contactId` belongs to the caller's own
 * account. Inlined rather than importing `contacts.ts`'s
 * `requireOwnContact` (private/unexported there) — same one-helper-
 * per-file style `deals.ts` already uses for its own copy.
 */
async function requireOwnContact(
  ctx: { db: QueryCtx["db"]; accountId: Id<"accounts"> },
  contactId: Id<"contacts">,
) {
  const contact = await ctx.db.get(contactId);
  if (!contact || contact.accountId !== ctx.accountId) {
    throw new ConvexError({ code: "NOT_FOUND", entity: "contact" });
  }
  return contact;
}

export const list = accountQuery({
  args: {},
  handler: async (ctx) => {
    // `by_account` binds only `accountId`, so the sole remaining sort
    // key is the implicit `_creationTime` — `.order("desc")` gives
    // newest-first, matching `contacts.list`'s identical treatment of
    // its own single-field `by_account` index.
    return await ctx.db
      .query("broadcasts")
      .withIndex("by_account", (q) => q.eq("accountId", ctx.accountId))
      .order("desc")
      .collect();
  },
});

export const get = accountQuery({
  args: { broadcastId: v.id("broadcasts") },
  handler: async (ctx, args) => {
    return await requireOwnBroadcast(ctx, args.broadcastId);
  },
});

export const listRecipients = accountQuery({
  args: {
    broadcastId: v.id("broadcasts"),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    await requireOwnBroadcast(ctx, args.broadcastId);
    return await ctx.db
      .query("broadcastRecipients")
      .withIndex("by_broadcast", (q) => q.eq("broadcastId", args.broadcastId))
      .paginate(args.paginationOpts);
  },
});

export const create = accountMutation({
  args: {
    name: v.string(),
    templateName: v.string(),
    templateLanguage: v.string(),
    contactIds: v.array(v.id("contacts")),
    templateVariables: v.optional(v.any()),
    audienceFilter: v.optional(v.any()),
    status: v.optional(
      v.union(
        v.literal("draft"),
        v.literal("scheduled"),
        v.literal("sending"),
        v.literal("sent"),
        v.literal("failed"),
      ),
    ),
  },
  handler: async (ctx, args) => {
    ctx.requireRole("agent");
    const { contactIds, status, ...rest } = args;

    // Validate every contactId belongs to this account BEFORE inserting
    // anything — a single foreign id rejects the whole broadcast rather
    // than partially creating one with some recipients silently
    // dropped.
    for (const contactId of contactIds) {
      await requireOwnContact(ctx, contactId);
    }

    // Counts always start at 0 — derived purely from recipient status
    // changes via `setRecipientStatus` below, never seeded here (see
    // the file header comment).
    const broadcastId = await ctx.db.insert("broadcasts", {
      accountId: ctx.accountId,
      createdByUserId: ctx.userId,
      ...rest,
      status: status ?? "sending",
      totalRecipients: contactIds.length,
      sentCount: 0,
      deliveredCount: 0,
      readCount: 0,
      repliedCount: 0,
      failedCount: 0,
    });

    for (const contactId of contactIds) {
      await ctx.db.insert("broadcastRecipients", {
        accountId: ctx.accountId,
        broadcastId,
        contactId,
        status: "pending",
      });
    }

    return broadcastId;
  },
});

/**
 * `action`-callable counterpart to `create` above, for `convex/apiV1
 * .createBroadcast` (Phase 8, Task 5) — an `action` has no `ctx.db`/user
 * session of its own (same reasoning as `conversations
 * .findOrCreateForContactInternal`), so `accountId` is an explicit,
 * caller-supplied argument instead of `ctx.accountId`/`ctx.userId`, and
 * there is no `requireRole` (the public API's own scope check —
 * `apiV1.ts`'s `requireScope`/`requireScopeAction` — already gated this
 * before `createBroadcast` ever calls here). Every `contactId` is
 * assumed already resolved + verified to belong to `accountId` by the
 * caller (`apiV1.createBroadcast` does this via `contacts
 * .findOrCreateByPhoneInternal`) — unlike the public `create`, this does
 * NOT re-check `requireOwnContact` per id, since `apiV1.createBroadcast`
 * only ever passes ids it JUST resolved/created for this exact
 * `accountId` in the same call. `createdByUserId` stays unset — there is
 * no user behind an API-key-authenticated write (mirrors the public
 * REST layer's pre-migration `resolveAuditUserId` being simplified away
 * for this migration; see the Phase 8 Task 5 report for the full
 * rationale). Always starts "sending" (never "draft"), matching the
 * REST contract's own immediate-fan-out behavior.
 */
export const createInternal = internalMutation({
  args: {
    accountId: v.id("accounts"),
    name: v.string(),
    templateName: v.string(),
    templateLanguage: v.string(),
    contactIds: v.array(v.id("contacts")),
    templateVariables: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    const { accountId, contactIds, ...rest } = args;

    const broadcastId = await ctx.db.insert("broadcasts", {
      accountId,
      ...rest,
      status: "sending",
      totalRecipients: contactIds.length,
      sentCount: 0,
      deliveredCount: 0,
      readCount: 0,
      repliedCount: 0,
      failedCount: 0,
    });

    for (const contactId of contactIds) {
      await ctx.db.insert("broadcastRecipients", {
        accountId,
        broadcastId,
        contactId,
        status: "pending",
      });
    }

    return broadcastId;
  },
});

export const setRecipientStatus = accountMutation({
  args: {
    recipientId: v.id("broadcastRecipients"),
    status: v.union(
      v.literal("pending"),
      v.literal("sent"),
      v.literal("delivered"),
      v.literal("read"),
      v.literal("replied"),
      v.literal("failed"),
    ),
    whatsappMessageId: v.optional(v.string()),
    errorMessage: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    ctx.requireRole("agent");
    const { recipientId, status, ...rest } = args;

    const recipient = await ctx.db.get(recipientId);
    if (!recipient || recipient.accountId !== ctx.accountId) {
      throw new ConvexError({
        code: "NOT_FOUND",
        entity: "broadcastRecipient",
      });
    }

    await applyRecipientStatusChange(ctx, recipient, status, rest);
    return recipientId;
  },
});

/**
 * Meta delivery-status webhook handler (Phase 8, Task 4) — Convex port
 * of the `broadcast_recipients` mirror in `src/app/api/whatsapp/webhook/
 * route.ts`'s `handleStatusUpdate` (step 2, lines ~376-409). `by_wamid`
 * was reserved on `broadcastRecipients.whatsappMessageId` for exactly
 * this lookup (schema.ts's own comment on that index/migration 003). A
 * no-op (no throw, `null`) when no recipient matches — most inbound
 * status webhooks don't correspond to a broadcast send at all, only to
 * an ordinary conversational message. Forward-only on the status ladder
 * (`isValidStatusTransition` above) — an out-of-order webhook delivery
 * must never regress a recipient that already advanced further, exactly
 * like the source; a rejected transition is a silent no-op (mirrors the
 * source's own `else if` — logging happens at the caller/httpAction
 * layer, not this internal mutation).
 */
export const recordRecipientStatusByWamid = internalMutation({
  args: {
    wamid: v.string(),
    status: v.union(
      v.literal("sent"),
      v.literal("delivered"),
      v.literal("read"),
      v.literal("failed"),
    ),
    errorMessage: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const recipient = await ctx.db
      .query("broadcastRecipients")
      .withIndex("by_wamid", (q) => q.eq("whatsappMessageId", args.wamid))
      .first();
    if (!recipient) return null;

    if (!isValidStatusTransition(recipient.status, args.status)) {
      return recipient._id;
    }

    await applyRecipientStatusChange(ctx, recipient, args.status, {
      errorMessage: args.errorMessage,
    });
    return recipient._id;
  },
});

export const setStatus = accountMutation({
  args: {
    broadcastId: v.id("broadcasts"),
    status: v.union(
      v.literal("draft"),
      v.literal("scheduled"),
      v.literal("sending"),
      v.literal("sent"),
      v.literal("failed"),
    ),
  },
  handler: async (ctx, args) => {
    ctx.requireRole("agent");
    await requireOwnBroadcast(ctx, args.broadcastId);
    await ctx.db.patch(args.broadcastId, {
      status: args.status,
      updatedAt: Date.now(),
    });
    return args.broadcastId;
  },
});

export const remove = accountMutation({
  args: { broadcastId: v.id("broadcasts") },
  handler: async (ctx, args) => {
    ctx.requireRole("agent");
    await requireOwnBroadcast(ctx, args.broadcastId);

    // Explicit cascade: broadcastRecipients has no ON DELETE in Convex.
    const recipients = await ctx.db
      .query("broadcastRecipients")
      .withIndex("by_broadcast", (q) => q.eq("broadcastId", args.broadcastId))
      .collect();
    for (const recipient of recipients) {
      await ctx.db.delete(recipient._id);
    }
    await ctx.db.delete(args.broadcastId);
  },
});

// ============================================================
// Delivery (Phase 8, Task 4) — the public `send` action that actually
// fans a persisted broadcast out to Meta, ported from
// `src/lib/whatsapp/broadcast-core.ts`'s `deliverBroadcast` +
// `src/hooks/use-broadcast-sending.ts`'s send loop. `create` above only
// ever PERSISTS the broadcast + its "pending" recipients (exactly like
// the source's own `createBroadcast` phase) — nothing is actually sent
// until `send` is called. The composer UI wiring that will call it is
// a SEPARATE later task; this is the backend delivery path on its own.
//
// `send` is a plain `action` (not `accountMutation`) because fanning
// out has to reach the scheduler (`ctx.scheduler.runAfter`, only
// available off an action/mutation ctx, never a query) AND, per
// recipient, ultimately calls `metaSend.sendTemplate` (an action) — so
// the entry point itself must be an action, and (like `send.ts`'s own
// `send`) derives account+role from the caller's session by hand via
// `getAuthUserId` + `internal.accounts.accountContextForUser`, since an
// action has no `ctx.db` to run `lib/auth.ts`'s membership lookup
// inline.
//
// Fan-out shape: `send` does the ownership check + status:"sending"
// flip + "pending" recipients snapshot in ONE internal mutation
// (`startSendingInternal`, atomic), then schedules one `deliverOne`
// internalAction per pending recipient, staggered `DELIVER_STAGGER_MS`
// apart. `deliverOne` is best-effort per recipient (never throws
// outward — a scheduled action that throws has nowhere useful to
// surface the error) and, after stamping its own recipient row, checks
// whether any "pending" recipients remain for the broadcast; once none
// do, it finalizes the broadcast's terminal status using the exact
// same rule the source's `deliverBroadcast` used: `sentCount > 0 ?
// 'sent' : 'failed'` — a partial send (some recipients failed, at
// least one succeeded) is still "sent"; only a broadcast where every
// recipient failed (or, degenerately, had none to send in the first
// place) is "failed".
//
// Deliberately NOT reproduced from the source: the contact-phone
// lookup + phone-variant retry (trunk-0 dialing quirks) in
// `deliverBroadcast`'s send loop. `metaSend.sendTemplate`'s own header
// comment already scoped that out as "an engine-level orchestration
// nicety" callers can layer on later if they find they need it — this
// task's design has `deliverOne` send once per recipient, so it isn't
// reproduced here either.
// ============================================================

/**
 * Delay between each per-recipient `deliverOne` schedule. The source's
 * own UI-side batching (`use-broadcast-sending.ts`'s
 * `SEND_BATCH_SIZE=10` / `SEND_BATCH_DELAY_MS=1000`) sent 10 messages
 * then paused a second — a steady-state rate of 10 messages/second.
 * A flat 100ms per-recipient stagger reproduces that exact same
 * steady-state throughput without a batch/sleep loop of our own:
 * Convex's scheduler already IS the queue, so a fixed interval is all
 * that's needed to stay comfortably under Meta's per-phone-number rate
 * limit.
 */
const DELIVER_STAGGER_MS = 100;

/**
 * Re-checks whether any "pending" recipients remain for `broadcastId`
 * and, if none do, patches the broadcast to its terminal status.
 * Mirrors `deliverBroadcast`'s own terminal-status rule verbatim:
 * `sentCount > 0 ? 'sent' : 'failed'` (see this section's header
 * comment). Called from both `startSendingInternal` (covers the
 * zero-pending-recipients edge case, so a broadcast never gets stuck
 * at "sending" with nothing left to finish it) and
 * `setRecipientStatusInternal` (the normal per-recipient completion
 * path) — a no-op while recipients remain pending.
 */
async function maybeFinalizeBroadcast(
  ctx: { db: MutationCtx["db"] },
  broadcastId: Id<"broadcasts">,
): Promise<void> {
  const stillPending = await ctx.db
    .query("broadcastRecipients")
    .withIndex("by_broadcast", (q) => q.eq("broadcastId", broadcastId))
    .filter((q) => q.eq(q.field("status"), "pending"))
    .first();
  if (stillPending) return;

  const broadcast = await ctx.db.get(broadcastId);
  if (!broadcast) return;
  await ctx.db.patch(broadcastId, {
    status: broadcast.sentCount > 0 ? "sent" : "failed",
    updatedAt: Date.now(),
  });
}

/**
 * Server-only counterpart to `setRecipientStatus` (accountMutation,
 * above), for `deliverOne` below — an internalAction has no `ctx.db`/
 * user session of its own (same reasoning as `conversations
 * .findOrCreateForContactInternal`), so `accountId` is an explicit,
 * caller-supplied argument instead of `ctx.accountId`, and there is no
 * `requireRole` call (the only caller is this file's own `deliverOne`,
 * already gated at `send`'s entry — see that action's own comment).
 * Reuses `applyRecipientStatusChange` verbatim, so the count-delta math
 * stays identical to the public mutation's; the one addition is the
 * `maybeFinalizeBroadcast` check afterward, since only THIS delivery
 * path (never the public `setRecipientStatus`, never the webhook-driven
 * `recordRecipientStatusByWamid`) ever resolves a broadcast's initial
 * "pending" fan-out and can therefore ever be "the last one".
 */
export const setRecipientStatusInternal = internalMutation({
  args: {
    accountId: v.id("accounts"),
    recipientId: v.id("broadcastRecipients"),
    status: v.union(
      v.literal("pending"),
      v.literal("sent"),
      v.literal("delivered"),
      v.literal("read"),
      v.literal("replied"),
      v.literal("failed"),
    ),
    whatsappMessageId: v.optional(v.string()),
    errorMessage: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { accountId, recipientId, status, ...rest } = args;
    const recipient = await ctx.db.get(recipientId);
    if (!recipient || recipient.accountId !== accountId) {
      throw new ConvexError({
        code: "NOT_FOUND",
        entity: "broadcastRecipient",
      });
    }

    await applyRecipientStatusChange(ctx, recipient, status, rest);
    await maybeFinalizeBroadcast(ctx, recipient.broadcastId);
    return recipientId;
  },
});

/**
 * Verifies `broadcastId` belongs to `accountId`, flips its status to
 * "sending" (regardless of its current status — this is the explicit
 * "actually start delivering now" trigger, independent of whatever
 * status `create` initialized it with), and returns the ids of its
 * currently-"pending" recipients for `send` to schedule. Runs as ONE
 * atomic internal mutation so the ownership check, the status flip,
 * and the pending snapshot can't race the way three separate
 * round-trips from the calling action could.
 *
 * Also covers the zero-pending-recipients edge case (every recipient
 * already resolved, or none were ever created) by calling
 * `maybeFinalizeBroadcast` immediately — otherwise a broadcast with
 * nothing left to send would flip to "sending" and never be revisited
 * (no `deliverOne` would ever run for it), stuck forever. Since this
 * all happens inside one mutation, the "sending" patch is never
 * externally observable in that case — only the final "sent"/"failed"
 * patch from `maybeFinalizeBroadcast` commits.
 */
export const startSendingInternal = internalMutation({
  args: { accountId: v.id("accounts"), broadcastId: v.id("broadcasts") },
  handler: async (ctx, args): Promise<Id<"broadcastRecipients">[]> => {
    const broadcast = await ctx.db.get(args.broadcastId);
    if (!broadcast || broadcast.accountId !== args.accountId) {
      throw new ConvexError({ code: "NOT_FOUND", entity: "broadcast" });
    }

    await ctx.db.patch(args.broadcastId, {
      status: "sending",
      updatedAt: Date.now(),
    });

    const pending = await ctx.db
      .query("broadcastRecipients")
      .withIndex("by_broadcast", (q) => q.eq("broadcastId", args.broadcastId))
      .filter((q) => q.eq(q.field("status"), "pending"))
      .collect();

    if (pending.length === 0) {
      await maybeFinalizeBroadcast(ctx, args.broadcastId);
    }

    return pending.map((recipient) => recipient._id);
  },
});

/**
 * Loads a "pending" recipient's contact + parent broadcast in one
 * round-trip for `deliverOne` below. `null` covers every "nothing to
 * deliver" case uniformly (foreign/missing recipient, or its broadcast
 * having vanished) — `deliverOne` treats a `null` result as "nothing to
 * do", never a throw.
 */
export const getRecipientForDeliveryInternal = internalQuery({
  args: {
    accountId: v.id("accounts"),
    recipientId: v.id("broadcastRecipients"),
  },
  handler: async (ctx, args) => {
    const recipient = await ctx.db.get(args.recipientId);
    if (!recipient || recipient.accountId !== args.accountId) return null;

    const broadcast = await ctx.db.get(recipient.broadcastId);
    if (!broadcast) return null;

    const contact = recipient.contactId
      ? await ctx.db.get(recipient.contactId)
      : null;

    return { recipient, contact, broadcast };
  },
});

/**
 * PUBLIC, authed entry point that actually delivers a persisted
 * broadcast (Phase 8, Task 4) — Convex port of
 * `src/lib/whatsapp/broadcast-core.ts`'s `deliverBroadcast`. See this
 * section's header comment for the full fan-out design.
 */
export const send = action({
  args: { broadcastId: v.id("broadcasts") },
  handler: async (ctx, args): Promise<{ scheduled: number }> => {
    // ---- authenticate + derive account/role — never trust a
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

    const pendingRecipientIds = await ctx.runMutation(
      internal.broadcasts.startSendingInternal,
      { accountId, broadcastId: args.broadcastId },
    );

    for (const [i, recipientId] of pendingRecipientIds.entries()) {
      await ctx.scheduler.runAfter(
        i * DELIVER_STAGGER_MS,
        internal.broadcasts.deliverOne,
        { accountId, recipientId },
      );
    }

    return { scheduled: pendingRecipientIds.length };
  },
});

/**
 * Delivers a single recipient's template send — scheduled once per
 * "pending" recipient by `send` above. Best-effort: every code path
 * ends in a `setRecipientStatusInternal` call (never a throw), since a
 * scheduled action failing has no caller to usefully propagate to.
 * `senderType: "bot"` (never "agent") — broadcasts are an automated
 * bulk send, not a human agent typing in the Inbox, matching
 * `automationsEngine`'s/`flowsEngine`'s own `metaSend` calls.
 */
export const deliverOne = internalAction({
  args: {
    accountId: v.id("accounts"),
    recipientId: v.id("broadcastRecipients"),
  },
  handler: async (ctx, args): Promise<void> => {
    const loaded = await ctx.runQuery(
      internal.broadcasts.getRecipientForDeliveryInternal,
      { accountId: args.accountId, recipientId: args.recipientId },
    );
    // Nothing to do: the recipient/broadcast vanished, or this
    // recipient already left "pending" (e.g. a duplicate schedule) —
    // either way, silently skip rather than throw.
    if (!loaded || loaded.recipient.status !== "pending") return;
    const { contact, broadcast } = loaded;

    if (!contact) {
      await ctx.runMutation(internal.broadcasts.setRecipientStatusInternal, {
        accountId: args.accountId,
        recipientId: args.recipientId,
        status: "failed",
        errorMessage: "Contact no longer exists",
      });
      return;
    }

    try {
      const conversationId = await ctx.runMutation(
        internal.conversations.findOrCreateForContactInternal,
        { accountId: args.accountId, contactId: contact._id },
      );

      // `broadcasts.templateVariables` is `v.any()` — only usable
      // directly as `metaSend.sendTemplate`'s positional `params:
      // string[]` when it already IS a plain string array. Per-contact
      // personalization (the source hook's `resolveVariables`,
      // resolving `{type:'field'|'custom_field'|'static'}` mappings per
      // recipient) has no Convex data model yet — the composer UI
      // rewire (a separate later task) owns wiring that up; until then
      // every recipient gets the same broadcast-level params, or none.
      const params =
        Array.isArray(broadcast.templateVariables) &&
        broadcast.templateVariables.every(
          (value: unknown) => typeof value === "string",
        )
          ? (broadcast.templateVariables as string[])
          : undefined;

      const result = await ctx.runAction(internal.metaSend.sendTemplate, {
        accountId: args.accountId,
        conversationId,
        to: contact.phone,
        templateName: broadcast.templateName,
        language: broadcast.templateLanguage,
        params,
        senderType: "bot",
      });

      await ctx.runMutation(internal.broadcasts.setRecipientStatusInternal, {
        accountId: args.accountId,
        recipientId: args.recipientId,
        status: "sent",
        whatsappMessageId: result.whatsappMessageId,
      });
    } catch (err) {
      await ctx.runMutation(internal.broadcasts.setRecipientStatusInternal, {
        accountId: args.accountId,
        recipientId: args.recipientId,
        status: "failed",
        errorMessage: err instanceof Error ? err.message : "Unknown error",
      });
    }
  },
});
