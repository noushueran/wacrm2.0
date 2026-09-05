/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import type { AccountRole } from "./lib/roles";
import { insertConversation } from "./conversations";
import { hourStartMs } from "./lib/messageStats";

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
    // Optional: a few tests seed a conversation purely so
    // `api.messages.append` can be called as setup. `append` now requires
    // "own" access (the caller must be assigned), so callers that append
    // as an "agent" must pass their own userId here.
    assignedToUserId?: Id<"users">;
    // Lane fixtures (Task 4): `true` = customer spoke last (or no
    // messages yet), `false` = we spoke last. See schema.ts's
    // `awaitingReply` comment.
    awaitingReply?: boolean;
    // Lane fixtures: set to mark the conversation archived (excluded
    // from every lane — the Archived tab is a separate index range).
    archivedAt?: number;
    // Manual override fixtures (Task 4): `snoozedUntil` parks the
    // conversation out of every worked lane until the given epoch ms,
    // regardless of `awaitingReply`/`lastMessageAt`. `chasingForcedAt`
    // pulls it into Chasing regardless of age. See schema.ts's comments
    // on both fields.
    snoozedUntil?: number;
    chasingForcedAt?: number;
  },
) {
  return await t.run((ctx) =>
    ctx.db.insert("conversations", {
      accountId: opts.accountId,
      contactId: opts.contactId,
      status: opts.status ?? "open",
      lastMessageAt: opts.lastMessageAt,
      unreadCount: opts.unreadCount ?? 0,
      assignedToUserId: opts.assignedToUserId,
      awaitingReply: opts.awaitingReply,
      archivedAt: opts.archivedAt,
      snoozedUntil: opts.snoozedUntil,
      chasingForcedAt: opts.chasingForcedAt,
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

const eventsOf = (
  t: TestConvex<typeof schema>,
  conversationId: Id<"conversations">,
) =>
  t.run((ctx) =>
    ctx.db
      .query("conversationEvents")
      .withIndex("by_conversation", (q) => q.eq("conversationId", conversationId))
      .collect(),
  );

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

/**
 * Seeds one account holding three *unread* conversations — one assigned
 * to `agent`, one unassigned (the claimable pool), one assigned to a
 * teammate — plus a read (unreadCount: 0) one that no scope may ever
 * count. This is the fixture the role-scope tests below share: each
 * asserts the slice of those three its own `conversationScope` allows.
 */
async function seedUnreadScopeFixture(t: ReturnType<typeof convexTest>) {
  const { asUser: asOwner, accountId } = await seedAccountMember(t, {
    name: "Owner",
    email: "owner@example.com",
    role: "owner",
  });
  const agent = await seedUserInAccount(t, accountId, {
    name: "Agent",
    email: "agent@example.com",
    role: "agent",
  });
  const teammate = await seedUserInAccount(t, accountId, {
    name: "Teammate",
    email: "teammate@example.com",
    role: "agent",
  });
  const contactId = await asOwner.mutation(api.contacts.create, {
    phone: "111",
  });

  await seedConversation(t, {
    accountId,
    contactId,
    unreadCount: 1,
    assignedToUserId: agent.userId,
  });
  await seedConversation(t, { accountId, contactId, unreadCount: 1 });
  await seedConversation(t, {
    accountId,
    contactId,
    unreadCount: 1,
    assignedToUserId: teammate.userId,
  });
  await seedConversation(t, { accountId, contactId, unreadCount: 0 });

  return { accountId, agent, teammate };
}

test("unreadTotal for an agent counts their own and the unassigned pool, but not a teammate's", async () => {
  const t = convexTest(schema, modules);
  const { agent } = await seedUnreadScopeFixture(t);

  expect(await agent.asUser.query(api.conversations.unreadTotal, {})).toBe(2);
});

test("unreadTotal for a supervisor counts every unread conversation including a teammate's", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedUnreadScopeFixture(t);
  const supervisor = await seedUserInAccount(t, accountId, {
    name: "Supervisor",
    email: "supervisor@example.com",
    role: "supervisor",
  });

  expect(await supervisor.asUser.query(api.conversations.unreadTotal, {})).toBe(
    3,
  );
});

test("unreadTotal for a viewer counts only the unassigned pool", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedUnreadScopeFixture(t);
  const viewer = await seedUserInAccount(t, accountId, {
    name: "Viewer",
    email: "viewer@example.com",
    role: "viewer",
  });

  expect(await viewer.asUser.query(api.conversations.unreadTotal, {})).toBe(1);
});

// ============================================================
// assign — target must be a real member of the same account
// ============================================================

test("assign rejects a userId that is not a member of the account", async () => {
  const t = convexTest(schema, modules);
  // supervisor: assigning to someone other than yourself is a
  // supervisor+-only path under the self-claim model (Task 6) — an
  // agent would be rejected by the claim guard before ever reaching
  // this mutation's membership check.
  const { asUser: asAlice, accountId: aliceAccountId } =
    await seedAccountMember(t, {
      name: "Alice",
      email: "alice@example.com",
      role: "supervisor",
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
  // supervisor: assigning a conversation to someone other than
  // yourself (Carol) is a supervisor+-only path under the self-claim
  // model (Task 6).
  const { asUser: asAlice, accountId: aliceAccountId } =
    await seedAccountMember(t, {
      name: "Alice",
      email: "alice@example.com",
      role: "supervisor",
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
  // supervisor: Alice both assigns to Carol and later unassigns
  // Carol's conversation — under the self-claim model (Task 6) an
  // agent could do neither (assign is self-claim-only, and "own" mode
  // requires the caller to hold the assignment), so this generic
  // clear-assignment behavior is exercised as a supervisor instead.
  const { asUser: asAlice, accountId: aliceAccountId } =
    await seedAccountMember(t, {
      name: "Alice",
      email: "alice@example.com",
      role: "supervisor",
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
  // supervisor: Alice assigns to Carol (a cross-user assignment,
  // supervisor+-only under the self-claim model, Task 6) so the setup
  // reaches the cross-account `unassign` check below; Bob's role is
  // irrelevant to that check (it fails on account mismatch first).
  const { asUser: asAlice, accountId: aliceAccountId } =
    await seedAccountMember(t, {
      name: "Alice",
      email: "alice@example.com",
      role: "supervisor",
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
  // supervisor: Alice assigns to Carol (a cross-user assignment,
  // supervisor+-only under the self-claim model, Task 6) so the setup
  // succeeds; the test itself is about Vic's viewer-role rejection,
  // unaffected by Alice's role.
  const { asUser: asAlice, accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "supervisor",
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
  const { asUser, accountId, userId } = await seedAccountMember(t, {
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
  // `setStatus` now requires "own" access (Task 6) — an agent must
  // hold the assignment, so self-claim it first.
  await asUser.mutation(api.conversations.assign, { conversationId, userId });

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
  const { asUser, accountId, userId } = await seedAccountMember(t, {
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
    assignedToUserId: userId,
  });
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
// markUnread — the undo for opening the wrong thread
// ============================================================

/**
 * Appends `senderType`-authored messages in order, so a test can shape
 * the trailing run `markUnread` counts back. Goes through
 * `api.messages.append` rather than a raw insert because that's the
 * path that maintains `unreadCount` — the tests below need the real
 * pre-`markRead` count to compare the restored one against.
 */
async function appendMessages(
  asUser: ReturnType<ReturnType<typeof convexTest>["withIdentity"]>,
  conversationId: Id<"conversations">,
  senders: ("customer" | "agent" | "bot")[],
) {
  for (const [i, senderType] of senders.entries()) {
    await asUser.mutation(api.messages.append, {
      conversationId,
      senderType,
      contentType: "text",
      contentText: `${senderType} ${i}`,
    });
  }
}

test("markUnread restores the count of inbound messages since the account last replied", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId, userId } = await seedAccountMember(t, {
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
    assignedToUserId: userId,
  });
  // An older exchange the agent already handled, then three new
  // inbound messages — only the trailing three were ever unread.
  await appendMessages(asUser, conversationId, [
    "customer",
    "agent",
    "customer",
    "customer",
    "customer",
  ]);

  const beforeRead = await t.run((ctx) => ctx.db.get(conversationId));
  expect(beforeRead!.unreadCount).toBe(4);

  await asUser.mutation(api.conversations.markRead, { conversationId });
  expect((await t.run((ctx) => ctx.db.get(conversationId)))!.unreadCount).toBe(
    0,
  );

  const result = await asUser.mutation(api.conversations.markUnread, {
    conversationId,
  });
  expect(result).toBe(conversationId);

  // 3, not 4: the first customer message predates the agent's reply, so
  // it was read long before this misclick.
  const after = await t.run((ctx) => ctx.db.get(conversationId));
  expect(after!.unreadCount).toBe(3);
});

test("markUnread restores 1 on a thread with no inbound messages", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId, userId } = await seedAccountMember(t, {
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
    assignedToUserId: userId,
  });
  // Outbound-only: nothing was ever waiting to be read, but the agent
  // still asked for the row to look unread.
  await appendMessages(asUser, conversationId, ["agent"]);

  await asUser.mutation(api.conversations.markUnread, { conversationId });

  const after = await t.run((ctx) => ctx.db.get(conversationId));
  expect(after!.unreadCount).toBe(1);
});

test("markUnread is a no-op on an already-unread conversation", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId, userId } = await seedAccountMember(t, {
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
    assignedToUserId: userId,
  });
  await appendMessages(asUser, conversationId, ["customer", "customer"]);
  expect((await t.run((ctx) => ctx.db.get(conversationId)))!.unreadCount).toBe(
    2,
  );

  // Twice: neither call may touch a count that's already nonzero, so a
  // double-click can't stack the badge higher than it was.
  await asUser.mutation(api.conversations.markUnread, { conversationId });
  await asUser.mutation(api.conversations.markUnread, { conversationId });

  const after = await t.run((ctx) => ctx.db.get(conversationId));
  expect(after!.unreadCount).toBe(2);
});

test("markUnread leaves updatedAt and status alone", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId, userId } = await seedAccountMember(t, {
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
    assignedToUserId: userId,
  });
  await appendMessages(asUser, conversationId, ["customer"]);
  await asUser.mutation(api.conversations.markRead, { conversationId });
  const before = await t.run((ctx) => ctx.db.get(conversationId));

  await asUser.mutation(api.conversations.markUnread, { conversationId });

  const after = await t.run((ctx) => ctx.db.get(conversationId));
  expect(after!.updatedAt).toBe(before!.updatedAt);
  expect(after!.status).toBe(before!.status);
  expect(after!.lastMessageAt).toBe(before!.lastMessageAt);
});

test("markUnread throws NOT_FOUND across accounts and leaves the row read", async () => {
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
  const contactId = await asAlice.mutation(api.contacts.create, {
    phone: "111",
  });
  const conversationId = await seedConversation(t, {
    accountId: aliceAccountId,
    contactId,
  });

  await expect(
    asBob.mutation(api.conversations.markUnread, { conversationId }),
  ).rejects.toMatchObject({
    data: { code: "NOT_FOUND", entity: "conversation" },
  });

  const after = await t.run((ctx) => ctx.db.get(conversationId));
  expect(after!.unreadCount).toBe(0);
});

test("markUnread is denied to a viewer", async () => {
  const t = convexTest(schema, modules);
  const { asUser: asAlice, accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const viewerUserId = await seedTeammate(t, {
    accountId,
    name: "Vic",
    email: "vic@example.com",
    role: "viewer",
  });
  const asViewer = t.withIdentity({ subject: `${viewerUserId}|session-Vic` });
  const contactId = await asAlice.mutation(api.contacts.create, {
    phone: "111",
  });
  const conversationId = await seedConversation(t, { accountId, contactId });

  await expect(
    asViewer.mutation(api.conversations.markUnread, { conversationId }),
  ).rejects.toThrow();

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
  // supervisor: assigning to Carol (not self) is a supervisor+-only
  // path under the self-claim model (Task 6); the notification-on-
  // cross-user-assign behavior under test requires that path.
  const {
    asUser: asAlice,
    accountId: aliceAccountId,
    userId: aliceUserId,
  } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "supervisor",
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
  const { asUser, accountId, userId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const contactId = await asUser.mutation(api.contacts.create, {
    phone: "15551234567",
  });
  const conversationId = await seedConversation(t, {
    accountId,
    contactId,
    assignedToUserId: userId,
  });
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
  const { asUser, accountId, userId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const contactId = await asUser.mutation(api.contacts.create, {
    phone: "15551234567",
  });
  const conversationId = await seedConversation(t, {
    accountId,
    contactId,
    assignedToUserId: userId,
  });
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
  const { asUser, accountId, userId } = await seedAccountMember(t, {
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
    assignedToUserId: userId,
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
  // supervisor: the conversation under test is pre-patched assigned to
  // Carol, not the caller. `setAutoreplyPaused` now requires "view"
  // access (Task 6), which for an agent means own-or-unassigned — a
  // colleague's assigned conversation is out of an agent's reach, so
  // exercising "releases ANY assignee, not just the caller's own"
  // requires a supervisor+ caller.
  const { asUser, accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "supervisor",
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

test("list filters by the assignment tab within the role scope", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountWithOwner(t);
  const a = await seedUserInAccount(t, accountId, { name: "AgentA", email: "a@x.com", role: "agent" });
  const b = await seedUserInAccount(t, accountId, { name: "AgentB", email: "b@x.com", role: "agent" });
  const s = await seedUserInAccount(t, accountId, { name: "Sup", email: "s@x.com", role: "supervisor" });

  await seedConv(t, accountId, { phone: "111", name: "Mine", assignedToUserId: a.userId });
  await seedConv(t, accountId, { phone: "222", name: "Pool" });
  await seedConv(t, accountId, { phone: "333", name: "Bees", assignedToUserId: b.userId });

  // Agent "Mine" → only their own assigned chat.
  const aMine = await a.asUser.query(api.conversations.list, { assignment: "mine", ...onePage });
  expect(aMine.page.map((c) => c.contact?.name)).toEqual(["Mine"]);

  // Agent "Unassigned" → the pool only.
  const aPool = await a.asUser.query(api.conversations.list, { assignment: "unassigned", ...onePage });
  expect(aPool.page.map((c) => c.contact?.name)).toEqual(["Pool"]);

  // Supervisor "Mine" → owns none.
  const sMine = await s.asUser.query(api.conversations.list, { assignment: "mine", ...onePage });
  expect(sMine.page).toHaveLength(0);

  // Supervisor "Unassigned" → the pool only (not Bees, not Mine).
  const sPool = await s.asUser.query(api.conversations.list, { assignment: "unassigned", ...onePage });
  expect(sPool.page.map((c) => c.contact?.name)).toEqual(["Pool"]);

  // Supervisor, no assignment arg → unchanged: sees all three.
  const sAll = await s.asUser.query(api.conversations.list, onePage);
  expect(sAll.page).toHaveLength(3);
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

// ============================================================
// claim / assign / reassign model (Task 6) — `canAssignToOthers`
// (`convex/lib/roles.ts`) applied to `assign` via a claim guard that
// sits after the shared `requireConversationAccess` guard. Agents may
// only self-claim a conversation that is unassigned or already theirs;
// supervisor+ may assign anyone to anyone. `unassign`/`setStatus` now
// require "own"; `markRead`/`setAutoreplyPaused` require "view".
// ============================================================

test("agent self-claims an unassigned conversation", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountWithOwner(t);
  const a = await seedUserInAccount(t, accountId, { name: "AgentA", email: "a@x.com", role: "agent" });
  const { conversationId } = await seedConv(t, accountId, { phone: "111", name: "Pool" });

  await a.asUser.mutation(api.conversations.assign, { conversationId, userId: a.userId });
  const row = await t.run((ctx) => ctx.db.get(conversationId));
  expect(row?.assignedToUserId).toBe(a.userId);
  expect(row?.status).toBe("pending");
});

test("agent cannot assign a conversation to another user", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountWithOwner(t);
  const a = await seedUserInAccount(t, accountId, { name: "AgentA", email: "a@x.com", role: "agent" });
  const b = await seedUserInAccount(t, accountId, { name: "AgentB", email: "b@x.com", role: "agent" });
  const { conversationId } = await seedConv(t, accountId, { phone: "111", name: "Pool" });

  await expect(
    a.asUser.mutation(api.conversations.assign, { conversationId, userId: b.userId }),
  ).rejects.toMatchObject({ data: { code: "FORBIDDEN", min: "supervisor" } });
});

test("agent cannot grab a conversation owned by another agent", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountWithOwner(t);
  const a = await seedUserInAccount(t, accountId, { name: "AgentA", email: "a@x.com", role: "agent" });
  const b = await seedUserInAccount(t, accountId, { name: "AgentB", email: "b@x.com", role: "agent" });
  const { conversationId } = await seedConv(t, accountId, { phone: "111", name: "Bees", assignedToUserId: b.userId });

  await expect(
    a.asUser.mutation(api.conversations.assign, { conversationId, userId: a.userId }),
  ).rejects.toMatchObject({ data: { code: "NOT_FOUND", entity: "conversation" } });
});

test("supervisor assigns a conversation to any agent", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountWithOwner(t);
  const s = await seedUserInAccount(t, accountId, { name: "Sup", email: "s@x.com", role: "supervisor" });
  const a = await seedUserInAccount(t, accountId, { name: "AgentA", email: "a@x.com", role: "agent" });
  const { conversationId } = await seedConv(t, accountId, { phone: "111", name: "Pool" });

  await s.asUser.mutation(api.conversations.assign, { conversationId, userId: a.userId });
  const row = await t.run((ctx) => ctx.db.get(conversationId));
  expect(row?.assignedToUserId).toBe(a.userId);
});

test("agent releases only their own conversation", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountWithOwner(t);
  const a = await seedUserInAccount(t, accountId, { name: "AgentA", email: "a@x.com", role: "agent" });
  const b = await seedUserInAccount(t, accountId, { name: "AgentB", email: "b@x.com", role: "agent" });
  const mine = await seedConv(t, accountId, { phone: "111", name: "Mine", assignedToUserId: a.userId });
  const theirs = await seedConv(t, accountId, { phone: "222", name: "Bees", assignedToUserId: b.userId });

  await a.asUser.mutation(api.conversations.unassign, { conversationId: mine.conversationId });
  expect((await t.run((ctx) => ctx.db.get(mine.conversationId)))?.assignedToUserId).toBeUndefined();

  await expect(
    a.asUser.mutation(api.conversations.unassign, { conversationId: theirs.conversationId }),
  ).rejects.toMatchObject({ data: { code: "NOT_FOUND", entity: "conversation" } });
});

test("viewer cannot assign", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountWithOwner(t);
  const v = await seedUserInAccount(t, accountId, { name: "Vic", email: "v@x.com", role: "viewer" });
  const { conversationId } = await seedConv(t, accountId, { phone: "111", name: "Pool" });

  await expect(
    v.asUser.mutation(api.conversations.assign, { conversationId, userId: v.userId }),
  ).rejects.toMatchObject({ data: { code: "FORBIDDEN", min: "agent" } });
});

// ============================================================
// list: assignment is served by an index, not a post-scan filter
//
// `by_account_assigned_last_message` (schema.ts) replaced a `.filter()`
// stacked on the recency index. A Convex `.filter()` does not narrow the
// traversal, so `.paginate()` read until `numItems` MATCHES accumulated —
// a tab matching nothing near the front scanned the whole account.
//
// NOTE ON COVERAGE: convex-test does not model the 4096-document read
// limit (verified — a 5,000-row unmatched scan completes cleanly here),
// so no test in this suite can fail on the performance property itself.
// That is exactly why this bug class keeps reaching production with a
// green suite. What these tests CAN pin is that switching indexes did not
// change what the inbox shows or the order it shows it in.
// ============================================================

test("list: the Mine tab is ordered newest-first by lastMessageAt", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountWithOwner(t);
  const a = await seedUserInAccount(t, accountId, { name: "AgentA", email: "a@x.com", role: "agent" });

  const contactId = await t.run((ctx) =>
    ctx.db.insert("contacts", { accountId, phone: "1", phoneNormalized: "1", name: "C" }),
  );
  // Insert oldest-first so insertion order can't accidentally satisfy the
  // assertion — only a real lastMessageAt-desc ordering can.
  for (const at of [100, 300, 200]) {
    await t.run((ctx) =>
      ctx.db.insert("conversations", {
        accountId, contactId, status: "open" as const, unreadCount: 0,
        assignedToUserId: a.userId, lastMessageAt: at,
      }),
    );
  }

  const mine = await a.asUser.query(api.conversations.list, { assignment: "mine", ...onePage });
  expect(mine.page.map((c) => c.lastMessageAt)).toEqual([300, 200, 100]);
});

test("list: the Unassigned tab is ordered newest-first and excludes assigned threads", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountWithOwner(t);
  const a = await seedUserInAccount(t, accountId, { name: "AgentA", email: "a@x.com", role: "agent" });

  const contactId = await t.run((ctx) =>
    ctx.db.insert("contacts", { accountId, phone: "1", phoneNormalized: "1", name: "C" }),
  );
  for (const at of [100, 300, 200]) {
    await t.run((ctx) =>
      ctx.db.insert("conversations", {
        accountId, contactId, status: "open" as const, unreadCount: 0, lastMessageAt: at,
      }),
    );
  }
  // An assigned thread NEWER than every pooled one — it must not lead the
  // page just because it sorts first on the recency index.
  await t.run((ctx) =>
    ctx.db.insert("conversations", {
      accountId, contactId, status: "open" as const, unreadCount: 0,
      assignedToUserId: a.userId, lastMessageAt: 999,
    }),
  );

  const pool = await a.asUser.query(api.conversations.list, { assignment: "unassigned", ...onePage });
  expect(pool.page.map((c) => c.lastMessageAt)).toEqual([300, 200, 100]);
});

test("list: the indexed tab agrees with filtering the unscoped list by hand", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountWithOwner(t);
  const s = await seedUserInAccount(t, accountId, { name: "Sup", email: "s@x.com", role: "supervisor" });
  const b = await seedUserInAccount(t, accountId, { name: "AgentB", email: "b@x.com", role: "agent" });

  const contactId = await t.run((ctx) =>
    ctx.db.insert("contacts", { accountId, phone: "1", phoneNormalized: "1", name: "C" }),
  );
  for (let i = 0; i < 8; i++) {
    await t.run((ctx) =>
      ctx.db.insert("conversations", {
        accountId, contactId, status: "open" as const, unreadCount: 0,
        lastMessageAt: i * 10,
        ...(i % 3 === 0 ? { assignedToUserId: b.userId } : {}),
      }),
    );
  }

  // Supervisor sees everything, so the unscoped list is ground truth for
  // what the pool tab (a different index) must return.
  const all = await s.asUser.query(api.conversations.list, onePage);
  const expected = all.page.filter((c) => c.assignedToUserId === undefined).map((c) => c._id);
  const pool = await s.asUser.query(api.conversations.list, { assignment: "unassigned", ...onePage });
  expect(pool.page.map((c) => c._id)).toEqual(expected);
});

test("list: a viewer clicking Mine gets an empty page (the predicate is unsatisfiable)", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountWithOwner(t);
  const v = await seedUserInAccount(t, accountId, { name: "Vic", email: "v@x.com", role: "viewer" });
  const a = await seedUserInAccount(t, accountId, { name: "AgentA", email: "a@x.com", role: "agent" });

  await seedConv(t, accountId, { phone: "111", name: "Pool" });
  await seedConv(t, accountId, { phone: "222", name: "Theirs", assignedToUserId: a.userId });

  // A viewer's scope is the pool only, so "assigned to me" can never hold.
  // Previously this scanned every conversation in the account to return
  // nothing; now it short-circuits before any read.
  const mine = await v.asUser.query(api.conversations.list, { assignment: "mine", ...onePage });
  expect(mine.page).toEqual([]);
  expect(mine.isDone).toBe(true);

  // ...and the viewer's normal view is unaffected.
  const pool = await v.asUser.query(api.conversations.list, onePage);
  expect(pool.page.map((c) => c.contact?.name)).toEqual(["Pool"]);
});

// ============================================================
// `unarchiveOnInbound` (Phase P2, Task 4) — an `internalMutation` called
// directly with `t.mutation`, not through an authenticated `asUser`
// session, so its own seed helpers mirror `leadAnalysisEngine.test.ts`'s
// `seedAccount`/`seedConversation` byte-for-byte rather than this file's
// `seedAccountMember`/`seedConversation` (which require an existing
// `contactId` and return only a bare id, not the `{ contactId,
// conversationId }` pair these tests need). The conversation-seeding
// helper here is named `seedBareConversation` — this file already has a
// `seedConversation` with a different signature/shape, so the mirrored
// version needed a different name to avoid colliding with it.
// ============================================================

async function seedAccount(t: ReturnType<typeof convexTest>) {
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { name: "Owner", email: "o@x.com" }),
  );
  const accountId = await t.run(async (ctx) => {
    const id = await ctx.db.insert("accounts", {
      name: "Acct", defaultCurrency: "AED", ownerUserId: userId,
    });
    await ctx.db.insert("memberships", {
      userId, accountId: id, role: "owner", fullName: "Owner", email: "o@x.com",
    });
    return id;
  });
  return { userId, accountId };
}

async function seedBareConversation(
  t: ReturnType<typeof convexTest>,
  accountId: Id<"accounts">,
) {
  return await t.run(async (ctx) => {
    const contactId = await ctx.db.insert("contacts", {
      accountId, phone: "+971500000001", phoneNormalized: "971500000001", name: "Asha",
    });
    const conversationId = await ctx.db.insert("conversations", {
      accountId, contactId, status: "open", unreadCount: 0, lastMessageAt: Date.now(),
    });
    return { contactId, conversationId };
  });
}

test("unarchiveOnInbound restores an archived conversation", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccount(t);
  const { contactId, conversationId } = await seedBareConversation(t, accountId);
  await t.run((ctx) =>
    ctx.db.patch(conversationId, {
      archivedAt: Date.now() - 1000,
      archivedReason: "manual",
    }),
  );

  await t.mutation(internal.conversations.unarchiveOnInbound, {
    accountId, conversationId, contactId,
  });

  const conversation = await t.run((ctx) => ctx.db.get(conversationId));
  expect(conversation!.archivedAt).toBeUndefined();
  expect(conversation!.archivedReason).toBeUndefined();
  expect(conversation!.returnedAt).toBeDefined();
});

test("unarchiveOnInbound clears the mirrored analysis flag too", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccount(t);
  const { contactId, conversationId } = await seedBareConversation(t, accountId);
  await t.run((ctx) => ctx.db.patch(conversationId, { archivedAt: Date.now() }));
  const analysisId = await t.run((ctx) =>
    ctx.db.insert("leadAnalyses", {
      accountId, conversationId, contactId,
      scoreStatus: "scored" as const, attempts: 0,
      sequenceStatus: "idle" as const, followUpsSent: 0, archived: true,
    }),
  );

  await t.mutation(internal.conversations.unarchiveOnInbound, {
    accountId, conversationId, contactId,
  });

  expect((await t.run((ctx) => ctx.db.get(analysisId)))!.archived).toBeUndefined();
});

test("unarchiveOnInbound notifies the assigned agent", async () => {
  const t = convexTest(schema, modules);
  const { accountId, userId } = await seedAccount(t);
  const { contactId, conversationId } = await seedBareConversation(t, accountId);
  await t.run((ctx) =>
    ctx.db.patch(conversationId, {
      archivedAt: Date.now(), assignedToUserId: userId,
    }),
  );

  await t.mutation(internal.conversations.unarchiveOnInbound, {
    accountId, conversationId, contactId,
  });

  const notes = await t.run((ctx) => ctx.db.query("notifications").collect());
  expect(notes).toHaveLength(1);
  expect(notes[0].type).toBe("lead_returned");
  expect(notes[0].userId).toBe(userId);
});

test("unarchiveOnInbound is a no-op on a conversation that is not archived", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccount(t);
  const { contactId, conversationId } = await seedBareConversation(t, accountId);

  await t.mutation(internal.conversations.unarchiveOnInbound, {
    accountId, conversationId, contactId,
  });

  const conversation = await t.run((ctx) => ctx.db.get(conversationId));
  expect(conversation!.returnedAt).toBeUndefined();
  expect(await t.run((ctx) => ctx.db.query("notifications").collect())).toHaveLength(0);
});

test("unarchiveOnInbound runs even when lead analysis is disabled", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccount(t);
  const { contactId, conversationId } = await seedBareConversation(t, accountId);
  const { defaultLeadAnalysisConfig } = await import("./lib/leadAnalysis/defaults");
  await t.run((ctx) =>
    ctx.db.insert("leadAnalysisConfigs", {
      ...defaultLeadAnalysisConfig(), accountId, enabled: false,
    }),
  );
  await t.run((ctx) => ctx.db.patch(conversationId, { archivedAt: Date.now() }));

  await t.mutation(internal.conversations.unarchiveOnInbound, {
    accountId, conversationId, contactId,
  });

  // The whole point: disabling the feature must never strand an archived
  // conversation out of the Inbox.
  expect((await t.run((ctx) => ctx.db.get(conversationId)))!.archivedAt).toBeUndefined();
});

// ============================================================
// list — excluding archived conversations (Task 5). `archived` is
// absent/false for the Inbox's active view, true for the Archived tab.
// Uses `seedBareConversation` (defined above for `unarchiveOnInbound`)
// rather than the file's own `seedConversation`, which takes an
// already-created `contactId` rather than an `accountId` alone.
// ============================================================

test("list excludes archived conversations by default", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Sup", email: "s@x.com", role: "supervisor",
  });
  const active = await seedBareConversation(t, accountId);
  const archived = await seedBareConversation(t, accountId);
  await t.run((ctx) => ctx.db.patch(archived.conversationId, { archivedAt: Date.now() }));

  const page = await asUser.query(api.conversations.list, {
    paginationOpts: { numItems: 50, cursor: null },
  });

  const ids = page.page.map((c: { _id: string }) => c._id);
  expect(ids).toContain(active.conversationId);
  expect(ids).not.toContain(archived.conversationId);
});

test("list with archived:true returns only archived conversations", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Sup", email: "s@x.com", role: "supervisor",
  });
  const active = await seedBareConversation(t, accountId);
  const archived = await seedBareConversation(t, accountId);
  await t.run((ctx) => ctx.db.patch(archived.conversationId, { archivedAt: Date.now() }));

  const page = await asUser.query(api.conversations.list, {
    archived: true,
    paginationOpts: { numItems: 50, cursor: null },
  });

  const ids = page.page.map((c: { _id: string }) => c._id);
  expect(ids).toContain(archived.conversationId);
  expect(ids).not.toContain(active.conversationId);
});

test("the archived exclusion holds on the single-assignee plan", async () => {
  const t = convexTest(schema, modules);
  const { accountId, userId, asUser } = await seedAccountMember(t, {
    name: "Sup", email: "s@x.com", role: "supervisor",
  });
  const mine = await seedBareConversation(t, accountId);
  const mineArchived = await seedBareConversation(t, accountId);
  await t.run(async (ctx) => {
    await ctx.db.patch(mine.conversationId, { assignedToUserId: userId });
    await ctx.db.patch(mineArchived.conversationId, {
      assignedToUserId: userId, archivedAt: Date.now(),
    });
  });

  const page = await asUser.query(api.conversations.list, {
    assignment: "mine",
    paginationOpts: { numItems: 50, cursor: null },
  });

  const ids = page.page.map((c: { _id: string }) => c._id);
  expect(ids).toContain(mine.conversationId);
  expect(ids).not.toContain(mineArchived.conversationId);
});

test("the archived exclusion holds on an agent's me-or-pool view", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Agent", email: "a@x.com", role: "agent",
  });
  const pool = await seedBareConversation(t, accountId);
  const poolArchived = await seedBareConversation(t, accountId);
  await t.run((ctx) =>
    ctx.db.patch(poolArchived.conversationId, { archivedAt: Date.now() }),
  );

  const page = await asUser.query(api.conversations.list, {
    paginationOpts: { numItems: 50, cursor: null },
  });

  const ids = page.page.map((c: { _id: string }) => c._id);
  expect(ids).toContain(pool.conversationId);
  expect(ids).not.toContain(poolArchived.conversationId);
});

// ============================================================
// P2 final-fixes Fix 6 — the `eq` + archived branch (a single assignee
// AND `archived: true`) was the only new query plan in `list` with no
// test of its own, and it is the one branch that carries the sanctioned
// `.filter()` exception (`assignedToUserId` can't also be bound as an
// index key once `archivedAt` is being ranged rather than equated — see
// the `list` handler's own comment). Two supervisors on the SAME
// account so the assignee filter has something real to distinguish.
// ============================================================

test("list with assignment: mine + archived: true returns only the caller's own archived conversations", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountWithOwner(t);
  const alice = await seedUserInAccount(t, accountId, {
    name: "Alice", email: "alice@x.com", role: "supervisor",
  });
  const bob = await seedUserInAccount(t, accountId, {
    name: "Bob", email: "bob@x.com", role: "supervisor",
  });

  const aliceActive = await seedConv(t, accountId, {
    phone: "+971500000010", name: "Active for Alice", assignedToUserId: alice.userId,
  });
  const aliceArchived = await seedConv(t, accountId, {
    phone: "+971500000011", name: "Archived for Alice", assignedToUserId: alice.userId,
  });
  const bobArchived = await seedConv(t, accountId, {
    phone: "+971500000012", name: "Archived for Bob", assignedToUserId: bob.userId,
  });
  await t.run(async (ctx) => {
    await ctx.db.patch(aliceArchived.conversationId, { archivedAt: Date.now() });
    await ctx.db.patch(bobArchived.conversationId, { archivedAt: Date.now() });
  });

  const page = await alice.asUser.query(api.conversations.list, {
    assignment: "mine",
    archived: true,
    ...onePage,
  });

  const ids = page.page.map((c: { _id: string }) => c._id);
  expect(ids).toContain(aliceArchived.conversationId);
  expect(ids).not.toContain(bobArchived.conversationId); // another user's archived
  expect(ids).not.toContain(aliceActive.conversationId); // her own, but not archived
});

// ============================================================
// lane argument (Task 4) — the Inbox's Active/Waiting/Chasing tabs.
// Each lane is a range on `awaitingReply`/`lastMessageAt` over
// `by_account_lane_last_message` / `by_account_assigned_lane_last_message`
// (schema.ts) — see `conversations.ts`'s `list` handler for the exact
// query shapes and why the guard against `archived` exists.
// ============================================================

const DAY = 24 * 3_600_000;

/** A qualificationConfigs row so the cutoff resolves. 72h -> 3 days. */
async function seedQualConfig(
  t: ReturnType<typeof convexTest>,
  accountId: Id<"accounts">,
) {
  await t.run((ctx) =>
    ctx.db.insert("qualificationConfigs", {
      accountId,
      enabled: true,
      basicFields: [],
      qualifyThresholdScore: 60,
      timezoneLabel: "Asia/Dubai",
      utcOffsetMinutes: 240,
      workStartMinute: 600,
      workEndMinute: 1260,
      workDays: [1, 2, 3, 4, 5, 6],
      followUpDelaysMinutes: [60],
      maxFollowUps: 4,
      sessionWindowHours: 72,
      closingMessage: "thanks",
      adminAlertEnabled: false,
      adminAlertPhones: [],
      outboundNudgesEnabled: false,
    }),
  );
}

test("each lane returns exactly its own set, and the sets are disjoint", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Sam",
    email: "sam@example.com",
    role: "supervisor",
  });
  await seedQualConfig(t, accountId);
  const contactId = await asUser.mutation(api.contacts.create, {
    phone: "111",
  });
  const now = Date.now();

  const active = await seedConversation(t, {
    accountId,
    contactId,
    awaitingReply: true,
    lastMessageAt: now - 10 * DAY, // age is irrelevant to Active
  });
  const waiting = await seedConversation(t, {
    accountId,
    contactId,
    awaitingReply: false,
    lastMessageAt: now - 1 * DAY,
  });
  const chasing = await seedConversation(t, {
    accountId,
    contactId,
    awaitingReply: false,
    lastMessageAt: now - 9 * DAY,
  });
  const archived = await seedConversation(t, {
    accountId,
    contactId,
    awaitingReply: true,
    lastMessageAt: now - 2 * DAY,
    archivedAt: now,
  });

  const ids = async (lane: "active" | "waiting" | "chasing") =>
    (
      await asUser.query(api.conversations.list, {
        lane,
        paginationOpts: { numItems: 50, cursor: null },
      })
    ).page.map((c) => c._id);

  expect(await ids("active")).toEqual([active]);
  expect(await ids("waiting")).toEqual([waiting]);
  expect(await ids("chasing")).toEqual([chasing]);
  for (const lane of ["active", "waiting", "chasing"] as const) {
    expect(await ids(lane)).not.toContain(archived);
  }
});

test("an old thread the customer spoke on last stays in Active, never Chasing", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Sam",
    email: "sam@example.com",
    role: "supervisor",
  });
  await seedQualConfig(t, accountId);
  const contactId = await asUser.mutation(api.contacts.create, {
    phone: "111",
  });
  const id = await seedConversation(t, {
    accountId,
    contactId,
    awaitingReply: true,
    lastMessageAt: Date.now() - 90 * DAY,
  });

  const ids = async (lane: "active" | "chasing") =>
    (
      await asUser.query(api.conversations.list, {
        lane,
        paginationOpts: { numItems: 50, cursor: null },
      })
    ).page.map((c) => c._id);

  // Safety property one: no age puts an unanswered customer out of Active.
  expect(await ids("active")).toEqual([id]);
  expect(await ids("chasing")).toEqual([]);
});

test("a message-less conversation is Active and never Chasing", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Sam",
    email: "sam@example.com",
    role: "supervisor",
  });
  await seedQualConfig(t, accountId);
  const contactId = await asUser.mutation(api.contacts.create, {
    phone: "111",
  });
  // No `lastMessageAt` at all — Convex sorts missing before every number,
  // so without the range's `gt(0)` this would land in Chasing.
  const id = await seedConversation(t, {
    accountId,
    contactId,
    awaitingReply: true,
  });

  const ids = async (lane: "active" | "chasing") =>
    (
      await asUser.query(api.conversations.list, {
        lane,
        paginationOpts: { numItems: 50, cursor: null },
      })
    ).page.map((c) => c._id);

  expect(await ids("active")).toEqual([id]);
  expect(await ids("chasing")).toEqual([]);
});

test("a thread exactly at the cutoff lands in exactly one lane", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Sam",
    email: "sam@example.com",
    role: "supervisor",
  });
  await seedQualConfig(t, accountId);
  const contactId = await asUser.mutation(api.contacts.create, {
    phone: "111",
  });
  // Waiting is gt(cutoff), Chasing is lte(cutoff) — complementary, so a
  // thread ON the boundary must appear once and only once. 3 days back
  // plus a small margin so the cutoff moving during the test cannot
  // flip which side it falls on.
  const id = await seedConversation(t, {
    accountId,
    contactId,
    awaitingReply: false,
    lastMessageAt: Date.now() - 3 * DAY - 1_000,
  });

  const ids = async (lane: "waiting" | "chasing") =>
    (
      await asUser.query(api.conversations.list, {
        lane,
        paginationOpts: { numItems: 50, cursor: null },
      })
    ).page.map((c) => c._id);

  const inWaiting = await ids("waiting");
  const inChasing = await ids("chasing");
  expect([...inWaiting, ...inChasing]).toEqual([id]);
});

test("Chasing orders longest-neglected first", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Sam",
    email: "sam@example.com",
    role: "supervisor",
  });
  await seedQualConfig(t, accountId);
  const contactId = await asUser.mutation(api.contacts.create, {
    phone: "111",
  });
  const now = Date.now();
  const recent = await seedConversation(t, {
    accountId,
    contactId,
    awaitingReply: false,
    lastMessageAt: now - 5 * DAY,
  });
  const ancient = await seedConversation(t, {
    accountId,
    contactId,
    awaitingReply: false,
    lastMessageAt: now - 40 * DAY,
  });

  const page = await asUser.query(api.conversations.list, {
    lane: "chasing",
    paginationOpts: { numItems: 50, cursor: null },
  });
  expect(page.page.map((c) => c._id)).toEqual([ancient, recent]);
});

test("lane combined with archived is rejected, not silently ignored", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Sam",
    email: "sam@example.com",
    role: "supervisor",
  });
  await seedQualConfig(t, accountId);

  await expect(
    asUser.query(api.conversations.list, {
      lane: "active",
      archived: true,
      paginationOpts: { numItems: 10, cursor: null },
    }),
  ).rejects.toThrow();
});

test("lanes narrow correctly under the Mine tab (the eq plan)", async () => {
  const t = convexTest(schema, modules);
  const { accountId, userId, asUser } = await seedAccountMember(t, {
    name: "Ann",
    email: "ann@example.com",
    role: "agent",
  });
  await seedQualConfig(t, accountId);
  const contactId = await asUser.mutation(api.contacts.create, {
    phone: "111",
  });
  const now = Date.now();
  const mine = await seedConversation(t, {
    accountId,
    contactId,
    awaitingReply: false,
    lastMessageAt: now - 9 * DAY,
    assignedToUserId: userId,
  });
  await seedConversation(t, {
    accountId,
    contactId,
    awaitingReply: false,
    lastMessageAt: now - 9 * DAY, // unassigned
  });

  const page = await asUser.query(api.conversations.list, {
    lane: "chasing",
    assignment: "mine",
    paginationOpts: { numItems: 50, cursor: null },
  });
  expect(page.page.map((c) => c._id)).toEqual([mine]);
});

test("lanes narrow correctly under an agent's default view (the meOrPool plan)", async () => {
  const t = convexTest(schema, modules);
  // An agent with NO assignment tab takes the `meOrPool` plan — the only
  // plan where a lane index range coexists with an OR `.filter()` for
  // assignment, so it is the one that could plausibly mis-compose. Spec
  // §Testing requires all four plans asserted separately.
  const { accountId, userId, asUser } = await seedAccountMember(t, {
    name: "Ann",
    email: "ann@example.com",
    role: "agent",
  });
  await seedQualConfig(t, accountId);
  const teammate = await seedTeammate(t, {
    accountId,
    name: "Bob",
    email: "bob@example.com",
    role: "agent",
  });
  const contactId = await asUser.mutation(api.contacts.create, {
    phone: "111",
  });
  const now = Date.now();

  const mineChasing = await seedConversation(t, {
    accountId,
    contactId,
    awaitingReply: false,
    lastMessageAt: now - 9 * DAY,
    assignedToUserId: userId,
  });
  const poolChasing = await seedConversation(t, {
    accountId,
    contactId,
    awaitingReply: false,
    lastMessageAt: now - 20 * DAY, // older -> first, Chasing sorts asc
  });
  const othersChasing = await seedConversation(t, {
    accountId,
    contactId,
    awaitingReply: false,
    lastMessageAt: now - 30 * DAY,
    assignedToUserId: teammate,
  });
  // Safety property one, on the plan an agent actually looks at all day
  // (it was previously only asserted for a supervisor): the customer
  // spoke last, at an age that would otherwise be deep in Chasing.
  const mineInbound = await seedConversation(t, {
    accountId,
    contactId,
    awaitingReply: true,
    lastMessageAt: now - 90 * DAY,
    assignedToUserId: userId,
  });
  const poolInbound = await seedConversation(t, {
    accountId,
    contactId,
    awaitingReply: true,
    lastMessageAt: now - 45 * DAY,
  });
  const othersInbound = await seedConversation(t, {
    accountId,
    contactId,
    awaitingReply: true,
    lastMessageAt: now - 1 * DAY,
    assignedToUserId: teammate,
  });

  const ids = async (lane: "active" | "waiting" | "chasing") =>
    (
      await asUser.query(api.conversations.list, {
        lane,
        paginationOpts: { numItems: 50, cursor: null },
      })
    ).page.map((c) => c._id);

  // Mine + pool, never another agent's — and Chasing still oldest-first.
  expect(await ids("chasing")).toEqual([poolChasing, mineChasing]);
  expect(await ids("chasing")).not.toContain(othersChasing);
  // Active: mine + pool at ANY age, still newest-first.
  expect(await ids("active")).toEqual([poolInbound, mineInbound]);
  expect(await ids("active")).not.toContain(othersInbound);
  expect(await ids("waiting")).toEqual([]);
});

test("a viewer clicking Mine gets an empty lane without a single read (the empty plan)", async () => {
  const t = convexTest(schema, modules);
  // A viewer's scope is the pool only, so "Mine" is unsatisfiable and
  // `list` short-circuits before it touches the database. Deliberately
  // seeds NO `qualificationConfigs` row: the short-circuit precedes even
  // the cutoff read, so the lane needs no config to answer.
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Val",
    email: "val@example.com",
    role: "viewer",
  });
  const contactId = await t.run((ctx) =>
    ctx.db.insert("contacts", {
      accountId,
      phone: "+971500000123",
      phoneNormalized: "971500000123",
    }),
  );
  // A conversation that WOULD match the lane, to prove the empty answer
  // comes from the plan and not from an empty account.
  await seedConversation(t, {
    accountId,
    contactId,
    awaitingReply: false,
    lastMessageAt: Date.now() - 9 * DAY,
  });

  for (const lane of ["active", "waiting", "chasing"] as const) {
    const page = await asUser.query(api.conversations.list, {
      lane,
      assignment: "mine",
      paginationOpts: { numItems: 50, cursor: null },
    });
    expect(page.page).toEqual([]);
    expect(page.isDone).toBe(true);
    // The hand-built sentinel cursor of the no-read return. A real
    // `.paginate()` always yields a non-empty continuation string, so
    // this is the observable proof that no query ran.
    expect(page.continueCursor).toBe("");
  }

  // Same viewer WITHOUT the impossible tab does read, and sees the pool
  // row — so the empty answer above is the tab, not the role.
  const pool = await asUser.query(api.conversations.list, {
    lane: "chasing",
    paginationOpts: { numItems: 50, cursor: null },
  });
  expect(pool.page.length).toBe(1);
  expect(pool.continueCursor).not.toBe("");
});

test("a conversation created through findOrCreateForContact lands in Active", async () => {
  const t = convexTest(schema, modules);
  // NOT hand-seeded (the mistake that let the create-path bug survive
  // nine reviews): the row is created by the real mutation, so this test
  // fails if any `insert("conversations")` path forgets `awaitingReply`.
  // An `undefined` field matches NO lane range — Active binds
  // `eq(awaitingReply, true)`, Waiting/Chasing bind `false` — and the UI
  // always sends a lane, so the row would be invisible in every tab.
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Ann",
    email: "ann@example.com",
    role: "agent",
  });
  await seedQualConfig(t, accountId);
  const contactId = await asUser.mutation(api.contacts.create, {
    phone: "111",
  });

  const conversationId = await asUser.mutation(
    api.conversations.findOrCreateForContact,
    { contactId },
  );

  const ids = async (lane: "active" | "waiting" | "chasing") =>
    (
      await asUser.query(api.conversations.list, {
        lane,
        paginationOpts: { numItems: 50, cursor: null },
      })
    ).page.map((c) => c._id);

  expect(await ids("active")).toEqual([conversationId]);
  expect(await ids("waiting")).toEqual([]);
  expect(await ids("chasing")).toEqual([]);
  // And the stored field, so a future refactor of the lane ranges cannot
  // make this test pass for the wrong reason.
  expect((await t.run((ctx) => ctx.db.get(conversationId)))!.awaitingReply)
    .toBe(true);
});

// ============================================================
// Chasing-lane leadAnalyses join (Task 7, spec 2026-07-27-inbox-lanes) —
// `followUpsSent`/`sequenceStatus` on the row, gated on `lane ===
// "chasing"` so no other tab pays for the extra per-page read.
// ============================================================

test("the leadAnalyses join happens only on the Chasing lane", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Sam",
    email: "sam@example.com",
    role: "supervisor",
  });
  await seedQualConfig(t, accountId);
  const contactId = await asUser.mutation(api.contacts.create, {
    phone: "111",
  });
  const now = Date.now();
  const id = await seedConversation(t, {
    accountId,
    contactId,
    awaitingReply: false,
    lastMessageAt: now - 9 * DAY,
  });
  await t.run(async (ctx) => {
    await ctx.db.insert("leadAnalyses", {
      accountId,
      conversationId: id,
      contactId,
      scoreStatus: "scored",
      sequenceStatus: "exhausted",
      attempts: 0,
      followUpsSent: 3,
    });
  });

  const chasing = await asUser.query(api.conversations.list, {
    lane: "chasing",
    paginationOpts: { numItems: 10, cursor: null },
  });
  expect(chasing.page[0].followUpsSent).toBe(3);
  expect(chasing.page[0].sequenceStatus).toBe("exhausted");

  // Other lanes must not pay for the join.
  const active = await asUser.query(api.conversations.list, {
    lane: "active",
    paginationOpts: { numItems: 10, cursor: null },
  });
  expect(active.page.every((c) => c.followUpsSent === undefined)).toBe(true);
});

// ============================================================
// The grace window (owner report 2026-07-28). Without it the lane is a
// pure function of who spoke last, so a live back-and-forth throws the
// row across the Active/Waiting line on every message and the thread an
// agent is working vanishes from under them.
// ============================================================

const MIN = 60_000;

/** A bare contact for the grace tests — mirrors the inline insert the
 *  other lane tests use, rather than adding a competing public helper. */
async function graceContact(
  t: ReturnType<typeof convexTest>,
  accountId: Id<"accounts">,
) {
  return await t.run((ctx) =>
    ctx.db.insert("contacts", {
      accountId,
      phone: "+971500000777",
      phoneNormalized: "971500000777",
      name: "Grace Fixture",
    }),
  );
}

/** A second member of the SAME account, so "Mine" has something to exclude. */
async function graceOtherUser(
  t: ReturnType<typeof convexTest>,
  accountId: Id<"accounts">,
) {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {
      name: "Other", email: "other@example.com",
    });
    await ctx.db.insert("memberships", {
      userId, accountId, role: "agent",
      fullName: "Other", email: "other@example.com",
    });
    return userId;
  });
}

test("a thread we replied to moments ago stays in Active, not Waiting", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Sam", email: "sam@example.com", role: "supervisor",
  });
  await seedQualConfig(t, accountId);
  const contactId = await graceContact(t, accountId);
  // We spoke last, two minutes ago — a live exchange.
  const live = await seedConversation(t, {
    accountId, contactId, awaitingReply: false, lastMessageAt: Date.now() - 2 * MIN,
  });

  const ids = async (lane: "active" | "waiting") =>
    (await asUser.query(api.conversations.list, {
      lane, paginationOpts: { numItems: 50, cursor: null },
    })).page.map((c) => c._id);

  expect(await ids("active")).toEqual([live]);
  expect(await ids("waiting")).toEqual([]);
});

test("once the grace window passes, the thread moves to Waiting", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Sam", email: "sam@example.com", role: "supervisor",
  });
  await seedQualConfig(t, accountId);
  const contactId = await graceContact(t, accountId);
  // We spoke last, 30 minutes ago — well past the 15-minute grace.
  const parked = await seedConversation(t, {
    accountId, contactId, awaitingReply: false, lastMessageAt: Date.now() - 30 * MIN,
  });

  const ids = async (lane: "active" | "waiting") =>
    (await asUser.query(api.conversations.list, {
      lane, paginationOpts: { numItems: 50, cursor: null },
    })).page.map((c) => c._id);

  expect(await ids("waiting")).toEqual([parked]);
  expect(await ids("active")).toEqual([]);
});

test("Active and Waiting stay disjoint across the grace boundary", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Sam", email: "sam@example.com", role: "supervisor",
  });
  await seedQualConfig(t, accountId);
  const contactId = await graceContact(t, accountId);
  const now = Date.now();
  // 16 minutes is deliberately still here, and deliberately NOT asserted
  // onto a side. `graceCutoffMs` quantizes to `BOUNDARY_BUCKET_MS` so a
  // paginated cursor survives (see lanes.ts), which makes the effective
  // grace window 15-30 minutes depending on where in the bucket the test
  // happens to run. A thread at 16 minutes is therefore genuinely on
  // either side, and pinning it would only buy a test that fails on the
  // clock. What must hold regardless is what this test is actually
  // about — the lanes PARTITION the set — plus the unambiguous rows
  // landing where the model says. Asserting a bare `a.length === 3`
  // conflated the two and broke on the quantization alone.
  const offsets = [1, 5, 14, 16, 40, 120];
  const made: Id<"conversations">[] = [];
  for (const m of offsets) {
    made.push(await seedConversation(t, {
      accountId, contactId, awaitingReply: false, lastMessageAt: now - m * MIN,
    }));
  }
  const at = (m: number) => made[offsets.indexOf(m)]!;
  const page = async (lane: "active" | "waiting" | "chasing") =>
    (await asUser.query(api.conversations.list, {
      lane, paginationOpts: { numItems: 50, cursor: null },
    })).page.map((c) => c._id);

  const a = await page("active"), w = await page("waiting"), c = await page("chasing");
  // No conversation appears twice...
  const all = [...a, ...w, ...c];
  expect(new Set(all).size).toBe(all.length);
  // ...and none is lost.
  expect(new Set(all)).toEqual(new Set(made));
  // Newer than the shortest possible grace (15m) — always still live.
  for (const m of [1, 5, 14]) expect(a).toContain(at(m));
  // Older than the longest possible grace (30m) — always parked, and
  // still newer than the 1-day Chasing cutoff, so Waiting specifically.
  for (const m of [40, 120]) expect(w).toContain(at(m));
  // Nothing is old enough to have aged into Chasing.
  expect(c).toEqual([]);
});

test("a customer reply outranks a thread we answered earlier in the grace window", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Sam", email: "sam@example.com", role: "supervisor",
  });
  await seedQualConfig(t, accountId);
  const contactId = await graceContact(t, accountId);
  const now = Date.now();
  const weAnswered10mAgo = await seedConversation(t, {
    accountId, contactId, awaitingReply: false, lastMessageAt: now - 10 * MIN,
  });
  const theyRepliedJustNow = await seedConversation(t, {
    accountId, contactId, awaitingReply: true, lastMessageAt: now - 30_000,
  });

  const page = (await asUser.query(api.conversations.list, {
    lane: "active", paginationOpts: { numItems: 50, cursor: null },
  })).page.map((c) => c._id);

  // The merge must sort by recency, not append the grace set blindly.
  expect(page).toEqual([theyRepliedJustNow, weAnswered10mAgo]);
});

test("the grace set respects the Mine tab", async () => {
  const t = convexTest(schema, modules);
  const { accountId, userId, asUser } = await seedAccountMember(t, {
    name: "Ann", email: "ann@example.com", role: "agent",
  });
  await seedQualConfig(t, accountId);
  const contactId = await graceContact(t, accountId);
  const now = Date.now();
  const mine = await seedConversation(t, {
    accountId, contactId, awaitingReply: false,
    lastMessageAt: now - 3 * MIN, assignedToUserId: userId,
  });
  const theirs = await seedConversation(t, {
    accountId, contactId, awaitingReply: false,
    lastMessageAt: now - 3 * MIN, assignedToUserId: await graceOtherUser(t, accountId),
  });

  const page = (await asUser.query(api.conversations.list, {
    lane: "active", assignment: "mine", paginationOpts: { numItems: 50, cursor: null },
  })).page.map((c) => c._id);

  expect(page).toContain(mine);
  expect(page).not.toContain(theirs);
});

test("a snoozed conversation appears in NO lane, and Snoozed orders soonest-wake-first", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Sam", email: "sam@example.com", role: "supervisor",
  });
  await seedQualConfig(t, accountId);
  const contactId = await graceContact(t, accountId);
  const now = Date.now();
  const wakesSoon = await seedConversation(t, {
    accountId, contactId, awaitingReply: true,
    lastMessageAt: now - 60_000, snoozedUntil: now + 86_400_000,
  });
  const wakesLater = await seedConversation(t, {
    accountId, contactId, awaitingReply: true,
    lastMessageAt: now - 120_000, snoozedUntil: now + 7 * 86_400_000,
  });

  const ids = async (lane: "active" | "waiting" | "chasing" | "snoozed") =>
    (await asUser.query(api.conversations.list, {
      lane, paginationOpts: { numItems: 50, cursor: null },
    })).page.map((c) => c._id);

  for (const lane of ["active", "waiting", "chasing"] as const) {
    expect(await ids(lane)).not.toContain(wakesSoon);
    expect(await ids(lane)).not.toContain(wakesLater);
  }
  // Ascending by `snoozedUntil`: the thread that wakes first is at the
  // top, which is what makes the tab scannable — pins the order, not
  // just membership.
  expect(await ids("snoozed")).toEqual([wakesSoon, wakesLater]);
});

test("a forced thread is in Chasing and NOT in Waiting, however recent", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Sam", email: "sam@example.com", role: "supervisor",
  });
  await seedQualConfig(t, accountId);
  const contactId = await graceContact(t, accountId);
  // 30 minutes old: past grace, nowhere near the 3-day chasing cutoff,
  // so without the force this would be squarely in Waiting.
  const forced = await seedConversation(t, {
    accountId, contactId, awaitingReply: false,
    lastMessageAt: Date.now() - 30 * 60_000, chasingForcedAt: Date.now(),
  });

  const ids = async (lane: "waiting" | "chasing") =>
    (await asUser.query(api.conversations.list, {
      lane, paginationOpts: { numItems: 50, cursor: null },
    })).page.map((c) => c._id);

  expect(await ids("chasing")).toContain(forced);
  expect(await ids("waiting")).not.toContain(forced);
});

test("forced and derived Chasing rows appear together, without duplicates", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Sam", email: "sam@example.com", role: "supervisor",
  });
  await seedQualConfig(t, accountId);
  const contactId = await graceContact(t, accountId);
  const now = Date.now();
  const derived = await seedConversation(t, {
    accountId, contactId, awaitingReply: false, lastMessageAt: now - 9 * 86_400_000,
  });
  const forced = await seedConversation(t, {
    accountId, contactId, awaitingReply: false,
    lastMessageAt: now - 30 * 60_000, chasingForcedAt: now,
  });

  const page = (await asUser.query(api.conversations.list, {
    lane: "chasing", paginationOpts: { numItems: 50, cursor: null },
  })).page.map((c) => c._id);

  // Ascending by neglect: `derived` (9 days stale, smaller `lastMessageAt`)
  // outranks `forced` (30 minutes old) — pins the merge's sort direction,
  // not just its membership. Also proves no row is counted twice by the
  // union: `toEqual` on an array fails on a duplicate the way a bare
  // `Set` comparison would not.
  expect(page).toEqual([derived, forced]);
});

test("the four working lanes plus Snoozed stay disjoint and exhaustive", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Sam", email: "sam@example.com", role: "supervisor",
  });
  await seedQualConfig(t, accountId);
  const contactId = await graceContact(t, accountId);
  const now = Date.now();
  const made = [
    await seedConversation(t, { accountId, contactId, awaitingReply: true, lastMessageAt: now - 60_000 }),
    await seedConversation(t, { accountId, contactId, awaitingReply: false, lastMessageAt: now - 60 * 60_000 }),
    await seedConversation(t, { accountId, contactId, awaitingReply: false, lastMessageAt: now - 9 * 86_400_000 }),
    await seedConversation(t, { accountId, contactId, awaitingReply: false, lastMessageAt: now - 60 * 60_000, chasingForcedAt: now }),
    await seedConversation(t, { accountId, contactId, awaitingReply: true, lastMessageAt: now - 60_000, snoozedUntil: now + 86_400_000 }),
  ];
  const page = async (lane: "active" | "waiting" | "chasing" | "snoozed") =>
    (await asUser.query(api.conversations.list, {
      lane, paginationOpts: { numItems: 50, cursor: null },
    })).page.map((c) => c._id);

  const all = [
    ...(await page("active")), ...(await page("waiting")),
    ...(await page("chasing")), ...(await page("snoozed")),
  ];
  expect(new Set(all).size).toBe(all.length); // disjoint
  expect(new Set(all)).toEqual(new Set(made)); // exhaustive
});

// The four tests above all seed `role: "supervisor"` with no `assignment`
// filter, which resolves to `plan.kind === "any"` and so only ever
// exercises `by_account_lane_last_message`. In that index the override
// keys sit right after `archivedAt`. But
// `by_account_assigned_lane_last_message` — used whenever a single
// assignee is pinned, e.g. by the "Mine" tab — has the override keys in a
// DIFFERENT position, after `assignedToUserId`. A mis-ordered equality
// chain there can compile and still silently select the wrong rows, so it
// needs its own coverage rather than relying on the `any`-plan tests
// above. `assignment: "mine"` on a supervisor is enough to force
// `plan.kind === "eq"` without introducing a second role.
test("a snoozed conversation is invisible on the assigned (eq) index too", async () => {
  const t = convexTest(schema, modules);
  const { accountId, userId, asUser } = await seedAccountMember(t, {
    name: "Sam", email: "sam@example.com", role: "supervisor",
  });
  await seedQualConfig(t, accountId);
  const contactId = await graceContact(t, accountId);
  const snoozed = await seedConversation(t, {
    accountId, contactId, awaitingReply: true, assignedToUserId: userId,
    lastMessageAt: Date.now() - 60_000, snoozedUntil: Date.now() + 86_400_000,
  });

  const ids = async (lane: "active" | "waiting" | "chasing" | "snoozed") =>
    (await asUser.query(api.conversations.list, {
      lane, assignment: "mine", paginationOpts: { numItems: 50, cursor: null },
    })).page.map((c) => c._id);

  for (const lane of ["active", "waiting", "chasing"] as const) {
    expect(await ids(lane)).not.toContain(snoozed);
  }
  expect(await ids("snoozed")).toEqual([snoozed]);
});

// Covers the forced set's `eq`-plan chain specifically (conversations.ts,
// the `forcedQuery` block): `.eq("assignedToUserId", plan.assignee)`
// then `.eq("snoozedUntil", undefined)` then `.gt("chasingForcedAt", 0)`
// — the assignee binds BEFORE the overrides here, the opposite order
// from the pool-wide index, which is exactly the kind of transposition a
// silent wrong-rows bug would hide in.
test("a forced thread on the assigned (eq) index is in Chasing and NOT in Waiting", async () => {
  const t = convexTest(schema, modules);
  const { accountId, userId, asUser } = await seedAccountMember(t, {
    name: "Sam", email: "sam@example.com", role: "supervisor",
  });
  await seedQualConfig(t, accountId);
  const contactId = await graceContact(t, accountId);
  // 30 minutes old: past grace, nowhere near the chasing cutoff, so
  // without the force this would be squarely in Waiting.
  const forced = await seedConversation(t, {
    accountId, contactId, awaitingReply: false, assignedToUserId: userId,
    lastMessageAt: Date.now() - 30 * 60_000, chasingForcedAt: Date.now(),
  });

  const ids = async (lane: "waiting" | "chasing") =>
    (await asUser.query(api.conversations.list, {
      lane, assignment: "mine", paginationOpts: { numItems: 50, cursor: null },
    })).page.map((c) => c._id);

  expect(await ids("chasing")).toContain(forced);
  expect(await ids("waiting")).not.toContain(forced);
});

test("forced and derived Chasing rows union correctly on the assigned (eq) index", async () => {
  const t = convexTest(schema, modules);
  const { accountId, userId, asUser } = await seedAccountMember(t, {
    name: "Sam", email: "sam@example.com", role: "supervisor",
  });
  await seedQualConfig(t, accountId);
  const contactId = await graceContact(t, accountId);
  const now = Date.now();
  const derived = await seedConversation(t, {
    accountId, contactId, awaitingReply: false, assignedToUserId: userId,
    lastMessageAt: now - 9 * 86_400_000,
  });
  const forced = await seedConversation(t, {
    accountId, contactId, awaitingReply: false, assignedToUserId: userId,
    lastMessageAt: now - 30 * 60_000, chasingForcedAt: now,
  });

  const page = (await asUser.query(api.conversations.list, {
    lane: "chasing", assignment: "mine", paginationOpts: { numItems: 50, cursor: null },
  })).page.map((c) => c._id);

  // Same ascending-by-neglect order as the `any`-plan union test.
  expect(page).toEqual([derived, forced]);
});

// ============================================================
// Final whole-branch review — the fix wave.
// ============================================================

// Finding 5. The grace set is a SECOND index range, read with its own
// binding chain and merged into Active's page one. Its `eq(snoozedUntil,
// undefined)` / `eq(chasingForcedAt, undefined)` pair is what keeps an
// overridden thread out of it, and until now that was asserted only by
// inspection — every override test seeds a `lastMessageAt` well outside
// the grace window, so the main range excluded the row on its own and the
// grace bindings were never actually exercised. Drop the timestamp inside
// the window and the grace read is the ONLY thing standing between a
// snoozed (or forced) thread and the top of Active.
test("an overridden thread inside the grace window still stays out of Active", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Sam", email: "sam@example.com", role: "supervisor",
  });
  await seedQualConfig(t, accountId);
  const contactId = await graceContact(t, accountId);
  const now = Date.now();
  // We spoke last two minutes ago: inside the grace window, so WITHOUT
  // the override each of these would be pulled into Active by the grace
  // read (see "a thread we replied to moments ago stays in Active").
  const snoozed = await seedConversation(t, {
    accountId, contactId, awaitingReply: false,
    lastMessageAt: now - 2 * MIN, snoozedUntil: now + 86_400_000,
  });
  const forced = await seedConversation(t, {
    accountId, contactId, awaitingReply: false,
    lastMessageAt: now - 2 * MIN, chasingForcedAt: now,
  });

  const ids = async (lane: "active" | "waiting" | "chasing" | "snoozed") =>
    (await asUser.query(api.conversations.list, {
      lane, paginationOpts: { numItems: 50, cursor: null },
    })).page.map((c) => c._id);

  const active = await ids("active");
  expect(active).not.toContain(snoozed);
  expect(active).not.toContain(forced);
  // And each is still reachable in exactly the one place it belongs —
  // "not in Active" is only half the invariant.
  expect(await ids("snoozed")).toEqual([snoozed]);
  expect(await ids("chasing")).toEqual([forced]);
  expect(await ids("waiting")).toEqual([]);
});

// The same, on the OTHER binding chain. The grace read picks
// `by_account_assigned_lane_last_message` whenever a single assignee is
// pinned, and there the override keys sit after `assignedToUserId` rather
// than immediately after `archivedAt` — a transposition that compiles and
// silently selects the wrong rows.
test("an overridden thread inside the grace window stays out of Active on the assigned (eq) index too", async () => {
  const t = convexTest(schema, modules);
  const { accountId, userId, asUser } = await seedAccountMember(t, {
    name: "Sam", email: "sam@example.com", role: "supervisor",
  });
  await seedQualConfig(t, accountId);
  const contactId = await graceContact(t, accountId);
  const now = Date.now();
  const snoozed = await seedConversation(t, {
    accountId, contactId, awaitingReply: false, assignedToUserId: userId,
    lastMessageAt: now - 2 * MIN, snoozedUntil: now + 86_400_000,
  });
  const forced = await seedConversation(t, {
    accountId, contactId, awaitingReply: false, assignedToUserId: userId,
    lastMessageAt: now - 2 * MIN, chasingForcedAt: now,
  });
  // A control that SHOULD come through the grace read, so the test fails
  // if the grace branch stopped returning anything at all rather than
  // because the override bindings work.
  const live = await seedConversation(t, {
    accountId, contactId, awaitingReply: false, assignedToUserId: userId,
    lastMessageAt: now - 2 * MIN,
  });

  const active = (await asUser.query(api.conversations.list, {
    lane: "active", assignment: "mine", paginationOpts: { numItems: 50, cursor: null },
  })).page.map((c) => c._id);

  expect(active).toEqual([live]);
  expect(active).not.toContain(snoozed);
  expect(active).not.toContain(forced);
});

// Finding 1. The forced set is a capped `.take()` merged into page one,
// and a force NEVER expires — so unlike the grace set, whose truncation
// self-heals as rows age out, a forced row dropped by the cap is gone
// from every lane until somebody un-forces it. Reading the range
// ascending by `chasingForcedAt` makes the survivors the longest-forced
// (the most neglected, which a neglect queue must not drop) and the
// casualties the just-forced, which the agent who forced them is still
// looking at. This pins that direction: seed one more than the cap and
// assert WHICH row falls out.
test("past the forced cap, Chasing keeps the longest-forced and drops the just-forced", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Sam", email: "sam@example.com", role: "supervisor",
  });
  await seedQualConfig(t, accountId);
  const contactId = await graceContact(t, accountId);
  const now = Date.now();
  // `FORCED_CAP` in conversations.ts is 60; 61 rows is the smallest
  // fixture that truncates. Forced oldest-first, so `made[0]` has been
  // forced longest and `made[60]` was forced a moment ago.
  const CAP = 60;
  const made: Id<"conversations">[] = [];
  for (let i = 0; i <= CAP; i++) {
    made.push(await seedConversation(t, {
      accountId, contactId, awaitingReply: false,
      // Inside Waiting by derivation: the force is the only thing putting
      // any of these in Chasing, so the page is the forced set alone.
      lastMessageAt: now - 30 * MIN - i,
      chasingForcedAt: now - (CAP - i) * 1_000,
    }));
  }

  const page = (await asUser.query(api.conversations.list, {
    lane: "chasing", paginationOpts: { numItems: 100, cursor: null },
  })).page.map((c) => c._id);

  expect(page).toHaveLength(CAP);
  // The longest-forced survives; the most recently forced is the one lost.
  expect(page).toContain(made[0]);
  expect(page).not.toContain(made[CAP]);
  expect(new Set(page)).toEqual(new Set(made.slice(0, CAP)));
});

// ============================================================
// insertConversation -> conversationsStarted (reports rollup, Task 2:
// docs/superpowers/specs/2026-08-05-reports-section-design.md). Reuses the
// bare `seedAccount` defined above for `unarchiveOnInbound` rather than
// `seedAccountMember` — these tests write directly via `t.run` and need no
// authenticated session.
// ============================================================

test("insertConversation bumps conversationsStarted in the current hour", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccount(t);

  const contactId = await t.run(async (ctx) =>
    ctx.db.insert("contacts", {
      accountId,
      phone: "+971500000001",
      phoneNormalized: "971500000001",
    }),
  );
  await t.run(async (ctx) => {
    await insertConversation(ctx, { accountId, contactId });
  });

  const rows = await t.run(async (ctx) =>
    ctx.db
      .query("messageHourlyStats")
      .withIndex("by_account_hour", (q) => q.eq("accountId", accountId))
      .collect(),
  );
  expect(rows).toHaveLength(1);
  expect(rows[0]!.conversationsStarted).toBe(1);
  expect(rows[0]!.hourStartMs).toBe(hourStartMs(Date.now()));
  // The counts this row shares with the message rollup must be seeded, not
  // left undefined — the schema requires them.
  expect(rows[0]!.incoming).toBe(0);
  expect(rows[0]!.outgoing).toBe(0);
});

test("two conversations in one hour share a bucket", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccount(t);

  await t.run(async (ctx) => {
    for (const phone of ["+971500000002", "+971500000003"]) {
      const contactId = await ctx.db.insert("contacts", {
        accountId,
        phone,
        phoneNormalized: phone.replace(/\D/g, ""),
      });
      await insertConversation(ctx, { accountId, contactId });
    }
  });

  const rows = await t.run(async (ctx) =>
    ctx.db
      .query("messageHourlyStats")
      .withIndex("by_account_hour", (q) => q.eq("accountId", accountId))
      .collect(),
  );
  expect(rows).toHaveLength(1);
  expect(rows[0]!.conversationsStarted).toBe(2);
});

// ============================================================
// applyAssignment routing (Task 2) — assign/unassign/setAutoreplyPaused
// now record a `conversationEvents` row alongside the `assignedToUserId`
// patch. These assert on that timeline, not just the field.
// ============================================================

test("assign records a manual handover on the timeline", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId, userId } = await seedAccountMember(t, {
    name: "Owner", email: "owner@example.com", role: "admin",
  });
  const agentId = await seedTeammate(t, {
    accountId, name: "Agent", email: "agent@example.com", role: "agent",
  });
  const contactId = await asUser.mutation(api.contacts.create, { phone: "111" });
  const conversationId = await seedConversation(t, { accountId, contactId });

  await asUser.mutation(api.conversations.assign, { conversationId, userId: agentId });

  const events = await eventsOf(t, conversationId);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    kind: "assigned", source: "manual",
    actorUserId: userId, targetUserId: agentId,
  });
});

test("assign still bumps status to pending", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId } = await seedAccountMember(t, {
    name: "Owner", email: "owner@example.com", role: "admin",
  });
  const agentId = await seedTeammate(t, {
    accountId, name: "Agent", email: "agent@example.com", role: "agent",
  });
  const contactId = await asUser.mutation(api.contacts.create, { phone: "111" });
  const conversationId = await seedConversation(t, { accountId, contactId });

  await asUser.mutation(api.conversations.assign, { conversationId, userId: agentId });

  const after = await t.run((ctx) => ctx.db.get(conversationId));
  expect(after!.status).toBe("pending");
});

test("assigning the same person twice records only one event", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId } = await seedAccountMember(t, {
    name: "Owner", email: "owner@example.com", role: "admin",
  });
  const agentId = await seedTeammate(t, {
    accountId, name: "Agent", email: "agent@example.com", role: "agent",
  });
  const contactId = await asUser.mutation(api.contacts.create, { phone: "111" });
  const conversationId = await seedConversation(t, { accountId, contactId });

  await asUser.mutation(api.conversations.assign, { conversationId, userId: agentId });
  await asUser.mutation(api.conversations.assign, { conversationId, userId: agentId });

  expect(await eventsOf(t, conversationId)).toHaveLength(1);
});

test("unassign records the release and who held it", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId, userId } = await seedAccountMember(t, {
    name: "Owner", email: "owner@example.com", role: "admin",
  });
  const agentId = await seedTeammate(t, {
    accountId, name: "Agent", email: "agent@example.com", role: "agent",
  });
  const contactId = await asUser.mutation(api.contacts.create, { phone: "111" });
  const conversationId = await seedConversation(t, { accountId, contactId });
  await asUser.mutation(api.conversations.assign, { conversationId, userId: agentId });

  await asUser.mutation(api.conversations.unassign, { conversationId });

  const events = await eventsOf(t, conversationId);
  expect(events).toHaveLength(2);
  expect(events[1]).toMatchObject({
    kind: "unassigned", source: "manual",
    actorUserId: userId, previousUserId: agentId,
  });
});

test("taking over records a takeover, resuming AI records a release", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId, userId } = await seedAccountMember(t, {
    name: "Agent", email: "agent@example.com", role: "agent",
  });
  const contactId = await asUser.mutation(api.contacts.create, { phone: "111" });
  const conversationId = await seedConversation(t, { accountId, contactId });

  await asUser.mutation(api.conversations.setAutoreplyPaused, {
    conversationId, paused: true, assignToMe: true,
  });
  await asUser.mutation(api.conversations.setAutoreplyPaused, {
    conversationId, paused: false,
  });

  const events = await eventsOf(t, conversationId);
  expect(events.map((e) => e.source)).toEqual(["takeover", "release"]);
  expect(events[0]).toMatchObject({
    kind: "assigned", actorUserId: userId, targetUserId: userId,
  });
  expect(events[1]).toMatchObject({
    kind: "unassigned", previousUserId: userId,
  });
});

test("listEvents returns handovers oldest-first with resolved names", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId } = await seedAccountMember(t, {
    name: "Owner", email: "owner@example.com", role: "admin",
  });
  const agentId = await seedTeammate(t, {
    accountId, name: "Agent", email: "agent@example.com", role: "agent",
  });
  const contactId = await asUser.mutation(api.contacts.create, { phone: "111" });
  const conversationId = await seedConversation(t, { accountId, contactId });

  await asUser.mutation(api.conversations.assign, { conversationId, userId: agentId });
  await asUser.mutation(api.conversations.unassign, { conversationId });

  const events = await asUser.query(api.conversations.listEvents, { conversationId });

  expect(events).toHaveLength(2);
  expect(events[0]).toMatchObject({
    kind: "assigned", source: "manual", actorName: "Owner", targetName: "Agent",
  });
  expect(events[1]).toMatchObject({
    kind: "unassigned", source: "manual", actorName: "Owner", previousName: "Agent",
  });
  expect(events[0]._creationTime).toBeLessThanOrEqual(events[1]._creationTime);
});

test("listEvents never leaks a member email as a name", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId } = await seedAccountMember(t, {
    name: "Owner", email: "owner@example.com", role: "admin",
  });
  // A membership with no fullName — the fallback must be the generic
  // word, never the email sitting right beside it.
  const namelessId = await t.run(async (ctx) => {
    const id = await ctx.db.insert("users", {
      name: "N", email: "nameless@example.com",
    });
    await ctx.db.insert("memberships", {
      userId: id, accountId, role: "agent", email: "nameless@example.com",
    });
    return id;
  });
  const contactId = await asUser.mutation(api.contacts.create, { phone: "111" });
  const conversationId = await seedConversation(t, { accountId, contactId });

  await asUser.mutation(api.conversations.assign, {
    conversationId, userId: namelessId,
  });

  const events = await asUser.query(api.conversations.listEvents, { conversationId });
  expect(events[0].targetName).toBe("Member");
});

test("listEvents refuses a conversation the caller cannot reach", async () => {
  const t = convexTest(schema, modules);
  const owner = await seedAccountMember(t, {
    name: "Owner", email: "owner@example.com", role: "admin",
  });
  const other = await seedAccountMember(t, {
    name: "Other", email: "other@example.com", role: "admin",
  });
  const contactId = await owner.asUser.mutation(api.contacts.create, { phone: "111" });
  const conversationId = await seedConversation(t, {
    accountId: owner.accountId, contactId,
  });

  await expect(
    other.asUser.query(api.conversations.listEvents, { conversationId }),
  ).rejects.toThrow();
});

// ------------------------------------------------------------------
// reassignAllFromUser — the offboarding sweep
// ------------------------------------------------------------------

/** Seeds `count` conversations assigned to `userId`, one contact each. */
async function seedAssignedConversations(
  t: TestConvex<typeof schema>,
  accountId: Id<"accounts">,
  userId: Id<"users">,
  count: number,
) {
  const ids: Id<"conversations">[] = [];
  for (let i = 0; i < count; i += 1) {
    const contactId = await t.run((ctx) =>
      ctx.db.insert("contacts", {
        accountId,
        phone: `9${i}`,
        phoneNormalized: `9${i}`,
        name: `C${i}`,
      }),
    );
    ids.push(
      await seedConversation(t, { accountId, contactId, assignedToUserId: userId }),
    );
  }
  return ids;
}

test("reassignAllFromUser moves every one of the leaver's threads to the new owner", async () => {
  const t = convexTest(schema, modules);
  const owner = await seedAccountMember(t, {
    name: "Owner", email: "owner@example.com", role: "owner",
  });
  const leaver = await seedTeammate(t, {
    accountId: owner.accountId, name: "Leaver", email: "leaver@example.com", role: "viewer",
  });
  const keeper = await seedTeammate(t, {
    accountId: owner.accountId, name: "Keeper", email: "keeper@example.com", role: "agent",
  });
  const ids = await seedAssignedConversations(t, owner.accountId, leaver, 3);

  const result = await t.mutation(internal.conversations.reassignAllFromUser, {
    accountId: owner.accountId,
    fromUserId: leaver,
    toUserId: keeper,
  });

  expect(result).toEqual({ moved: 3, scanned: 3, more: false });
  for (const id of ids) {
    const doc = await t.run((ctx) => ctx.db.get(id));
    expect(doc?.assignedToUserId).toBe(keeper);
  }
});

test("reassignAllFromUser records a handover on the thread's own timeline", async () => {
  const t = convexTest(schema, modules);
  const owner = await seedAccountMember(t, {
    name: "Owner", email: "owner@example.com", role: "owner",
  });
  const leaver = await seedTeammate(t, {
    accountId: owner.accountId, name: "Leaver", email: "leaver@example.com", role: "viewer",
  });
  const keeper = await seedTeammate(t, {
    accountId: owner.accountId, name: "Keeper", email: "keeper@example.com", role: "agent",
  });
  const [conversationId] = await seedAssignedConversations(t, owner.accountId, leaver, 1);

  await t.mutation(internal.conversations.reassignAllFromUser, {
    accountId: owner.accountId, fromUserId: leaver, toUserId: keeper,
  });

  const events = await eventsOf(t, conversationId);
  expect(events).toHaveLength(1);
  expect(events[0].kind).toBe("assigned");
  expect(events[0].targetUserId).toBe(keeper);
  expect(events[0].previousUserId).toBe(leaver);
  // Nobody clicked this — the absent actor is what the UI reads to
  // phrase the line as a system move.
  expect(events[0].actorUserId).toBeUndefined();
});

test("reassignAllFromUser leaves status untouched and bills no lead", async () => {
  const t = convexTest(schema, modules);
  const owner = await seedAccountMember(t, {
    name: "Owner", email: "owner@example.com", role: "owner",
  });
  const leaver = await seedTeammate(t, {
    accountId: owner.accountId, name: "Leaver", email: "leaver@example.com", role: "viewer",
  });
  // An "agent" destination is the case that would be charged had this
  // gone through `conversations.assign` — see `chargeLeadIfAgent`.
  const keeper = await seedTeammate(t, {
    accountId: owner.accountId, name: "Keeper", email: "keeper@example.com", role: "agent",
  });
  const contactId = await t.run((ctx) =>
    ctx.db.insert("contacts", {
      accountId: owner.accountId, phone: "555", phoneNormalized: "555", name: "C",
    }),
  );
  const conversationId = await seedConversation(t, {
    accountId: owner.accountId, contactId, status: "closed", assignedToUserId: leaver,
  });

  await t.mutation(internal.conversations.reassignAllFromUser, {
    accountId: owner.accountId, fromUserId: leaver, toUserId: keeper,
  });

  const doc = await t.run((ctx) => ctx.db.get(conversationId));
  expect(doc?.status).toBe("closed");
  const charges = await t.run((ctx) => ctx.db.query("leadCharges").collect());
  expect(charges).toHaveLength(0);
  const notifications = await t.run((ctx) => ctx.db.query("notifications").collect());
  expect(notifications).toHaveLength(0);
});

test("reassignAllFromUser batches, and `more` reports the remainder", async () => {
  const t = convexTest(schema, modules);
  const owner = await seedAccountMember(t, {
    name: "Owner", email: "owner@example.com", role: "owner",
  });
  const leaver = await seedTeammate(t, {
    accountId: owner.accountId, name: "Leaver", email: "leaver@example.com", role: "viewer",
  });
  const keeper = await seedTeammate(t, {
    accountId: owner.accountId, name: "Keeper", email: "keeper@example.com", role: "agent",
  });
  await seedAssignedConversations(t, owner.accountId, leaver, 5);

  const first = await t.mutation(internal.conversations.reassignAllFromUser, {
    accountId: owner.accountId, fromUserId: leaver, toUserId: keeper, limit: 2,
  });
  expect(first).toEqual({ moved: 2, scanned: 2, more: true });

  const second = await t.mutation(internal.conversations.reassignAllFromUser, {
    accountId: owner.accountId, fromUserId: leaver, toUserId: keeper, limit: 10,
  });
  expect(second).toEqual({ moved: 3, scanned: 3, more: false });

  const third = await t.mutation(internal.conversations.reassignAllFromUser, {
    accountId: owner.accountId, fromUserId: leaver, toUserId: keeper, limit: 10,
  });
  expect(third).toEqual({ moved: 0, scanned: 0, more: false });
});

test("reassignAllFromUser dry run writes nothing", async () => {
  const t = convexTest(schema, modules);
  const owner = await seedAccountMember(t, {
    name: "Owner", email: "owner@example.com", role: "owner",
  });
  const leaver = await seedTeammate(t, {
    accountId: owner.accountId, name: "Leaver", email: "leaver@example.com", role: "viewer",
  });
  const keeper = await seedTeammate(t, {
    accountId: owner.accountId, name: "Keeper", email: "keeper@example.com", role: "agent",
  });
  const [conversationId] = await seedAssignedConversations(t, owner.accountId, leaver, 2);

  const result = await t.mutation(internal.conversations.reassignAllFromUser, {
    accountId: owner.accountId, fromUserId: leaver, toUserId: keeper, dryRun: true,
  });

  expect(result).toEqual({ moved: 0, scanned: 2, more: false });
  const doc = await t.run((ctx) => ctx.db.get(conversationId));
  expect(doc?.assignedToUserId).toBe(leaver);
  expect(await eventsOf(t, conversationId)).toHaveLength(0);
});

test("reassignAllFromUser refuses a destination who is not a member of the account", async () => {
  const t = convexTest(schema, modules);
  const owner = await seedAccountMember(t, {
    name: "Owner", email: "owner@example.com", role: "owner",
  });
  const other = await seedAccountMember(t, {
    name: "Other", email: "other@example.com", role: "owner",
  });
  const leaver = await seedTeammate(t, {
    accountId: owner.accountId, name: "Leaver", email: "leaver@example.com", role: "viewer",
  });

  await expect(
    t.mutation(internal.conversations.reassignAllFromUser, {
      accountId: owner.accountId, fromUserId: leaver, toUserId: other.userId,
    }),
  ).rejects.toThrow();
});

test("reassignAllFromUser ignores another account's identically-assigned threads", async () => {
  const t = convexTest(schema, modules);
  const owner = await seedAccountMember(t, {
    name: "Owner", email: "owner@example.com", role: "owner",
  });
  const other = await seedAccountMember(t, {
    name: "Other", email: "other@example.com", role: "owner",
  });
  const leaver = await seedTeammate(t, {
    accountId: owner.accountId, name: "Leaver", email: "leaver@example.com", role: "viewer",
  });
  // The same user also carries threads on a SECOND account — a shape the
  // schema permits (nothing makes `memberships` unique per user), so the
  // query is pinned against it even though no current code path builds it.
  await t.run((ctx) =>
    ctx.db.insert("memberships", {
      userId: leaver, accountId: other.accountId, role: "viewer",
      fullName: "Leaver", email: "leaver@example.com",
    }),
  );
  const keeper = await seedTeammate(t, {
    accountId: owner.accountId, name: "Keeper", email: "keeper@example.com", role: "agent",
  });
  const [mine] = await seedAssignedConversations(t, owner.accountId, leaver, 1);
  const [theirs] = await seedAssignedConversations(t, other.accountId, leaver, 1);

  const result = await t.mutation(internal.conversations.reassignAllFromUser, {
    accountId: owner.accountId, fromUserId: leaver, toUserId: keeper,
  });

  expect(result.moved).toBe(1);
  expect((await t.run((ctx) => ctx.db.get(mine)))?.assignedToUserId).toBe(keeper);
  expect((await t.run((ctx) => ctx.db.get(theirs)))?.assignedToUserId).toBe(leaver);
});
