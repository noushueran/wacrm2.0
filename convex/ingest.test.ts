/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";

// Convex function modules for convex-test to resolve `internal.*`
// references against. Absolute, from-project-root pattern (matches
// every other `convex/*.test.ts` suite — see `convex/lib/auth.test.ts`'s
// comment for why this must be absolute rather than a relative "./**").
const modules = import.meta.glob("/convex/**/*.ts");

/**
 * Seeds a bare `users` + `accounts` row — no `memberships` row, unlike
 * every other suite's `seedAccountMember`: `ingest.ingestInbound` is a
 * plain `internalMutation` with no `accountMutation` auth wrapper (see
 * that module's own header comment), so there is no session/role to
 * seed against — only the `accounts.ownerUserId` FK that `accounts`
 * itself requires.
 */
async function seedAccount(t: ReturnType<typeof convexTest>, name: string) {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {
      name,
      email: `${name.toLowerCase()}@example.com`,
    });
    return await ctx.db.insert("accounts", {
      name: `${name}'s account`,
      defaultCurrency: "USD",
      ownerUserId: userId,
    });
  });
}

// ============================================================
// First inbound from a new phone — creates everything
// ============================================================

test("ingestInbound from a new phone creates a contact + conversation + message", async () => {
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Acme");

  const beforeIngest = Date.now();
  const result = await t.mutation(internal.ingest.ingestInbound, {
    accountId,
    from: "15551234567",
    name: "Jamie Customer",
    message: {
      type: "text",
      text: "Hi, is anyone there?",
      wamid: "wamid.FIRST",
    },
  });

  expect(result.wasCreated).toBe(true);
  expect(result.isFirstInboundMessage).toBe(true);

  const contact = await t.run((ctx) => ctx.db.get(result.contactId));
  expect(contact).not.toBeNull();
  expect(contact!.accountId).toBe(accountId);
  expect(contact!.phone).toBe("15551234567");
  expect(contact!.phoneNormalized).toBe("15551234567");
  expect(contact!.name).toBe("Jamie Customer");

  const conversation = await t.run((ctx) => ctx.db.get(result.conversationId));
  expect(conversation).not.toBeNull();
  expect(conversation!.accountId).toBe(accountId);
  expect(conversation!.contactId).toBe(result.contactId);
  expect(conversation!.status).toBe("open");
  expect(conversation!.unreadCount).toBe(1);
  expect(conversation!.lastMessageText).toBe("Hi, is anyone there?");
  expect(conversation!.lastMessageAt).toBeGreaterThanOrEqual(beforeIngest);
  expect(conversation!.updatedAt).toBeGreaterThanOrEqual(beforeIngest);

  const message = await t.run((ctx) => ctx.db.get(result.messageId));
  expect(message).not.toBeNull();
  expect(message!.accountId).toBe(accountId);
  expect(message!.conversationId).toBe(result.conversationId);
  expect(message!.senderType).toBe("customer");
  expect(message!.contentType).toBe("text");
  expect(message!.contentText).toBe("Hi, is anyone there?");
  expect(message!.messageId).toBe("wamid.FIRST");
  expect(message!.status).toBe("sent");
});

// ============================================================
// Second inbound from the same phone — reuses contact + conversation
// ============================================================

test("a second inbound message from the same phone reuses the contact + conversation and bumps unread", async () => {
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Acme");

  const first = await t.mutation(internal.ingest.ingestInbound, {
    accountId,
    from: "15551234567",
    name: "Jamie Customer",
    message: {
      type: "text",
      text: "Hi, is anyone there?",
      wamid: "wamid.FIRST",
    },
  });

  const second = await t.mutation(internal.ingest.ingestInbound, {
    accountId,
    from: "15551234567",
    name: "Jamie Customer",
    message: { type: "text", text: "Following up...", wamid: "wamid.SECOND" },
  });

  expect(second.wasCreated).toBe(false);
  expect(second.isFirstInboundMessage).toBe(false);
  expect(second.contactId).toBe(first.contactId);
  expect(second.conversationId).toBe(first.conversationId);
  expect(second.messageId).not.toBe(first.messageId);

  const conversation = await t.run((ctx) => ctx.db.get(second.conversationId));
  expect(conversation!.unreadCount).toBe(2);
  expect(conversation!.lastMessageText).toBe("Following up...");

  const contacts = await t.run((ctx) =>
    ctx.db
      .query("contacts")
      .withIndex("by_account", (q) => q.eq("accountId", accountId))
      .collect(),
  );
  expect(contacts).toHaveLength(1);

  const messages = await t.run((ctx) =>
    ctx.db
      .query("messages")
      .withIndex("by_conversation", (q) =>
        q.eq("conversationId", second.conversationId),
      )
      .collect(),
  );
  expect(messages).toHaveLength(2);
});

// ============================================================
// Cross-account isolation — same phone, different account
// ============================================================

test("the same phone number on a different account gets its own contact and conversation", async () => {
  const t = convexTest(schema, modules);
  const accountA = await seedAccount(t, "Acme");
  const accountB = await seedAccount(t, "Globex");

  const resultA = await t.mutation(internal.ingest.ingestInbound, {
    accountId: accountA,
    from: "15551234567",
    message: { type: "text", text: "Hello from A's customer", wamid: "wamid.A1" },
  });
  const resultB = await t.mutation(internal.ingest.ingestInbound, {
    accountId: accountB,
    from: "15551234567",
    message: { type: "text", text: "Hello from B's customer", wamid: "wamid.B1" },
  });

  expect(resultA.wasCreated).toBe(true);
  expect(resultB.wasCreated).toBe(true);
  expect(resultB.isFirstInboundMessage).toBe(true);
  expect(resultA.contactId).not.toBe(resultB.contactId);
  expect(resultA.conversationId).not.toBe(resultB.conversationId);

  const contactB = await t.run((ctx) => ctx.db.get(resultB.contactId));
  expect(contactB!.accountId).toBe(accountB);

  const accountAContacts = await t.run((ctx) =>
    ctx.db
      .query("contacts")
      .withIndex("by_account", (q) => q.eq("accountId", accountA))
      .collect(),
  );
  expect(accountAContacts).toHaveLength(1);
  expect(accountAContacts[0]!._id).toBe(resultA.contactId);

  const accountBContacts = await t.run((ctx) =>
    ctx.db
      .query("contacts")
      .withIndex("by_account", (q) => q.eq("accountId", accountB))
      .collect(),
  );
  expect(accountBContacts).toHaveLength(1);
  expect(accountBContacts[0]!._id).toBe(resultB.contactId);
});

// ============================================================
// Media + interactive-reply fields thread through correctly
// ============================================================

test("ingestInbound persists mediaUrl for a media message and interactiveReplyId for an interactive reply", async () => {
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Acme");

  const imageResult = await t.mutation(internal.ingest.ingestInbound, {
    accountId,
    from: "15559990000",
    message: {
      type: "image",
      mediaId: "meta-media-id-123",
      mediaUrl: "https://media.example.com/photo.jpg",
      wamid: "wamid.IMG1",
    },
  });
  const imageMessage = await t.run((ctx) => ctx.db.get(imageResult.messageId));
  expect(imageMessage!.contentType).toBe("image");
  expect(imageMessage!.mediaUrl).toBe("https://media.example.com/photo.jpg");
  const conversationAfterImage = await t.run((ctx) =>
    ctx.db.get(imageResult.conversationId),
  );
  // No `text` supplied — falls back to the bracketed content-type
  // preview, same as `messages.append`'s own documented behavior.
  expect(conversationAfterImage!.lastMessageText).toBe("[image]");

  const replyResult = await t.mutation(internal.ingest.ingestInbound, {
    accountId,
    from: "15558880000",
    message: {
      type: "interactive",
      text: "Yes please",
      interactiveReplyId: "btn_yes",
      wamid: "wamid.REPLY1",
    },
  });
  const replyMessage = await t.run((ctx) => ctx.db.get(replyResult.messageId));
  expect(replyMessage!.contentType).toBe("interactive");
  expect(replyMessage!.interactiveReplyId).toBe("btn_yes");
});
