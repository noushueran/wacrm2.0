/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, expect, test, vi } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import {
  buildFlowDispatchMessage,
  buildMessageReceivedPayload,
  determineAutomationTriggers,
  runBestEffort,
  shouldDispatchAiReply,
} from "./ingest";
import { encrypt } from "./lib/whatsappEncryption";
import type { Id } from "./_generated/dataModel";

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
// Wamid idempotency — a retried Meta webhook delivery (same wamid)
// must not create a duplicate message or double-bump unreadCount
// (Phase 6 review fix)
// ============================================================

test("ingesting the same wamid twice is idempotent: one message row, unreadCount bumped once, second call reports duplicate", async () => {
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Acme");

  const first = await t.mutation(internal.ingest.ingestInbound, {
    accountId,
    from: "15551234567",
    name: "Jamie Customer",
    message: {
      type: "text",
      text: "Hi, is anyone there?",
      wamid: "wamid.RETRY",
    },
  });
  expect(first.duplicate).toBe(false);

  // Meta redelivers the identical webhook payload (same wamid) — it
  // does this whenever it doesn't get a fast-enough ack, with no
  // dedupe guarantee of its own.
  const second = await t.mutation(internal.ingest.ingestInbound, {
    accountId,
    from: "15551234567",
    name: "Jamie Customer",
    message: {
      type: "text",
      text: "Hi, is anyone there?",
      wamid: "wamid.RETRY",
    },
  });

  expect(second.duplicate).toBe(true);
  expect(second.messageId).toBe(first.messageId);
  expect(second.contactId).toBe(first.contactId);
  expect(second.conversationId).toBe(first.conversationId);
  expect(second.wasCreated).toBe(false);
  expect(second.isFirstInboundMessage).toBe(false);

  const messages = await t.run((ctx) =>
    ctx.db
      .query("messages")
      .withIndex("by_conversation", (q) =>
        q.eq("conversationId", first.conversationId),
      )
      .collect(),
  );
  expect(messages).toHaveLength(1);

  const conversation = await t.run((ctx) => ctx.db.get(first.conversationId));
  expect(conversation!.unreadCount).toBe(1);
});

test("the same wamid on a different account is not treated as a duplicate (by_message_id isn't account-scoped, so the hit must be filtered)", async () => {
  const t = convexTest(schema, modules);
  const accountA = await seedAccount(t, "Acme");
  const accountB = await seedAccount(t, "Globex");

  const resultA = await t.mutation(internal.ingest.ingestInbound, {
    accountId: accountA,
    from: "15551234567",
    message: { type: "text", text: "Hello from A", wamid: "wamid.SHARED" },
  });
  const resultB = await t.mutation(internal.ingest.ingestInbound, {
    accountId: accountB,
    from: "15551234567",
    message: { type: "text", text: "Hello from B", wamid: "wamid.SHARED" },
  });

  expect(resultA.duplicate).toBe(false);
  expect(resultB.duplicate).toBe(false);
  expect(resultB.wasCreated).toBe(true);
  expect(resultB.messageId).not.toBe(resultA.messageId);

  const messagesB = await t.run((ctx) =>
    ctx.db
      .query("messages")
      .withIndex("by_account", (q) => q.eq("accountId", accountB))
      .collect(),
  );
  expect(messagesB).toHaveLength(1);
  expect(messagesB[0]!.messageId).toBe("wamid.SHARED");
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

// ============================================================
// processInbound — the inbound-processing orchestrator (Phase 8, Task 4)
// ============================================================

afterEach(() => {
  // Belt-and-suspenders, matching every other DRY-RUN suite's own
  // afterEach (`flowsEngine.test.ts`/`automationsEngine.test.ts`/
  // `aiReply.test.ts`): a thrown assertion could skip a test's own
  // cleanup otherwise.
  delete process.env.CONVEX_META_DRY_RUN;
  delete process.env.CONVEX_AI_DRY_RUN;
  vi.unstubAllGlobals();
});

// ------------------------------------------------------------
// Seed helpers for the engines processInbound fans out to
// (flows/automations/AI reply/webhook delivery) — duplicated from
// `flowsEngine.test.ts`/`automationsEngine.test.ts`/`aiReply.test.ts`/
// `webhookDelivery.test.ts` rather than imported, matching this
// codebase's established per-suite-owns-its-own-helpers convention
// (see this file's own `seedAccount` comment). Every insert is a direct
// `t.run`, no membership/identity seeded — every engine
// `processInbound` calls is itself session-less, exactly like
// `ingestInbound` above.
// ------------------------------------------------------------

async function seedFlow(
  t: ReturnType<typeof convexTest>,
  opts: {
    accountId: Id<"accounts">;
    triggerType: "keyword" | "first_inbound_message" | "manual";
    triggerConfig?: unknown;
    entryNodeId: string;
  },
) {
  return await t.run((ctx) =>
    ctx.db.insert("flows", {
      accountId: opts.accountId,
      name: "Test flow",
      status: "active",
      triggerType: opts.triggerType,
      triggerConfig: opts.triggerConfig,
      entryNodeId: opts.entryNodeId,
      fallbackPolicy: {
        on_unknown_reply: "reprompt",
        max_reprompts: 2,
        on_timeout_hours: 24,
        on_exhaust: "handoff",
      },
      executionCount: 0,
    }),
  );
}

async function seedNode(
  t: ReturnType<typeof convexTest>,
  opts: {
    accountId: Id<"accounts">;
    flowId: Id<"flows">;
    nodeKey: string;
    nodeType: "start" | "end";
    config?: unknown;
  },
) {
  return await t.run((ctx) =>
    ctx.db.insert("flowNodes", {
      accountId: opts.accountId,
      flowId: opts.flowId,
      nodeKey: opts.nodeKey,
      nodeType: opts.nodeType,
      config: opts.config ?? {},
      positionX: 0,
      positionY: 0,
    }),
  );
}

async function seedAutomationWithAddTag(
  t: ReturnType<typeof convexTest>,
  opts: {
    accountId: Id<"accounts">;
    triggerType: string;
    triggerConfig?: unknown;
    tagId: Id<"tags">;
  },
) {
  const automationId = await t.run((ctx) =>
    ctx.db.insert("automations", {
      accountId: opts.accountId,
      name: `Test automation (${opts.triggerType})`,
      triggerType: opts.triggerType,
      triggerConfig: opts.triggerConfig,
      isActive: true,
      executionCount: 0,
    }),
  );
  await t.run((ctx) =>
    ctx.db.insert("automationSteps", {
      accountId: opts.accountId,
      automationId,
      stepType: "add_tag",
      stepConfig: { tag_id: opts.tagId },
      position: 0,
    }),
  );
  return automationId;
}

async function seedTag(t: ReturnType<typeof convexTest>, accountId: Id<"accounts">, name: string) {
  return await t.run((ctx) => ctx.db.insert("tags", { accountId, name, color: "#000000" }));
}

// Scans (not `.withIndex`) — a helper parameter typed as the bare
// `ReturnType<typeof convexTest>` loses this suite's concrete index
// names (see `flowsEngine.test.ts`'s own `messagesFor`/
// `automationsEngine.test.ts`'s own `tagLink` for the identical,
// already-documented gotcha).
async function tagLink(t: ReturnType<typeof convexTest>, contactId: Id<"contacts">, tagId: Id<"tags">) {
  return await t.run((ctx) =>
    ctx.db
      .query("contactTags")
      .filter((q) => q.and(q.eq(q.field("contactId"), contactId), q.eq(q.field("tagId"), tagId)))
      .first(),
  );
}

async function messagesFor(t: ReturnType<typeof convexTest>, conversationId: Id<"conversations">) {
  return await t.run((ctx) =>
    ctx.db.query("messages").filter((q) => q.eq(q.field("conversationId"), conversationId)).collect(),
  );
}

/** Active + auto-reply-enabled AI config, seeded directly (bypassing
 *  `aiConfig.upsert`'s own admin-role gate — this suite has no
 *  membership/identity, matching every helper above) with a genuinely
 *  encrypted `apiKey` (`aiConfig.loadDecrypted` always decrypts it, dry
 *  run or not). */
async function seedAiConfig(t: ReturnType<typeof convexTest>, accountId: Id<"accounts">) {
  const apiKey = await encrypt("sk-test-key");
  return await t.run((ctx) =>
    ctx.db.insert("aiConfigs", {
      accountId,
      provider: "openai",
      model: "gpt-4o-mini",
      apiKey,
      isActive: true,
      autoReplyEnabled: true,
      autoReplyMaxPerConversation: 3,
    }),
  );
}

async function seedWebhookEndpoint(
  t: ReturnType<typeof convexTest>,
  opts: { accountId: Id<"accounts">; events: string[] },
) {
  return await t.run((ctx) =>
    ctx.db.insert("webhookEndpoints", {
      accountId: opts.accountId,
      url: "https://example.com/hook",
      secret: "whsec_test_plaintext",
      events: opts.events,
      isActive: true,
      failureCount: 0,
    }),
  );
}

// ------------------------------------------------------------
// Pure-helper tests — determineAutomationTriggers/buildFlowDispatchMessage/
// buildMessageReceivedPayload/runBestEffort, ported byte-faithfully from
// route.ts's own precedence (see `ingest.ts`'s header comment on
// `processInbound` for the exact line refs). Mirrors this codebase's
// established convention of unit-testing extracted pure decision logic
// directly (`colsForStatus`, `triggerMatches`, `matchesKeywordTrigger`).
// ------------------------------------------------------------

test("determineAutomationTriggers: not consumed, plain text — only the two content triggers", () => {
  expect(
    determineAutomationTriggers({
      flowConsumed: false,
      wasCreated: false,
      isFirstInboundMessage: false,
    }),
  ).toEqual(["new_message_received", "keyword_match"]);
});

test("determineAutomationTriggers: not consumed, interactive tap — content triggers plus interactive_reply", () => {
  expect(
    determineAutomationTriggers({
      flowConsumed: false,
      wasCreated: false,
      isFirstInboundMessage: false,
      interactiveReplyId: "btn_yes",
    }),
  ).toEqual(["new_message_received", "keyword_match", "interactive_reply"]);
});

test("determineAutomationTriggers: consumed — content triggers (incl. interactive_reply) are suppressed entirely", () => {
  expect(
    determineAutomationTriggers({
      flowConsumed: true,
      wasCreated: false,
      isFirstInboundMessage: false,
      interactiveReplyId: "btn_yes",
    }),
  ).toEqual([]);
});

test("determineAutomationTriggers: relationship triggers (new_contact_created/first_inbound_message) fire regardless of flowConsumed", () => {
  // Consumed: content triggers suppressed, relationship triggers still
  // present — and in the exact source order (wasCreated unshifted
  // first, then isFirstInboundMessage, so the latter ends up at index 0
  // when both are true — route.ts:782-783).
  expect(
    determineAutomationTriggers({
      flowConsumed: true,
      wasCreated: true,
      isFirstInboundMessage: true,
    }),
  ).toEqual(["first_inbound_message", "new_contact_created"]);

  // Not consumed: relationship triggers lead, content triggers follow.
  expect(
    determineAutomationTriggers({
      flowConsumed: false,
      wasCreated: true,
      isFirstInboundMessage: true,
    }),
  ).toEqual([
    "first_inbound_message",
    "new_contact_created",
    "new_message_received",
    "keyword_match",
  ]);
});

test("determineAutomationTriggers: only wasCreated true — new_contact_created alone leads", () => {
  expect(
    determineAutomationTriggers({
      flowConsumed: false,
      wasCreated: true,
      isFirstInboundMessage: false,
    }),
  ).toEqual(["new_contact_created", "new_message_received", "keyword_match"]);
});

test("buildFlowDispatchMessage: plain text vs. an interactive tap", () => {
  expect(
    buildFlowDispatchMessage({ text: "hi there", wamid: "wamid-1" }),
  ).toEqual({ kind: "text", text: "hi there", metaMessageId: "wamid-1" });

  // No `text` supplied — falls back to "", mirrors the source's
  // `contentText ?? message.text?.body ?? ''`.
  expect(buildFlowDispatchMessage({ wamid: "wamid-2" })).toEqual({
    kind: "text",
    text: "",
    metaMessageId: "wamid-2",
  });

  expect(
    buildFlowDispatchMessage({
      text: "Yes please",
      wamid: "wamid-3",
      interactiveReplyId: "btn_yes",
    }),
  ).toEqual({
    kind: "interactive_reply",
    replyId: "btn_yes",
    replyTitle: "Yes please",
    metaMessageId: "wamid-3",
  });
});

test("buildMessageReceivedPayload: matches the public message.received contract, text defaults to null (not undefined)", () => {
  const conversationId = "conv_1" as Id<"conversations">;
  const contactId = "contact_1" as Id<"contacts">;

  expect(
    buildMessageReceivedPayload({
      conversationId,
      contactId,
      wamid: "wamid-1",
      contentType: "text",
      text: "hello",
    }),
  ).toEqual({
    conversation_id: conversationId,
    contact_id: contactId,
    whatsapp_message_id: "wamid-1",
    content_type: "text",
    text: "hello",
  });

  expect(
    buildMessageReceivedPayload({
      conversationId,
      contactId,
      wamid: "wamid-2",
      contentType: "image",
    }),
  ).toMatchObject({ text: null });
});

test("runBestEffort: swallows a rejection and logs instead of throwing", async () => {
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  await expect(
    runBestEffort("some-step", () => Promise.reject(new Error("boom"))),
  ).resolves.toBeUndefined();
  expect(errorSpy).toHaveBeenCalledWith(
    "[webhook] some-step failed:",
    "boom",
  );
  errorSpy.mockRestore();
});

test("runBestEffort: a resolving fn completes normally with no error logged", async () => {
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  let ran = false;
  await runBestEffort("some-step", async () => {
    ran = true;
  });
  expect(ran).toBe(true);
  expect(errorSpy).not.toHaveBeenCalled();
  errorSpy.mockRestore();
});

// ------------------------------------------------------------
// shouldDispatchAiReply — the AI "stand down" precedence ported from
// src/lib/ai/auto-reply.ts:53-68 (see ingest.ts's own comment on this
// function for why the decision lives here rather than inside
// aiReply.dispatchInbound itself).
// ------------------------------------------------------------

test("shouldDispatchAiReply: dispatches when nothing stands in the way", () => {
  expect(
    shouldDispatchAiReply({
      flowConsumed: false,
      inboundText: "hi there",
      hasActiveAutoResponder: false,
    }),
  ).toBe(true);
});

test("shouldDispatchAiReply: stands down when a flow consumed the message", () => {
  expect(
    shouldDispatchAiReply({
      flowConsumed: true,
      inboundText: "hi there",
      hasActiveAutoResponder: false,
    }),
  ).toBe(false);
});

test("shouldDispatchAiReply: stands down for an interactive reply", () => {
  expect(
    shouldDispatchAiReply({
      flowConsumed: false,
      interactiveReplyId: "btn_yes",
      inboundText: "Yes please",
      hasActiveAutoResponder: false,
    }),
  ).toBe(false);
});

test("shouldDispatchAiReply: stands down for empty/whitespace-only text", () => {
  expect(
    shouldDispatchAiReply({
      flowConsumed: false,
      inboundText: "   ",
      hasActiveAutoResponder: false,
    }),
  ).toBe(false);
});

test("shouldDispatchAiReply: stands down when the account has an active auto-responder automation", () => {
  expect(
    shouldDispatchAiReply({
      flowConsumed: false,
      inboundText: "hi there",
      hasActiveAutoResponder: true,
    }),
  ).toBe(false);
});

// ------------------------------------------------------------
// processInbound — integration tests via convex-test, real engines,
// DRY-RUN throughout (both CONVEX_META_DRY_RUN, for flows/AI-send/
// webhook delivery, and CONVEX_AI_DRY_RUN for the LLM call itself —
// same two-flag convention `aiReply.test.ts` documents).
// ------------------------------------------------------------

test("processInbound on a brand-new contact runs the full fan-out in order: ingest -> flows (no match) -> automations (all four triggers) -> AI stands down (active auto-responder automation) -> webhook delivery", async () => {
  process.env.CONVEX_META_DRY_RUN = "1";
  process.env.CONVEX_AI_DRY_RUN = "1";
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Acme");

  const newContactTag = await seedTag(t, accountId, "new-contact");
  const firstInboundTag = await seedTag(t, accountId, "first-inbound");
  const newMessageTag = await seedTag(t, accountId, "new-message");
  const keywordTag = await seedTag(t, accountId, "keyword");
  await seedAutomationWithAddTag(t, { accountId, triggerType: "new_contact_created", tagId: newContactTag });
  await seedAutomationWithAddTag(t, { accountId, triggerType: "first_inbound_message", tagId: firstInboundTag });
  await seedAutomationWithAddTag(t, { accountId, triggerType: "new_message_received", tagId: newMessageTag });
  await seedAutomationWithAddTag(t, {
    accountId,
    triggerType: "keyword_match",
    triggerConfig: { keywords: ["help"], match_type: "contains" },
    tagId: keywordTag,
  });
  await seedAiConfig(t, accountId);
  const endpointId = await seedWebhookEndpoint(t, { accountId, events: ["message.received"] });

  const result = await t.action(internal.ingest.processInbound, {
    accountId,
    from: "15551234567",
    name: "Jamie Customer",
    message: { type: "text", text: "hi, need some help please", wamid: "wamid.FULL" },
  });

  expect(result.duplicate).toBe(false);
  expect(result.flowConsumed).toBe(false);

  const ingested = await t.run((ctx) =>
    ctx.db
      .query("contacts")
      .withIndex("by_account", (q) => q.eq("accountId", accountId))
      .first(),
  );
  const contactId = ingested!._id;
  expect(await tagLink(t, contactId, newContactTag)).not.toBeNull();
  expect(await tagLink(t, contactId, firstInboundTag)).not.toBeNull();
  expect(await tagLink(t, contactId, newMessageTag)).not.toBeNull();
  expect(await tagLink(t, contactId, keywordTag)).not.toBeNull();

  const conversation = await t.run((ctx) =>
    ctx.db
      .query("conversations")
      .filter((q) => q.eq(q.field("contactId"), contactId))
      .first(),
  );
  const messages = await messagesFor(t, conversation!._id);
  // The account has an ACTIVE new_message_received/keyword_match
  // automation (seeded above, and confirmed to have fired via the tag
  // assertions above) — the AI stands down rather than double-texting
  // the customer (shouldDispatchAiReply in ingest.ts). See the
  // dedicated stand-down tests below for the isolated, single-variable
  // version of this precedence.
  const botMessages = messages.filter((m) => m.senderType === "bot");
  expect(botMessages).toHaveLength(0);

  const endpoint = await t.run((ctx) => ctx.db.get(endpointId));
  expect(endpoint!.lastDeliveryAt).toBeDefined();
});

test("processInbound: AI reply stands down when an active new_message_received automation exists, even though that automation itself still fires", async () => {
  process.env.CONVEX_META_DRY_RUN = "1";
  process.env.CONVEX_AI_DRY_RUN = "1";
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Acme");

  const tagId = await seedTag(t, accountId, "auto-responder");
  await seedAutomationWithAddTag(t, { accountId, triggerType: "new_message_received", tagId });
  await seedAiConfig(t, accountId);

  const result = await t.action(internal.ingest.processInbound, {
    accountId,
    from: "15551234567",
    message: { type: "text", text: "anyone around?", wamid: "wamid.STANDDOWN1" },
  });

  expect(result.duplicate).toBe(false);
  expect(result.flowConsumed).toBe(false);

  const contact = await t.run((ctx) =>
    ctx.db.query("contacts").withIndex("by_account", (q) => q.eq("accountId", accountId)).first(),
  );
  // The automation itself still fired...
  expect(await tagLink(t, contact!._id, tagId)).not.toBeNull();

  // ...but the AI did not reply, avoiding a double-text.
  const conversation = await t.run((ctx) =>
    ctx.db.query("conversations").filter((q) => q.eq(q.field("contactId"), contact!._id)).first(),
  );
  const messages = await messagesFor(t, conversation!._id);
  expect(messages.filter((m) => m.senderType === "bot")).toHaveLength(0);
});

test("processInbound: AI reply stands down for an active keyword_match automation even when this message's own text doesn't match its keywords (account-wide existence check, not a per-message match)", async () => {
  process.env.CONVEX_META_DRY_RUN = "1";
  process.env.CONVEX_AI_DRY_RUN = "1";
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Acme");

  const tagId = await seedTag(t, accountId, "keyword-responder");
  // "help" never appears in the inbound text below, so the automation's
  // own triggerMatches() won't fire (no tag applied) — but the
  // stand-down check is an ACCOUNT-WIDE existence check on active
  // new_message_received/keyword_match automations, not a per-message
  // match (mirrors src/lib/ai/auto-reply.ts's own `.limit(1)` query), so
  // the AI still stands down.
  await seedAutomationWithAddTag(t, {
    accountId,
    triggerType: "keyword_match",
    triggerConfig: { keywords: ["help"], match_type: "contains" },
    tagId,
  });
  await seedAiConfig(t, accountId);

  const result = await t.action(internal.ingest.processInbound, {
    accountId,
    from: "15551234567",
    message: { type: "text", text: "just saying hello", wamid: "wamid.STANDDOWN2" },
  });

  expect(result.duplicate).toBe(false);
  expect(result.flowConsumed).toBe(false);

  const contact = await t.run((ctx) =>
    ctx.db.query("contacts").withIndex("by_account", (q) => q.eq("accountId", accountId)).first(),
  );
  // Keyword never matched this message — the automation's own tag did
  // NOT apply.
  expect(await tagLink(t, contact!._id, tagId)).toBeNull();

  // The AI still stood down — the check is account-wide existence, not
  // per-message match.
  const conversation = await t.run((ctx) =>
    ctx.db.query("conversations").filter((q) => q.eq(q.field("contactId"), contact!._id)).first(),
  );
  const messages = await messagesFor(t, conversation!._id);
  expect(messages.filter((m) => m.senderType === "bot")).toHaveLength(0);
});

test("processInbound SKIPS the entire fan-out on a duplicate wamid (a Meta retry)", async () => {
  process.env.CONVEX_META_DRY_RUN = "1";
  process.env.CONVEX_AI_DRY_RUN = "1";
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Acme");

  const tagId = await seedTag(t, accountId, "greeted");
  await seedAutomationWithAddTag(t, { accountId, triggerType: "new_message_received", tagId });
  await seedAiConfig(t, accountId);
  const endpointId = await seedWebhookEndpoint(t, { accountId, events: ["message.received"] });

  const first = await t.action(internal.ingest.processInbound, {
    accountId,
    from: "15551234567",
    message: { type: "text", text: "hello there", wamid: "wamid.DUPETEST" },
  });
  expect(first.duplicate).toBe(false);

  const contact = await t.run((ctx) =>
    ctx.db.query("contacts").withIndex("by_account", (q) => q.eq("accountId", accountId)).first(),
  );
  const conversation = await t.run((ctx) =>
    ctx.db.query("conversations").filter((q) => q.eq(q.field("contactId"), contact!._id)).first(),
  );
  const messagesAfterFirst = await messagesFor(t, conversation!._id);
  const botMessagesAfterFirst = messagesAfterFirst.filter((m) => m.senderType === "bot");
  const endpointAfterFirst = await t.run((ctx) => ctx.db.get(endpointId));

  // Meta redelivers the identical webhook (same wamid).
  const second = await t.action(internal.ingest.processInbound, {
    accountId,
    from: "15551234567",
    message: { type: "text", text: "hello there", wamid: "wamid.DUPETEST" },
  });
  expect(second.duplicate).toBe(true);
  expect(second.flowConsumed).toBe(false);

  // No SECOND automation run, AI reply, or webhook delivery attempt —
  // every observable side effect is identical to right after the FIRST
  // call.
  const messagesAfterSecond = await messagesFor(t, conversation!._id);
  expect(messagesAfterSecond).toHaveLength(messagesAfterFirst.length);
  const botMessagesAfterSecond = messagesAfterSecond.filter((m) => m.senderType === "bot");
  expect(botMessagesAfterSecond).toHaveLength(botMessagesAfterFirst.length);
  const endpointAfterSecond = await t.run((ctx) => ctx.db.get(endpointId));
  expect(endpointAfterSecond!.lastDeliveryAt).toBe(endpointAfterFirst!.lastDeliveryAt);
});

test("a flow that consumes the inbound suppresses new_message_received/keyword_match automations and the AI reply, but relationship-trigger automations and webhook delivery still fire", async () => {
  process.env.CONVEX_META_DRY_RUN = "1";
  process.env.CONVEX_AI_DRY_RUN = "1";
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Acme");

  // A minimal flow (start -> end, no sends) that matches the inbound
  // text and consumes it outright.
  const flowId = await seedFlow(t, {
    accountId,
    triggerType: "keyword",
    triggerConfig: { keywords: ["hi"], match_type: "contains" },
    entryNodeId: "start",
  });
  await seedNode(t, { accountId, flowId, nodeKey: "start", nodeType: "start", config: { next_node_key: "end1" } });
  await seedNode(t, { accountId, flowId, nodeKey: "end1", nodeType: "end", config: {} });

  const contentTag = await seedTag(t, accountId, "content-trigger");
  const relationshipTag = await seedTag(t, accountId, "relationship-trigger");
  await seedAutomationWithAddTag(t, { accountId, triggerType: "new_message_received", tagId: contentTag });
  await seedAutomationWithAddTag(t, { accountId, triggerType: "new_contact_created", tagId: relationshipTag });
  await seedAiConfig(t, accountId);
  const endpointId = await seedWebhookEndpoint(t, { accountId, events: ["message.received"] });

  const result = await t.action(internal.ingest.processInbound, {
    accountId,
    from: "15551234567",
    message: { type: "text", text: "hi there", wamid: "wamid.FLOWCONSUMED" },
  });

  expect(result.duplicate).toBe(false);
  expect(result.flowConsumed).toBe(true);

  const contact = await t.run((ctx) =>
    ctx.db.query("contacts").withIndex("by_account", (q) => q.eq("accountId", accountId)).first(),
  );
  // Content-level trigger suppressed...
  expect(await tagLink(t, contact!._id, contentTag)).toBeNull();
  // ...but the relationship trigger (unaffected by consumption) still fired.
  expect(await tagLink(t, contact!._id, relationshipTag)).not.toBeNull();

  // No AI-generated reply — the flow (which sends nothing itself, just
  // start -> end) consumed the message, so only the original inbound
  // customer message exists in the thread.
  const conversation = await t.run((ctx) =>
    ctx.db.query("conversations").filter((q) => q.eq(q.field("contactId"), contact!._id)).first(),
  );
  const messages = await messagesFor(t, conversation!._id);
  expect(messages.filter((m) => m.senderType === "bot")).toHaveLength(0);

  // webhook delivery still fires regardless of consumption.
  const endpoint = await t.run((ctx) => ctx.db.get(endpointId));
  expect(endpoint!.lastDeliveryAt).toBeDefined();
});

test("an interactive reply dispatches the interactive_reply automation trigger (when not consumed by a flow) and never reaches the AI reply", async () => {
  process.env.CONVEX_META_DRY_RUN = "1";
  process.env.CONVEX_AI_DRY_RUN = "1";
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Acme");

  const replyTag = await seedTag(t, accountId, "interactive-reply");
  await seedAutomationWithAddTag(t, {
    accountId,
    triggerType: "interactive_reply",
    triggerConfig: { reply_ids: ["btn_yes"] },
    tagId: replyTag,
  });
  await seedAiConfig(t, accountId);

  const result = await t.action(internal.ingest.processInbound, {
    accountId,
    from: "15551234567",
    message: {
      type: "interactive",
      text: "Yes please",
      interactiveReplyId: "btn_yes",
      wamid: "wamid.INTERACTIVE",
    },
  });

  expect(result.flowConsumed).toBe(false);

  const contact = await t.run((ctx) =>
    ctx.db.query("contacts").withIndex("by_account", (q) => q.eq("accountId", accountId)).first(),
  );
  expect(await tagLink(t, contact!._id, replyTag)).not.toBeNull();

  const conversation = await t.run((ctx) =>
    ctx.db.query("conversations").filter((q) => q.eq(q.field("contactId"), contact!._id)).first(),
  );
  const messages = await messagesFor(t, conversation!._id);
  // Only the original inbound interactive-reply message — the AI reply
  // gate (`!interactiveReplyId`) never opens for an interactive tap.
  expect(messages.filter((m) => m.senderType === "bot")).toHaveLength(0);
});

test("processInbound: an automations phase matching zero automations (nothing to do) still lets the AI reply and webhook delivery run to completion", async () => {
  // No automation seeded at all — `automationsEngine.runForTrigger`
  // legitimately no-ops for every trigger in the set. This proves the
  // fan-out steps are independent: an earlier step doing nothing useful
  // must never prevent a later step from running. (A literal THROW from
  // one of the four engines `processInbound` calls is a separate
  // concern, covered by the `runBestEffort` unit tests above with a
  // manufactured rejection — all four engines are documented to never
  // throw by design, each owning its own top-level try/catch, so that
  // failure mode isn't reachable through real engine behavior here.)
  process.env.CONVEX_META_DRY_RUN = "1";
  process.env.CONVEX_AI_DRY_RUN = "1";
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Acme");
  await seedAiConfig(t, accountId);
  const endpointId = await seedWebhookEndpoint(t, { accountId, events: ["message.received"] });

  const result = await t.action(internal.ingest.processInbound, {
    accountId,
    from: "15551234567",
    message: { type: "text", text: "hello, anyone there?", wamid: "wamid.ISOLATION" },
  });

  expect(result.duplicate).toBe(false);

  const contact = await t.run((ctx) =>
    ctx.db.query("contacts").withIndex("by_account", (q) => q.eq("accountId", accountId)).first(),
  );
  const conversation = await t.run((ctx) =>
    ctx.db.query("conversations").filter((q) => q.eq(q.field("contactId"), contact!._id)).first(),
  );
  const messages = await messagesFor(t, conversation!._id);
  expect(messages.filter((m) => m.senderType === "bot")).toHaveLength(1);

  const endpoint = await t.run((ctx) => ctx.db.get(endpointId));
  expect(endpoint!.lastDeliveryAt).toBeDefined();
});

// ============================================================
// Inbound media resolution — the "follow-up" both webhookParse.ts and
// files.storeFromUrl flag: an inbound WhatsApp media message arrives as
// a bare Meta `mediaId` (a signed Graph fetch is real network I/O the
// mutation can't do), so processInbound must resolve it to a durable
// Convex-storage URL. Before this, every inbound voice note / video /
// image rendered "unavailable" in the inbox because `mediaUrl` was never
// populated.
// ============================================================

test("processInbound resolves an inbound voice note's media into storage and attaches a playable mediaUrl", async () => {
  process.env.CONVEX_META_DRY_RUN = "1";
  process.env.CONVEX_AI_DRY_RUN = "1";
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Acme");

  // The account's WhatsApp config — `resolveInboundMedia` decrypts this
  // token to authenticate the Meta media fetch.
  await t.run(async (ctx) =>
    ctx.db.insert("whatsappConfig", {
      accountId,
      phoneNumberId: "pn-acme",
      accessToken: await encrypt("secret-token"),
      status: "connected",
    }),
  );

  // Mock the two Meta round-trips: getMediaUrl (id -> CDN url + mime),
  // then the authenticated CDN byte download.
  const voiceBytes = new TextEncoder().encode("ogg/opus voice-note bytes");
  const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const target = String(url);
    if (target.includes("meta-audio-1")) {
      expect(
        (init?.headers as Record<string, string> | undefined)?.Authorization,
      ).toBe("Bearer secret-token");
      return {
        ok: true,
        status: 200,
        json: async () => ({
          url: "https://cdn.example/voice.ogg",
          mime_type: "audio/ogg",
        }),
      } as unknown as Response;
    }
    return {
      ok: true,
      status: 200,
      blob: async () => new Blob([voiceBytes], { type: "audio/ogg" }),
    } as unknown as Response;
  });
  vi.stubGlobal("fetch", fetchMock);

  await t.action(internal.ingest.processInbound, {
    accountId,
    from: "15559990000",
    message: { type: "audio", mediaId: "meta-audio-1", wamid: "wamid.VOICE1" },
  });

  const message = await t.run((ctx) =>
    ctx.db
      .query("messages")
      .withIndex("by_message_id", (q) => q.eq("messageId", "wamid.VOICE1"))
      .first(),
  );
  expect(message!.contentType).toBe("audio");
  // The fix: `mediaUrl` is now a fetchable Convex-storage URL (was
  // undefined -> "audio unavailable" in the inbox).
  expect(message!.mediaUrl).toBeTruthy();
  // Both Meta round-trips happened (resolve id -> url, then download).
  expect(fetchMock).toHaveBeenCalledTimes(2);
});
