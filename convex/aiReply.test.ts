/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import type { Doc, Id } from "./_generated/dataModel";
import type { AccountRole } from "./lib/roles";
import { HANDOFF_SENTINEL } from "./lib/ai/defaults";

// Convex function modules for convex-test to resolve `api.*`/`internal.*`
// references against. Absolute, from-project-root pattern (matches every
// other `convex/*.test.ts` suite — see `convex/lib/auth.test.ts`'s
// comment for why this must be absolute rather than a relative "./**").
const modules = import.meta.glob("/convex/**/*.ts");

// Two DRY-RUN flags for every test in this file: `dispatchInbound` skips
// the real LLM call under `CONVEX_AI_DRY_RUN` (see `aiReply.ts`'s own
// `syntheticGeneration`), and the reply send goes through
// `metaSend.sendText`'s own `CONVEX_META_DRY_RUN` gate (skips the real
// Meta call) — same two-flag convention as the source engine tests
// (`automationsEngine.test.ts`/`flowsEngine.test.ts`) that send through
// `metaSend.ts`.
beforeEach(() => {
  process.env.CONVEX_AI_DRY_RUN = "1";
  process.env.CONVEX_META_DRY_RUN = "1";
});
afterEach(() => {
  delete process.env.CONVEX_AI_DRY_RUN;
  delete process.env.CONVEX_META_DRY_RUN;
});

/**
 * Seeds a `users` row + an `accounts`/`memberships` row for a fresh
 * account, and returns a convex-test client already authenticated as
 * that user. Duplicated per-suite rather than imported — see
 * `convex/aiKnowledge.test.ts`'s own comment on this pattern. Role is
 * always "admin" here: this suite needs `aiConfig.upsert` (admin-gated)
 * and `contacts.create` (agent-gated; admin outranks it).
 */
async function seedAccountMember(
  t: TestConvex<typeof schema>,
  opts: { name: string; email: string },
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
      role: "admin" as AccountRole,
      fullName: opts.name,
      email: opts.email,
    });
    return id;
  });
  const asUser = t.withIdentity({ subject: `${userId}|session-${opts.name}` });
  return { userId, accountId, asUser };
}

/** Adds a second membership row to an *existing* account — for the
 *  configured `handoffAgentId` target. Matches `aiKnowledge.test.ts`'s
 *  own `seedTeammate`. */
async function seedTeammate(
  t: TestConvex<typeof schema>,
  opts: { accountId: Id<"accounts">; name: string; email: string },
) {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { name: opts.name, email: opts.email });
    await ctx.db.insert("memberships", {
      userId,
      accountId: opts.accountId,
      role: "agent" as AccountRole,
      fullName: opts.name,
      email: opts.email,
    });
    return userId;
  });
}

const BASE_AI_CONFIG_ARGS = {
  provider: "openai" as const,
  model: "gpt-4o-mini",
  isActive: true,
  autoReplyEnabled: true,
  autoReplyMaxPerConversation: 3,
};

/** Admin+ upsert of the caller's AI config — active + auto-reply on by
 *  default; override any field (e.g. `isActive: false`, a
 *  `handoffAgentId`) per test. */
async function configureAi(
  asUser: Awaited<ReturnType<typeof seedAccountMember>>["asUser"],
  overrides: Partial<typeof BASE_AI_CONFIG_ARGS & { handoffAgentId: Id<"users"> }> = {},
) {
  await asUser.mutation(api.aiConfig.upsert, {
    ...BASE_AI_CONFIG_ARGS,
    apiKey: "sk-test-key",
    ...overrides,
  });
}

/**
 * A contact + a fresh conversation + one inbound (`"customer"`, text)
 * message — the minimal thread `dispatchInbound` needs something to
 * reply to. The message is inserted directly via `t.run` (bypassing
 * `messages.append`'s auth wrapper), matching `aiKnowledge.test.ts`'s own
 * "direct insert for full control" precedent.
 */
async function seedInboundThread(
  t: TestConvex<typeof schema>,
  asUser: Awaited<ReturnType<typeof seedAccountMember>>["asUser"],
  opts: { accountId: Id<"accounts">; phone: string; messageText: string },
) {
  const contactId = await asUser.mutation(api.contacts.create, { phone: opts.phone });
  const conversationId = await t.run((ctx) =>
    ctx.db.insert("conversations", {
      accountId: opts.accountId,
      contactId,
      status: "open" as const,
      unreadCount: 0,
    }),
  );
  await t.run((ctx) =>
    ctx.db.insert("messages", {
      accountId: opts.accountId,
      conversationId,
      senderType: "customer" as const,
      contentType: "text" as const,
      contentText: opts.messageText,
      status: "sent" as const,
    }),
  );
  return { contactId, conversationId };
}

async function getConversation(
  t: TestConvex<typeof schema>,
  conversationId: Id<"conversations">,
): Promise<Doc<"conversations"> | null> {
  return await t.run((ctx) => ctx.db.get(conversationId));
}

async function messagesFor(t: TestConvex<typeof schema>, conversationId: Id<"conversations">) {
  return await t.run((ctx) =>
    ctx.db
      .query("messages")
      .withIndex("by_conversation", (q) => q.eq("conversationId", conversationId))
      .collect(),
  );
}

// ============================================================
// Happy path
// ============================================================

// This one chains ~9 sequential ctx.runQuery/runMutation/runAction hops
// (config load → dispatch context → history → KB check → usage log →
// claim → send → mark-AI-generated), each with its own convex-test
// scheduling overhead — comfortably under 1s standalone, but the
// default 5s test timeout has been observed to be too tight when the
// full ~1150-test suite runs under heavy parallel load. A generous
// explicit timeout avoids that flake without masking a real bug (the
// other, lighter early-exit tests in this file never need it).
test("generates and sends a DRY-RUN reply, marks it AI-generated, and bumps aiReplyCount", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
  });
  await configureAi(asUser);
  const { contactId, conversationId } = await seedInboundThread(t, asUser, {
    accountId,
    phone: "15551234567",
    messageText: "Hi, what are your opening hours?",
  });

  await t.action(internal.aiReply.dispatchInbound, { accountId, conversationId, contactId });

  const messages = await messagesFor(t, conversationId);
  const botMessages = messages.filter((m) => m.senderType === "bot");
  expect(botMessages).toHaveLength(1);
  expect(botMessages[0]!.aiGenerated).toBe(true);
  expect(botMessages[0]!.contentText).toBeTruthy();

  const conversation = await getConversation(t, conversationId);
  expect(conversation!.aiReplyCount).toBe(1);
  expect(conversation!.aiAutoreplyDisabled).not.toBe(true);
  expect(conversation!.assignedToUserId).toBeUndefined();

  // Zero usage in DRY-RUN — `aiUsage.log`'s own "skip when there's no
  // usage" no-op means no row should have been written.
  const usageRows = await t.run((ctx) =>
    ctx.db
      .query("aiUsageLog")
      .withIndex("by_account", (q) => q.eq("accountId", accountId))
      .collect(),
  );
  expect(usageRows).toHaveLength(0);
}, 20_000);

// ============================================================
// Eligibility gates — early-exit, no send
// ============================================================

test("early-exits without sending when the account's AI config is inactive", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
  });
  await configureAi(asUser, { isActive: false });
  const { contactId, conversationId } = await seedInboundThread(t, asUser, {
    accountId,
    phone: "15551234567",
    messageText: "Hello?",
  });

  await t.action(internal.aiReply.dispatchInbound, { accountId, conversationId, contactId });

  expect(await messagesFor(t, conversationId)).toHaveLength(1); // only the seeded inbound
  expect((await getConversation(t, conversationId))!.aiReplyCount ?? 0).toBe(0);
});

test("early-exits without sending when auto-reply is disabled for the account", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
  });
  await configureAi(asUser, { autoReplyEnabled: false });
  const { contactId, conversationId } = await seedInboundThread(t, asUser, {
    accountId,
    phone: "15551234567",
    messageText: "Hello?",
  });

  await t.action(internal.aiReply.dispatchInbound, { accountId, conversationId, contactId });

  expect(await messagesFor(t, conversationId)).toHaveLength(1);
});

test("early-exits without sending when auto-reply was disabled on this conversation (prior handoff)", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
  });
  await configureAi(asUser);
  const { contactId, conversationId } = await seedInboundThread(t, asUser, {
    accountId,
    phone: "15551234567",
    messageText: "Hello?",
  });
  await t.run((ctx) => ctx.db.patch(conversationId, { aiAutoreplyDisabled: true }));

  await t.action(internal.aiReply.dispatchInbound, { accountId, conversationId, contactId });

  expect(await messagesFor(t, conversationId)).toHaveLength(1);
});

test("early-exits without sending when a human already owns the conversation", async () => {
  const t = convexTest(schema, modules);
  const { accountId, userId, asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
  });
  await configureAi(asUser);
  const { contactId, conversationId } = await seedInboundThread(t, asUser, {
    accountId,
    phone: "15551234567",
    messageText: "Hello?",
  });
  await t.run((ctx) => ctx.db.patch(conversationId, { assignedToUserId: userId }));

  await t.action(internal.aiReply.dispatchInbound, { accountId, conversationId, contactId });

  expect(await messagesFor(t, conversationId)).toHaveLength(1);
});

test("hitting autoReplyMaxPerConversation early-exits with no send and leaves the count unchanged", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
  });
  await configureAi(asUser, { autoReplyMaxPerConversation: 3 });
  const { contactId, conversationId } = await seedInboundThread(t, asUser, {
    accountId,
    phone: "15551234567",
    messageText: "Hello?",
  });
  await t.run((ctx) => ctx.db.patch(conversationId, { aiReplyCount: 3 }));

  await t.action(internal.aiReply.dispatchInbound, { accountId, conversationId, contactId });

  expect(await messagesFor(t, conversationId)).toHaveLength(1); // no bot reply added
  expect((await getConversation(t, conversationId))!.aiReplyCount).toBe(3); // unchanged
});

// ============================================================
// Handoff
// ============================================================

test("a handoff-signalled reply disables auto-reply, sets status pending + a summary, and sends no normal reply", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
  });
  await configureAi(asUser); // no handoffAgentId configured
  const { contactId, conversationId } = await seedInboundThread(t, asUser, {
    accountId,
    phone: "15551234567",
    messageText: `I want to speak to a manager ${HANDOFF_SENTINEL}`,
  });

  await t.action(internal.aiReply.dispatchInbound, { accountId, conversationId, contactId });

  const messages = await messagesFor(t, conversationId);
  expect(messages.filter((m) => m.senderType === "bot")).toHaveLength(0);

  const conversation = await getConversation(t, conversationId);
  expect(conversation!.aiAutoreplyDisabled).toBe(true);
  expect(conversation!.status).toBe("pending");
  expect(conversation!.aiHandoffSummary).toContain("AI agent handed off");
  expect(conversation!.aiReplyCount ?? 0).toBe(0);
  // No handoff target configured — left unassigned (shared queue).
  expect(conversation!.assignedToUserId).toBeUndefined();
});

test("a handoff-signalled reply assigns the conversation to the configured handoff agent", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
  });
  const handoffAgentId = await seedTeammate(t, {
    accountId,
    name: "Hank (handoff agent)",
    email: "hank@example.com",
  });
  await configureAi(asUser, { handoffAgentId });
  const { contactId, conversationId } = await seedInboundThread(t, asUser, {
    accountId,
    phone: "15551234567",
    messageText: `This is unacceptable, get me a human ${HANDOFF_SENTINEL}`,
  });

  await t.action(internal.aiReply.dispatchInbound, { accountId, conversationId, contactId });

  const conversation = await getConversation(t, conversationId);
  expect(conversation!.assignedToUserId).toBe(handoffAgentId);
  expect(conversation!.status).toBe("pending");
  expect(conversation!.aiAutoreplyDisabled).toBe(true);
  const messages = await messagesFor(t, conversationId);
  expect(messages.filter((m) => m.senderType === "bot")).toHaveLength(0);
});

// ============================================================
// Account isolation
// ============================================================

test("account isolation: dispatching for one account never reads or mutates another account's conversation", async () => {
  const t = convexTest(schema, modules);
  const alice = await seedAccountMember(t, { name: "Alice", email: "alice@example.com" });
  await configureAi(alice.asUser);
  const aliceThread = await seedInboundThread(t, alice.asUser, {
    accountId: alice.accountId,
    phone: "15551234567",
    messageText: "Alice's customer says hi",
  });

  const bob = await seedAccountMember(t, { name: "Bob", email: "bob@example.com" });
  await configureAi(bob.asUser);
  const bobThread = await seedInboundThread(t, bob.asUser, {
    accountId: bob.accountId,
    phone: "15557654321",
    messageText: "Bob's customer says hi",
  });

  await t.action(internal.aiReply.dispatchInbound, {
    accountId: alice.accountId,
    conversationId: aliceThread.conversationId,
    contactId: aliceThread.contactId,
  });

  // Alice's own thread got the reply...
  expect(
    (await messagesFor(t, aliceThread.conversationId)).filter((m) => m.senderType === "bot"),
  ).toHaveLength(1);
  // ...but Bob's conversation/messages were never touched.
  expect(await messagesFor(t, bobThread.conversationId)).toHaveLength(1); // only Bob's own seeded inbound
  const bobConversation = await getConversation(t, bobThread.conversationId);
  expect(bobConversation!.aiReplyCount ?? 0).toBe(0);
});

test("account isolation: a cross-account id mix-up is a safe no-op", async () => {
  const t = convexTest(schema, modules);
  const alice = await seedAccountMember(t, { name: "Alice", email: "alice@example.com" });
  await configureAi(alice.asUser);
  const aliceThread = await seedInboundThread(t, alice.asUser, {
    accountId: alice.accountId,
    phone: "15551234567",
    messageText: "Alice's customer says hi",
  });

  const bob = await seedAccountMember(t, { name: "Bob", email: "bob@example.com" });
  await configureAi(bob.asUser); // Bob's own account IS active/auto-reply-enabled

  // Bob's accountId + Alice's conversationId/contactId — must never read
  // or act on Alice's data (mirrors `metaSend.test.ts`'s own cross-account
  // probe).
  await t.action(internal.aiReply.dispatchInbound, {
    accountId: bob.accountId,
    conversationId: aliceThread.conversationId,
    contactId: aliceThread.contactId,
  });

  expect(await messagesFor(t, aliceThread.conversationId)).toHaveLength(1); // untouched
  expect((await getConversation(t, aliceThread.conversationId))!.aiReplyCount ?? 0).toBe(0);
});
