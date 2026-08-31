import type { MutationCtx } from "../../_generated/server";
import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";

// ============================================================
// Automation trigger dispatch for events that are NOT an inbound
// message.
//
// The automations engine only runs when something calls
// `automationsEngine.runForTrigger`. For a long time the only caller was
// `ingest.ts`'s inbound-message path, whose `determineAutomationTriggers`
// emits five trigger types — so the three triggers the builder offers
// that aren't about an inbound message (`tag_added`,
// `conversation_assigned`, `time_based`) accepted config, validated,
// toggled green, and fired nothing. `AutomationContext` had already
// carved out `tagId` ("for a future tag_added trigger") and `agentId`
// ("for conversation_assigned"); this module is that future for the
// two event-shaped ones. `time_based` is not an event at all — it needs
// a cron sweep, not a dispatch helper, so it does not live here.
//
// Every path that raises one of these events routes through here, so a
// trigger fires the same way regardless of WHO caused it — a human in
// the UI, the public API, a flow, AI tagging, qualification, or another
// automation's own step. A trigger that fired for some of those and not
// others would be the same class of half-wired bug this fixes.
// ============================================================

/**
 * The maximum number of automation->automation hops. An automation's
 * `add_tag` or `assign_conversation` step can fire another automation,
 * which can do the same, and so on; `depth` counts those hops and this
 * caps them.
 *
 * Tag cycles are ALREADY bounded in the common case, because callers
 * only dispatch when the state actually changed and `add_tag` is
 * idempotent — re-adding a tag the contact already holds inserts
 * nothing, so a plain A->B->A tag cycle runs dry on its second lap.
 * What that argument does NOT cover is a pair of automations that also
 * `remove_tag`: A (on X) removes X and adds Y, B (on Y) removes Y and
 * adds X, and every hop is a genuine insert forever. Assignment has the
 * same hole (A assigns to agent 1, B assigns to agent 2, forever). This
 * cap is what stops either from becoming an unbounded scheduler loop
 * that bills the account and spams the customer.
 */
export const MAX_TRIGGER_DEPTH = 5;

/** Shared hop-cap + scheduling for every dispatcher below. */
async function dispatch(
  ctx: { scheduler: MutationCtx["scheduler"] },
  triggerType: "tag_added" | "conversation_assigned",
  args: {
    accountId: Id<"accounts">;
    contactId?: Id<"contacts">;
    context: Record<string, unknown>;
    depth: number;
  },
): Promise<void> {
  if (args.depth >= MAX_TRIGGER_DEPTH) {
    console.warn("[automations] trigger depth cap reached, not dispatching", {
      triggerType,
      contactId: args.contactId,
      depth: args.depth,
    });
    return;
  }

  // Scheduled at 0ms rather than awaited: `runForTrigger` is an action
  // (it may send over the network), and a mutation cannot call one
  // inline. That also keeps the caller's own transaction from depending
  // on automation work — a failing automation must never roll back the
  // tag or assignment the user just applied.
  await ctx.scheduler.runAfter(0, internal.automationsEngine.runForTrigger, {
    accountId: args.accountId,
    triggerType,
    contactId: args.contactId,
    context: { ...args.context, depth: args.depth + 1 },
  });
}

/**
 * Fire `tag_added` automations for a tag that was JUST attached.
 *
 * Call this only after an insert that actually happened — never after
 * a no-op "already had that tag" branch (see the cycle reasoning on
 * `MAX_TRIGGER_DEPTH`, which depends on it).
 *
 * `conversationId` is optional and only sharpens which conversation a
 * send-type step targets; `resolveSendTargetQuery` falls back to the
 * contact's own conversation when it is absent.
 */
export async function dispatchTagAdded(
  ctx: { scheduler: MutationCtx["scheduler"] },
  args: {
    accountId: Id<"accounts">;
    contactId: Id<"contacts">;
    tagId: Id<"tags">;
    conversationId?: Id<"conversations">;
    /** Hops so far. Omit (or 0) for anything that isn't an automation. */
    depth?: number;
  },
): Promise<void> {
  await dispatch(ctx, "tag_added", {
    accountId: args.accountId,
    contactId: args.contactId,
    context: { tagId: args.tagId, conversationId: args.conversationId },
    depth: args.depth ?? 0,
  });
}

/**
 * Fire `conversation_assigned` automations for a conversation that was
 * JUST handed to an agent.
 *
 * Call this only when `assignedToUserId` actually CHANGED to a real
 * user — never on an unassign (`undefined`/`null`), and never when the
 * conversation was already assigned to that same agent. Re-saving the
 * same assignee is not an assignment event, and firing on it would let
 * a double-clicked Assign button double-message the customer.
 *
 * Fires for self-assignment too (an agent taking over a thread). The
 * `conversation_assigned` NOTIFICATION deliberately skips that case —
 * you don't need to be told you assigned something to yourself — but
 * the automation is about the customer's experience ("an agent will be
 * with you shortly"), which is identical either way.
 */
export async function dispatchConversationAssigned(
  ctx: { scheduler: MutationCtx["scheduler"] },
  args: {
    accountId: Id<"accounts">;
    conversationId: Id<"conversations">;
    contactId: Id<"contacts">;
    agentId: Id<"users">;
    /** Hops so far. Omit (or 0) for anything that isn't an automation. */
    depth?: number;
  },
): Promise<void> {
  await dispatch(ctx, "conversation_assigned", {
    accountId: args.accountId,
    contactId: args.contactId,
    context: { agentId: args.agentId, conversationId: args.conversationId },
    depth: args.depth ?? 0,
  });
}
