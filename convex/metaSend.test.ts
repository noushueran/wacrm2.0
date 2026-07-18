/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import type { AccountRole } from "./lib/roles";

// Convex function modules for convex-test to resolve `api.*`/`internal.*`
// references against. Absolute, from-project-root pattern (matches every
// other `convex/*.test.ts` suite — see `convex/lib/auth.test.ts`'s
// comment for why this must be absolute rather than a relative "./**").
const modules = import.meta.glob("/convex/**/*.ts");

/**
 * Seeds a `users` row + an `accounts`/`memberships` row for a fresh
 * account, and returns a convex-test client already authenticated as
 * that user. Duplicated per-suite rather than imported — see
 * `convex/messages.test.ts`'s own comment on this pattern.
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
 * Inserts a `conversations` row directly via `t.run` — same shape
 * `convex/messages.test.ts`'s own `seedConversation` uses.
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

const onePage = { numItems: 50, cursor: null };

// ============================================================
// sendText — DRY-RUN persistence + account-scoping
// ============================================================

test("sendText in DRY-RUN persists a bot message and updates the conversation, without calling Meta", async () => {
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

  const beforeSend = Date.now();
  const result = await t.action(internal.metaSend.sendText, {
    accountId,
    conversationId,
    to: "15551234567",
    text: "Thanks for reaching out!",
  });

  // Synthetic dry-run wamid, not a real Meta id — no whatsappConfig row
  // exists for this account, so a real send would have thrown.
  expect(result.whatsappMessageId).toMatch(/^dry-run-[0-9a-f]{16}$/);

  const messages = await t.run((ctx) =>
    ctx.db
      .query("messages")
      .withIndex("by_conversation", (q) => q.eq("conversationId", conversationId))
      .collect(),
  );
  expect(messages).toHaveLength(1);
  expect(messages[0]!.accountId).toBe(accountId);
  expect(messages[0]!.senderType).toBe("bot");
  expect(messages[0]!.contentType).toBe("text");
  expect(messages[0]!.contentText).toBe("Thanks for reaching out!");
  expect(messages[0]!.messageId).toBe(result.whatsappMessageId);
  expect(messages[0]!.status).toBe("sent");

  const conversation = await t.run((ctx) => ctx.db.get(conversationId));
  expect(conversation!.lastMessageText).toBe("Thanks for reaching out!");
  expect(conversation!.lastMessageAt).toBeGreaterThanOrEqual(beforeSend);
  expect(conversation!.updatedAt).toBeGreaterThanOrEqual(beforeSend);
  // A bot send is not inbound — unreadCount must NOT bump.
  expect(conversation!.unreadCount).toBe(0);

  delete process.env.CONVEX_META_DRY_RUN;
});

// ============================================================
// sendText — senderType override (Phase 8, Task 4). `senderType` is
// optional and defaults to "bot" (asserted above); a caller acting on a
// human agent's behalf (`convex/send.ts`'s `send`) passes "agent"
// explicitly so the persisted message isn't indistinguishable from an
// automation's.
// ============================================================

test("sendText persists senderType 'agent' when explicitly passed", async () => {
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

  await t.action(internal.metaSend.sendText, {
    accountId,
    conversationId,
    to: "15551234567",
    text: "Hi, this is your agent",
    senderType: "agent",
  });

  const messages = await t.run((ctx) =>
    ctx.db
      .query("messages")
      .withIndex("by_conversation", (q) => q.eq("conversationId", conversationId))
      .collect(),
  );
  expect(messages).toHaveLength(1);
  expect(messages[0]!.senderType).toBe("agent");

  delete process.env.CONVEX_META_DRY_RUN;
});

test("sendText is account-scoped: cannot persist against another account's conversation", async () => {
  process.env.CONVEX_META_DRY_RUN = "1";
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

  // Bob's accountId + Alice's conversationId must be rejected — the
  // same NOT_FOUND `messages.appendInternal`'s `requireOwnConversation`
  // throws for any cross-account probe.
  await expect(
    t.action(internal.metaSend.sendText, {
      accountId: bobAccountId,
      conversationId: aliceConversationId,
      to: "15551234567",
      text: "should never land",
    }),
  ).rejects.toMatchObject({ data: { code: "NOT_FOUND", entity: "conversation" } });

  const messages = await t.run((ctx) =>
    ctx.db
      .query("messages")
      .withIndex("by_conversation", (q) => q.eq("conversationId", aliceConversationId))
      .collect(),
  );
  expect(messages).toHaveLength(0);

  delete process.env.CONVEX_META_DRY_RUN;
});

test("sendText throws 'WhatsApp not configured' when DRY-RUN is off and no whatsappConfig row exists", async () => {
  delete process.env.CONVEX_META_DRY_RUN;
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

  await expect(
    t.action(internal.metaSend.sendText, {
      accountId,
      conversationId,
      to: "15551234567",
      text: "hi",
    }),
  ).rejects.toThrow(/WhatsApp not configured/);

  const messages = await t.run((ctx) =>
    ctx.db
      .query("messages")
      .withIndex("by_conversation", (q) => q.eq("conversationId", conversationId))
      .collect(),
  );
  expect(messages).toHaveLength(0);
});

// ============================================================
// sendTemplate — DRY-RUN persistence
// ============================================================

test("sendTemplate in DRY-RUN persists a template message", async () => {
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

  const result = await t.action(internal.metaSend.sendTemplate, {
    accountId,
    conversationId,
    to: "15551234567",
    templateName: "order_confirmation",
    language: "en_US",
    params: ["12345"],
    contentText: "Your order 12345 is confirmed.",
  });

  const messages = await t.run((ctx) =>
    ctx.db
      .query("messages")
      .withIndex("by_conversation", (q) => q.eq("conversationId", conversationId))
      .collect(),
  );
  expect(messages).toHaveLength(1);
  expect(messages[0]!.contentType).toBe("template");
  expect(messages[0]!.templateName).toBe("order_confirmation");
  expect(messages[0]!.messageId).toBe(result.whatsappMessageId);
  // The rendered template body must persist on the row so the bubble
  // renders text instead of a blank template placeholder.
  expect(messages[0]!.contentText).toBe("Your order 12345 is confirmed.");

  // ...and surface as the conversation-list preview, not the `[template]`
  // fallback used when no body text is available.
  const conversation = await t.run((ctx) => ctx.db.get(conversationId));
  expect(conversation!.lastMessageText).toBe("Your order 12345 is confirmed.");

  delete process.env.CONVEX_META_DRY_RUN;
});

// ============================================================
// sendInteractive — DRY-RUN persistence + payload validation
// ============================================================

test("sendInteractive in DRY-RUN persists the interactive payload", async () => {
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

  const payload = {
    kind: "buttons" as const,
    body: "Pick one",
    buttons: [{ id: "yes", title: "Yes" }],
  };
  const result = await t.action(internal.metaSend.sendInteractive, {
    accountId,
    conversationId,
    to: "15551234567",
    payload,
  });

  const messages = await t.run((ctx) =>
    ctx.db
      .query("messages")
      .withIndex("by_conversation", (q) => q.eq("conversationId", conversationId))
      .collect(),
  );
  expect(messages).toHaveLength(1);
  expect(messages[0]!.contentType).toBe("interactive");
  expect(messages[0]!.contentText).toBe("Pick one");
  expect(messages[0]!.interactivePayload).toEqual(payload);
  expect(messages[0]!.messageId).toBe(result.whatsappMessageId);

  delete process.env.CONVEX_META_DRY_RUN;
});

test("sendInteractive rejects an invalid payload before ever touching Meta or the DB", async () => {
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

  // No buttons — fails validateInteractivePayload's "at least one
  // reply button" check.
  await expect(
    t.action(internal.metaSend.sendInteractive, {
      accountId,
      conversationId,
      to: "15551234567",
      payload: { kind: "buttons", body: "Pick one", buttons: [] },
    }),
  ).rejects.toThrow(/at least one reply button/);

  const messages = await t.run((ctx) =>
    ctx.db
      .query("messages")
      .withIndex("by_conversation", (q) => q.eq("conversationId", conversationId))
      .collect(),
  );
  expect(messages).toHaveLength(0);

  delete process.env.CONVEX_META_DRY_RUN;
});

// ============================================================
// sendMedia — DRY-RUN persistence
// ============================================================

test("sendMedia in DRY-RUN persists a media message with the right contentType", async () => {
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

  const result = await t.action(internal.metaSend.sendMedia, {
    accountId,
    conversationId,
    to: "15551234567",
    kind: "image" as const,
    link: "https://example.com/photo.jpg",
    caption: "Here's the photo",
  });

  const messages = await t.run((ctx) =>
    ctx.db
      .query("messages")
      .withIndex("by_conversation", (q) => q.eq("conversationId", conversationId))
      .collect(),
  );
  expect(messages).toHaveLength(1);
  expect(messages[0]!.contentType).toBe("image");
  expect(messages[0]!.mediaUrl).toBe("https://example.com/photo.jpg");
  expect(messages[0]!.contentText).toBe("Here's the photo");
  expect(messages[0]!.messageId).toBe(result.whatsappMessageId);

  const onePageResult = await asUser.query(api.messages.listByConversation, {
    conversationId,
    paginationOpts: onePage,
  });
  expect(onePageResult.page).toHaveLength(1);

  delete process.env.CONVEX_META_DRY_RUN;
});

// ============================================================
// sendReaction — Meta-only notify (Phase 8, Task 4). Unlike every
// action above, this one does NOT persist via `appendInternal` (a
// reaction is its own row — `convex/reactions.ts` owns that write); the
// account-scoping guard instead comes from `conversations
// .resolveSendTarget`, run unconditionally so it fires in DRY-RUN too.
// ============================================================

test("sendReaction in DRY-RUN does not throw and returns a synthetic wamid, without persisting a message", async () => {
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

  const result = await t.action(internal.metaSend.sendReaction, {
    accountId,
    conversationId,
    targetWhatsappMessageId: "wamid.TARGET123",
    emoji: "👍",
  });

  expect(result.whatsappMessageId).toMatch(/^dry-run-[0-9a-f]{16}$/);

  const messages = await t.run((ctx) =>
    ctx.db
      .query("messages")
      .withIndex("by_conversation", (q) => q.eq("conversationId", conversationId))
      .collect(),
  );
  expect(messages).toHaveLength(0);

  delete process.env.CONVEX_META_DRY_RUN;
});

test("sendReaction accepts an empty emoji (Meta's 'remove reaction' convention) without throwing", async () => {
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

  const result = await t.action(internal.metaSend.sendReaction, {
    accountId,
    conversationId,
    targetWhatsappMessageId: "wamid.TARGET123",
    emoji: "",
  });

  expect(result.whatsappMessageId).toMatch(/^dry-run-[0-9a-f]{16}$/);

  delete process.env.CONVEX_META_DRY_RUN;
});

test("sendReaction is account-scoped: rejects a conversation belonging to a different account, even in DRY-RUN", async () => {
  process.env.CONVEX_META_DRY_RUN = "1";
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
    t.action(internal.metaSend.sendReaction, {
      accountId: bobAccountId,
      conversationId: aliceConversationId,
      targetWhatsappMessageId: "wamid.SHOULD_NOT_SEND",
      emoji: "👍",
    }),
  ).rejects.toMatchObject({ data: { code: "NOT_FOUND", entity: "conversation" } });

  delete process.env.CONVEX_META_DRY_RUN;
});

// ============================================================
// markRead — read receipt + typing indicator (no persistence)
// ============================================================

test("markRead in DRY-RUN resolves without calling Meta and persists nothing", async () => {
  process.env.CONVEX_META_DRY_RUN = "1";
  try {
    const t = convexTest(schema, modules);
    const { accountId, asUser } = await seedAccountMember(t, {
      name: "Alice",
      email: "alice@example.com",
      role: "agent",
    });
    const contactId = await asUser.mutation(api.contacts.create, {
      phone: "15551234567",
    });
    const conversationId = await seedConversation(t, { accountId, contactId });

    await t.action(internal.metaSend.markRead, {
      accountId,
      whatsappMessageId: "wamid.inbound123",
      typingIndicator: true,
    });

    // A read receipt is not a message — nothing may be persisted.
    const rows = await t.run((ctx) =>
      ctx.db
        .query("messages")
        .withIndex("by_conversation", (q) => q.eq("conversationId", conversationId))
        .collect(),
    );
    expect(rows).toHaveLength(0);
  } finally {
    delete process.env.CONVEX_META_DRY_RUN;
  }
});
