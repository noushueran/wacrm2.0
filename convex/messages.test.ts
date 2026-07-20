/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import type { AccountRole } from "./lib/roles";
import { insertMessageAndUpdateConversation } from "./messages";
import { hourStartMs } from "./lib/messageStats";

// Convex function modules for convex-test to resolve `api.*` references
// against. Absolute, from-project-root pattern (matches
// `convex/conversations.test.ts`/`convex/contacts.test.ts` — see those
// files' comments for why this must be absolute rather than a relative
// "./**").
const modules = import.meta.glob("/convex/**/*.ts");

/**
 * Seeds a `users` row + an `accounts`/`memberships` row for a fresh
 * account, and returns a convex-test client already authenticated as
 * that user. Duplicated from `convex/conversations.test.ts` rather than
 * imported — each `convex/*.test.ts` suite owns its own copy of this
 * helper (see that file's own comment on `seedAccountMember`, and
 * `convex/lib/auth.test.ts`'s `insertUser`/`insertMembership` for the
 * same pattern elsewhere). Bypasses `accounts.bootstrapAccount` on
 * purpose — this suite tests `messages.ts`, not the bootstrap flow.
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
 * Inserts a `conversations` row directly via `t.run`, exactly like
 * `convex/conversations.test.ts`'s own `seedConversation` — this suite
 * is what actually exercises the denormalized writes (`lastMessageAt`/
 * `lastMessageText`/`updatedAt`/`unreadCount`) that Task 1 deferred to
 * Task 2. `unreadCount` defaults to 0, matching every real insert.
 */
async function seedConversation(
  t: ReturnType<typeof convexTest>,
  opts: { accountId: Id<"accounts">; contactId: Id<"contacts"> },
) {
  return await t.run((ctx) =>
    ctx.db.insert("conversations", {
      accountId: opts.accountId,
      contactId: opts.contactId,
      status: "open",
      unreadCount: 0,
    }),
  );
}

/**
 * Seeds a teammate onto an existing account with a chosen role and
 * returns an authenticated client for them — unlike `seedAccountMember`
 * above, which always mints a fresh account. Used by the role-scoped
 * access tests (Task 7) below, which need several differently-roled
 * teammates on the SAME account. Copied from
 * `convex/conversations.test.ts`'s identical helper (Task 4).
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
 * by the role-scoped access tests (Task 7) to seed "mine" / "pool" /
 * "a teammate's" conversations. Copied from
 * `convex/conversations.test.ts`'s identical helper (Task 4).
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
 * of its own — the role-scoped access tests (Task 7) build their own
 * differently-roled teammates via `seedUserInAccount` and never need to
 * act as the owner directly. Copied from `convex/conversations.test.ts`'s
 * identical helper (Task 4).
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

// Task 4's `onePage` shape (`{ paginationOpts: {...} }`, spread at each
// call site via `...onePage`) rather than this file's earlier bare
// `{ numItems, cursor }` value — unified so the Task 7 tests below
// (copied verbatim from the task brief, which spreads `...onePage`)
// and this file's pre-existing call sites (updated to `...onePage`
// alongside this change) share one constant.
const onePage = { paginationOpts: { numItems: 50, cursor: null } };

// ============================================================
// append — insert + conversation denorm update
// ============================================================

test("append inserts a message, updates the conversation's preview fields, and bumps unreadCount only for customer-authored messages", async () => {
  const t = convexTest(schema, modules);
  // supervisor, not agent: this conversation is seeded unassigned
  // (pool) and this test is about denormalized-write behavior, not
  // RBAC — Task 7's own access rules are covered separately below.
  const { asUser, accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "supervisor",
  });
  const contactId = await asUser.mutation(api.contacts.create, {
    phone: "111",
  });
  const conversationId = await seedConversation(t, { accountId, contactId });

  const beforeAppend = Date.now();
  const customerMessageId = await asUser.mutation(api.messages.append, {
    conversationId,
    senderType: "customer",
    contentType: "text",
    contentText: "Hi, is anyone there?",
  });

  const messageDoc = await t.run((ctx) => ctx.db.get(customerMessageId));
  expect(messageDoc).not.toBeNull();
  expect(messageDoc!.accountId).toBe(accountId);
  expect(messageDoc!.conversationId).toBe(conversationId);
  expect(messageDoc!.senderType).toBe("customer");
  expect(messageDoc!.contentType).toBe("text");
  expect(messageDoc!.contentText).toBe("Hi, is anyone there?");
  expect(messageDoc!.status).toBe("sent");

  const afterCustomer = await t.run((ctx) => ctx.db.get(conversationId));
  expect(afterCustomer!.lastMessageText).toBe("Hi, is anyone there?");
  expect(afterCustomer!.lastMessageAt).toBeGreaterThanOrEqual(beforeAppend);
  expect(afterCustomer!.updatedAt).toBeGreaterThanOrEqual(beforeAppend);
  // 0 -> 1: a customer (inbound) message bumps unreadCount.
  expect(afterCustomer!.unreadCount).toBe(1);

  // An agent reply must NOT bump unreadCount further.
  await asUser.mutation(api.messages.append, {
    conversationId,
    senderType: "agent",
    contentType: "text",
    contentText: "Yes! How can I help?",
  });
  const afterAgent = await t.run((ctx) => ctx.db.get(conversationId));
  expect(afterAgent!.unreadCount).toBe(1);
  expect(afterAgent!.lastMessageText).toBe("Yes! How can I help?");

  // Neither does a bot-authored message.
  await asUser.mutation(api.messages.append, {
    conversationId,
    senderType: "bot",
    contentType: "text",
    contentText: "Automated notice",
  });
  const afterBot = await t.run((ctx) => ctx.db.get(conversationId));
  expect(afterBot!.unreadCount).toBe(1);
});

test("append falls back to a bracketed content-type preview when contentText is omitted", async () => {
  const t = convexTest(schema, modules);
  // supervisor: pool conversation, not about RBAC (see Task 7 tests below).
  const { asUser, accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "supervisor",
  });
  const contactId = await asUser.mutation(api.contacts.create, {
    phone: "111",
  });
  const conversationId = await seedConversation(t, { accountId, contactId });

  await asUser.mutation(api.messages.append, {
    conversationId,
    senderType: "customer",
    contentType: "image",
    mediaUrl: "https://example.com/photo.jpg",
  });

  const conversation = await t.run((ctx) => ctx.db.get(conversationId));
  expect(conversation!.lastMessageText).toBe("[image]");
});

// ============================================================
// listByConversation — ordering
// ============================================================

test("listByConversation returns messages newest-first", async () => {
  const t = convexTest(schema, modules);
  // supervisor: pool conversation, not about RBAC (see Task 7 tests below).
  const { asUser, accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "supervisor",
  });
  const contactId = await asUser.mutation(api.contacts.create, {
    phone: "111",
  });
  const conversationId = await seedConversation(t, { accountId, contactId });

  const first = await asUser.mutation(api.messages.append, {
    conversationId,
    senderType: "customer",
    contentType: "text",
    contentText: "first",
  });
  const second = await asUser.mutation(api.messages.append, {
    conversationId,
    senderType: "agent",
    contentType: "text",
    contentText: "second",
  });
  const third = await asUser.mutation(api.messages.append, {
    conversationId,
    senderType: "customer",
    contentType: "text",
    contentText: "third",
  });

  const result = await asUser.query(api.messages.listByConversation, {
    conversationId,
    ...onePage,
  });

  expect(result.page.map((m) => m._id)).toEqual([third, second, first]);
});

// ============================================================
// cross-account denial — proves the account-isolation model holds for
// the new `messages.listByConversation`/`messages.append` functions.
// ============================================================

test("listByConversation throws NOT_FOUND for a conversation belonging to a different account", async () => {
  const t = convexTest(schema, modules);
  // supervisor: pool conversation, not about RBAC (see Task 7 tests below).
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

  const aliceContactId = await asAlice.mutation(api.contacts.create, {
    phone: "111",
  });
  const conversationId = await seedConversation(t, {
    accountId: aliceAccountId,
    contactId: aliceContactId,
  });
  await asAlice.mutation(api.messages.append, {
    conversationId,
    senderType: "customer",
    contentType: "text",
    contentText: "Alice's message",
  });

  await expect(
    asBob.query(api.messages.listByConversation, {
      conversationId,
      ...onePage,
    }),
  ).rejects.toMatchObject({
    data: { code: "NOT_FOUND", entity: "conversation" },
  });

  // Alice herself can still read it — proves the throw above is really
  // about cross-account isolation, not a broken query in general.
  const hers = await asAlice.query(api.messages.listByConversation, {
    conversationId,
    ...onePage,
  });
  expect(hers.page).toHaveLength(1);
});

test("append throws NOT_FOUND for a conversation belonging to a different account, and creates no message", async () => {
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
    asBob.mutation(api.messages.append, {
      conversationId,
      senderType: "customer",
      contentType: "text",
      contentText: "Bob trying to inject a message",
    }),
  ).rejects.toMatchObject({
    data: { code: "NOT_FOUND", entity: "conversation" },
  });

  const messagesOnAlicesConversation = await t.run((ctx) =>
    ctx.db
      .query("messages")
      .withIndex("by_conversation", (q) =>
        q.eq("conversationId", conversationId),
      )
      .collect(),
  );
  expect(messagesOnAlicesConversation).toHaveLength(0);

  // The conversation itself must be untouched too — no denorm write
  // should leak through before the ownership check runs.
  const conversation = await t.run((ctx) => ctx.db.get(conversationId));
  expect(conversation!.unreadCount).toBe(0);
  expect(conversation!.lastMessageText).toBeUndefined();
  expect(conversation!.lastMessageAt).toBeUndefined();
});

// ============================================================
// getForAccount — server-only counterpart of a `requireOwnMessage`-
// style lookup, for `reactions.reactToMeta` (Phase 8, Task 4): a public
// `action` has no `ctx.db` to check message ownership inline.
// ============================================================

test("getForAccount returns the message when it belongs to accountId", async () => {
  const t = convexTest(schema, modules);
  // supervisor: pool conversation, not about RBAC (see Task 7 tests below).
  const { asUser, accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "supervisor",
  });
  const contactId = await asUser.mutation(api.contacts.create, {
    phone: "111",
  });
  const conversationId = await seedConversation(t, { accountId, contactId });
  const messageId = await asUser.mutation(api.messages.append, {
    conversationId,
    senderType: "customer",
    contentType: "text",
    contentText: "hi",
    messageId: "wamid.X",
  });

  const result = await t.query(internal.messages.getForAccount, {
    accountId,
    messageId,
  });

  expect(result._id).toBe(messageId);
  expect(result.messageId).toBe("wamid.X");
  expect(result.conversationId).toBe(conversationId);
});

test("getForAccount throws NOT_FOUND for a message belonging to a different account", async () => {
  const t = convexTest(schema, modules);
  // supervisor: pool conversation, not about RBAC (see Task 7 tests below).
  const { asUser: asAlice, accountId: aliceAccountId } =
    await seedAccountMember(t, {
      name: "Alice",
      email: "alice@example.com",
      role: "supervisor",
    });
  const { accountId: bobAccountId } = await seedAccountMember(t, {
    name: "Bob",
    email: "bob@example.com",
    role: "agent",
  });
  const aliceContactId = await asAlice.mutation(api.contacts.create, {
    phone: "111",
  });
  const aliceConversationId = await seedConversation(t, {
    accountId: aliceAccountId,
    contactId: aliceContactId,
  });
  const aliceMessageId = await asAlice.mutation(api.messages.append, {
    conversationId: aliceConversationId,
    senderType: "customer",
    contentType: "text",
    contentText: "hi",
  });

  await expect(
    t.query(internal.messages.getForAccount, {
      accountId: bobAccountId,
      messageId: aliceMessageId,
    }),
  ).rejects.toMatchObject({ data: { code: "NOT_FOUND", entity: "message" } });
});

// ============================================================
// updateDeliveryStatusByWamid — Meta delivery-status webhook handler
// (Phase 8, Task 4), ported from route.ts's `handleStatusUpdate` step 1
// ============================================================

test("updateDeliveryStatusByWamid patches the status of the message matching the wamid", async () => {
  const t = convexTest(schema, modules);
  // supervisor: pool conversation, not about RBAC (see Task 7 tests below).
  const { asUser, accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "supervisor",
  });
  const contactId = await asUser.mutation(api.contacts.create, { phone: "111" });
  const conversationId = await seedConversation(t, { accountId, contactId });
  const messageId = await asUser.mutation(api.messages.append, {
    conversationId,
    senderType: "bot",
    contentType: "text",
    contentText: "Your order shipped!",
    messageId: "wamid.STATUS1",
  });

  const result = await t.mutation(internal.messages.updateDeliveryStatusByWamid, {
    wamid: "wamid.STATUS1",
    status: "delivered",
    accountId,
  });
  expect(result).toEqual({ matched: 1, updated: 1 });

  const message = await t.run((ctx) => ctx.db.get(messageId));
  expect(message!.status).toBe("delivered");
});

test("updateDeliveryStatusByWamid is a safe no-op when no message matches the wamid", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });

  const result = await t.mutation(internal.messages.updateDeliveryStatusByWamid, {
    wamid: "wamid.NEVER_SEEN",
    status: "read",
    accountId,
  });
  expect(result).toEqual({ matched: 0, updated: 0 });
});

test("updateDeliveryStatusByWamid is cross-account safe: when two accounts' messages coincidentally share a wamid, only the caller's own accountId's row is patched", async () => {
  const t = convexTest(schema, modules);
  // supervisor: pool conversations, not about RBAC (see Task 7 tests below).
  const { asUser: asAlice, accountId: aliceAccountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "supervisor",
  });
  const { asUser: asBob, accountId: bobAccountId } = await seedAccountMember(t, {
    name: "Bob",
    email: "bob@example.com",
    role: "supervisor",
  });
  const aliceContactId = await asAlice.mutation(api.contacts.create, { phone: "111" });
  const aliceConversationId = await seedConversation(t, {
    accountId: aliceAccountId,
    contactId: aliceContactId,
  });
  const aliceMessageId = await asAlice.mutation(api.messages.append, {
    conversationId: aliceConversationId,
    senderType: "bot",
    contentType: "text",
    contentText: "Alice's message",
    messageId: "wamid.SHARED",
  });
  const bobContactId = await asBob.mutation(api.contacts.create, { phone: "222" });
  const bobConversationId = await seedConversation(t, {
    accountId: bobAccountId,
    contactId: bobContactId,
  });
  const bobMessageId = await asBob.mutation(api.messages.append, {
    conversationId: bobConversationId,
    senderType: "bot",
    contentType: "text",
    contentText: "Bob's message",
    messageId: "wamid.SHARED",
  });

  const result = await t.mutation(internal.messages.updateDeliveryStatusByWamid, {
    wamid: "wamid.SHARED",
    status: "read",
    accountId: aliceAccountId,
  });
  expect(result).toEqual({ matched: 2, updated: 1 });

  const aliceMessage = await t.run((ctx) => ctx.db.get(aliceMessageId));
  expect(aliceMessage!.status).toBe("read");
  const bobMessage = await t.run((ctx) => ctx.db.get(bobMessageId));
  expect(bobMessage!.status).not.toBe("read");
});

test("updateDeliveryStatusByWamid without accountId updates every matching row (mirrors the source's own account-agnostic sweep)", async () => {
  const t = convexTest(schema, modules);
  // supervisor: pool conversations, not about RBAC (see Task 7 tests below).
  const { asUser: asAlice, accountId: aliceAccountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "supervisor",
  });
  const { asUser: asBob, accountId: bobAccountId } = await seedAccountMember(t, {
    name: "Bob",
    email: "bob@example.com",
    role: "supervisor",
  });
  const aliceContactId = await asAlice.mutation(api.contacts.create, { phone: "111" });
  const aliceConversationId = await seedConversation(t, {
    accountId: aliceAccountId,
    contactId: aliceContactId,
  });
  const aliceMessageId = await asAlice.mutation(api.messages.append, {
    conversationId: aliceConversationId,
    senderType: "bot",
    contentType: "text",
    contentText: "Alice's message",
    messageId: "wamid.SHARED2",
  });
  const bobContactId = await asBob.mutation(api.contacts.create, { phone: "222" });
  const bobConversationId = await seedConversation(t, {
    accountId: bobAccountId,
    contactId: bobContactId,
  });
  const bobMessageId = await asBob.mutation(api.messages.append, {
    conversationId: bobConversationId,
    senderType: "bot",
    contentType: "text",
    contentText: "Bob's message",
    messageId: "wamid.SHARED2",
  });

  const result = await t.mutation(internal.messages.updateDeliveryStatusByWamid, {
    wamid: "wamid.SHARED2",
    status: "failed",
  });
  expect(result).toEqual({ matched: 2, updated: 2 });

  expect((await t.run((ctx) => ctx.db.get(aliceMessageId)))!.status).toBe("failed");
  expect((await t.run((ctx) => ctx.db.get(bobMessageId)))!.status).toBe("failed");
});

// ============================================================
// role-scoped read/send access (Task 7) — `requireConversationAccess`
// (`convex/lib/conversationAccess.ts`) now gates `listByConversation`
// ("view") and `append` ("own"): an agent may READ their own+pool
// conversations but only SEND in one actually assigned to them.
// Mirrors `conversations.test.ts`'s Task 4 tests for the
// conversation-level equivalents. `appendInternal` is untouched (no
// session/role to gate on) and isn't exercised here.
// ============================================================

test("agent can send only in a conversation assigned to them", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountWithOwner(t);
  const a = await seedUserInAccount(t, accountId, { name: "AgentA", email: "a@x.com", role: "agent" });
  const mine = await seedConv(t, accountId, { phone: "111", name: "Mine", assignedToUserId: a.userId });
  const pool = await seedConv(t, accountId, { phone: "222", name: "Pool" });

  await a.asUser.mutation(api.messages.append, {
    conversationId: mine.conversationId,
    senderType: "agent",
    contentType: "text",
    contentText: "hi",
  });
  expect(await t.run((ctx) => ctx.db.query("messages").collect())).toHaveLength(1);

  await expect(
    a.asUser.mutation(api.messages.append, {
      conversationId: pool.conversationId,
      senderType: "agent",
      contentType: "text",
      contentText: "nope",
    }),
  ).rejects.toMatchObject({ data: { code: "NOT_FOUND", entity: "conversation" } });
});

test("agent cannot read messages of another agent's conversation; viewer can read the pool", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountWithOwner(t);
  const a = await seedUserInAccount(t, accountId, { name: "AgentA", email: "a@x.com", role: "agent" });
  const b = await seedUserInAccount(t, accountId, { name: "AgentB", email: "b@x.com", role: "agent" });
  const v = await seedUserInAccount(t, accountId, { name: "Vic", email: "v@x.com", role: "viewer" });
  const theirs = await seedConv(t, accountId, { phone: "111", name: "Bees", assignedToUserId: b.userId });
  const pool = await seedConv(t, accountId, { phone: "222", name: "Pool" });

  await expect(
    a.asUser.query(api.messages.listByConversation, { conversationId: theirs.conversationId, ...onePage }),
  ).rejects.toMatchObject({ data: { code: "NOT_FOUND", entity: "conversation" } });

  const poolMsgs = await v.asUser.query(api.messages.listByConversation, { conversationId: pool.conversationId, ...onePage });
  expect(poolMsgs.page).toEqual([]);
});

// ============================================================
// setMediaKey — attaches a resolved R2 object key to an already-
// persisted message. Second half of inbound-media resolution: ingest
// persists an inbound media message with no key/url (the webhook carries
// only Meta's raw mediaId), then convex/ingest.ts's processInbound
// downloads the bytes via whatsappConfig.resolveInboundMedia (which PUTs
// them to R2) and calls this to attach the resulting key.
//
// R2-migration cutover (this module's Task 7, NOT the role-scoped-access
// "Task 7" this file's other helpers reference): renamed from
// `setMediaUrl`, which took an already-resolved URL and patched
// `mediaUrl`. Its only caller (`convex/ingest.ts`) now has a key, not a
// URL, to give it — `resolveInboundMedia` itself stopped resolving one.
// Readers still fall back to the legacy `mediaUrl` column for
// pre-cutover rows (`convex/lib/r2/url.ts`'s `resolveMediaUrl`, Task 5);
// this mutation itself never writes that column anymore.
// ============================================================

test("setMediaKey attaches a mediaKey to a message that had none", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const contactId = await asUser.mutation(api.contacts.create, { phone: "111" });
  const conversationId = await seedConversation(t, { accountId, contactId });

  // An inbound audio message as ingest first persists it: no mediaKey.
  const messageId = await t.run((ctx) =>
    ctx.db.insert("messages", {
      accountId,
      conversationId,
      senderType: "customer",
      contentType: "audio",
      status: "delivered",
    }),
  );
  expect((await t.run((ctx) => ctx.db.get(messageId)))!.mediaKey).toBeUndefined();

  await t.mutation(internal.messages.setMediaKey, {
    messageId,
    mediaKey: "acct123/inbound/voice-1.ogg",
  });

  expect((await t.run((ctx) => ctx.db.get(messageId)))!.mediaKey).toBe(
    "acct123/inbound/voice-1.ogg",
  );
});

// ============================================================
// setAdReferralImage — attaches the R2 object key of a downloaded ad
// image to the message's OWN `referral`. R2-migration cutover: takes
// `storedImageKey` (not a pre-resolved URL), and — unlike before — no
// longer echoes anything onto `conversation.adReferral`: that field has
// no `storedImageKey` counterpart in the schema (only `messages.referral`
// got one — see the R2-migration design spec's "Schema changes" table),
// and nothing in `src/` ever reads `conversation.adReferral.storedImageUrl`
// (the inbox's ad-lead badge only checks presence/`startedAt`;
// `AdReferralCard`, the one place an ad image actually renders, takes the
// MESSAGE-level referral this mutation still patches). Keeping that
// second write alive would mean re-resolving a URL from the key inside
// this mutation, reintroducing the exact eager R2-config-at-write-time
// dependency this cutover retires, for a field nothing consumes.
// `convex/ingest.test.ts`'s ad-referral tests cover this through the full
// `processInbound` fan-out; this is the direct, narrow unit test for the
// mutation itself.
// ============================================================

test("setAdReferralImage patches the message's referral.storedImageKey and leaves the conversation's adReferral untouched", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const contactId = await asUser.mutation(api.contacts.create, { phone: "111" });
  const conversationId = await seedConversation(t, { accountId, contactId });

  // The conversation already carries a set-once `adReferral` denorm
  // (written by `ingestInbound`, unrelated to this mutation) — asserting
  // it stays byte-for-byte unchanged proves `setAdReferralImage` truly
  // never touches the conversation anymore, not just that it doesn't set
  // `storedImageUrl`.
  await t.run((ctx) =>
    ctx.db.patch(conversationId, {
      adReferral: { headline: "Ad A", startedAt: 1_700_000_000_000 },
    }),
  );
  const messageId = await t.run((ctx) =>
    ctx.db.insert("messages", {
      accountId,
      conversationId,
      senderType: "customer",
      contentType: "text",
      status: "delivered",
      referral: { sourceType: "ad", headline: "Ad A" },
    }),
  );

  await t.mutation(internal.messages.setAdReferralImage, {
    messageId,
    storedImageKey: "acct123/ad/banner-1.jpg",
  });

  const message = await t.run((ctx) => ctx.db.get(messageId));
  expect(message!.referral?.storedImageKey).toBe("acct123/ad/banner-1.jpg");
  expect(message!.referral?.storedImageUrl).toBeUndefined();

  const conversation = await t.run((ctx) => ctx.db.get(conversationId));
  expect(conversation!.adReferral).toEqual({
    headline: "Ad A",
    startedAt: 1_700_000_000_000,
  });
});

test("appendInternal persists replyToMessageId (reply linkage)", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountMember(t, {
    name: "Ann",
    email: "ann@example.com",
    role: "agent",
  });
  const { conversationId } = await seedConv(t, accountId, {
    phone: "15550001111",
    name: "Cust",
  });
  const parentId = await t.run((ctx) =>
    ctx.db.insert("messages", {
      accountId,
      conversationId,
      senderType: "customer",
      contentType: "text",
      contentText: "Any availability?",
      status: "delivered",
    }),
  );

  const replyId = await t.mutation(internal.messages.appendInternal, {
    accountId,
    conversationId,
    senderType: "agent",
    contentType: "text",
    contentText: "Yes!",
    replyToMessageId: parentId,
  });

  const stored = await t.run((ctx) => ctx.db.get(replyId));
  expect(stored!.replyToMessageId).toBe(parentId);
});

// ============================================================
// Hourly rollup is maintained at the message-insert choke point
//
// `insertMessageAndUpdateConversation` is the ONLY `insert("messages")` in
// the backend — every path (inbound ingest, agent send, broadcast
// fan-out) funnels through it — so incrementing here is what makes the
// dashboard chart's rollup complete. A second insert site added later
// without a matching increment would silently undercount the chart, which
// is why these tests assert through the choke point rather than through
// any one caller.
// ============================================================

async function statsRows(t: ReturnType<typeof convexTest>) {
  return await t.run((ctx) => ctx.db.query("messageHourlyStats").collect());
}

async function appendVia(
  t: ReturnType<typeof convexTest>,
  accountId: Id<"accounts">,
  conversationId: Id<"conversations">,
  senderType: "customer" | "agent" | "bot",
) {
  await t.run(async (ctx) => {
    const conversation = await ctx.db.get(conversationId);
    await insertMessageAndUpdateConversation(
      ctx,
      { accountId, conversationId, senderType, contentType: "text", contentText: "hi" },
      conversation!,
    );
  });
}

test("appending a message opens an hourly bucket and counts it by direction", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountMember(t, { name: "A", email: "a@x.com", role: "admin" });
  const contactId = await t.run((ctx) =>
    ctx.db.insert("contacts", { accountId, phone: "+1", phoneNormalized: "1" }),
  );
  const conversationId = await seedConversation(t, { accountId, contactId });

  await appendVia(t, accountId, conversationId, "customer");
  await appendVia(t, accountId, conversationId, "agent");
  await appendVia(t, accountId, conversationId, "bot");

  const rows = await statsRows(t);
  // All three land in the same hour, so one row — the rollup must PATCH an
  // open bucket, not insert a row per message (that would reproduce the
  // unbounded read it exists to avoid).
  expect(rows).toHaveLength(1);
  expect(rows[0]!.accountId).toBe(accountId);
  // Only "customer" is inbound; agent and bot are both outgoing, matching
  // what the chart counted when it read raw messages.
  expect(rows[0]!.incoming).toBe(1);
  expect(rows[0]!.outgoing).toBe(2);
});

test("the hourly bucket is keyed to the containing UTC hour", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountMember(t, { name: "A", email: "a@x.com", role: "admin" });
  const contactId = await t.run((ctx) =>
    ctx.db.insert("contacts", { accountId, phone: "+1", phoneNormalized: "1" }),
  );
  const conversationId = await seedConversation(t, { accountId, contactId });

  await appendVia(t, accountId, conversationId, "customer");

  const rows = await statsRows(t);
  expect(rows[0]!.hourStartMs).toBe(hourStartMs(rows[0]!.hourStartMs));
  expect(rows[0]!.hourStartMs % 3_600_000).toBe(0);
});

test("each account accumulates its own buckets", async () => {
  const t = convexTest(schema, modules);
  const a = await seedAccountMember(t, { name: "A", email: "a@x.com", role: "admin" });
  const b = await seedAccountMember(t, { name: "B", email: "b@x.com", role: "admin" });
  const mk = async (accountId: Id<"accounts">) => {
    const contactId = await t.run((ctx) =>
      ctx.db.insert("contacts", { accountId, phone: "+1", phoneNormalized: "1" }),
    );
    return await seedConversation(t, { accountId, contactId });
  };
  const convA = await mk(a.accountId);
  const convB = await mk(b.accountId);

  await appendVia(t, a.accountId, convA, "customer");
  await appendVia(t, a.accountId, convA, "customer");
  await appendVia(t, b.accountId, convB, "customer");

  const rows = await statsRows(t);
  expect(rows).toHaveLength(2);
  const byAccount = Object.fromEntries(rows.map((r) => [r.accountId, r.incoming]));
  expect(byAccount[a.accountId]).toBe(2);
  expect(byAccount[b.accountId]).toBe(1);
});

// ============================================================
// Backfill
//
// The rollup only starts accumulating at deploy, so without this the
// dashboard chart is empty for everything that happened before. The
// important property beyond "it works" is IDEMPOTENCE: it rebuilds whole
// hours with SET semantics rather than incrementing, so a re-run (or a
// resumed run that overlaps) converges instead of doubling.
// ============================================================

/** Inserts a message the way pre-rollup history exists: raw, with no
 *  hourly bucket behind it. */
async function seedRawMessage(
  t: ReturnType<typeof convexTest>,
  accountId: Id<"accounts">,
  conversationId: Id<"conversations">,
  senderType: "customer" | "agent" | "bot",
) {
  await t.run((ctx) =>
    ctx.db.insert("messages", {
      accountId,
      conversationId,
      senderType,
      contentType: "text",
      contentText: "old",
      status: "sent",
    }),
  );
}

test("backfill rebuilds hourly buckets from pre-existing messages", async () => {
  vi.useFakeTimers();
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountMember(t, { name: "A", email: "a@x.com", role: "admin" });
  const contactId = await t.run((ctx) =>
    ctx.db.insert("contacts", { accountId, phone: "+1", phoneNormalized: "1" }),
  );
  const conversationId = await seedConversation(t, { accountId, contactId });

  await seedRawMessage(t, accountId, conversationId, "customer");
  await seedRawMessage(t, accountId, conversationId, "customer");
  await seedRawMessage(t, accountId, conversationId, "agent");
  expect(await statsRows(t)).toHaveLength(0); // nothing rolled up yet

  await t.mutation(internal.messages.backfillMessageHourlyStats, {});
  await t.finishAllScheduledFunctions(vi.runAllTimers);

  const rows = await statsRows(t);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.incoming).toBe(2);
  expect(rows[0]!.outgoing).toBe(1);
});

test("backfill is idempotent — a second run does not double the counts", async () => {
  vi.useFakeTimers();
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountMember(t, { name: "A", email: "a@x.com", role: "admin" });
  const contactId = await t.run((ctx) =>
    ctx.db.insert("contacts", { accountId, phone: "+1", phoneNormalized: "1" }),
  );
  const conversationId = await seedConversation(t, { accountId, contactId });
  await seedRawMessage(t, accountId, conversationId, "customer");
  await seedRawMessage(t, accountId, conversationId, "agent");

  await t.mutation(internal.messages.backfillMessageHourlyStats, {});
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  const first = await statsRows(t);

  await t.mutation(internal.messages.backfillMessageHourlyStats, {});
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  const second = await statsRows(t);

  expect(second).toHaveLength(first.length);
  expect(second[0]!.incoming).toBe(first[0]!.incoming);
  expect(second[0]!.outgoing).toBe(first[0]!.outgoing);
  expect(second[0]!.incoming).toBe(1);
  expect(second[0]!.outgoing).toBe(1);
});

test("backfill covers every account, not just the first", async () => {
  vi.useFakeTimers();
  const t = convexTest(schema, modules);
  const a = await seedAccountMember(t, { name: "A", email: "a@x.com", role: "admin" });
  const b = await seedAccountMember(t, { name: "B", email: "b@x.com", role: "admin" });
  for (const acc of [a, b]) {
    const contactId = await t.run((ctx) =>
      ctx.db.insert("contacts", { accountId: acc.accountId, phone: "+1", phoneNormalized: "1" }),
    );
    const conversationId = await seedConversation(t, { accountId: acc.accountId, contactId });
    await seedRawMessage(t, acc.accountId, conversationId, "customer");
  }

  await t.mutation(internal.messages.backfillMessageHourlyStats, {});
  await t.finishAllScheduledFunctions(vi.runAllTimers);

  const rows = await statsRows(t);
  expect(rows).toHaveLength(2);
  expect(rows.every((r) => r.incoming === 1)).toBe(true);
});
