/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import schema from "./schema";

// Convex function modules for convex-test to resolve `api.*` references
// against. Absolute so it resolves identically regardless of which file
// imports it (mirrors the pattern from the Convex testing docs).
const modules = import.meta.glob("/convex/**/*.ts");

// ============================================================
// Schema-only smoke tests. Phase 1 adds tables in groups, task by task,
// with no queries/mutations until each vertical's own function-phase — so
// there's nothing in `api.*` to drive yet. Instead we exercise the schema
// directly through `t.run` + `ctx.db`, which still routes every insert
// through the same validators `defineTable`/`v` produce. Extend this file
// per task with 1-2 representative tables from that task's group.
// ============================================================

/** Seeds an account (+ its owner user) so tenant-scoped inserts have a
 * real `accountId` to reference. */
async function insertAccount(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const ownerUserId = await ctx.db.insert("users", {
      name: "Priya",
      email: "priya@example.com",
    });
    return await ctx.db.insert("accounts", {
      name: "Priya's account",
      defaultCurrency: "USD",
      ownerUserId,
    });
  });
}

test("Task 1 — conversations + messages round-trip through the schema's validators", async () => {
  const t = convexTest(schema, modules);
  const accountId = await insertAccount(t);

  const contactId = await t.run(async (ctx) =>
    ctx.db.insert("contacts", {
      accountId,
      phone: "+15551234567",
      phoneNormalized: "15551234567",
    }),
  );

  const conversationId = await t.run(async (ctx) =>
    ctx.db.insert("conversations", {
      accountId,
      contactId,
      status: "open",
      unreadCount: 0,
      // Optional AI columns (migrations 029 + 033) — set them here so the
      // fixup's new validators are actually exercised, not just skipped.
      aiAutoreplyDisabled: false,
      aiReplyCount: 0,
      aiHandoffSummary: "handed off: pricing question",
    }),
  );

  const messageId = await t.run(async (ctx) =>
    ctx.db.insert("messages", {
      accountId,
      conversationId,
      senderType: "bot",
      contentType: "text",
      contentText: "Hi there",
      status: "delivered",
      aiGenerated: true, // migration 033 column
    }),
  );

  const conversation = await t.run(async (ctx) => ctx.db.get(conversationId));
  const message = await t.run(async (ctx) => ctx.db.get(messageId));

  expect(conversation).not.toBeNull();
  expect(conversation!.accountId).toBe(accountId);
  expect(conversation!.contactId).toBe(contactId);
  expect(conversation!.status).toBe("open");
  expect(conversation!.unreadCount).toBe(0);
  expect(conversation!.aiAutoreplyDisabled).toBe(false);
  expect(conversation!.aiReplyCount).toBe(0);
  expect(conversation!.aiHandoffSummary).toBe("handed off: pricing question");

  expect(message).not.toBeNull();
  expect(message!.accountId).toBe(accountId);
  expect(message!.conversationId).toBe(conversationId);
  expect(message!.senderType).toBe("bot");
  expect(message!.contentType).toBe("text");
  expect(message!.status).toBe("delivered");
  expect(message!.aiGenerated).toBe(true);

  // Also exercise the declared indexes, not just the field validators.
  const byConversation = await t.run(async (ctx) =>
    ctx.db
      .query("messages")
      .withIndex("by_conversation", (q) =>
        q.eq("conversationId", conversationId),
      )
      .collect(),
  );
  expect(byConversation.map((m) => m._id)).toEqual([messageId]);

  const byAccount = await t.run(async (ctx) =>
    ctx.db
      .query("conversations")
      .withIndex("by_account", (q) => q.eq("accountId", accountId))
      .collect(),
  );
  expect(byAccount.map((c) => c._id)).toEqual([conversationId]);
});

test("Task 1 — an out-of-union value is rejected by the schema validator", async () => {
  const t = convexTest(schema, modules);
  const accountId = await insertAccount(t);
  const contactId = await t.run(async (ctx) =>
    ctx.db.insert("contacts", {
      accountId,
      phone: "+15551234567",
      phoneNormalized: "15551234567",
    }),
  );

  await expect(
    t.run(async (ctx) =>
      ctx.db.insert("conversations", {
        accountId,
        contactId,
        // Not one of the `status` union's literals — proves the schema
        // rejects it rather than silently accepting any string.
        status: "not-a-real-status" as unknown as "open",
        unreadCount: 0,
      }),
    ),
  ).rejects.toThrow();
});

test("Task 2 — messageTemplates + apiKeys round-trip through the schema's validators", async () => {
  const t = convexTest(schema, modules);
  const accountId = await insertAccount(t);

  const templateId = await t.run(async (ctx) =>
    ctx.db.insert("messageTemplates", {
      accountId,
      name: "welcome",
      category: "Utility",
      language: "en_US",
      bodyText: "Hello {{1}}, welcome to {{2}}!",
      status: "APPROVED",
      // Typed `sampleValues` object (migration 014) — exercises the
      // nested v.object/v.array validators, not just a bare v.any().
      sampleValues: {
        body: ["Priya", "Acme"],
        header: ["Acme Support"],
      },
      metaTemplateId: "meta-template-123",
      qualityScore: "GREEN",
      headerHandle: "4::aW1hZ2U6cGxhY2Vob2xkZXI=",
      headerMediaUrl: "https://example.com/header.png",
      lastSubmittedAt: Date.now(),
    }),
  );

  const apiKeyId = await t.run(async (ctx) =>
    ctx.db.insert("apiKeys", {
      accountId,
      name: "CI integration",
      keyPrefix: "wacrm_live_a1b2c3d4",
      keyHash: "fixture-sha256-hash-of-the-plaintext-key",
      scopes: ["contacts:read", "messages:write"],
    }),
  );

  const template = await t.run(async (ctx) => ctx.db.get(templateId));
  const apiKey = await t.run(async (ctx) => ctx.db.get(apiKeyId));

  expect(template).not.toBeNull();
  expect(template!.accountId).toBe(accountId);
  expect(template!.category).toBe("Utility");
  expect(template!.status).toBe("APPROVED");
  expect(template!.sampleValues?.body).toEqual(["Priya", "Acme"]);
  expect(template!.sampleValues?.header).toEqual(["Acme Support"]);
  expect(template!.metaTemplateId).toBe("meta-template-123");
  expect(template!.headerMediaUrl).toBe("https://example.com/header.png");

  expect(apiKey).not.toBeNull();
  expect(apiKey!.accountId).toBe(accountId);
  expect(apiKey!.scopes).toEqual(["contacts:read", "messages:write"]);
  expect(apiKey!.keyHash).toBe("fixture-sha256-hash-of-the-plaintext-key");

  // Also exercise the declared unique-enforcing indexes, not just the
  // field validators.
  const byNameLang = await t.run(async (ctx) =>
    ctx.db
      .query("messageTemplates")
      .withIndex("by_account_name_lang", (q) =>
        q
          .eq("accountId", accountId)
          .eq("name", "welcome")
          .eq("language", "en_US"),
      )
      .collect(),
  );
  expect(byNameLang.map((r) => r._id)).toEqual([templateId]);

  const byKeyHash = await t.run(async (ctx) =>
    ctx.db
      .query("apiKeys")
      .withIndex("by_key_hash", (q) =>
        q.eq("keyHash", "fixture-sha256-hash-of-the-plaintext-key"),
      )
      .collect(),
  );
  expect(byKeyHash.map((r) => r._id)).toEqual([apiKeyId]);
});

test("Task 2 — an out-of-union value is rejected by the schema validator", async () => {
  const t = convexTest(schema, modules);
  const accountId = await insertAccount(t);

  await expect(
    t.run(async (ctx) =>
      ctx.db.insert("broadcasts", {
        accountId,
        name: "Spring sale",
        templateName: "spring_sale",
        templateLanguage: "en_US",
        // Not one of the `status` union's literals — proves the schema
        // rejects it rather than silently accepting any string.
        status: "not-a-real-status" as unknown as "draft",
        totalRecipients: 0,
        sentCount: 0,
        deliveredCount: 0,
        readCount: 0,
        repliedCount: 0,
        failedCount: 0,
      }),
    ),
  ).rejects.toThrow();
});
