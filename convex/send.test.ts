/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import type { AccountRole } from "./lib/roles";

// Convex function modules for convex-test to resolve `api.*`/`internal.*`
// references against. Absolute, from-project-root pattern (matches
// `convex/metaSend.test.ts`/`convex/conversations.test.ts` — see those
// files' comments for why this must be absolute rather than a relative
// "./**").
const modules = import.meta.glob("/convex/**/*.ts");

/**
 * Seeds a `users` row + an `accounts`/`memberships` row for a fresh
 * account, and returns a convex-test client already authenticated as
 * that user. Duplicated per-suite rather than imported — see
 * `convex/metaSend.test.ts`'s own comment on this pattern.
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
 * Adds a second membership row to an *existing* account — unlike
 * `seedAccountMember`, which always mints a brand-new account. The
 * per-conversation "own" access tests (RBAC final review, C1) need a
 * real teammate `userId` on the *same* account as the conversation
 * under test, which `seedAccountMember` alone can't produce. Mirrors
 * `convex/conversations.test.ts`'s own `seedTeammate` byte-for-byte —
 * duplicated per this suite's own established per-file-helper
 * convention (see `seedAccountMember`'s own comment above).
 */
async function seedTeammate(
  t: ReturnType<typeof convexTest>,
  opts: { accountId: Id<"accounts">; name: string; email: string; role: AccountRole },
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
 * Inserts a `conversations` row directly via `t.run` — same shape
 * `convex/metaSend.test.ts`'s own `seedConversation` uses.
 */
async function seedConversation(
  t: ReturnType<typeof convexTest>,
  opts: {
    accountId: Id<"accounts">;
    contactId: Id<"contacts">;
    // Optional: one test seeds a conversation purely so
    // `api.messages.append` can be called as setup. `append` now requires
    // "own" access (the caller must be assigned), so callers that append
    // as an "agent" must pass their own userId here.
    assignedToUserId?: Id<"users">;
  },
) {
  return await t.run((ctx) =>
    ctx.db.insert("conversations", {
      accountId: opts.accountId,
      contactId: opts.contactId,
      assignedToUserId: opts.assignedToUserId,
      status: "open",
      unreadCount: 0,
    }),
  );
}

// ============================================================
// send — auth / role / tenancy gating. Every test that reaches
// metaSend sets CONVEX_META_DRY_RUN, mirroring
// `convex/metaSend.test.ts`'s own convention.
// ============================================================

test("send throws UNAUTHENTICATED when there is no identity", async () => {
  const t = convexTest(schema, modules);

  await expect(
    t.action(api.send.send, { messageType: "text", contentText: "hi" }),
  ).rejects.toMatchObject({ data: { code: "UNAUTHENTICATED" } });
});

test("send throws NO_ACCOUNT when authenticated but not yet bootstrapped", async () => {
  const t = convexTest(schema, modules);
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { name: "Nomad", email: "nomad@example.com" }),
  );
  const asNomad = t.withIdentity({ subject: `${userId}|session-nomad` });

  await expect(
    asNomad.action(api.send.send, { messageType: "text", contentText: "hi" }),
  ).rejects.toMatchObject({ data: { code: "NO_ACCOUNT" } });
});

test("send throws FORBIDDEN for a viewer (below the agent floor)", async () => {
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

  await expect(
    asUser.action(api.send.send, {
      conversationId,
      messageType: "text",
      contentText: "hi",
    }),
  ).rejects.toMatchObject({ data: { code: "FORBIDDEN", min: "agent" } });
});

test("send throws when neither conversationId nor contactId is provided", async () => {
  process.env.CONVEX_META_DRY_RUN = "1";
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });

  await expect(
    asUser.action(api.send.send, { messageType: "text", contentText: "hi" }),
  ).rejects.toThrow(/conversationId or a contactId/);

  delete process.env.CONVEX_META_DRY_RUN;
});

test("send rejects a conversationId belonging to a different account", async () => {
  process.env.CONVEX_META_DRY_RUN = "1";
  const t = convexTest(schema, modules);
  const { asUser: asAlice } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const { accountId: bobAccountId, asUser: asBob } = await seedAccountMember(
    t,
    { name: "Bob", email: "bob@example.com", role: "agent" },
  );
  const bobContactId = await asBob.mutation(api.contacts.create, {
    phone: "15559990000",
  });
  const bobConversationId = await seedConversation(t, {
    accountId: bobAccountId,
    contactId: bobContactId,
  });

  await expect(
    asAlice.action(api.send.send, {
      conversationId: bobConversationId,
      messageType: "text",
      contentText: "should never land",
    }),
  ).rejects.toMatchObject({ data: { code: "NOT_FOUND", entity: "conversation" } });

  delete process.env.CONVEX_META_DRY_RUN;
});

test("send rejects a contactId belonging to a different account", async () => {
  process.env.CONVEX_META_DRY_RUN = "1";
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
    phone: "15559990001",
  });

  await expect(
    asAlice.action(api.send.send, {
      contactId: bobContactId,
      messageType: "text",
      contentText: "should never land",
    }),
  ).rejects.toMatchObject({ data: { code: "NOT_FOUND", entity: "contact" } });

  delete process.env.CONVEX_META_DRY_RUN;
});

// ============================================================
// send — conversationId path
// ============================================================

test("send with a conversationId sends text and persists the outbound message (DRY-RUN)", async () => {
  process.env.CONVEX_META_DRY_RUN = "1";
  const t = convexTest(schema, modules);
  const { asUser, accountId, userId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const contactId = await asUser.mutation(api.contacts.create, {
    phone: "15551234567",
  });
  // Assigned to the caller — `send` now requires "own" access (RBAC
  // final review, C1), same as `messages.append` already did.
  const conversationId = await seedConversation(t, {
    accountId,
    contactId,
    assignedToUserId: userId,
  });

  const result = await asUser.action(api.send.send, {
    conversationId,
    messageType: "text",
    contentText: "Hello from the dashboard",
  });

  expect(result.whatsappMessageId).toMatch(/^dry-run-[0-9a-f]{16}$/);

  const messages = await t.run((ctx) =>
    ctx.db
      .query("messages")
      .withIndex("by_conversation", (q) => q.eq("conversationId", conversationId))
      .collect(),
  );
  expect(messages).toHaveLength(1);
  expect(messages[0]!.accountId).toBe(accountId);
  expect(messages[0]!.contentType).toBe("text");
  expect(messages[0]!.contentText).toBe("Hello from the dashboard");
  expect(messages[0]!.messageId).toBe(result.whatsappMessageId);
  // Dashboard/agent-initiated send — must persist as "agent", not the
  // metaSend default "bot", or the inbox would render it as a bot/AI
  // message (Phase 8, Task 4).
  expect(messages[0]!.senderType).toBe("agent");

  delete process.env.CONVEX_META_DRY_RUN;
});

test("send throws a plain validation error when messageType=text has no contentText", async () => {
  process.env.CONVEX_META_DRY_RUN = "1";
  const t = convexTest(schema, modules);
  const { asUser, accountId, userId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const contactId = await asUser.mutation(api.contacts.create, {
    phone: "15551234567",
  });
  // Assigned to the caller — see the DRY-RUN text-send test above for
  // why (this test needs to reach the messageType validation, not the
  // new "own" access check).
  const conversationId = await seedConversation(t, {
    accountId,
    contactId,
    assignedToUserId: userId,
  });

  await expect(
    asUser.action(api.send.send, { conversationId, messageType: "text" }),
  ).rejects.toThrow(/contentText is required/);

  delete process.env.CONVEX_META_DRY_RUN;
});

// ============================================================
// send — contactId path (find-or-create)
// ============================================================

test("send with a contactId find-or-creates the conversation, then sends", async () => {
  process.env.CONVEX_META_DRY_RUN = "1";
  const t = convexTest(schema, modules);
  // supervisor: a brand-new contact has no existing conversation yet,
  // so this exercises the CREATE branch of find-or-create — which
  // (RBAC final review, C1) only supervisor+ may do via `send`, since
  // the freshly-created conversation is always unassigned and an
  // agent's "own" access can never reach an unassigned conversation.
  // See "agent cannot send.send to a brand-new contact" below for the
  // sub-supervisor denial case.
  const { asUser } = await seedAccountMember(t, {
    name: "Sam",
    email: "sam@example.com",
    role: "supervisor",
  });
  const contactId = await asUser.mutation(api.contacts.create, {
    phone: "15551234567",
  });

  const before = await t.run((ctx) =>
    ctx.db
      .query("conversations")
      .withIndex("by_contact", (q) => q.eq("contactId", contactId))
      .first(),
  );
  expect(before).toBeNull();

  const result = await asUser.action(api.send.send, {
    contactId,
    messageType: "text",
    contentText: "First outbound message",
  });
  expect(result.whatsappMessageId).toMatch(/^dry-run-[0-9a-f]{16}$/);

  const conversation = await t.run((ctx) =>
    ctx.db
      .query("conversations")
      .withIndex("by_contact", (q) => q.eq("contactId", contactId))
      .first(),
  );
  expect(conversation).not.toBeNull();

  const messages = await t.run((ctx) =>
    ctx.db
      .query("messages")
      .withIndex("by_conversation", (q) =>
        q.eq("conversationId", conversation!._id),
      )
      .collect(),
  );
  expect(messages).toHaveLength(1);
  expect(messages[0]!.contentText).toBe("First outbound message");

  // A second send for the same contactId reuses the SAME conversation
  // rather than creating a duplicate.
  await asUser.action(api.send.send, {
    contactId,
    messageType: "text",
    contentText: "Second outbound message",
  });

  const conversationsForContact = await t.run((ctx) =>
    ctx.db
      .query("conversations")
      .withIndex("by_contact", (q) => q.eq("contactId", contactId))
      .collect(),
  );
  expect(conversationsForContact).toHaveLength(1);
  expect(conversationsForContact[0]!._id).toBe(conversation!._id);

  delete process.env.CONVEX_META_DRY_RUN;
});

// ============================================================
// send — template / interactive / media routing
// ============================================================

test("send routes messageType=template to metaSend.sendTemplate", async () => {
  process.env.CONVEX_META_DRY_RUN = "1";
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

  const result = await asUser.action(api.send.send, {
    conversationId,
    messageType: "template",
    templateName: "order_confirmation",
    templateLanguage: "en_US",
    templateParams: ["12345"],
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
  // The rendered body the composer passes must be threaded through to the
  // persisted row (was dropped before, leaving the bubble/preview blank).
  expect(messages[0]!.contentText).toBe("Your order 12345 is confirmed.");

  const conversation = await t.run((ctx) => ctx.db.get(conversationId));
  expect(conversation!.lastMessageText).toBe("Your order 12345 is confirmed.");

  delete process.env.CONVEX_META_DRY_RUN;
});

test("send routes messageType=interactive to metaSend.sendInteractive", async () => {
  process.env.CONVEX_META_DRY_RUN = "1";
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

  const payload = {
    kind: "buttons" as const,
    body: "Pick one",
    buttons: [{ id: "yes", title: "Yes" }],
  };
  const result = await asUser.action(api.send.send, {
    conversationId,
    messageType: "interactive",
    interactivePayload: payload,
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

test("send routes a media messageType (image) to metaSend.sendMedia", async () => {
  process.env.CONVEX_META_DRY_RUN = "1";
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

  const result = await asUser.action(api.send.send, {
    conversationId,
    messageType: "image",
    mediaUrl: "https://example.com/photo.jpg",
    contentText: "Here's the photo",
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
  // A legacy `mediaUrl`-only send persists just the URL — no key exists
  // to carry (final-review fix: "outbound media never persists a key").
  expect(messages[0]!.mediaKey).toBeUndefined();
  expect(messages[0]!.contentText).toBe("Here's the photo");
  expect(messages[0]!.messageId).toBe(result.whatsappMessageId);

  delete process.env.CONVEX_META_DRY_RUN;
});

test("send resolves a message's mediaKey to a public R2 URL for Meta, and persists BOTH the key and the resolved URL", async () => {
  // Arrange an outbound media send whose staged object is identified by
  // key, not by legacy URL, and assert the `link` handed to Meta is the
  // objs.holidayys.co URL rather than a Convex storage URL.
  //
  // Same arrangement as "send routes a media messageType (image) to
  // metaSend.sendMedia" above (DRY-RUN + account/conversation seeding).
  // There is no `metaSend.sendMedia` argument-interception pattern
  // anywhere in this file or in `metaSend.test.ts` — every existing test
  // in both files goes through DRY-RUN and asserts on the PERSISTED row
  // instead. That's a faithful proxy here too:
  // `metaSend.sendMedia`'s handler (`convex/metaSend.ts:358`) persists
  // `mediaUrl: args.link` unconditionally, even in DRY-RUN (only
  // `whatsappMessageId` is synthetic) — so the persisted row's
  // `mediaUrl` IS the exact `link` value that would have been handed to
  // Meta's Graph API on a real send.
  //
  // Also the regression test for the final-review fix "outbound media
  // never persists a key": `send` threads its already-ownership-checked
  // `args.mediaKey` through to `metaSend.sendMedia` (not just the
  // resolved `link`), so the persisted row carries BOTH — proving the
  // composer-attachment / voice-note write path durably stores a key
  // instead of discarding it after resolution.
  process.env.CONVEX_META_DRY_RUN = "1";
  process.env.R2_BUCKET = "wa-holidayys";
  process.env.R2_ENDPOINT = "https://acct.r2.cloudflarestorage.com";
  process.env.R2_ACCESS_KEY_ID = "ak";
  process.env.R2_SECRET_ACCESS_KEY = "sk";
  process.env.R2_PUBLIC_HOST = "https://objs.holidayys.co";
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

  // The key's own account segment MUST be the caller's real seeded
  // `accountId`, not a fixture literal like "acc1" — `send` verifies the
  // key's prefix against the caller's own account (cross-tenant
  // ownership check, see the tests below) before ever resolving it to a
  // URL, so a key minted for a DIFFERENT account here would be rejected
  // rather than resolved. This is also, therefore, the regression test
  // for "an agent's OWN key still succeeds."
  await asUser.action(api.send.send, {
    conversationId,
    messageType: "image",
    mediaKey: `${accountId}/outbound/photo.png`,
  });

  const messages = await t.run((ctx) =>
    ctx.db
      .query("messages")
      .withIndex("by_conversation", (q) => q.eq("conversationId", conversationId))
      .collect(),
  );
  expect(messages).toHaveLength(1);
  const capturedLink = messages[0]!.mediaUrl;
  expect(capturedLink).toBe(
    `https://objs.holidayys.co/${accountId}/outbound/photo.png`,
  );
  expect(messages[0]!.mediaKey).toBe(`${accountId}/outbound/photo.png`);

  delete process.env.CONVEX_META_DRY_RUN;
  delete process.env.R2_BUCKET;
  delete process.env.R2_ENDPOINT;
  delete process.env.R2_ACCESS_KEY_ID;
  delete process.env.R2_SECRET_ACCESS_KEY;
  delete process.env.R2_PUBLIC_HOST;
});

// ============================================================
// send — mediaKey cross-tenant ownership (Important review finding):
// `send`'s args validator has no `accountId` field, so nothing upstream
// stops a client from passing a `mediaKey` that belongs to a DIFFERENT
// account. Without a server-side check, `resolveMediaUrlLazy` would
// happily resolve a foreign key to a real, fetchable R2 URL, Meta would
// fetch and deliver that object, and the foreign URL would land in the
// caller's own account's message row
// (`convex/metaSend.ts`'s `sendMedia` persists `mediaUrl: args.link`
// unconditionally). A foreign key and a malformed key must be
// indistinguishable — both `NOT_FOUND`, never `FORBIDDEN` — matching
// `convex/files.ts`'s `remove` mutation, which enforces the identical
// contract for the same key shape.
// ============================================================

test("send rejects a mediaKey belonging to a different account (cross-tenant), and nothing is persisted", async () => {
  process.env.CONVEX_META_DRY_RUN = "1";
  process.env.R2_BUCKET = "wa-holidayys";
  process.env.R2_ENDPOINT = "https://acct.r2.cloudflarestorage.com";
  process.env.R2_ACCESS_KEY_ID = "ak";
  process.env.R2_SECRET_ACCESS_KEY = "sk";
  process.env.R2_PUBLIC_HOST = "https://objs.holidayys.co";
  const t = convexTest(schema, modules);
  // R2 is deliberately left CONFIGURED (not omitted) for this test: with
  // no ownership check, `resolveMediaUrlLazy` would successfully resolve
  // Bob's key to a real `objs.holidayys.co` URL and the send would
  // SUCCEED (persisting Bob's URL into Alice's message) — that failure
  // mode is the actual vulnerability, and it only surfaces when R2 is
  // configured. Leaving R2 unconfigured would instead make an unfixed
  // `send` throw a generic "R2_BUCKET is not set" error, which also
  // rejects but for the wrong reason and would mask a regression where
  // the ownership check silently moved to run AFTER key resolution.
  const { asUser: asAlice, accountId, userId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const { accountId: bobAccountId } = await seedAccountMember(t, {
    name: "Bob",
    email: "bob@example.com",
    role: "agent",
  });
  const contactId = await asAlice.mutation(api.contacts.create, {
    phone: "15551234567",
  });
  const conversationId = await seedConversation(t, {
    accountId,
    contactId,
    assignedToUserId: userId,
  });

  await expect(
    asAlice.action(api.send.send, {
      conversationId,
      messageType: "image",
      mediaKey: `${bobAccountId}/outbound/photo.png`,
    }),
  ).rejects.toMatchObject({ data: { code: "NOT_FOUND", entity: "file" } });

  // Nothing was persisted into Alice's conversation — proof the send
  // pipeline (which would have called Meta) was never reached.
  const messages = await t.run((ctx) =>
    ctx.db
      .query("messages")
      .withIndex("by_conversation", (q) => q.eq("conversationId", conversationId))
      .collect(),
  );
  expect(messages).toHaveLength(0);

  delete process.env.CONVEX_META_DRY_RUN;
  delete process.env.R2_BUCKET;
  delete process.env.R2_ENDPOINT;
  delete process.env.R2_ACCESS_KEY_ID;
  delete process.env.R2_SECRET_ACCESS_KEY;
  delete process.env.R2_PUBLIC_HOST;
});

test("send rejects a malformed mediaKey with the SAME NOT_FOUND shape as a foreign key", async () => {
  process.env.CONVEX_META_DRY_RUN = "1";
  process.env.R2_BUCKET = "wa-holidayys";
  process.env.R2_ENDPOINT = "https://acct.r2.cloudflarestorage.com";
  process.env.R2_ACCESS_KEY_ID = "ak";
  process.env.R2_SECRET_ACCESS_KEY = "sk";
  process.env.R2_PUBLIC_HOST = "https://objs.holidayys.co";
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

  await expect(
    asUser.action(api.send.send, {
      conversationId,
      messageType: "image",
      // `parseMediaKey` requires exactly 3 `/`-separated segments with a
      // known `kind` — this has neither, so it must be rejected without
      // ever attempting to resolve it, identically to a foreign key.
      mediaKey: "not-a-real-key",
    }),
  ).rejects.toMatchObject({ data: { code: "NOT_FOUND", entity: "file" } });

  const messages = await t.run((ctx) =>
    ctx.db
      .query("messages")
      .withIndex("by_conversation", (q) => q.eq("conversationId", conversationId))
      .collect(),
  );
  expect(messages).toHaveLength(0);

  delete process.env.CONVEX_META_DRY_RUN;
  delete process.env.R2_BUCKET;
  delete process.env.R2_ENDPOINT;
  delete process.env.R2_ACCESS_KEY_ID;
  delete process.env.R2_SECRET_ACCESS_KEY;
  delete process.env.R2_PUBLIC_HOST;
});

test("send still requires a mediaUrl or mediaKey for media messages (both absent throws)", async () => {
  process.env.CONVEX_META_DRY_RUN = "1";
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

  await expect(
    asUser.action(api.send.send, { conversationId, messageType: "image" }),
  ).rejects.toThrow(/mediaKey or mediaUrl is required/);

  delete process.env.CONVEX_META_DRY_RUN;
});

// ============================================================
// send — reply threading (replyToMessageId -> Meta contextMessageId)
// ============================================================

test("send rejects a replyToMessageId that belongs to a different conversation", async () => {
  process.env.CONVEX_META_DRY_RUN = "1";
  const t = convexTest(schema, modules);
  const { asUser, accountId, userId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const contactId = await asUser.mutation(api.contacts.create, {
    phone: "15551234567",
  });
  // Assigned to the caller — the PRIMARY send target must pass the new
  // "own" access check (RBAC final review, C1) so this test actually
  // reaches its real target: the `replyToMessageId` cross-conversation
  // rejection, not an access denial.
  const conversationId = await seedConversation(t, {
    accountId,
    contactId,
    assignedToUserId: userId,
  });
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
    asUser.action(api.send.send, {
      conversationId,
      messageType: "text",
      contentText: "reply attempt",
      replyToMessageId: otherMessageId,
    }),
  ).rejects.toMatchObject({
    data: { code: "NOT_FOUND", entity: "replyToMessage" },
  });

  delete process.env.CONVEX_META_DRY_RUN;
});

// ============================================================
// send — per-conversation "own" access (RBAC final review, C1): an
// agent may only send.send into a conversation actually assigned to
// them; supervisor+ may send into any conversation in the account,
// including creating one for a brand-new contact.
// ============================================================

test("agent cannot send.send into a conversation assigned to another agent", async () => {
  process.env.CONVEX_META_DRY_RUN = "1";
  const t = convexTest(schema, modules);
  const { asUser: asAlice, accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const bobUserId = await seedTeammate(t, {
    accountId,
    name: "Bob",
    email: "bob@example.com",
    role: "agent",
  });
  const contactId = await asAlice.mutation(api.contacts.create, {
    phone: "15551112222",
  });
  const conversationId = await seedConversation(t, {
    accountId,
    contactId,
    assignedToUserId: bobUserId,
  });

  await expect(
    asAlice.action(api.send.send, {
      conversationId,
      messageType: "text",
      contentText: "should never land",
    }),
  ).rejects.toMatchObject({
    data: { code: "NOT_FOUND", entity: "conversation" },
  });

  const messages = await t.run((ctx) =>
    ctx.db
      .query("messages")
      .withIndex("by_conversation", (q) => q.eq("conversationId", conversationId))
      .collect(),
  );
  expect(messages).toHaveLength(0);

  delete process.env.CONVEX_META_DRY_RUN;
});

test("agent CAN send.send into their own assigned conversation", async () => {
  process.env.CONVEX_META_DRY_RUN = "1";
  const t = convexTest(schema, modules);
  const { asUser, accountId, userId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const contactId = await asUser.mutation(api.contacts.create, {
    phone: "15551112223",
  });
  const conversationId = await seedConversation(t, {
    accountId,
    contactId,
    assignedToUserId: userId,
  });

  const result = await asUser.action(api.send.send, {
    conversationId,
    messageType: "text",
    contentText: "hi from my own thread",
  });
  expect(result.whatsappMessageId).toMatch(/^dry-run-[0-9a-f]{16}$/);

  const messages = await t.run((ctx) =>
    ctx.db
      .query("messages")
      .withIndex("by_conversation", (q) => q.eq("conversationId", conversationId))
      .collect(),
  );
  expect(messages).toHaveLength(1);

  delete process.env.CONVEX_META_DRY_RUN;
});

test("supervisor can send.send into any conversation, including one assigned to someone else", async () => {
  process.env.CONVEX_META_DRY_RUN = "1";
  const t = convexTest(schema, modules);
  const { asUser: asSupervisor, accountId } = await seedAccountMember(t, {
    name: "Sam",
    email: "sam@example.com",
    role: "supervisor",
  });
  const bobUserId = await seedTeammate(t, {
    accountId,
    name: "Bob",
    email: "bob@example.com",
    role: "agent",
  });
  const contactId = await asSupervisor.mutation(api.contacts.create, {
    phone: "15551112224",
  });
  const conversationId = await seedConversation(t, {
    accountId,
    contactId,
    assignedToUserId: bobUserId,
  });

  const result = await asSupervisor.action(api.send.send, {
    conversationId,
    messageType: "text",
    contentText: "supervisor override",
  });
  expect(result.whatsappMessageId).toMatch(/^dry-run-[0-9a-f]{16}$/);

  const messages = await t.run((ctx) =>
    ctx.db
      .query("messages")
      .withIndex("by_conversation", (q) => q.eq("conversationId", conversationId))
      .collect(),
  );
  expect(messages).toHaveLength(1);

  delete process.env.CONVEX_META_DRY_RUN;
});

test("agent cannot send.send to a brand-new contact (would create an unassigned conversation), and no orphan conversation is left behind", async () => {
  process.env.CONVEX_META_DRY_RUN = "1";
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const contactId = await asUser.mutation(api.contacts.create, {
    phone: "15551112225",
  });

  await expect(
    asUser.action(api.send.send, {
      contactId,
      messageType: "text",
      contentText: "cold outreach",
    }),
  ).rejects.toMatchObject({
    data: { code: "NOT_FOUND", entity: "conversation" },
  });

  // The whole point of checking BEFORE create (C1's edge case): a
  // denied agent must not leave a dead, empty conversation behind.
  const conversation = await t.run((ctx) =>
    ctx.db
      .query("conversations")
      .withIndex("by_contact", (q) => q.eq("contactId", contactId))
      .first(),
  );
  expect(conversation).toBeNull();

  delete process.env.CONVEX_META_DRY_RUN;
});

test("send persists replyToMessageId on the outbound reply (DRY-RUN)", async () => {
  process.env.CONVEX_META_DRY_RUN = "1";
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
  // The customer message the agent is replying to.
  const parentId = await t.run((ctx) =>
    ctx.db.insert("messages", {
      accountId,
      conversationId,
      senderType: "customer",
      contentType: "text",
      contentText: "Do you have availability?",
      messageId: "wamid.PARENT",
      status: "delivered",
    }),
  );

  await asUser.action(api.send.send, {
    conversationId,
    messageType: "text",
    contentText: "Yes we do!",
    replyToMessageId: parentId,
  });

  const messages = await t.run((ctx) =>
    ctx.db
      .query("messages")
      .withIndex("by_conversation", (q) =>
        q.eq("conversationId", conversationId),
      )
      .collect(),
  );
  const reply = messages.find((m) => m.senderType === "agent");
  expect(reply).toBeDefined();
  expect(reply!.replyToMessageId).toBe(parentId);

  delete process.env.CONVEX_META_DRY_RUN;
});
