import { v, ConvexError } from "convex/values";
import { action, internalMutation, internalQuery } from "./_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { accountQuery, accountMutation } from "./lib/auth";
import { hasMinRole } from "./lib/roles";
import { sendBlockReason, type SkipReason } from "./lib/revival/select";
import { blockedReason } from "./lib/notes/gate";

// ============================================================
// Revival agent — the human half. `revivalEngine` drafts; nothing here
// invents a message, and nothing anywhere sends one without a person
// tapping send.
//
// The send path is CLAIM-THEN-DISPATCH: `claimForSend` re-checks every
// guard and flips the row to `sent` inside ONE transaction, so a
// double-tap or a stale browser tab cannot dispatch the same nudge
// twice. Only after the claim succeeds does the message go out; if that
// call then fails, `releaseClaim` puts the row back to `pending` so a
// human can retry rather than losing the draft.
// ============================================================

/**
 * The account's pending queue. Member-safe, matching `agentRoster.roster`
 * and `aiConfig.get`: it carries no keys, prompts, models or token
 * counts, only what a person needs to judge a nudge.
 */
export const queue = accountQuery({
  args: {},
  handler: async (ctx) => {
    // Newest first, and never a draft whose window has shut.
    //
    // Both halves matter. `revivalEngine.reapExpired` retires stale rows
    // every 30 minutes, but a draft can expire between sweeps, and a
    // reader must never be offered a nudge that `claimForSend` will
    // refuse. Reading DESC then filtering also means a backlog can only
    // ever push older drafts past the cap, never fresher ones — the
    // failure that made this queue useless read oldest-first.
    const now = Date.now();
    const rows = await ctx.db
      .query("revivalDrafts")
      .withIndex("by_account_status", (q) =>
        q.eq("accountId", ctx.accountId).eq("status", "pending"),
      )
      .order("desc")
      .take(101);

    const live = rows.filter((row) => row.expiresAt > now);

    const drafts = [];
    for (const row of live.slice(0, 100)) {
      const contact = await ctx.db.get(row.contactId);
      drafts.push({
        id: row._id,
        conversationId: row.conversationId,
        contactName: contact?.name ?? contact?.phone ?? "Unknown",
        body: row.body,
        reason: row.reason,
        confidence: row.confidence,
        assignedToUserId: row.assignedToUserId ?? null,
        createdAt: row.createdAt,
        expiresAt: row.expiresAt,
      });
    }
    return { drafts, overflow: live.length > 100 };
  },
});

type ClaimResult =
  | { ok: true; conversationId: Id<"conversations">; body: string }
  | { ok: false; blocked: SkipReason };

/**
 * Re-check every guard and claim the row in one transaction.
 *
 * Claiming BEFORE dispatch rather than marking sent afterwards is
 * deliberate: two taps arriving together both pass a read-only check,
 * but only one can win a transactional status flip. The cost is that a
 * failed dispatch needs `releaseClaim` to undo it, which is the cheaper
 * of the two failure modes — a draft stuck pending is recoverable, a
 * customer messaged twice is not.
 */
export const claimForSend = internalMutation({
  args: {
    draftId: v.id("revivalDrafts"),
    accountId: v.id("accounts"),
    userId: v.id("users"),
    bodyOverride: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<ClaimResult> => {
    const draft = await ctx.db.get(args.draftId);
    if (!draft || draft.accountId !== args.accountId) {
      throw new ConvexError({ code: "NOT_FOUND", entity: "revivalDraft" });
    }

    const conversation = await ctx.db.get(draft.conversationId);
    if (!conversation) {
      throw new ConvexError({ code: "NOT_FOUND", entity: "conversation" });
    }
    const contact = await ctx.db.get(draft.contactId);

    const session = await ctx.db
      .query("qualificationSessions")
      .withIndex("by_conversation", (q) =>
        q.eq("conversationId", draft.conversationId),
      )
      .first();

    const newest = await ctx.db
      .query("messages")
      .withIndex("by_conversation", (q) =>
        q.eq("conversationId", draft.conversationId),
      )
      .order("desc")
      .first();

    const now = Date.now();
    const blocked = sendBlockReason(
      {
        status: draft.status,
        expiresAt: draft.expiresAt,
        draftedAt: draft.createdAt,
        lastMessageAt: conversation.lastMessageAt ?? 0,
        lastMessageInbound: newest?.senderType === "customer",
        snoozedUntil: conversation.snoozedUntil ?? null,
        doNotContact: blockedReason(contact) !== null,
        // Someone can opt out in the hours between a draft being queued
        // and a human tapping send. Session status only — see
        // `revivalEngine` for why `aiAutoreplyDisabled` is not an
        // opt-out signal.
        optedOut: session?.status === "opted_out",
        archived: conversation.archivedAt !== undefined,
        // Neither is consulted by `sendBlockReason`; they exist only
        // because the send check shares `CandidateInput`'s shape, which
        // is what stops the two paths drifting apart.
        qualificationWillNudge: false,
        lastDraftAt: null,
        leadScore: null,
      },
      now,
    );
    if (blocked) return { ok: false, blocked };

    const body = args.bodyOverride?.trim() || draft.body;

    await ctx.db.patch(args.draftId, {
      status: "sent",
      reviewedByUserId: args.userId,
      reviewedAt: now,
      // An edited message is what actually went out, so it is what the
      // row must record — otherwise the audit trail shows a message
      // nobody sent.
      body,
    });

    return { ok: true, conversationId: draft.conversationId, body };
  },
});

/** Undo a claim whose dispatch failed, so the draft can be retried. */
export const releaseClaim = internalMutation({
  args: { draftId: v.id("revivalDrafts") },
  handler: async (ctx, args) => {
    const draft = await ctx.db.get(args.draftId);
    if (!draft || draft.status !== "sent") return;
    await ctx.db.patch(args.draftId, {
      status: "pending",
      reviewedByUserId: undefined,
      reviewedAt: undefined,
    });
  },
});

export const loadForAccess = internalQuery({
  args: { draftId: v.id("revivalDrafts") },
  handler: async (ctx, args) => {
    const draft = await ctx.db.get(args.draftId);
    if (!draft) return null;
    return {
      accountId: draft.accountId,
      conversationId: draft.conversationId,
      assignedToUserId: draft.assignedToUserId ?? null,
    };
  },
});

type SendResult = { ok: true } | { blocked: SkipReason };

/**
 * Approve and send one queued nudge. `agent` role or above, and the
 * caller must be able to act on that conversation — an agent may send
 * their own or an unassigned lead's nudge, supervisor+ any.
 *
 * Returns `{blocked}` rather than throwing for every guard failure, so
 * the queue can say "the customer replied — open the thread instead"
 * rather than surfacing an exception.
 */
export const send = action({
  args: {
    draftId: v.id("revivalDrafts"),
    /** An edited message. Absent means send what the agent drafted. */
    body: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<SendResult> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new ConvexError({ code: "UNAUTHENTICATED" });
    const context = await ctx.runQuery(internal.accounts.accountContextForUser, {
      userId,
    });
    if (!context) throw new ConvexError({ code: "NO_ACCOUNT" });
    if (!hasMinRole(context.role, "agent")) {
      throw new ConvexError({ code: "FORBIDDEN", min: "agent" });
    }

    const meta = await ctx.runQuery(internal.revival.loadForAccess, {
      draftId: args.draftId,
    });
    // Account mismatch is conflated with absence on purpose — the same
    // policy `aiReply.draft` uses, so probing ids leaks nothing.
    if (!meta || meta.accountId !== context.accountId) {
      throw new ConvexError({ code: "NOT_FOUND", entity: "revivalDraft" });
    }

    const claim = await ctx.runMutation(internal.revival.claimForSend, {
      draftId: args.draftId,
      accountId: context.accountId,
      userId,
      ...(args.body !== undefined ? { bodyOverride: args.body } : {}),
    });
    if (!claim.ok) return { blocked: claim.blocked };

    try {
      // The approver's own identity carries into this call — the nudge
      // is sent BY a person, not by the agent on its own authority.
      await ctx.runAction(api.send.send, {
        conversationId: claim.conversationId,
        messageType: "text",
        contentText: claim.body,
      });
    } catch (err) {
      await ctx.runMutation(internal.revival.releaseClaim, {
        draftId: args.draftId,
      });
      throw err;
    }

    return { ok: true };
  },
});

/** Decline a nudge. Records who, so a high dismissal rate is visible
 *  evidence against ever unlocking auto-send. */
export const dismiss = accountMutation({
  args: { draftId: v.id("revivalDrafts") },
  handler: async (ctx, args) => {
    ctx.requireRole("agent");
    const draft = await ctx.db.get(args.draftId);
    if (!draft || draft.accountId !== ctx.accountId) {
      throw new ConvexError({ code: "NOT_FOUND", entity: "revivalDraft" });
    }
    if (draft.status !== "pending") {
      throw new ConvexError({ code: "ALREADY_ACTIONED" });
    }
    await ctx.db.patch(args.draftId, {
      status: "dismissed",
      reviewedByUserId: ctx.userId,
      reviewedAt: Date.now(),
    });
  },
});
