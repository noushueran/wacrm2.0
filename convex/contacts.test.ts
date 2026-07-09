/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { api } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import type { AccountRole } from "./lib/roles";

// Convex function modules for convex-test to resolve `api.*` references
// against. Absolute, from-project-root pattern (not a relative "./**")
// per the gotcha documented in `convex/lib/auth.test.ts`: convex-test's
// moduleCache assumes one uniform key prefix derived from wherever
// "_generated" lands, and a relative glob only produces that for every
// matched file when every file sits the same number of directories
// away from this one — which breaks the moment any test file lives
// under a subdirectory (e.g. `lib/`). This file happens to sit at the
// convex root today, but the absolute form is used anyway, both to
// follow the established convention and to stay correct if this suite
// is ever split into a subdirectory.
const modules = import.meta.glob("/convex/**/*.ts");

/**
 * Seeds a `users` row + an `accounts`/`memberships` row for a fresh
 * account, and returns a convex-test client already authenticated as
 * that user. Bypasses `accounts.bootstrapAccount` on purpose — this
 * suite tests `contacts.ts`/`tags.ts`, not the bootstrap flow (see
 * `convex/accounts.test.ts` for that, and `convex/lib/auth.test.ts` for
 * the identity-simulation pattern this relies on:
 * `t.withIdentity({ subject: "<userId>|<session>" })` round-trips to
 * the seeded user because `getAuthUserId` splits the subject on "|").
 */
async function seedAccountMember(
  t: ReturnType<typeof convexTest>,
  opts: { name: string; email: string; role: AccountRole },
) {
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { name: opts.name, email: opts.email }),
  );
  const accountId = await t.run(async (ctx) => {
    const id = await ctx.db.insert("accounts", {
      name: `${opts.name}'s account`,
      defaultCurrency: "USD",
      ownerUserId: userId,
    });
    await ctx.db.insert("memberships", {
      userId,
      accountId: id,
      role: opts.role,
      fullName: opts.name,
      email: opts.email,
    });
    return id;
  });
  const asUser = t.withIdentity({
    subject: `${userId}|session-${opts.name}`,
  });
  return { userId, accountId, asUser };
}

const onePage = { paginationOpts: { numItems: 50, cursor: null } };

// ============================================================
// create + dedup
// ============================================================

test("create inserts a contact scoped to the caller's own account, from ctx — not from any client-supplied arg", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId, userId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });

  const contactId = await asUser.mutation(api.contacts.create, {
    phone: "+370 63949836",
    name: "Jonas",
  });

  const row = await t.run((ctx) => ctx.db.get(contactId));
  expect(row).not.toBeNull();
  // `create`'s args have no accountId/userId field at all, so the only
  // way these can land on the row is via the wrapper-injected ctx —
  // this is the strongest available proof that accountQuery/
  // accountMutation actually inject the caller's own membership data.
  // (Supersedes the old convex/lib/authFixtures.ts `whoAmI` echo test,
  // which only asserted the wrapper's ctx shape in isolation rather
  // than proving a real write persists it correctly.)
  expect(row!.accountId).toBe(accountId);
  expect(row!.createdByUserId).toBe(userId);
  expect(row!.phone).toBe("+370 63949836");
  expect(row!.phoneNormalized).toBe("37063949836");
});

test("create throws DUPLICATE_PHONE for a second contact with the same normalized phone in the same account", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });

  const firstId = await asUser.mutation(api.contacts.create, {
    phone: "+370 63949836",
  });

  const error: unknown = await asUser
    .mutation(api.contacts.create, { phone: "370-63-949-836" }) // same digits
    .catch((e: unknown) => e);

  expect(error).toBeInstanceOf(ConvexError);
  expect((error as { data: unknown }).data).toEqual({
    code: "DUPLICATE_PHONE",
    contactId: firstId,
  });

  const all = await t.run((ctx) => ctx.db.query("contacts").collect());
  expect(all).toHaveLength(1);
});

test("create allows the same normalized phone across two different accounts", async () => {
  const t = convexTest(schema, modules);
  const { asUser: asAlice } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const { asUser: asBob } = await seedAccountMember(t, {
    name: "Bob",
    email: "bob@example.com",
    role: "agent",
  });

  const aliceContactId = await asAlice.mutation(api.contacts.create, {
    phone: "37063949836",
  });
  const bobContactId = await asBob.mutation(api.contacts.create, {
    phone: "37063949836",
  });

  expect(aliceContactId).not.toBe(bobContactId);
});

test("create throws FORBIDDEN for a caller below the agent role", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Vera",
    email: "vera@example.com",
    role: "viewer",
  });

  await expect(
    asUser.mutation(api.contacts.create, { phone: "123" }),
  ).rejects.toMatchObject({ data: { code: "FORBIDDEN", min: "agent" } });
});

// ============================================================
// cross-account denial — the payoff: this is what proves the
// account-isolation model actually holds end-to-end.
// ============================================================

test("list never returns another account's contacts", async () => {
  const t = convexTest(schema, modules);
  const { asUser: asAlice } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const { asUser: asBob } = await seedAccountMember(t, {
    name: "Bob",
    email: "bob@example.com",
    role: "agent",
  });

  await asAlice.mutation(api.contacts.create, {
    phone: "111",
    name: "Alice's Contact",
  });

  const bobsView = await asBob.query(api.contacts.list, onePage);
  expect(bobsView.page).toHaveLength(0);

  const alicesView = await asAlice.query(api.contacts.list, onePage);
  expect(alicesView.page).toHaveLength(1);
});

test("filterByTags never returns another account's contacts, even when the caller supplies the other account's real tagId", async () => {
  const t = convexTest(schema, modules);
  const { asUser: asAlice } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const { asUser: asBob } = await seedAccountMember(t, {
    name: "Bob",
    email: "bob@example.com",
    role: "agent",
  });

  const aliceContactId = await asAlice.mutation(api.contacts.create, {
    phone: "111",
  });
  const aliceTagId = await asAlice.mutation(api.tags.create, {
    name: "VIP",
    color: "#f00",
  });
  await asAlice.mutation(api.contacts.assignTag, {
    contactId: aliceContactId,
    tagId: aliceTagId,
  });

  // Bob doesn't have this tagId in his own account's tag list, but
  // nothing stops him from supplying it verbatim as an argument — the
  // defense-in-depth accountId check inside filterByTags must still
  // drop the (real, existing) link it resolves to.
  const bobsView = await asBob.query(api.contacts.filterByTags, {
    tagIds: [aliceTagId],
    limit: 10,
    offset: 0,
  });

  expect(bobsView).toEqual({ items: [], total: 0 });
});

test("update throws (not a silent no-op) when the contact belongs to a different account, and leaves it unmodified", async () => {
  const t = convexTest(schema, modules);
  const { asUser: asAlice } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const { asUser: asBob } = await seedAccountMember(t, {
    name: "Bob",
    email: "bob@example.com",
    role: "agent",
  });

  const aliceContactId = await asAlice.mutation(api.contacts.create, {
    phone: "111",
    name: "Alice's Contact",
  });

  await expect(
    asBob.mutation(api.contacts.update, {
      contactId: aliceContactId,
      name: "Pwned",
    }),
  ).rejects.toMatchObject({ data: { code: "NOT_FOUND" } });

  const row = await t.run((ctx) => ctx.db.get(aliceContactId));
  expect(row!.name).toBe("Alice's Contact");
});

test("remove throws (not a silent no-op) when the contact belongs to a different account, and leaves it in place", async () => {
  const t = convexTest(schema, modules);
  const { asUser: asAlice } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const { asUser: asBob } = await seedAccountMember(t, {
    name: "Bob",
    email: "bob@example.com",
    role: "agent",
  });

  const aliceContactId = await asAlice.mutation(api.contacts.create, {
    phone: "111",
  });

  await expect(
    asBob.mutation(api.contacts.remove, { contactId: aliceContactId }),
  ).rejects.toMatchObject({ data: { code: "NOT_FOUND" } });

  const row = await t.run((ctx) => ctx.db.get(aliceContactId));
  expect(row).not.toBeNull();
});

test("assignTag throws when the contact belongs to a different account than the caller", async () => {
  const t = convexTest(schema, modules);
  const { asUser: asAlice } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const { asUser: asBob } = await seedAccountMember(t, {
    name: "Bob",
    email: "bob@example.com",
    role: "agent",
  });

  const bobContactId = await asBob.mutation(api.contacts.create, {
    phone: "222",
  });
  const aliceTagId = await asAlice.mutation(api.tags.create, {
    name: "VIP",
    color: "#f00",
  });

  await expect(
    asAlice.mutation(api.contacts.assignTag, {
      contactId: bobContactId,
      tagId: aliceTagId,
    }),
  ).rejects.toMatchObject({ data: { code: "NOT_FOUND" } });
});

test("assignTag throws when the tag belongs to a different account than the caller", async () => {
  const t = convexTest(schema, modules);
  const { asUser: asAlice } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const { asUser: asBob } = await seedAccountMember(t, {
    name: "Bob",
    email: "bob@example.com",
    role: "agent",
  });

  const aliceContactId = await asAlice.mutation(api.contacts.create, {
    phone: "111",
  });
  const bobTagId = await asBob.mutation(api.tags.create, {
    name: "VIP",
    color: "#f00",
  });

  await expect(
    asAlice.mutation(api.contacts.assignTag, {
      contactId: aliceContactId,
      tagId: bobTagId,
    }),
  ).rejects.toMatchObject({ data: { code: "NOT_FOUND" } });
});

test("tags.list returns only the caller's own account's tags", async () => {
  const t = convexTest(schema, modules);
  const { asUser: asAlice } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const { asUser: asBob } = await seedAccountMember(t, {
    name: "Bob",
    email: "bob@example.com",
    role: "agent",
  });

  await asAlice.mutation(api.tags.create, { name: "VIP", color: "#f00" });

  expect(await asBob.query(api.tags.list, {})).toEqual([]);
  expect(await asAlice.query(api.tags.list, {})).toHaveLength(1);
});

test("tags.remove throws when the tag belongs to a different account, and leaves it in place", async () => {
  const t = convexTest(schema, modules);
  const { asUser: asAlice } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const { asUser: asBob } = await seedAccountMember(t, {
    name: "Bob",
    email: "bob@example.com",
    role: "agent",
  });

  const aliceTagId = await asAlice.mutation(api.tags.create, {
    name: "VIP",
    color: "#f00",
  });

  await expect(
    asBob.mutation(api.tags.remove, { tagId: aliceTagId }),
  ).rejects.toMatchObject({ data: { code: "NOT_FOUND" } });

  expect(await t.run((ctx) => ctx.db.get(aliceTagId))).not.toBeNull();
});

// ============================================================
// same-account happy paths
// ============================================================

test("list embeds each contact's tags", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });

  const contactId = await asUser.mutation(api.contacts.create, {
    phone: "111",
    name: "Jonas",
  });
  const tagId = await asUser.mutation(api.tags.create, {
    name: "VIP",
    color: "#f00",
  });
  await asUser.mutation(api.contacts.assignTag, { contactId, tagId });

  const result = await asUser.query(api.contacts.list, onePage);

  expect(result.page).toHaveLength(1);
  expect(result.page[0]!.tags).toHaveLength(1);
  expect(result.page[0]!.tags[0]!._id).toBe(tagId);
});

test("list search_name matches by name prefix and stays scoped to the caller's account", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });

  await asUser.mutation(api.contacts.create, {
    phone: "111",
    name: "Jonas Petraitis",
  });
  await asUser.mutation(api.contacts.create, {
    phone: "222",
    name: "Marija",
  });

  const result = await asUser.query(api.contacts.list, {
    search: "jonas",
    paginationOpts: { numItems: 50, cursor: null },
  });

  expect(result.page).toHaveLength(1);
  expect(result.page[0]!.name).toBe("Jonas Petraitis");
});

test("assignTag is idempotent — assigning the same tag twice does not duplicate the link", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });

  const contactId = await asUser.mutation(api.contacts.create, {
    phone: "111",
  });
  const tagId = await asUser.mutation(api.tags.create, {
    name: "VIP",
    color: "#f00",
  });

  await asUser.mutation(api.contacts.assignTag, { contactId, tagId });
  await asUser.mutation(api.contacts.assignTag, { contactId, tagId });

  const links = await t.run((ctx) => ctx.db.query("contactTags").collect());
  expect(links).toHaveLength(1);
});

test("unassignTag removes a tag from a contact", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });

  const contactId = await asUser.mutation(api.contacts.create, {
    phone: "111",
  });
  const tagId = await asUser.mutation(api.tags.create, {
    name: "VIP",
    color: "#f00",
  });
  await asUser.mutation(api.contacts.assignTag, { contactId, tagId });

  await asUser.mutation(api.contacts.unassignTag, { contactId, tagId });

  const result = await asUser.query(api.contacts.list, onePage);
  expect(result.page[0]!.tags).toEqual([]);
});

test("remove cascades: deletes the contact's contactTags rows along with it, but leaves the tag itself untouched", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });

  const contactId = await asUser.mutation(api.contacts.create, {
    phone: "111",
  });
  const tagId = await asUser.mutation(api.tags.create, {
    name: "VIP",
    color: "#f00",
  });
  await asUser.mutation(api.contacts.assignTag, { contactId, tagId });

  await asUser.mutation(api.contacts.remove, { contactId });

  const links = await t.run((ctx) => ctx.db.query("contactTags").collect());
  expect(links).toHaveLength(0);
  expect(await t.run((ctx) => ctx.db.get(contactId))).toBeNull();
  expect(await t.run((ctx) => ctx.db.get(tagId))).not.toBeNull();
});

test("tags.remove cascades: deletes the contactTags rows referencing it", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });

  const contactId = await asUser.mutation(api.contacts.create, {
    phone: "111",
  });
  const tagId = await asUser.mutation(api.tags.create, {
    name: "VIP",
    color: "#f00",
  });
  await asUser.mutation(api.contacts.assignTag, { contactId, tagId });

  await asUser.mutation(api.tags.remove, { tagId });

  const links = await t.run((ctx) => ctx.db.query("contactTags").collect());
  expect(links).toHaveLength(0);
  expect(await t.run((ctx) => ctx.db.get(contactId))).not.toBeNull();
});

test("update changes fields, and re-checks phone dedup only when the phone actually changes", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });

  const contactId = await asUser.mutation(api.contacts.create, {
    phone: "111",
    name: "Old Name",
  });
  const otherContactId = await asUser.mutation(api.contacts.create, {
    phone: "222",
  });

  await asUser.mutation(api.contacts.update, { contactId, name: "New Name" });
  const afterRename = await t.run((ctx) => ctx.db.get(contactId));
  expect(afterRename!.name).toBe("New Name");
  expect(afterRename!.phone).toBe("111"); // unchanged

  const error: unknown = await asUser
    .mutation(api.contacts.update, { contactId, phone: "222" })
    .catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ConvexError);
  expect((error as { data: unknown }).data).toEqual({
    code: "DUPLICATE_PHONE",
    contactId: otherContactId,
  });
});

// ============================================================
// filterByTags — OR semantics, dedup, search, pagination
// ============================================================

test("filterByTags ORs across tags and dedupes a contact matching more than one", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });

  const tagA = await asUser.mutation(api.tags.create, {
    name: "A",
    color: "#000",
  });
  const tagB = await asUser.mutation(api.tags.create, {
    name: "B",
    color: "#000",
  });

  const c1 = await asUser.mutation(api.contacts.create, {
    phone: "1",
    name: "One",
  });
  const c2 = await asUser.mutation(api.contacts.create, {
    phone: "2",
    name: "Two",
  });
  await asUser.mutation(api.contacts.create, { phone: "3", name: "Three" });

  await asUser.mutation(api.contacts.assignTag, { contactId: c1, tagId: tagA });
  await asUser.mutation(api.contacts.assignTag, { contactId: c2, tagId: tagA });
  await asUser.mutation(api.contacts.assignTag, { contactId: c2, tagId: tagB }); // c2: both tags

  const result = await asUser.query(api.contacts.filterByTags, {
    tagIds: [tagA, tagB],
    limit: 10,
    offset: 0,
  });

  expect(result.total).toBe(2); // c1, c2 — "Three" excluded, c2 counted once
  expect(new Set(result.items.map((c) => c._id))).toEqual(new Set([c1, c2]));
});

test("filterByTags applies name/phone/email search on top of the tag match", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });

  const tagA = await asUser.mutation(api.tags.create, {
    name: "A",
    color: "#000",
  });
  const c1 = await asUser.mutation(api.contacts.create, {
    phone: "111",
    name: "Jonas",
  });
  const c2 = await asUser.mutation(api.contacts.create, {
    phone: "222",
    name: "Marija",
  });
  await asUser.mutation(api.contacts.assignTag, { contactId: c1, tagId: tagA });
  await asUser.mutation(api.contacts.assignTag, { contactId: c2, tagId: tagA });

  const result = await asUser.query(api.contacts.filterByTags, {
    tagIds: [tagA],
    search: "jonas",
    limit: 10,
    offset: 0,
  });

  expect(result.total).toBe(1);
  expect(result.items[0]!._id).toBe(c1);
});

test("filterByTags paginates with offset/limit while total reflects every match", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });

  const tagA = await asUser.mutation(api.tags.create, {
    name: "A",
    color: "#000",
  });
  const ids: Id<"contacts">[] = [];
  for (const phone of ["1", "2", "3"]) {
    const id = await asUser.mutation(api.contacts.create, { phone });
    await asUser.mutation(api.contacts.assignTag, { contactId: id, tagId: tagA });
    ids.push(id);
  }

  const page1 = await asUser.query(api.contacts.filterByTags, {
    tagIds: [tagA],
    limit: 2,
    offset: 0,
  });
  const page2 = await asUser.query(api.contacts.filterByTags, {
    tagIds: [tagA],
    limit: 2,
    offset: 2,
  });

  expect(page1.items).toHaveLength(2);
  expect(page1.total).toBe(3);
  expect(page2.items).toHaveLength(1);
  expect(page2.total).toBe(3);
  // No overlap between the two pages.
  const page1Ids = new Set(page1.items.map((c) => c._id));
  for (const item of page2.items) expect(page1Ids.has(item._id)).toBe(false);
});

// ============================================================
// get (single-contact read, added for the Phase 8 Task 2a UI rewire —
// ContactDetailView and the contact-form duplicate-phone banner both
// resolve one contact from a bare id).
// ============================================================

test("get returns the contact with embedded tags for the caller's own account", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });

  const contactId = await asUser.mutation(api.contacts.create, {
    phone: "111",
    name: "Alice's Contact",
  });
  const tagId = await asUser.mutation(api.tags.create, {
    name: "VIP",
    color: "#f00",
  });
  await asUser.mutation(api.contacts.assignTag, { contactId, tagId });

  const result = await asUser.query(api.contacts.get, { contactId });
  expect(result._id).toBe(contactId);
  expect(result.name).toBe("Alice's Contact");
  expect(result.tags).toHaveLength(1);
  expect(result.tags[0]._id).toBe(tagId);
});

test("get throws NOT_FOUND when the contact belongs to a different account", async () => {
  const t = convexTest(schema, modules);
  const { asUser: asAlice } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const { asUser: asBob } = await seedAccountMember(t, {
    name: "Bob",
    email: "bob@example.com",
    role: "agent",
  });

  const aliceContactId = await asAlice.mutation(api.contacts.create, {
    phone: "111",
  });

  const error: unknown = await asBob
    .query(api.contacts.get, { contactId: aliceContactId })
    .catch((e: unknown) => e);

  expect(error).toBeInstanceOf(ConvexError);
  expect((error as { data: unknown }).data).toEqual({
    code: "NOT_FOUND",
    entity: "contact",
  });
});

test("filterByTags returns nothing for an empty tagIds list", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  await asUser.mutation(api.contacts.create, { phone: "111" });

  const result = await asUser.query(api.contacts.filterByTags, {
    tagIds: [],
    limit: 10,
    offset: 0,
  });

  expect(result).toEqual({ items: [], total: 0 });
});
