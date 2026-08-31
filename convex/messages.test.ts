/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import type { AccountRole } from "./lib/roles";
import { insertMessageAndUpdateConversation, SENDER_TYPE_BACKFILL } from "./messages";
import { hourStartMs, HOUR_MS, DAY_MS, utcDayStartMs } from "./lib/messageStats";
import {
  emptyResponseBuckets,
  emptyPricingCategories,
  RESPONSE_BUCKET_KEYS,
} from "./lib/reportStats";

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
// Reply-latency pairing is maintained at the same choke point
//
// `dashboard.responseTime` used to redo this pairing over raw messages on
// every page load, which is what eventually took /dashboard down ("too many
// system operations"). It now reads the sums these writes accumulate, so
// these assertions ARE the chart's correctness — the query itself no longer
// looks at a message.
//
// Asserted through `insertMessageAndUpdateConversation` rather than any one
// caller, for the same reason as the counts above: it is the only
// `insert("messages")` in the backend.
// ============================================================

async function convDoc(
  t: ReturnType<typeof convexTest>,
  conversationId: Id<"conversations">,
) {
  return (await t.run((ctx) => ctx.db.get(conversationId)))!;
}

/** Seeds an account + contact + conversation and returns the ids. */
async function seedThread(t: ReturnType<typeof convexTest>, email: string) {
  const { accountId } = await seedAccountMember(t, {
    name: "A",
    email,
    role: "admin",
  });
  const contactId = await t.run((ctx) =>
    ctx.db.insert("contacts", { accountId, phone: "+1", phoneNormalized: "1" }),
  );
  const conversationId = await seedConversation(t, { accountId, contactId });
  return { accountId, conversationId };
}

test("a customer message starts the reply clock and an outbound reply records the sample", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const t = convexTest(schema, modules);
    const { accountId, conversationId } = await seedThread(t, "a@x.com");

    const askedAt = Date.parse("2026-07-07T10:00:00.000Z");
    vi.setSystemTime(askedAt);
    await appendVia(t, accountId, conversationId, "customer");

    // The thread is now waiting on us, and says since when.
    expect((await convDoc(t, conversationId)).pendingCustomerAtMs).toBe(askedAt);

    vi.setSystemTime(askedAt + 15 * 60_000);
    await appendVia(t, accountId, conversationId, "agent");

    // Answered: the clock is cleared so the next question starts a fresh one.
    expect(
      (await convDoc(t, conversationId)).pendingCustomerAtMs,
    ).toBeUndefined();

    const rows = await statsRows(t);
    // Bucketed by when the customer ASKED, which is the axis the chart's bars
    // are keyed on — not by when we answered.
    const bucket = rows.find((r) => r.hourStartMs === hourStartMs(askedAt))!;
    expect(bucket.responseCount).toBe(1);
    expect(bucket.responseTotalMs).toBe(15 * 60_000);
  } finally {
    vi.useRealTimers();
  }
});

test("a customer who messages repeatedly is one sample, timed from their first message", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const t = convexTest(schema, modules);
    const { accountId, conversationId } = await seedThread(t, "b@x.com");

    const askedAt = Date.parse("2026-07-07T10:00:00.000Z");
    vi.setSystemTime(askedAt);
    await appendVia(t, accountId, conversationId, "customer");
    // Two more nudges while we are still typing. Neither may restart the
    // clock, or a chatty customer would flatter our average.
    vi.setSystemTime(askedAt + 5 * 60_000);
    await appendVia(t, accountId, conversationId, "customer");
    vi.setSystemTime(askedAt + 9 * 60_000);
    await appendVia(t, accountId, conversationId, "customer");

    expect((await convDoc(t, conversationId)).pendingCustomerAtMs).toBe(askedAt);

    vi.setSystemTime(askedAt + 20 * 60_000);
    await appendVia(t, accountId, conversationId, "agent");

    const bucket = (await statsRows(t)).find(
      (r) => r.hourStartMs === hourStartMs(askedAt),
    )!;
    expect(bucket.responseCount).toBe(1);
    expect(bucket.responseTotalMs).toBe(20 * 60_000);
  } finally {
    vi.useRealTimers();
  }
});

test("consecutive outbound messages record only the first as a reply, and a bot reply counts like an agent's", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const t = convexTest(schema, modules);
    const { accountId, conversationId } = await seedThread(t, "c@x.com");

    const askedAt = Date.parse("2026-07-07T10:00:00.000Z");
    vi.setSystemTime(askedAt);
    await appendVia(t, accountId, conversationId, "customer");

    // The AI answers first — that is a reply to the customer, exactly as the
    // per-message implementation counted it.
    vi.setSystemTime(askedAt + 2 * 60_000);
    await appendVia(t, accountId, conversationId, "bot");
    // Follow-ups with nothing pending must not invent samples.
    vi.setSystemTime(askedAt + 30 * 60_000);
    await appendVia(t, accountId, conversationId, "agent");
    vi.setSystemTime(askedAt + 45 * 60_000);
    await appendVia(t, accountId, conversationId, "agent");

    const rows = await statsRows(t);
    const totalSamples = rows.reduce((n, r) => n + (r.responseCount ?? 0), 0);
    expect(totalSamples).toBe(1);
    const bucket = rows.find((r) => r.hourStartMs === hourStartMs(askedAt))!;
    expect(bucket.responseTotalMs).toBe(2 * 60_000);
  } finally {
    vi.useRealTimers();
  }
});

test("a reply lands on the hour the customer asked in, even when that hour is long past", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const t = convexTest(schema, modules);
    const { accountId, conversationId } = await seedThread(t, "d@x.com");

    // Asked late Friday, answered Monday morning — the sample belongs to
    // Friday's bar, so the write has to reach back to that bucket.
    const askedAt = Date.parse("2026-07-03T18:30:00.000Z");
    vi.setSystemTime(askedAt);
    await appendVia(t, accountId, conversationId, "customer");

    const repliedAt = Date.parse("2026-07-06T09:00:00.000Z");
    vi.setSystemTime(repliedAt);
    await appendVia(t, accountId, conversationId, "agent");

    const rows = await statsRows(t);
    const askedBucket = rows.find(
      (r) => r.hourStartMs === hourStartMs(askedAt),
    )!;
    expect(askedBucket.responseCount).toBe(1);
    expect(askedBucket.responseTotalMs).toBe(repliedAt - askedAt);

    // Monday's bucket counted the outgoing message but owns no sample.
    const repliedBucket = rows.find(
      (r) => r.hourStartMs === hourStartMs(repliedAt),
    )!;
    expect(repliedBucket.outgoing).toBe(1);
    expect(repliedBucket.responseCount ?? 0).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

test("an outbound message on a thread nobody is waiting on records no sample", async () => {
  const t = convexTest(schema, modules);
  const { accountId, conversationId } = await seedThread(t, "e@x.com");

  // Cold outreach: we speak first. There is no question to have answered.
  await appendVia(t, accountId, conversationId, "agent");
  await appendVia(t, accountId, conversationId, "bot");

  const rows = await statsRows(t);
  expect(rows.reduce((n, r) => n + (r.responseCount ?? 0), 0)).toBe(0);
  expect((await convDoc(t, conversationId)).pendingCustomerAtMs).toBeUndefined();
});

test("each conversation keeps its own reply clock", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const t = convexTest(schema, modules);
    const { accountId, conversationId: convA } = await seedThread(t, "f@x.com");
    const contactB = await t.run((ctx) =>
      ctx.db.insert("contacts", {
        accountId,
        phone: "+2",
        phoneNormalized: "2",
      }),
    );
    const convB = await seedConversation(t, { accountId, contactId: contactB });

    const askedAt = Date.parse("2026-07-07T10:00:00.000Z");
    vi.setSystemTime(askedAt);
    await appendVia(t, accountId, convA, "customer");
    await appendVia(t, accountId, convB, "customer");

    // Answering A must not clear B's clock, nor credit B with a reply.
    vi.setSystemTime(askedAt + 10 * 60_000);
    await appendVia(t, accountId, convA, "agent");

    expect((await convDoc(t, convA)).pendingCustomerAtMs).toBeUndefined();
    expect((await convDoc(t, convB)).pendingCustomerAtMs).toBe(askedAt);

    const bucket = (await statsRows(t)).find(
      (r) => r.hourStartMs === hourStartMs(askedAt),
    )!;
    expect(bucket.responseCount).toBe(1);
    expect(bucket.responseTotalMs).toBe(10 * 60_000);
  } finally {
    vi.useRealTimers();
  }
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

// ============================================================
// applyStatusPricing — Meta pricing + conversation-window capture
// ============================================================

/** One outbound message carrying a known wamid, so the `by_message_id`
 *  lookup inside `applyStatusPricing` has a row to match. */
async function seedMessageWithWamid(
  t: ReturnType<typeof convexTest>,
  accountId: Id<"accounts">,
  conversationId: Id<"conversations">,
  wamid: string,
) {
  return await t.run((ctx) =>
    ctx.db.insert("messages", {
      accountId,
      conversationId,
      senderType: "agent",
      contentType: "text",
      contentText: "hello",
      messageId: wamid,
      status: "sent",
    }),
  );
}

test("applyStatusPricing: stores per-message pricing and the conversation window", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountMember(t, {
    name: "A",
    email: "a@x.com",
    role: "admin",
  });
  const { conversationId } = await seedConv(t, accountId, {
    phone: "+15551230000",
    name: "Lead",
  });
  const messageId = await seedMessageWithWamid(
    t,
    accountId,
    conversationId,
    "wamid.P1",
  );

  await t.mutation(internal.messages.applyStatusPricing, {
    wamid: "wamid.P1",
    accountId,
    pricing: {
      conversationMetaId: "CONV1",
      expiresAt: 1753560000000,
      originType: "referral_conversion",
      pricingModel: "CBP",
      pricingCategory: "referral_conversion",
      billable: false,
      isFreeEntryPoint: true,
    },
  });

  const { message, conversation } = await t.run(async (ctx) => ({
    message: await ctx.db.get(messageId),
    conversation: await ctx.db.get(conversationId),
  }));

  expect(message?.pricing?.billable).toBe(false);
  expect(message?.pricing?.model).toBe("CBP");
  expect(message?.pricing?.category).toBe("referral_conversion");
  expect(conversation?.metaWindow?.isFreeEntryPoint).toBe(true);
  expect(conversation?.metaWindow?.expiresAt).toBe(1753560000000);
  expect(conversation?.metaWindow?.conversationMetaId).toBe("CONV1");
});

test("applyStatusPricing: a later expiry advances the window", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountMember(t, {
    name: "A",
    email: "a@x.com",
    role: "admin",
  });
  const { conversationId } = await seedConv(t, accountId, {
    phone: "+15551230000",
    name: "Lead",
  });
  await seedMessageWithWamid(t, accountId, conversationId, "wamid.P2");

  const base = {
    conversationMetaId: "CONV1",
    originType: "referral_conversion",
    isFreeEntryPoint: true,
  };
  await t.mutation(internal.messages.applyStatusPricing, {
    wamid: "wamid.P2",
    accountId,
    pricing: { ...base, expiresAt: 1000 },
  });
  await t.mutation(internal.messages.applyStatusPricing, {
    wamid: "wamid.P2",
    accountId,
    pricing: { ...base, expiresAt: 5000 },
  });

  const conversation = await t.run((ctx) => ctx.db.get(conversationId));
  expect(conversation?.metaWindow?.expiresAt).toBe(5000);
});

test("applyStatusPricing: an out-of-order older expiry does NOT shrink the window", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountMember(t, {
    name: "A",
    email: "a@x.com",
    role: "admin",
  });
  const { conversationId } = await seedConv(t, accountId, {
    phone: "+15551230000",
    name: "Lead",
  });
  await seedMessageWithWamid(t, accountId, conversationId, "wamid.P3");

  const base = {
    conversationMetaId: "CONV1",
    originType: "referral_conversion",
    isFreeEntryPoint: true,
  };
  await t.mutation(internal.messages.applyStatusPricing, {
    wamid: "wamid.P3",
    accountId,
    pricing: { ...base, expiresAt: 5000 },
  });
  await t.mutation(internal.messages.applyStatusPricing, {
    wamid: "wamid.P3",
    accountId,
    pricing: { ...base, expiresAt: 1000 },
  });

  const conversation = await t.run((ctx) => ctx.db.get(conversationId));
  expect(conversation?.metaWindow?.expiresAt).toBe(5000);
});

test("applyStatusPricing: a different conversation id replaces the window even if earlier", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountMember(t, {
    name: "A",
    email: "a@x.com",
    role: "admin",
  });
  const { conversationId } = await seedConv(t, accountId, {
    phone: "+15551230000",
    name: "Lead",
  });
  await seedMessageWithWamid(t, accountId, conversationId, "wamid.P4");

  await t.mutation(internal.messages.applyStatusPricing, {
    wamid: "wamid.P4",
    accountId,
    pricing: {
      conversationMetaId: "CONV_OLD",
      expiresAt: 5000,
      isFreeEntryPoint: true,
    },
  });
  await t.mutation(internal.messages.applyStatusPricing, {
    wamid: "wamid.P4",
    accountId,
    pricing: {
      conversationMetaId: "CONV_NEW",
      expiresAt: 1000,
      isFreeEntryPoint: false,
    },
  });

  const conversation = await t.run((ctx) => ctx.db.get(conversationId));
  expect(conversation?.metaWindow?.conversationMetaId).toBe("CONV_NEW");
  expect(conversation?.metaWindow?.expiresAt).toBe(1000);
});

test("applyStatusPricing: an unknown wamid is a silent no-op", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountMember(t, {
    name: "A",
    email: "a@x.com",
    role: "admin",
  });
  const res = await t.mutation(internal.messages.applyStatusPricing, {
    wamid: "wamid.DOES_NOT_EXIST",
    accountId,
    pricing: { isFreeEntryPoint: false },
  });
  expect(res.matched).toBe(0);
});

test("applyStatusPricing: a later callback omitting the free-entry-point signal must not flip the window to billable", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountMember(t, {
    name: "A",
    email: "a@x.com",
    role: "admin",
  });
  const { conversationId } = await seedConv(t, accountId, {
    phone: "+15551230000",
    name: "Lead",
  });
  await seedMessageWithWamid(t, accountId, conversationId, "wamid.P5");

  // Callback A (`sent`): PMP pricing declares a free entry point, no conversation object.
  await t.mutation(internal.messages.applyStatusPricing, {
    wamid: "wamid.P5",
    accountId,
    pricing: { pricingType: "free_entry_point", isFreeEntryPoint: true },
  });

  // Callback B (`delivered`): conversation object with an expiry, no pricing —
  // the parser reports isFreeEntryPoint:false because neither signal is in THIS payload.
  await t.mutation(internal.messages.applyStatusPricing, {
    wamid: "wamid.P5",
    accountId,
    pricing: {
      conversationMetaId: "CONV1",
      expiresAt: 5000,
      isFreeEntryPoint: false,
    },
  });

  const conversation = await t.run((ctx) => ctx.db.get(conversationId));
  expect(conversation?.metaWindow?.isFreeEntryPoint).toBe(true);
  expect(conversation?.metaWindow?.expiresAt).toBe(5000);
  expect(conversation?.metaWindow?.conversationMetaId).toBe("CONV1");
});

test("applyStatusPricing: a conversation-only callback preserves previously captured message pricing", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountMember(t, {
    name: "A",
    email: "a@x.com",
    role: "admin",
  });
  const { conversationId } = await seedConv(t, accountId, {
    phone: "+15551230000",
    name: "Lead",
  });
  const messageId = await seedMessageWithWamid(
    t,
    accountId,
    conversationId,
    "wamid.P6",
  );

  await t.mutation(internal.messages.applyStatusPricing, {
    wamid: "wamid.P6",
    accountId,
    pricing: {
      billable: true,
      pricingModel: "PMP",
      pricingCategory: "marketing",
      pricingType: "regular",
      isFreeEntryPoint: false,
    },
  });
  await t.mutation(internal.messages.applyStatusPricing, {
    wamid: "wamid.P6",
    accountId,
    pricing: {
      conversationMetaId: "CONV1",
      expiresAt: 5000,
      isFreeEntryPoint: false,
    },
  });

  const message = await t.run((ctx) => ctx.db.get(messageId));
  expect(message?.pricing?.billable).toBe(true);
  expect(message?.pricing?.category).toBe("marketing");
  expect(message?.pricing?.type).toBe("regular");
});

test("applyStatusPricing: a different conversation id resets the free-entry-point flag", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountMember(t, {
    name: "A",
    email: "a@x.com",
    role: "admin",
  });
  const { conversationId } = await seedConv(t, accountId, {
    phone: "+15551230000",
    name: "Lead",
  });
  await seedMessageWithWamid(t, accountId, conversationId, "wamid.P7");

  await t.mutation(internal.messages.applyStatusPricing, {
    wamid: "wamid.P7",
    accountId,
    pricing: {
      conversationMetaId: "CONV_OLD",
      expiresAt: 5000,
      originType: "referral_conversion",
      isFreeEntryPoint: true,
    },
  });
  await t.mutation(internal.messages.applyStatusPricing, {
    wamid: "wamid.P7",
    accountId,
    pricing: {
      conversationMetaId: "CONV_NEW",
      expiresAt: 1000,
      originType: "user_initiated",
      isFreeEntryPoint: false,
    },
  });

  const conversation = await t.run((ctx) => ctx.db.get(conversationId));
  expect(conversation?.metaWindow?.isFreeEntryPoint).toBe(false);
  expect(conversation?.metaWindow?.originType).toBe("user_initiated");
  expect(conversation?.metaWindow?.expiresAt).toBe(1000);
});

test("applyStatusPricing: an out-of-order callback with the SAME expiry still records a newly-seen free-entry-point signal", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountMember(t, { name: "A", email: "a@x.com", role: "admin" });
  const { conversationId } = await seedConv(t, accountId, { phone: "+15551230000", name: "Lead" });
  await seedMessageWithWamid(t, accountId, conversationId, "wamid.P8");

  // `delivered` lands first: same conversation, same expiry, no FEP signal.
  await t.mutation(internal.messages.applyStatusPricing, {
    wamid: "wamid.P8",
    accountId,
    pricing: { conversationMetaId: "C1", expiresAt: 9000, isFreeEntryPoint: false },
  });
  // The `sent` that actually OPENED the free entry point lands second,
  // carrying the same expiry. Its signal must not be discarded.
  await t.mutation(internal.messages.applyStatusPricing, {
    wamid: "wamid.P8",
    accountId,
    pricing: {
      conversationMetaId: "C1",
      expiresAt: 9000,
      originType: "referral_conversion",
      isFreeEntryPoint: true,
    },
  });

  const conversation = await t.run((ctx) => ctx.db.get(conversationId));
  expect(conversation?.metaWindow?.isFreeEntryPoint).toBe(true);
  expect(conversation?.metaWindow?.originType).toBe("referral_conversion");
  expect(conversation?.metaWindow?.expiresAt).toBe(9000);
});

test("applyStatusPricing: a stale free-entry-point latch does not leak into a later billed conversation", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountMember(t, { name: "A", email: "a@x.com", role: "admin" });
  const { conversationId } = await seedConv(t, accountId, { phone: "+15551230000", name: "Lead" });
  await seedMessageWithWamid(t, accountId, conversationId, "wamid.P9");

  // A pricing-only free-entry-point callback: leaves conversationMetaId unset.
  await t.mutation(internal.messages.applyStatusPricing, {
    wamid: "wamid.P9",
    accountId,
    pricing: { pricingType: "free_entry_point", isFreeEntryPoint: true },
  });

  // Age that record beyond one full FEP window. Both `fepObservedAt` and
  // `updatedAt` must be aged together: in real data `updatedAt` is
  // rewritten on every write — including the one that stamps
  // `fepObservedAt` — so `updatedAt >= fepObservedAt` always holds. Aging
  // only `updatedAt` would leave `fepObservedAt` fresh, an incoherent
  // state that cannot occur in production and that the latch correctly
  // treats as still-live.
  await t.run(async (ctx) => {
    const c = await ctx.db.get(conversationId);
    await ctx.db.patch(conversationId, {
      metaWindow: {
        ...c!.metaWindow!,
        fepObservedAt: Date.now() - 4 * 24 * 60 * 60 * 1000,
        updatedAt: Date.now() - 4 * 24 * 60 * 60 * 1000,
      },
    });
  });

  // A later, genuinely billed conversation must NOT inherit the stale flag.
  await t.mutation(internal.messages.applyStatusPricing, {
    wamid: "wamid.P9",
    accountId,
    pricing: {
      conversationMetaId: "C_BILLED",
      expiresAt: Date.now() + 60_000,
      originType: "marketing",
      isFreeEntryPoint: false,
    },
  });

  const conversation = await t.run((ctx) => ctx.db.get(conversationId));
  expect(conversation?.metaWindow?.isFreeEntryPoint).toBe(false);
  expect(conversation?.metaWindow?.originType).toBe("marketing");
});

test("applyStatusPricing: a callback carrying no window facts leaves the window untouched", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountMember(t, { name: "A", email: "a@x.com", role: "admin" });
  const { conversationId } = await seedConv(t, accountId, { phone: "+15551230000", name: "Lead" });
  await seedMessageWithWamid(t, accountId, conversationId, "wamid.P10");

  await t.mutation(internal.messages.applyStatusPricing, {
    wamid: "wamid.P10",
    accountId,
    pricing: {
      conversationMetaId: "C1",
      expiresAt: 5000,
      originType: "referral_conversion",
      isFreeEntryPoint: true,
    },
  });
  // Pricing-only, no window facts at all.
  await t.mutation(internal.messages.applyStatusPricing, {
    wamid: "wamid.P10",
    accountId,
    pricing: { billable: true, pricingCategory: "marketing", isFreeEntryPoint: false },
  });

  const conversation = await t.run((ctx) => ctx.db.get(conversationId));
  expect(conversation?.metaWindow?.conversationMetaId).toBe("C1");
  expect(conversation?.metaWindow?.expiresAt).toBe(5000);
  expect(conversation?.metaWindow?.isFreeEntryPoint).toBe(true);
});

test("applyStatusPricing: a different conversation id REPLACES rather than inherits omitted fields", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountMember(t, { name: "A", email: "a@x.com", role: "admin" });
  const { conversationId } = await seedConv(t, accountId, { phone: "+15551230000", name: "Lead" });
  await seedMessageWithWamid(t, accountId, conversationId, "wamid.P11");

  await t.mutation(internal.messages.applyStatusPricing, {
    wamid: "wamid.P11",
    accountId,
    pricing: {
      conversationMetaId: "C_OLD",
      expiresAt: 5000,
      originType: "referral_conversion",
      isFreeEntryPoint: true,
    },
  });
  // New conversation id, omitting originType — it must NOT be inherited.
  await t.mutation(internal.messages.applyStatusPricing, {
    wamid: "wamid.P11",
    accountId,
    pricing: { conversationMetaId: "C_NEW", expiresAt: 1000, isFreeEntryPoint: false },
  });

  const conversation = await t.run((ctx) => ctx.db.get(conversationId));
  expect(conversation?.metaWindow?.originType).toBeUndefined();
  expect(conversation?.metaWindow?.expiresAt).toBe(1000);
  expect(conversation?.metaWindow?.isFreeEntryPoint).toBe(false);
});

test("applyStatusPricing: same conversation inherits an omitted originType", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountMember(t, { name: "A", email: "a@x.com", role: "admin" });
  const { conversationId } = await seedConv(t, accountId, { phone: "+15551230000", name: "Lead" });
  await seedMessageWithWamid(t, accountId, conversationId, "wamid.P12");

  // Real future epoch-ms timestamps, not small notional placeholders: the
  // latch now refuses to hold when `prev.expiresAt` is already in the past
  // (see `latchStillLive` in messages.ts), so this fixture must describe a
  // window that is genuinely still open relative to wall-clock `now`.
  const early = Date.now() + 60_000;
  const later = Date.now() + 120_000;

  await t.mutation(internal.messages.applyStatusPricing, {
    wamid: "wamid.P12",
    accountId,
    pricing: {
      conversationMetaId: "C1",
      expiresAt: early,
      originType: "referral_conversion",
      isFreeEntryPoint: true,
    },
  });
  // Same conversation, later expiry, originType omitted.
  await t.mutation(internal.messages.applyStatusPricing, {
    wamid: "wamid.P12",
    accountId,
    pricing: { conversationMetaId: "C1", expiresAt: later, isFreeEntryPoint: false },
  });

  const conversation = await t.run((ctx) => ctx.db.get(conversationId));
  expect(conversation?.metaWindow?.originType).toBe("referral_conversion");
  expect(conversation?.metaWindow?.expiresAt).toBe(later);
  expect(conversation?.metaWindow?.isFreeEntryPoint).toBe(true);
});

// ============================================================
// applyStatusError — Meta delivery-failure reason capture
// ============================================================

test("applyStatusError: stores the captured error on the message", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountMember(t, {
    name: "A",
    email: "a@x.com",
    role: "admin",
  });
  const { conversationId } = await seedConv(t, accountId, {
    phone: "+15551230000",
    name: "Lead",
  });
  const messageId = await seedMessageWithWamid(
    t,
    accountId,
    conversationId,
    "wamid.E1",
  );

  await t.mutation(internal.messages.applyStatusError, {
    wamid: "wamid.E1",
    accountId,
    error: {
      code: 131049,
      title:
        "This message was not delivered to maintain healthy ecosystem engagement.",
      message: "Message failed to send because of an error.",
      details: "rate limit heuristic",
    },
  });

  const message = await t.run((ctx) => ctx.db.get(messageId));
  expect(message?.deliveryError?.code).toBe(131049);
  expect(message?.deliveryError?.title).toBe(
    "This message was not delivered to maintain healthy ecosystem engagement.",
  );
  expect(message?.deliveryError?.message).toBe(
    "Message failed to send because of an error.",
  );
  expect(message?.deliveryError?.details).toBe("rate limit heuristic");
});

test("applyStatusError: a later, partially-populated callback preserves previously captured fields", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountMember(t, {
    name: "A",
    email: "a@x.com",
    role: "admin",
  });
  const { conversationId } = await seedConv(t, accountId, {
    phone: "+15551230000",
    name: "Lead",
  });
  const messageId = await seedMessageWithWamid(
    t,
    accountId,
    conversationId,
    "wamid.E2",
  );

  // First callback: the full shape Meta sends.
  await t.mutation(internal.messages.applyStatusError, {
    wamid: "wamid.E2",
    accountId,
    error: {
      code: 131049,
      title:
        "This message was not delivered to maintain healthy ecosystem engagement.",
      message: "Message failed to send because of an error.",
      details: "rate limit heuristic",
    },
  });

  // Second callback: Meta redelivers the same webhook with only `code`
  // present — ordinary traffic, not a contrived case (this mutation's own
  // doc comment already notes `message`/`error_data.details` are
  // "frequently absent"). Must not blank the fields the first callback
  // already captured.
  await t.mutation(internal.messages.applyStatusError, {
    wamid: "wamid.E2",
    accountId,
    error: { code: 131049 },
  });

  const message = await t.run((ctx) => ctx.db.get(messageId));
  expect(message?.deliveryError?.code).toBe(131049);
  expect(message?.deliveryError?.title).toBe(
    "This message was not delivered to maintain healthy ecosystem engagement.",
  );
  expect(message?.deliveryError?.message).toBe(
    "Message failed to send because of an error.",
  );
  expect(message?.deliveryError?.details).toBe("rate limit heuristic");
});

test("applyStatusError: a callback with no error facts at all is a no-op", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountMember(t, {
    name: "A",
    email: "a@x.com",
    role: "admin",
  });
  const { conversationId } = await seedConv(t, accountId, {
    phone: "+15551230000",
    name: "Lead",
  });
  const messageId = await seedMessageWithWamid(
    t,
    accountId,
    conversationId,
    "wamid.E3",
  );

  await t.mutation(internal.messages.applyStatusError, {
    wamid: "wamid.E3",
    accountId,
    error: { code: 131049, title: "original title" },
  });

  const res = await t.mutation(internal.messages.applyStatusError, {
    wamid: "wamid.E3",
    accountId,
    error: {},
  });

  expect(res.updated).toBe(0);
  const message = await t.run((ctx) => ctx.db.get(messageId));
  expect(message?.deliveryError?.title).toBe("original title");
});

// ============================================================
// lastInboundAt / firstReplyAt maintenance
// ============================================================

/** A fresh account + conversation, seeded the way the rest of this
 *  suite does it. */
async function seedWindowConv(t: ReturnType<typeof convexTest>) {
  const { accountId } = await seedAccountMember(t, {
    name: "A",
    email: "a@x.com",
    role: "admin",
  });
  const { conversationId } = await seedConv(t, accountId, {
    phone: "+15551230000",
    name: "Lead",
  });
  return { accountId, conversationId };
}

test("insertMessageAndUpdateConversation: an inbound customer message sets lastInboundAt", async () => {
  const t = convexTest(schema, modules);
  const { accountId, conversationId } = await seedWindowConv(t);

  const before = Date.now();
  await appendVia(t, accountId, conversationId, "customer");

  const conversation = await t.run((ctx) => ctx.db.get(conversationId));
  expect(conversation?.lastInboundAt).toBeGreaterThanOrEqual(before);
});

test("insertMessageAndUpdateConversation: an outbound message does NOT set lastInboundAt", async () => {
  const t = convexTest(schema, modules);
  const { accountId, conversationId } = await seedWindowConv(t);

  await appendVia(t, accountId, conversationId, "agent");

  const conversation = await t.run((ctx) => ctx.db.get(conversationId));
  expect(conversation?.lastInboundAt).toBeUndefined();
});

test("insertMessageAndUpdateConversation: first outbound on an ad conversation sets firstReplyAt once", async () => {
  const t = convexTest(schema, modules);
  const { accountId, conversationId } = await seedWindowConv(t);
  await t.run((ctx) =>
    ctx.db.patch(conversationId, { adReferral: { startedAt: 1_000 } }),
  );

  await appendVia(t, accountId, conversationId, "agent");
  const afterFirst = await t.run((ctx) => ctx.db.get(conversationId));
  const firstReplyAt = afterFirst?.firstReplyAt;
  expect(firstReplyAt).toBeGreaterThan(0);

  await appendVia(t, accountId, conversationId, "agent");
  const afterSecond = await t.run((ctx) => ctx.db.get(conversationId));
  expect(afterSecond?.firstReplyAt).toBe(firstReplyAt);
});

test("insertMessageAndUpdateConversation: no adReferral means no firstReplyAt", async () => {
  const t = convexTest(schema, modules);
  const { accountId, conversationId } = await seedWindowConv(t);

  await appendVia(t, accountId, conversationId, "agent");

  const conversation = await t.run((ctx) => ctx.db.get(conversationId));
  expect(conversation?.firstReplyAt).toBeUndefined();
});

test("applyStatusPricing: the free-entry-point latch ages against the signal, not the record's last touch", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountMember(t, { name: "A", email: "a@x.com", role: "admin" });
  const { conversationId } = await seedConv(t, accountId, { phone: "+15551230000", name: "Lead" });
  await seedMessageWithWamid(t, accountId, conversationId, "wamid.P13");

  // A pricing-only free-entry-point callback (leaves conversationMetaId unset).
  await t.mutation(internal.messages.applyStatusPricing, {
    wamid: "wamid.P13",
    accountId,
    pricing: { pricingType: "free_entry_point", isFreeEntryPoint: true },
  });

  // Age the SIGNAL beyond one window while leaving `updatedAt` fresh —
  // exactly what a stream of unrelated callbacks would do.
  await t.run(async (ctx) => {
    const c = await ctx.db.get(conversationId);
    await ctx.db.patch(conversationId, {
      metaWindow: {
        ...c!.metaWindow!,
        fepObservedAt: Date.now() - 80 * 60 * 60 * 1000,
        updatedAt: Date.now(),
      },
    });
  });

  // A genuinely billed conversation must NOT inherit the stale flag.
  await t.mutation(internal.messages.applyStatusPricing, {
    wamid: "wamid.P13",
    accountId,
    pricing: {
      conversationMetaId: "C_BILLED",
      expiresAt: Date.now() + 60_000,
      originType: "marketing",
      isFreeEntryPoint: false,
    },
  });

  const conversation = await t.run((ctx) => ctx.db.get(conversationId));
  expect(conversation?.metaWindow?.isFreeEntryPoint).toBe(false);
  expect(conversation?.metaWindow?.originType).toBe("marketing");
});

test("applyStatusPricing: a latch whose stored window has demonstrably expired does not hold", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountMember(t, { name: "A", email: "a@x.com", role: "admin" });
  const { conversationId } = await seedConv(t, accountId, { phone: "+15551230000", name: "Lead" });
  await seedMessageWithWamid(t, accountId, conversationId, "wamid.P14");

  // FEP observed, but its window expiry is already in the past.
  await t.mutation(internal.messages.applyStatusPricing, {
    wamid: "wamid.P14",
    accountId,
    pricing: {
      pricingType: "free_entry_point",
      expiresAt: Date.now() - 1000,
      isFreeEntryPoint: true,
    },
  });

  await t.mutation(internal.messages.applyStatusPricing, {
    wamid: "wamid.P14",
    accountId,
    pricing: {
      conversationMetaId: "C_BILLED",
      expiresAt: Date.now() + 60_000,
      originType: "marketing",
      isFreeEntryPoint: false,
    },
  });

  const conversation = await t.run((ctx) => ctx.db.get(conversationId));
  expect(conversation?.metaWindow?.isFreeEntryPoint).toBe(false);
});

test("applyStatusPricing: a live free-entry-point latch still holds within the window", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountMember(t, { name: "A", email: "a@x.com", role: "admin" });
  const { conversationId } = await seedConv(t, accountId, { phone: "+15551230000", name: "Lead" });
  await seedMessageWithWamid(t, accountId, conversationId, "wamid.P15");

  await t.mutation(internal.messages.applyStatusPricing, {
    wamid: "wamid.P15",
    accountId,
    pricing: {
      conversationMetaId: "C1",
      expiresAt: Date.now() + 60 * 60 * 1000,
      originType: "referral_conversion",
      isFreeEntryPoint: true,
    },
  });
  // Same conversation, moments later, no FEP signal in this payload.
  await t.mutation(internal.messages.applyStatusPricing, {
    wamid: "wamid.P15",
    accountId,
    pricing: { conversationMetaId: "C1", expiresAt: Date.now() + 61 * 60 * 1000, isFreeEntryPoint: false },
  });

  const conversation = await t.run((ctx) => ctx.db.get(conversationId));
  expect(conversation?.metaWindow?.isFreeEntryPoint).toBe(true);
});

// ============================================================
// Lead Analysis follow-up sequence — arm on outbound (P3 Task 6).
// `insertMessageAndUpdateConversation` is the single `insert("messages")`
// in the backend (this file's own comment on that function), so it is
// the choke point both `append` and `appendInternal` share — proving
// the wiring through EITHER entry point is enough to prove it lives in
// the shared core, not duplicated per caller.
// ============================================================

test("an outbound message arms a scored lead's follow-up sequence", async () => {
  const t = convexTest(schema, modules);
  const { defaultLeadAnalysisConfig } = await import("./lib/leadAnalysis/defaults");
  const { defaultQualificationConfig } = await import("./lib/qualification/defaults");
  const { firstTouchAt } = await import("./lib/leadAnalysis/sequenceSchedule");

  const { asUser, accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "supervisor", // pool conversation (unassigned); not testing RBAC here
  });
  await t.run((ctx) =>
    ctx.db.insert("leadAnalysisConfigs", {
      ...defaultLeadAnalysisConfig(), accountId, enabled: true,
    }),
  );
  await t.run((ctx) =>
    ctx.db.insert("qualificationConfigs", {
      accountId,
      ...defaultQualificationConfig(),
      enabled: true,
      utcOffsetMinutes: 0,
      workStartMinute: 0,
      workEndMinute: 1440,
      workDays: [0, 1, 2, 3, 4, 5, 6],
    }),
  );

  const contactId = await t.run((ctx) =>
    ctx.db.insert("contacts", { accountId, phone: "+111", phoneNormalized: "111" }),
  );
  const lastCustomerMessageAt = Date.now() - 10 * 24 * 60 * 60_000;
  const conversationId = await t.run((ctx) =>
    ctx.db.insert("conversations", {
      accountId,
      contactId,
      status: "open",
      unreadCount: 0,
      assignedToUserId: undefined,
      lastInboundAt: lastCustomerMessageAt,
    }),
  );
  const analysisId = await t.run((ctx) =>
    ctx.db.insert("leadAnalyses", {
      accountId,
      conversationId,
      contactId,
      score: 9,
      band: "hot",
      scoreStatus: "scored",
      attempts: 0,
      sequenceStatus: "idle",
      followUpsSent: 0,
    }),
  );

  await asUser.mutation(api.messages.append, {
    conversationId,
    senderType: "agent",
    contentType: "text",
    contentText: "Following up on your enquiry!",
  });

  const row = await t.run((ctx) => ctx.db.get(analysisId));
  expect(row!.sequenceStatus).toBe("running");
  expect(row!.followUpsSent).toBe(0);
  expect(row!.nextFollowUpAt).toBe(
    firstTouchAt({
      lastCustomerMessageAt,
      idleDaysBeforeSequence: 3,
      step0DelayDays: 2, // hot band's steps[0]
      config: { utcOffsetMinutes: 0, workStartMinute: 0, workEndMinute: 1440, workDays: [0, 1, 2, 3, 4, 5, 6] },
    }),
  );
});

test("a customer (inbound) message never arms the follow-up sequence", async () => {
  const t = convexTest(schema, modules);
  const { defaultLeadAnalysisConfig } = await import("./lib/leadAnalysis/defaults");
  const { defaultQualificationConfig } = await import("./lib/qualification/defaults");

  const { asUser, accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "supervisor", // pool conversation (unassigned); not testing RBAC here
  });
  await t.run((ctx) =>
    ctx.db.insert("leadAnalysisConfigs", {
      ...defaultLeadAnalysisConfig(), accountId, enabled: true,
    }),
  );
  await t.run((ctx) =>
    ctx.db.insert("qualificationConfigs", {
      accountId,
      ...defaultQualificationConfig(),
      enabled: true,
      workDays: [0, 1, 2, 3, 4, 5, 6],
      workStartMinute: 0,
      workEndMinute: 1440,
    }),
  );
  const contactId = await t.run((ctx) =>
    ctx.db.insert("contacts", { accountId, phone: "+111", phoneNormalized: "111" }),
  );
  const conversationId = await t.run((ctx) =>
    ctx.db.insert("conversations", {
      accountId, contactId, status: "open", unreadCount: 0,
      lastInboundAt: Date.now() - 10 * 24 * 60 * 60_000,
    }),
  );
  const analysisId = await t.run((ctx) =>
    ctx.db.insert("leadAnalyses", {
      accountId, conversationId, contactId,
      score: 9, band: "hot", scoreStatus: "scored", attempts: 0,
      sequenceStatus: "idle", followUpsSent: 0,
    }),
  );

  await asUser.mutation(api.messages.append, {
    conversationId,
    senderType: "customer",
    contentType: "text",
    contentText: "Hello?",
  });

  const row = await t.run((ctx) => ctx.db.get(analysisId));
  expect(row!.sequenceStatus).toBe("idle");
});

test("applyStatusPricing: an explicit non-free-entry-point marker beats a latch even inside the window", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountMember(t, {
    name: "A",
    email: "a@x.com",
    role: "admin",
  });
  const { conversationId } = await seedConv(t, accountId, {
    phone: "+15551230000",
    name: "Lead",
  });
  await seedMessageWithWamid(t, accountId, conversationId, "wamid.P16");

  // Pricing-only free-entry-point callback: leaves `conversationMetaId`
  // unset, so `differentConversation` can never fire for what follows.
  await t.mutation(internal.messages.applyStatusPricing, {
    wamid: "wamid.P16",
    accountId,
    pricing: { pricingType: "free_entry_point", isFreeEntryPoint: true },
  });

  // A genuinely BILLED conversation arrives well inside the 72h window,
  // carrying an explicit marketing origin. The latch must not survive it.
  await t.mutation(internal.messages.applyStatusPricing, {
    wamid: "wamid.P16",
    accountId,
    pricing: {
      conversationMetaId: "C_BILLED",
      expiresAt: Date.now() + 60_000,
      originType: "marketing",
      pricingType: "regular",
      isFreeEntryPoint: false,
    },
  });

  const conversation = await t.run((ctx) => ctx.db.get(conversationId));
  expect(conversation?.metaWindow?.isFreeEntryPoint).toBe(false);
  expect(conversation?.metaWindow?.originType).toBe("marketing");
});

test("insertMessageAndUpdateConversation denormalises the last sender type", async () => {
  const t = convexTest(schema, modules);

  const { accountId, conversationId } = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {
      name: "Owner", email: "owner@x.com",
    });
    const accountId = await ctx.db.insert("accounts", {
      name: "Acct", defaultCurrency: "AED", ownerUserId: userId,
    });
    const contactId = await ctx.db.insert("contacts", {
      accountId, phone: "+971500000001", phoneNormalized: "+971500000001",
    });
    const conversationId = await ctx.db.insert("conversations", {
      accountId, contactId, status: "open", unreadCount: 0,
    });
    return { accountId, contactId, conversationId };
  });

  for (const senderType of ["customer", "agent", "bot"] as const) {
    await t.run(async (ctx) => {
      const conversation = (await ctx.db.get(conversationId))!;
      await insertMessageAndUpdateConversation(
        ctx,
        {
          accountId,
          conversationId,
          senderType,
          contentType: "text",
          contentText: `hello from ${senderType}`,
        },
        conversation,
      );
    });

    const conversation = await t.run((ctx) => ctx.db.get(conversationId));
    expect(conversation?.lastMessageSenderType).toBe(senderType);
    expect(conversation?.lastMessageText).toBe(`hello from ${senderType}`);
  }
});

test("backfillLastMessageSenderType fills only conversations missing the field", async () => {
  const t = convexTest(schema, modules);

  const ids = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {
      name: "Owner", email: "owner@x.com",
    });
    const accountId = await ctx.db.insert("accounts", {
      name: "Acct", defaultCurrency: "AED", ownerUserId: userId,
    });
    const contactId = await ctx.db.insert("contacts", {
      accountId, phone: "+971500000005", phoneNormalized: "+971500000005",
    });

    // (a) missing the field, has messages → filled from the newest row
    const missing = await ctx.db.insert("conversations", {
      accountId, contactId, status: "open", unreadCount: 0,
    });
    await ctx.db.insert("messages", {
      accountId, conversationId: missing, senderType: "customer",
      contentType: "text", contentText: "first", status: "sent",
    });
    await ctx.db.insert("messages", {
      accountId, conversationId: missing, senderType: "bot",
      contentType: "text", contentText: "newest", status: "sent",
    });

    // (b) already set → left alone even though messages disagree
    const preset = await ctx.db.insert("conversations", {
      accountId, contactId, status: "open", unreadCount: 0,
      lastMessageSenderType: "agent",
    });
    await ctx.db.insert("messages", {
      accountId, conversationId: preset, senderType: "customer",
      contentType: "text", contentText: "ignored", status: "sent",
    });

    // (c) no messages at all → stays undefined, never guessed
    const empty = await ctx.db.insert("conversations", {
      accountId, contactId, status: "open", unreadCount: 0,
    });

    return { missing, preset, empty };
  });

  await t.mutation(internal.messages.backfillLastMessageSenderType, {});

  const after = await t.run(async (ctx) => ({
    missing: (await ctx.db.get(ids.missing))?.lastMessageSenderType,
    preset: (await ctx.db.get(ids.preset))?.lastMessageSenderType,
    empty: (await ctx.db.get(ids.empty))?.lastMessageSenderType,
  }));

  expect(after.missing).toBe("bot");
  expect(after.preset).toBe("agent");
  expect(after.empty).toBeUndefined();

  // Idempotent: a second pass changes nothing.
  await t.mutation(internal.messages.backfillLastMessageSenderType, {});
  const again = await t.run(async (ctx) => ({
    missing: (await ctx.db.get(ids.missing))?.lastMessageSenderType,
    empty: (await ctx.db.get(ids.empty))?.lastMessageSenderType,
  }));
  expect(again.missing).toBe("bot");
  expect(again.empty).toBeUndefined();
});

// ------------------------------------------------------------------
// Fix round 1 (review): the original cursor resumed with
// `.gt("_creationTime", cursorMs)` — strictly greater-than, seeded from
// the previous batch's OWN tail row. Any conversation sharing that
// exact `_creationTime` but excluded from the batch by `.take()` (routine
// after a bulk import — e.g. the Postgres migration that originally
// populated this table — stamps a whole slice with one timestamp) was
// skipped PERMANENTLY: the next call's `.gt` filters that timestamp out
// entirely, with no later pass that would ever revisit it.
//
// `SENDER_TYPE_BACKFILL.batchSize` is exported as a mutable object (the
// same pattern as `leadAnalysis.BOARD_LIMITS.cap`) so this test can force
// the boundary with a batch of 2 without seeding hundreds of rows.
//
// convex-test's `_creationTime` generator is otherwise monotonic and
// collision-avoiding by construction (see `DatabaseFake#insert` in
// node_modules/convex-test/dist/index.js: on any collision it bumps by
// `+ 0.001` rather than truly tying), so two ordinary inserts can never
// land on the identical `_creationTime` the way real Convex — and
// especially a bulk migration import — can. Freezing the clock at
// `Number.MAX_SAFE_INTEGER` defeats that safety net on purpose: a double
// cannot represent `Number.MAX_SAFE_INTEGER + 0.001` as a distinct value
// (`Number.MAX_SAFE_INTEGER + 0.001 === Number.MAX_SAFE_INTEGER` is
// `true`), so the generator's own collision-avoidance arithmetic rounds
// straight back to the same timestamp on every insert in this block —
// producing the exact tie this test needs to exercise.
// ------------------------------------------------------------------
test("backfillLastMessageSenderType fills every conversation tied at a batch boundary's _creationTime", async () => {
  const t = convexTest(schema, modules);

  const originalBatchSize = SENDER_TYPE_BACKFILL.batchSize;
  SENDER_TYPE_BACKFILL.batchSize = 2;
  try {
    vi.useFakeTimers();
    vi.setSystemTime(Number.MAX_SAFE_INTEGER);

    const tied: Id<"conversations">[] = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {
        name: "Owner", email: "owner-tie@x.com",
      });
      const accountId = await ctx.db.insert("accounts", {
        name: "Acct", defaultCurrency: "AED", ownerUserId: userId,
      });
      const contactId = await ctx.db.insert("contacts", {
        accountId, phone: "+971500000006", phoneNormalized: "+971500000006",
      });

      const ids: Id<"conversations">[] = [];
      // Three conversations, all landing on the exact same
      // `_creationTime` (see comment above) — one more than the
      // `batchSize` of 2, so the first `.take(2)` is guaranteed to cut
      // the tie group in half.
      for (const tag of ["a", "b", "c"]) {
        const conversationId = await ctx.db.insert("conversations", {
          accountId, contactId, status: "open", unreadCount: 0,
        });
        await ctx.db.insert("messages", {
          accountId, conversationId, senderType: "bot",
          contentType: "text", contentText: tag, status: "sent",
        });
        ids.push(conversationId);
      }
      return ids;
    });

    vi.useRealTimers();

    await t.mutation(internal.messages.backfillLastMessageSenderType, {});

    // `?? "MISSING"` keeps this an ordinary array (a bare `undefined`
    // element isn't a serializable Convex value and would crash `t.run`
    // itself rather than fail the assertion below).
    const senderTypes = await t.run(async (ctx) =>
      Promise.all(
        tied.map(async (id) => (await ctx.db.get(id))?.lastMessageSenderType ?? "MISSING"),
      ),
    );

    // Every conversation at the tied `_creationTime` must be filled —
    // including whichever one `.take(2)` left out of the first batch.
    expect(senderTypes).toEqual(["bot", "bot", "bot"]);
  } finally {
    SENDER_TYPE_BACKFILL.batchSize = originalBatchSize;
    vi.useRealTimers();
  }
});

test("awaitingReply tracks the direction of the last message", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Ann", email: "ann@example.com", role: "supervisor",
  });
  const contactId = await asUser.mutation(api.contacts.create, {
    phone: "111",
  });
  const conversationId = await seedConversation(t, { accountId, contactId });
  const read = async () =>
    (await t.run((ctx) => ctx.db.get(conversationId)))!.awaitingReply;

  await asUser.mutation(api.messages.append, {
    conversationId, senderType: "customer", contentType: "text", contentText: "hi",
  });
  expect(await read()).toBe(true);

  await asUser.mutation(api.messages.append, {
    conversationId, senderType: "agent", contentType: "text", contentText: "hello",
  });
  expect(await read()).toBe(false);

  // A bot message is ours too — an auto-reply must not leave the thread
  // looking like it still owes the customer an answer.
  await asUser.mutation(api.messages.append, {
    conversationId, senderType: "bot", contentType: "text", contentText: "auto",
  });
  expect(await read()).toBe(false);

  // ...and a fresh customer message puts it straight back to Active.
  await asUser.mutation(api.messages.append, {
    conversationId, senderType: "customer", contentType: "text", contentText: "still there?",
  });
  expect(await read()).toBe(true);
});

// ============================================================
// Un-archive on inbound must be TRANSACTIONAL (fix, 2026-07-28).
//
// P2's spec required this and the shipped code did not do it: the call
// lived in `ingest.ts`'s best-effort fan-out, which swallows failures by
// design, so a swallowed failure left an archived customer invisible
// while they were actively writing in. These tests reach the message
// helper WITHOUT the fan-out, so they only pass if the un-archive
// happens in the same transaction as the message insert.
// ============================================================

test("an inbound message un-archives, without the ingest fan-out running", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    // supervisor: pool conversation, not about RBAC — `messages.append`
    // requires "own" access and an unassigned thread has no owner.
    name: "Ann", email: "ann@example.com", role: "supervisor",
  });
  const contactId = await asUser.mutation(api.contacts.create, {
    phone: "+971500000901", name: "Archived Returner",
  });
  const conversationId = await seedConversation(t, { accountId, contactId });
  await t.run((ctx) =>
    ctx.db.patch(conversationId, {
      archivedAt: Date.now() - 60_000,
      archivedReason: "manual",
    }),
  );

  // `messages.append`, NOT `ingest.processInbound` — no fan-out here.
  await asUser.mutation(api.messages.append, {
    conversationId, senderType: "customer", contentType: "text", contentText: "still there?",
  });

  const c = await t.run((ctx) => ctx.db.get(conversationId));
  expect(c!.archivedAt).toBeUndefined();
  expect(c!.archivedReason).toBeUndefined();
  expect(c!.returnedAt).toBeGreaterThan(0);
});

test("the mirrored leadAnalyses.archived flag clears in the same transaction", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Ann", email: "ann@example.com", role: "supervisor",
  });
  const contactId = await asUser.mutation(api.contacts.create, {
    phone: "+971500000902", name: "Mirror Returner",
  });
  const conversationId = await seedConversation(t, { accountId, contactId });
  const analysisId = await t.run(async (ctx) => {
    await ctx.db.patch(conversationId, { archivedAt: Date.now() - 60_000 });
    return await ctx.db.insert("leadAnalyses", {
      accountId, conversationId, contactId,
      scoreStatus: "scored", sequenceStatus: "idle",
      attempts: 0, followUpsSent: 0, archived: true,
    });
  });

  await asUser.mutation(api.messages.append, {
    conversationId, senderType: "customer", contentType: "text", contentText: "hi",
  });

  // CLEARED, not `false` — the schema's representation rule.
  expect((await t.run((ctx) => ctx.db.get(analysisId)))!.archived).toBeUndefined();
});

test("an OUTBOUND message never un-archives", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Ann", email: "ann@example.com", role: "supervisor",
  });
  const contactId = await asUser.mutation(api.contacts.create, {
    phone: "+971500000903", name: "Stays Archived",
  });
  const conversationId = await seedConversation(t, { accountId, contactId });
  const archivedAt = Date.now() - 60_000;
  await t.run((ctx) => ctx.db.patch(conversationId, { archivedAt }));

  // A template sent into an archived thread must not resurrect it —
  // only the CUSTOMER coming back does that.
  await asUser.mutation(api.messages.append, {
    conversationId, senderType: "bot", contentType: "text", contentText: "nudge",
  });

  expect((await t.run((ctx) => ctx.db.get(conversationId)))!.archivedAt).toBe(archivedAt);
});

// ============================================================
// Manual lane overrides — snooze and forced-chasing — must clear
// on inbound, in the message transaction (not in best-effort fan-out).
// ============================================================

test("an inbound message clears a snooze, in the message transaction", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Ann", email: "ann@example.com", role: "supervisor",
  });
  const contactId = await asUser.mutation(api.contacts.create, {
    phone: "111",
  });
  const conversationId = await seedConversation(t, { accountId, contactId });
  await t.run((ctx) => ctx.db.patch(conversationId, {
    snoozedUntil: Date.now() + 86_400_000, snoozedReason: "next week",
  }));

  await asUser.mutation(api.messages.append, {
    conversationId, senderType: "customer", contentType: "text", contentText: "actually...",
  });

  const c = await t.run((ctx) => ctx.db.get(conversationId));
  // Cleared WITHOUT the ingest fan-out running. A customer writing to us
  // outranks every filing decision, and must not depend on best-effort.
  expect(c!.snoozedUntil).toBeUndefined();
  expect(c!.snoozedReason).toBeUndefined();
  expect(c!.awaitingReply).toBe(true);
});

test("an inbound message clears a forced-chasing mark", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Ann", email: "ann@example.com", role: "supervisor",
  });
  const contactId = await asUser.mutation(api.contacts.create, {
    phone: "222",
  });
  const conversationId = await seedConversation(t, { accountId, contactId });
  await t.run((ctx) => ctx.db.patch(conversationId, { chasingForcedAt: Date.now() }));

  await asUser.mutation(api.messages.append, {
    conversationId, senderType: "customer", contentType: "text", contentText: "hi",
  });

  expect((await t.run((ctx) => ctx.db.get(conversationId)))!.chasingForcedAt).toBeUndefined();
});

test("an OUTBOUND message leaves both overrides alone", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Ann", email: "ann@example.com", role: "supervisor",
  });
  const contactId = await asUser.mutation(api.contacts.create, {
    phone: "333",
  });
  const conversationId = await seedConversation(t, { accountId, contactId });
  const until = Date.now() + 86_400_000;
  await t.run((ctx) => ctx.db.patch(conversationId, { snoozedUntil: until }));

  // Sending a template into a snoozed thread must not un-park it — only
  // the CUSTOMER coming back does that.
  await asUser.mutation(api.messages.append, {
    conversationId, senderType: "bot", contentType: "text", contentText: "nudge",
  });

  expect((await t.run((ctx) => ctx.db.get(conversationId)))!.snoozedUntil).toBe(until);
});

// ============================================================
// Reply-latency backfill
//
// `recordResponseSample` only pairs messages written after it deploys, so
// without this `dashboard.responseTime` charts a flat "no data" for its whole
// 14-day window until two weeks have passed. Idempotence works differently
// here than for the counts above: a sample cannot be rebuilt hour-by-hour
// (it is attributed to the hour the customer ASKED, which a later reply
// discovers), so the run CLEARS the window first and then accumulates.
// ============================================================

async function responseTotals(t: ReturnType<typeof convexTest>) {
  const rows = await statsRows(t);
  return {
    samples: rows.reduce((n, r) => n + (r.responseCount ?? 0), 0),
    totalMs: rows.reduce((n, r) => n + (r.responseTotalMs ?? 0), 0),
    // Histogram-derived total, matching `sumResponseBuckets` in
    // lib/reportStats.ts — the invariant every consumer of `responseBuckets`
    // (percentiles, within-target) relies on is that this always equals
    // `samples` above. `recordResponseSample` writes buckets via
    // `addResponseBucket`, which ADDS to whatever is already there, so this
    // number silently drifts from `samples` if a backfill's clear step ever
    // resets the count without also resetting the histogram.
    bucketSamples: rows.reduce(
      (n, r) =>
        n +
        RESPONSE_BUCKET_KEYS.reduce((s, k) => s + (r.responseBuckets?.[k] ?? 0), 0),
      0,
    ),
  };
}

test("response backfill rebuilds samples from pre-existing messages", async () => {
  vi.useFakeTimers();
  try {
    const t = convexTest(schema, modules);
    const { accountId } = await seedThread(t, "a@x.com");
    const conversationId = await t.run(async (ctx) => {
      const rows = await ctx.db.query("conversations").collect();
      return rows[0]!._id;
    });

    // Pre-rollup history: raw rows with no pairing behind them.
    await seedRawMessage(t, accountId, conversationId, "customer");
    await seedRawMessage(t, accountId, conversationId, "customer");
    await seedRawMessage(t, accountId, conversationId, "agent");
    expect((await responseTotals(t)).samples).toBe(0);

    await t.mutation(internal.messages.backfillResponseHourlyStats, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    // Two customer messages then one reply is ONE sample, same dedupe rule
    // the write path applies.
    expect((await responseTotals(t)).samples).toBe(1);
  } finally {
    vi.useRealTimers();
  }
});

test("response backfill is idempotent — a second run does not double the samples", async () => {
  vi.useFakeTimers();
  try {
    const t = convexTest(schema, modules);
    const { accountId } = await seedThread(t, "b@x.com");
    const conversationId = await t.run(async (ctx) => {
      const rows = await ctx.db.query("conversations").collect();
      return rows[0]!._id;
    });
    await seedRawMessage(t, accountId, conversationId, "customer");
    await seedRawMessage(t, accountId, conversationId, "agent");
    await seedRawMessage(t, accountId, conversationId, "customer");
    await seedRawMessage(t, accountId, conversationId, "bot");

    await t.mutation(internal.messages.backfillResponseHourlyStats, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const first = await responseTotals(t);

    await t.mutation(internal.messages.backfillResponseHourlyStats, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const second = await responseTotals(t);

    expect(first.samples).toBe(2);
    expect(second).toEqual(first);

    // The invariant every percentile/within-target figure in
    // `convex/reports.ts` depends on: the histogram's entries must sum to
    // `responseCount`, on EVERY run, not just the first. `recordResponseSample`
    // writes `responseBuckets` via `addResponseBucket`, which ADDS — so if
    // the backfill's clear step resets `responseCount`/`responseTotalMs` but
    // leaves a prior run's histogram in place, the replay below piles a
    // second copy of every bucket increment on top of the first while the
    // count rebuilds from zero, and this equality silently breaks on exactly
    // the re-run this test exists to cover.
    expect(first.bucketSamples).toBe(first.samples);
    expect(second.bucketSamples).toBe(second.samples);
  } finally {
    vi.useRealTimers();
  }
});

test("response backfill leaves a mid-wait thread able to record its reply later", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    // Pinned BEFORE anything is seeded. This backfill reads `_creationTime`,
    // and convex-test only ever clamps that forward from the last insert — so
    // seeding at the real "now" first would push the message past `askedAt`
    // and make the reply below look like it arrived before the question.
    const askedAt = Date.parse("2026-07-07T10:00:00.000Z");
    vi.setSystemTime(askedAt - 3_600_000);

    const t = convexTest(schema, modules);
    const { accountId } = await seedThread(t, "c@x.com");
    const conversationId = await t.run(async (ctx) => {
      const rows = await ctx.db.query("conversations").collect();
      return rows[0]!._id;
    });

    vi.setSystemTime(askedAt);
    await seedRawMessage(t, accountId, conversationId, "customer");

    vi.setSystemTime(askedAt + 60_000);
    await t.mutation(internal.messages.backfillResponseHourlyStats, {
      sinceMs: askedAt - 24 * 3_600_000,
    });
    await t.finishAllScheduledFunctions(async () => {});

    // Unanswered, so no sample yet — but the clock is now armed.
    expect((await responseTotals(t)).samples).toBe(0);
    expect((await convDoc(t, conversationId)).pendingCustomerAtMs).toBe(askedAt);

    // The reply arrives through the normal write path and is still counted,
    // timed from the question the backfill recovered.
    vi.setSystemTime(askedAt + 30 * 60_000);
    await appendVia(t, accountId, conversationId, "agent");

    expect(await responseTotals(t)).toEqual({
      samples: 1,
      totalMs: 30 * 60_000,
      bucketSamples: 1,
    });
  } finally {
    vi.useRealTimers();
  }
});

test("response backfill covers every account, not just the first", async () => {
  vi.useFakeTimers();
  try {
    const t = convexTest(schema, modules);
    const a = await seedThread(t, "d@x.com");
    const b = await seedThread(t, "e@x.com");
    for (const thread of [a, b]) {
      await seedRawMessage(t, thread.accountId, thread.conversationId, "customer");
      await seedRawMessage(t, thread.accountId, thread.conversationId, "agent");
    }

    await t.mutation(internal.messages.backfillResponseHourlyStats, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const rows = await statsRows(t);
    const byAccount = new Map<string, number>();
    for (const row of rows) {
      byAccount.set(
        row.accountId,
        (byAccount.get(row.accountId) ?? 0) + (row.responseCount ?? 0),
      );
    }
    expect(byAccount.get(a.accountId)).toBe(1);
    expect(byAccount.get(b.accountId)).toBe(1);
  } finally {
    vi.useRealTimers();
  }
});

// ============================================================
// Reply-latency HISTOGRAM (Task 3, docs/superpowers/specs/2026-08-05-
// reports-section-design.md) — `responseBuckets` alongside the sum/count
// above. Written in the SAME patch/insert as `responseCount`/
// `responseTotalMs`, never separately: the SLA panel this feeds derives
// exact percentiles from the histogram, and a histogram that can disagree
// with the count sitting beside it would make every one of them silently
// wrong.
// ============================================================

test("recordResponseSample fills the histogram alongside the sum and count", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const t = convexTest(schema, modules);
    const { accountId, conversationId } = await seedThread(t, "g@x.com");

    // Customer asks, agent replies 3 minutes later -> the m5 bucket.
    const askedAt = Date.now();
    await t.run(async (ctx) => {
      await ctx.db.patch(conversationId, { pendingCustomerAtMs: askedAt });
    });
    vi.setSystemTime(askedAt + 3 * 60_000);
    await t.mutation(internal.messages.appendInternal, {
      accountId,
      conversationId,
      senderType: "agent",
      contentType: "text",
      contentText: "on it",
    });

    const row = await t.run(async (ctx) =>
      ctx.db
        .query("messageHourlyStats")
        .withIndex("by_account_hour", (q) =>
          q.eq("accountId", accountId).eq("hourStartMs", hourStartMs(askedAt)),
        )
        .unique(),
    );
    expect(row?.responseCount).toBe(1);
    expect(row?.responseBuckets).toEqual({ ...emptyResponseBuckets(), m5: 1 });
    // The histogram must always agree with the count it sits beside — a
    // divergence means one write path updated only half the pair.
    const histogramTotal = Object.values(row!.responseBuckets!).reduce(
      (a, b) => a + b,
      0,
    );
    expect(histogramTotal).toBe(row!.responseCount);
  } finally {
    vi.useRealTimers();
  }
});

// ============================================================
// Meta billing rollup (Task 4, docs/superpowers/specs/2026-08-05-
// reports-section-design.md) — `metaConversations`,
// `freeEntryPointConversations`, `billedMessagesByCategory` alongside the
// pricing/window writes `applyStatusPricing` already made above. TWO
// SEPARATE dedup mechanisms are exercised here: per-message categories key
// off `message.pricing === undefined` (the first callback to carry pricing
// facts for a given message); conversation counters ride the existing
// `!prev || differentConversation` branch, which already IS the "new Meta
// conversation" dedup — no second guard was added for it.
// ============================================================

// A status webhook fires repeatedly for one message (sent -> delivered ->
// read). Without a guard each callback would re-count the same message, and
// the billing panel would over-report by however many callbacks Meta sent —
// a wrong number that looks entirely plausible.
test("repeated status callbacks count one message exactly once", async () => {
  const t = convexTest(schema, modules);
  const { accountId, conversationId } = await seedThread(t, "billing1@x.com");
  const sentAt = Date.now();

  await t.run(async (ctx) =>
    ctx.db.insert("messages", {
      accountId,
      conversationId,
      senderType: "agent",
      contentType: "text",
      status: "sent",
      messageId: "wamid.billing.1",
    }),
  );

  // Three Meta status callbacks (sent, delivered, read), identical pricing
  // facts each time.
  for (let callback = 0; callback < 3; callback++) {
    await t.mutation(internal.messages.applyStatusPricing, {
      wamid: "wamid.billing.1",
      accountId,
      pricing: {
        conversationMetaId: "meta-conv-1",
        pricingCategory: "marketing",
        billable: true,
        isFreeEntryPoint: false,
      },
    });
  }

  const row = await t.run(async (ctx) =>
    ctx.db
      .query("messageHourlyStats")
      .withIndex("by_account_hour", (q) =>
        q.eq("accountId", accountId).eq("hourStartMs", hourStartMs(sentAt)),
      )
      .unique(),
  );
  expect(row?.billedMessagesByCategory).toEqual({
    ...emptyPricingCategories(),
    marketing: 1,
  });
  // Same dedup, different mechanism: the conversation counter rides the
  // "new conversationMetaId" branch.
  expect(row?.metaConversations).toBe(1);
  expect(row?.freeEntryPointConversations).toBe(0);
});

test("a genuinely new Meta conversation is counted again", async () => {
  const t = convexTest(schema, modules);
  const { accountId, conversationId } = await seedThread(t, "billing2@x.com");

  for (const [wamid, metaConv] of [
    ["wamid.a", "meta-conv-1"],
    ["wamid.b", "meta-conv-2"],
  ]) {
    await t.run(async (ctx) =>
      ctx.db.insert("messages", {
        accountId, conversationId, senderType: "agent",
        contentType: "text", status: "sent", messageId: wamid,
      }),
    );
    await t.mutation(internal.messages.applyStatusPricing, {
      wamid,
      accountId,
      pricing: {
        conversationMetaId: metaConv,
        pricingCategory: "service",
        billable: true,
        isFreeEntryPoint: true,
      },
    });
  }

  const total = await t.run(async (ctx) => {
    const rows = await ctx.db
      .query("messageHourlyStats")
      .withIndex("by_account_hour", (q) => q.eq("accountId", accountId))
      .collect();
    return {
      meta: rows.reduce((s, r) => s + (r.metaConversations ?? 0), 0),
      fep: rows.reduce((s, r) => s + (r.freeEntryPointConversations ?? 0), 0),
    };
  });
  // Both windows were free-entry-point, so `fep` equals `meta` here — which
  // is the whole reason this counter is NOT named "billable": Meta billed
  // for neither of them.
  expect(total).toEqual({ meta: 2, fep: 2 });
});

test("a pricing-free callback writes no billing counters", async () => {
  const t = convexTest(schema, modules);
  const { accountId, conversationId } = await seedThread(t, "billing3@x.com");
  await t.run(async (ctx) =>
    ctx.db.insert("messages", {
      accountId, conversationId, senderType: "agent",
      contentType: "text", status: "sent", messageId: "wamid.empty",
    }),
  );

  await t.mutation(internal.messages.applyStatusPricing, {
    wamid: "wamid.empty",
    accountId,
    pricing: { isFreeEntryPoint: false },
  });

  const rows = await t.run(async (ctx) =>
    ctx.db
      .query("messageHourlyStats")
      .withIndex("by_account_hour", (q) => q.eq("accountId", accountId))
      .collect(),
  );
  const billed = rows.reduce(
    (s, r) => s + (r.billedMessagesByCategory?.marketing ?? 0),
    0,
  );
  expect(billed).toBe(0);
});

// Fix round 1: the three tests above all pass even if the implementation
// bucketed on `Date.now()` instead of `message._creationTime` /
// `first._creationTime` — the message insert and the callback happen back
// to back within the same hour (test 1), or the assertions sum across every
// hourly row regardless of which hour they landed in (tests 2 and 3). This
// test is the one that actually distinguishes the two: the message is
// created in one hour, the status callback is made two hours later, and the
// counters must land on the MESSAGE's hour, not the callback's.
test("billing counters land on the MESSAGE's hour, not the status callback's", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    // Set the fake clock BEFORE seeding: convex-test derives every row's
    // `_creationTime` from `Date.now()` and clamps it forward only within one
    // `convexTest()` instance. `seedThread` itself inserts rows (account,
    // contact, conversation); if the clock were set to `messageCreatedAt`
    // only after that, and `messageCreatedAt` is earlier than the real "now"
    // those seed rows were clamped to, the message insert below would be
    // silently clamped forward too — defeating the whole point of this test.
    const messageCreatedAt = Date.parse("2026-07-07T10:00:00.000Z");
    vi.setSystemTime(messageCreatedAt);
    const t = convexTest(schema, modules);
    const { accountId, conversationId } = await seedThread(t, "billing5@x.com");

    await t.run(async (ctx) =>
      ctx.db.insert("messages", {
        accountId,
        conversationId,
        senderType: "agent",
        contentType: "text",
        status: "sent",
        messageId: "wamid.hour-test",
      }),
    );

    // The status callback arrives two hours later, in a genuinely different
    // hourly bucket than the message's own creation hour.
    const callbackAt = messageCreatedAt + 2 * HOUR_MS;
    expect(hourStartMs(callbackAt)).not.toBe(hourStartMs(messageCreatedAt));
    vi.setSystemTime(callbackAt);

    await t.mutation(internal.messages.applyStatusPricing, {
      wamid: "wamid.hour-test",
      accountId,
      pricing: {
        conversationMetaId: "meta-conv-hourtest",
        pricingCategory: "marketing",
        billable: true,
        isFreeEntryPoint: true,
      },
    });

    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("messageHourlyStats")
        .withIndex("by_account_hour", (q) => q.eq("accountId", accountId))
        .collect(),
    );
    const messageHourRow = rows.find(
      (r) => r.hourStartMs === hourStartMs(messageCreatedAt),
    );
    const callbackHourRow = rows.find(
      (r) => r.hourStartMs === hourStartMs(callbackAt),
    );

    // Both counters — the per-message category AND the conversation —
    // belong to the message's hour...
    expect(messageHourRow?.billedMessagesByCategory).toEqual({
      ...emptyPricingCategories(),
      marketing: 1,
    });
    expect(messageHourRow?.metaConversations).toBe(1);
    expect(messageHourRow?.freeEntryPointConversations).toBe(1);
    // ...and nothing was ever written to the callback's hour: this whole
    // test's conversation/message pair produced exactly one hourly row.
    expect(callbackHourRow).toBeUndefined();
    expect(rows).toHaveLength(1);
  } finally {
    vi.useRealTimers();
  }
});

// Cheap, same theme, not gating: the common production shape is several
// DIFFERENT messages sent inside one Meta conversation window before it
// closes, each getting its own status callback. The conversation must still
// be counted once, not once per message.
test("a second message in the same Meta conversation does not double-count the conversation", async () => {
  const t = convexTest(schema, modules);
  const { accountId, conversationId } = await seedThread(t, "billing6@x.com");

  await t.run(async (ctx) =>
    ctx.db.insert("messages", {
      accountId, conversationId, senderType: "agent",
      contentType: "text", status: "sent", messageId: "wamid.shared.1",
    }),
  );
  await t.mutation(internal.messages.applyStatusPricing, {
    wamid: "wamid.shared.1",
    accountId,
    pricing: {
      conversationMetaId: "meta-conv-shared",
      pricingCategory: "utility",
      billable: true,
      isFreeEntryPoint: false,
    },
  });

  // A second, DIFFERENT message, same Meta conversation.
  await t.run(async (ctx) =>
    ctx.db.insert("messages", {
      accountId, conversationId, senderType: "agent",
      contentType: "text", status: "sent", messageId: "wamid.shared.2",
    }),
  );
  await t.mutation(internal.messages.applyStatusPricing, {
    wamid: "wamid.shared.2",
    accountId,
    pricing: {
      conversationMetaId: "meta-conv-shared",
      pricingCategory: "utility",
      billable: true,
      isFreeEntryPoint: false,
    },
  });

  const rows = await t.run(async (ctx) =>
    ctx.db
      .query("messageHourlyStats")
      .withIndex("by_account_hour", (q) => q.eq("accountId", accountId))
      .collect(),
  );
  const totals = rows.reduce(
    (acc, r) => ({
      utility: acc.utility + (r.billedMessagesByCategory?.utility ?? 0),
      metaConversations: acc.metaConversations + (r.metaConversations ?? 0),
    }),
    { utility: 0, metaConversations: 0 },
  );
  // Both messages are billed individually...
  expect(totals.utility).toBe(2);
  // ...but the second message's callback carries the SAME conversationMetaId,
  // so it takes the merge branch (not "!prev || differentConversation") and
  // must not bump the conversation counter again.
  expect(totals.metaConversations).toBe(1);
});

// ============================================================
// backfillConversationStartedStats / backfillResponseBuckets (Task 5)
//
// One-shot backfills that populate the reports rollup's
// `conversationsStarted`/`conversationsStartedAd` counters and the
// `responseBuckets` histogram from history that predates the live write
// paths added in Tasks 2-4 (`conversations.insertConversation`,
// `adReferrals.recordAdReferral`, `recordResponseSample`). Same IDEMPOTENCE
// property as `backfillMessageHourlyStats` above, plus two properties
// specific to these two: the ad-sourced counter must apply the exact same
// `sourceType === "ad"` gate the live path uses (not every referral is an
// ad), and the histogram backfill must never clobber an hour that already
// has an EXACT histogram with its own approximation.
// ============================================================

// `.filter()`, not `.withIndex()` — a helper parameter typed as the bare
// `ReturnType<typeof convexTest>` loses this suite's concrete index names
// (see `convex/ingest.test.ts`'s `tagLink` for the identical, already
// documented gotcha).
async function statsRowsFor(
  t: ReturnType<typeof convexTest>,
  accountId: Id<"accounts">,
) {
  return await t.run((ctx) =>
    ctx.db
      .query("messageHourlyStats")
      .filter((q) => q.eq(q.field("accountId"), accountId))
      .collect(),
  );
}

test("backfillConversationStartedStats is idempotent", async () => {
  vi.useFakeTimers();
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountMember(t, {
    name: "A",
    email: "a@x.com",
    role: "admin",
  });
  // Seed three conversations directly (bypassing insertConversation, so no
  // counter is written) to simulate rows that predate the rollup.
  await t.run(async (ctx) => {
    for (let i = 0; i < 3; i++) {
      const contactId = await ctx.db.insert("contacts", {
        accountId,
        phone: `+97150000010${i}`,
        phoneNormalized: `97150000010${i}`,
      });
      await ctx.db.insert("conversations", {
        accountId,
        contactId,
        status: "open",
        unreadCount: 0,
        awaitingReply: true,
      });
    }
  });

  const runAll = async () => {
    await t.mutation(internal.messages.backfillConversationStartedStats, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
  };
  const total = async () =>
    await t.run(async (ctx) => {
      const rows = await ctx.db
        .query("messageHourlyStats")
        .withIndex("by_account_hour", (q) => q.eq("accountId", accountId))
        .collect();
      return rows.reduce((s, r) => s + (r.conversationsStarted ?? 0), 0);
    });

  await runAll();
  expect(await total()).toBe(3);
  // Running twice must converge, not double. This is the property that
  // makes a resumable backfill safe to re-trigger after an interruption.
  await runAll();
  expect(await total()).toBe(3);
});

// The test above never actually exercises the self-scheduling chain: three
// conversations in one account is a single partial batch, so
// `advanceToNextAccount` finds no next account and `ctx.scheduler.runAfter`
// is never called — `finishAllScheduledFunctions` has nothing to do. A
// two-account run does: account A's batch (necessarily partial, 2 < 500)
// finishes and schedules a hop to account B, so idempotency here is
// actually proven across a real scheduled invocation, not just one
// synchronous call.
test("backfillConversationStartedStats: idempotency holds across a genuine self-scheduling hop between accounts", async () => {
  vi.useFakeTimers();
  const t = convexTest(schema, modules);
  const a = await seedAccountMember(t, { name: "A", email: "hop-a@x.com", role: "admin" });
  const b = await seedAccountMember(t, { name: "B", email: "hop-b@x.com", role: "admin" });

  const seedRawConversations = async (accountId: Id<"accounts">, n: number) => {
    await t.run(async (ctx) => {
      for (let i = 0; i < n; i++) {
        const contactId = await ctx.db.insert("contacts", {
          accountId,
          phone: `+1555${i}`,
          phoneNormalized: `1555${i}`,
        });
        await ctx.db.insert("conversations", {
          accountId,
          contactId,
          status: "open",
          unreadCount: 0,
          awaitingReply: true,
        });
      }
    });
  };
  await seedRawConversations(a.accountId, 2);
  await seedRawConversations(b.accountId, 3);

  const runAll = async () => {
    await t.mutation(internal.messages.backfillConversationStartedStats, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
  };
  const totals = async () => {
    const sum = (rows: Awaited<ReturnType<typeof statsRowsFor>>) =>
      rows.reduce((s, r) => s + (r.conversationsStarted ?? 0), 0);
    return {
      a: sum(await statsRowsFor(t, a.accountId)),
      b: sum(await statsRowsFor(t, b.accountId)),
    };
  };

  await runAll();
  expect(await totals()).toEqual({ a: 2, b: 3 });
  await runAll();
  expect(await totals()).toEqual({ a: 2, b: 3 });
});

test('backfillConversationStartedStats gates conversationsStartedAd on sourceType === "ad", matching the live write path', async () => {
  vi.useFakeTimers();
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountMember(t, {
    name: "A",
    email: "post-gate@x.com",
    role: "admin",
  });
  const { contactId, conversationId } = await t.run(async (ctx) => {
    const contactId = await ctx.db.insert("contacts", {
      accountId,
      phone: "+15550000000",
      phoneNormalized: "15550000000",
    });
    const conversationId = await ctx.db.insert("conversations", {
      accountId,
      contactId,
      status: "open",
      unreadCount: 0,
      awaitingReply: true,
    });
    return { contactId, conversationId };
  });
  // Inserted directly (bypassing recordAdReferral), the way a pre-rollup
  // history row looks. Its only referral is an organic "post" tap — an
  // organic Facebook/Instagram post click, NOT a Click-to-WhatsApp ad.
  await t.run((ctx) =>
    ctx.db.insert("adReferrals", {
      accountId,
      contactId,
      conversationId,
      waMessageId: "wamid.post1",
      sourceType: "post",
      isFirstTouch: true,
    }),
  );

  await t.mutation(internal.messages.backfillConversationStartedStats, {});
  await t.finishAllScheduledFunctions(vi.runAllTimers);

  const rows = await statsRowsFor(t, accountId);
  expect(rows).toHaveLength(1);
  // The conversation still started...
  expect(rows[0]!.conversationsStarted).toBe(1);
  // ...but must NOT be attributed to an ad it didn't come from — matching
  // `adReferrals.recordAdReferral`'s `sourceType === "ad"` gate (Task 2).
  expect(rows[0]!.conversationsStartedAd ?? 0).toBe(0);
});

test("backfillConversationStartedStats counts a genuine ad referral toward conversationsStartedAd", async () => {
  vi.useFakeTimers();
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountMember(t, {
    name: "A",
    email: "ad-gate@x.com",
    role: "admin",
  });
  const { contactId, conversationId } = await t.run(async (ctx) => {
    const contactId = await ctx.db.insert("contacts", {
      accountId,
      phone: "+15550000001",
      phoneNormalized: "15550000001",
    });
    const conversationId = await ctx.db.insert("conversations", {
      accountId,
      contactId,
      status: "open",
      unreadCount: 0,
      awaitingReply: true,
    });
    return { contactId, conversationId };
  });
  await t.run((ctx) =>
    ctx.db.insert("adReferrals", {
      accountId,
      contactId,
      conversationId,
      waMessageId: "wamid.ad1",
      sourceType: "ad",
      adId: "AD1",
      isFirstTouch: true,
    }),
  );

  await t.mutation(internal.messages.backfillConversationStartedStats, {});
  await t.finishAllScheduledFunctions(vi.runAllTimers);

  const rows = await statsRowsFor(t, accountId);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.conversationsStarted).toBe(1);
  expect(rows[0]!.conversationsStartedAd).toBe(1);
});

// Fix round 1, Finding 1 (Critical): the live path
// (`adReferrals.recordAdReferral`) counts a conversation as ad-sourced iff
// its CHRONOLOGICALLY EARLIEST referral is an ad — `priorReferrals` there
// is collected unfiltered by sourceType, so a later ad referral landing on
// a conversation that already has ANY earlier referral (of any type) is
// never counted. `ingest.ts`'s find-or-create reuses one conversation per
// contact, so a "post" tap followed, days later, by a genuine ad click on
// the SAME (reused) conversation is the normal shape, not a contrived one.
test('backfillConversationStartedStats: a conversation whose EARLIEST referral is "post" and whose LATER referral is "ad" must not count as ad-sourced', async () => {
  vi.useFakeTimers();
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountMember(t, {
    name: "A",
    email: "mixed-referral@x.com",
    role: "admin",
  });
  const conversationCreatedAt = Date.now();
  const { contactId, conversationId } = await t.run(async (ctx) => {
    const contactId = await ctx.db.insert("contacts", {
      accountId,
      phone: "+15550000002",
      phoneNormalized: "15550000002",
    });
    const conversationId = await ctx.db.insert("conversations", {
      accountId,
      contactId,
      status: "open",
      unreadCount: 0,
      awaitingReply: true,
    });
    return { contactId, conversationId };
  });

  // First referral on this conversation: an organic "post" tap.
  await t.run((ctx) =>
    ctx.db.insert("adReferrals", {
      accountId,
      contactId,
      conversationId,
      waMessageId: "wamid.mixed.post",
      sourceType: "post",
      isFirstTouch: true,
    }),
  );

  // Second referral on the SAME conversation, three days later: a genuine
  // ad. Explicit time-step so the ordering is unambiguous to a reader,
  // rather than relying on convex-test's own insert-ordering behavior.
  vi.setSystemTime(conversationCreatedAt + 3 * 24 * 60 * 60 * 1000);
  await t.run((ctx) =>
    ctx.db.insert("adReferrals", {
      accountId,
      contactId,
      conversationId,
      waMessageId: "wamid.mixed.ad",
      sourceType: "ad",
      adId: "AD-MIXED",
      isFirstTouch: false,
    }),
  );

  await t.mutation(internal.messages.backfillConversationStartedStats, {});
  await t.finishAllScheduledFunctions(vi.runAllTimers);

  const rows = await statsRowsFor(t, accountId);
  expect(rows).toHaveLength(1);
  // The conversation still started...
  expect(rows[0]!.conversationsStarted).toBe(1);
  // ...but its EARLIEST referral was "post", so — exactly like
  // `recordAdReferral`'s `alreadyCountedThisConversation` guard, which
  // checks for ANY prior referral, not just a prior AD — the later ad
  // referral must NOT retroactively make this an ad-sourced conversation.
  expect(rows[0]!.conversationsStartedAd ?? 0).toBe(0);
});

// ------------------------------------------------------------
// Fix round 1, Finding 2 (Important): the cursor, withheld-partial-hour,
// and single-hour-overflow paths had zero coverage — every earlier test
// seeds at most 3 rows against a 500-row batch, so `cursorMs` was never
// non-undefined and neither of those branches ever ran. `batchSize` is an
// internal-mutation-only test seam (see its own comment on the args
// validator above) that lets these tests force a genuine multi-batch chain
// with a handful of rows instead of 500+.
// ------------------------------------------------------------

/** Inserts a contact + conversation at exactly `atMs`, the way the
 *  multi-batch tests below need precise control over which hour (and which
 *  position within a batch) each conversation lands in. */
async function seedConversationAt(
  t: ReturnType<typeof convexTest>,
  accountId: Id<"accounts">,
  atMs: number,
  phoneSuffix: string,
) {
  vi.setSystemTime(atMs);
  await t.run(async (ctx) => {
    const contactId = await ctx.db.insert("contacts", {
      accountId,
      phone: `+1777${phoneSuffix}`,
      phoneNormalized: `1777${phoneSuffix}`,
    });
    await ctx.db.insert("conversations", {
      accountId,
      contactId,
      status: "open",
      unreadCount: 0,
      awaitingReply: true,
    });
  });
}

test("backfillConversationStartedStats: a multi-batch chain resumes via cursorMs, correctly writes a withheld hour's FULL count once fully observed, and reaches the same per-hour totals as a single-batch run", async () => {
  vi.useFakeTimers();
  const baseHour = hourStartMs(Date.now());
  // Two conversations per hour, three hours — with batchSize=3 below, no
  // single hour ever fills a whole batch by itself, so every full batch
  // spans >= 2 hours and takes the withhold-the-last-hour branch, not the
  // single-hour-overflow one (that path is covered separately below).
  const seedSix = async (t: ReturnType<typeof convexTest>, accountId: Id<"accounts">) => {
    let i = 0;
    for (const hourOffset of [0, 0, 1, 1, 2, 2]) {
      await seedConversationAt(
        t,
        accountId,
        baseHour + hourOffset * HOUR_MS + (i + 1) * 1000,
        String(i),
      );
      i++;
    }
  };

  // --- Multi-batch run: batchSize=3 forces a 3-hop chain (batch 1: hours
  // [0,1] partial, withholds hour 1; batch 2: hours [1,2] partial,
  // withholds hour 2; batch 3: hour 2 only, not a full batch, terminates). ---
  const tMulti = convexTest(schema, modules);
  // Pinned explicitly, not left implicit: convex-test clamps each fresh
  // instance's `_creationTime` forward from whatever `Date.now()` its OWN
  // first insert observes, so `seedAccountMember` below must run at (or
  // before) `baseHour`, not at whatever the fake clock has drifted to since
  // it was last touched — see the identical pin before `tSingle` below,
  // where omitting it is exactly what corrupted every one of tSingle's
  // conversation timestamps the first time this test was written (every
  // insert got clamped forward to `tMulti`'s last, since `tSingle`'s own
  // `seedAccountMember` ran at whatever `Date.now()` had drifted to after
  // draining `tMulti`'s whole self-scheduling chain).
  vi.setSystemTime(baseHour);
  const multi = await seedAccountMember(tMulti, {
    name: "A",
    email: "multibatch@x.com",
    role: "admin",
  });
  await seedSix(tMulti, multi.accountId);

  // Run only the FIRST batch directly (not through the scheduler), so the
  // withheld hour's absence can be observed before the chain continues —
  // proving it wasn't written prematurely (partial), not just that it
  // eventually arrives correct.
  await tMulti.mutation(internal.messages.backfillConversationStartedStats, {
    batchSize: 3,
  });
  const afterFirstBatch = await statsRowsFor(tMulti, multi.accountId);
  expect(afterFirstBatch).toHaveLength(1);
  expect(afterFirstBatch[0]!.hourStartMs).toBe(baseHour);
  expect(afterFirstBatch[0]!.conversationsStarted).toBe(2);

  // Drain the rest of the chain (hour 1 gets written on the second hop —
  // with its FULL count of 2, not the 1 conversation batch 1 glimpsed of
  // it — and hour 2 on the third).
  await tMulti.finishAllScheduledFunctions(vi.runAllTimers);
  const multiRows = await statsRowsFor(tMulti, multi.accountId);
  const multiByHour = Object.fromEntries(
    multiRows.map((r) => [r.hourStartMs, r.conversationsStarted ?? 0]),
  );
  expect(multiByHour).toEqual({
    [baseHour]: 2,
    [baseHour + HOUR_MS]: 2,
    [baseHour + 2 * HOUR_MS]: 2,
  });

  // --- Single-batch run: identical fixture, default (large) batchSize, so
  // all 6 conversations land in one pass with no withholding at all. ---
  const tSingle = convexTest(schema, modules);
  // Re-pin to `baseHour`: draining `tMulti`'s chain just now (via
  // `vi.runAllTimers` above) has moved the shared fake clock forward by
  // several hours, and `tSingle` is a brand-new convex-test instance whose
  // own `_creationTime` floor has not seen any of that — its first insert
  // must not observe the drifted-forward "now" either.
  vi.setSystemTime(baseHour);
  const single = await seedAccountMember(tSingle, {
    name: "B",
    email: "singlebatch@x.com",
    role: "admin",
  });
  await seedSix(tSingle, single.accountId);
  await tSingle.mutation(internal.messages.backfillConversationStartedStats, {});
  await tSingle.finishAllScheduledFunctions(vi.runAllTimers);
  const singleRows = await statsRowsFor(tSingle, single.accountId);
  const singleByHour = Object.fromEntries(
    singleRows.map((r) => [r.hourStartMs, r.conversationsStarted ?? 0]),
  );

  // Same shape, same numbers, regardless of how many batches it took to
  // get there.
  expect(multiByHour).toEqual(singleByHour);
});

test("backfillConversationStartedStats: single-hour-overflow writes what it measured and steps past the hour, rather than looping forever", async () => {
  vi.useFakeTimers();
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountMember(t, {
    name: "A",
    email: "overflow@x.com",
    role: "admin",
  });
  const hour = hourStartMs(Date.now());

  // THREE conversations, all in the SAME hour, with batchSize=2: the very
  // first batch this backfill can ever take is entirely one hour — from
  // inside that batch, indistinguishable from an hour with far more than
  // `batchSize` conversations. That is exactly the shape the overflow
  // guard exists to terminate rather than loop on forever (withholding
  // would rewind the cursor to where it already is).
  for (let i = 0; i < 3; i++) {
    await seedConversationAt(t, accountId, hour + (i + 1) * 1000, String(i));
  }

  const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  await t.mutation(internal.messages.backfillConversationStartedStats, {
    batchSize: 2,
  });
  await t.finishAllScheduledFunctions(vi.runAllTimers);

  const rows = await statsRowsFor(t, accountId);
  // The chain terminates — `finishAllScheduledFunctions` above resolved at
  // all, rather than hanging on a cursor that never advances — having
  // written exactly one row for the overflowing hour...
  expect(rows).toHaveLength(1);
  expect(rows[0]!.hourStartMs).toBe(hour);
  // ...with the KNOWN, documented undercount: only the first `batchSize`
  // (2) conversations it ever saw for that hour, not the 3 that actually
  // exist. This is the accepted tradeoff the code's own comment and
  // console.warn describe, not a bug — pinned here so a future change that
  // accidentally makes this loop instead of terminate is caught.
  expect(rows[0]!.conversationsStarted).toBe(2);
  expect(warnSpy).toHaveBeenCalledTimes(1);
  expect(warnSpy.mock.calls[0]![0]).toContain("may undercount");
  warnSpy.mockRestore();
});

// ------------------------------------------------------------
// Fix round 2, regression coverage: the ad-set read is now scoped to ONE
// `by_contact` query per DISTINCT contact in the CURRENT BATCH, not the
// whole account (see the read-bound comment above the ad-set construction
// in `backfillConversationStartedStats`). That bound must not resurface as
// a correctness regression: a `by_contact` read returns a contact's FULL
// referral history regardless of how that history relates to which
// conversations happen to share its batch, or which hop of a multi-batch
// chain is currently running. This test embeds the mixed-referral
// conversation from the test above inside a genuinely multi-hop chain,
// surrounded by unrelated conversations for OTHER contacts, with its
// determining ("post") referral close to its own creation but its
// non-determining ("ad") referral's timestamp falling well outside every
// conversation's creation window in the whole fixture — i.e. nothing about
// "the current batch's conversation window" could account for finding it.
// ------------------------------------------------------------

test('backfillConversationStartedStats: the earliest-referral rule survives a genuine multi-hop chain — a "post"-then-"ad" conversation among unrelated conversations for other contacts still resolves via its own contact\'s full history', async () => {
  vi.useFakeTimers();
  const t = convexTest(schema, modules);
  const baseHour = hourStartMs(Date.now());
  vi.setSystemTime(baseHour);
  const { accountId } = await seedAccountMember(t, {
    name: "A",
    email: "batch-spanning@x.com",
    role: "admin",
  });

  // Six unrelated, referral-free conversations for six DIFFERENT contacts,
  // two per hour across three hours, PLUS the mixed-referral conversation
  // (its own, seventh, contact) in the middle hour — so hour 1 ends up
  // with 3 conversations (2 filler + 1 mixed), forcing batchSize=4 below to
  // keep every full batch spanning >= 2 hours (the withhold-and-resume
  // path this test is about), and meaning the mixed-referral conversation
  // is not `batch[0]` of any hop: it is surrounded on both sides by other
  // contacts' history.
  //
  // Seeded in STRICT chronological order — filler0, filler1, THEN the
  // mixed conversation and its "post" referral, THEN filler2, filler3,
  // THEN filler4, filler5, THEN (last of all) the "ad" referral 10 days
  // later — because convex-test clamps `_creationTime` forward from the
  // previous insert (see the multi-batch test above), so inserting the
  // mixed conversation's earlier hour-1 timestamp AFTER filler2..filler5
  // (which are also hour 1/2) would silently clamp it into the wrong hour.
  await seedConversationAt(t, accountId, baseHour + 1000, "filler0");
  await seedConversationAt(t, accountId, baseHour + 2000, "filler1");

  const mixedAtMs = baseHour + HOUR_MS + 500;
  vi.setSystemTime(mixedAtMs);
  const { contactId: mixedContactId, conversationId: mixedConversationId } =
    await t.run(async (ctx) => {
      const contactId = await ctx.db.insert("contacts", {
        accountId,
        phone: "+19998887777",
        phoneNormalized: "19998887777",
      });
      const conversationId = await ctx.db.insert("conversations", {
        accountId,
        contactId,
        status: "open",
        unreadCount: 0,
        awaitingReply: true,
      });
      return { contactId, conversationId };
    });
  // Its EARLIEST referral: "post", moments after its own creation — well
  // within the fixture's H0..H2 conversation-creation span.
  vi.setSystemTime(mixedAtMs + 100);
  await t.run((ctx) =>
    ctx.db.insert("adReferrals", {
      accountId,
      contactId: mixedContactId,
      conversationId: mixedConversationId,
      waMessageId: "wamid.spanning.post",
      sourceType: "post",
      isFirstTouch: true,
    }),
  );

  await seedConversationAt(t, accountId, baseHour + HOUR_MS + 3000, "filler2");
  await seedConversationAt(t, accountId, baseHour + HOUR_MS + 4000, "filler3");
  await seedConversationAt(t, accountId, baseHour + 2 * HOUR_MS + 5000, "filler4");
  await seedConversationAt(t, accountId, baseHour + 2 * HOUR_MS + 6000, "filler5");

  // Its LATER referral: "ad", 10 days after the LAST conversation created
  // anywhere in this fixture — unambiguously outside any batch-of-
  // conversations' own creation window, so nothing about "which
  // conversations this hop happens to be processing" could explain finding
  // it. A per-contact `by_contact` read finds it anyway (and correctly
  // ignores it, since it is not the earliest).
  vi.setSystemTime(baseHour + 2 * HOUR_MS + 6000 + 10 * 24 * 60 * 60 * 1000);
  await t.run((ctx) =>
    ctx.db.insert("adReferrals", {
      accountId,
      contactId: mixedContactId,
      conversationId: mixedConversationId,
      waMessageId: "wamid.spanning.ad",
      sourceType: "ad",
      adId: "AD-SPANNING",
      isFirstTouch: false,
    }),
  );

  await t.mutation(internal.messages.backfillConversationStartedStats, {
    // 4, not 3: hour 1 ends up with exactly 3 conversations (2 filler + 1
    // mixed) below, and a batchSize that exactly matches a single hour's
    // count would coincidentally trip the single-hour-overflow path
    // instead of the withheld-partial-hour one — a different code path,
    // already covered by its own test above. 4 keeps every full batch
    // spanning >= 2 hours, exercising the withhold-and-resume path this
    // test is actually about.
    batchSize: 4,
  });
  await t.finishAllScheduledFunctions(vi.runAllTimers);

  const rows = await statsRowsFor(t, accountId);
  const totalStarted = rows.reduce((s, r) => s + (r.conversationsStarted ?? 0), 0);
  const totalAd = rows.reduce((s, r) => s + (r.conversationsStartedAd ?? 0), 0);
  // All 7 conversations (6 filler + 1 mixed-referral) are counted...
  expect(totalStarted).toBe(7);
  // ...but the mixed-referral conversation's EARLIEST referral was "post",
  // so it must not be the one conversation contributing to the ad total —
  // the whole chain must still resolve to zero ad-sourced conversations,
  // exactly as the single-hop version of this scenario does above.
  expect(totalAd).toBe(0);

  const mixedRow = rows.find((r) => r.hourStartMs === baseHour + HOUR_MS);
  expect(mixedRow?.conversationsStarted).toBe(3); // 2 filler + 1 mixed
  expect(mixedRow?.conversationsStartedAd ?? 0).toBe(0);
});

test("backfillResponseBuckets: a multi-batch chain resumes via cursorMs and reaches the same totals as a single-batch run", async () => {
  vi.useFakeTimers();
  const hour0 = hourStartMs(Date.now());
  const seedFiveHours = async (t: ReturnType<typeof convexTest>, accountId: Id<"accounts">) => {
    for (let i = 0; i < 5; i++) {
      await t.run((ctx) =>
        ctx.db.insert("messageHourlyStats", {
          accountId,
          hourStartMs: hour0 + i * HOUR_MS,
          incoming: 1,
          outgoing: 1,
          responseCount: 1,
          responseTotalMs: 30_000, // mean 30s -> "m1"
        }),
      );
    }
  };

  // batchSize=2 forces a 3-hop chain (2 + 2 + 1) over 5 legacy hours.
  const tMulti = convexTest(schema, modules);
  const multi = await seedAccountMember(tMulti, {
    name: "A",
    email: "rb-multibatch@x.com",
    role: "admin",
  });
  await seedFiveHours(tMulti, multi.accountId);
  await tMulti.mutation(internal.messages.backfillResponseBuckets, { batchSize: 2 });
  await tMulti.finishAllScheduledFunctions(vi.runAllTimers);
  const multiRows = await statsRowsFor(tMulti, multi.accountId);

  const tSingle = convexTest(schema, modules);
  const single = await seedAccountMember(tSingle, {
    name: "B",
    email: "rb-singlebatch@x.com",
    role: "admin",
  });
  await seedFiveHours(tSingle, single.accountId);
  await tSingle.mutation(internal.messages.backfillResponseBuckets, {});
  await tSingle.finishAllScheduledFunctions(vi.runAllTimers);
  const singleRows = await statsRowsFor(tSingle, single.accountId);

  const expected = { ...emptyResponseBuckets(), m1: 1 };
  // Every one of the 5 hours got its bucket, in BOTH runs — none skipped
  // or double-visited by the cursor crossing a batch boundary.
  expect(multiRows).toHaveLength(5);
  expect(singleRows).toHaveLength(5);
  for (const row of multiRows) expect(row.responseBuckets).toEqual(expected);
  for (const row of singleRows) expect(row.responseBuckets).toEqual(expected);
});

test("backfillResponseBuckets places a legacy hour's whole sample count in the bucket its stored mean falls into", async () => {
  vi.useFakeTimers();
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountMember(t, {
    name: "A",
    email: "mean-bucket@x.com",
    role: "admin",
  });
  const hour = hourStartMs(Date.now());
  await t.run((ctx) =>
    ctx.db.insert("messageHourlyStats", {
      accountId,
      hourStartMs: hour,
      incoming: 4,
      outgoing: 4,
      responseCount: 4,
      responseTotalMs: 4 * 2 * 60_000, // mean = 2 minutes -> "m5" bucket
    }),
  );

  await t.mutation(internal.messages.backfillResponseBuckets, {});
  await t.finishAllScheduledFunctions(vi.runAllTimers);

  const row = await t.run((ctx) =>
    ctx.db
      .query("messageHourlyStats")
      .withIndex("by_account_hour", (q) =>
        q.eq("accountId", accountId).eq("hourStartMs", hour),
      )
      .unique(),
  );
  expect(row?.responseBuckets).toEqual({ ...emptyResponseBuckets(), m5: 4 });
});

test("backfillResponseBuckets never overwrites an hour that already has an exact histogram", async () => {
  vi.useFakeTimers();
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountMember(t, {
    name: "A",
    email: "exact-histogram@x.com",
    role: "admin",
  });
  const hour = hourStartMs(Date.now());
  // The mean of responseTotalMs/responseCount below is 90 minutes, which
  // would land in "m240" if estimated — deliberately far from the real
  // histogram, so a wrongful overwrite would be unmistakable.
  const exactHistogram = { ...emptyResponseBuckets(), m1: 2, over: 1 };
  await t.run((ctx) =>
    ctx.db.insert("messageHourlyStats", {
      accountId,
      hourStartMs: hour,
      incoming: 3,
      outgoing: 3,
      responseCount: 3,
      responseTotalMs: 3 * 90 * 60_000,
      responseBuckets: exactHistogram,
    }),
  );

  await t.mutation(internal.messages.backfillResponseBuckets, {});
  await t.finishAllScheduledFunctions(vi.runAllTimers);

  const row = await t.run((ctx) =>
    ctx.db
      .query("messageHourlyStats")
      .withIndex("by_account_hour", (q) =>
        q.eq("accountId", accountId).eq("hourStartMs", hour),
      )
      .unique(),
  );
  expect(row?.responseBuckets).toEqual(exactHistogram);
});

// Two accounts, sharing the exact same legacy `hourStartMs` — the scenario
// that would silently drop or re-read rows under a cursor compared globally
// across accounts (see `backfillResponseBuckets`'s own comment on why it
// walks per-account). Account A's single row is a partial batch (1 < 500),
// so completing it schedules a genuine hop to account B, and the whole
// two-account chain is run twice to prove convergence, not just one
// synchronous pass.
test("backfillResponseBuckets is idempotent across a genuine self-scheduling hop between accounts sharing the same legacy hour", async () => {
  vi.useFakeTimers();
  const t = convexTest(schema, modules);
  const a = await seedAccountMember(t, { name: "A", email: "hop-ra@x.com", role: "admin" });
  const b = await seedAccountMember(t, { name: "B", email: "hop-rb@x.com", role: "admin" });
  const hour = hourStartMs(Date.now());
  for (const { accountId } of [a, b]) {
    await t.run((ctx) =>
      ctx.db.insert("messageHourlyStats", {
        accountId,
        hourStartMs: hour,
        incoming: 1,
        outgoing: 1,
        responseCount: 1,
        responseTotalMs: 30_000, // mean = 30s -> "m1"
      }),
    );
  }

  const runAll = async () => {
    await t.mutation(internal.messages.backfillResponseBuckets, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
  };
  const bucketsFor = async (accountId: Id<"accounts">) =>
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("messageHourlyStats")
        .withIndex("by_account_hour", (q) =>
          q.eq("accountId", accountId).eq("hourStartMs", hour),
        )
        .unique();
      return row?.responseBuckets;
    });
  const expected = { ...emptyResponseBuckets(), m1: 1 };

  await runAll();
  expect(await bucketsFor(a.accountId)).toEqual(expected);
  expect(await bucketsFor(b.accountId)).toEqual(expected);

  await runAll();
  expect(await bucketsFor(a.accountId)).toEqual(expected);
  expect(await bucketsFor(b.accountId)).toEqual(expected);
});

// ============================================================
// Active conversations — distinct threads with traffic, deduped per UTC day
//
// THE property this whole design exists for. A per-HOUR dedup passes the
// naive "twice in one hour" case and is still wrong; the first test below is
// what distinguishes them: distinct counts are not additive across hourly
// buckets, so summing an hourly dedup into a day would yield
// conversation-HOURS and could exceed the account's total conversation
// count. See `bumpActiveConversationStat` and `conversations.lastActiveDayMs`
// in messages.ts/schema.ts.
// ============================================================

test("a thread messaged across several hours of one UTC day counts once", async () => {
  const t = convexTest(schema, modules);
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const dayStart = Date.parse("2026-08-06T00:00:00.000Z");
    vi.setSystemTime(dayStart + 2 * HOUR_MS);
    const { accountId, conversationId } = await seedThread(t, "a@x.com");

    for (const offsetHours of [2, 5, 9, 17]) {
      vi.setSystemTime(dayStart + offsetHours * HOUR_MS);
      await t.mutation(internal.messages.appendInternal, {
        accountId,
        conversationId,
        senderType: offsetHours % 2 === 0 ? "customer" : "agent",
        contentType: "text",
        contentText: `msg ${offsetHours}`,
      });
    }

    const total = await t.run(async (ctx) => {
      const rows = await ctx.db
        .query("messageHourlyStats")
        .withIndex("by_account_hour", (q) => q.eq("accountId", accountId))
        .collect();
      return rows.reduce((s, r) => s + (r.activeConversations ?? 0), 0);
    });
    expect(total).toBe(1);
  } finally {
    vi.useRealTimers();
  }
});

test("the increment lands on the hour of the day's FIRST message", async () => {
  const t = convexTest(schema, modules);
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const dayStart = Date.parse("2026-08-06T00:00:00.000Z");
    const firstAt = dayStart + 3 * HOUR_MS;
    vi.setSystemTime(firstAt);
    const { accountId, conversationId } = await seedThread(t, "b@x.com");

    await t.mutation(internal.messages.appendInternal, {
      accountId, conversationId, senderType: "customer",
      contentType: "text", contentText: "first",
    });
    vi.setSystemTime(dayStart + 11 * HOUR_MS);
    await t.mutation(internal.messages.appendInternal, {
      accountId, conversationId, senderType: "agent",
      contentType: "text", contentText: "later",
    });

    const row = await t.run(async (ctx) =>
      ctx.db
        .query("messageHourlyStats")
        .withIndex("by_account_hour", (q) =>
          q.eq("accountId", accountId).eq("hourStartMs", hourStartMs(firstAt)),
        )
        .unique(),
    );
    expect(row?.activeConversations).toBe(1);
  } finally {
    vi.useRealTimers();
  }
});

// The marker must not latch permanently.
test("the same thread counts again the next UTC day", async () => {
  const t = convexTest(schema, modules);
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const dayStart = Date.parse("2026-08-06T00:00:00.000Z");
    vi.setSystemTime(dayStart + HOUR_MS);
    const { accountId, conversationId } = await seedThread(t, "c@x.com");

    for (const at of [dayStart + HOUR_MS, dayStart + DAY_MS + HOUR_MS]) {
      vi.setSystemTime(at);
      await t.mutation(internal.messages.appendInternal, {
        accountId, conversationId, senderType: "customer",
        contentType: "text", contentText: "hi",
      });
    }

    const total = await t.run(async (ctx) => {
      const rows = await ctx.db
        .query("messageHourlyStats")
        .withIndex("by_account_hour", (q) => q.eq("accountId", accountId))
        .collect();
      return rows.reduce((s, r) => s + (r.activeConversations ?? 0), 0);
    });
    expect(total).toBe(2);
  } finally {
    vi.useRealTimers();
  }
});

// `seedThread` mints a fresh ACCOUNT per call (see its own comment above),
// so two calls would land in different `messageHourlyStats` rollups and this
// test would trivially pass by only ever seeing one of them. Adapted to seed
// both threads under one account instead, via the same
// seedThread-plus-manual-second-conversation pattern already used by "each
// conversation keeps its own reply clock" above.
test("two different threads in one day count separately", async () => {
  const t = convexTest(schema, modules);
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const dayStart = Date.parse("2026-08-06T00:00:00.000Z");
    vi.setSystemTime(dayStart + HOUR_MS);
    const { accountId, conversationId: first } = await seedThread(t, "d@x.com");
    const secondContactId = await t.run((ctx) =>
      ctx.db.insert("contacts", {
        accountId,
        phone: "+2",
        phoneNormalized: "2",
      }),
    );
    const second = await seedConversation(t, { accountId, contactId: secondContactId });

    for (const conversationId of [first, second]) {
      await t.mutation(internal.messages.appendInternal, {
        accountId,
        conversationId,
        senderType: "customer",
        contentType: "text",
        contentText: "hi",
      });
    }

    const total = await t.run(async (ctx) => {
      const rows = await ctx.db
        .query("messageHourlyStats")
        .withIndex("by_account_hour", (q) => q.eq("accountId", accountId))
        .collect();
      return rows.reduce((s, r) => s + (r.activeConversations ?? 0), 0);
    });
    expect(total).toBe(2);
  } finally {
    vi.useRealTimers();
  }
});

// ============================================================
// backfillActiveConversationStats (Task 3)
//
// One-shot backfill that rebuilds `activeConversations` from message
// history that predates the live write path tested just above
// (`bumpActiveConversationStat` / `conversations.lastActiveDayMs`). Same
// batched, self-scheduling, cursor-threaded, SET-not-increment shape as
// `backfillConversationStartedStats` — see that function's own comment in
// messages.ts for the shared idempotence argument — plus one structural
// difference: this backfill withholds the final partial UTC DAY of a batch
// rather than the final partial HOUR, because day-level distinctness (not
// hour-level) is what `activeConversations` needs.
//
// WHAT THE WITHHOLD ACTUALLY BUYS (fix round 1 correction to the reasoning
// this section originally shipped with): for a chain that runs to
// COMPLETION, the withhold is provably redundant. `resumeFrom` always
// rewinds to the withheld day's exact start; `by_account` reads
// `[accountId, _creationTime]` in chronological order, so an earlier
// batch's view of a day is always a strict PREFIX of the full day; a
// conversation's earliest-hour-of-the-day is invariant under prefix
// extension; and every write is a SET. So the fuller, later view always
// reconfirms or extends a premature write — never contradicts it.
// Confirmed empirically: mutating `daysToWrite` to always include the
// trailing day does not change any *completed* chain's final totals
// anywhere in this file.
//
// It IS load-bearing for a chain that STOPS partway through. Without the
// withhold, an interrupted run leaves a partially-measured day persisted as
// though it were complete — silently wrong history, with no signal that
// anything is missing. That is what the second test below actually
// discriminates: it checks the withheld day's state is ABSENT immediately
// after the batch that only partly saw it, not merely that the numbers come
// out right once the whole chain has finished. (Confirmed: reverting
// `daysToWrite` to always-inclusive makes that specific assertion fail —
// see its own comment.)
// ============================================================

/** Inserts a message at exactly `atMs` for `conversationId` — the way the
 *  multi-batch tests below need precise control over which UTC day (and
 *  which position within a batch) each message lands in. Mirrors
 *  `seedConversationAt` above: same idea, for messages instead of
 *  conversations, since this backfill batches over `messages`, not
 *  `conversations`. */
async function seedMessageAt(
  t: ReturnType<typeof convexTest>,
  accountId: Id<"accounts">,
  conversationId: Id<"conversations">,
  atMs: number,
) {
  vi.setSystemTime(atMs);
  await t.run((ctx) =>
    ctx.db.insert("messages", {
      accountId,
      conversationId,
      senderType: "customer",
      contentType: "text",
      status: "sent",
    }),
  );
}

/** Inserts `n` contact+conversation pairs under `accountId` and returns
 *  their conversation ids, in insertion order. `tag` only needs to keep
 *  `phone`/`phoneNormalized` distinct across calls within one test. */
async function seedConversations(
  t: ReturnType<typeof convexTest>,
  accountId: Id<"accounts">,
  n: number,
  tag: string,
): Promise<Id<"conversations">[]> {
  const ids: Id<"conversations">[] = [];
  for (let i = 0; i < n; i++) {
    const contactId = await t.run((ctx) =>
      ctx.db.insert("contacts", {
        accountId,
        phone: `+1888${tag}${i}`,
        phoneNormalized: `1888${tag}${i}`,
      }),
    );
    ids.push(await seedConversation(t, { accountId, contactId }));
  }
  return ids;
}

test("backfillActiveConversationStats: idempotency holds across a genuine self-scheduling chain, not just a single-batch call repeated", async () => {
  vi.useFakeTimers();
  const t = convexTest(schema, modules);
  const baseDay = utcDayStartMs(Date.now());
  vi.setSystemTime(baseDay);
  const { accountId } = await seedAccountMember(t, {
    name: "A",
    email: "idempotent-chain@x.com",
    role: "admin",
  });
  // Two conversations per day, three days: with batchSize=3 below, no
  // single day (2 messages) ever fills a whole batch by itself, so every
  // full batch spans >= 2 days and self-schedules a real hop through
  // `ctx.scheduler.runAfter` — unlike the version of this test fix round 1
  // flagged, which seeded 5 messages against the default (1000) batch size
  // and so never scheduled anything: `finishAllScheduledFunctions` had
  // nothing to wait for, and "idempotent" was only ever proven for a
  // single synchronous call issued twice.
  const [c1, c2] = await seedConversations(t, accountId, 2, "ic");
  for (const dayOffset of [0, 1, 2]) {
    await seedMessageAt(t, accountId, c1, baseDay + dayOffset * DAY_MS + HOUR_MS);
    await seedMessageAt(t, accountId, c2, baseDay + dayOffset * DAY_MS + 5 * HOUR_MS);
  }

  const runAll = async () => {
    await t.mutation(internal.messages.backfillActiveConversationStats, {
      batchSize: 3,
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
  };
  const byHour = async () => {
    const rows = await statsRowsFor(t, accountId);
    return Object.fromEntries(
      rows.map((r) => [r.hourStartMs, r.activeConversations ?? 0]),
    );
  };
  const expected = {
    [baseDay + HOUR_MS]: 1,
    [baseDay + 5 * HOUR_MS]: 1,
    [baseDay + DAY_MS + HOUR_MS]: 1,
    [baseDay + DAY_MS + 5 * HOUR_MS]: 1,
    [baseDay + 2 * DAY_MS + HOUR_MS]: 1,
    [baseDay + 2 * DAY_MS + 5 * HOUR_MS]: 1,
  };

  await runAll();
  expect(await byHour()).toEqual(expected);
  // Converges rather than doubling — the property that makes a resumable
  // backfill safe to re-trigger after an interruption. Proven here across a
  // REAL multi-hop chain (three self-scheduled hops — see the identical
  // fixture shape's hop-by-hop trace in the test right below), not a single
  // synchronous call that never touches the scheduler at all.
  await runAll();
  expect(await byHour()).toEqual(expected);
});

test("backfillActiveConversationStats: a multi-batch chain resumes via cursorMs, leaves the withheld day ABSENT (not partial) until fully observed, and reaches the same per-hour totals as a single-batch run", async () => {
  vi.useFakeTimers();
  const baseDay = utcDayStartMs(Date.now());
  // Two conversations per day, three days — with batchSize=3 below, no
  // single day ever fills a whole batch by itself (2 < 3), so every full
  // batch spans >= 2 days and takes the withhold-the-last-day branch, not
  // the single-day-overflow one (that path is covered separately below).
  const seedSixMessages = async (
    t: ReturnType<typeof convexTest>,
    accountId: Id<"accounts">,
  ) => {
    const [c1, c2] = await seedConversations(t, accountId, 2, "mb");
    for (const dayOffset of [0, 1, 2]) {
      await seedMessageAt(t, accountId, c1, baseDay + dayOffset * DAY_MS + HOUR_MS);
      await seedMessageAt(t, accountId, c2, baseDay + dayOffset * DAY_MS + 5 * HOUR_MS);
    }
  };
  const expectedFinal = {
    [baseDay + HOUR_MS]: 1,
    [baseDay + 5 * HOUR_MS]: 1,
    [baseDay + DAY_MS + HOUR_MS]: 1,
    [baseDay + DAY_MS + 5 * HOUR_MS]: 1,
    [baseDay + 2 * DAY_MS + HOUR_MS]: 1,
    [baseDay + 2 * DAY_MS + 5 * HOUR_MS]: 1,
  };

  // --- Multi-batch run: batchSize=3 forces a 3-hop chain (batch 1: days
  // [0,1] partial, withholds day 1; batch 2: days [1,2] partial, withholds
  // day 2; batch 3: day 2 only, not a full batch, terminates). ---
  const tMulti = convexTest(schema, modules);
  // Pinned explicitly — see the identical pin (and its full explanation) in
  // `backfillConversationStartedStats: a multi-batch chain resumes via
  // cursorMs...` above, which this test mirrors.
  vi.setSystemTime(baseDay);
  const multi = await seedAccountMember(tMulti, {
    name: "A",
    email: "multibatch-day@x.com",
    role: "admin",
  });
  await seedSixMessages(tMulti, multi.accountId);

  // Run only the FIRST batch directly (not through the scheduler), so the
  // withheld day's absence can be observed before the chain continues —
  // proving it wasn't written prematurely (partial), not just that it
  // eventually arrives correct. THIS is the property that matters for an
  // INTERRUPTED backfill: a chain that stops right here must not leave the
  // second day's history silently (and undetectably) wrong.
  await tMulti.mutation(internal.messages.backfillActiveConversationStats, {
    batchSize: 3,
  });
  const afterFirstBatch = await statsRowsFor(tMulti, multi.accountId);
  const afterFirstByHour = Object.fromEntries(
    afterFirstBatch.map((r) => [r.hourStartMs, r.activeConversations ?? 0]),
  );
  expect(afterFirstByHour).toEqual({
    [baseDay + HOUR_MS]: 1,
    [baseDay + 5 * HOUR_MS]: 1,
  });
  // Not zero, not a partial count — the second day's buckets do not exist
  // as rows at all yet. (Reverting `daysToWrite` to
  // `new Set(sortedDays)` unconditionally makes these two assertions fail:
  // both hours below flip to existing, with `activeConversations: 1`, one
  // batch before the chain has actually seen the rest of that day.)
  expect(
    afterFirstBatch.some((r) => r.hourStartMs === baseDay + DAY_MS + HOUR_MS),
  ).toBe(false);
  expect(
    afterFirstBatch.some((r) => r.hourStartMs === baseDay + DAY_MS + 5 * HOUR_MS),
  ).toBe(false);

  // Drain the rest of the chain (day 1 gets written on the second hop, day
  // 2 on the third).
  await tMulti.finishAllScheduledFunctions(vi.runAllTimers);
  const multiRows = await statsRowsFor(tMulti, multi.accountId);
  const multiByHour = Object.fromEntries(
    multiRows.map((r) => [r.hourStartMs, r.activeConversations ?? 0]),
  );
  expect(multiByHour).toEqual(expectedFinal);

  // --- Single-batch run: identical fixture, default (large) batchSize, so
  // all 6 messages land in one pass with no withholding at all. ---
  const tSingle = convexTest(schema, modules);
  vi.setSystemTime(baseDay);
  const single = await seedAccountMember(tSingle, {
    name: "B",
    email: "singlebatch-day@x.com",
    role: "admin",
  });
  await seedSixMessages(tSingle, single.accountId);
  await tSingle.mutation(internal.messages.backfillActiveConversationStats, {});
  await tSingle.finishAllScheduledFunctions(vi.runAllTimers);
  const singleRows = await statsRowsFor(tSingle, single.accountId);
  const singleByHour = Object.fromEntries(
    singleRows.map((r) => [r.hourStartMs, r.activeConversations ?? 0]),
  );

  // Same shape, same numbers, regardless of how many batches it took to
  // get there.
  expect(singleByHour).toEqual(expectedFinal);
});

test("backfillActiveConversationStats: single-day-overflow writes what it measured and steps past the day, rather than looping forever", async () => {
  vi.useFakeTimers();
  const day = utcDayStartMs(Date.now());
  // Pinned to the day's exact start BEFORE the first insert of any kind —
  // see the identical pin (and its full explanation) on the multi-batch
  // test above. Without it, `seedAccountMember` below inserts at whatever
  // the ambient real "now" happens to be (e.g. mid-morning UTC), and every
  // `seedMessageAt` call for an EARLIER hour of `day` (1am, 4am, 7am UTC)
  // would then be moving system time BACKWARDS relative to already-inserted
  // docs — convex-test's `_creationTime` ratchet silently clamps that
  // forward instead of honoring it, collapsing several intended hours into
  // one and invalidating this test's whole premise.
  vi.setSystemTime(day);
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountMember(t, {
    name: "A",
    email: "day-overflow@x.com",
    role: "admin",
  });

  // FIVE conversations, each with its own single message on the SAME day,
  // with batchSize=2: the very first batch this backfill can ever take is
  // entirely one day — from inside that batch, indistinguishable from a day
  // with far more than `batchSize` distinct conversations. That is exactly
  // the shape the overflow guard exists to terminate rather than loop on
  // forever (withholding would rewind the cursor to where it already is).
  const convs = await seedConversations(t, accountId, 5, "ov");
  const hours = [1, 4, 7, 12, 19];
  for (let i = 0; i < convs.length; i++) {
    await seedMessageAt(t, accountId, convs[i]!, day + hours[i]! * HOUR_MS);
  }
  // A second day, one more (different) conversation — proves the
  // overflow-skip on day 1 doesn't also corrupt whatever comes after it.
  const [c5] = await seedConversations(t, accountId, 1, "ov2");
  await seedMessageAt(t, accountId, c5!, day + DAY_MS + 3 * HOUR_MS);

  const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  await t.mutation(internal.messages.backfillActiveConversationStats, {
    batchSize: 2,
  });
  await t.finishAllScheduledFunctions(vi.runAllTimers);

  const rows = await statsRowsFor(t, accountId);
  const byHour = Object.fromEntries(
    rows.map((r) => [r.hourStartMs, r.activeConversations ?? 0]),
  );
  // Only the first `batchSize` (2) conversations the backfill ever saw for
  // the overflowing day are counted — the messages at hours 7/12/19 (3
  // more DISTINCT conversations) are never read at all, because
  // `resumeFrom` jumps a full day past them once overflow is detected.
  // This is the KNOWN, documented undercount: day 1's TRUE distinct count
  // is 5, not 2. Pinned here as the accepted tradeoff the code's own
  // comment and console.warn describe (not something either side quietly
  // adjusted to match), and to catch a future change that accidentally
  // makes this loop instead of terminate. Day 2 is entirely unaffected.
  expect(byHour).toEqual({
    [day + HOUR_MS]: 1,
    [day + 4 * HOUR_MS]: 1,
    [day + DAY_MS + 3 * HOUR_MS]: 1,
  });
  expect(warnSpy).toHaveBeenCalledTimes(1);
  expect(warnSpy.mock.calls[0]![0]).toContain("may undercount");
  warnSpy.mockRestore();
});

// This is the divergence class that shipped a bug on the previous branch,
// where the live rule and the rebuild rule quietly disagreed and both
// looked plausible. Drive identical traffic through both routes and assert
// identical PER-HOUR MAPS (not just a summed total, which cannot tell
// per-conversation dedup apart from "days with any traffic" and cannot
// catch a divergence in WHICH hour gets credited), across TWO conversations
// with overlapping days so a mixup between them would be visible.
test("backfill totals equal what the live write path produces, hour-for-hour, across two conversations with overlapping days", async () => {
  const dayStart = Date.parse("2026-08-06T00:00:00.000Z");
  // Chronologically interleaved traffic for two conversations, both active
  // on BOTH UTC days but always at DIFFERENT hours from each other.
  const traffic: Array<{ h: number; who: "c1" | "c2" }> = [
    { h: 1, who: "c1" },
    { h: 3, who: "c2" },
    { h: 4, who: "c1" },
    { h: 4, who: "c1" },
    { h: 9, who: "c1" },
    { h: 26, who: "c1" },
    { h: 27, who: "c1" },
    { h: 30, who: "c2" },
  ];
  const expectedByHour = {
    [dayStart + 1 * HOUR_MS]: 1,
    [dayStart + 3 * HOUR_MS]: 1,
    [dayStart + 26 * HOUR_MS]: 1,
    [dayStart + 30 * HOUR_MS]: 1,
  };

  // The LIVE path's single `insert("messages")` choke point also runs
  // `recordMessageInHourlyStats` (unrelated incoming/outgoing counters), so
  // it writes a `messageHourlyStats` row for EVERY message's hour, not just
  // the hours that earn an `activeConversations` credit — those extra rows
  // carry `activeConversations: undefined`. The backfill never creates such
  // a row (it only ever writes hours it has a count for), so comparing raw
  // `statsRowsFor` output between the two paths would fail on those
  // incidental rows for a reason that has nothing to do with this counter.
  // Filtering to genuinely-credited hours on BOTH sides keeps the
  // comparison about what this test is actually for.
  const activeHoursOf = (rows: Awaited<ReturnType<typeof statsRowsFor>>) =>
    Object.fromEntries(
      rows
        .filter((r) => (r.activeConversations ?? 0) > 0)
        .map((r) => [r.hourStartMs, r.activeConversations!]),
    );

  const runLive = async () => {
    const t = convexTest(schema, modules);
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(dayStart);
      const { accountId, conversationId: c1 } = await seedThread(t, "live2@x.com");
      const contact2 = await t.run((ctx) =>
        ctx.db.insert("contacts", {
          accountId, phone: "+971500000902", phoneNormalized: "971500000902",
        }),
      );
      const c2 = await seedConversation(t, { accountId, contactId: contact2 });
      for (const { h, who } of traffic) {
        vi.setSystemTime(dayStart + h * HOUR_MS);
        await t.mutation(internal.messages.appendInternal, {
          accountId, conversationId: who === "c1" ? c1 : c2,
          senderType: "customer", contentType: "text", contentText: "x",
        });
      }
      return activeHoursOf(await statsRowsFor(t, accountId));
    } finally {
      vi.useRealTimers();
    }
  };

  const runBackfilled = async () => {
    const t = convexTest(schema, modules);
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(dayStart);
      const { accountId } = await seedAccountMember(t, {
        name: "A",
        email: "bf2@x.com",
        role: "admin",
      });
      const [c1, c2] = await seedConversations(t, accountId, 2, "bf2");
      for (const { h, who } of traffic) {
        await seedMessageAt(t, accountId, who === "c1" ? c1 : c2, dayStart + h * HOUR_MS);
      }
      await t.mutation(internal.messages.backfillActiveConversationStats, {});
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      return activeHoursOf(await statsRowsFor(t, accountId));
    } finally {
      vi.useRealTimers();
    }
  };

  const live = await runLive();
  const backfilled = await runBackfilled();
  expect(live).toEqual(expectedByHour); // one per conversation per UTC day
  expect(backfilled).toEqual(live);
});
