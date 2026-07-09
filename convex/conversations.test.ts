/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import type { AccountRole } from "./lib/roles";

// Convex function modules for convex-test to resolve `api.*` references
// against. Absolute, from-project-root pattern (matches
// `convex/contacts.test.ts` — see that file's comment for why this must
// be absolute rather than a relative "./**").
const modules = import.meta.glob("/convex/**/*.ts");

/**
 * Seeds a `users` row + an `accounts`/`memberships` row for a fresh
 * account, and returns a convex-test client already authenticated as
 * that user. Duplicated from `convex/contacts.test.ts` rather than
 * imported — each `convex/*.test.ts` suite owns its own copy of this
 * helper (see `convex/contacts.test.ts`'s own comment on
 * `seedAccountMember` and `convex/lib/auth.test.ts`'s `insertUser`/
 * `insertMembership` for the same pattern elsewhere). Bypasses
 * `accounts.bootstrapAccount` on purpose — this suite tests
 * `conversations.ts`, not the bootstrap flow.
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
 * Inserts a `conversations` row directly via `t.run` (Phase 2 Task 1
 * only builds the read side — `messages.append`'s denormalized writes
 * land in Task 2), per the task brief's own instruction. `unreadCount`
 * is the one required-but-uninteresting field beyond
 * `accountId`/`contactId`/`status`, so it defaults to 0 here exactly
 * like every real write will supply.
 */
async function seedConversation(
  t: ReturnType<typeof convexTest>,
  opts: {
    accountId: Id<"accounts">;
    contactId: Id<"contacts">;
    status?: "open" | "pending" | "closed";
    lastMessageAt?: number;
  },
) {
  return await t.run((ctx) =>
    ctx.db.insert("conversations", {
      accountId: opts.accountId,
      contactId: opts.contactId,
      status: opts.status ?? "open",
      lastMessageAt: opts.lastMessageAt,
      unreadCount: 0,
    }),
  );
}

const onePage = { paginationOpts: { numItems: 50, cursor: null } };

// ============================================================
// cross-account denial — proves the account-isolation model holds for
// the new `conversations.list`/`conversations.get` queries.
// ============================================================

test("list never returns another account's conversations", async () => {
  const t = convexTest(schema, modules);
  const { asUser: asAlice, accountId: aliceAccountId } =
    await seedAccountMember(t, {
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
  await seedConversation(t, {
    accountId: aliceAccountId,
    contactId: aliceContactId,
  });

  const bobsView = await asBob.query(api.conversations.list, onePage);
  expect(bobsView.page).toHaveLength(0);

  const alicesView = await asAlice.query(api.conversations.list, onePage);
  expect(alicesView.page).toHaveLength(1);
});

test("get throws NOT_FOUND for a conversation belonging to a different account", async () => {
  const t = convexTest(schema, modules);
  const { asUser: asAlice, accountId: aliceAccountId } =
    await seedAccountMember(t, {
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
  const conversationId = await seedConversation(t, {
    accountId: aliceAccountId,
    contactId: aliceContactId,
  });

  await expect(
    asBob.query(api.conversations.get, { conversationId }),
  ).rejects.toMatchObject({
    data: { code: "NOT_FOUND", entity: "conversation" },
  });

  // Alice herself can still read it — proves the throw above is really
  // about cross-account isolation, not a broken `get` in general.
  const hers = await asAlice.query(api.conversations.get, { conversationId });
  expect(hers._id).toBe(conversationId);
});

test("get throws NOT_FOUND for a conversation that no longer exists", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const contactId = await asUser.mutation(api.contacts.create, {
    phone: "111",
  });
  const conversationId = await seedConversation(t, { accountId, contactId });
  await t.run((ctx) => ctx.db.delete(conversationId));

  await expect(
    asUser.query(api.conversations.get, { conversationId }),
  ).rejects.toMatchObject({
    data: { code: "NOT_FOUND", entity: "conversation" },
  });
});

// ============================================================
// same-account happy path
// ============================================================

test("list returns a seeded conversation with its embedded contact and the contact's tags", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId } = await seedAccountMember(t, {
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
  const conversationId = await seedConversation(t, { accountId, contactId });

  const result = await asUser.query(api.conversations.list, onePage);

  expect(result.page).toHaveLength(1);
  expect(result.page[0]!._id).toBe(conversationId);
  expect(result.page[0]!.contact).not.toBeNull();
  expect(result.page[0]!.contact!._id).toBe(contactId);
  expect(result.page[0]!.contact!.tags).toHaveLength(1);
  expect(result.page[0]!.contact!.tags[0]!._id).toBe(tagId);
});

test("get returns the conversation with its embedded contact", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });

  const contactId = await asUser.mutation(api.contacts.create, {
    phone: "111",
    name: "Jonas",
  });
  const conversationId = await seedConversation(t, { accountId, contactId });

  const result = await asUser.query(api.conversations.get, {
    conversationId,
  });

  expect(result._id).toBe(conversationId);
  expect(result.contact).not.toBeNull();
  expect(result.contact!._id).toBe(contactId);
  expect(result.contact!.tags).toEqual([]);
});

// ============================================================
// ordering + status filter — the reason `by_account_last_message` exists
// ============================================================

test("list orders conversations by lastMessageAt descending", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const contactId = await asUser.mutation(api.contacts.create, {
    phone: "111",
  });

  const oldest = await seedConversation(t, {
    accountId,
    contactId,
    lastMessageAt: 1000,
  });
  const newest = await seedConversation(t, {
    accountId,
    contactId,
    lastMessageAt: 3000,
  });
  const middle = await seedConversation(t, {
    accountId,
    contactId,
    lastMessageAt: 2000,
  });

  const result = await asUser.query(api.conversations.list, onePage);

  expect(result.page.map((c) => c._id)).toEqual([newest, middle, oldest]);
});

test("list sorts a conversation with no lastMessageAt after every conversation that has one", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const contactId = await asUser.mutation(api.contacts.create, {
    phone: "111",
  });

  // No `lastMessageAt` — a brand new conversation with no messages yet.
  const noMessagesYet = await seedConversation(t, { accountId, contactId });
  const hasMessage = await seedConversation(t, {
    accountId,
    contactId,
    lastMessageAt: 1000,
  });

  const result = await asUser.query(api.conversations.list, onePage);

  expect(result.page.map((c) => c._id)).toEqual([hasMessage, noMessagesYet]);
});

test("list applies the optional status filter", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const contactId = await asUser.mutation(api.contacts.create, {
    phone: "111",
  });

  const open = await seedConversation(t, {
    accountId,
    contactId,
    status: "open",
    lastMessageAt: 1,
  });
  const closed = await seedConversation(t, {
    accountId,
    contactId,
    status: "closed",
    lastMessageAt: 2,
  });

  const openOnly = await asUser.query(api.conversations.list, {
    status: "open",
    paginationOpts: { numItems: 50, cursor: null },
  });
  expect(openOnly.page.map((c) => c._id)).toEqual([open]);

  const closedOnly = await asUser.query(api.conversations.list, {
    status: "closed",
    paginationOpts: { numItems: 50, cursor: null },
  });
  expect(closedOnly.page.map((c) => c._id)).toEqual([closed]);

  const all = await asUser.query(api.conversations.list, onePage);
  expect(all.page).toHaveLength(2);
});

test("embeds contact: null when the conversation's contact has been deleted", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const contactId = await asUser.mutation(api.contacts.create, {
    phone: "111",
  });
  const conversationId = await seedConversation(t, { accountId, contactId });

  // `contacts.remove` has no cascade onto `conversations` (see
  // `convex/conversations.ts`'s `embedContact` comment) — deleting the
  // contact directly reproduces that dangling-reference state without
  // waiting for a future cascade to be built.
  await asUser.mutation(api.contacts.remove, { contactId });

  const viaGet = await asUser.query(api.conversations.get, {
    conversationId,
  });
  expect(viaGet.contact).toBeNull();

  const viaList = await asUser.query(api.conversations.list, onePage);
  expect(viaList.page[0]!.contact).toBeNull();
});
