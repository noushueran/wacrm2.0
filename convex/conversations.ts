import { accountMutation, accountQuery } from "./lib/auth";
import { internalMutation, internalQuery } from "./_generated/server";
import { v, ConvexError } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { insertNotification } from "./notifications";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { conversationScope, canAccessConversation } from "./lib/roles";
import { requireConversationAccess } from "./lib/conversationAccess";

// ============================================================
// Conversations — the Inbox list/thread read (`list`/`get`/
// `getByContact`/`unreadTotal`) plus the mutations that drive its write
// side: `findOrCreateForContact`, `assign`, `unassign`, `setStatus`,
// `markRead`. Every function here is built on `accountQuery`/
// `accountMutation` (never the raw `query`/`mutation`), mirroring the
// account-isolation pattern `contacts.ts` establishes: `ctx.accountId`
// always comes from the caller's own `memberships` row, never a
// client-supplied argument (there is no `accountId` field in any args
// validator below).
// ============================================================

/**
 * Attaches this contact's `tags` (via the `contactTags` join table).
 * Mirrors `contacts.ts`'s own `embedTags` byte-for-byte — that helper
 * is private to `contacts.ts` (not exported), so it's duplicated here
 * rather than importing across verticals, matching the codebase's
 * existing one-helper-per-file style (each of `contacts.ts`/`tags.ts`
 * only ever reads its own table's shape).
 */
async function embedTags(ctx: QueryCtx, contact: Doc<"contacts">) {
  const links = await ctx.db
    .query("contactTags")
    .withIndex("by_contact", (q) => q.eq("contactId", contact._id))
    .collect();
  const tags = (
    await Promise.all(links.map((link) => ctx.db.get(link.tagId)))
  ).filter((tag): tag is Doc<"tags"> => tag !== null);
  return { ...contact, tags };
}

/**
 * Embeds a conversation's `contact` (+ that contact's `tags`) for
 * display, so the Inbox list/thread view never needs a second
 * round-trip. `contactId` has no DB-level referential integrity in
 * Convex (and `contacts.remove` has no cascade onto `conversations`
 * today), so the contact can in principle be missing — `contact: null`
 * covers that defensively rather than throwing.
 */
async function embedContact(
  ctx: QueryCtx,
  conversation: Doc<"conversations">,
) {
  const contact = await ctx.db.get(conversation.contactId);
  return {
    ...conversation,
    contact: contact ? await embedTags(ctx, contact) : null,
  };
}

export const list = accountQuery({
  args: {
    status: v.optional(
      v.union(v.literal("open"), v.literal("pending"), v.literal("closed")),
    ),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    const { status, paginationOpts } = args;
    const scope = conversationScope(ctx.role);

    const base = ctx.db
      .query("conversations")
      .withIndex("by_account_last_message", (q) =>
        q.eq("accountId", ctx.accountId),
      )
      .order("desc");

    // Compose the optional status filter with the role visibility scope.
    // `own_and_pool` = assigned to me OR unassigned; `unassigned` = the
    // pool only; `all` = no extra predicate.
    const query =
      status || scope !== "all"
        ? base.filter((q) => {
            const parts = [];
            if (status) parts.push(q.eq(q.field("status"), status));
            if (scope === "own_and_pool") {
              parts.push(
                q.or(
                  q.eq(q.field("assignedToUserId"), ctx.userId),
                  q.eq(q.field("assignedToUserId"), undefined),
                ),
              );
            } else if (scope === "unassigned") {
              parts.push(q.eq(q.field("assignedToUserId"), undefined));
            }
            return parts.reduce((a, b) => q.and(a, b));
          })
        : base;

    const result = await query.paginate(paginationOpts);

    const page = await Promise.all(
      result.page.map((conversation) => embedContact(ctx, conversation)),
    );
    return { ...result, page };
  },
});

export const get = accountQuery({
  args: { conversationId: v.id("conversations") },
  handler: async (ctx, args) => {
    const conversation = await requireConversationAccess(
      ctx,
      args.conversationId,
      "view",
    );
    return await embedContact(ctx, conversation);
  },
});

/**
 * The contact's own conversation, or `null` if no thread has been
 * opened for them yet — the read the deal-form "Link to Conversation"
 * banner needs (Phase 8, Task 3). Ownership is checked on the CONTACT
 * (mirrors `findOrCreateForContact`'s own check below) rather than on
 * a conversation id, since the caller may not know whether a
 * conversation exists at all yet. Unlike `findOrCreateForContact`,
 * this never creates one — a deal can exist before any inbound/
 * outbound WhatsApp message ever happened for its contact, and the
 * banner only needs to know whether a thread exists to link to.
 */
export const getByContact = accountQuery({
  args: { contactId: v.id("contacts") },
  handler: async (ctx, args) => {
    const contact = await ctx.db.get(args.contactId);
    if (!contact || contact.accountId !== ctx.accountId) {
      throw new ConvexError({ code: "NOT_FOUND", entity: "contact" });
    }

    const conversation = await ctx.db
      .query("conversations")
      .withIndex("by_contact", (q) => q.eq("contactId", args.contactId))
      .filter((q) => q.eq(q.field("accountId"), ctx.accountId))
      .first();
    if (!conversation) return null;
    const allowed = canAccessConversation(
      ctx.role,
      {
        isMine: conversation.assignedToUserId === ctx.userId,
        isUnassigned: conversation.assignedToUserId === undefined,
      },
      "view",
    );
    if (!allowed) return null;
    return await embedContact(ctx, conversation);
  },
});

/**
 * Count of the account's conversations with `unreadCount > 0` — the
 * sidebar's unread nav badge (Phase 8/9 stragglers: the Convex
 * counterpart to `src/hooks/use-total-unread.ts`, which currently sums
 * this client-side from a Supabase realtime subscription). Ranges over
 * `by_account` (not `by_account_last_message`, which `list` uses)
 * since ordering is irrelevant to a count; the `> 0` test has no index
 * boundary to range on, so it's a JS filter over the account's full
 * conversation set rather than an index-level range — matching this
 * account's conversation volume being small enough that this isn't a
 * concern (same assumption `list`'s own pagination already leans on).
 */
export const unreadTotal = accountQuery({
  args: {},
  handler: async (ctx) => {
    const scope = conversationScope(ctx.role);
    const conversations = await ctx.db
      .query("conversations")
      .withIndex("by_account", (q) => q.eq("accountId", ctx.accountId))
      .collect();
    return conversations.filter((c) => {
      if (c.unreadCount <= 0) return false;
      if (scope === "all") return true;
      if (scope === "own_and_pool")
        return c.assignedToUserId === ctx.userId || c.assignedToUserId === undefined;
      return c.assignedToUserId === undefined; // viewer: pool only
    }).length;
  },
});

// ============================================================
// Conversation mutations (Phase 2, Task 3) — creating a thread for a
// contact, assigning it, changing its status, and marking it read.
// Every mutation asserts ownership of its target conversation via
// `requireOwnConversation` before writing.
// ============================================================

/**
 * Loads a conversation and throws `NOT_FOUND` unless it belongs to the
 * caller's own account — the same error for "doesn't exist" and
 * "exists but isn't yours" on purpose (mirrors `get` above and
 * `messages.ts`'s own `requireOwnConversation`). Duplicated from
 * `messages.ts` rather than imported, matching this codebase's
 * one-helper-per-file style (see `embedTags`'s own comment above for
 * the same reasoning) — `messages.ts` needs this to guard message
 * reads/writes, this file needs it to guard the mutations below.
 */
async function requireOwnConversation(
  ctx: { db: QueryCtx["db"]; accountId: Id<"accounts"> },
  conversationId: Id<"conversations">,
) {
  const conversation = await ctx.db.get(conversationId);
  if (!conversation || conversation.accountId !== ctx.accountId) {
    throw new ConvexError({ code: "NOT_FOUND", entity: "conversation" });
  }
  return conversation;
}

/**
 * Returns the existing thread for a contact, or opens a new one.
 * `by_contact` isn't itself account-scoped (see schema.ts), so the
 * match is additionally filtered to `ctx.accountId` — defense-in-depth
 * that doesn't actually change behavior today (a contact only ever
 * belongs to one account, and the ownership check above already proves
 * it's this caller's own, so no other account's conversation could
 * share its `contactId`), matching `contacts.ts`'s own "re-check the
 * target row's accountId, don't rely solely on the index" philosophy.
 */
export const findOrCreateForContact = accountMutation({
  args: { contactId: v.id("contacts") },
  handler: async (ctx, args) => {
    ctx.requireRole("agent");
    const contact = await ctx.db.get(args.contactId);
    if (!contact || contact.accountId !== ctx.accountId) {
      throw new ConvexError({ code: "NOT_FOUND", entity: "contact" });
    }

    const existing = await ctx.db
      .query("conversations")
      .withIndex("by_contact", (q) => q.eq("contactId", args.contactId))
      .filter((q) => q.eq(q.field("accountId"), ctx.accountId))
      .first();
    if (existing) return existing._id;

    return await ctx.db.insert("conversations", {
      accountId: ctx.accountId,
      contactId: args.contactId,
      status: "open",
      unreadCount: 0,
    });
  },
});

/**
 * Server-only counterpart to `findOrCreateForContact` above, for
 * `send.ts`'s public `send` action (Phase 8, Task 4) — an action has no
 * `ctx.db`/user session of its own (same reasoning as `messages.ts`'s
 * `appendInternal`), so `accountId` is an explicit, caller-supplied
 * argument instead of `ctx.accountId`. Otherwise byte-for-byte the same
 * find-or-create body: verify the contact belongs to `accountId`, reuse
 * `by_contact` + an `accountId` filter (see `findOrCreateForContact`'s
 * own comment for why that filter is defense-in-depth, not
 * load-bearing), insert if none exists.
 */
export const findOrCreateForContactInternal = internalMutation({
  args: { accountId: v.id("accounts"), contactId: v.id("contacts") },
  handler: async (ctx, args) => {
    const contact = await ctx.db.get(args.contactId);
    if (!contact || contact.accountId !== args.accountId) {
      throw new ConvexError({ code: "NOT_FOUND", entity: "contact" });
    }

    const existing = await ctx.db
      .query("conversations")
      .withIndex("by_contact", (q) => q.eq("contactId", args.contactId))
      .filter((q) => q.eq(q.field("accountId"), args.accountId))
      .first();
    if (existing) return existing._id;

    return await ctx.db.insert("conversations", {
      accountId: args.accountId,
      contactId: args.contactId,
      status: "open",
      unreadCount: 0,
    });
  },
});

/**
 * Assigns a conversation to an account teammate and bumps it to
 * "pending" — the agent now owns following up. `userId` must itself be
 * a member of this same account (checked via `by_user_account`); an
 * arbitrary/foreign user id is rejected the same way a missing/foreign
 * conversation is, so a cross-account probe can't distinguish "no such
 * user" from "not your teammate".
 *
 * Also notifies the assignee (`convex/notifications.ts`'s
 * `insertNotification`) — the Convex counterpart to migration 027's
 * `notify_conversation_assigned` trigger. Skipped for self-assignment
 * (mirrors the trigger's own `auth.uid() = NEW.assigned_agent_id`
 * guard): nothing to notify an agent about when they assigned the
 * conversation to themselves.
 */
export const assign = accountMutation({
  args: { conversationId: v.id("conversations"), userId: v.id("users") },
  handler: async (ctx, args) => {
    ctx.requireRole("agent");
    const conversation = await requireOwnConversation(ctx, args.conversationId);

    const membership = await ctx.db
      .query("memberships")
      .withIndex("by_user_account", (q) =>
        q.eq("userId", args.userId).eq("accountId", ctx.accountId),
      )
      .first();
    if (!membership) {
      throw new ConvexError({ code: "NOT_FOUND", entity: "member" });
    }

    await ctx.db.patch(args.conversationId, {
      assignedToUserId: args.userId,
      status: "pending",
      updatedAt: Date.now(),
    });

    if (args.userId !== ctx.userId) {
      const [contact, actorMembership] = await Promise.all([
        ctx.db.get(conversation.contactId),
        ctx.db
          .query("memberships")
          .withIndex("by_user_account", (q) =>
            q.eq("userId", ctx.userId).eq("accountId", ctx.accountId),
          )
          .first(),
      ]);
      // COALESCE(NULLIF(name, ''), phone) / COALESCE(actor, 'Someone') —
      // same fallback chain as migration 027's trigger body text.
      const contactName = contact?.name || contact?.phone || "a contact";
      const actorName = actorMembership?.fullName || "Someone";

      await insertNotification(ctx, {
        accountId: ctx.accountId,
        userId: args.userId,
        type: "conversation_assigned",
        conversationId: args.conversationId,
        contactId: conversation.contactId,
        actorUserId: ctx.userId,
        title: "New conversation assigned",
        body: `${actorName} assigned you a conversation with ${contactName}`,
      });
    }

    return args.conversationId;
  },
});

/**
 * Clears a conversation's assignment — the inverse of `assign`, for
 * the Inbox's "Unassign" dropdown option and the "Resume AI" banner
 * (Phase 8/9 stragglers): `assign` requires a concrete `userId`, so it
 * has no way to represent "nobody owns this anymore." `assignedToUserId`
 * is an optional field, and patching it to `undefined` removes it —
 * the same idiom `templates.ts`'s `submissionError: undefined` uses to
 * clear an optional field, rather than a special-cased "unset" API.
 *
 * `status` is deliberately left untouched. This mirrors the legacy
 * Supabase write it replaces (`src/components/inbox/message-
 * thread.tsx`'s `handleAssignChange`, the "Unassign" branch), which
 * only ever cleared `assigned_agent_id` and never touched `status` —
 * unlike `assign`, which bumps status to "pending" because assigning
 * is itself the start of someone actively working the thread, clearing
 * the assignee isn't itself a statement about whether the conversation
 * is still open, pending, or closed. Callers that also want a status
 * change (e.g. reopening) call `setStatus` explicitly. There's also no
 * notification to fire in reverse — unassigning notifies nobody, since
 * there's no `notify_conversation_assigned`-style trigger for it in the
 * original schema.
 */
export const unassign = accountMutation({
  args: { conversationId: v.id("conversations") },
  handler: async (ctx, args) => {
    ctx.requireRole("agent");
    await requireOwnConversation(ctx, args.conversationId);
    await ctx.db.patch(args.conversationId, {
      assignedToUserId: undefined,
      updatedAt: Date.now(),
    });
    return args.conversationId;
  },
});

/**
 * Toggle the AI auto-reply bot for one conversation — the Inbox's
 * "Take over" / "Resume AI" banner. Convex port of `src/app/api/ai/
 * autoreply/[conversationId]/route.ts`'s POST handler (lines ~44-99).
 *
 * `paused: true` (Take over) — sets `aiAutoreplyDisabled`; when
 * `assignToMe` is also set, assigns the thread to the caller too
 * (mirrors the route's `if (assign_to_me) update.assigned_agent_id =
 * userId`). Since the assignee here is ALWAYS the caller themselves,
 * this is exactly the self-assignment case `conversations.assign`'s own
 * notification step exempts — see that mutation's doc comment — so no
 * `insertNotification` call is needed here either; it would only ever
 * no-op.
 *
 * `paused: false` (Resume AI) — clears the pause, releases ANY
 * assignment (not just the caller's own — the route's own comment: a
 * stale assignee from a prior handoff would otherwise keep the "human
 * owns this" eligibility gate tripped and make Resume AI a no-op), and
 * gives the bot a fresh reply budget (`aiReplyCount: 0`) + clears the
 * handoff note. `status` is deliberately left untouched in BOTH
 * branches, exactly like the route — unlike `assign`, which bumps it to
 * "pending".
 */
export const setAutoreplyPaused = accountMutation({
  args: {
    conversationId: v.id("conversations"),
    paused: v.boolean(),
    assignToMe: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    ctx.requireRole("agent");
    await requireOwnConversation(ctx, args.conversationId);

    if (args.paused) {
      await ctx.db.patch(args.conversationId, {
        aiAutoreplyDisabled: true,
        updatedAt: Date.now(),
        ...(args.assignToMe ? { assignedToUserId: ctx.userId } : {}),
      });
    } else {
      await ctx.db.patch(args.conversationId, {
        aiAutoreplyDisabled: false,
        assignedToUserId: undefined,
        aiReplyCount: 0,
        aiHandoffSummary: undefined,
        updatedAt: Date.now(),
      });
    }

    return { success: true as const, paused: args.paused };
  },
});

export const setStatus = accountMutation({
  args: {
    conversationId: v.id("conversations"),
    status: v.union(
      v.literal("open"),
      v.literal("pending"),
      v.literal("closed"),
    ),
  },
  handler: async (ctx, args) => {
    ctx.requireRole("agent");
    await requireOwnConversation(ctx, args.conversationId);
    await ctx.db.patch(args.conversationId, {
      status: args.status,
      updatedAt: Date.now(),
    });
    return args.conversationId;
  },
});

/**
 * Zeroes `unreadCount` — the Inbox calls this the moment an agent opens
 * a thread. No `updatedAt` bump here: unlike `assign`/`setStatus`,
 * reading a thread isn't a change to the conversation's own state an
 * agent would expect reflected in "last updated" (matches the task
 * brief's own spec for this mutation).
 */
export const markRead = accountMutation({
  args: { conversationId: v.id("conversations") },
  handler: async (ctx, args) => {
    ctx.requireRole("agent");
    await requireOwnConversation(ctx, args.conversationId);
    await ctx.db.patch(args.conversationId, { unreadCount: 0 });
    return args.conversationId;
  },
});

/**
 * Resolves the Meta recipient phone (+ optional reply context) for a
 * conversation, scoped to `accountId` — the piece `send.ts`'s public
 * `send` action and `metaSend.sendReaction` both need before they can
 * call into `metaSend.ts`'s actions, which take `to`/`contextMessageId`
 * directly rather than a `conversationId` (see that module's header
 * comment on why the contact-phone lookup was deliberately left OUT of
 * those actions — this query is exactly that lookup, resurrected for
 * the two callers that DO still need it). An `internalQuery` rather
 * than folded into `metaSend.ts` itself, since it reads
 * `conversations`/`contacts`/`messages` — tables that file has never
 * needed to touch directly.
 *
 * Doubles as both callers' tenancy gate: throws the same `NOT_FOUND`
 * "doesn't exist" / "exists but isn't yours" conflation
 * `requireOwnConversation` uses elsewhere in this file, for either a
 * foreign `conversationId` or a `replyToMessageId` that exists but
 * belongs to a different conversation — so a cross-account probe can't
 * distinguish "no such row" from "not yours" via either argument.
 *
 * A reply target that exists (in this conversation) but has no Meta
 * `messageId` yet (still sending, or failed) is NOT an error —
 * `contextMessageId` comes back `undefined` and the send proceeds
 * without reply context, mirroring `src/lib/whatsapp/send-message.ts`'s
 * own "warn and send without context" handling for the same case.
 */
export const resolveSendTarget = internalQuery({
  args: {
    accountId: v.id("accounts"),
    conversationId: v.id("conversations"),
    replyToMessageId: v.optional(v.id("messages")),
  },
  handler: async (ctx, args) => {
    const conversation = await ctx.db.get(args.conversationId);
    if (!conversation || conversation.accountId !== args.accountId) {
      throw new ConvexError({ code: "NOT_FOUND", entity: "conversation" });
    }
    const contact = await ctx.db.get(conversation.contactId);
    if (!contact) {
      throw new ConvexError({ code: "NOT_FOUND", entity: "contact" });
    }

    let contextMessageId: string | undefined;
    if (args.replyToMessageId) {
      const parent = await ctx.db.get(args.replyToMessageId);
      if (!parent || parent.conversationId !== args.conversationId) {
        throw new ConvexError({ code: "NOT_FOUND", entity: "replyToMessage" });
      }
      contextMessageId = parent.messageId;
    }

    return { to: contact.phone, contextMessageId };
  },
});
