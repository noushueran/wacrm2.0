import { accountMutation, accountQuery } from "./lib/auth";
import { v, ConvexError } from "convex/values";
import type { Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";

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
    return await ctx.db
      .query("contactNotes")
      .withIndex("by_contact", (q) => q.eq("contactId", args.contactId))
      .order("desc")
      .collect();
  },
});

export const add = accountMutation({
  args: { contactId: v.id("contacts"), body: v.string() },
  handler: async (ctx, args) => {
    ctx.requireRole("agent");
    await requireOwnContact(ctx, args.contactId);

    // The schema's real field is `noteText` (Postgres: `contact_notes.
    // note_text`, confirmed against migration 001_initial_schema.sql
    // and `src/types/index.ts`'s `ContactNote.note_text`) — the public
    // arg here stays named `body` per this task's own API spec, mapped
    // onto the actual storage field below.
    return await ctx.db.insert("contactNotes", {
      accountId: ctx.accountId,
      contactId: args.contactId,
      noteText: args.body,
      createdByUserId: ctx.userId,
    });
  },
});

export const remove = accountMutation({
  args: { noteId: v.id("contactNotes") },
  handler: async (ctx, args) => {
    ctx.requireRole("agent");
    await requireOwnNote(ctx, args.noteId);
    await ctx.db.delete(args.noteId);
  },
});
