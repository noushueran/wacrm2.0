/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { api, internal } from "./_generated/api";
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

/**
 * Inserts a minimal `pipelines` + `pipelineStages` + `deals` row
 * directly via `t.run`, bypassing `pipelines.create`/`deals.create` —
 * this suite only needs a real `deals` row with a real `contactId` to
 * exercise `contacts.remove`'s SET NULL cascade, not `pipelines
 * .create`'s own default-stages behavior (mirrors
 * `convex/conversations.test.ts`'s `seedConversation`, which inserts
 * directly for the same "out of this file's own vertical" reason).
 */
async function seedDeal(
  t: ReturnType<typeof convexTest>,
  opts: { accountId: Id<"accounts">; contactId: Id<"contacts"> },
) {
  return await t.run(async (ctx) => {
    const pipelineId = await ctx.db.insert("pipelines", {
      accountId: opts.accountId,
      name: "Sales",
    });
    const stageId = await ctx.db.insert("pipelineStages", {
      accountId: opts.accountId,
      pipelineId,
      name: "New Lead",
      position: 0,
      color: "#3b82f6",
    });
    return await ctx.db.insert("deals", {
      accountId: opts.accountId,
      pipelineId,
      stageId,
      contactId: opts.contactId,
      title: "Big Fish",
      value: 5000,
      status: "open",
    });
  });
}

/**
 * Inserts a minimal `broadcasts` + `broadcastRecipients` row directly
 * via `t.run` — same "bypass the real mutation, just need a real row
 * with a real contactId" reasoning as `seedDeal` above (the real
 * `broadcasts.create`/send flow does far more than this cascade test
 * needs: template validation, per-recipient WhatsApp sends, etc.).
 */
async function seedBroadcastRecipient(
  t: ReturnType<typeof convexTest>,
  opts: { accountId: Id<"accounts">; contactId: Id<"contacts"> },
) {
  return await t.run(async (ctx) => {
    const broadcastId = await ctx.db.insert("broadcasts", {
      accountId: opts.accountId,
      name: "Spring Sale",
      templateName: "spring_sale",
      templateLanguage: "en_US",
      status: "draft",
      totalRecipients: 0,
      sentCount: 0,
      deliveredCount: 0,
      readCount: 0,
      repliedCount: 0,
      failedCount: 0,
    });
    return await ctx.db.insert("broadcastRecipients", {
      accountId: opts.accountId,
      broadcastId,
      contactId: opts.contactId,
      status: "pending",
    });
  });
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
    role: "supervisor",
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

// ============================================================
// byCustomFieldValue — Phase 8 Task 4 (broadcast composer rewire)
// ============================================================

test("byCustomFieldValue matches by is/is_not/contains, and never matches a contact with no value row for that field", async () => {
  const t = convexTest(schema, modules);
  const { asUser: asAlice } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });

  const fieldId = await asAlice.mutation(api.customFields.create, {
    fieldName: "Plan",
    fieldType: "text",
  });

  const proContactId = await asAlice.mutation(api.contacts.create, {
    phone: "111",
    name: "Pro User",
  });
  const freeContactId = await asAlice.mutation(api.contacts.create, {
    phone: "222",
    name: "Free User",
  });
  await asAlice.mutation(api.contacts.create, {
    phone: "333",
    name: "No Value User",
  });

  await asAlice.mutation(api.customFields.setForContact, {
    contactId: proContactId,
    values: [{ customFieldId: fieldId, value: "Pro" }],
  });
  await asAlice.mutation(api.customFields.setForContact, {
    contactId: freeContactId,
    values: [{ customFieldId: fieldId, value: "Free" }],
  });
  // noValueContactId gets no `contactCustomValues` row at all.

  const isMatches = await asAlice.query(api.contacts.byCustomFieldValue, {
    customFieldId: fieldId,
    operator: "is",
    value: "Pro",
  });
  expect(isMatches.map((c) => c._id)).toEqual([proContactId]);

  // "is_not" only ever compares against EXISTING value rows —
  // noValueContactId has none, so it can never match either operator,
  // same limitation the Postgres-era `.neq('value', value)` filter had.
  const isNotMatches = await asAlice.query(api.contacts.byCustomFieldValue, {
    customFieldId: fieldId,
    operator: "is_not",
    value: "Pro",
  });
  expect(isNotMatches.map((c) => c._id)).toEqual([freeContactId]);

  const containsMatches = await asAlice.query(
    api.contacts.byCustomFieldValue,
    { customFieldId: fieldId, operator: "contains", value: "ro" },
  );
  expect(containsMatches.map((c) => c._id)).toEqual([proContactId]);

  const noMatches = await asAlice.query(api.contacts.byCustomFieldValue, {
    customFieldId: fieldId,
    operator: "is",
    value: "Enterprise",
  });
  expect(noMatches).toEqual([]);
});

/**
 * Same account, two fields, both holding the value "Pro". Pins that the query
 * discriminates on `customFieldId` and not merely on the value — the contract
 * the `by_account_field` range has to preserve. Cross-ACCOUNT isolation is the
 * next test down; this is the same-account sibling case, which nothing covered.
 */
test("byCustomFieldValue returns only the requested field's matches, not a sibling field's identical value", async () => {
  const t = convexTest(schema, modules);
  const { asUser: asAlice } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });

  const planFieldId = await asAlice.mutation(api.customFields.create, {
    fieldName: "Plan",
    fieldType: "text",
  });
  const tierFieldId = await asAlice.mutation(api.customFields.create, {
    fieldName: "Tier",
    fieldType: "text",
  });

  const planContactId = await asAlice.mutation(api.contacts.create, {
    phone: "111",
  });
  const tierContactId = await asAlice.mutation(api.contacts.create, {
    phone: "222",
  });

  await asAlice.mutation(api.customFields.setForContact, {
    contactId: planContactId,
    values: [{ customFieldId: planFieldId, value: "Pro" }],
  });
  await asAlice.mutation(api.customFields.setForContact, {
    contactId: tierContactId,
    values: [{ customFieldId: tierFieldId, value: "Pro" }],
  });

  const matches = await asAlice.query(api.contacts.byCustomFieldValue, {
    customFieldId: planFieldId,
    operator: "is",
    value: "Pro",
  });

  expect(matches.map((c) => c._id)).toEqual([planContactId]);
});

test("byCustomFieldValue never returns another account's contacts, even when the caller supplies the other account's real customFieldId", async () => {
  const t = convexTest(schema, modules);
  const { asUser: asAlice } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });
  const { asUser: asBob } = await seedAccountMember(t, {
    name: "Bob",
    email: "bob@example.com",
    role: "admin",
  });

  const fieldId = await asAlice.mutation(api.customFields.create, {
    fieldName: "Plan",
    fieldType: "text",
  });
  const aliceContactId = await asAlice.mutation(api.contacts.create, {
    phone: "111",
  });
  await asAlice.mutation(api.customFields.setForContact, {
    contactId: aliceContactId,
    values: [{ customFieldId: fieldId, value: "Pro" }],
  });

  // Bob doesn't have this fieldId in his own account's catalogue, but
  // nothing stops him from supplying it verbatim as an argument — every
  // `contactCustomValues` row this query can see is already scoped to
  // the caller's own account via `by_account`, so this must come back
  // empty rather than leaking Alice's contact.
  const bobsView = await asBob.query(api.contacts.byCustomFieldValue, {
    customFieldId: fieldId,
    operator: "is",
    value: "Pro",
  });
  expect(bobsView).toEqual([]);

  const alicesView = await asAlice.query(api.contacts.byCustomFieldValue, {
    customFieldId: fieldId,
    operator: "is",
    value: "Pro",
  });
  expect(alicesView.map((c) => c._id)).toEqual([aliceContactId]);
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
    role: "supervisor",
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
    role: "supervisor",
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
    role: "supervisor",
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
    role: "supervisor",
  });
  const { asUser: asBob } = await seedAccountMember(t, {
    name: "Bob",
    email: "bob@example.com",
    role: "supervisor",
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
    role: "supervisor",
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

test("list search matches by phone digits, email, and contact ID (not just name)", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "supervisor", // supervisor+ so the phone isn't masked in the result
  });

  await asUser.mutation(api.contacts.create, {
    phone: "+971501234567",
    name: "Jonas",
    email: "jonas@travel.com",
  }); // HC-000001
  await asUser.mutation(api.contacts.create, { phone: "222", name: "Marija" });

  const byPhone = await asUser.query(api.contacts.list, {
    search: "50123",
    paginationOpts: { numItems: 50, cursor: null },
  });
  expect(byPhone.page.map((c) => c.name)).toEqual(["Jonas"]);

  const byEmail = await asUser.query(api.contacts.list, {
    search: "travel.com",
    paginationOpts: { numItems: 50, cursor: null },
  });
  expect(byEmail.page.map((c) => c.name)).toEqual(["Jonas"]);

  const byId = await asUser.query(api.contacts.list, {
    search: "HC-000001",
    paginationOpts: { numItems: 50, cursor: null },
  });
  expect(byId.page.map((c) => c.name)).toEqual(["Jonas"]);
});

test("assignTag is idempotent — assigning the same tag twice does not duplicate the link", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "supervisor",
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
    role: "supervisor",
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
    role: "supervisor",
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

// ============================================================
// remove — cascades onto contactCustomValues/contactNotes (DELETE)
// and deals/broadcastRecipients (SET NULL). conversations/messages are
// deliberately left untouched — see `convex/contacts.ts`'s `remove`
// comment and `convex/conversations.test.ts`'s own dangling-contact
// test, which relies on that gap staying open.
// ============================================================

test("remove cascades: deletes the contact's contactCustomValues and contactNotes rows", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });

  const contactId = await asUser.mutation(api.contacts.create, {
    phone: "111",
  });
  const fieldId = await asUser.mutation(api.customFields.create, {
    fieldName: "Plan",
    fieldType: "text",
  });
  await asUser.mutation(api.customFields.setForContact, {
    contactId,
    values: [{ customFieldId: fieldId, value: "Pro" }],
  });
  await asUser.mutation(api.contactNotes.add, {
    contactId,
    body: "Called about renewal",
  });

  await asUser.mutation(api.contacts.remove, { contactId });

  const values = await t.run((ctx) =>
    ctx.db
      .query("contactCustomValues")
      .withIndex("by_contact", (q) => q.eq("contactId", contactId))
      .collect(),
  );
  expect(values).toHaveLength(0);

  const notes = await t.run((ctx) =>
    ctx.db
      .query("contactNotes")
      .withIndex("by_contact", (q) => q.eq("contactId", contactId))
      .collect(),
  );
  expect(notes).toHaveLength(0);
});

test("remove cascades: SET NULL on deals.contactId, but keeps the deal itself", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const contactId = await asUser.mutation(api.contacts.create, {
    phone: "111",
  });
  const dealId = await seedDeal(t, { accountId, contactId });

  await asUser.mutation(api.contacts.remove, { contactId });

  const deal = await t.run((ctx) => ctx.db.get(dealId));
  expect(deal).not.toBeNull();
  expect(deal!.contactId).toBeUndefined();
});

test("remove cascades: SET NULL on broadcastRecipients.contactId, but keeps the recipient row", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const contactId = await asUser.mutation(api.contacts.create, {
    phone: "111",
  });
  const recipientId = await seedBroadcastRecipient(t, {
    accountId,
    contactId,
  });

  await asUser.mutation(api.contacts.remove, { contactId });

  const recipient = await t.run((ctx) => ctx.db.get(recipientId));
  expect(recipient).not.toBeNull();
  expect(recipient!.contactId).toBeUndefined();
});

/**
 * Two contacts in ONE account, each with a recipient row; only the removed
 * contact's is nulled. Pins that the cascade discriminates on `contactId`
 * rather than sweeping the account — the contract the `by_account_contact`
 * range has to preserve, and the one a wrong index prefix would silently
 * break by nulling every recipient in the account. Cross-ACCOUNT isolation is
 * covered separately below; this is the same-account sibling case.
 */
test("remove leaves another contact's broadcastRecipients row in the same account untouched", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const doomedContactId = await asUser.mutation(api.contacts.create, {
    phone: "111",
  });
  const survivingContactId = await asUser.mutation(api.contacts.create, {
    phone: "222",
  });
  const doomedRecipientId = await seedBroadcastRecipient(t, {
    accountId,
    contactId: doomedContactId,
  });
  const survivingRecipientId = await seedBroadcastRecipient(t, {
    accountId,
    contactId: survivingContactId,
  });

  await asUser.mutation(api.contacts.remove, { contactId: doomedContactId });

  const doomed = await t.run((ctx) => ctx.db.get(doomedRecipientId));
  expect(doomed!.contactId).toBeUndefined();

  const surviving = await t.run((ctx) => ctx.db.get(survivingRecipientId));
  expect(surviving!.contactId).toBe(survivingContactId);
});

test("remove cascades never touch another account's contactCustomValues/contactNotes/deals/broadcastRecipients rows", async () => {
  const t = convexTest(schema, modules);
  const { asUser: asAlice, accountId: aliceAccountId } =
    await seedAccountMember(t, {
      name: "Alice",
      email: "alice@example.com",
      role: "admin",
    });
  const { asUser: asBob, accountId: bobAccountId } = await seedAccountMember(
    t,
    { name: "Bob", email: "bob@example.com", role: "admin" },
  );

  const aliceContactId = await asAlice.mutation(api.contacts.create, {
    phone: "111",
  });
  const bobContactId = await asBob.mutation(api.contacts.create, {
    phone: "222",
  });

  const aliceFieldId = await asAlice.mutation(api.customFields.create, {
    fieldName: "Plan",
    fieldType: "text",
  });
  await asAlice.mutation(api.customFields.setForContact, {
    contactId: aliceContactId,
    values: [{ customFieldId: aliceFieldId, value: "Pro" }],
  });
  const bobFieldId = await asBob.mutation(api.customFields.create, {
    fieldName: "Plan",
    fieldType: "text",
  });
  await asBob.mutation(api.customFields.setForContact, {
    contactId: bobContactId,
    values: [{ customFieldId: bobFieldId, value: "Pro" }],
  });

  await asAlice.mutation(api.contactNotes.add, {
    contactId: aliceContactId,
    body: "Alice note",
  });
  await asBob.mutation(api.contactNotes.add, {
    contactId: bobContactId,
    body: "Bob note",
  });

  const aliceDealId = await seedDeal(t, {
    accountId: aliceAccountId,
    contactId: aliceContactId,
  });
  const bobDealId = await seedDeal(t, {
    accountId: bobAccountId,
    contactId: bobContactId,
  });

  const aliceRecipientId = await seedBroadcastRecipient(t, {
    accountId: aliceAccountId,
    contactId: aliceContactId,
  });
  const bobRecipientId = await seedBroadcastRecipient(t, {
    accountId: bobAccountId,
    contactId: bobContactId,
  });

  await asAlice.mutation(api.contacts.remove, { contactId: aliceContactId });

  // Bob's rows: completely untouched by Alice's cascade.
  const bobValues = await t.run((ctx) =>
    ctx.db
      .query("contactCustomValues")
      .withIndex("by_contact", (q) => q.eq("contactId", bobContactId))
      .collect(),
  );
  expect(bobValues).toHaveLength(1);
  const bobNotes = await t.run((ctx) =>
    ctx.db
      .query("contactNotes")
      .withIndex("by_contact", (q) => q.eq("contactId", bobContactId))
      .collect(),
  );
  expect(bobNotes).toHaveLength(1);
  const bobDeal = await t.run((ctx) => ctx.db.get(bobDealId));
  expect(bobDeal!.contactId).toBe(bobContactId);
  const bobRecipient = await t.run((ctx) => ctx.db.get(bobRecipientId));
  expect(bobRecipient!.contactId).toBe(bobContactId);

  // Alice's own rows: cascaded as expected.
  const aliceValues = await t.run((ctx) =>
    ctx.db
      .query("contactCustomValues")
      .withIndex("by_contact", (q) => q.eq("contactId", aliceContactId))
      .collect(),
  );
  expect(aliceValues).toHaveLength(0);
  const aliceNotes = await t.run((ctx) =>
    ctx.db
      .query("contactNotes")
      .withIndex("by_contact", (q) => q.eq("contactId", aliceContactId))
      .collect(),
  );
  expect(aliceNotes).toHaveLength(0);
  const aliceDeal = await t.run((ctx) => ctx.db.get(aliceDealId));
  expect(aliceDeal!.contactId).toBeUndefined();
  const aliceRecipient = await t.run((ctx) => ctx.db.get(aliceRecipientId));
  expect(aliceRecipient!.contactId).toBeUndefined();
});

test("tags.remove cascades: deletes the contactTags rows referencing it", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "supervisor",
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
    role: "supervisor",
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
    role: "supervisor",
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

test("filterByTags matches by contact ID under an active tag filter", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "supervisor",
  });

  const tagA = await asUser.mutation(api.tags.create, {
    name: "A",
    color: "#000",
  });
  // Phones deliberately contain no "1", so the ID-search terms below match
  // ONLY via `contactCode`, not incidentally via the phone number.
  const c1 = await asUser.mutation(api.contacts.create, {
    phone: "555",
    name: "Jonas",
  }); // HC-000001
  const c2 = await asUser.mutation(api.contacts.create, {
    phone: "777",
    name: "Marija",
  }); // HC-000002
  // Both carry the tag, so a match must come from the ID, not the tag set.
  await asUser.mutation(api.contacts.assignTag, { contactId: c1, tagId: tagA });
  await asUser.mutation(api.contacts.assignTag, { contactId: c2, tagId: tagA });

  // Previously ID search silently returned nothing while a tag filter was
  // active (filterByTags matched name/phone/email only). Full code, bare
  // number, and zero-padded number now all resolve to c1 (not c2).
  for (const search of ["HC-000001", "1", "000001"]) {
    const result = await asUser.query(api.contacts.filterByTags, {
      tagIds: [tagA],
      search,
      limit: 10,
      offset: 0,
    });
    expect(result.total).toBe(1);
    expect(result.items[0]!._id).toBe(c1);
  }
});

test("filterByTags paginates with offset/limit while total reflects every match", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "supervisor",
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
    role: "supervisor",
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

// ============================================================
// server-side phone masking (Task 5, defense-in-depth) — agents/
// viewers have no Contacts UI, but `list`/`get` are still directly
// callable, so they mask below `supervisor` the same way
// `conversations.ts`'s `embedContact` does.
// ============================================================

test("contacts.get masks the phone for agent and viewer", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId } = await seedAccountMember(t, { name: "Ag", email: "ag@x.com", role: "agent" });
  const contactId = await t.run((ctx) =>
    ctx.db.insert("contacts", { accountId, phone: "+15551230148", phoneNormalized: "15551230148", name: "X" }),
  );
  const got = await asUser.query(api.contacts.get, { contactId });
  expect(got.phone).toMatch(/^•+48$/);
  expect(got.phoneNormalized).toBe("");
});

test("filterByTags masks phone for agent/viewer", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId } = await seedAccountMember(t, {
    name: "Ag",
    email: "ag@x.com",
    role: "agent",
  });
  const { tagId } = await t.run(async (ctx) => {
    const contactId = await ctx.db.insert("contacts", {
      accountId,
      phone: "+15551230148",
      phoneNormalized: "15551230148",
      name: "X",
    });
    const tagId = await ctx.db.insert("tags", {
      accountId,
      name: "VIP",
      color: "#f00",
    });
    await ctx.db.insert("contactTags", { accountId, contactId, tagId });
    return { contactId, tagId };
  });

  const result = await asUser.query(api.contacts.filterByTags, {
    tagIds: [tagId],
    limit: 10,
    offset: 0,
  });

  expect(result.items).toHaveLength(1);
  expect(result.items[0]!.phone).toMatch(/^•+48$/);
  expect(result.items[0]!.phoneNormalized).toBe("");
});

test("byCustomFieldValue masks phone for agent/viewer", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId } = await seedAccountMember(t, {
    name: "Ag",
    email: "ag@x.com",
    role: "agent",
  });
  const { fieldId } = await t.run(async (ctx) => {
    const contactId = await ctx.db.insert("contacts", {
      accountId,
      phone: "+15551230148",
      phoneNormalized: "15551230148",
      name: "X",
    });
    const fieldId = await ctx.db.insert("customFields", {
      accountId,
      fieldName: "Plan",
      fieldType: "text",
    });
    await ctx.db.insert("contactCustomValues", {
      accountId,
      contactId,
      customFieldId: fieldId,
      value: "Pro",
    });
    return { contactId, fieldId };
  });

  const result = await asUser.query(api.contacts.byCustomFieldValue, {
    customFieldId: fieldId,
    operator: "is",
    value: "Pro",
  });

  expect(result).toHaveLength(1);
  expect(result[0]!.phone).toMatch(/^•+48$/);
  expect(result[0]!.phoneNormalized).toBe("");
});

test("contacts.get masks both phone and altPhone for agent", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId } = await seedAccountMember(t, { name: "Ag", email: "ag@x.com", role: "agent" });
  const contactId = await t.run((ctx) =>
    ctx.db.insert("contacts", {
      accountId,
      phone: "+15551230148",
      phoneNormalized: "15551230148",
      altPhone: "+15551234567",
      name: "X",
    }),
  );
  const got = await asUser.query(api.contacts.get, { contactId });
  expect(got.phone).toMatch(/^•+48$/);
  expect(got.altPhone).toMatch(/^•+67$/);
  expect(got.phoneNormalized).toBe("");
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

test("update persists the extended contact fields", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Ana",
    email: "ana@example.com",
    role: "agent",
  });
  const contactId = await asUser.mutation(api.contacts.create, {
    phone: "+971501234567",
    name: "Guest",
  });

  await asUser.mutation(api.contacts.update, {
    contactId,
    altPhone: "+971559876543",
    address: "12 Marina Walk",
    city: "Dubai",
    country: "UAE",
    nationality: "Indian",
    preferredDestination: "Maldives",
    notes: "VIP — prefers window seat",
  });

  const doc = await t.run((ctx) => ctx.db.get(contactId));
  expect(doc?.altPhone).toBe("+971559876543");
  expect(doc?.address).toBe("12 Marina Walk");
  expect(doc?.city).toBe("Dubai");
  expect(doc?.country).toBe("UAE");
  expect(doc?.nationality).toBe("Indian");
  expect(doc?.preferredDestination).toBe("Maldives");
  expect(doc?.notes).toBe("VIP — prefers window seat");
});

// ============================================================
// contactCode — sequential HC-000001-style per-account identifier
// (Contact Section Enhancements, Task 1).
// ============================================================

test("create assigns sequential HC- contact codes per account, starting at HC-000001", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });

  const firstId = await asUser.mutation(api.contacts.create, { phone: "111" });
  const secondId = await asUser.mutation(api.contacts.create, { phone: "222" });

  const first = await t.run((ctx) => ctx.db.get(firstId));
  const second = await t.run((ctx) => ctx.db.get(secondId));
  expect(first!.contactCode).toBe("HC-000001");
  expect(second!.contactCode).toBe("HC-000002");
});

test("contact codes are numbered independently per account", async () => {
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

  const aliceId = await asAlice.mutation(api.contacts.create, { phone: "111" });
  const bobId = await asBob.mutation(api.contacts.create, { phone: "111" });

  const alice = await t.run((ctx) => ctx.db.get(aliceId));
  const bob = await t.run((ctx) => ctx.db.get(bobId));
  expect(alice!.contactCode).toBe("HC-000001");
  expect(bob!.contactCode).toBe("HC-000001");
});

// ============================================================
// contactCode via findOrCreateByPhoneInternal (Contact Section
// Enhancements, Task 2) — the account-explicit find-or-create the
// public API uses must allocate a code on the CREATE branch only; a
// FIND must never burn a number.
// ============================================================

test("findOrCreateByPhoneInternal assigns a contact code on create, none extra on find", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });

  const created = await t.mutation(
    internal.contacts.findOrCreateByPhoneInternal,
    { accountId, phone: "+971501234567", name: "Guest" },
  );
  expect(created.created).toBe(true);
  const row = await t.run((ctx) => ctx.db.get(created.contactId));
  expect(row!.contactCode).toBe("HC-000001");

  const found = await t.mutation(
    internal.contacts.findOrCreateByPhoneInternal,
    { accountId, phone: "+971501234567" },
  );
  expect(found.created).toBe(false);
  expect(found.contactId).toBe(created.contactId);

  // No wasted number: the counter only advanced once.
  const counter = await t.run((ctx) =>
    ctx.db
      .query("counters")
      .withIndex("by_account_name", (q) =>
        q.eq("accountId", accountId).eq("name", "contacts"),
      )
      .first(),
  );
  expect(counter!.value).toBe(1);
});

// ============================================================
// backfillContactCodes (Contact Section Enhancements, Task 3) — the
// one-shot migration that codes contacts created before this feature
// existed.
// ============================================================

test("backfillContactCodes assigns codes in creation order, is idempotent, and seeds the counter", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });

  // Insert three code-less contacts directly (simulating pre-migration
  // rows), in the REVERSE of their expected code order — phone "333" is
  // created first, "111" last. If codes were assigned by anything other
  // than true `_creationTime` order (e.g. phone value, or whatever
  // incidental order `.collect()` happened to return), this would
  // produce a different, easily-distinguishable result; ascending
  // insertion order couldn't have told the two apart.
  const ids: Id<"contacts">[] = [];
  for (const phone of ["333", "222", "111"]) {
    const id = await t.run((ctx) =>
      ctx.db.insert("contacts", { accountId, phone, phoneNormalized: phone }),
    );
    ids.push(id);
  }

  await t.mutation(internal.contacts.backfillContactCodes, {});

  const codes = await Promise.all(
    ids.map((id) => t.run((ctx) => ctx.db.get(id).then((c) => c!.contactCode))),
  );
  // ids[0] ("333") was created FIRST, so it gets the LOWEST code — even
  // though "333" is numerically/lexically the largest phone value.
  expect(codes).toEqual(["HC-000001", "HC-000002", "HC-000003"]);

  // Idempotent: re-running changes nothing.
  await t.mutation(internal.contacts.backfillContactCodes, {});
  const codesAgain = await Promise.all(
    ids.map((id) => t.run((ctx) => ctx.db.get(id).then((c) => c!.contactCode))),
  );
  expect(codesAgain).toEqual(["HC-000001", "HC-000002", "HC-000003"]);

  // Counter is seeded to the highest number used, so the next create
  // continues at HC-000004 rather than colliding at HC-000001.
  const counter = await t.run((ctx) =>
    ctx.db
      .query("counters")
      .withIndex("by_account_name", (q) =>
        q.eq("accountId", accountId).eq("name", "contacts"),
      )
      .first(),
  );
  expect(counter!.value).toBe(3);
});

test("backfillContactCodes seeds past a counter that lags an already-assigned code's numeric suffix", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });

  // An already-coded contact whose numeric suffix (50) is HIGHER than the
  // counter row below (3) — simulates a counter that drifted behind
  // reality (e.g. codes assigned by some path other than
  // `allocateContactCode`). Without the "bump past the max assigned code"
  // logic (convex/contacts.ts:134-139), the backfill below would trust the
  // stale counter, hand the code-less contact HC-000004, and leave the
  // counter at 4 — a future `create` would eventually count up to 50 and
  // collide with this contact's existing HC-000050.
  await t.run((ctx) =>
    ctx.db.insert("contacts", {
      accountId,
      phone: "111",
      phoneNormalized: "111",
      contactCode: "HC-000050",
    }),
  );
  await t.run((ctx) =>
    ctx.db.insert("counters", { accountId, name: "contacts", value: 3 }),
  );

  // A code-less contact that still needs backfilling.
  const codelessId = await t.run((ctx) =>
    ctx.db.insert("contacts", {
      accountId,
      phone: "222",
      phoneNormalized: "222",
    }),
  );

  await t.mutation(internal.contacts.backfillContactCodes, {});

  // Continues from the true max (50), not the stale counter (3): lands on
  // HC-000051, never colliding with the existing HC-000050.
  const codeless = await t.run((ctx) => ctx.db.get(codelessId));
  expect(codeless!.contactCode).toBe("HC-000051");

  const counter = await t.run((ctx) =>
    ctx.db
      .query("counters")
      .withIndex("by_account_name", (q) =>
        q.eq("accountId", accountId).eq("name", "contacts"),
      )
      .first(),
  );
  expect(counter!.value).toBe(51);
});

test("backfillContactCodes scopes numbering and counters independently per account", async () => {
  const t = convexTest(schema, modules);
  const { accountId: aliceId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const { accountId: bobId } = await seedAccountMember(t, {
    name: "Bob",
    email: "bob@example.com",
    role: "agent",
  });
  const { accountId: carolId } = await seedAccountMember(t, {
    name: "Carol",
    email: "carol@example.com",
    role: "agent",
  });

  // Alice gets two code-less contacts, Bob gets one, Carol gets none at
  // all — she should come out of a global backfill run completely
  // untouched.
  const aliceIds: Id<"contacts">[] = [];
  for (const phone of ["a1", "a2"]) {
    const id = await t.run((ctx) =>
      ctx.db.insert("contacts", {
        accountId: aliceId,
        phone,
        phoneNormalized: phone,
      }),
    );
    aliceIds.push(id);
  }
  const bobContactId = await t.run((ctx) =>
    ctx.db.insert("contacts", {
      accountId: bobId,
      phone: "b1",
      phoneNormalized: "b1",
    }),
  );

  await t.mutation(internal.contacts.backfillContactCodes, {});

  const aliceCodes = await Promise.all(
    aliceIds.map((id) => t.run((ctx) => ctx.db.get(id).then((c) => c!.contactCode))),
  );
  expect(aliceCodes).toEqual(["HC-000001", "HC-000002"]);

  // Bob's own sequence starts at HC-000001 too, not HC-000003 — proving
  // his numbering doesn't continue on from Alice's.
  const bobContact = await t.run((ctx) => ctx.db.get(bobContactId));
  expect(bobContact!.contactCode).toBe("HC-000001");

  const aliceCounter = await t.run((ctx) =>
    ctx.db
      .query("counters")
      .withIndex("by_account_name", (q) =>
        q.eq("accountId", aliceId).eq("name", "contacts"),
      )
      .first(),
  );
  const bobCounter = await t.run((ctx) =>
    ctx.db
      .query("counters")
      .withIndex("by_account_name", (q) =>
        q.eq("accountId", bobId).eq("name", "contacts"),
      )
      .first(),
  );
  const carolCounter = await t.run((ctx) =>
    ctx.db
      .query("counters")
      .withIndex("by_account_name", (q) =>
        q.eq("accountId", carolId).eq("name", "contacts"),
      )
      .first(),
  );
  expect(aliceCounter!.value).toBe(2);
  expect(bobCounter!.value).toBe(1);
  // Carol had zero contacts, so the backfill never touches her: no counter
  // row is conjured out of nowhere (`next` stays 0, and the mutation only
  // inserts a counter when `next > 0`).
  expect(carolCounter).toBeNull();
});

// ============================================================
// assignTag — single-select group displacement (Task 4)
// ============================================================

test("assignTag displaces the prior tag from a single-select group", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId } = await seedAccountMember(t, { name: "Sup", email: "ss@x.com", role: "supervisor" });
  const gid = await asUser.mutation(api.tagGroups.create, { name: "Product", selectionMode: "single" });
  const uae = await asUser.mutation(api.tags.create, { name: "UAE Visa", color: "#3b82f6", groupId: gid });
  const pkg = await asUser.mutation(api.tags.create, { name: "Packages", color: "#f59e0b", groupId: gid });
  const contactId = await t.run((ctx) =>
    ctx.db.insert("contacts", { accountId, phone: "+15550001", phoneNormalized: "15550001" }),
  );

  await asUser.mutation(api.contacts.assignTag, { contactId, tagId: uae });
  await asUser.mutation(api.contacts.assignTag, { contactId, tagId: pkg }); // same single group

  const links = await t.run((ctx) =>
    ctx.db.query("contactTags").withIndex("by_contact", (q) => q.eq("contactId", contactId)).collect(),
  );
  expect(links.map((l) => l.tagId)).toEqual([pkg]); // UAE displaced
});

test("assignTag keeps both tags for a multi-select group", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId } = await seedAccountMember(t, { name: "Sup", email: "sm@x.com", role: "supervisor" });
  const gid = await asUser.mutation(api.tagGroups.create, { name: "Destination", selectionMode: "multi" });
  const th = await asUser.mutation(api.tags.create, { name: "Thailand", color: "#10b981", groupId: gid });
  const ba = await asUser.mutation(api.tags.create, { name: "Bali", color: "#06b6d4", groupId: gid });
  const contactId = await t.run((ctx) =>
    ctx.db.insert("contacts", { accountId, phone: "+15550002", phoneNormalized: "15550002" }),
  );

  await asUser.mutation(api.contacts.assignTag, { contactId, tagId: th });
  await asUser.mutation(api.contacts.assignTag, { contactId, tagId: ba });

  const links = await t.run((ctx) =>
    ctx.db.query("contactTags").withIndex("by_contact", (q) => q.eq("contactId", contactId)).collect(),
  );
  expect(links.map((l) => l.tagId).sort()).toEqual([th, ba].sort());
});

// ============================================================
// travel-profile fields (Task 1: contact write-back columns) —
// travelDates/travelers/budget round-trip through contacts.update
// the same way nationality/preferredDestination already do.
// ============================================================

test("update round-trips the travel-profile fields", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId } = await seedAccountMember(t, {
    name: "Ag", email: "ag@x.com", role: "agent",
  });
  const contactId = await t.run((ctx) =>
    ctx.db.insert("contacts", {
      accountId, phone: "+15551230199", phoneNormalized: "15551230199", name: "X",
    }),
  );
  await asUser.mutation(api.contacts.update, {
    contactId,
    travelDates: "mid December",
    travelers: "2 adults + 1 child aged 9",
    budget: "around AED 3,000 per person",
  });
  const row = await t.run((ctx) => ctx.db.get(contactId));
  expect(row).toMatchObject({
    travelDates: "mid December",
    travelers: "2 adults + 1 child aged 9",
    budget: "around AED 3,000 per person",
  });
});
