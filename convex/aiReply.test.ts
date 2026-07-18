/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
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
  vi.useRealTimers(); // the retry tests below opt into fake timers
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
 *  configured `handoffAgentId` target (defaults to "agent") and, with an
 *  explicit `role`, for role-gating tests (matches `conversations.test
 *  .ts`'s own parametrized `seedTeammate`). */
async function seedTeammate(
  t: TestConvex<typeof schema>,
  opts: { accountId: Id<"accounts">; name: string; email: string; role?: AccountRole },
) {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { name: opts.name, email: opts.email });
    await ctx.db.insert("memberships", {
      userId,
      accountId: opts.accountId,
      role: opts.role ?? ("agent" as AccountRole),
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

test("hitting autoReplyMaxPerConversation hands off to a human instead of going silent", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
  });
  await configureAi(asUser, { autoReplyMaxPerConversation: 3 }); // no handoffAgentId
  const { contactId, conversationId } = await seedInboundThread(t, asUser, {
    accountId,
    phone: "15551234567",
    messageText: "Hello?",
  });
  await t.run((ctx) => ctx.db.patch(conversationId, { aiReplyCount: 3 }));

  await t.action(internal.aiReply.dispatchInbound, { accountId, conversationId, contactId });

  // No reply (the budget is spent) — but the thread must land in the
  // human queue rather than stranding the customer in silence.
  expect(await messagesFor(t, conversationId)).toHaveLength(1); // no bot reply added
  const conversation = await getConversation(t, conversationId);
  expect(conversation!.aiReplyCount).toBe(3); // unchanged
  expect(conversation!.aiAutoreplyDisabled).toBe(true);
  expect(conversation!.status).toBe("pending");
  expect(conversation!.aiHandoffSummary).toContain("reply limit");
  expect(conversation!.aiHandoffSummary).toContain("“Hello?”");
  // No handoff target configured — left unassigned (shared queue).
  expect(conversation!.assignedToUserId).toBeUndefined();
});

test("the cap-reached handoff assigns the configured handoff agent", async () => {
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
  await configureAi(asUser, { autoReplyMaxPerConversation: 3, handoffAgentId });
  const { contactId, conversationId } = await seedInboundThread(t, asUser, {
    accountId,
    phone: "15551234567",
    messageText: "Hello?",
  });
  await t.run((ctx) => ctx.db.patch(conversationId, { aiReplyCount: 3 }));

  await t.action(internal.aiReply.dispatchInbound, { accountId, conversationId, contactId });

  const conversation = await getConversation(t, conversationId);
  expect(conversation!.assignedToUserId).toBe(handoffAgentId);
  expect(conversation!.status).toBe("pending");
  expect(conversation!.aiAutoreplyDisabled).toBe(true);
});

// ============================================================
// Transient-failure retry — `[[FAIL]]` in the triggering message makes
// DRY-RUN's `syntheticGeneration` throw, exactly where a real provider/
// network failure would surface (same steering convention as the
// handoff sentinel). Fake timers + `finishAllScheduledFunctions` drain
// the scheduled retry, the `broadcasts.test.ts` idiom.
// ============================================================

test("a provider failure schedules one retry, which replies once the failure clears", async () => {
  vi.useFakeTimers();
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
  });
  await configureAi(asUser);
  const { contactId, conversationId } = await seedInboundThread(t, asUser, {
    accountId,
    phone: "15551234567",
    messageText: "[[FAIL]] what are your opening hours?",
  });

  await t.action(internal.aiReply.dispatchInbound, { accountId, conversationId, contactId });

  // First attempt failed — nothing sent, nothing claimed.
  expect(
    (await messagesFor(t, conversationId)).filter((m) => m.senderType === "bot"),
  ).toHaveLength(0);
  expect((await getConversation(t, conversationId))!.aiReplyCount ?? 0).toBe(0);

  // The transient failure clears before the retry fires.
  await t.run(async (ctx) => {
    const inbound = (await ctx.db
      .query("messages")
      .withIndex("by_conversation", (q) => q.eq("conversationId", conversationId))
      .collect())[0]!;
    await ctx.db.patch(inbound._id, { contentText: "what are your opening hours?" });
  });

  await t.finishAllScheduledFunctions(vi.runAllTimers);

  const botMessages = (await messagesFor(t, conversationId)).filter(
    (m) => m.senderType === "bot",
  );
  expect(botMessages).toHaveLength(1);
  expect((await getConversation(t, conversationId))!.aiReplyCount).toBe(1);
}, 20_000);

test("a persistent failure stops after the single retry — no reply, no endless rescheduling", async () => {
  vi.useFakeTimers();
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
  });
  await configureAi(asUser);
  const { contactId, conversationId } = await seedInboundThread(t, asUser, {
    accountId,
    phone: "15551234567",
    messageText: "[[FAIL]] hello",
  });

  await t.action(internal.aiReply.dispatchInbound, { accountId, conversationId, contactId });
  // Drains the retry (attempt 2), which fails again. If the code kept
  // rescheduling, this drain would never terminate — the test timeout
  // is the regression signal for that.
  await t.finishAllScheduledFunctions(vi.runAllTimers);

  expect(
    (await messagesFor(t, conversationId)).filter((m) => m.senderType === "bot"),
  ).toHaveLength(0);
  expect((await getConversation(t, conversationId))!.aiReplyCount ?? 0).toBe(0);
}, 20_000);

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
// markHandoff — direct `internalMutation` coverage of the lead-charge
// wiring (lead-value fix wave — final review, Fix 1). The two handoff
// tests above already prove `dispatchInbound` reaches `markHandoff` and
// that it assigns `handoffAgentId`; these call `markHandoff` itself
// directly (skipping the whole config/generation pipeline) to focus
// narrowly on the charge side, mirroring `automationsEngine.test.ts`'s
// own focused `assign_conversation` charge test.
// ============================================================

test("markHandoff charges the handoff agent when a lead value is set", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
  });
  await t.run((ctx) => ctx.db.patch(accountId, { leadValue: 5 }));
  const handoffAgentId = await seedTeammate(t, {
    accountId,
    name: "Hank (handoff agent)",
    email: "hank@example.com",
  });
  const { conversationId } = await seedInboundThread(t, asUser, {
    accountId,
    phone: "15551234567",
    messageText: "I need a human",
  });

  await t.mutation(internal.aiReply.markHandoff, {
    accountId,
    conversationId,
    handoffAgentId,
    summary: "test handoff",
  });

  const conversation = await getConversation(t, conversationId);
  expect(conversation!.assignedToUserId).toBe(handoffAgentId);

  const charges = await t.run((ctx) =>
    ctx.db
      .query("leadCharges")
      .withIndex("by_user_conversation", (q) =>
        q.eq("userId", handoffAgentId).eq("conversationId", conversationId),
      )
      .collect(),
  );
  expect(charges).toHaveLength(1);
  expect(charges[0]).toMatchObject({ accountId, value: 5, currency: "USD" });
});

test("markHandoff writes no charge when no handoff agent is configured (unassigned queue)", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
  });
  await t.run((ctx) => ctx.db.patch(accountId, { leadValue: 5 }));
  const { conversationId } = await seedInboundThread(t, asUser, {
    accountId,
    phone: "15551234567",
    messageText: "I need a human",
  });

  await t.mutation(internal.aiReply.markHandoff, {
    accountId,
    conversationId,
    summary: "test handoff",
  });

  expect((await getConversation(t, conversationId))!.assignedToUserId).toBeUndefined();
  expect(await t.run((ctx) => ctx.db.query("leadCharges").collect())).toHaveLength(0);
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

// ============================================================
// playground / draft — public, authed AI entry points (transitive-
// Supabase gap-fill task). Unlike `dispatchInbound` above, these never
// check `CONVEX_AI_DRY_RUN` — they always call the real `generateReply`,
// so every test that reaches it stubs `global.fetch` directly (the
// brief's own "(mock provider)" test strategy), rather than relying on
// the file-level DRY-RUN `beforeEach`/`afterEach` above (which only
// gates `dispatchInbound`'s own synthetic-generation branch and is
// otherwise inert for these two actions).
// ============================================================

function okChatCompletion(content: string): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content } }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    }),
    { status: 200 },
  );
}

// ------------------------------------------------------------
// playground
// ------------------------------------------------------------

test("playground generates a reply from the mocked provider, in the route's shape", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => okChatCompletion("Sure, happy to help!")));
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
  });
  await configureAi(asUser);

  const result = await asUser.action(api.aiReply.playground, {
    messages: [{ role: "user", content: "What are your hours?" }],
  });

  expect(result).toEqual({ reply: "Sure, happy to help!", handoff: false });
  vi.unstubAllGlobals();
});

test("playground returns ai_not_configured (never throws) when the account has no AI config", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
  });

  const result = await asUser.action(api.aiReply.playground, {
    messages: [{ role: "user", content: "Hello?" }],
  });

  expect(result).toEqual({
    error: "No agent configured yet. Add your provider key in Setup.",
    code: "ai_not_configured",
  });
});

test("playground returns an error (never throws) when every message is blank", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
  });

  const result = await asUser.action(api.aiReply.playground, {
    messages: [{ role: "user", content: "   " }],
  });

  expect(result).toEqual({ error: "Send a message to test the agent." });
});

test("playground throws FORBIDDEN for a viewer (below the agent role floor)", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
  });
  const vicUserId = await seedTeammate(t, {
    accountId,
    name: "Vic",
    email: "vic@example.com",
    role: "viewer",
  });
  const asVic = t.withIdentity({ subject: `${vicUserId}|session-Vic` });

  await expect(
    asVic.action(api.aiReply.playground, {
      messages: [{ role: "user", content: "Hello?" }],
    }),
  ).rejects.toMatchObject({ data: { code: "FORBIDDEN", min: "agent" } });
});

test("playground throws UNAUTHENTICATED when there is no identity", async () => {
  const t = convexTest(schema, modules);

  await expect(
    t.action(api.aiReply.playground, {
      messages: [{ role: "user", content: "Hello?" }],
    }),
  ).rejects.toMatchObject({ data: { code: "UNAUTHENTICATED" } });
});

test("account isolation: playground never falls back to a different account's AI config", async () => {
  const t = convexTest(schema, modules);
  const alice = await seedAccountMember(t, { name: "Alice", email: "alice@example.com" });
  await configureAi(alice.asUser);
  const bob = await seedAccountMember(t, { name: "Bob", email: "bob@example.com" });

  // Bob has no config of his own — must get ai_not_configured, never
  // silently generate using Alice's saved provider/key.
  const result = await bob.asUser.action(api.aiReply.playground, {
    messages: [{ role: "user", content: "Hello?" }],
  });

  expect(result).toMatchObject({ code: "ai_not_configured" });
});

// ------------------------------------------------------------
// draft
// ------------------------------------------------------------

test("draft generates a suggested reply from the mocked provider, without sending or persisting a message", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => okChatCompletion("Our hours are 9-5 Mon-Fri.")));
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
  });
  await configureAi(asUser);
  const { conversationId } = await seedInboundThread(t, asUser, {
    accountId,
    phone: "15551234567",
    messageText: "What are your hours?",
  });

  const result = await asUser.action(api.aiReply.draft, { conversationId });

  expect(result).toEqual({ draft: "Our hours are 9-5 Mon-Fri." });
  // Read-only — no message was appended by the draft itself.
  expect(await messagesFor(t, conversationId)).toHaveLength(1); // only the seeded customer message

  // Usage is logged (mirrors the route's own best-effort `logAiUsage`).
  const usageRows = await t.run((ctx) =>
    ctx.db
      .query("aiUsageLog")
      .withIndex("by_account", (q) => q.eq("accountId", accountId))
      .collect(),
  );
  expect(usageRows).toHaveLength(1);
  expect(usageRows[0]!.mode).toBe("draft");
  vi.unstubAllGlobals();
});

test("draft throws NOT_FOUND for a conversation belonging to a different account, without generating anything", async () => {
  const t = convexTest(schema, modules);
  const alice = await seedAccountMember(t, { name: "Alice", email: "alice@example.com" });
  await configureAi(alice.asUser);
  const aliceThread = await seedInboundThread(t, alice.asUser, {
    accountId: alice.accountId,
    phone: "15551234567",
    messageText: "Alice's customer says hi",
  });
  const bob = await seedAccountMember(t, { name: "Bob", email: "bob@example.com" });

  await expect(
    bob.asUser.action(api.aiReply.draft, {
      conversationId: aliceThread.conversationId,
    }),
  ).rejects.toMatchObject({ data: { code: "NOT_FOUND", entity: "conversation" } });
});

test("draft throws FORBIDDEN for a viewer (below the agent role floor)", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
  });
  await configureAi(asUser);
  const { conversationId } = await seedInboundThread(t, asUser, {
    accountId,
    phone: "15551234567",
    messageText: "Hi",
  });
  const vicUserId = await seedTeammate(t, {
    accountId,
    name: "Vic",
    email: "vic@example.com",
    role: "viewer",
  });
  const asVic = t.withIdentity({ subject: `${vicUserId}|session-Vic` });

  await expect(
    asVic.action(api.aiReply.draft, { conversationId }),
  ).rejects.toMatchObject({ data: { code: "FORBIDDEN", min: "agent" } });
});

test("draft throws UNAUTHENTICATED when there is no identity", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
  });
  const { conversationId } = await seedInboundThread(t, asUser, {
    accountId,
    phone: "15551234567",
    messageText: "Hi",
  });

  await expect(
    t.action(api.aiReply.draft, { conversationId }),
  ).rejects.toMatchObject({ data: { code: "UNAUTHENTICATED" } });
});

test("draft returns no_messages (never throws) for a brand-new conversation with no text history", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
  });
  await configureAi(asUser);
  const contactId = await asUser.mutation(api.contacts.create, {
    phone: "15559998888",
  });
  const conversationId = await t.run((ctx) =>
    ctx.db.insert("conversations", {
      accountId,
      contactId,
      status: "open" as const,
      unreadCount: 0,
    }),
  );

  const result = await asUser.action(api.aiReply.draft, { conversationId });

  expect(result).toEqual({
    error: "No messages to draft from yet.",
    code: "no_messages",
  });
});

test("draft returns ai_not_configured (never throws) when the account has no AI config", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
  });
  const { conversationId } = await seedInboundThread(t, asUser, {
    accountId,
    phone: "15551234567",
    messageText: "Hi",
  });

  const result = await asUser.action(api.aiReply.draft, { conversationId });

  expect(result).toEqual({
    error: "AI assistant is not set up. Enable it in Settings → AI Assistant.",
    code: "ai_not_configured",
  });
});
