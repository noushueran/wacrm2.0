import { v, ConvexError } from "convex/values";
import { accountMutation } from "./lib/auth";
import { internalMutation } from "./_generated/server";
import { requireConversationAccess } from "./lib/conversationAccess";
import { resolveSnoozeUntilMs, SNOOZE_PRESETS } from "./lib/inbox/overrides";
import type { SnoozeChoice } from "./lib/inbox/overrides";

// ============================================================
// Manual lane overrides (spec 2026-07-28-inbox-manual-overrides).
//
// An override is a fact a human knows that the derivation cannot. It is
// NOT a mirror of anything — there is no second source of truth to
// disagree with — which is what distinguishes it from the
// `conversations.chasing` mirror that v2 of the lanes spec removed.
//
// Both fields are PRESENCE flags. Clearing writes `undefined`, never a
// sentinel: every lane binds `eq(field, undefined)` as an index equality,
// so a `0` would drop the row out of all four lanes at once.
// ============================================================

/** Snooze and force are mutually exclusive: a thread is either parked or
 *  chased, never both. Applied on the way in by each mutation rather than
 *  checked afterwards, so the two fields can never both be set. */
const CLEAR_FORCE = { chasingForcedAt: undefined, chasingForcedByUserId: undefined };
const CLEAR_SNOOZE = {
  snoozedUntil: undefined,
  snoozedByUserId: undefined,
  snoozedReason: undefined,
};

/**
 * Neither override may be SET on an archived thread.
 *
 * Archived outranks everything — every lane and both extra tabs bind
 * `eq("archivedAt", undefined)`, and the Archived tab itself shows the
 * thread regardless of these fields — so an override written here would
 * be invisible, permanent and misleading all at once: the agent gets
 * "Snoozed until Tuesday", the thread is in the Archived tab, and
 * nothing ever wakes it into a lane (the wake sweep clears the fields
 * but the row stays archived). It is also the exact stale-override state
 * `leadAnalysis.ts`'s `archiveConversationCore` clears on the way in, so
 * allowing it to be re-created afterwards undoes that.
 *
 * The two CLEARING mutations (`wake`, `unforceChasing`) are deliberately
 * NOT gated: removing state is always safe, and a row that somehow
 * carries a stale override must stay recoverable.
 */
function rejectIfArchived(
  conversation: { archivedAt?: number },
  reason: string,
): void {
  if (conversation.archivedAt !== undefined) {
    throw new ConvexError({ code: "BAD_REQUEST", reason });
  }
}

export const snooze = accountMutation({
  args: {
    conversationId: v.id("conversations"),
    preset: v.optional(v.union(...SNOOZE_PRESETS.map((p) => v.literal(p)))),
    customMs: v.optional(v.number()),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    ctx.requireRole("agent");
    const conversation = await requireConversationAccess(
      ctx,
      args.conversationId,
      "view",
    );
    rejectIfArchived(conversation, "snooze_blocked_archived");

    if ((args.preset === undefined) === (args.customMs === undefined)) {
      throw new ConvexError({ code: "BAD_REQUEST", reason: "snooze_needs_exactly_one_of_preset_or_custom" });
    }

    const config = await ctx.db
      .query("qualificationConfigs")
      .withIndex("by_account", (q) => q.eq("accountId", ctx.accountId))
      .unique();

    const choice: SnoozeChoice =
      args.preset ?? { customMs: args.customMs as number };
    let until: number;
    try {
      until = resolveSnoozeUntilMs(choice, Date.now(), {
        // Fall back to the same Dubai defaults `lib/qualification/defaults.ts`
        // seeds, so an account that has never opened those settings still
        // gets a sensible "tomorrow" rather than a UTC midnight.
        utcOffsetMinutes: config?.utcOffsetMinutes ?? 240,
        workStartMinute: config?.workStartMinute ?? 600,
        workDays: config?.workDays ?? [1, 2, 3, 4, 5, 6],
      });
    } catch (err) {
      throw new ConvexError({
        code: "BAD_REQUEST",
        reason: err instanceof Error ? err.message : "snooze_invalid",
      });
    }

    await ctx.db.patch(args.conversationId, {
      snoozedUntil: until,
      snoozedByUserId: ctx.userId,
      snoozedReason: args.reason?.trim() || undefined,
      ...CLEAR_FORCE,
    });
    return until;
  },
});

export const wake = accountMutation({
  args: { conversationId: v.id("conversations") },
  handler: async (ctx, args) => {
    ctx.requireRole("agent");
    await requireConversationAccess(ctx, args.conversationId, "view");
    await ctx.db.patch(args.conversationId, CLEAR_SNOOZE);
  },
});

export const forceChasing = accountMutation({
  args: { conversationId: v.id("conversations") },
  handler: async (ctx, args) => {
    ctx.requireRole("agent");
    const conversation = await requireConversationAccess(
      ctx,
      args.conversationId,
      "view",
    );
    rejectIfArchived(conversation, "chase_now_blocked_archived");

    // NO OVERRIDE MAY HIDE A CUSTOMER WAITING ON US — the spec's first
    // safety property, and the one this codebase has already broken twice
    // by other means. `awaitingReply === true` means the customer spoke
    // last, so the thread belongs in Active. Forcing it would drop it out
    // of Active into Chasing, which sorts ASCENDING by `lastMessageAt`:
    // a customer who wrote two minutes ago would sort dead last in a cold
    // tab nobody watches.
    //
    // Only the MANUAL path needs this. The automatic direction is already
    // safe: an inbound message clears `chasingForcedAt` inside the same
    // transaction as the message insert (`messages.ts`), so a customer
    // writing to an already-forced thread pulls it straight back to
    // Active — a forced thread can never be `awaitingReply` for longer
    // than that one transaction.
    if (conversation.awaitingReply === true) {
      throw new ConvexError({
        code: "BAD_REQUEST",
        reason: "chase_now_blocked_customer_waiting",
      });
    }

    await ctx.db.patch(args.conversationId, {
      chasingForcedAt: Date.now(),
      chasingForcedByUserId: ctx.userId,
      ...CLEAR_SNOOZE,
    });
  },
});

export const unforceChasing = accountMutation({
  args: { conversationId: v.id("conversations") },
  handler: async (ctx, args) => {
    ctx.requireRole("agent");
    await requireConversationAccess(ctx, args.conversationId, "view");
    await ctx.db.patch(args.conversationId, CLEAR_FORCE);
  },
});

/** Conversations woken per run. Bounded so a burst of same-minute
 *  snoozes cannot make one sweep unboundedly large. */
const WAKE_PER_RUN = 200;

/**
 * Clears every snooze that has come due.
 *
 * This sweep is LOAD-BEARING, not a convenience. `snoozedUntil` in the
 * past is still a present value, so the row keeps failing every lane's
 * `eq(snoozedUntil, undefined)` binding and stays invisible until this
 * runs. A stalled sweep hides conversations silently — which is why the
 * cron is registered through `cronSchedules.ts` (so a stall shows in
 * Settings → Cron schedules) and why the Snoozed tab ranges the
 * complement, keeping the set reachable even if this never fires.
 */
export const sweepSnoozeWake = internalMutation({
  args: {},
  handler: async (ctx): Promise<{ woken: number }> => {
    const now = Date.now();
    const due = await ctx.db
      .query("conversations")
      .withIndex("by_snoozed_until", (q) =>
        q.gt("snoozedUntil", 0).lte("snoozedUntil", now),
      )
      .take(WAKE_PER_RUN);
    for (const conversation of due) {
      await ctx.db.patch(conversation._id, CLEAR_SNOOZE);
    }
    if (due.length > 0) console.log(`[inbox-snooze-wake] woke ${due.length}`);
    return { woken: due.length };
  },
});
