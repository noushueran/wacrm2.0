/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import type { AccountRole } from "./lib/roles";

// Convex function modules for convex-test to resolve `api.*` references
// against. Absolute, from-project-root pattern (matches
// `convex/conversations.test.ts`/`convex/messages.test.ts` — see those
// files' comments for why this must be absolute rather than a relative
// "./**").
const modules = import.meta.glob("/convex/**/*.ts");

/**
 * Seeds a `users` row + an `accounts`/`memberships` row for a fresh
 * account, and returns a convex-test client already authenticated as
 * that user. Duplicated from `convex/conversations.test.ts`/
 * `convex/messages.test.ts` rather than imported — each `convex/*.test.ts`
 * suite owns its own copy of this helper (see those files' own comments
 * on `seedAccountMember`). Bypasses `accounts.bootstrapAccount` on
 * purpose — this suite tests `reactions.ts`, not the bootstrap flow.
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
 * `convex/messages.test.ts`'s own `seedConversation` — this suite's
 * messages need a parent conversation, but exercising
 * `conversations.findOrCreateForContact` for that is out of scope here.
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

// ============================================================
// set — upsert keyed by (messageId, actorType, actorId)
// ============================================================

test("set inserts a new reaction row scoped to the caller's own account", async () => {
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
  const messageId = await asUser.mutation(api.messages.append, {
    conversationId,
    senderType: "customer",
    contentType: "text",
    contentText: "Hi",
  });

  const reactionId = await asUser.mutation(api.reactions.set, {
    messageId,
    emoji: "👍",
    actorType: "agent",
    actorId: userId,
  });

  const row = await t.run((ctx) => ctx.db.get(reactionId));
  expect(row).not.toBeNull();
  expect(row!.accountId).toBe(accountId);
  expect(row!.messageId).toBe(messageId);
  expect(row!.conversationId).toBe(conversationId);
  expect(row!.actorType).toBe("agent");
  expect(row!.actorId).toBe(userId);
  expect(row!.emoji).toBe("👍");
});

test("set twice for the same (message, actor) patches the emoji on one row instead of creating a second", async () => {
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
  const messageId = await asUser.mutation(api.messages.append, {
    conversationId,
    senderType: "customer",
    contentType: "text",
    contentText: "Hi",
  });

  const firstId = await asUser.mutation(api.reactions.set, {
    messageId,
    emoji: "👍",
    actorType: "agent",
    actorId: userId,
  });
  const secondId = await asUser.mutation(api.reactions.set, {
    messageId,
    emoji: "❤️",
    actorType: "agent",
    actorId: userId,
  });

  expect(secondId).toBe(firstId);

  const rows = await t.run((ctx) =>
    ctx.db
      .query("messageReactions")
      .withIndex("by_message", (q) => q.eq("messageId", messageId))
      .collect(),
  );
  expect(rows).toHaveLength(1);
  expect(rows[0]!.emoji).toBe("❤️");
});

test("set upserts correctly when actorId is omitted (an actor identified by actorType alone)", async () => {
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
  const messageId = await asUser.mutation(api.messages.append, {
    conversationId,
    senderType: "customer",
    contentType: "text",
    contentText: "Hi",
  });

  const firstId = await asUser.mutation(api.reactions.set, {
    messageId,
    emoji: "👍",
    actorType: "customer",
  });
  const secondId = await asUser.mutation(api.reactions.set, {
    messageId,
    emoji: "🎉",
    actorType: "customer",
  });

  expect(secondId).toBe(firstId);
  const row = await t.run((ctx) => ctx.db.get(firstId));
  expect(row!.emoji).toBe("🎉");
  expect(row!.actorId).toBeUndefined();
});

test("different actors reacting to the same message each get their own row", async () => {
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
  const messageId = await asUser.mutation(api.messages.append, {
    conversationId,
    senderType: "customer",
    contentType: "text",
    contentText: "Hi",
  });

  await asUser.mutation(api.reactions.set, {
    messageId,
    emoji: "👍",
    actorType: "agent",
    actorId: userId,
  });
  // The contact themself reacting too — a distinct actor distinguished
  // from the agent above purely by (actorType, actorId), not a separate
  // messageId.
  await asUser.mutation(api.reactions.set, {
    messageId,
    emoji: "😀",
    actorType: "customer",
    actorId: contactId,
  });

  const rows = await asUser.query(api.reactions.forMessage, { messageId });
  expect(rows).toHaveLength(2);
});

// ============================================================
// remove
// ============================================================

test("remove deletes the matching reaction row", async () => {
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
  const messageId = await asUser.mutation(api.messages.append, {
    conversationId,
    senderType: "customer",
    contentType: "text",
    contentText: "Hi",
  });
  const reactionId = await asUser.mutation(api.reactions.set, {
    messageId,
    emoji: "👍",
    actorType: "agent",
    actorId: userId,
  });

  await asUser.mutation(api.reactions.remove, {
    messageId,
    actorType: "agent",
    actorId: userId,
  });

  const row = await t.run((ctx) => ctx.db.get(reactionId));
  expect(row).toBeNull();
});

test("remove is a no-op when no reaction exists for that actor", async () => {
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
  const messageId = await asUser.mutation(api.messages.append, {
    conversationId,
    senderType: "customer",
    contentType: "text",
    contentText: "Hi",
  });

  // Convex normalizes an explicit no-return-value mutation result to
  // `null` over the wire (no `undefined` in JSON) — same treatment
  // `contacts.unassignTag`'s own no-op-delete path gets.
  await expect(
    asUser.mutation(api.reactions.remove, {
      messageId,
      actorType: "agent",
      actorId: userId,
    }),
  ).resolves.toBeNull();
});

// ============================================================
// forMessage
// ============================================================

test("forMessage returns only the given message's reactions", async () => {
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
  const messageId = await asUser.mutation(api.messages.append, {
    conversationId,
    senderType: "customer",
    contentType: "text",
    contentText: "first",
  });
  const otherMessageId = await asUser.mutation(api.messages.append, {
    conversationId,
    senderType: "customer",
    contentType: "text",
    contentText: "second",
  });
  await asUser.mutation(api.reactions.set, {
    messageId,
    emoji: "👍",
    actorType: "agent",
    actorId: userId,
  });
  await asUser.mutation(api.reactions.set, {
    messageId: otherMessageId,
    emoji: "😀",
    actorType: "agent",
    actorId: userId,
  });

  const result = await asUser.query(api.reactions.forMessage, { messageId });

  expect(result).toHaveLength(1);
  expect(result[0]!.messageId).toBe(messageId);
  expect(result[0]!.emoji).toBe("👍");
});

// ============================================================
// cross-account denial — account B cannot set/remove/read reactions on
// account A's message
// ============================================================

test("set/remove/forMessage all throw NOT_FOUND for a message belonging to a different account, and no row is created", async () => {
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
  const messageId = await asAlice.mutation(api.messages.append, {
    conversationId,
    senderType: "customer",
    contentType: "text",
    contentText: "Alice's message",
  });

  await expect(
    asBob.mutation(api.reactions.set, {
      messageId,
      emoji: "👍",
      actorType: "agent",
      actorId: bobUserId,
    }),
  ).rejects.toMatchObject({ data: { code: "NOT_FOUND", entity: "message" } });

  await expect(
    asBob.mutation(api.reactions.remove, {
      messageId,
      actorType: "agent",
      actorId: bobUserId,
    }),
  ).rejects.toMatchObject({ data: { code: "NOT_FOUND", entity: "message" } });

  await expect(
    asBob.query(api.reactions.forMessage, { messageId }),
  ).rejects.toMatchObject({ data: { code: "NOT_FOUND", entity: "message" } });

  const rows = await t.run((ctx) =>
    ctx.db
      .query("messageReactions")
      .withIndex("by_message", (q) => q.eq("messageId", messageId))
      .collect(),
  );
  expect(rows).toHaveLength(0);

  // Alice herself can still react — proves the throws above are really
  // about cross-account isolation, not broken mutations.
  await asAlice.mutation(api.reactions.set, {
    messageId,
    emoji: "👍",
    actorType: "agent",
    actorId: bobUserId,
  });
});

// ============================================================
// forConversation
// ============================================================

test("forConversation returns only the given conversation's reactions", async () => {
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
  const otherConversationId = await seedConversation(t, {
    accountId,
    contactId,
  });
  const messageId = await asUser.mutation(api.messages.append, {
    conversationId,
    senderType: "customer",
    contentType: "text",
    contentText: "first",
  });
  const otherMessageId = await asUser.mutation(api.messages.append, {
    conversationId,
    senderType: "customer",
    contentType: "text",
    contentText: "second",
  });
  const otherConversationMessageId = await asUser.mutation(
    api.messages.append,
    {
      conversationId: otherConversationId,
      senderType: "customer",
      contentType: "text",
      contentText: "elsewhere",
    },
  );

  await asUser.mutation(api.reactions.set, {
    messageId,
    emoji: "👍",
    actorType: "agent",
    actorId: userId,
  });
  await asUser.mutation(api.reactions.set, {
    messageId: otherMessageId,
    emoji: "😀",
    actorType: "agent",
    actorId: userId,
  });
  await asUser.mutation(api.reactions.set, {
    messageId: otherConversationMessageId,
    emoji: "🎉",
    actorType: "agent",
    actorId: userId,
  });

  const result = await asUser.query(api.reactions.forConversation, {
    conversationId,
  });

  expect(result).toHaveLength(2);
  expect(result.map((r) => r.emoji).sort()).toEqual(["👍", "😀"].sort());
  for (const row of result) {
    expect(row.conversationId).toBe(conversationId);
  }
});

test("forConversation throws NOT_FOUND for a conversation belonging to a different account", async () => {
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
    asBob.query(api.reactions.forConversation, { conversationId }),
  ).rejects.toMatchObject({
    data: { code: "NOT_FOUND", entity: "conversation" },
  });

  // Positive control.
  const alicesView = await asAlice.query(api.reactions.forConversation, {
    conversationId,
  });
  expect(alicesView).toEqual([]);
});

// ============================================================
// reactToMeta — the authed, PUBLIC action that notifies Meta of a
// reaction (Phase 8, Task 4). Does NOT touch `messageReactions` itself
// (the UI's own `set`/`remove` calls above already own that row) — every
// test here only asserts the Meta-notify leg succeeds/fails correctly.
// Every DRY-RUN test sets `CONVEX_META_DRY_RUN`, mirroring
// `convex/metaSend.test.ts`'s own convention.
// ============================================================

test("reactToMeta in DRY-RUN does not throw for the caller's own account", async () => {
  process.env.CONVEX_META_DRY_RUN = "1";
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
  const targetMessageId = await asUser.mutation(api.messages.append, {
    conversationId,
    senderType: "customer",
    contentType: "text",
    contentText: "Hi",
    messageId: "wamid.TARGET123",
  });

  const result = await asUser.action(api.reactions.reactToMeta, {
    messageId: targetMessageId,
    emoji: "👍",
  });

  expect(result.whatsappMessageId).toMatch(/^dry-run-[0-9a-f]{16}$/);

  delete process.env.CONVEX_META_DRY_RUN;
});

test("reactToMeta supports emoji: '' (removal) without throwing", async () => {
  process.env.CONVEX_META_DRY_RUN = "1";
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
  const targetMessageId = await asUser.mutation(api.messages.append, {
    conversationId,
    senderType: "customer",
    contentType: "text",
    contentText: "Hi",
    messageId: "wamid.TARGET123",
  });

  const result = await asUser.action(api.reactions.reactToMeta, {
    messageId: targetMessageId,
    emoji: "",
  });

  expect(result.whatsappMessageId).toMatch(/^dry-run-[0-9a-f]{16}$/);

  delete process.env.CONVEX_META_DRY_RUN;
});

test("reactToMeta throws when the target message has never been sent to WhatsApp (no wamid)", async () => {
  process.env.CONVEX_META_DRY_RUN = "1";
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
  const targetMessageId = await asUser.mutation(api.messages.append, {
    conversationId,
    senderType: "agent",
    contentType: "text",
    contentText: "still sending",
  });

  await expect(
    asUser.action(api.reactions.reactToMeta, {
      messageId: targetMessageId,
      emoji: "👍",
    }),
  ).rejects.toThrow(/has not been sent to WhatsApp/);

  delete process.env.CONVEX_META_DRY_RUN;
});

test("reactToMeta is account-scoped: rejects a message belonging to a different account", async () => {
  process.env.CONVEX_META_DRY_RUN = "1";
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
    phone: "15551234567",
  });
  const aliceConversationId = await seedConversation(t, {
    accountId: aliceAccountId,
    contactId: aliceContactId,
  });
  const aliceMessageId = await asAlice.mutation(api.messages.append, {
    conversationId: aliceConversationId,
    senderType: "customer",
    contentType: "text",
    contentText: "Hi",
    messageId: "wamid.ALICE123",
  });

  await expect(
    asBob.action(api.reactions.reactToMeta, {
      messageId: aliceMessageId,
      emoji: "👍",
    }),
  ).rejects.toMatchObject({ data: { code: "NOT_FOUND", entity: "message" } });

  delete process.env.CONVEX_META_DRY_RUN;
});

test("reactToMeta throws UNAUTHENTICATED when there is no identity", async () => {
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
  const targetMessageId = await asUser.mutation(api.messages.append, {
    conversationId,
    senderType: "customer",
    contentType: "text",
    contentText: "Hi",
    messageId: "wamid.X",
  });

  await expect(
    t.action(api.reactions.reactToMeta, {
      messageId: targetMessageId,
      emoji: "👍",
    }),
  ).rejects.toMatchObject({ data: { code: "UNAUTHENTICATED" } });
});

test("reactToMeta throws FORBIDDEN for a viewer (below the agent floor)", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId } = await seedAccountMember(t, {
    name: "Viewer",
    email: "viewer@example.com",
    role: "viewer",
  });
  const contactId = await t.run((ctx) =>
    ctx.db.insert("contacts", {
      accountId,
      phone: "15551234567",
      phoneNormalized: "15551234567",
    }),
  );
  const conversationId = await seedConversation(t, { accountId, contactId });
  const targetMessageId = await t.run((ctx) =>
    ctx.db.insert("messages", {
      accountId,
      conversationId,
      senderType: "customer",
      contentType: "text",
      contentText: "Hi",
      messageId: "wamid.X",
      status: "sent",
    }),
  );

  await expect(
    asUser.action(api.reactions.reactToMeta, {
      messageId: targetMessageId,
      emoji: "👍",
    }),
  ).rejects.toMatchObject({ data: { code: "FORBIDDEN", min: "agent" } });
});
