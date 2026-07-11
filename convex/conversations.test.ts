/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { api, internal } from "./_generated/api";
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
 * defaults to 0, matching every real write, but is overridable —
 * `unreadTotal`'s tests (Phase 8/9 stragglers) need seeded conversations
 * with a nonzero count, the same way `status`/`lastMessageAt` are
 * already overridable above their own defaults.
 */
async function seedConversation(
  t: ReturnType<typeof convexTest>,
  opts: {
    accountId: Id<"accounts">;
    contactId: Id<"contacts">;
    status?: "open" | "pending" | "closed";
    lastMessageAt?: number;
    unreadCount?: number;
  },
) {
  return await t.run((ctx) =>
    ctx.db.insert("conversations", {
      accountId: opts.accountId,
      contactId: opts.contactId,
      status: opts.status ?? "open",
      lastMessageAt: opts.lastMessageAt,
      unreadCount: opts.unreadCount ?? 0,
    }),
  );
}

/**
 * Adds a second membership row to an *existing* account — unlike
 * `seedAccountMember`, which always mints a brand-new account.
 * `assign`'s tests need a real teammate `userId` on the *same* account
 * as the conversation being assigned, which `seedAccountMember` alone
 * can't produce.
 */
async function seedTeammate(
  t: ReturnType<typeof convexTest>,
  opts: {
    accountId: Id<"accounts">;
    name: string;
    email: string;
    role: AccountRole;
  },
) {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {
      name: opts.name,
      email: opts.email,
    });
    await ctx.db.insert("memberships", {
      userId,
      accountId: opts.accountId,
      role: opts.role,
      fullName: opts.name,
      email: opts.email,
    });
    return userId;
  });
}

/**
 * Seeds a teammate onto an existing account with a chosen role and
 * returns an authenticated client for them — unlike `seedTeammate`
 * above (bare `userId`, no client) or `seedAccountMember` (always
 * mints a fresh account). Used by the role-scoped visibility tests
 * (Task 4) below, which need several differently-roled teammates on
 * the SAME account.
 */
async function seedUserInAccount(
  t: ReturnType<typeof convexTest>,
  accountId: Id<"accounts">,
  opts: { name: string; email: string; role: AccountRole },
) {
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { name: opts.name, email: opts.email }),
  );
  await t.run((ctx) =>
    ctx.db.insert("memberships", {
      userId,
      accountId,
      role: opts.role,
      fullName: opts.name,
      email: opts.email,
    }),
  );
  return { userId, asUser: t.withIdentity({ subject: `${userId}|s-${opts.name}` }) };
}

/**
 * Seeds a contact + its conversation in one call, optionally
 * pre-assigned — unlike `seedConversation` above, which takes an
 * already-created `contactId` and has no `assignedToUserId` knob. Used
 * by the role-scoped visibility tests to seed "mine" / "pool" /
 * "a teammate's" conversations.
 */
async function seedConv(
  t: ReturnType<typeof convexTest>,
  accountId: Id<"accounts">,
  opts: { phone: string; name: string; assignedToUserId?: Id<"users"> },
) {
  const contactId = await t.run((ctx) =>
    ctx.db.insert("contacts", {
      accountId,
      phone: opts.phone,
      phoneNormalized: opts.phone.replace(/\D/g, ""),
      name: opts.name,
    }),
  );
  const conversationId = await t.run((ctx) =>
    ctx.db.insert("conversations", {
      accountId,
      contactId,
      status: "open" as const,
      unreadCount: 0,
      ...(opts.assignedToUserId
        ? { assignedToUserId: opts.assignedToUserId }
        : {}),
    }),
  );
  return { contactId, conversationId };
}

/**
 * Seeds a bare account + its owner membership with no `asUser` client
 * of its own — the role-scoped visibility tests build their own
 * differently-roled teammates via `seedUserInAccount` and never need
 * to act as the owner directly.
 */
async function seedAccountWithOwner(t: ReturnType<typeof convexTest>) {
  const ownerId = await t.run((ctx) =>
    ctx.db.insert("users", { name: "Owner", email: "owner@x.com" }),
  );
  const accountId = await t.run(async (ctx) => {
    const id = await ctx.db.insert("accounts", {
      name: "Acme",
      defaultCurrency: "USD",
      ownerUserId: ownerId,
    });
    await ctx.db.insert("memberships", { userId: ownerId, accountId: id, role: "owner" });
    return id;
  });
  return { ownerId, accountId };
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

// ============================================================
// findOrCreateForContact — idempotent get-or-insert
// ============================================================

test("findOrCreateForContact returns the same conversation id on a second call, without creating a duplicate row", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const contactId = await asUser.mutation(api.contacts.create, {
    phone: "111",
  });

  const first = await asUser.mutation(
    api.conversations.findOrCreateForContact,
    { contactId },
  );
  const second = await asUser.mutation(
    api.conversations.findOrCreateForContact,
    { contactId },
  );

  expect(second).toBe(first);

  const rows = await t.run((ctx) =>
    ctx.db
      .query("conversations")
      .withIndex("by_contact", (q) => q.eq("contactId", contactId))
      .collect(),
  );
  expect(rows).toHaveLength(1);
  expect(rows[0]!._id).toBe(first);
  expect(rows[0]!.accountId).toBe(accountId);
  expect(rows[0]!.status).toBe("open");
  expect(rows[0]!.unreadCount).toBe(0);
});

test("findOrCreateForContact throws NOT_FOUND for a contact belonging to a different account", async () => {
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
    asBob.mutation(api.conversations.findOrCreateForContact, {
      contactId: aliceContactId,
    }),
  ).rejects.toMatchObject({ data: { code: "NOT_FOUND", entity: "contact" } });

  const rows = await t.run((ctx) =>
    ctx.db
      .query("conversations")
      .withIndex("by_contact", (q) => q.eq("contactId", aliceContactId))
      .collect(),
  );
  expect(rows).toHaveLength(0);
});

// ============================================================
// findOrCreateForContactInternal — server-only counterpart, for
// `send.ts`'s public `send` action (Phase 8, Task 4): no user session
// to derive `ctx.accountId` from, so `accountId` is caller-supplied.
// ============================================================

test("findOrCreateForContactInternal returns the same conversation id on a second call, without creating a duplicate row", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const contactId = await asUser.mutation(api.contacts.create, {
    phone: "111",
  });

  const first = await t.mutation(
    internal.conversations.findOrCreateForContactInternal,
    { accountId, contactId },
  );
  const second = await t.mutation(
    internal.conversations.findOrCreateForContactInternal,
    { accountId, contactId },
  );

  expect(second).toBe(first);

  const rows = await t.run((ctx) =>
    ctx.db
      .query("conversations")
      .withIndex("by_contact", (q) => q.eq("contactId", contactId))
      .collect(),
  );
  expect(rows).toHaveLength(1);
  expect(rows[0]!._id).toBe(first);
  expect(rows[0]!.accountId).toBe(accountId);
  expect(rows[0]!.status).toBe("open");
  expect(rows[0]!.unreadCount).toBe(0);
});

test("findOrCreateForContactInternal throws NOT_FOUND for a contact belonging to a different account", async () => {
  const t = convexTest(schema, modules);
  const { asUser: asAlice } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const { accountId: bobAccountId } = await seedAccountMember(t, {
    name: "Bob",
    email: "bob@example.com",
    role: "agent",
  });
  const aliceContactId = await asAlice.mutation(api.contacts.create, {
    phone: "111",
  });

  await expect(
    t.mutation(internal.conversations.findOrCreateForContactInternal, {
      accountId: bobAccountId,
      contactId: aliceContactId,
    }),
  ).rejects.toMatchObject({ data: { code: "NOT_FOUND", entity: "contact" } });

  const rows = await t.run((ctx) =>
    ctx.db
      .query("conversations")
      .withIndex("by_contact", (q) => q.eq("contactId", aliceContactId))
      .collect(),
  );
  expect(rows).toHaveLength(0);
});

// ============================================================
// getByContact — read-only counterpart to findOrCreateForContact;
// never creates, returns null when no thread exists yet
// ============================================================

test("getByContact returns the contact's conversation with its embedded contact", async () => {
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

  const result = await asUser.query(api.conversations.getByContact, {
    contactId,
  });

  expect(result).not.toBeNull();
  expect(result!._id).toBe(conversationId);
  expect(result!.contact).not.toBeNull();
  expect(result!.contact!._id).toBe(contactId);
});

test("getByContact returns null when the contact has no conversation yet", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const contactId = await asUser.mutation(api.contacts.create, {
    phone: "111",
  });

  const result = await asUser.query(api.conversations.getByContact, {
    contactId,
  });
  expect(result).toBeNull();
});

test("getByContact throws NOT_FOUND for a contact belonging to a different account", async () => {
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
    asBob.query(api.conversations.getByContact, {
      contactId: aliceContactId,
    }),
  ).rejects.toMatchObject({ data: { code: "NOT_FOUND", entity: "contact" } });

  // Alice herself can still read it — proves the throw above is really
  // about cross-account isolation, not a broken `getByContact` in
  // general.
  const hers = await asAlice.query(api.conversations.getByContact, {
    contactId: aliceContactId,
  });
  expect(hers).toBeNull();
});

// ============================================================
// unreadTotal — count of the account's conversations with
// unreadCount > 0 (Phase 8/9 stragglers: the sidebar unread badge,
// `src/hooks/use-total-unread.ts`'s Convex counterpart)
// ============================================================

test("unreadTotal counts only conversations with unreadCount > 0 in the caller's account", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const contactId = await asUser.mutation(api.contacts.create, {
    phone: "111",
  });

  await seedConversation(t, { accountId, contactId, unreadCount: 2 });
  await seedConversation(t, { accountId, contactId, unreadCount: 1 });
  await seedConversation(t, { accountId, contactId, unreadCount: 0 });

  const total = await asUser.query(api.conversations.unreadTotal, {});
  expect(total).toBe(2);
});

test("unreadTotal does not count another account's unread conversations", async () => {
  const t = convexTest(schema, modules);
  const { asUser: asAlice, accountId: aliceAccountId } =
    await seedAccountMember(t, {
      name: "Alice",
      email: "alice@example.com",
      role: "agent",
    });
  const { asUser: asBob, accountId: bobAccountId } = await seedAccountMember(
    t,
    { name: "Bob", email: "bob@example.com", role: "agent" },
  );
  const aliceContactId = await asAlice.mutation(api.contacts.create, {
    phone: "111",
  });
  const bobContactId = await asBob.mutation(api.contacts.create, {
    phone: "222",
  });

  await seedConversation(t, {
    accountId: aliceAccountId,
    contactId: aliceContactId,
    unreadCount: 3,
  });
  await seedConversation(t, {
    accountId: bobAccountId,
    contactId: bobContactId,
    unreadCount: 5,
  });

  expect(await asAlice.query(api.conversations.unreadTotal, {})).toBe(1);
  expect(await asBob.query(api.conversations.unreadTotal, {})).toBe(1);
});

// ============================================================
// assign — target must be a real member of the same account
// ============================================================

test("assign rejects a userId that is not a member of the account", async () => {
  const t = convexTest(schema, modules);
  const { asUser: asAlice, accountId: aliceAccountId } =
    await seedAccountMember(t, {
      name: "Alice",
      email: "alice@example.com",
      role: "agent",
    });
  const { userId: bobUserId } = await seedAccountMember(t, {
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
    asAlice.mutation(api.conversations.assign, {
      conversationId,
      userId: bobUserId,
    }),
  ).rejects.toMatchObject({ data: { code: "NOT_FOUND", entity: "member" } });

  const row = await t.run((ctx) => ctx.db.get(conversationId));
  expect(row!.assignedToUserId).toBeUndefined();
  expect(row!.status).toBe("open");
});

test("assign sets assignedToUserId and status:pending for a real member of the account", async () => {
  const t = convexTest(schema, modules);
  const { asUser: asAlice, accountId: aliceAccountId } =
    await seedAccountMember(t, {
      name: "Alice",
      email: "alice@example.com",
      role: "agent",
    });
  const carolUserId = await seedTeammate(t, {
    accountId: aliceAccountId,
    name: "Carol",
    email: "carol@example.com",
    role: "agent",
  });
  const contactId = await asAlice.mutation(api.contacts.create, {
    phone: "111",
  });
  const conversationId = await seedConversation(t, {
    accountId: aliceAccountId,
    contactId,
    status: "open",
  });

  const beforeAssign = Date.now();
  const result = await asAlice.mutation(api.conversations.assign, {
    conversationId,
    userId: carolUserId,
  });
  expect(result).toBe(conversationId);

  const row = await t.run((ctx) => ctx.db.get(conversationId));
  expect(row!.assignedToUserId).toBe(carolUserId);
  expect(row!.status).toBe("pending");
  expect(row!.updatedAt).toBeGreaterThanOrEqual(beforeAssign);
});

// ============================================================
// unassign — clears assignedToUserId; leaves status untouched (see
// the mutation's own doc comment for why)
// ============================================================

test("unassign clears assignedToUserId and leaves status untouched", async () => {
  const t = convexTest(schema, modules);
  const { asUser: asAlice, accountId: aliceAccountId } =
    await seedAccountMember(t, {
      name: "Alice",
      email: "alice@example.com",
      role: "agent",
    });
  const carolUserId = await seedTeammate(t, {
    accountId: aliceAccountId,
    name: "Carol",
    email: "carol@example.com",
    role: "agent",
  });
  const contactId = await asAlice.mutation(api.contacts.create, {
    phone: "111",
  });
  const conversationId = await seedConversation(t, {
    accountId: aliceAccountId,
    contactId,
    status: "open",
  });
  await asAlice.mutation(api.conversations.assign, {
    conversationId,
    userId: carolUserId,
  });

  const beforeUnassign = Date.now();
  const result = await asAlice.mutation(api.conversations.unassign, {
    conversationId,
  });
  expect(result).toBe(conversationId);

  const row = await t.run((ctx) => ctx.db.get(conversationId));
  expect(row!.assignedToUserId).toBeUndefined();
  // status is left untouched by design — `assign` bumped it to
  // "pending" and `unassign` doesn't reverse that (see `unassign`'s
  // own doc comment on this file for the reasoning).
  expect(row!.status).toBe("pending");
  expect(row!.updatedAt).toBeGreaterThanOrEqual(beforeUnassign);
});

test("unassign throws NOT_FOUND for a conversation belonging to a different account, and leaves it untouched", async () => {
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
  const carolUserId = await seedTeammate(t, {
    accountId: aliceAccountId,
    name: "Carol",
    email: "carol@example.com",
    role: "agent",
  });
  const contactId = await asAlice.mutation(api.contacts.create, {
    phone: "111",
  });
  const conversationId = await seedConversation(t, {
    accountId: aliceAccountId,
    contactId,
  });
  await asAlice.mutation(api.conversations.assign, {
    conversationId,
    userId: carolUserId,
  });

  await expect(
    asBob.mutation(api.conversations.unassign, { conversationId }),
  ).rejects.toMatchObject({
    data: { code: "NOT_FOUND", entity: "conversation" },
  });

  const row = await t.run((ctx) => ctx.db.get(conversationId));
  expect(row!.assignedToUserId).toBe(carolUserId);
});

test("unassign is rejected for a viewer (below the agent role floor), leaving the assignment untouched", async () => {
  const t = convexTest(schema, modules);
  const { asUser: asAlice, accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const carolUserId = await seedTeammate(t, {
    accountId,
    name: "Carol",
    email: "carol@example.com",
    role: "agent",
  });
  const vicUserId = await seedTeammate(t, {
    accountId,
    name: "Vic",
    email: "vic@example.com",
    role: "viewer",
  });
  const asVic = t.withIdentity({ subject: `${vicUserId}|session-Vic` });
  const contactId = await asAlice.mutation(api.contacts.create, {
    phone: "111",
  });
  const conversationId = await seedConversation(t, { accountId, contactId });
  await asAlice.mutation(api.conversations.assign, {
    conversationId,
    userId: carolUserId,
  });

  await expect(
    asVic.mutation(api.conversations.unassign, { conversationId }),
  ).rejects.toMatchObject({ data: { code: "FORBIDDEN", min: "agent" } });

  const row = await t.run((ctx) => ctx.db.get(conversationId));
  expect(row!.assignedToUserId).toBe(carolUserId);
});

// ============================================================
// setStatus
// ============================================================

test("setStatus updates the conversation's status and bumps updatedAt", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const contactId = await asUser.mutation(api.contacts.create, {
    phone: "111",
  });
  const conversationId = await seedConversation(t, {
    accountId,
    contactId,
    status: "open",
  });

  const beforeUpdate = Date.now();
  const result = await asUser.mutation(api.conversations.setStatus, {
    conversationId,
    status: "closed",
  });
  expect(result).toBe(conversationId);

  const row = await t.run((ctx) => ctx.db.get(conversationId));
  expect(row!.status).toBe("closed");
  expect(row!.updatedAt).toBeGreaterThanOrEqual(beforeUpdate);
});

// ============================================================
// markRead
// ============================================================

test("markRead zeroes unreadCount", async () => {
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
  await asUser.mutation(api.messages.append, {
    conversationId,
    senderType: "customer",
    contentType: "text",
    contentText: "Hello?",
  });
  const before = await t.run((ctx) => ctx.db.get(conversationId));
  expect(before!.unreadCount).toBe(1);

  const result = await asUser.mutation(api.conversations.markRead, {
    conversationId,
  });
  expect(result).toBe(conversationId);

  const after = await t.run((ctx) => ctx.db.get(conversationId));
  expect(after!.unreadCount).toBe(0);
});

// ============================================================
// cross-account denial — every new mutation added by this task
// ============================================================

test("assign/setStatus/markRead all throw NOT_FOUND for a conversation belonging to a different account, and leave it untouched", async () => {
  const t = convexTest(schema, modules);
  const { asUser: asAlice, accountId: aliceAccountId } =
    await seedAccountMember(t, {
      name: "Alice",
      email: "alice@example.com",
      role: "agent",
    });
  const { asUser: asBob, userId: bobUserId } = await seedAccountMember(t, {
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
    asBob.mutation(api.conversations.assign, {
      conversationId,
      userId: bobUserId,
    }),
  ).rejects.toMatchObject({
    data: { code: "NOT_FOUND", entity: "conversation" },
  });

  await expect(
    asBob.mutation(api.conversations.setStatus, {
      conversationId,
      status: "closed",
    }),
  ).rejects.toMatchObject({
    data: { code: "NOT_FOUND", entity: "conversation" },
  });

  await expect(
    asBob.mutation(api.conversations.markRead, { conversationId }),
  ).rejects.toMatchObject({
    data: { code: "NOT_FOUND", entity: "conversation" },
  });

  // Untouched by every rejected attempt above.
  const row = await t.run((ctx) => ctx.db.get(conversationId));
  expect(row!.status).toBe("open");
  expect(row!.assignedToUserId).toBeUndefined();
  expect(row!.unreadCount).toBe(0);

  // Alice herself can still act on it — proves the throws above are
  // really about cross-account isolation, not broken mutations.
  await asAlice.mutation(api.conversations.markRead, { conversationId });
});

// ============================================================
// assign -> notifications (Phase 5, Task 2) — wired to
// `insertNotification` (`convex/notifications.ts`), the Convex
// counterpart to migration 027's `notify_conversation_assigned` trigger.
// ============================================================

test("assign creates a notification for the assignee", async () => {
  const t = convexTest(schema, modules);
  const {
    asUser: asAlice,
    accountId: aliceAccountId,
    userId: aliceUserId,
  } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const carolUserId = await seedTeammate(t, {
    accountId: aliceAccountId,
    name: "Carol",
    email: "carol@example.com",
    role: "agent",
  });
  const asCarol = t.withIdentity({ subject: `${carolUserId}|session-Carol` });
  const contactId = await asAlice.mutation(api.contacts.create, {
    phone: "111",
    name: "Jonas",
  });
  const conversationId = await seedConversation(t, {
    accountId: aliceAccountId,
    contactId,
  });

  await asAlice.mutation(api.conversations.assign, {
    conversationId,
    userId: carolUserId,
  });

  const carolsNotifications = await asCarol.query(api.notifications.list, {});
  expect(carolsNotifications).toHaveLength(1);
  const notification = carolsNotifications[0]!;
  expect(notification.type).toBe("conversation_assigned");
  expect(notification.userId).toBe(carolUserId);
  expect(notification.conversationId).toBe(conversationId);
  expect(notification.contactId).toBe(contactId);
  expect(notification.actorUserId).toBe(aliceUserId);
  expect(notification.title).toBe("New conversation assigned");
  expect(notification.body).toContain("Jonas");
  expect(notification.body).toContain("Alice");
  expect(notification.readAt).toBeUndefined();

  // Not visible in the assigner's own notifications — it's Carol's.
  const alicesNotifications = await asAlice.query(api.notifications.list, {});
  expect(alicesNotifications).toHaveLength(0);
});

test("assign does not notify when an agent assigns a conversation to themselves", async () => {
  const t = convexTest(schema, modules);
  const {
    asUser: asAlice,
    accountId: aliceAccountId,
    userId: aliceUserId,
  } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const contactId = await asAlice.mutation(api.contacts.create, {
    phone: "111",
  });
  const conversationId = await seedConversation(t, {
    accountId: aliceAccountId,
    contactId,
  });

  await asAlice.mutation(api.conversations.assign, {
    conversationId,
    userId: aliceUserId,
  });

  const alicesNotifications = await asAlice.query(api.notifications.list, {});
  expect(alicesNotifications).toHaveLength(0);
});

// ============================================================
// resolveSendTarget — server-only recipient-phone + reply-context
// resolution, for `send.ts`'s `send` action and `metaSend.sendReaction`
// (Phase 8, Task 4).
// ============================================================

test("resolveSendTarget returns the conversation's contact phone", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const contactId = await asUser.mutation(api.contacts.create, {
    phone: "15551234567",
  });
  const conversationId = await seedConversation(t, { accountId, contactId });

  const result = await t.query(internal.conversations.resolveSendTarget, {
    accountId,
    conversationId,
  });

  expect(result.to).toBe("15551234567");
  expect(result.contextMessageId).toBeUndefined();
});

test("resolveSendTarget throws NOT_FOUND for a conversation belonging to a different account", async () => {
  const t = convexTest(schema, modules);
  const { asUser: asAlice, accountId: aliceAccountId } =
    await seedAccountMember(t, {
      name: "Alice",
      email: "alice@example.com",
      role: "agent",
    });
  const { accountId: bobAccountId } = await seedAccountMember(t, {
    name: "Bob",
    email: "bob@example.com",
    role: "agent",
  });
  const aliceContactId = await asAlice.mutation(api.contacts.create, {
    phone: "15551234567",
  });
  const aliceConversationId = await seedConversation(t, {
    accountId: aliceAccountId,
    contactId: aliceContactId,
  });

  await expect(
    t.query(internal.conversations.resolveSendTarget, {
      accountId: bobAccountId,
      conversationId: aliceConversationId,
    }),
  ).rejects.toMatchObject({ data: { code: "NOT_FOUND", entity: "conversation" } });
});

test("resolveSendTarget resolves a replyToMessageId in the same conversation to its Meta wamid", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const contactId = await asUser.mutation(api.contacts.create, {
    phone: "15551234567",
  });
  const conversationId = await seedConversation(t, { accountId, contactId });
  const parentMessageId = await asUser.mutation(api.messages.append, {
    conversationId,
    senderType: "customer",
    contentType: "text",
    contentText: "hi",
    messageId: "wamid.PARENT123",
  });

  const result = await t.query(internal.conversations.resolveSendTarget, {
    accountId,
    conversationId,
    replyToMessageId: parentMessageId,
  });

  expect(result.to).toBe("15551234567");
  expect(result.contextMessageId).toBe("wamid.PARENT123");
});

test("resolveSendTarget omits contextMessageId (without throwing) when the reply target has no Meta wamid yet", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const contactId = await asUser.mutation(api.contacts.create, {
    phone: "15551234567",
  });
  const conversationId = await seedConversation(t, { accountId, contactId });
  const parentMessageId = await asUser.mutation(api.messages.append, {
    conversationId,
    senderType: "agent",
    contentType: "text",
    contentText: "still sending",
  });

  const result = await t.query(internal.conversations.resolveSendTarget, {
    accountId,
    conversationId,
    replyToMessageId: parentMessageId,
  });

  expect(result.contextMessageId).toBeUndefined();
});

test("resolveSendTarget throws NOT_FOUND for a replyToMessageId belonging to a different conversation", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const contactId = await asUser.mutation(api.contacts.create, {
    phone: "15551234567",
  });
  const conversationId = await seedConversation(t, { accountId, contactId });
  const otherContactId = await asUser.mutation(api.contacts.create, {
    phone: "15559998888",
  });
  const otherConversationId = await seedConversation(t, {
    accountId,
    contactId: otherContactId,
  });
  const otherMessageId = await asUser.mutation(api.messages.append, {
    conversationId: otherConversationId,
    senderType: "customer",
    contentType: "text",
    contentText: "hi",
    messageId: "wamid.OTHER",
  });

  await expect(
    t.query(internal.conversations.resolveSendTarget, {
      accountId,
      conversationId,
      replyToMessageId: otherMessageId,
    }),
  ).rejects.toMatchObject({
    data: { code: "NOT_FOUND", entity: "replyToMessage" },
  });
});

// ============================================================
// setAutoreplyPaused — the Inbox "Take over" / "Resume AI" banner
// (transitive-Supabase gap-fill task). Convex port of `POST /api/ai/
// autoreply/[conversationId]` (lines ~44-99).
// ============================================================

test("setAutoreplyPaused(paused:true) disables auto-reply and bumps updatedAt, without touching assignment", async () => {
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

  const beforeUpdate = Date.now();
  const result = await asUser.mutation(api.conversations.setAutoreplyPaused, {
    conversationId,
    paused: true,
  });
  expect(result).toEqual({ success: true, paused: true });

  const row = await t.run((ctx) => ctx.db.get(conversationId));
  expect(row!.aiAutoreplyDisabled).toBe(true);
  expect(row!.assignedToUserId).toBeUndefined();
  expect(row!.updatedAt).toBeGreaterThanOrEqual(beforeUpdate);
});

test("setAutoreplyPaused(paused:true, assignToMe:true) also assigns the conversation to the caller", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId, userId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const contactId = await asUser.mutation(api.contacts.create, {
    phone: "111",
  });
  const conversationId = await seedConversation(t, { accountId, contactId });

  const result = await asUser.mutation(api.conversations.setAutoreplyPaused, {
    conversationId,
    paused: true,
    assignToMe: true,
  });
  expect(result).toEqual({ success: true, paused: true });

  const row = await t.run((ctx) => ctx.db.get(conversationId));
  expect(row!.aiAutoreplyDisabled).toBe(true);
  expect(row!.assignedToUserId).toBe(userId);
});

test("setAutoreplyPaused(paused:false) clears the pause, releases any assignment, resets the reply count, and clears the handoff summary — leaving status untouched", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const carolUserId = await seedTeammate(t, {
    accountId,
    name: "Carol",
    email: "carol@example.com",
    role: "agent",
  });
  const contactId = await asUser.mutation(api.contacts.create, {
    phone: "111",
  });
  const conversationId = await seedConversation(t, {
    accountId,
    contactId,
    status: "pending",
  });
  // Simulate a prior handoff: paused, assigned to Carol (NOT the caller),
  // a reply count, and a handoff summary already on the row.
  await t.run((ctx) =>
    ctx.db.patch(conversationId, {
      aiAutoreplyDisabled: true,
      assignedToUserId: carolUserId,
      aiReplyCount: 2,
      aiHandoffSummary: "handed off: pricing question",
    }),
  );

  const beforeUpdate = Date.now();
  const result = await asUser.mutation(api.conversations.setAutoreplyPaused, {
    conversationId,
    paused: false,
  });
  expect(result).toEqual({ success: true, paused: false });

  const row = await t.run((ctx) => ctx.db.get(conversationId));
  expect(row!.aiAutoreplyDisabled).toBe(false);
  // Released even though it wasn't the CALLER's own assignment — the
  // bot needs a clear "human owns this" gate to stand down (route's own
  // comment: any stale assignee would otherwise make Resume AI a no-op).
  expect(row!.assignedToUserId).toBeUndefined();
  expect(row!.aiReplyCount).toBe(0);
  expect(row!.aiHandoffSummary).toBeUndefined();
  // status is deliberately left untouched, exactly like the route.
  expect(row!.status).toBe("pending");
  expect(row!.updatedAt).toBeGreaterThanOrEqual(beforeUpdate);
});

test("setAutoreplyPaused throws NOT_FOUND for a conversation belonging to a different account, and leaves it untouched", async () => {
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
    asBob.mutation(api.conversations.setAutoreplyPaused, {
      conversationId,
      paused: true,
    }),
  ).rejects.toMatchObject({
    data: { code: "NOT_FOUND", entity: "conversation" },
  });

  const row = await t.run((ctx) => ctx.db.get(conversationId));
  expect(row!.aiAutoreplyDisabled).toBeUndefined();
});

test("setAutoreplyPaused is rejected for a viewer (below the agent role floor), leaving the conversation untouched", async () => {
  const t = convexTest(schema, modules);
  const { asUser: asAlice, accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const vicUserId = await seedTeammate(t, {
    accountId,
    name: "Vic",
    email: "vic@example.com",
    role: "viewer",
  });
  const asVic = t.withIdentity({ subject: `${vicUserId}|session-Vic` });
  const contactId = await asAlice.mutation(api.contacts.create, {
    phone: "111",
  });
  const conversationId = await seedConversation(t, { accountId, contactId });

  await expect(
    asVic.mutation(api.conversations.setAutoreplyPaused, {
      conversationId,
      paused: true,
    }),
  ).rejects.toMatchObject({ data: { code: "FORBIDDEN", min: "agent" } });

  const row = await t.run((ctx) => ctx.db.get(conversationId));
  expect(row!.aiAutoreplyDisabled).toBeUndefined();
});

// ============================================================
// role-scoped visibility (Task 4) — `conversationScope`/
// `canAccessConversation` (`convex/lib/roles.ts`) applied to `list`/
// `get` via the shared `requireConversationAccess` guard
// (`convex/lib/conversationAccess.ts`). agent = own + unassigned pool;
// viewer = unassigned pool only; supervisor+ = everything.
// ============================================================

test("list scopes conversations by role", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountWithOwner(t);
  const a = await seedUserInAccount(t, accountId, { name: "AgentA", email: "a@x.com", role: "agent" });
  const b = await seedUserInAccount(t, accountId, { name: "AgentB", email: "b@x.com", role: "agent" });
  const v = await seedUserInAccount(t, accountId, { name: "Vic", email: "v@x.com", role: "viewer" });
  const s = await seedUserInAccount(t, accountId, { name: "Sup", email: "s@x.com", role: "supervisor" });

  await seedConv(t, accountId, { phone: "111", name: "Mine", assignedToUserId: a.userId });
  await seedConv(t, accountId, { phone: "222", name: "Pool" });
  await seedConv(t, accountId, { phone: "333", name: "Bees", assignedToUserId: b.userId });

  const asA = await a.asUser.query(api.conversations.list, onePage);
  expect(asA.page.map((c) => c.contact?.name).sort()).toEqual(["Mine", "Pool"]);

  const asV = await v.asUser.query(api.conversations.list, onePage);
  expect(asV.page.map((c) => c.contact?.name)).toEqual(["Pool"]);

  const asS = await s.asUser.query(api.conversations.list, onePage);
  expect(asS.page).toHaveLength(3);
});

test("get denies an out-of-scope conversation with NOT_FOUND", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountWithOwner(t);
  const a = await seedUserInAccount(t, accountId, { name: "AgentA", email: "a@x.com", role: "agent" });
  const b = await seedUserInAccount(t, accountId, { name: "AgentB", email: "b@x.com", role: "agent" });
  const { conversationId: bsConv } = await seedConv(t, accountId, { phone: "333", name: "Bees", assignedToUserId: b.userId });

  await expect(
    a.asUser.query(api.conversations.get, { conversationId: bsConv }),
  ).rejects.toMatchObject({ data: { code: "NOT_FOUND", entity: "conversation" } });
});

// ============================================================
// server-side phone masking (Task 5) — `embedContact` applies
// `canSeeContactPhone` (`convex/lib/roles.ts`) via the new
// `maskContactPhone` helper. agent: real on their own assigned chat,
// masked on the pool; viewer: always masked; supervisor+: never masked.
// ============================================================

test("phone is masked on the pool and unmasked on an agent's own chat", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountWithOwner(t);
  const a = await seedUserInAccount(t, accountId, { name: "AgentA", email: "a@x.com", role: "agent" });
  const v = await seedUserInAccount(t, accountId, { name: "Vic", email: "v@x.com", role: "viewer" });
  const s = await seedUserInAccount(t, accountId, { name: "Sup", email: "s@x.com", role: "supervisor" });

  await seedConv(t, accountId, { phone: "+15551230148", name: "Mine", assignedToUserId: a.userId });
  await seedConv(t, accountId, { phone: "+15551230199", name: "Pool" });

  const asA = await a.asUser.query(api.conversations.list, onePage);
  const mine = asA.page.find((c) => c.contact?.name === "Mine");
  const pool = asA.page.find((c) => c.contact?.name === "Pool");
  expect(mine?.contact?.phone).toBe("+15551230148"); // own chat: real
  expect(pool?.contact?.phone).toMatch(/^•+99$/); // pool: masked
  expect(pool?.contact?.phoneNormalized).toBe("");

  const asV = await v.asUser.query(api.conversations.list, onePage);
  expect(asV.page[0]?.contact?.phone).toMatch(/^•+99$/); // viewer: masked

  const asS = await s.asUser.query(api.conversations.list, onePage);
  expect(asS.page.find((c) => c.contact?.name === "Mine")?.contact?.phone).toBe("+15551230148");
});
