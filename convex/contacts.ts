import { accountMutation, accountQuery } from "./lib/auth";
import { internalMutation } from "./_generated/server";
import { v, ConvexError } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { normalizePhone, maskPhone } from "./lib/phone";
import { hasMinRole } from "./lib/roles";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";

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
 * Strips a contact's real number for callers below `supervisor` — the
 * same masking `conversations.ts`'s `embedContact` applies to the Inbox,
 * duplicated here (byte-for-byte, same one-helper-per-file reasoning as
 * `embedTags` above) as defense-in-depth: agents/viewers have no
 * Contacts UI today, but `list`/`get` below are still directly callable
 * regardless of what the UI exposes.
 */
function maskContactPhone<T extends { phone: string; phoneNormalized: string }>(
  contact: T,
): T {
  return { ...contact, phone: maskPhone(contact.phone), phoneNormalized: "" };
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
      result.page.map(async (contact) => {
        const withTags = await embedTags(ctx, contact);
        return hasMinRole(ctx.role, "supervisor")
          ? withTags
          : maskContactPhone(withTags);
      }),
    );
    return { ...result, page };
  },
});

/**
 * Single-contact read by id, with embedded tags — the same shape as an
 * item from `list`/`filterByTags`. Added for Phase 8 Task 2a (the
 * contacts UI rewire): `ContactDetailView` and the contact-form's
 * duplicate-phone banner both need to resolve one contact from a bare
 * `Id<"contacts">` (e.g. the `contactId` on a `DUPLICATE_PHONE`
 * ConvexError), and no other query here supports that (`list`/
 * `filterByTags` are page/multi-result reads only). `NOT_FOUND` for
 * "doesn't exist" and "exists but isn't yours" alike, same as every
 * other read in this file.
 */
export const get = accountQuery({
  args: { contactId: v.id("contacts") },
  handler: async (ctx, args) => {
    const contact = await requireOwnContact(ctx, args.contactId);
    const withTags = await embedTags(ctx, contact);
    return hasMinRole(ctx.role, "supervisor")
      ? withTags
      : maskContactPhone(withTags);
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

/**
 * Contacts whose `customFieldId` custom-field value matches `value`
 * under `operator` (`is`/`is_not`/exact, or `contains` — case-
 * insensitive substring) — the Convex equivalent of the pre-Convex
 * broadcast composer's `resolveCustomFieldAudience` (`src/hooks/
 * use-broadcast-sending.ts`, Supabase era). Added for Phase 8 Task 4
 * (the broadcast composer rewire): the composer's "custom field"
 * audience type had no Convex query to resolve against.
 *
 * `contactCustomValues` has no index on `customFieldId` alone (see
 * schema.ts — only `by_contact_field`, `by_contact`, `by_account`), so
 * this reuses the exact `by_account` + in-memory `filter` access
 * pattern `customFields.remove`'s own cascade already established for
 * this table, rather than adding a new index for what's expected to
 * stay an occasional read (one per broadcast-composer "custom field"
 * pick, not a hot path).
 *
 * Only ever matches contacts that HAVE a `contactCustomValues` row for
 * this field — the same limitation the Postgres-era implementation
 * had (a contact with no row for this field never matches `is_not`
 * either, since there's nothing to compare against).
 */
export const byCustomFieldValue = accountQuery({
  args: {
    customFieldId: v.id("customFields"),
    operator: v.union(
      v.literal("is"),
      v.literal("is_not"),
      v.literal("contains"),
    ),
    value: v.string(),
  },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("contactCustomValues")
      .withIndex("by_account", (q) => q.eq("accountId", ctx.accountId))
      .filter((q) => q.eq(q.field("customFieldId"), args.customFieldId))
      .collect();

    const needle = args.value.toLowerCase();
    const matches = rows.filter((row) => {
      const value = row.value ?? "";
      switch (args.operator) {
        case "is":
          return value === args.value;
        case "is_not":
          return value !== args.value;
        case "contains":
          return value.toLowerCase().includes(needle);
      }
    });

    const contactIds = [...new Set(matches.map((row) => row.contactId))];

    // Defense-in-depth, same reasoning as `filterByTags` above: nothing
    // stops a caller from supplying another account's real
    // customFieldId, but every `contactCustomValues` row this query can
    // ever see is already scoped to `ctx.accountId` via the `by_account`
    // index above, so a foreign customFieldId simply matches zero rows
    // — no cross-account contact id can ever reach `contactIds`. The
    // `ctx.db.get` + accountId re-check below only guards against a
    // contact having been deleted after its value row was written
    // (matches `filterByTags`'s own null-drop).
    const fetched = await Promise.all(contactIds.map((id) => ctx.db.get(id)));
    return fetched.filter(
      (contact): contact is Doc<"contacts"> =>
        contact !== null && contact.accountId === ctx.accountId,
    );
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

    // Explicit cascade: Postgres had `contact_custom_values.contact_id
    // ... ON DELETE CASCADE` — a custom-field value is meaningless once
    // its contact is gone. Mirrors the `contactTags` cascade above.
    const customValues = await ctx.db
      .query("contactCustomValues")
      .withIndex("by_contact", (q) => q.eq("contactId", args.contactId))
      .collect();
    for (const value of customValues) {
      await ctx.db.delete(value._id);
    }

    // Explicit cascade: Postgres had `contact_notes.contact_id ...
    // ON DELETE CASCADE` — same reasoning as `contactCustomValues` above.
    const notes = await ctx.db
      .query("contactNotes")
      .withIndex("by_contact", (q) => q.eq("contactId", args.contactId))
      .collect();
    for (const note of notes) {
      await ctx.db.delete(note._id);
    }

    // Explicit SET NULL: migration 004 (contact_delete_set_null) made
    // `deals.contact_id ON DELETE SET NULL` so a deal's sales history
    // survives its contact being deleted — unlike the DELETE cascades
    // above, these rows are unlinked, never removed.
    const deals = await ctx.db
      .query("deals")
      .withIndex("by_contact", (q) => q.eq("contactId", args.contactId))
      .collect();
    for (const deal of deals) {
      await ctx.db.patch(deal._id, { contactId: undefined });
    }

    // Explicit SET NULL: migration 004 gave `broadcast_recipients.
    // contact_id` the same ON DELETE SET NULL treatment as `deals`
    // above, so a broadcast's send history survives too.
    // `broadcastRecipients` has no `by_contact` index (see schema.ts —
    // only `by_broadcast`/`by_account`/`by_wamid`), so this scopes
    // through the account's own `by_account` index and filters down to
    // this contact in memory instead — the same pattern
    // `customFields.remove`'s cascade uses onto `contactCustomValues`
    // for the identical reason (no index on the column being filtered).
    // A dedicated `by_contact` index would speed this up, but adding
    // one is a schema change beyond this cascade fix — worth revisiting
    // if broadcast recipient volume ever makes this scan a hot path.
    const recipients = await ctx.db
      .query("broadcastRecipients")
      .withIndex("by_account", (q) => q.eq("accountId", ctx.accountId))
      .filter((q) => q.eq(q.field("contactId"), args.contactId))
      .collect();
    for (const recipient of recipients) {
      await ctx.db.patch(recipient._id, { contactId: undefined });
    }

    // Deliberately NOT cascaded: `conversations` / `messages`.
    // `conversations.contactId` is NOT NULL (`v.id("contacts")`), so it
    // can't be SET NULL without a schema change, and the read layer
    // already tolerates a dangling reference on purpose —
    // `conversations.ts`'s `embedContact` returns `contact: null` for a
    // deleted contact rather than throwing, which
    // `convex/conversations.test.ts`'s "embeds contact: null when the
    // conversation's contact has been deleted" test asserts directly.
    // Deleting a contact's conversation + message history outright is a
    // separate, destructive product decision that's out of scope here;
    // a future improvement making `conversations.contactId` optional
    // would allow a clean SET NULL cascade instead.

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

// ============================================================
// Public-API (Phase 8, Task 5) find-or-create by phone — the account-
// explicit counterpart `convex/apiV1.ts`'s `createContact`/`sendMessage`/
// `createBroadcast` need. Deliberately separate from `create` above
// (which THROWS `DUPLICATE_PHONE` on a match, the right UX for the
// dashboard's manual contact form): the public REST API's contract is
// silent find-or-create (`POST /api/v1/contacts` returns 200
// `created:false` on a match, never an error), matching
// `src/lib/api/v1/contacts.ts`'s old `findOrCreateContact`. Dedup is
// EXACT `phoneNormalized` match via `by_account_phone` — the same
// index/convention `create` already established for this table in
// Convex (the old Postgres-side `findOrCreateContact` did fuzzy
// trunk-prefix matching via `findExistingContact`; this migration
// keeps the exact-match convention `create` already set, rather than
// reintroducing the fuzzy behavior for just this one caller).
// ============================================================

/**
 * Find (by exact normalized-phone match) or create a contact in
 * `accountId`. Returns the contact id and whether it was created. Typed
 * to accept any ctx with a `db` (only `db.get`/`db.query`/`db.insert`
 * are used), so it works unmodified from a `mutation` handler (`apiV1
 * .createContact`) or from `findOrCreateByPhoneInternal` below (an
 * `internalMutation`, for the `action`-shaped `apiV1.sendMessage`/
 * `apiV1.createBroadcast`, which have no `ctx.db` of their own).
 */
export async function findOrCreateContactByPhone(
  ctx: { db: MutationCtx["db"] },
  accountId: Id<"accounts">,
  input: { phone: string; name?: string; email?: string; company?: string },
): Promise<{ contactId: Id<"contacts">; created: boolean }> {
  const phoneNormalized = normalizePhone(input.phone);
  const existing = await ctx.db
    .query("contacts")
    .withIndex("by_account_phone", (q) =>
      q.eq("accountId", accountId).eq("phoneNormalized", phoneNormalized),
    )
    .first();
  if (existing) return { contactId: existing._id, created: false };

  const contactId = await ctx.db.insert("contacts", {
    accountId,
    phone: input.phone,
    phoneNormalized,
    name: input.name ?? input.phone,
    email: input.email,
    company: input.company,
  });
  return { contactId, created: true };
}

/**
 * `action`-callable counterpart to `findOrCreateContactByPhone` above —
 * see that function's own doc comment for why a second entry point is
 * needed (an `action` has no `ctx.db`, only `ctx.runMutation`).
 */
export const findOrCreateByPhoneInternal = internalMutation({
  args: {
    accountId: v.id("accounts"),
    phone: v.string(),
    name: v.optional(v.string()),
    email: v.optional(v.string()),
    company: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { accountId, ...input } = args;
    return await findOrCreateContactByPhone(ctx, accountId, input);
  },
});
