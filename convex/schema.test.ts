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
    }),
  );

  const messageId = await t.run(async (ctx) =>
    ctx.db.insert("messages", {
      accountId,
      conversationId,
      senderType: "customer",
      contentType: "text",
      contentText: "Hi there",
      status: "delivered",
    }),
  );

  const conversation = await t.run(async (ctx) => ctx.db.get(conversationId));
  const message = await t.run(async (ctx) => ctx.db.get(messageId));

  expect(conversation).not.toBeNull();
  expect(conversation!.accountId).toBe(accountId);
  expect(conversation!.contactId).toBe(contactId);
  expect(conversation!.status).toBe("open");
  expect(conversation!.unreadCount).toBe(0);

  expect(message).not.toBeNull();
  expect(message!.accountId).toBe(accountId);
  expect(message!.conversationId).toBe(conversationId);
  expect(message!.senderType).toBe("customer");
  expect(message!.contentType).toBe("text");
  expect(message!.status).toBe("delivered");

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
