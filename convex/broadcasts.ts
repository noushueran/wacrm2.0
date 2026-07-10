import { accountMutation, accountQuery } from "./lib/auth";
import { internalMutation } from "./_generated/server";
import { v, ConvexError } from "convex/values";
import { paginationOptsValidator } from "convex/server";
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
