import type { MutationCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";

/**
 * Records a lead charge iff: the feature is on (account.leadValue > 0),
 * the target is an `agent`, and there is no existing charge for this
 * (agent, conversation) pair. Idempotent — releasing + re-claiming your
 * own lead never double-charges; a different agent taking it later pays
 * their own charge. Snapshots value + currency at charge time. No-op
 * otherwise. Call AFTER the assignment patch lands.
 */
export async function chargeLeadIfAgent(
  ctx: { db: MutationCtx["db"] },
  accountId: Id<"accounts">,
  targetUserId: Id<"users">,
  conversationId: Id<"conversations">,
): Promise<void> {
  const account = await ctx.db.get(accountId);
  const leadValue = account?.leadValue ?? 0;
  if (leadValue <= 0) return; // feature off

  const membership = await ctx.db
    .query("memberships")
    .withIndex("by_user_account", (q) =>
      q.eq("userId", targetUserId).eq("accountId", accountId),
    )
    .first();
  if (membership?.role !== "agent") return; // agents only

  const existing = await ctx.db
    .query("leadCharges")
    .withIndex("by_user_conversation", (q) =>
      q.eq("userId", targetUserId).eq("conversationId", conversationId),
    )
    .first();
  if (existing) return; // idempotent

  await ctx.db.insert("leadCharges", {
    accountId,
    userId: targetUserId,
    conversationId,
    value: leadValue,
    currency: account!.defaultCurrency,
  });
}
