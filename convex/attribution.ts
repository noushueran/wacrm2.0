import { internalMutation } from "./_generated/server";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";

export const CODE_REGEX = /HY-[0-9A-HJKMNP-TV-Z]{6}/i;

export function extractRefCode(text: string | undefined | null): string | null {
  if (!text) {
    return null;
  }
  const match = text.match(CODE_REGEX);
  return match ? match[0].toUpperCase() : null;
}

export function extractCtwaClid(msg: { ctwaClid?: string }): string | null {
  return msg.ctwaClid ?? null;
}

// ============================================================
// recordSignal (Task B3) — idempotent, account-scoped write side of
// `attributionSignals` (`convex/schema.ts`). Plain `internalMutation`
// with an explicit caller-supplied `accountId`, not an `accountMutation`:
// the caller is `ingest.processInbound` (Task B4), which — like
// `ingestInbound` itself — runs session-less off a webhook, not a user
// request (same shape as `aiUsage.log`).
// ============================================================

/**
 * First-occurrence-only insert keyed on `(accountId, identifier)`, via
 * the `by_account_identifier` index. An existing row for that pair means
 * this identifier has already been signalled for this account — returns
 * `null` and inserts nothing. Only a fresh insert returns the new id.
 *
 * DESIGN NOTE: returning `null` on a duplicate (rather than the existing
 * row) is deliberate — it lets the caller (B4) schedule the outbound
 * partner-signal action ONLY on a fresh insert, i.e. "fire once per
 * (accountId, identifier)". `landingResult`/`attempts` are not caller
 * args: every fresh row starts `"pending"`/`0`, advanced later by the
 * outbound signal action, not by this mutation.
 */
export const recordSignal = internalMutation({
  args: {
    accountId: v.id("accounts"),
    identifier: v.string(),
    lane: v.union(v.literal("code"), v.literal("ctwa")),
    phone: v.string(),
    waMessageId: v.string(),
    contactId: v.id("contacts"),
    conversationId: v.id("conversations"),
    firstMessageAt: v.number(),
  },
  handler: async (ctx, args): Promise<Id<"attributionSignals"> | null> => {
    const existing = await ctx.db
      .query("attributionSignals")
      .withIndex("by_account_identifier", (q) =>
        q.eq("accountId", args.accountId).eq("identifier", args.identifier),
      )
      .first();
    if (existing) {
      return null;
    }

    return await ctx.db.insert("attributionSignals", {
      ...args,
      landingResult: "pending",
      attempts: 0,
    });
  },
});
