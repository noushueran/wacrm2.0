import { accountMutation, accountQuery } from "./lib/auth";
import { v, ConvexError } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { normalizePhone } from "./lib/phone";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";

// ============================================================
// Contacts — the reference vertical for the account-isolation model.
// Every function here is built on `accountQuery`/`accountMutation`
// (never the raw `query`/`mutation`), so `ctx.accountId` always comes
// from the caller's own `memberships` row, never from a client-supplied
// argument — there is no `accountId` field in any args validator below.
// Every write additionally re-checks the target row's own `accountId`
// before mutating it (defense-in-depth: the guarantee doesn't rely
// solely on "the index we queried by happened to be account-scoped").
// ============================================================

/**
 * Attaches this contact's `tags` (via the `contactTags` join table) for
 * display. Read-only, so it's safe to share between `list` and
 * `filterByTags` (both `accountQuery`s — a plain `QueryCtx` is
 * structurally satisfied by either's injected ctx).
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
 * Loads a contact and throws `NOT_FOUND` unless it belongs to the
 * caller's own account — the same error for "doesn't exist" and
 * "exists but isn't yours" on purpose, so a cross-account probe can't
 * distinguish the two. Used by every write below.
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

export const create = accountMutation({
  args: {
    phone: v.string(),
    name: v.optional(v.string()),
    email: v.optional(v.string()),
    company: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    ctx.requireRole("agent");
    const phoneNormalized = normalizePhone(args.phone);
    const dup = await ctx.db
      .query("contacts")
      .withIndex("by_account_phone", (q) =>
        q.eq("accountId", ctx.accountId).eq("phoneNormalized", phoneNormalized),
      )
      .first();
    if (dup) {
      throw new ConvexError({ code: "DUPLICATE_PHONE", contactId: dup._id });
    }
    return await ctx.db.insert("contacts", {
      accountId: ctx.accountId,
      createdByUserId: ctx.userId,
      phone: args.phone,
      phoneNormalized,
      name: args.name,
      email: args.email,
      company: args.company,
    });
  },
});

export const list = accountQuery({
  args: {
    search: v.optional(v.string()),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    const { search, paginationOpts } = args;

    // `search_name` only covers `name` (see convex/schema.ts) — phone/
    // email search for the paginated list view is left as a documented
    // gap (see the schema's "Search note"); `filterByTags` below is
    // where full name/phone/email search is actually needed and
    // implemented, since it already materializes full docs in memory.
    const result = search
      ? await ctx.db
          .query("contacts")
          .withSearchIndex("search_name", (q) =>
            q.search("name", search).eq("accountId", ctx.accountId),
          )
          .paginate(paginationOpts)
      : await ctx.db
          .query("contacts")
          .withIndex("by_account", (q) => q.eq("accountId", ctx.accountId))
          .order("desc")
          .paginate(paginationOpts);

    const page = await Promise.all(
      result.page.map((contact) => embedTags(ctx, contact)),
    );
    return { ...result, page };
  },
});

export const filterByTags = accountQuery({
  args: {
    tagIds: v.array(v.id("tags")),
    search: v.optional(v.string()),
    limit: v.number(),
    offset: v.number(),
  },
  handler: async (ctx, args) => {
    const { tagIds, search, limit, offset } = args;

    // OR across tags: union every matching contactId (Set dedupes a
    // contact that matches more than one selected tag).
    const contactIds = new Set<Id<"contacts">>();
    for (const tagId of tagIds) {
      const links = await ctx.db
        .query("contactTags")
        .withIndex("by_tag", (q) => q.eq("tagId", tagId))
        .collect();
      for (const link of links) contactIds.add(link.contactId);
    }

    // Defense-in-depth: a tagId only ever comes from the caller's own
    // account in the UI, but nothing stops a caller from supplying
    // another account's real tagId — `contactTags.by_tag` would then
    // return that other account's contact links. Drop nulls (stale
    // link) and anything whose own `accountId` doesn't match before it
    // can ever reach the response.
    const fetched = await Promise.all(
      [...contactIds].map((id) => ctx.db.get(id)),
    );
    const contacts = fetched.filter(
      (contact): contact is Doc<"contacts"> =>
        contact !== null && contact.accountId === ctx.accountId,
    );

    const term = search?.trim().toLowerCase();
    const matched = term
      ? contacts.filter(
          (contact) =>
            contact.name?.toLowerCase().includes(term) ||
            contact.phone.toLowerCase().includes(term) ||
            contact.email?.toLowerCase().includes(term),
        )
      : contacts;

    matched.sort((a, b) => b._creationTime - a._creationTime);

    const total = matched.length;
    const page = matched.slice(offset, offset + limit);
    const items = await Promise.all(
      page.map((contact) => embedTags(ctx, contact)),
    );

    return { items, total };
  },
});

export const update = accountMutation({
  args: {
    contactId: v.id("contacts"),
    name: v.optional(v.string()),
    email: v.optional(v.string()),
    company: v.optional(v.string()),
    phone: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    ctx.requireRole("agent");
    const { contactId, phone, ...rest } = args;
    const contact = await requireOwnContact(ctx, contactId);

    const patch: Partial<{
      name: string;
      email: string;
      company: string;
      phone: string;
      phoneNormalized: string;
    }> = { ...rest };

    if (phone !== undefined) {
      const phoneNormalized = normalizePhone(phone);
      // Only worth a dedup check when the phone is actually changing —
      // re-checking against an unchanged value could never find
      // anything but this same row (see the report for why that's
      // structurally impossible, not just "shouldn't happen").
      if (phoneNormalized !== contact.phoneNormalized) {
        const dup = await ctx.db
          .query("contacts")
          .withIndex("by_account_phone", (q) =>
            q
              .eq("accountId", ctx.accountId)
              .eq("phoneNormalized", phoneNormalized),
          )
          .first();
        if (dup) {
          throw new ConvexError({ code: "DUPLICATE_PHONE", contactId: dup._id });
        }
      }
      patch.phone = phone;
      patch.phoneNormalized = phoneNormalized;
    }

    await ctx.db.patch(contactId, patch);
    return contactId;
  },
});

export const remove = accountMutation({
  args: { contactId: v.id("contacts") },
  handler: async (ctx, args) => {
    ctx.requireRole("agent");
    await requireOwnContact(ctx, args.contactId);

    // Explicit cascade: contactTags has no ON DELETE in Convex.
    const links = await ctx.db
      .query("contactTags")
      .withIndex("by_contact", (q) => q.eq("contactId", args.contactId))
      .collect();
    for (const link of links) {
      await ctx.db.delete(link._id);
    }
    await ctx.db.delete(args.contactId);
  },
});

export const assignTag = accountMutation({
  args: { contactId: v.id("contacts"), tagId: v.id("tags") },
  handler: async (ctx, args) => {
    ctx.requireRole("agent");
    await requireOwnContact(ctx, args.contactId);

    const tag = await ctx.db.get(args.tagId);
    if (!tag || tag.accountId !== ctx.accountId) {
      throw new ConvexError({ code: "NOT_FOUND", entity: "tag" });
    }

    const existing = await ctx.db
      .query("contactTags")
      .withIndex("by_contact_tag", (q) =>
        q.eq("contactId", args.contactId).eq("tagId", args.tagId),
      )
      .first();
    if (existing) return existing._id;

    return await ctx.db.insert("contactTags", {
      accountId: ctx.accountId,
      contactId: args.contactId,
      tagId: args.tagId,
    });
  },
});

export const unassignTag = accountMutation({
  args: { contactId: v.id("contacts"), tagId: v.id("tags") },
  handler: async (ctx, args) => {
    ctx.requireRole("agent");
    await requireOwnContact(ctx, args.contactId);

    const link = await ctx.db
      .query("contactTags")
      .withIndex("by_contact_tag", (q) =>
        q.eq("contactId", args.contactId).eq("tagId", args.tagId),
      )
      .first();
    if (link) await ctx.db.delete(link._id);
  },
});
