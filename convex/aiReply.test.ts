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

/** Adds a second membership row to an *existing* account — for
 *  role-gating tests via an explicit `role` (matches `conversations.test
 *  .ts`'s own parametrized `seedTeammate`; defaults to "agent"). */
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
};

/** Admin+ upsert of the caller's AI config — active + auto-reply on by
 *  default; override any field (e.g. `isActive: false`) per test. */
async function configureAi(
  asUser: Awaited<ReturnType<typeof seedAccountMember>>["asUser"],
  overrides: Partial<typeof BASE_AI_CONFIG_ARGS> = {},
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
    messageText: "Hi, what are your opening hours?",
  });

  await t.action(internal.aiReply.dispatchInbound, { accountId, conversationId, contactId });
  // The reply now lands via a scheduled `deliverReply` (length-proportional
  // delay) instead of sending inline — drain the scheduler so it fires.
  await t.finishAllScheduledFunctions(vi.runAllTimers);

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

test("no reply cap: the bot keeps replying no matter how many replies it has already sent", async () => {
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
    messageText: "Hello?",
  });
  // A long-running thread: 50 bot replies already sent. There is no
  // cap — the bot answers every message until a human takes the chat
  // from the dashboard (assignment / autoreply-pause are the ONLY stops).
  await t.run((ctx) => ctx.db.patch(conversationId, { aiReplyCount: 50 }));

  await t.action(internal.aiReply.dispatchInbound, { accountId, conversationId, contactId });
  await t.finishAllScheduledFunctions(vi.runAllTimers);

  const botMessages = (await messagesFor(t, conversationId)).filter(
    (m) => m.senderType === "bot",
  );
  expect(botMessages).toHaveLength(1);
  const conversation = await getConversation(t, conversationId);
  expect(conversation!.aiReplyCount).toBe(51); // still counted (metrics), never gating
  expect(conversation!.aiAutoreplyDisabled).not.toBe(true);
  expect(conversation!.status).toBe("open");
  expect(conversation!.assignedToUserId).toBeUndefined();
}, 20_000);

// ============================================================
// Media understanding — inbound voice notes are transcribed and images
// described (OpenAI, DRY-RUN synthetic here), stored on the message
// row (`aiTranscription`) and rendered into the transcript so the
// reply addresses the ACTUAL content, not just "[voice note]".
// ============================================================

test("a voice note is transcribed before replying and the transcript is stored on the row", async () => {
  vi.useFakeTimers();
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
  });
  await configureAi(asUser);
  const contactId = await asUser.mutation(api.contacts.create, { phone: "15551234567" });
  const conversationId = await t.run((ctx) =>
    ctx.db.insert("conversations", {
      accountId,
      contactId,
      status: "open" as const,
      unreadCount: 0,
    }),
  );
  const audioMessageId = await t.run((ctx) =>
    ctx.db.insert("messages", {
      accountId,
      conversationId,
      senderType: "customer" as const,
      contentType: "audio" as const,
      mediaUrl: "https://example.com/voice.ogg",
      status: "sent" as const,
    }),
  );

  await t.action(internal.aiReply.dispatchInbound, { accountId, conversationId, contactId });
  await t.finishAllScheduledFunctions(vi.runAllTimers);

  const audioRow = await t.run((ctx) => ctx.db.get(audioMessageId));
  expect(audioRow!.aiTranscription).toBe("[dry-run transcript]");
  const botMessages = (await messagesFor(t, conversationId)).filter(
    (m) => m.senderType === "bot",
  );
  expect(botMessages).toHaveLength(1);
}, 20_000);

test("an inbound image is described the same way", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
  });
  await configureAi(asUser);
  const contactId = await asUser.mutation(api.contacts.create, { phone: "15551234567" });
  const conversationId = await t.run((ctx) =>
    ctx.db.insert("conversations", {
      accountId,
      contactId,
      status: "open" as const,
      unreadCount: 0,
    }),
  );
  const imageMessageId = await t.run((ctx) =>
    ctx.db.insert("messages", {
      accountId,
      conversationId,
      senderType: "customer" as const,
      contentType: "image" as const,
      contentText: "my visa",
      mediaUrl: "https://example.com/visa.jpg",
      status: "sent" as const,
    }),
  );

  await t.action(internal.aiReply.dispatchInbound, { accountId, conversationId, contactId });

  const imageRow = await t.run((ctx) => ctx.db.get(imageMessageId));
  expect(imageRow!.aiTranscription).toBe("[dry-run transcript]");
}, 20_000);

test("a customer media row with only mediaKey (no mediaUrl) is still picked up and transcribed", async () => {
  // Task 5 of the R2 migration: `untranscribedMediaRows`' filter widens
  // from `m.mediaUrl` alone to `m.mediaKey || m.mediaUrl` — without that
  // widening, a key-only row (the post-cutover shape) would be silently
  // excluded from the query and never transcribed at all.
  process.env.R2_BUCKET = "wa-holidayys";
  process.env.R2_ENDPOINT = "https://acct.r2.cloudflarestorage.com";
  process.env.R2_ACCESS_KEY_ID = "ak";
  process.env.R2_SECRET_ACCESS_KEY = "sk";
  process.env.R2_PUBLIC_HOST = "https://objs.holidayys.co";
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
  });
  await configureAi(asUser);
  const contactId = await asUser.mutation(api.contacts.create, { phone: "15551234567" });
  const conversationId = await t.run((ctx) =>
    ctx.db.insert("conversations", {
      accountId,
      contactId,
      status: "open" as const,
      unreadCount: 0,
    }),
  );
  const audioMessageId = await t.run((ctx) =>
    ctx.db.insert("messages", {
      accountId,
      conversationId,
      senderType: "customer" as const,
      contentType: "audio" as const,
      mediaKey: "acc1/inbound/voice.ogg",
      status: "sent" as const,
    }),
  );

  await t.action(internal.aiReply.dispatchInbound, { accountId, conversationId, contactId });

  const audioRow = await t.run((ctx) => ctx.db.get(audioMessageId));
  expect(audioRow!.aiTranscription).toBe("[dry-run transcript]");

  delete process.env.R2_BUCKET;
  delete process.env.R2_ENDPOINT;
  delete process.env.R2_ACCESS_KEY_ID;
  delete process.env.R2_SECRET_ACCESS_KEY;
  delete process.env.R2_PUBLIC_HOST;
}, 20_000);

test("a customer media row with mediaKey and R2 unconfigured is skipped (best-effort) rather than crashing the dispatch", async () => {
  // The exact trap this task's brief calls out: `r2ConfigFromEnv()`
  // throws when R2 env vars are unset. This row's `mediaKey` forces
  // `resolveMediaUrlLazy` to actually build the config, which throws
  // here (no R2_* env vars set anywhere in this suite) — that throw must
  // be caught per-row (matching the existing "best-effort per row"
  // design already documented on `untranscribedMediaRows`) and must not
  // take down the rest of the dispatch (the reply still sends).
  vi.useFakeTimers();
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
  });
  await configureAi(asUser);
  const contactId = await asUser.mutation(api.contacts.create, { phone: "15551234567" });
  const conversationId = await t.run((ctx) =>
    ctx.db.insert("conversations", {
      accountId,
      contactId,
      status: "open" as const,
      unreadCount: 0,
    }),
  );
  const audioMessageId = await t.run((ctx) =>
    ctx.db.insert("messages", {
      accountId,
      conversationId,
      senderType: "customer" as const,
      contentType: "audio" as const,
      mediaKey: "acc1/inbound/voice.ogg",
      status: "sent" as const,
    }),
  );

  await t.action(internal.aiReply.dispatchInbound, { accountId, conversationId, contactId });
  // `dispatchInbound` no longer sends inline — it schedules `deliverReply`
  // after the pacing delay — so the reply only exists once the scheduler is
  // drained. The assertion below is unchanged: the point is still that a
  // throwing `resolveMediaUrlLazy` is caught per-row and does NOT cost the
  // customer their reply.
  await t.finishAllScheduledFunctions(vi.runAllTimers);

  const audioRow = await t.run((ctx) => ctx.db.get(audioMessageId));
  expect(audioRow!.aiTranscription).toBeUndefined();
  const botMessages = (await messagesFor(t, conversationId)).filter(
    (m) => m.senderType === "bot",
  );
  expect(botMessages).toHaveLength(1); // dispatch completes and still replies
}, 20_000);

test("no usable OpenAI key (anthropic provider, no embeddings key) skips transcription but still replies", async () => {
  vi.useFakeTimers();
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
  });
  await configureAi(asUser, { provider: "anthropic" as never, model: "claude-3-5-haiku-latest" });
  const contactId = await asUser.mutation(api.contacts.create, { phone: "15551234567" });
  const conversationId = await t.run((ctx) =>
    ctx.db.insert("conversations", {
      accountId,
      contactId,
      status: "open" as const,
      unreadCount: 0,
    }),
  );
  const audioMessageId = await t.run((ctx) =>
    ctx.db.insert("messages", {
      accountId,
      conversationId,
      senderType: "customer" as const,
      contentType: "audio" as const,
      mediaUrl: "https://example.com/voice.ogg",
      status: "sent" as const,
    }),
  );

  await t.action(internal.aiReply.dispatchInbound, { accountId, conversationId, contactId });
  await t.finishAllScheduledFunctions(vi.runAllTimers);

  const audioRow = await t.run((ctx) => ctx.db.get(audioMessageId));
  expect(audioRow!.aiTranscription).toBeUndefined();
  const botMessages = (await messagesFor(t, conversationId)).filter(
    (m) => m.senderType === "bot",
  );
  expect(botMessages).toHaveLength(1); // placeholder-only context still gets a reply
}, 20_000);

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

test("a provider failure's scheduled retry also re-acks (whole-branch review Fix F1, re-opened): the ack's indicator must land WITH the retry, not die ~5s before it starts", async () => {
  vi.useFakeTimers();
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice-retry-ack@example.com",
  });
  await configureAi(asUser);
  const { contactId, conversationId } = await seedInboundThread(t, asUser, {
    accountId,
    phone: "15551234598",
    messageText: "[[FAIL]] what are your opening hours?",
  });

  const before = Date.now();
  await t.action(internal.aiReply.dispatchInbound, {
    accountId,
    conversationId,
    contactId,
    triggerWamid: "wamid.RETRYACK",
  });

  // Right after the first (failed) attempt: a retry AND a re-ack must
  // both be scheduled, carrying the SAME triggerWamid forward so the ack
  // re-marks the SAME inbound as read/typing.
  const scheduled = await t.run((ctx) =>
    ctx.db.system.query("_scheduled_functions").collect(),
  );
  const ackRows = scheduled.filter((s) => s.name === "aiReply:ackInbound");
  expect(ackRows).toHaveLength(1);
  expect(ackRows[0]!.args[0]).toMatchObject({
    accountId,
    conversationId,
    contactId,
    triggerWamid: "wamid.RETRYACK",
  });

  const dispatchRetryRows = scheduled.filter((s) => s.name === "aiReply:dispatchInbound");
  expect(dispatchRetryRows).toHaveLength(1);
  expect(dispatchRetryRows[0]!.args[0]).toMatchObject({ attempt: 2 });

  // THE BUG this re-opened finding is about: Meta's typing indicator
  // auto-dismisses ~25s after it's shown, with no refresh, and the retry
  // above doesn't actually RUN until it fires — DISPATCH_RETRY_DELAY_MS
  // (30s) after this catch block, not 0s after it. Scheduling the ack at
  // delay 0 (the previous, incomplete fix) means its indicator is already
  // dead by the time the retry starts. The correct fix schedules the ack
  // at the SAME delay as the retry so the two land together — assert
  // that relationship directly, rather than merely "an ack exists
  // somewhere" (which is all the old assertion checked, and which is
  // exactly what let the +0ms regression through the first time).
  expect(
    Math.abs(ackRows[0]!.scheduledTime - dispatchRetryRows[0]!.scheduledTime),
  ).toBeLessThan(1000);
  // Guards against a vacuous pass (e.g. both landing near `before` due to
  // some other regression): the shared time must itself be a real delay,
  // not immediate — comfortably below the real 30s retry delay so this
  // doesn't hardcode DISPATCH_RETRY_DELAY_MS's exact value, but well
  // above "basically now".
  expect(ackRows[0]!.scheduledTime - before).toBeGreaterThan(20_000);

  // The transient failure clears before the retry fires — the reply
  // still lands normally, same as the existing (pre-F1) retry test above.
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
}, 20_000);

// ============================================================
// Handoff
// ============================================================

test("a model-emitted handoff marker never silences the bot — the customer still gets a reply", async () => {
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
    messageText: `I want to speak to a manager ${HANDOFF_SENTINEL}`,
  });

  await t.action(internal.aiReply.dispatchInbound, { accountId, conversationId, contactId });
  await t.finishAllScheduledFunctions(vi.runAllTimers);

  // Handoff is MANUAL-ONLY (dashboard takeover). Even if the model
  // emits the legacy marker, the customer still hears something and the
  // thread stays fully bot-owned.
  const botMessages = (await messagesFor(t, conversationId)).filter(
    (m) => m.senderType === "bot",
  );
  expect(botMessages).toHaveLength(1);
  expect(botMessages[0]!.contentText).toBeTruthy();
  expect(botMessages[0]!.contentText).not.toContain("[[HANDOFF]]");

  const conversation = await getConversation(t, conversationId);
  expect(conversation!.aiAutoreplyDisabled).not.toBe(true);
  expect(conversation!.status).toBe("open");
  expect(conversation!.assignedToUserId).toBeUndefined();
  expect(conversation!.aiReplyCount).toBe(1);
}, 20_000);

// ============================================================
// flagForHuman — the ONLY thing the AI stack may do when a thread
// needs human eyes: surface it (status pending + summary). It must
// never silence the bot, assign anyone, or charge a lead — takeover is
// exclusively a manual dashboard action.
// ============================================================

test("flagForHuman marks the thread pending + bells supervisors, but never silences, assigns, or charges — and never double-bells", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
  });
  await t.run((ctx) => ctx.db.patch(accountId, { leadValue: 5 }));
  const supervisorUserId = await seedTeammate(t, {
    accountId,
    name: "Sam (supervisor)",
    email: "sam@example.com",
    role: "supervisor",
  });
  const { conversationId } = await seedInboundThread(t, asUser, {
    accountId,
    phone: "15551234567",
    messageText: "I need a human",
  });

  await t.mutation(internal.aiReply.flagForHuman, {
    accountId,
    conversationId,
    summary: "🤖 Customer asked for a human.",
  });

  const conversation = await getConversation(t, conversationId);
  expect(conversation!.status).toBe("pending");
  expect(conversation!.aiHandoffSummary).toBe("🤖 Customer asked for a human.");
  expect(conversation!.aiAutoreplyDisabled).not.toBe(true);
  expect(conversation!.assignedToUserId).toBeUndefined();

  const charges = await t.run((ctx) => ctx.db.query("leadCharges").collect());
  expect(charges).toHaveLength(0);

  // Surfacing means someone actually HEARS about it: supervisors get a
  // bell (the admin seeding user does too — supervisor+ role).
  const bells = await t.run((ctx) =>
    ctx.db
      .query("notifications")
      .withIndex("by_account", (q) => q.eq("accountId", accountId))
      .collect(),
  );
  expect(bells.filter((n) => n.userId === supervisorUserId)).toHaveLength(1);
  expect(bells.every((n) => n.type === "sla_alert")).toBe(true);

  // Re-flagging an already-flagged thread refreshes the note, no re-bell.
  await t.mutation(internal.aiReply.flagForHuman, {
    accountId,
    conversationId,
    summary: "🤖 Customer asked again.",
  });
  const bellsAfter = await t.run((ctx) =>
    ctx.db
      .query("notifications")
      .withIndex("by_account", (q) => q.eq("accountId", accountId))
      .collect(),
  );
  expect(bellsAfter.length).toBe(bells.length);
  expect((await getConversation(t, conversationId))!.aiHandoffSummary).toBe(
    "🤖 Customer asked again.",
  );
});

// ============================================================
// Account isolation
// ============================================================

test("account isolation: dispatching for one account never reads or mutates another account's conversation", async () => {
  vi.useFakeTimers();
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
  await t.finishAllScheduledFunctions(vi.runAllTimers);

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

// Whole-branch review Fix 3: `playground` loads the DECRYPTED account
// config (including `systemPrompt`) and spends the account's own BYO
// provider budget, so its floor was raised from agent+ to admin+ — its
// only UI (`/agents`'s Playground tab) is already admin/owner-only. This
// pins the new floor at BOTH ends: a supervisor (who now sees Campaigns
// and much of the dashboard on this branch, but must NOT reach the AI
// config) is rejected, same as a plain viewer.
test("playground throws FORBIDDEN for a viewer (below the admin role floor)", async () => {
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
  ).rejects.toMatchObject({ data: { code: "FORBIDDEN", min: "admin" } });
});

test("playground throws FORBIDDEN for a supervisor (raised from agent+ to admin+ by Fix 3 — supervisors must not reach the decrypted config or spend the account's AI budget)", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
  });
  const supUserId = await seedTeammate(t, {
    accountId,
    name: "Sam",
    email: "sam@example.com",
    role: "supervisor",
  });
  const asSam = t.withIdentity({ subject: `${supUserId}|session-Sam` });

  await expect(
    asSam.action(api.aiReply.playground, {
      messages: [{ role: "user", content: "Hello?" }],
    }),
  ).rejects.toMatchObject({ data: { code: "FORBIDDEN", min: "admin" } });
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

// ------------------------------------------------------------
// draft — per-conversation RBAC. An agent must not draft a reply
// grounded in a COLLEAGUE'S assigned thread that the message read layer
// (`messages.listByConversation`) would refuse to show them. With no AI
// config, an ALLOWED call falls through to `ai_not_configured`; a DENIED
// call throws NOT_FOUND before ever reaching the config check.
// ------------------------------------------------------------

test("draft throws NOT_FOUND when an agent targets a conversation assigned to a different agent", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser: asAdmin } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
  });
  const { conversationId } = await seedInboundThread(t, asAdmin, {
    accountId,
    phone: "15551234567",
    messageText: "Hi",
  });
  const bobId = await seedTeammate(t, {
    accountId,
    name: "Bob",
    email: "bob@example.com",
    role: "agent",
  });
  const carlId = await seedTeammate(t, {
    accountId,
    name: "Carl",
    email: "carl@example.com",
    role: "agent",
  });
  await t.run((ctx) =>
    ctx.db.patch(conversationId, { assignedToUserId: bobId }),
  );
  const asCarl = t.withIdentity({ subject: `${carlId}|session-Carl` });

  await expect(
    asCarl.action(api.aiReply.draft, { conversationId }),
  ).rejects.toMatchObject({ data: { code: "NOT_FOUND", entity: "conversation" } });
});

test("draft allows the assigned agent (reaches ai_not_configured, not NOT_FOUND)", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser: asAdmin } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
  });
  const { conversationId } = await seedInboundThread(t, asAdmin, {
    accountId,
    phone: "15551234567",
    messageText: "Hi",
  });
  const bobId = await seedTeammate(t, {
    accountId,
    name: "Bob",
    email: "bob@example.com",
    role: "agent",
  });
  await t.run((ctx) =>
    ctx.db.patch(conversationId, { assignedToUserId: bobId }),
  );
  const asBob = t.withIdentity({ subject: `${bobId}|session-Bob` });

  const result = await asBob.action(api.aiReply.draft, { conversationId });
  expect(result).toMatchObject({ code: "ai_not_configured" });
});

test("draft allows a supervisor on another agent's assigned conversation", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser: asAdmin } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
  });
  const { conversationId } = await seedInboundThread(t, asAdmin, {
    accountId,
    phone: "15551234567",
    messageText: "Hi",
  });
  const bobId = await seedTeammate(t, {
    accountId,
    name: "Bob",
    email: "bob@example.com",
    role: "agent",
  });
  const samId = await seedTeammate(t, {
    accountId,
    name: "Sam",
    email: "sam@example.com",
    role: "supervisor",
  });
  await t.run((ctx) =>
    ctx.db.patch(conversationId, { assignedToUserId: bobId }),
  );
  const asSam = t.withIdentity({ subject: `${samId}|session-Sam` });

  const result = await asSam.action(api.aiReply.draft, { conversationId });
  expect(result).toMatchObject({ code: "ai_not_configured" });
});

test("draft allows an agent on an unassigned (pool) conversation", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser: asAdmin } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
  });
  const { conversationId } = await seedInboundThread(t, asAdmin, {
    accountId,
    phone: "15551234567",
    messageText: "Hi",
  });
  const carlId = await seedTeammate(t, {
    accountId,
    name: "Carl",
    email: "carl@example.com",
    role: "agent",
  });
  const asCarl = t.withIdentity({ subject: `${carlId}|session-Carl` });

  const result = await asCarl.action(api.aiReply.draft, { conversationId });
  expect(result).toMatchObject({ code: "ai_not_configured" });
});

// ============================================================
// Ad-aware replies (CTWA lead-source grounding)
// ============================================================

// End-to-end through `dispatchInbound`: an ad-lead conversation (the
// `adReferral` denorm ingest writes) still replies normally AND lazily
// warms the `adLandingPages` cache for the ad's link — the observable
// half of `loadAdContext`. The prompt-side rendering is asserted in
// `lib/ai/adContext.test.ts`; the fetch itself is `CONVEX_AI_DRY_RUN`-
// synthetic here (see `adLanding.ts`).
test("an ad-lead conversation replies AND warms the landing cache lazily", async () => {
  vi.useFakeTimers();
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Ada",
    email: "ada@example.com",
  });
  await configureAi(asUser);
  const { contactId, conversationId } = await seedInboundThread(t, asUser, {
    accountId,
    phone: "15551230000",
    messageText: "Hi",
  });
  await t.run(async (ctx) => {
    await ctx.db.patch(conversationId, {
      adReferral: {
        headline: "Georgia Summer Package",
        body: "5 nights from AED 1299",
        sourceUrl: "https://holidayys.co/packages/georgia-summer?fbclid=click-1",
        sourceType: "ad" as const,
        startedAt: Date.now(),
      },
    });
  });

  await t.action(internal.aiReply.dispatchInbound, { accountId, conversationId, contactId });
  await t.finishAllScheduledFunctions(vi.runAllTimers);

  const botMessages = (await messagesFor(t, conversationId)).filter(
    (m) => m.senderType === "bot",
  );
  expect(botMessages).toHaveLength(1);
  expect(botMessages[0]!.contentText).toBeTruthy();

  const landingRows = await t.run((ctx) =>
    ctx.db
      .query("adLandingPages")
      .withIndex("by_account_url", (q) =>
        q
          .eq("accountId", accountId)
          .eq("urlKey", "https://holidayys.co/packages/georgia-summer"),
      )
      .collect(),
  );
  expect(landingRows).toHaveLength(1);
  expect(landingRows[0]!.status).toBe("ok");
}, 15_000);

// A referral WITHOUT a usable link still replies (context is just the
// ad text) and never touches the landing cache.
test("an ad-lead conversation with no source_url replies without a landing row", async () => {
  vi.useFakeTimers();
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Ben",
    email: "ben@example.com",
  });
  await configureAi(asUser);
  const { contactId, conversationId } = await seedInboundThread(t, asUser, {
    accountId,
    phone: "15551231111",
    messageText: "Hi",
  });
  await t.run(async (ctx) => {
    await ctx.db.patch(conversationId, {
      adReferral: {
        headline: "Georgia Summer Package",
        sourceType: "ad" as const,
        startedAt: Date.now(),
      },
    });
  });

  await t.action(internal.aiReply.dispatchInbound, { accountId, conversationId, contactId });
  await t.finishAllScheduledFunctions(vi.runAllTimers);

  const botMessages = (await messagesFor(t, conversationId)).filter(
    (m) => m.senderType === "bot",
  );
  expect(botMessages).toHaveLength(1);
  const landingRows = await t.run((ctx) => ctx.db.query("adLandingPages").collect());
  expect(landingRows).toHaveLength(0);
});

// ============================================================
// hasKnowledgeChunks — the retrieval gate over BOTH pools
// ============================================================

// Every caller of `aiKnowledge.retrieve` is gated on this query, so a
// pool it fails to probe is a pool the AI silently cannot see. It
// deliberately spans both: the legacy `aiKnowledgeChunks` and the
// compiled `kbChunks` of Knowledge Engine v2.
test("hasKnowledgeChunks is true for EITHER pool alone and false with neither", async () => {
  const t = convexTest(schema, modules);

  // 1. Compiled-only — the account that migrated to v2 and then deleted
  //    its pasted documents through `aiKnowledge.remove` in the settings
  //    UI. This is the case a legacy-only probe would get wrong, and it
  //    fails CLOSED: auto-reply and all three engines would ground on
  //    nothing while `kbChunks` sat fully populated, with no error
  //    anywhere to notice it by.
  const { accountId: compiledOnly } = await seedAccountMember(t, {
    name: "Compiled",
    email: "compiled@example.com",
  });
  await t.run((ctx) =>
    ctx.db.insert("kbChunks", {
      accountId: compiledOnly,
      sourceKind: "entry" as const,
      serviceKey: "georgia",
      entryType: "note",
      audience: "customer" as const,
      chunkIndex: 0,
      content: "[Georgia — Visa requirements]\nPassport valid 6 months.",
    }),
  );
  await t.run(async (ctx) => {
    // Guard the guard: assert the premise (NO legacy rows at all), so
    // this can never pass for the wrong reason.
    const legacy = await ctx.db
      .query("aiKnowledgeChunks")
      .withIndex("by_account", (q) => q.eq("accountId", compiledOnly))
      .collect();
    expect(legacy).toHaveLength(0);
  });
  expect(
    await t.query(internal.aiReply.hasKnowledgeChunks, {
      accountId: compiledOnly,
    }),
  ).toBe(true);

  // 2. Legacy-only — the pre-v2 shape, still how this account is served
  //    for everything not yet migrated. Proves the widened check is a
  //    real OR rather than a swapped probe.
  const { accountId: legacyOnly } = await seedAccountMember(t, {
    name: "Legacy",
    email: "legacy@example.com",
  });
  await t.run(async (ctx) => {
    const documentId = await ctx.db.insert("aiKnowledgeDocuments", {
      accountId: legacyOnly,
      title: "KB 3 — Georgia",
      content: "QUALIFICATION CHECKLIST — Georgia",
      updatedAt: Date.now(),
    });
    await ctx.db.insert("aiKnowledgeChunks", {
      accountId: legacyOnly,
      documentId,
      chunkIndex: 0,
      content: "QUALIFICATION CHECKLIST — Georgia",
    });
  });
  expect(
    await t.query(internal.aiReply.hasKnowledgeChunks, {
      accountId: legacyOnly,
    }),
  ).toBe(true);

  // 3. Neither pool — the negative control that keeps the two above from
  //    being vacuous, and the perf fast-path this query exists for: no
  //    knowledge anywhere means `dispatchInbound` skips the `retrieve`
  //    action (its config load + potential embedding call) entirely.
  const { accountId: empty } = await seedAccountMember(t, {
    name: "Empty",
    email: "empty@example.com",
  });
  expect(
    await t.query(internal.aiReply.hasKnowledgeChunks, { accountId: empty }),
  ).toBe(false);
});

// ============================================================
// Instant acknowledgement (ackInbound) — blue tick + "typing…" the
// moment the inbound lands, independent of the debounced dispatch.
// ============================================================

test("ackInbound returns skipped_inactive when auto-reply is switched off", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Owner",
    email: "owner-ack-off@example.com",
  });
  await configureAi(asUser, { autoReplyEnabled: false });
  const { contactId, conversationId } = await seedInboundThread(t, asUser, {
    accountId,
    phone: "+971500000101",
    messageText: "hi",
  });

  // Must resolve without throwing and without reaching Meta. A throw
  // here would surface as an unhandled scheduled-function failure.
  const result = await t.action(internal.aiReply.ackInbound, {
    accountId,
    conversationId,
    contactId,
    triggerWamid: "wamid.TEST_ACK_OFF",
  });

  expect(result).toBe("skipped_inactive");
});

test("ackInbound returns skipped_assigned once a human owns the thread", async () => {
  const t = convexTest(schema, modules);
  const { accountId, userId, asUser } = await seedAccountMember(t, {
    name: "Owner",
    email: "owner-ack-assigned@example.com",
  });
  await configureAi(asUser);
  const { contactId, conversationId } = await seedInboundThread(t, asUser, {
    accountId,
    phone: "+971500000102",
    messageText: "hi",
  });

  await t.run(async (ctx) => {
    await ctx.db.patch(conversationId, { assignedToUserId: userId });
  });

  const result = await t.action(internal.aiReply.ackInbound, {
    accountId,
    conversationId,
    contactId,
    triggerWamid: "wamid.TEST_ACK_ASSIGNED",
  });

  expect(result).toBe("skipped_assigned");
});

test("ackInbound returns acked when the conversation is eligible", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Owner",
    email: "owner-ack-eligible@example.com",
  });
  await configureAi(asUser);
  const { contactId, conversationId } = await seedInboundThread(t, asUser, {
    accountId,
    phone: "+971500000103",
    messageText: "hi",
  });

  // Verify all gates pass: AI active, auto-reply enabled, unassigned, not paused
  const result = await t.action(internal.aiReply.ackInbound, {
    accountId,
    conversationId,
    contactId,
    triggerWamid: "wamid.TEST_ACK_ELIGIBLE",
  });

  expect(result).toBe("acked");
});

// ============================================================
// deliverReply — length-proportional delivery (Task 4). Split out of
// `dispatchInbound` so the wait before sending can be scheduled rather
// than slept; the final debounce-token re-check moves here too, since
// more time has passed by delivery time than at any earlier gate.
// ============================================================

test("deliverReply sends the text it was handed", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Owner",
    email: "owner-deliver@example.com",
  });
  await configureAi(asUser);
  const { contactId, conversationId } = await seedInboundThread(t, asUser, {
    accountId,
    phone: "+971500000201",
    messageText: "how much?",
  });

  await t.action(internal.aiReply.deliverReply, {
    accountId,
    conversationId,
    contactId,
    to: "+971500000201",
    replyText: "Yes, we have packages for August!",
    inquiryIds: [],
  });

  const messages = await messagesFor(t, conversationId);
  expect(
    messages.some((m) => m.contentText === "Yes, we have packages for August!"),
  ).toBe(true);
});

test("deliverReply stands down when a newer inbound has arrived", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Owner",
    email: "owner-deliver-stale@example.com",
  });
  await configureAi(asUser);
  const { contactId, conversationId } = await seedInboundThread(t, asUser, {
    accountId,
    phone: "+971500000202",
    messageText: "first",
  });

  // The thread's only message so far is the debounce token we will pass.
  const [firstInbound] = await messagesFor(t, conversationId);

  // A newer customer message overtakes it, so the delivery must abort.
  await t.run((ctx) =>
    ctx.db.insert("messages", {
      accountId,
      conversationId,
      senderType: "customer" as const,
      contentType: "text" as const,
      contentText: "second, newer",
      status: "sent" as const,
    }),
  );

  await t.action(internal.aiReply.deliverReply, {
    accountId,
    conversationId,
    contactId,
    to: "+971500000202",
    replyText: "stale reply that must not send",
    triggerMessageId: firstInbound._id,
    inquiryIds: [],
  });

  const messages = await messagesFor(t, conversationId);
  expect(
    messages.some((m) => m.contentText === "stale reply that must not send"),
  ).toBe(false);
});

// ============================================================
// deliverReply re-checks human takeover (whole-branch review Fix F2).
// `dispatchInbound` checks `assignedToUserId`/`aiAutoreplyDisabled`
// BEFORE scheduling delivery, but delivery can now fire up to
// `deliveryDelayMs`'s max (~15s) later — long enough for an agent to
// claim or pause the conversation from the dashboard in between. Manual
// takeover is documented (this file's own header) as the ONLY stop the
// bot recognizes, so `deliverReply` must re-check both gates itself
// rather than trust a stale pre-delay read.
// ============================================================

test("deliverReply stands down when a human claims the conversation after dispatch already scheduled delivery", async () => {
  const t = convexTest(schema, modules);
  const { accountId, userId, asUser } = await seedAccountMember(t, {
    name: "Owner",
    email: "owner-deliver-takeover@example.com",
  });
  await configureAi(asUser);
  const { contactId, conversationId } = await seedInboundThread(t, asUser, {
    accountId,
    phone: "+971500000203",
    messageText: "how much for the August package?",
  });

  // Simulates an agent claiming the chat from the dashboard during the
  // artificial typing delay `dispatchInbound` already scheduled this
  // delivery behind.
  await t.run((ctx) => ctx.db.patch(conversationId, { assignedToUserId: userId }));

  await t.action(internal.aiReply.deliverReply, {
    accountId,
    conversationId,
    contactId,
    to: "+971500000203",
    replyText: "must not send — a human just took over",
    inquiryIds: [],
  });

  const messages = await messagesFor(t, conversationId);
  expect(messages.some((m) => m.senderType === "bot")).toBe(false);
  // No bookkeeping either — this send never happened.
  expect((await getConversation(t, conversationId))!.aiReplyCount ?? 0).toBe(0);
});

test("deliverReply stands down when auto-reply is paused on the conversation after dispatch already scheduled delivery", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Owner",
    email: "owner-deliver-paused@example.com",
  });
  await configureAi(asUser);
  const { contactId, conversationId } = await seedInboundThread(t, asUser, {
    accountId,
    phone: "+971500000204",
    messageText: "how much for the August package?",
  });

  // Simulates a manual pause (or a handoff marker resolved elsewhere)
  // landing during the artificial typing delay.
  await t.run((ctx) => ctx.db.patch(conversationId, { aiAutoreplyDisabled: true }));

  await t.action(internal.aiReply.deliverReply, {
    accountId,
    conversationId,
    contactId,
    to: "+971500000204",
    replyText: "must not send — auto-reply was paused",
    inquiryIds: [],
  });

  const messages = await messagesFor(t, conversationId);
  expect(messages.some((m) => m.senderType === "bot")).toBe(false);
});

test("deliverReply stands down when the account's AI kill switch is flipped off after dispatch already scheduled delivery (whole-branch review Fix F2, completed)", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Owner",
    email: "owner-deliver-killswitch@example.com",
  });
  await configureAi(asUser);
  const { contactId, conversationId } = await seedInboundThread(t, asUser, {
    accountId,
    phone: "+971500000205",
    messageText: "how much for the August package?",
  });

  // Simulates the owner hitting the account-wide emergency AI-off switch
  // in Settings (e.g. right after watching the bot say something wrong)
  // during the artificial typing delay `dispatchInbound` already
  // scheduled this delivery behind. Before this fix, `deliverReply` had
  // no way to see this at all — it re-checked per-conversation takeover/
  // pause via `loadDispatchContext`, but that query never reads
  // `aiConfig`, so the account-wide switch (the very FIRST gate
  // `dispatchInbound` itself applies) went unchecked here.
  await configureAi(asUser, { isActive: false });

  await t.action(internal.aiReply.deliverReply, {
    accountId,
    conversationId,
    contactId,
    to: "+971500000205",
    replyText: "must not send — AI was switched off account-wide",
    inquiryIds: [],
  });

  const messages = await messagesFor(t, conversationId);
  expect(messages.some((m) => m.senderType === "bot")).toBe(false);
  // No bookkeeping either — this send never happened.
  expect((await getConversation(t, conversationId))!.aiReplyCount ?? 0).toBe(0);
});

// ============================================================
// deliverReply's own send-boundary retry (whole-branch review Fix F4 —
// a newly authorised behaviour change). The branch's original plan never
// retried anything inside `deliverReply`, on the theory that Meta send
// rejections are "near-always non-retryable" — that theory is factually
// wrong (the WhatsApp Cloud API returns retryable 429/500/503 responses),
// so a transient failure right at the send call used to leave the
// customer with a blue tick, "typing…", and then silence forever.
//
// `[[SENDFAIL]]` / `[[SENDFAIL_ALWAYS]]` / `[[POSTSENDFAIL]]` in
// `replyText` are DRY-RUN-only synthetic hooks living in `aiReply.ts`
// itself (see `SEND_FAILURE_SENTINEL`'s own comment there) — same
// steering convention as `[[FAIL]]` above, adapted to the send boundary
// because `metaSend.ts` is a file this phase leaves untouched and has no
// failure hook of its own.
// ============================================================

test("a transient send failure triggers exactly one retry, at a short delay, and the message is eventually delivered", async () => {
  vi.useFakeTimers();
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Owner",
    email: "owner-deliver-sendfail@example.com",
  });
  await configureAi(asUser);
  const { contactId, conversationId } = await seedInboundThread(t, asUser, {
    accountId,
    phone: "+971500000206",
    messageText: "how much for the August package?",
  });

  const before = Date.now();
  await t.action(internal.aiReply.deliverReply, {
    accountId,
    conversationId,
    contactId,
    to: "+971500000206",
    replyText: "[[SENDFAIL]] Yes, we have packages for August!",
    inquiryIds: [],
  });

  // First attempt failed at the send boundary — nothing sent yet.
  expect(
    (await messagesFor(t, conversationId)).some((m) => m.senderType === "bot"),
  ).toBe(false);

  // Exactly one retry must be scheduled, carrying `sendAttempt: 2` and a
  // SHORT delay — nowhere near the 30s dispatch-level retry delay (the
  // customer already has a live typing indicator running; a 30s wait
  // here would risk the exact dead-air failure Fix F1 closes).
  const scheduled = await t.run((ctx) =>
    ctx.db.system.query("_scheduled_functions").collect(),
  );
  const retryRows = scheduled.filter((s) => s.name === "aiReply:deliverReply");
  expect(retryRows).toHaveLength(1);
  expect(retryRows[0]!.args[0]).toMatchObject({ sendAttempt: 2 });
  expect(retryRows[0]!.scheduledTime - before).toBeGreaterThan(0);
  expect(retryRows[0]!.scheduledTime - before).toBeLessThan(10_000);

  await t.finishAllScheduledFunctions(vi.runAllTimers);

  // `[[SENDFAIL]]` only throws on attempt 1 (same "transient failure
  // clears by the next try" convention as the `[[FAIL]]` dispatch-retry
  // tests above) — the retry's own send succeeds and the message goes
  // out exactly once, never twice.
  const botMessages = (await messagesFor(t, conversationId)).filter(
    (m) => m.senderType === "bot",
  );
  expect(botMessages).toHaveLength(1);
  expect((await getConversation(t, conversationId))!.aiReplyCount).toBe(1);
}, 20_000);

test("a persistent send failure stops after the single retry — no message, no endless rescheduling", async () => {
  vi.useFakeTimers();
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Owner",
    email: "owner-deliver-sendfail-persist@example.com",
  });
  await configureAi(asUser);
  const { contactId, conversationId } = await seedInboundThread(t, asUser, {
    accountId,
    phone: "+971500000207",
    messageText: "how much for the August package?",
  });

  await t.action(internal.aiReply.deliverReply, {
    accountId,
    conversationId,
    contactId,
    to: "+971500000207",
    replyText: "[[SENDFAIL_ALWAYS]] Yes, we have packages for August!",
    inquiryIds: [],
  });
  // Drains the retry (sendAttempt 2), which fails again. If the code kept
  // rescheduling, this drain would never terminate — the test timeout is
  // the regression signal for that, same idiom as the sibling
  // `dispatchInbound` "persistent failure" test above.
  await t.finishAllScheduledFunctions(vi.runAllTimers);

  expect(
    (await messagesFor(t, conversationId)).some((m) => m.senderType === "bot"),
  ).toBe(false);
  expect((await getConversation(t, conversationId))!.aiReplyCount ?? 0).toBe(0);
  // `_scheduled_functions` retains history (completed rows keep their
  // "success"/"failed" state rather than disappearing), so the ONE
  // retry that legitimately got scheduled (sendAttempt 2) is still
  // listed here having run — the real "did it loop?" question is
  // whether anything is still PENDING/in-flight, which is what would
  // grow without bound if the attempt cap were broken.
  const scheduled = await t.run((ctx) =>
    ctx.db.system.query("_scheduled_functions").collect(),
  );
  const deliverRows = scheduled.filter((s) => s.name === "aiReply:deliverReply");
  expect(deliverRows).toHaveLength(1); // sendAttempt 2 only — no attempt 3
  expect(deliverRows.filter((s) => s.state.kind === "pending")).toHaveLength(0);
}, 20_000);

test("a post-send failure does NOT retry — the customer already has the message, so a second send would double-text them", async () => {
  vi.useFakeTimers();
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Owner",
    email: "owner-deliver-postsendfail@example.com",
  });
  await configureAi(asUser);
  const { contactId, conversationId } = await seedInboundThread(t, asUser, {
    accountId,
    phone: "+971500000208",
    messageText: "how much for the August package?",
  });

  await t.action(internal.aiReply.deliverReply, {
    accountId,
    conversationId,
    contactId,
    to: "+971500000208",
    replyText: "[[POSTSENDFAIL]] Yes, we have packages for August!",
    inquiryIds: [],
  });

  // The send itself succeeded (DRY-RUN `metaSend.sendText` persists the
  // message before returning) — the sentinel only throws AFTER that, so
  // exactly one bot message exists despite the logged failure.
  const botMessages = (await messagesFor(t, conversationId)).filter(
    (m) => m.senderType === "bot",
  );
  expect(botMessages).toHaveLength(1);

  // No retry was scheduled — draining every timer must not add a second
  // message. This is the assertion that actually distinguishes F4's
  // send-only retry from a naive "retry on any catch": a pre-fix
  // implementation that retried unconditionally would send TWICE here.
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  const scheduled = await t.run((ctx) =>
    ctx.db.system.query("_scheduled_functions").collect(),
  );
  expect(scheduled.filter((s) => s.name === "aiReply:deliverReply")).toHaveLength(0);
  expect(
    (await messagesFor(t, conversationId)).filter((m) => m.senderType === "bot"),
  ).toHaveLength(1);
  // The sentinel fires immediately after `sent = true`, before
  // `bumpReplyCount` runs — so the metric is NOT bumped even though the
  // message went out. That asymmetry is fine (it's a best-effort tally,
  // not a delivery record) and is exactly what proves this is testing a
  // genuine POST-send failure rather than accidentally re-hitting the
  // pre-send sentinel: a pre-send failure leaves both the message AND
  // the count at zero, which is not what happened here.
  expect((await getConversation(t, conversationId))!.aiReplyCount ?? 0).toBe(0);
}, 20_000);
