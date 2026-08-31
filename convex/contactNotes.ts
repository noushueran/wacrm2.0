import { accountMutation, accountQuery } from "./lib/auth";
import { v, ConvexError } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { parseMediaKey } from "./lib/r2/keys";
import { hasMinRole } from "./lib/roles";
import type { AccountRole } from "./lib/roles";

// ============================================================
// Contact notes — free-text notes an account member leaves on a
// contact. Every write here is `requireRole("agent")` (mirrors
// Postgres's own `contact_notes_insert`/`_update`/`_delete` policies:
// `is_account_member(account_id, 'agent')`); reads have no role floor
// beyond membership (`contact_notes_select`: plain `is_account_member`).
// Built on `accountQuery`/`accountMutation` (never the raw
// `query`/`mutation`), mirroring `contacts.ts`/`customFields.ts`:
// `ctx.accountId` always comes from the caller's own `memberships`
// row, never a client-supplied argument.
// ============================================================

/**
 * Loads a contact and throws `NOT_FOUND` unless it belongs to the
 * caller's own account. Duplicated from `contacts.ts` (private there)
 * — same one-helper-per-file style as `deals.ts`/`customFields.ts`.
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

/**
 * Loads a note and throws `NOT_FOUND` unless it belongs to the
 * caller's own account — the same error for "doesn't exist" and
 * "exists but isn't yours" on purpose (mirrors `requireOwnContact`
 * above), so a cross-account probe can't distinguish the two.
 */
async function requireOwnNote(
  ctx: { db: QueryCtx["db"]; accountId: Id<"accounts"> },
  noteId: Id<"contactNotes">,
) {
  const note = await ctx.db.get(noteId);
  if (!note || note.accountId !== ctx.accountId) {
    throw new ConvexError({ code: "NOT_FOUND", entity: "contactNote" });
  }
  return note;
}

/**
 * A note is its author's to edit or delete; an `admin` may act on
 * anyone's. Engine-written rows have no `createdByUserId`, which makes
 * them admin-only by construction — correct, since they are the audit
 * trail rather than someone's memo.
 *
 * `FORBIDDEN` (not `NOT_FOUND`) is right here: the caller has already
 * proven, via `requireOwnNote`, that the row is inside their own
 * account. Nothing is leaked by admitting it exists.
 */
function requireAuthorOrAdmin(
  ctx: { userId: Id<"users">; role: AccountRole },
  note: { createdByUserId?: Id<"users"> },
) {
  if (note.createdByUserId && note.createdByUserId === ctx.userId) return;
  if (hasMinRole(ctx.role, "admin")) return;
  throw new ConvexError({ code: "FORBIDDEN" });
}

/** Mirrors `src/lib/inbox/notes.ts`'s NOTE_ATTACHMENT_MAX_COUNT. Kept
 *  as a literal rather than imported: `convex/` must not import from
 *  `src/`, and the pair is pinned by tests on both sides. */
const NOTE_ATTACHMENT_MAX_COUNT = 5;

const attachmentValidator = v.object({
  key: v.string(),
  filename: v.string(),
  contentType: v.string(),
  size: v.number(),
});

const kindValidator = v.union(
  v.literal("call"),
  v.literal("whatsapp_external"),
  v.literal("meeting"),
  v.literal("email"),
  v.literal("payment"),
  v.literal("general"),
);

const outcomeValidator = v.union(
  v.literal("no_answer"),
  v.literal("follow_up"),
  v.literal("do_not_contact"),
  v.literal("not_interested"),
);

/**
 * Bounds the attachment list and proves every key belongs to the
 * caller's own account. A key is the ONLY ownership signal an R2 object
 * carries (`convex/lib/r2/keys.ts`), so this is the same check
 * `files.remove` and `send.sendMedia` perform — a foreign OR unparseable
 * key is `NOT_FOUND`, never `FORBIDDEN`, so a probe learns nothing.
 */
function validateAttachments(
  attachments: Array<{ key: string }> | undefined,
  accountId: Id<"accounts">,
) {
  if (!attachments) return;
  if (attachments.length > NOTE_ATTACHMENT_MAX_COUNT) {
    throw new ConvexError({
      code: "TOO_MANY_ATTACHMENTS",
      max: NOTE_ATTACHMENT_MAX_COUNT,
    });
  }
  for (const attachment of attachments) {
    const parsed = parseMediaKey(attachment.key);
    if (!parsed || parsed.accountId !== accountId) {
      throw new ConvexError({ code: "NOT_FOUND", entity: "file" });
    }
  }
}

/**
 * Loads a conversation and throws `NOT_FOUND` unless it belongs to the
 * caller's own account — same non-leaky treatment as
 * `requireOwnContact`.
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
 * Embeds each note's author (name + avatar) so the UI need not fan out
 * one membership query per note. Memberships are cached per userId
 * within the call: a thread is usually two or three agents' notes, so
 * this is a handful of reads rather than one per row.
 *
 * Returns `null` for an engine-written note (no `createdByUserId`) and
 * for an author whose membership has since been removed — the UI renders
 * both as a system entry rather than a missing name.
 */
async function withAuthors(
  ctx: { db: QueryCtx["db"]; accountId: Id<"accounts"> },
  notes: Array<Doc<"contactNotes">>,
) {
  const cache = new Map<
    string,
    { userId: Id<"users">; fullName?: string; avatarUrl?: string } | null
  >();

  const resolve = async (userId: Id<"users">) => {
    const hit = cache.get(userId);
    if (hit !== undefined) return hit;
    // Binds both fields on `by_user_account` rather than scanning
    // `by_user` and re-filtering the account in JS — see
    // `notifications.ts`'s `list` for the same idiom. A `by_user` scan
    // can surface a DIFFERENT account's membership row for a user who
    // belongs to more than one account; a JS filter on that result
    // isn't a leak (it correctly rejects the wrong-account row) but it
    // does misresolve a genuine same-account author to `null`.
    const membership = await ctx.db
      .query("memberships")
      .withIndex("by_user_account", (q) =>
        q.eq("userId", userId).eq("accountId", ctx.accountId),
      )
      .first();
    const value = membership
      ? {
          userId,
          fullName: membership.fullName,
          avatarUrl: membership.avatarUrl,
        }
      : null;
    cache.set(userId, value);
    return value;
  };

  return await Promise.all(
    notes.map(async (note) => ({
      ...note,
      author: note.createdByUserId ? await resolve(note.createdByUserId) : null,
    })),
  );
}

export const listForContact = accountQuery({
  args: { contactId: v.id("contacts") },
  handler: async (ctx, args) => {
    await requireOwnContact(ctx, args.contactId);

    // `by_contact` binds its only field via `.eq` below, so the sole
    // remaining sort key is the implicit `_creationTime` —
    // `.order("desc")` gives newest-first, matching
    // `ContactDetailView.fetchNotes`'s own
    // `.order('created_at', { ascending: false })` (mirrors
    // `messages.listByConversation`'s identical reasoning).
    const notes = await ctx.db
      .query("contactNotes")
      .withIndex("by_contact", (q) => q.eq("contactId", args.contactId))
      .order("desc")
      .collect();
    return await withAuthors(ctx, notes);
  },
});

/**
 * One conversation's notes, OLDEST first — the thread renders them in
 * chronological order alongside messages, unlike the sidebar's
 * newest-first log.
 *
 * A note with no `conversationId` (engine-written, or added from the
 * contacts page) is deliberately absent: it belongs to the contact, not
 * to any one thread, and the sidebar is where it surfaces.
 */
export const listForConversation = accountQuery({
  args: { conversationId: v.id("conversations") },
  handler: async (ctx, args) => {
    await requireOwnConversation(ctx, args.conversationId);
    const notes = await ctx.db
      .query("contactNotes")
      .withIndex("by_conversation", (q) =>
        q.eq("conversationId", args.conversationId),
      )
      .order("asc")
      .collect();
    return await withAuthors(ctx, notes);
  },
});

export const add = accountMutation({
  args: {
    contactId: v.id("contacts"),
    body: v.string(),
    conversationId: v.optional(v.id("conversations")),
    kind: v.optional(kindValidator),
    outcome: v.optional(outcomeValidator),
    attachments: v.optional(v.array(attachmentValidator)),
  },
  handler: async (ctx, args) => {
    ctx.requireRole("agent");
    await requireOwnContact(ctx, args.contactId);
    if (args.conversationId) {
      const conversation = await requireOwnConversation(ctx, args.conversationId);
      // Both `contactId` and `conversationId` are proven same-account by
      // the two checks above, so this isn't a tenant leak either way —
      // but a note filed against a mismatched pair would still render in
      // the WRONG thread (`listForConversation` trusts `conversationId`
      // alone). `NOT_FOUND`/`"conversation"` matches this file's
      // established non-leaky convention for "doesn't exist or isn't
      // yours" rather than introducing a new error shape.
      if (conversation.contactId !== args.contactId) {
        throw new ConvexError({ code: "NOT_FOUND", entity: "conversation" });
      }
    }
    validateAttachments(args.attachments, ctx.accountId);

    // The schema's real field is `noteText`; the public arg stays `body`
    // per this module's original API (see the file header).
    const noteId = await ctx.db.insert("contactNotes", {
      accountId: ctx.accountId,
      contactId: args.contactId,
      conversationId: args.conversationId,
      noteText: args.body,
      kind: args.kind,
      outcome: args.outcome,
      attachments: args.attachments,
      createdByUserId: ctx.userId,
    });

    // The one outcome with teeth. Denormalised onto the contact so the
    // Phase 3 automation gates are an O(1) field read rather than a note
    // scan on every inbound message. Overwrites any earlier flag: the
    // most recent refusal is the one that carries the reason.
    if (args.outcome === "do_not_contact") {
      await ctx.db.patch(args.contactId, {
        doNotContact: { at: Date.now(), byUserId: ctx.userId, noteId },
      });
      // Task 5, cancellation path 4: a customer who just opted out must
      // not still receive whatever automation send is queued behind a
      // `wait`. Scheduled, not inline — a mutation can't call another
      // mutation directly, only `ctx.scheduler` reaches one.
      await ctx.scheduler.runAfter(0, internal.automationsEngine.cancelRunsForContact, {
        accountId: ctx.accountId,
        contactId: args.contactId,
        reason: "contact opted out",
      });
    }

    return noteId;
  },
});

export const update = accountMutation({
  args: {
    noteId: v.id("contactNotes"),
    body: v.optional(v.string()),
    kind: v.optional(kindValidator),
    outcome: v.optional(outcomeValidator),
    attachments: v.optional(v.array(attachmentValidator)),
  },
  handler: async (ctx, args) => {
    ctx.requireRole("agent");
    const note = await requireOwnNote(ctx, args.noteId);
    requireAuthorOrAdmin(ctx, note);
    validateAttachments(args.attachments, ctx.accountId);

    // A do-not-contact note's OUTCOME is frozen. `clearDoNotContact` is
    // the single path that lifts the flag, and it is supervisor-gated
    // and audited — editing the note must not be a back door around
    // that. The note's TEXT stays editable (a typo in the reason is
    // still worth fixing).
    if (note.outcome === "do_not_contact" && args.outcome !== undefined) {
      throw new ConvexError({ code: "DO_NOT_CONTACT_LOCKED" });
    }

    await ctx.db.patch(args.noteId, {
      ...(args.body !== undefined ? { noteText: args.body } : {}),
      ...(args.kind !== undefined ? { kind: args.kind } : {}),
      ...(args.outcome !== undefined ? { outcome: args.outcome } : {}),
      ...(args.attachments !== undefined
        ? { attachments: args.attachments }
        : {}),
      editedAt: Date.now(),
    });

    // Mirrors `add`'s denormalisation. The lock above only stops an
    // ALREADY-do_not_contact note from changing outcome — it says
    // nothing about a note that is being edited INTO do_not_contact
    // for the first time. Phase 3's automation gates (auto-reply,
    // chase sweep, broadcasts) read only `contacts.doNotContact`, so
    // if this path doesn't arm it too, the note says "do not contact"
    // while the contact keeps getting messaged. `note.contactId` is
    // already known-safe: `requireOwnNote` above proved the row is in
    // the caller's own account, so no extra ownership check is needed.
    if (args.outcome === "do_not_contact") {
      await ctx.db.patch(note.contactId, {
        doNotContact: { at: Date.now(), byUserId: ctx.userId, noteId: args.noteId },
      });
      // Same as `add` above — see that call's own comment.
      await ctx.scheduler.runAfter(0, internal.automationsEngine.cancelRunsForContact, {
        accountId: ctx.accountId,
        contactId: note.contactId,
        reason: "contact opted out",
      });
    }

    return null;
  },
});

export const remove = accountMutation({
  args: { noteId: v.id("contactNotes") },
  handler: async (ctx, args) => {
    ctx.requireRole("agent");
    const note = await requireOwnNote(ctx, args.noteId);
    // Tightened from "any agent" — a shared audit trail nobody owns is
    // one an agent can quietly edit history in.
    requireAuthorOrAdmin(ctx, note);

    // Deliberately does NOT clear `contacts.doNotContact`. See that
    // field's own comment in schema.ts: a customer's stated wish must
    // outlive an agent tidying up their notes.
    //
    // The R2 objects behind `note.attachments` are intentionally NOT
    // deleted here either — orphan cleanup is a Phase 2 concern once
    // the sidebar can also delete, and a leaked object is a storage
    // nit while a wrongly-deleted passport scan is not.
    await ctx.db.delete(args.noteId);
    return null;
  },
});

export const clearDoNotContact = accountMutation({
  args: { contactId: v.id("contacts") },
  handler: async (ctx, args) => {
    // Supervisor floor: this overrides something the CUSTOMER asked
    // for, which is a different class of act from writing a note.
    ctx.requireRole("supervisor");
    const contact = await requireOwnContact(ctx, args.contactId);
    if (!contact.doNotContact) return null;

    // Stamp the note that raised the flag, so it stops reading as an
    // active block. Guarded: Phase 1 deliberately let `doNotContact`
    // outlive the note that set it (deleting a note must not silently
    // lift the customer's stated wish), so `noteId` can be dangling —
    // this must not throw when it is.
    const origin = await ctx.db.get(contact.doNotContact.noteId);
    if (origin && origin.accountId === ctx.accountId) {
      await ctx.db.patch(origin._id, { outcomeClearedAt: Date.now() });
    }

    // Audit first, so the trail exists even if the patch below is the
    // last thing this transaction does.
    await ctx.db.insert("contactNotes", {
      accountId: ctx.accountId,
      contactId: args.contactId,
      noteText: "Do-not-contact flag cleared.",
      kind: "general",
      createdByUserId: ctx.userId,
    });
    await ctx.db.patch(args.contactId, { doNotContact: undefined });
    return null;
  },
});
