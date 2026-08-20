import type { MutationCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";

/** Which machinery moved the assignment. `kind` (assigned/unassigned) says
 *  what happened to ownership; this says who or what did it, and is what
 *  the thread's line is phrased from. A new entry point adds a literal
 *  here rather than a branch in the renderer. */
export type AssignmentSource =
  | "manual"
  | "takeover"
  | "release"
  | "auto_assign"
  | "automation"
  | "offer_accept";

/**
 * THE way `conversations.assignedToUserId` changes. Patches the field and
 * records the handover in `conversationEvents` in one step, so the two can
 * never drift: seven code paths assign conversations, and seven separate
 * inserts would be seven chances to forget one.
 *
 * Returns `true` when the assignee genuinely changed. Callers use that in
 * place of their own `previousAssignee !== next` guard — the same
 * double-click guard `conversations.assign` carried, now shared.
 *
 * Deliberately does NOT touch `status`: `assign` bumps it to "pending"
 * while `setAutoreplyPaused` documents that it must not, and that
 * divergence belongs with the callers. `bumpUpdatedAt` defaults true;
 * `automationsEngine` passes false because its comment records that
 * matching the legacy path's "no status/updatedAt bump" is deliberate.
 *
 * `ctx` is structurally typed (the `chargeLeadIfAgent` precedent) so this
 * works from `accountMutation` handlers and from the bare
 * `{db, scheduler}` cores in `qualificationEngine.ts` alike.
 */
export async function applyAssignment(
  ctx: { db: MutationCtx["db"] },
  args: {
    conversation: Doc<"conversations">;
    /** `undefined` releases the thread back to the pool. */
    nextAssignee: Id<"users"> | undefined;
    /** Omit when the system did it — that absence is what the UI reads. */
    actorUserId?: Id<"users">;
    source: AssignmentSource;
    bumpUpdatedAt?: boolean;
  },
): Promise<boolean> {
  const { conversation, nextAssignee, actorUserId, source } = args;
  const previous = conversation.assignedToUserId;
  if (previous === nextAssignee) return false;

  await ctx.db.patch(conversation._id, {
    assignedToUserId: nextAssignee,
    ...(args.bumpUpdatedAt === false ? {} : { updatedAt: Date.now() }),
  });

  await ctx.db.insert("conversationEvents", {
    accountId: conversation.accountId,
    conversationId: conversation._id,
    contactId: conversation.contactId,
    kind: nextAssignee ? "assigned" : "unassigned",
    ...(actorUserId ? { actorUserId } : {}),
    ...(nextAssignee ? { targetUserId: nextAssignee } : {}),
    ...(previous ? { previousUserId: previous } : {}),
    source,
  });

  return true;
}
