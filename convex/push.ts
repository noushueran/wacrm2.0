import { accountMutation, accountQuery } from "./lib/auth";
import { internalQuery, internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { recipientsForInbound } from "./lib/pushRecipients";
import {
  buildInboundPayload,
  buildQualifiedLeadPayload,
  type PushPayload,
} from "./lib/pushPayload";
import type { AccountRole } from "./lib/roles";

// ---- Client-facing: one device's subscription ------------------------

export const subscribe = accountMutation({
  args: {
    endpoint: v.string(),
    p256dh: v.string(),
    auth: v.string(),
    userAgent: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const existing = await ctx.db
      .query("pushSubscriptions")
      .withIndex("by_endpoint", (q) => q.eq("endpoint", args.endpoint))
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, {
        accountId: ctx.accountId,
        userId: ctx.userId,
        p256dh: args.p256dh,
        auth: args.auth,
        userAgent: args.userAgent,
        lastSeenAt: now,
      });
      return existing._id;
    }
    return await ctx.db.insert("pushSubscriptions", {
      accountId: ctx.accountId,
      userId: ctx.userId,
      endpoint: args.endpoint,
      p256dh: args.p256dh,
      auth: args.auth,
      userAgent: args.userAgent,
      createdAt: now,
      lastSeenAt: now,
    });
  },
});

export const unsubscribe = accountMutation({
  args: { endpoint: v.string() },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("pushSubscriptions")
      .withIndex("by_endpoint", (q) => q.eq("endpoint", args.endpoint))
      .first();
    // Only delete the caller's own subscription.
    if (existing && existing.userId === ctx.userId) {
      await ctx.db.delete(existing._id);
    }
    return null;
  },
});

// ---- Client-facing: per-user preferences -----------------------------

export const getPreferences = accountQuery({
  args: {},
  handler: async (ctx) => {
    const row = await ctx.db
      .query("notificationPreferences")
      .withIndex("by_user_account", (q) =>
        q.eq("userId", ctx.userId).eq("accountId", ctx.accountId),
      )
      .first();
    return {
      pushEnabled: row?.pushEnabled ?? true,
      hidePreview: row?.hidePreview ?? false,
    };
  },
});

export const setPreferences = accountMutation({
  args: {
    pushEnabled: v.optional(v.boolean()),
    hidePreview: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("notificationPreferences")
      .withIndex("by_user_account", (q) =>
        q.eq("userId", ctx.userId).eq("accountId", ctx.accountId),
      )
      .first();
    if (row) {
      await ctx.db.patch(row._id, {
        ...(args.pushEnabled !== undefined ? { pushEnabled: args.pushEnabled } : {}),
        ...(args.hidePreview !== undefined ? { hidePreview: args.hidePreview } : {}),
      });
      return row._id;
    }
    return await ctx.db.insert("notificationPreferences", {
      accountId: ctx.accountId,
      userId: ctx.userId,
      pushEnabled: args.pushEnabled ?? true,
      hidePreview: args.hidePreview ?? false,
    });
  },
});

// ---- Client-facing: account-wide policy (admin) -----------------------
//
// Opt-in, OFF by default: "don't send a push for an inbound message a
// no-code flow fully handled." Read is any-role (so the panel can show
// current state before deciding whether to render the admin control);
// write is admin+, same floor as other critical-settings mutations
// (`aiKnowledge.create`, `aiConfig.upsert`, …).

export const getAccountPushPolicy = accountQuery({
  args: {},
  handler: async (ctx) => {
    const account = await ctx.db.get(ctx.accountId);
    return { suppressBotHandled: account?.suppressBotHandledPush ?? false };
  },
});

export const setAccountPushPolicy = accountMutation({
  args: { suppressBotHandled: v.boolean() },
  handler: async (ctx, args) => {
    ctx.requireRole("admin");
    await ctx.db.patch(ctx.accountId, {
      suppressBotHandledPush: args.suppressBotHandled,
    });
    return null;
  },
});

// ---- Internal: assembly + pruning (called by the Node sender) --------

export const deleteByEndpoint = internalMutation({
  args: { endpoint: v.string() },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("pushSubscriptions")
      .withIndex("by_endpoint", (q) => q.eq("endpoint", args.endpoint))
      .first();
    if (existing) await ctx.db.delete(existing._id);
    return null;
  },
});

export const assembleDelivery = internalQuery({
  args: {
    accountId: v.id("accounts"),
    conversationId: v.id("conversations"),
    contentType: v.string(),
    text: v.optional(v.string()),
    flowConsumed: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const conversation = await ctx.db.get(args.conversationId);
    if (!conversation || conversation.accountId !== args.accountId) {
      return { jobs: [] as { endpoint: string; p256dh: string; auth: string; payload: PushPayload }[] };
    }

    // Opt-in account policy: skip push entirely when a flow fully
    // handled this inbound message. `flowConsumed` undefined = false =
    // never suppresses (backward compatible — default is "notify on
    // every message"). AI-assistant replies never set `flowConsumed`,
    // so they're never suppressed by this gate.
    const account = await ctx.db.get(args.accountId);
    if (args.flowConsumed && account?.suppressBotHandledPush) {
      return { jobs: [] };
    }

    const members = await ctx.db
      .query("memberships")
      .withIndex("by_account", (q) => q.eq("accountId", args.accountId))
      .collect();

    const recipients = recipientsForInbound({
      assignedToUserId: conversation.assignedToUserId ?? null,
      members: members.map((m) => ({ userId: m.userId, role: m.role as AccountRole })),
    });
    if (recipients.length === 0) return { jobs: [] };

    const contact = await ctx.db.get(conversation.contactId);
    const contactName = contact?.name ?? null;

    const jobs: { endpoint: string; p256dh: string; auth: string; payload: PushPayload }[] = [];
    for (const userId of recipients) {
      const prefs = await ctx.db
        .query("notificationPreferences")
        .withIndex("by_user_account", (q) =>
          q.eq("userId", userId).eq("accountId", args.accountId),
        )
        .first();
      if (prefs?.pushEnabled === false) continue;

      const payload = buildInboundPayload({
        contactName,
        contentType: args.contentType,
        text: args.text,
        conversationId: args.conversationId,
        hidePreview: prefs?.hidePreview ?? false,
      });

      const subs = await ctx.db
        .query("pushSubscriptions")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .collect();
      for (const s of subs) {
        if (s.accountId !== args.accountId) continue; // tenant isolation
        jobs.push({ endpoint: s.endpoint, p256dh: s.p256dh, auth: s.auth, payload });
      }
    }
    return { jobs };
  },
});

/**
 * Assembles the qualified-lead push jobs (qualification P2). Recipient
 * rule and per-user preference handling are identical to
 * `assembleDelivery` above (assignee else supervisor+; `pushEnabled`
 * false skips; `hidePreview` collapses the body).
 */
export const assembleQualifiedLeadDelivery = internalQuery({
  args: {
    accountId: v.id("accounts"),
    conversationId: v.id("conversations"),
  },
  handler: async (ctx, args) => {
    const conversation = await ctx.db.get(args.conversationId);
    if (!conversation || conversation.accountId !== args.accountId) {
      return { jobs: [] as { endpoint: string; p256dh: string; auth: string; payload: PushPayload }[] };
    }
    const session = await ctx.db
      .query("qualificationSessions")
      .withIndex("by_conversation", (q) => q.eq("conversationId", args.conversationId))
      .unique();
    if (!session || session.status !== "qualified") return { jobs: [] };
    const contact = await ctx.db.get(conversation.contactId);

    const members = await ctx.db
      .query("memberships")
      .withIndex("by_account", (q) => q.eq("accountId", args.accountId))
      .collect();
    const recipients = recipientsForInbound({
      assignedToUserId: conversation.assignedToUserId ?? null,
      members: members.map((m) => ({ userId: m.userId, role: m.role as AccountRole })),
    });
    if (recipients.length === 0) return { jobs: [] };

    const jobs: { endpoint: string; p256dh: string; auth: string; payload: PushPayload }[] = [];
    for (const userId of recipients) {
      const prefs = await ctx.db
        .query("notificationPreferences")
        .withIndex("by_user_account", (q) =>
          q.eq("userId", userId).eq("accountId", args.accountId),
        )
        .first();
      if (prefs?.pushEnabled === false) continue;

      const payload = buildQualifiedLeadPayload({
        contactName: contact?.name ?? contact?.phone,
        serviceName: session.serviceName,
        score: session.score ?? null,
        conversationId: args.conversationId,
        hidePreview: prefs?.hidePreview ?? false,
      });

      const subs = await ctx.db
        .query("pushSubscriptions")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .collect();
      for (const s of subs) {
        if (s.accountId !== args.accountId) continue; // tenant isolation
        jobs.push({ endpoint: s.endpoint, p256dh: s.p256dh, auth: s.auth, payload });
      }
    }
    return { jobs };
  },
});
