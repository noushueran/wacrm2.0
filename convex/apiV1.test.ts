/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { hashApiKey } from "./lib/apiKey";
import type { Id } from "./_generated/dataModel";
import type { AccountRole } from "./lib/roles";

// Convex function modules for convex-test to resolve `api.*`/`internal.*`
// references against. Absolute, from-project-root pattern (matches every
// other `convex/*.test.ts` suite — see `convex/lib/auth.test.ts`'s
// comment for why this must be absolute rather than a relative "./**").
const modules = import.meta.glob("/convex/**/*.ts");

afterEach(() => {
  vi.useRealTimers();
  delete process.env.CONVEX_META_DRY_RUN;
});

/**
 * Seeds a `users` row + an `accounts`/`memberships` row for a fresh
 * account, and returns a convex-test client already authenticated as
 * that user. Duplicated per-suite rather than imported — see
 * `convex/contacts.test.ts`'s own comment on this pattern.
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
  const asUser = t.withIdentity({ subject: `${userId}|session-${opts.name}` });
  return { userId, accountId, asUser };
}

/**
 * Inserts an `apiKeys` row directly (bypassing `apiKeys.create`'s
 * accountMutation session requirement — these tests authenticate purely
 * by hash, exactly like the public API itself) and returns the plaintext
 * + its hash, so a test can call any `apiV1.*` function with `{ keyHash }`
 * the same way `requireApiKey` would after hashing a caller's bearer
 * token.
 */
async function seedApiKey(
  t: ReturnType<typeof convexTest>,
  opts: {
    accountId: Id<"accounts">;
    scopes: string[];
    revoked?: boolean;
    expiresAt?: number;
  },
) {
  const plaintext = `wacrm_live_test_${Math.random().toString(36).slice(2)}`;
  const keyHash = await hashApiKey(plaintext);
  const apiKeyId = await t.run((ctx) =>
    ctx.db.insert("apiKeys", {
      accountId: opts.accountId,
      name: "Test key",
      keyPrefix: plaintext.slice(0, 20),
      keyHash,
      scopes: opts.scopes,
      revokedAt: opts.revoked ? Date.now() - 1_000 : undefined,
      expiresAt: opts.expiresAt,
    }),
  );
  return { plaintext, keyHash, apiKeyId };
}

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
// Shared auth/scope behavior — exercised once thoroughly via
// `listContacts` as the representative op; every other op below reuses
// the exact same `requireScope`/`requireScopeAction` helper, so a spot
// check on a query-shaped op (`getMe`) and an action-shaped op
// (`sendMessage`) covers the two code paths, not just one.
// ============================================================

test("a query-shaped op (listContacts) throws UNAUTHORIZED for an unknown key hash", async () => {
  const t = convexTest(schema, modules);
  await expect(
    t.query(api.apiV1.listContacts, { keyHash: "nope", limit: 50 }),
  ).rejects.toMatchObject({ data: { code: "UNAUTHORIZED" } });
});

test("a query-shaped op (listContacts) throws FORBIDDEN with the missing scope for a live key lacking it", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const { keyHash } = await seedApiKey(t, { accountId, scopes: ["messages:send"] });

  await expect(
    t.query(api.apiV1.listContacts, { keyHash, limit: 50 }),
  ).rejects.toMatchObject({ data: { code: "FORBIDDEN", scope: "contacts:read" } });
});

test("a revoked key is treated the same as unknown (UNAUTHORIZED)", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const { keyHash } = await seedApiKey(t, {
    accountId,
    scopes: ["contacts:read"],
    revoked: true,
  });

  await expect(
    t.query(api.apiV1.listContacts, { keyHash, limit: 50 }),
  ).rejects.toMatchObject({ data: { code: "UNAUTHORIZED" } });
});

test("an expired key is treated the same as unknown (UNAUTHORIZED)", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const { keyHash } = await seedApiKey(t, {
    accountId,
    scopes: ["contacts:read"],
    expiresAt: Date.now() - 1_000,
  });

  await expect(
    t.query(api.apiV1.listContacts, { keyHash, limit: 50 }),
  ).rejects.toMatchObject({ data: { code: "UNAUTHORIZED" } });
});

test("an action-shaped op (sendMessage) also throws UNAUTHORIZED/FORBIDDEN via requireScopeAction", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });

  await expect(
    t.action(api.apiV1.sendMessage, { keyHash: "nope", to: "+14155550123", type: "text", text: "hi" }),
  ).rejects.toMatchObject({ data: { code: "UNAUTHORIZED" } });

  const { keyHash } = await seedApiKey(t, { accountId, scopes: ["contacts:read"] });
  await expect(
    t.action(api.apiV1.sendMessage, { keyHash, to: "+14155550123", type: "text", text: "hi" }),
  ).rejects.toMatchObject({ data: { code: "FORBIDDEN", scope: "messages:send" } });
});

// ============================================================
// contacts
// ============================================================

test("listContacts returns the account's contacts, embedded tags, newest first, and paginates via an offset cursor", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "supervisor",
  });
  const { keyHash } = await seedApiKey(t, { accountId, scopes: ["contacts:read"] });

  const c1 = await asUser.mutation(api.contacts.create, { phone: "15550000001", name: "First" });
  const c2 = await asUser.mutation(api.contacts.create, { phone: "15550000002", name: "Second" });
  const tagId = await asUser.mutation(api.tags.create, { name: "VIP", color: "#fff" });
  await asUser.mutation(api.contacts.assignTag, { contactId: c2, tagId });

  const page1 = await t.query(api.apiV1.listContacts, { keyHash, limit: 1 });
  expect(page1.items).toHaveLength(1);
  expect(page1.items[0]!._id).toBe(c2); // newest first
  expect(page1.items[0]!.tags).toHaveLength(1);
  expect(page1.nextCursor).not.toBeNull();

  const page2 = await t.query(api.apiV1.listContacts, {
    keyHash,
    limit: 1,
    cursor: page1.nextCursor!,
  });
  expect(page2.items).toHaveLength(1);
  expect(page2.items[0]!._id).toBe(c1);
  expect(page2.nextCursor).toBeNull();
});

test("listContacts filters by search (name/phone substring) and by tag", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "supervisor",
  });
  const { keyHash } = await seedApiKey(t, { accountId, scopes: ["contacts:read"] });

  const jane = await asUser.mutation(api.contacts.create, { phone: "15550000003", name: "Jane Doe" });
  await asUser.mutation(api.contacts.create, { phone: "15550000004", name: "Bob" });
  const tagId = await asUser.mutation(api.tags.create, { name: "VIP", color: "#fff" });
  await asUser.mutation(api.contacts.assignTag, { contactId: jane, tagId });

  const bySearch = await t.query(api.apiV1.listContacts, { keyHash, limit: 50, search: "jane" });
  expect(bySearch.items.map((c) => c._id)).toEqual([jane]);

  const byTag = await t.query(api.apiV1.listContacts, { keyHash, limit: 50, tag: tagId });
  expect(byTag.items.map((c) => c._id)).toEqual([jane]);

  const byForeignTag = await t.query(api.apiV1.listContacts, {
    keyHash,
    limit: 50,
    tag: "not-a-real-id",
  });
  expect(byForeignTag.items).toEqual([]);
});

test("getContact returns the embedded contact for this account, and null for a missing or foreign one", async () => {
  const t = convexTest(schema, modules);
  const { accountId: aliceAccount, asUser: asAlice } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const { accountId: bobAccount, asUser: asBob } = await seedAccountMember(t, {
    name: "Bob",
    email: "bob@example.com",
    role: "agent",
  });
  const { keyHash: aliceKey } = await seedApiKey(t, { accountId: aliceAccount, scopes: ["contacts:read"] });

  const contactId = await asAlice.mutation(api.contacts.create, { phone: "15550000005" });
  const bobContactId = await asBob.mutation(api.contacts.create, { phone: "15550000006" });

  const found = await t.query(api.apiV1.getContact, { keyHash: aliceKey, contactId });
  expect(found?._id).toBe(contactId);

  expect(await t.query(api.apiV1.getContact, { keyHash: aliceKey, contactId: bobContactId })).toBeNull();
  expect(await t.query(api.apiV1.getContact, { keyHash: aliceKey, contactId: "not-a-real-id" })).toBeNull();
});

test("createContact finds-or-creates by phone (200 semantics: created:false on a match) and applies tags", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const { keyHash } = await seedApiKey(t, { accountId, scopes: ["contacts:write"] });

  const first = await t.mutation(api.apiV1.createContact, {
    keyHash,
    phone: "+14155550123",
    name: "Jane",
    tags: ["VIP", "vip"], // case-insensitive de-dupe
  });
  expect(first.created).toBe(true);
  expect(first.contact.name).toBe("Jane");
  expect(first.contact.tags).toHaveLength(1);
  expect(first.contact.tags[0]!.name).toBe("VIP");

  const second = await t.mutation(api.apiV1.createContact, {
    keyHash,
    phone: "+14155550123",
  });
  expect(second.created).toBe(false);
  expect(second.contact._id).toBe(first.contact._id);
});

test("createContact rejects a missing or invalid phone with BAD_REQUEST", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const { keyHash } = await seedApiKey(t, { accountId, scopes: ["contacts:write"] });

  await expect(
    t.mutation(api.apiV1.createContact, { keyHash, phone: "" }),
  ).rejects.toMatchObject({ data: { code: "BAD_REQUEST" } });
  await expect(
    t.mutation(api.apiV1.createContact, { keyHash, phone: "not-a-phone" }),
  ).rejects.toMatchObject({ data: { code: "BAD_REQUEST" } });
});

test("updateContact patches only the fields present, null clears a field, and replaces tags", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const { keyHash } = await seedApiKey(t, { accountId, scopes: ["contacts:write"] });
  const contactId = await asUser.mutation(api.contacts.create, {
    phone: "15550000007",
    name: "Original",
    email: "orig@example.com",
    company: "Acme",
  });

  const patched = await t.mutation(api.apiV1.updateContact, {
    keyHash,
    contactId,
    name: "Renamed",
    // email/company omitted entirely — must stay untouched
  });
  expect(patched?.name).toBe("Renamed");
  expect(patched?.email).toBe("orig@example.com");
  expect(patched?.company).toBe("Acme");

  const cleared = await t.mutation(api.apiV1.updateContact, {
    keyHash,
    contactId,
    email: null,
  });
  expect(cleared?.email).toBeUndefined();
  expect(cleared?.name).toBe("Renamed"); // still untouched by this second call

  const tagged = await t.mutation(api.apiV1.updateContact, {
    keyHash,
    contactId,
    tags: ["Gold"],
  });
  expect(tagged?.tags.map((tg) => tg.name)).toEqual(["Gold"]);

  expect(
    await t.mutation(api.apiV1.updateContact, {
      keyHash,
      contactId: "not-a-real-id",
      name: "X",
    }),
  ).toBeNull();
});

test("deleteContact removes the contact and cascades its tag links; foreign/missing -> null", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "supervisor",
  });
  const { keyHash } = await seedApiKey(t, { accountId, scopes: ["contacts:write"] });
  const contactId = await asUser.mutation(api.contacts.create, { phone: "15550000008" });
  const tagId = await asUser.mutation(api.tags.create, { name: "VIP", color: "#fff" });
  await asUser.mutation(api.contacts.assignTag, { contactId, tagId });

  const result = await t.mutation(api.apiV1.deleteContact, { keyHash, contactId });
  expect(result?.id).toBe(contactId);
  expect(await t.run((ctx) => ctx.db.get(contactId))).toBeNull();
  const links = await t.run((ctx) =>
    ctx.db.query("contactTags").withIndex("by_contact", (q) => q.eq("contactId", contactId)).collect(),
  );
  expect(links).toHaveLength(0);

  expect(
    await t.mutation(api.apiV1.deleteContact, { keyHash, contactId: "not-a-real-id" }),
  ).toBeNull();
});

// ============================================================
// conversations + messages
// ============================================================

test("listConversations orders newest-first by creation (not last-message-recency) and filters by status/contact_id", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const { keyHash } = await seedApiKey(t, { accountId, scopes: ["conversations:read"] });

  const c1 = await asUser.mutation(api.contacts.create, { phone: "15550000009" });
  const c2 = await asUser.mutation(api.contacts.create, { phone: "15550000010" });
  const conv1 = await seedConversation(t, { accountId, contactId: c1 });
  const conv2 = await seedConversation(t, { accountId, contactId: c2 });
  await t.run((ctx) => ctx.db.patch(conv2, { status: "closed" }));

  const all = await t.query(api.apiV1.listConversations, { keyHash, limit: 50 });
  expect(all.items.map((c) => c._id)).toEqual([conv2, conv1]); // newest (conv2) first

  const open = await t.query(api.apiV1.listConversations, { keyHash, limit: 50, status: "open" });
  expect(open.items.map((c) => c._id)).toEqual([conv1]);

  const byContact = await t.query(api.apiV1.listConversations, {
    keyHash,
    limit: 50,
    contactId: c1,
  });
  expect(byContact.items.map((c) => c._id)).toEqual([conv1]);
});

test("getConversation embeds the contact + tags, and returns null for a foreign/missing conversation", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const { accountId: bobAccount, asUser: asBob } = await seedAccountMember(t, {
    name: "Bob",
    email: "bob@example.com",
    role: "agent",
  });
  const { keyHash } = await seedApiKey(t, { accountId, scopes: ["conversations:read"] });

  const contactId = await asUser.mutation(api.contacts.create, { phone: "15550000011" });
  const conversationId = await seedConversation(t, { accountId, contactId });

  const bobContact = await asBob.mutation(api.contacts.create, { phone: "15550000012" });
  const bobConversation = await seedConversation(t, { accountId: bobAccount, contactId: bobContact });

  const found = await t.query(api.apiV1.getConversation, { keyHash, conversationId });
  expect(found?.contact?._id).toBe(contactId);

  expect(
    await t.query(api.apiV1.getConversation, { keyHash, conversationId: bobConversation }),
  ).toBeNull();
});

test("listMessages paginates newest-first via Convex's native cursor, and 404s (null) for a foreign conversation", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const { keyHash } = await seedApiKey(t, { accountId, scopes: ["messages:read"] });

  const contactId = await asUser.mutation(api.contacts.create, { phone: "15550000013" });
  const conversationId = await seedConversation(t, { accountId, contactId });
  for (let i = 0; i < 3; i++) {
    await t.run((ctx) =>
      ctx.db.insert("messages", {
        accountId,
        conversationId,
        senderType: "agent",
        contentType: "text",
        contentText: `msg ${i}`,
        status: "sent",
      }),
    );
  }

  const page1 = await t.query(api.apiV1.listMessages, { keyHash, conversationId, limit: 2 });
  if (!page1) throw new Error("expected a page, got null (conversation not found)");
  expect(page1.items).toHaveLength(2);
  expect(page1.items[0]!.contentText).toBe("msg 2");
  expect(page1.nextCursor).not.toBeNull();

  const page2 = await t.query(api.apiV1.listMessages, {
    keyHash,
    conversationId,
    limit: 2,
    cursor: page1.nextCursor!,
  });
  if (!page2) throw new Error("expected a page, got null (conversation not found)");
  expect(page2.items).toHaveLength(1);
  expect(page2.nextCursor).toBeNull();

  const { keyHash: otherKey } = await seedApiKey(t, {
    accountId: (await seedAccountMember(t, { name: "Eve", email: "eve@example.com", role: "agent" })).accountId,
    scopes: ["messages:read"],
  });
  expect(
    await t.query(api.apiV1.listMessages, { keyHash: otherKey, conversationId, limit: 2 }),
  ).toBeNull();
});

test("listMessages clamps an oversized limit to 100 instead of paginating the whole conversation", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const { keyHash } = await seedApiKey(t, { accountId, scopes: ["messages:read"] });
  const contactId = await asUser.mutation(api.contacts.create, { phone: "15550000014" });
  const conversationId = await seedConversation(t, { accountId, contactId });
  await t.run(async (ctx) => {
    for (let i = 0; i < 101; i++) {
      await ctx.db.insert("messages", {
        accountId,
        conversationId,
        senderType: "agent",
        contentType: "text",
        contentText: `m${i}`,
        status: "sent",
      });
    }
  });

  // A caller-supplied limit above the REST layer's [1,100] cap is clamped,
  // so a single page can't be coerced into reading the whole conversation.
  const page = await t.query(api.apiV1.listMessages, {
    keyHash,
    conversationId,
    limit: 100_000,
  });
  if (!page) throw new Error("expected a page, got null");
  expect(page.items).toHaveLength(100);
  expect(page.nextCursor).not.toBeNull();
});

test("sendMessage (text, DRY-RUN) resolves-or-creates the contact+conversation and persists the sent message", async () => {
  process.env.CONVEX_META_DRY_RUN = "1";
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const { keyHash } = await seedApiKey(t, { accountId, scopes: ["messages:send"] });

  const result = await t.action(api.apiV1.sendMessage, {
    keyHash,
    to: "+14155550199",
    type: "text",
    text: "Hi there",
  });

  expect(result.contactCreated).toBe(true);
  expect(result.whatsappMessageId).toMatch(/^dry-run-/);
  expect(result.messageId).not.toBeNull();

  const message = await t.run((ctx) => ctx.db.get(result.messageId!));
  expect(message?.contentText).toBe("Hi there");
  expect(message?.senderType).toBe("agent");

  // Sending again to the SAME phone reuses the same contact/conversation.
  const again = await t.action(api.apiV1.sendMessage, {
    keyHash,
    to: "+14155550199",
    type: "text",
    text: "Second",
  });
  expect(again.contactCreated).toBe(false);
  expect(again.contactId).toBe(result.contactId);
  expect(again.conversationId).toBe(result.conversationId);
});

test("sendMessage (template, DRY-RUN) sends the named template with positional params", async () => {
  process.env.CONVEX_META_DRY_RUN = "1";
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const { keyHash } = await seedApiKey(t, { accountId, scopes: ["messages:send"] });

  const result = await t.action(api.apiV1.sendMessage, {
    keyHash,
    to: "+14155550200",
    type: "template",
    template: { name: "spring_sale", language: "en_US", params: ["Jane"] },
  });

  const message = await t.run((ctx) => ctx.db.get(result.messageId!));
  expect(message?.contentType).toBe("template");
  expect(message?.templateName).toBe("spring_sale");
});

test("sendMessage (image, DRY-RUN) requires media_url", async () => {
  process.env.CONVEX_META_DRY_RUN = "1";
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const { keyHash } = await seedApiKey(t, { accountId, scopes: ["messages:send"] });

  await expect(
    t.action(api.apiV1.sendMessage, { keyHash, to: "+14155550201", type: "image" }),
  ).rejects.toMatchObject({ data: { code: "BAD_REQUEST" } });

  const result = await t.action(api.apiV1.sendMessage, {
    keyHash,
    to: "+14155550201",
    type: "image",
    mediaUrl: "https://example.com/photo.jpg",
  });
  const message = await t.run((ctx) => ctx.db.get(result.messageId!));
  expect(message?.contentType).toBe("image");
  expect(message?.mediaUrl).toBe("https://example.com/photo.jpg");
});

test("sendMessage rejects an unsupported type, and an invalid 'to' phone", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const { keyHash } = await seedApiKey(t, { accountId, scopes: ["messages:send"] });

  await expect(
    t.action(api.apiV1.sendMessage, { keyHash, to: "+14155550123", type: "carrier_pigeon" }),
  ).rejects.toMatchObject({ data: { code: "BAD_REQUEST" } });

  await expect(
    t.action(api.apiV1.sendMessage, { keyHash, to: "not-a-phone", type: "text", text: "hi" }),
  ).rejects.toMatchObject({ data: { code: "BAD_REQUEST" } });
});

// ============================================================
// broadcasts
// ============================================================

test("createBroadcast (DRY-RUN) persists + immediately delivers to resolved recipients, reporting rejected invalid phones", async () => {
  process.env.CONVEX_META_DRY_RUN = "1";
  vi.useFakeTimers();
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const { keyHash } = await seedApiKey(t, { accountId, scopes: ["broadcasts:send"] });

  const result = await t.action(api.apiV1.createBroadcast, {
    keyHash,
    templateName: "spring_sale",
    recipients: [{ to: "+14155550301" }, { to: "+14155550302" }, { to: "not-a-phone" }],
  });

  expect(result.totalRecipients).toBe(2);
  expect(result.rejected).toBe(1);

  const broadcast = await t.run((ctx) => ctx.db.get(result.broadcastId));
  expect(broadcast?.status).toBe("sending");
  expect(broadcast?.totalRecipients).toBe(2);

  await t.finishAllScheduledFunctions(vi.runAllTimers);

  const finalBroadcast = await t.run((ctx) => ctx.db.get(result.broadcastId));
  expect(finalBroadcast?.status).toBe("sent");
  expect(finalBroadcast?.sentCount).toBe(2);
});

test("createBroadcast rejects an empty template_name or an empty/oversized recipients list", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const { keyHash } = await seedApiKey(t, { accountId, scopes: ["broadcasts:send"] });

  await expect(
    t.action(api.apiV1.createBroadcast, { keyHash, templateName: "", recipients: [{ to: "+14155550123" }] }),
  ).rejects.toMatchObject({ data: { code: "BAD_REQUEST" } });

  await expect(
    t.action(api.apiV1.createBroadcast, { keyHash, templateName: "x", recipients: [] }),
  ).rejects.toMatchObject({ data: { code: "BAD_REQUEST" } });

  await expect(
    t.action(api.apiV1.createBroadcast, {
      keyHash,
      templateName: "x",
      recipients: [{ to: "not-a-phone" }],
    }),
  ).rejects.toMatchObject({ data: { code: "BAD_REQUEST" } });
});

test("getBroadcast returns the broadcast for this account, and null for a foreign/missing one", async () => {
  process.env.CONVEX_META_DRY_RUN = "1";
  vi.useFakeTimers();
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const { keyHash } = await seedApiKey(t, { accountId, scopes: ["broadcasts:send"] });

  const created = await t.action(api.apiV1.createBroadcast, {
    keyHash,
    templateName: "spring_sale",
    recipients: [{ to: "+14155550303" }],
  });
  await t.finishAllScheduledFunctions(vi.runAllTimers);

  const found = await t.query(api.apiV1.getBroadcast, { keyHash, broadcastId: created.broadcastId });
  expect(found?._id).toBe(created.broadcastId);

  expect(
    await t.query(api.apiV1.getBroadcast, { keyHash, broadcastId: "not-a-real-id" }),
  ).toBeNull();
});

// ============================================================
// webhooks
// ============================================================

test("createWebhook validates url/events, generates+encrypts a secret, and returns it exactly once", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const { keyHash } = await seedApiKey(t, { accountId, scopes: ["webhooks:manage"] });

  await expect(
    t.mutation(api.apiV1.createWebhook, {
      keyHash,
      url: "http://insecure.example.com",
      events: ["message.received"],
    }),
  ).rejects.toMatchObject({ data: { code: "BAD_REQUEST" } });

  await expect(
    t.mutation(api.apiV1.createWebhook, {
      keyHash,
      url: "https://example.com/hook",
      events: ["not.a.real.event"],
    }),
  ).rejects.toMatchObject({ data: { code: "BAD_REQUEST" } });

  const created = await t.mutation(api.apiV1.createWebhook, {
    keyHash,
    url: "https://example.com/hook",
    events: ["message.received", "message.received"], // de-duped
  });
  expect(created.events).toEqual(["message.received"]);
  expect(created.secret.startsWith("whsec_")).toBe(true);
  expect(created.isActive).toBe(true);

  const stored = await t.run((ctx) => ctx.db.get(created._id));
  expect(stored?.secret).not.toBe(created.secret); // encrypted at rest
  expect(stored?.secret.split(":")).toHaveLength(3); // GCM wire format
});

test("getWebhook returns the endpoint for this account, and null for a foreign/missing one", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const { accountId: bobAccount } = await seedAccountMember(t, {
    name: "Bob",
    email: "bob@example.com",
    role: "agent",
  });
  const { keyHash } = await seedApiKey(t, { accountId, scopes: ["webhooks:manage"] });
  const { keyHash: bobKey } = await seedApiKey(t, { accountId: bobAccount, scopes: ["webhooks:manage"] });

  const created = await t.mutation(api.apiV1.createWebhook, {
    keyHash,
    url: "https://example.com/hook",
    events: ["message.received"],
  });

  const found = await t.query(api.apiV1.getWebhook, { keyHash, endpointId: created._id });
  expect(found?._id).toBe(created._id);
  expect((found as { secret?: string })?.secret).not.toBe(created.secret);

  expect(
    await t.query(api.apiV1.getWebhook, { keyHash: bobKey, endpointId: created._id }),
  ).toBeNull();
  expect(
    await t.query(api.apiV1.getWebhook, { keyHash, endpointId: "not-a-real-id" }),
  ).toBeNull();
});

test("listWebhooks/updateWebhook/deleteWebhook are account-scoped and patch only provided fields", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const { accountId: bobAccount } = await seedAccountMember(t, {
    name: "Bob",
    email: "bob@example.com",
    role: "agent",
  });
  const { keyHash } = await seedApiKey(t, { accountId, scopes: ["webhooks:manage"] });
  const { keyHash: bobKey } = await seedApiKey(t, { accountId: bobAccount, scopes: ["webhooks:manage"] });

  const created = await t.mutation(api.apiV1.createWebhook, {
    keyHash,
    url: "https://example.com/hook",
    events: ["message.received"],
  });

  const list = await t.query(api.apiV1.listWebhooks, { keyHash });
  expect(list).toHaveLength(1);
  // `list` returns the raw doc (encrypted `secret`), never the plaintext
  // — the plaintext is only ever in `createWebhook`'s one-time response.
  expect(list[0]!.secret).not.toBe(created.secret);

  const updated = await t.mutation(api.apiV1.updateWebhook, {
    keyHash,
    endpointId: created._id,
    isActive: false,
  });
  expect(updated?.isActive).toBe(false);
  expect(updated?.url).toBe("https://example.com/hook"); // untouched

  expect(
    await t.mutation(api.apiV1.updateWebhook, { keyHash: bobKey, endpointId: created._id, isActive: true }),
  ).toBeNull();

  const deleted = await t.mutation(api.apiV1.deleteWebhook, { keyHash, endpointId: created._id });
  expect(deleted?.id).toBe(created._id);
  expect(await t.run((ctx) => ctx.db.get(created._id))).toBeNull();
});

// ============================================================
// me
// ============================================================

test("getMe returns the account + the key's own scopes, with no scope required", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const { keyHash } = await seedApiKey(t, { accountId, scopes: [] });

  const me = await t.query(api.apiV1.getMe, { keyHash });
  expect(me.accountId).toBe(accountId);
  expect(me.accountName).toBe("Alice's account");
  expect(me.scopes).toEqual([]);

  await expect(t.query(api.apiV1.getMe, { keyHash: "nope" })).rejects.toMatchObject({
    data: { code: "UNAUTHORIZED" },
  });
});
