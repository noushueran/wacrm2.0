/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
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
import {
  flattenInboundMessage,
  type MetaWebhookMessage,
} from "./lib/whatsapp/webhookParse";
import type { Id } from "./_generated/dataModel";

// Encode a 6-char base32 code as its 30 invisible zero-width chars — mirrors the
// landing-side + attribution.ts codec, so these ingest tests feed the SAME wire form.
const ZW_ALPHABET = "0123456789ABCDEFGHJKLMNPQRSTVWXYZ".replace(/[ILOU]/g, "");
function hidden(code: string): string {
  let out = "";
  for (const ch of code) {
    const bits = ZW_ALPHABET.indexOf(ch).toString(2).padStart(5, "0");
    for (const b of bits) out += b === "0" ? "​" : "‌";
  }
  return out;
}

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
// First-customer detection across an outbound-heavy thread (read-bound)
// ============================================================

test("ingestInbound detects the first customer message even when the conversation already holds only non-customer messages", async () => {
  // Staff-alert-channel shape from the brief: a conversation that has only
  // ever carried outbound bot/agent messages. The customer's first reply is
  // still `isFirstInboundMessage: true` — detection keys on the ABSENCE of a
  // prior CUSTOMER message, which `by_conversation_sender` now ranges
  // directly instead of scanning the whole (outbound-heavy) thread.
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Acme");

  const conversationId = await t.run(async (ctx) => {
    const contactId = await ctx.db.insert("contacts", {
      accountId,
      phone: "15551234567",
      phoneNormalized: "15551234567",
    });
    const convId = await ctx.db.insert("conversations", {
      accountId,
      contactId,
      status: "open",
      unreadCount: 0,
    });
    for (const senderType of ["bot", "agent", "bot"] as const) {
      await ctx.db.insert("messages", {
        accountId,
        conversationId: convId,
        senderType,
        contentType: "text",
        contentText: "outbound",
        status: "sent",
      });
    }
    return convId;
  });

  const res = await t.mutation(internal.ingest.ingestInbound, {
    accountId,
    from: "15551234567",
    message: {
      type: "text",
      text: "Hi, first time reaching out",
      wamid: "wamid.FIRSTCUST",
    },
  });

  expect(res.conversationId).toBe(conversationId);
  expect(res.isFirstInboundMessage).toBe(true);
});

test("ingestInbound reports isFirstInboundMessage=false when an older customer message already exists under later outbound noise", async () => {
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Acme");

  const conversationId = await t.run(async (ctx) => {
    const contactId = await ctx.db.insert("contacts", {
      accountId,
      phone: "15551234567",
      phoneNormalized: "15551234567",
    });
    const convId = await ctx.db.insert("conversations", {
      accountId,
      contactId,
      status: "open",
      unreadCount: 0,
    });
    // An earlier CUSTOMER message, then later bot noise on top of it.
    await ctx.db.insert("messages", {
      accountId,
      conversationId: convId,
      senderType: "customer",
      contentType: "text",
      contentText: "earlier question",
      status: "sent",
    });
    await ctx.db.insert("messages", {
      accountId,
      conversationId: convId,
      senderType: "bot",
      contentType: "text",
      contentText: "auto reply",
      status: "sent",
    });
    return convId;
  });

  const res = await t.mutation(internal.ingest.ingestInbound, {
    accountId,
    from: "15551234567",
    message: {
      type: "text",
      text: "following up again",
      wamid: "wamid.NOTFIRST",
    },
  });

  expect(res.conversationId).toBe(conversationId);
  expect(res.isFirstInboundMessage).toBe(false);
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
  // cleanup otherwise. `vi.useRealTimers()` + `LANDING_CONVERSION_URL`
  // are for the attribution `sendSignal`-scheduling test further below,
  // which opts into `vi.useFakeTimers()` (mirrors `broadcasts.test.ts`'s
  // own file-level `afterEach` for the identical reason).
  delete process.env.CONVEX_META_DRY_RUN;
  delete process.env.CONVEX_AI_DRY_RUN;
  delete process.env.LANDING_CONVERSION_URL;
  vi.useRealTimers();
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
      contentType: "text",
    }),
  ).toBe(true);
});

test("shouldDispatchAiReply: stands down when a flow consumed the message", () => {
  expect(
    shouldDispatchAiReply({
      flowConsumed: true,
      inboundText: "hi there",
      hasActiveAutoResponder: false,
      contentType: "text",
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
      contentType: "interactive",
    }),
  ).toBe(false);
});

test("shouldDispatchAiReply: stands down for empty/whitespace-only text", () => {
  expect(
    shouldDispatchAiReply({
      flowConsumed: false,
      inboundText: "   ",
      hasActiveAutoResponder: false,
      contentType: "text",
    }),
  ).toBe(false);
});

test("shouldDispatchAiReply: stands down when the account has an active auto-responder automation", () => {
  expect(
    shouldDispatchAiReply({
      flowConsumed: false,
      inboundText: "hi there",
      hasActiveAutoResponder: true,
      contentType: "text",
    }),
  ).toBe(false);
});

test("shouldDispatchAiReply: dispatches for a media-only message (voice note, no text)", () => {
  expect(
    shouldDispatchAiReply({
      flowConsumed: false,
      inboundText: "",
      hasActiveAutoResponder: false,
      contentType: "audio",
    }),
  ).toBe(true);
});

test("shouldDispatchAiReply: a media message still respects the flow/auto-responder precedence", () => {
  expect(
    shouldDispatchAiReply({
      flowConsumed: true,
      inboundText: "",
      hasActiveAutoResponder: false,
      contentType: "image",
    }),
  ).toBe(false);
  expect(
    shouldDispatchAiReply({
      flowConsumed: false,
      inboundText: "",
      hasActiveAutoResponder: true,
      contentType: "image",
    }),
  ).toBe(false);
});

// ------------------------------------------------------------
// processInbound — integration tests via convex-test, real engines,
// DRY-RUN throughout (both CONVEX_META_DRY_RUN, for flows/AI-send/
// webhook delivery, and CONVEX_AI_DRY_RUN for the LLM call itself —
// same two-flag convention `aiReply.test.ts` documents).
// ------------------------------------------------------------

// 15s, not the 5s default: this is the suite's heaviest e2e (full inbound
// fan-out, ~5s alone) and it sits right at the cap under full-suite transform
// load, flaking on slow disks while passing in isolation.
test("processInbound on a brand-new contact runs the full fan-out in order: ingest -> flows (no match) -> automations (all four triggers) -> AI stands down (active auto-responder automation) -> webhook delivery", { timeout: 15_000 }, async () => {
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

// pushSend.deliverForMessage has no persisted side effect to assert on
// (unlike webhookDelivery.dispatch's `endpoint.lastDeliveryAt` above) —
// no VAPID env is configured in this suite (vitest.config.ts sets only
// ENCRYPTION_KEY/META_APP_SECRET), so the REAL action (convex-test wires
// every `internal.*` action for real, not a mock — see `modules` above)
// hits its own early-return guard and resolves silently (no log — see
// pushSend.ts). Asserting that `processInbound` still resolves with its
// normal result is the proof the real (unmocked, arg-validated) dispatch
// to `internal.pushSend.deliverForMessage` is wired into the fan-out
// without breaking ingestion.
test("processInbound dispatches pushSend.deliverForMessage as part of the fan-out (best-effort; no VAPID env in tests so it skips sending, but ingestion still completes normally)", async () => {
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Acme");

  const result = await t.action(internal.ingest.processInbound, {
    accountId,
    from: "15551234567",
    message: { type: "text", text: "hello", wamid: "wamid.PUSH1" },
  });

  expect(result.duplicate).toBe(false);
  expect(result.flowConsumed).toBe(false);
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

test("a rapid burst of inbound texts gets ONE debounced AI reply, not one per message", async () => {
  process.env.CONVEX_META_DRY_RUN = "1";
  process.env.CONVEX_AI_DRY_RUN = "1";
  vi.useFakeTimers();
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Acme");
  await seedAiConfig(t, accountId);

  // WhatsApp users fragment one thought across quick messages — each is
  // its own webhook. Only the LAST message's debounced dispatch may
  // reply, covering the whole burst.
  for (const [i, text] of ["Hi", "I want a Baku package", "for August"].entries()) {
    await t.action(internal.ingest.processInbound, {
      accountId,
      from: "15551234567",
      message: { type: "text", text, wamid: `wamid.BURST${i}` },
    });
  }

  await t.finishAllScheduledFunctions(vi.runAllTimers);

  const contact = await t.run((ctx) =>
    ctx.db.query("contacts").withIndex("by_account", (q) => q.eq("accountId", accountId)).first(),
  );
  const conversation = await t.run((ctx) =>
    ctx.db.query("conversations").filter((q) => q.eq(q.field("contactId"), contact!._id)).first(),
  );
  const messages = await messagesFor(t, conversation!._id);
  expect(messages.filter((m) => m.senderType === "customer")).toHaveLength(3);
  expect(messages.filter((m) => m.senderType === "bot")).toHaveLength(1);
}, 20_000);

test("processInbound SKIPS the entire fan-out on a duplicate wamid (a Meta retry)", async () => {
  process.env.CONVEX_META_DRY_RUN = "1";
  process.env.CONVEX_AI_DRY_RUN = "1";
  vi.useFakeTimers(); // the AI reply is debounced (scheduled) — drained below
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
  await t.finishAllScheduledFunctions(vi.runAllTimers); // debounced AI reply lands

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
  await t.finishAllScheduledFunctions(vi.runAllTimers); // a duplicate schedules nothing

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
  vi.useFakeTimers(); // the AI reply is debounced (scheduled) — drained below
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
  await t.finishAllScheduledFunctions(vi.runAllTimers); // debounced AI reply lands

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
// mutation can't do), so processInbound must resolve it to a durable R2
// object key (R2-migration Task 7; a resolved Convex-storage URL before
// that migration). Before this, every inbound voice note / video / image
// rendered "unavailable" in the inbox because neither `mediaKey` nor
// `mediaUrl` was ever populated.
// ============================================================

test("processInbound resolves an inbound voice note's media into R2 and attaches a mediaKey (not a mediaUrl)", async () => {
  process.env.CONVEX_META_DRY_RUN = "1";
  process.env.CONVEX_AI_DRY_RUN = "1";
  // R2-migration write path (Task 7, completing Task 6): `resolveInboundMedia`
  // stores the downloaded bytes in R2 (`files.storeFromUrl`), which needs
  // `r2ConfigFromEnv()` to resolve — see `convex/files.test.ts`'s own
  // comment on why these are set per-test rather than globally in
  // `vitest.config.ts` (that would defeat `aiReply.test.ts`'s dedicated
  // R2-unconfigured coverage).
  process.env.R2_BUCKET = "test-bucket";
  process.env.R2_ENDPOINT = "https://test.r2.cloudflarestorage.com";
  process.env.R2_ACCESS_KEY_ID = "test-key";
  process.env.R2_SECRET_ACCESS_KEY = "test-secret";
  process.env.R2_PUBLIC_HOST = "https://objs.amaniworld.com";
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

  // Mock the two Meta round-trips (getMediaUrl: id -> CDN url + mime;
  // then the authenticated CDN byte download) PLUS the R2 PUT that now
  // follows (`files.storeFromUrl` -> `putObject`). The R2 PUT goes
  // through `aws4fetch`, which signs a `Request` and invokes the global
  // `fetch` with THAT SINGLE `Request` object as its only argument
  // (mirrors `convex/lib/r2/client.test.ts`'s own
  // `vi.stubGlobal("fetch", async (req: Request) => ...)` convention) —
  // so this mock must handle both calling conventions.
  const voiceBytes = new TextEncoder().encode("ogg/opus voice-note bytes");
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    if (input instanceof Request) {
      return new Response(null, { status: 200 });
    }
    const target = String(input);
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
      // A real `fetch` Response always carries `.headers` — `storeFromUrl`
      // reads `content-type` off it to pick the R2 object's extension.
      headers: new Headers({ "content-type": "audio/ogg" }),
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
  // The fix (R2-migration Task 7): the message gets an R2 object KEY,
  // shaped `<accountId>/inbound/<random><ext>` (`convex/lib/r2/keys.ts`'s
  // `buildMediaKey`) — was undefined -> "audio unavailable" in the inbox
  // before Task 6/7. `mediaUrl` is deliberately left unset: readers
  // resolve `mediaKey ?? mediaUrl` lazily at render time instead
  // (`convex/lib/r2/url.ts`'s `resolveMediaUrl`, Task 5).
  expect(message!.mediaKey).toBeTruthy();
  expect(message!.mediaKey).toMatch(/^[^/]+\/inbound\//);
  expect(message!.mediaUrl).toBeUndefined();
  // Both Meta round-trips happened (resolve id -> url, then download),
  // plus the R2 PUT.
  expect(fetchMock).toHaveBeenCalledTimes(3);

  delete process.env.R2_BUCKET;
  delete process.env.R2_ENDPOINT;
  delete process.env.R2_ACCESS_KEY_ID;
  delete process.env.R2_SECRET_ACCESS_KEY;
  delete process.env.R2_PUBLIC_HOST;
});

// ============================================================
// Conversion funnel: first-touch new_lead (formerly "Attribution
// signal", Task B4) — processInbound's LAST fan-out step, outside
// every flowConsumed guard (like webhookDelivery.dispatch just above
// it): detect our HY- ref code (in the message text) or Meta's
// ctwa_clid (ad referral), classify the lane, and seed the ONE
// `new_lead` conversionEvents row for that lane via
// conversionEvents.seedNewLead — only on a fresh insert (fire-once) —
// scheduling conversionEvents.deliverConversionEvent to dispatch it
// (`code` lane → Platform A, `ctwa` lane → direct CAPI; replaces the
// old attribution.recordSignal/sendSignal double-fire — see
// convex/ingest.ts's own comment on the step). Scaffold mirrors the
// minimal "account + aiConfig + webhook endpoint" processInbound tests
// above (e.g. the "automations phase matching zero automations" test)
// — no flows/automations needed.
// ============================================================

test("processInbound seeds a code-lane new_lead conversionEvent from an HY- code, and NO attributionSignals row", async () => {
  process.env.CONVEX_META_DRY_RUN = "1";
  process.env.CONVEX_AI_DRY_RUN = "1";
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Acme");
  await seedAiConfig(t, accountId);
  await seedWebhookEndpoint(t, { accountId, events: ["message.received"] });

  await t.action(internal.ingest.processInbound, {
    accountId, from: "15551234567",
    message: { type: "text", text: "hi," + hidden("ABCDEF") + " please", wamid: "wamid.CODE1" },
  });

  const conv = await t.run((ctx) =>
    ctx.db.query("conversations").withIndex("by_account", (q) => q.eq("accountId", accountId)).first());
  const events = await t.run((ctx) =>
    ctx.db.query("conversionEvents").withIndex("by_conversation", (q) => q.eq("conversationId", conv!._id)).collect());
  expect(events).toHaveLength(1);
  expect(events[0].lane).toBe("code");
  expect(events[0].backend).toBe("platformA");
  expect(events[0].eventName).toBe("Lead");
  expect(events[0].stage).toBe("new_lead");

  const signals = await t.run((ctx) =>
    ctx.db.query("attributionSignals").withIndex("by_account_result", (q) => q.eq("accountId", accountId)).collect());
  expect(signals).toHaveLength(0); // old path no longer writes
});

test("processInbound seeds a ctwa-lane new_lead conversionEvent (backend capi) from a ctwaClid", async () => {
  process.env.CONVEX_META_DRY_RUN = "1";
  process.env.CONVEX_AI_DRY_RUN = "1";
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Acme");
  await seedAiConfig(t, accountId);
  await seedWebhookEndpoint(t, { accountId, events: ["message.received"] });

  await t.action(internal.ingest.processInbound, {
    accountId, from: "15551234567",
    message: { type: "text", text: "hello", wamid: "wamid.CTWA1", ctwaClid: "clid-xyz789" },
  });

  const conv = await t.run((ctx) =>
    ctx.db.query("conversations").withIndex("by_account", (q) => q.eq("accountId", accountId)).first());
  const events = await t.run((ctx) =>
    ctx.db.query("conversionEvents").withIndex("by_conversation", (q) => q.eq("conversationId", conv!._id)).collect());
  expect(events).toHaveLength(1);
  expect(events[0].lane).toBe("ctwa");
  expect(events[0].backend).toBe("capi");
  expect(events[0].eventName).toBe("LeadSubmitted");
  expect(events[0].identifier).toBe("clid-xyz789");
});

test("processInbound captures an adReferrals row from an inbound ad referral", async () => {
  process.env.CONVEX_META_DRY_RUN = "1";
  process.env.CONVEX_AI_DRY_RUN = "1";
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Acme");
  await seedAiConfig(t, accountId);
  await seedWebhookEndpoint(t, { accountId, events: ["message.received"] });

  await t.action(internal.ingest.processInbound, {
    accountId,
    from: "15551234567",
    message: {
      type: "text",
      text: "hi",
      wamid: "wamid.AD1",
      ctwaClid: "clid-xyz789",
      referral: { sourceType: "ad", sourceId: "AD1", headline: "Maldives" },
    },
  });

  const rows = await t.run((ctx) =>
    ctx.db
      .query("adReferrals")
      .withIndex("by_account", (q) => q.eq("accountId", accountId))
      .collect(),
  );
  expect(rows).toHaveLength(1);
  expect(rows[0].ctwaClid).toBe("clid-xyz789");
  expect(rows[0].adId).toBe("AD1");
  expect(rows[0].isFirstTouch).toBe(true);
});

// ============================================================
// Ad->service tagging wiring (Task 5) — `processInbound` schedules
// `adServiceTagging.tagFromAd` for both the click itself (`trigger:
// "referral"`) and, on a follow-up in a conversation that started from
// an ad, a retry pass (`trigger: "followup"`). `tagFromAd` runs as a
// scheduled zero-delay mutation, not inline, so these tests drain it
// with `finishInProgressScheduledFunctions()` under fake timers — NOT
// `finishAllScheduledFunctions(vi.runAllTimers)`, which would also fire
// the ten-minute agent-reply SLA check `processInbound` books on every
// inbound (see `convex/ingest.ts:970`) and, with it, unrelated
// notification machinery this test has no business touching. A bounded
// handful of small `vi.advanceTimersByTime` steps is enough to cross
// the zero-delay scheduling gap without reaching anywhere near either
// that 10-minute SLA timer or the (2s+) debounced AI-reply timer —
// same technique `convex/ingest.test.ts`'s "bot reply before takeover"
// test already relies on.
async function seedUaeVisaService(
  t: TestConvex<typeof schema>,
  accountId: Id<"accounts">,
) {
  await t.run(async (ctx) => {
    await ctx.db.insert("kbServices", {
      accountId,
      key: "uae-visa",
      name: "UAE Visa",
      aliases: ["dubai visa"],
      status: "active",
      sortOrder: 0,
      updatedAt: Date.now(),
    });
  });
}

async function contactTagNames(
  t: TestConvex<typeof schema>,
  accountId: Id<"accounts">,
) {
  return await t.run(async (ctx) => {
    const contact = await ctx.db
      .query("contacts")
      .withIndex("by_account", (q) => q.eq("accountId", accountId))
      .first();
    if (!contact) return [];
    const links = await ctx.db
      .query("contactTags")
      .withIndex("by_contact", (q) => q.eq("contactId", contact._id))
      .collect();
    return await Promise.all(
      links.map(async (l) => (await ctx.db.get(l.tagId))?.name),
    );
  });
}

async function referralRow(
  t: TestConvex<typeof schema>,
  accountId: Id<"accounts">,
) {
  return await t.run((ctx) =>
    ctx.db
      .query("adReferrals")
      .withIndex("by_account", (q) => q.eq("accountId", accountId))
      .first(),
  );
}

/**
 * The MOST RECENT `adReferrals` row for the account — mirrors
 * `adServiceTagging.referralFor`'s own "newest wins" resolution
 * (collect + sort by `_creationTime` desc), needed once a test has more
 * than one row on the account (a second ad click inserts its own fresh
 * row rather than updating the first — see `adReferrals.recordAdReferral`).
 * `referralRow` above's plain `.first()` only happens to work for the
 * single-row tests; this is the one to reach for once a test seeds two.
 */
async function newestReferralRow(
  t: TestConvex<typeof schema>,
  accountId: Id<"accounts">,
) {
  const rows = await t.run((ctx) =>
    ctx.db
      .query("adReferrals")
      .withIndex("by_account", (q) => q.eq("accountId", accountId))
      .collect(),
  );
  return rows.sort((a, b) => b._creationTime - a._creationTime)[0] ?? null;
}

/**
 * Drains the zero-delay `tagFromAd` schedule booked inside `t.action`
 * above, under fake timers — see the block comment above this section
 * for why `finishInProgressScheduledFunctions()` (bounded small steps)
 * is used instead of `finishAllScheduledFunctions(vi.runAllTimers)`.
 */
async function drainAdTagging(t: TestConvex<typeof schema>) {
  for (let i = 0; i < 4; i++) {
    vi.advanceTimersByTime(100);
    await t.finishInProgressScheduledFunctions();
  }
}

test("processInbound tags the contact from the ad it came in on", async () => {
  process.env.CONVEX_META_DRY_RUN = "1";
  process.env.CONVEX_AI_DRY_RUN = "1";
  vi.useFakeTimers();
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Acme");
  await seedAiConfig(t, accountId);
  await seedUaeVisaService(t, accountId);

  await t.action(internal.ingest.processInbound, {
    accountId,
    from: "15551234567",
    message: {
      type: "text",
      text: "hi",
      wamid: "wamid.ADTAG1",
      referral: {
        sourceType: "ad",
        sourceId: "AD1",
        headline: "Apply for your UAE Visa today",
      },
    },
  });
  await drainAdTagging(t);

  expect(await contactTagNames(t, accountId)).toEqual(["UAE Visa"]);
  const row = await referralRow(t, accountId);
  expect(row?.serviceMatchStatus).toBe("matched");
  expect(row?.serviceMatchedOn).toBe("headline");
});

test("processInbound retries the ad match on the customer's next message", async () => {
  process.env.CONVEX_META_DRY_RUN = "1";
  process.env.CONVEX_AI_DRY_RUN = "1";
  vi.useFakeTimers();
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Acme");
  await seedAiConfig(t, accountId);
  await seedUaeVisaService(t, accountId);

  // The click itself: a vague ad names no service, so nothing is tagged.
  await t.action(internal.ingest.processInbound, {
    accountId,
    from: "15551234567",
    message: {
      type: "text",
      text: "hi",
      wamid: "wamid.ADTAG2A",
      referral: { sourceType: "ad", sourceId: "AD2", headline: "Talk to our team" },
    },
  });
  await drainAdTagging(t);

  expect(await contactTagNames(t, accountId)).toEqual([]);
  expect((await referralRow(t, accountId))?.serviceMatchStatus).toBe("unmatched");

  // The follow-up carries the customer's own words — no referral of its own.
  await t.action(internal.ingest.processInbound, {
    accountId,
    from: "15551234567",
    message: {
      type: "text",
      text: "i need a dubai visa please",
      wamid: "wamid.ADTAG2B",
    },
  });
  await drainAdTagging(t);

  expect(await contactTagNames(t, accountId)).toEqual(["UAE Visa"]);
  const row = await referralRow(t, accountId);
  expect(row?.serviceMatchStatus).toBe("matched");
  expect(row?.serviceMatchedOn).toBe("customerText");
});

test("processInbound does not double-spend the retry pass when a second ad click carries only a ctwaClid", async () => {
  process.env.CONVEX_META_DRY_RUN = "1";
  process.env.CONVEX_AI_DRY_RUN = "1";
  vi.useFakeTimers();
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Acme");
  await seedAiConfig(t, accountId);
  await seedUaeVisaService(t, accountId);

  // First click: sets the conversation's `adReferral` denorm.
  await t.action(internal.ingest.processInbound, {
    accountId,
    from: "15551234567",
    message: {
      type: "text",
      text: "hi",
      wamid: "wamid.ADTAG3A",
      referral: { sourceType: "ad", sourceId: "AD3", headline: "Talk to our team" },
    },
  });
  await drainAdTagging(t);

  // A second ad click on a creative-less ad: `webhookParse.ts` can hand
  // back a `ctwaClid` with no `referral` object at all. This still
  // satisfies the capture block's `referral || ctwaClid` guard above (a
  // fresh `adReferrals` row gets inserted for it) but must NOT also
  // satisfy the retry gate — that gate is reserved for a genuine
  // customer follow-up, not a second click event. Without excluding
  // `ctwaClid` too, this single inbound would spend BOTH rule passes on
  // the fresh row and fire the paid AI fallback immediately.
  await t.action(internal.ingest.processInbound, {
    accountId,
    from: "15551234567",
    message: {
      type: "text",
      text: "hi again",
      wamid: "wamid.ADTAG3B",
      ctwaClid: "clid-creativeless",
    },
  });
  await drainAdTagging(t);

  const row = await newestReferralRow(t, accountId);
  expect(row?.ctwaClid).toBe("clid-creativeless");
  // Only the first (referral) pass ran against this fresh row — one
  // attempt spent, not two.
  expect(row?.serviceMatchAttempts).toBe(1);
});

test("processInbound never ad-tags a conversation that came in organically", async () => {
  process.env.CONVEX_META_DRY_RUN = "1";
  process.env.CONVEX_AI_DRY_RUN = "1";
  vi.useFakeTimers();
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Acme");
  await seedAiConfig(t, accountId);
  await seedUaeVisaService(t, accountId);

  await t.action(internal.ingest.processInbound, {
    accountId,
    from: "15551234567",
    message: { type: "text", text: "i need a dubai visa please", wamid: "wamid.ORG1" },
  });
  await drainAdTagging(t);

  expect(await contactTagNames(t, accountId)).toEqual([]);
});

test("processInbound: an HY- code in the text wins over a ctwaClid also present on the same message", async () => {
  process.env.CONVEX_META_DRY_RUN = "1";
  process.env.CONVEX_AI_DRY_RUN = "1";
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Acme");
  await seedAiConfig(t, accountId);
  await seedWebhookEndpoint(t, { accountId, events: ["message.received"] });

  await t.action(internal.ingest.processInbound, {
    accountId,
    from: "15551234567",
    message: {
      type: "text",
      text: "hi," + hidden("ABCDEF") + " please",
      wamid: "wamid.BOTH1",
      ctwaClid: "clid-should-lose",
    },
  });

  const conv = await t.run((ctx) =>
    ctx.db.query("conversations").withIndex("by_account", (q) => q.eq("accountId", accountId)).first());
  const events = await t.run((ctx) =>
    ctx.db.query("conversionEvents").withIndex("by_conversation", (q) => q.eq("conversationId", conv!._id)).collect());
  expect(events).toHaveLength(1);
  expect(events[0]!.lane).toBe("code");
  expect(events[0]!.identifier).toBe("ABCDEF");
});

test("processInbound creates no attribution signal when the message carries neither an HY- code nor a ctwaClid", async () => {
  process.env.CONVEX_META_DRY_RUN = "1";
  process.env.CONVEX_AI_DRY_RUN = "1";
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Acme");
  await seedAiConfig(t, accountId);
  await seedWebhookEndpoint(t, { accountId, events: ["message.received"] });

  await t.action(internal.ingest.processInbound, {
    accountId,
    from: "15551234567",
    message: { type: "text", text: "just saying hello", wamid: "wamid.NONE" },
  });

  const conv = await t.run((ctx) =>
    ctx.db.query("conversations").withIndex("by_account", (q) => q.eq("accountId", accountId)).first());
  const events = await t.run((ctx) =>
    ctx.db.query("conversionEvents").withIndex("by_conversation", (q) => q.eq("conversationId", conv!._id)).collect());
  expect(events).toHaveLength(0);
});

test("processInbound does not create a second new_lead conversionEvent when the SAME code message is redelivered (duplicate wamid)", async () => {
  process.env.CONVEX_META_DRY_RUN = "1";
  process.env.CONVEX_AI_DRY_RUN = "1";
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Acme");
  await seedAiConfig(t, accountId);
  await seedWebhookEndpoint(t, { accountId, events: ["message.received"] });

  const message = {
    type: "text" as const,
    text: "hi," + hidden("ABCDEF") + " please",
    wamid: "wamid.DUPCODE",
  };

  const first = await t.action(internal.ingest.processInbound, {
    accountId,
    from: "15551234567",
    message,
  });
  expect(first.duplicate).toBe(false);

  const second = await t.action(internal.ingest.processInbound, {
    accountId,
    from: "15551234567",
    message,
  });
  expect(second.duplicate).toBe(true);

  const conv = await t.run((ctx) =>
    ctx.db.query("conversations").withIndex("by_account", (q) => q.eq("accountId", accountId)).first());
  const events = await t.run((ctx) =>
    ctx.db.query("conversionEvents").withIndex("by_conversation", (q) => q.eq("conversationId", conv!._id)).collect());
  expect(events).toHaveLength(1);
});

// ============================================================
// Task B8 — offline integration test for the SEAM no existing test
// covers. webhookParse.test.ts proves `flattenInboundMessage` extracts
// `ctwaClid` from a raw `referral` in isolation; the tests above prove
// `processInbound` consumes an ALREADY-flattened `message.ctwaClid`/HY-
// text and seeds a `new_lead` conversionEvents row — but nothing
// proves the two compose end-to-end: a RAW `MetaWebhookMessage`,
// flattened by the SAME `flattenInboundMessage` convex/http.ts's
// `processChange` calls, fed into `processInbound` exactly as
// `processChange` does it (`{ accountId, from: rawMessage.from, name,
// message: flattened }`), actually produces a `conversionEvents` row.
//
// httpActions themselves can't be invoked under convex-test (see
// webhookParse.ts's own header comment), so the literal HTTP POST to
// `/whatsapp/ingest` is the deferred live E2E (see
// docs/attribution-verified-conversion.md) — this offline test is the
// stand-in, replicating exactly what `processChange` does between the
// HTTP layer and the engine. Reuses this file's own
// `seedAccount`/`seedAiConfig`/`seedWebhookEndpoint` scaffolding and
// DRY-RUN env, same as every processInbound test above (the negative
// case below asserts that no conversionEvents are created). Each test
// asserts immediately after `processInbound` returns — before any
// scheduled fn runs — so every conversionEvents row here is still `"pending"`.
// ============================================================

test("integration seam: a RAW Meta message with referral.ctwa_clid flattens via flattenInboundMessage and ingests via processInbound into a ctwa-lane new_lead conversionEvent", async () => {
  process.env.CONVEX_META_DRY_RUN = "1";
  process.env.CONVEX_AI_DRY_RUN = "1";
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Acme");
  await seedAiConfig(t, accountId);
  await seedWebhookEndpoint(t, { accountId, events: ["message.received"] });

  // A RAW Meta webhook message — the exact shape Meta POSTs (an `id` +
  // `referral`), not a hand-built FlattenedInboundMessage.
  const raw: MetaWebhookMessage = {
    id: "wamid.INT-CTWA1",
    from: "15551230001",
    timestamp: "1700000000",
    type: "text",
    text: { body: "Hi, interested in your offer" },
    referral: { ctwa_clid: "clid-int-1", source_id: "AD1" },
  };

  const flattened = flattenInboundMessage(raw);
  if (!flattened) throw new Error("expected a flattened message, got null");
  // Proves this is genuinely the parser's output, not a hand-rolled
  // stand-in: `wamid` only exists on `flattened` because
  // flattenInboundMessage copied it over from raw.id (a differently
  // named field on the raw shape), and `ctwaClid` only exists because
  // it lifted raw.referral.ctwa_clid.
  expect(flattened.wamid).toBe(raw.id);
  expect(flattened.ctwaClid).toBe("clid-int-1");

  await t.action(internal.ingest.processInbound, {
    accountId,
    from: raw.from,
    message: flattened,
  });

  const conv = await t.run((ctx) =>
    ctx.db.query("conversations").withIndex("by_account", (q) => q.eq("accountId", accountId)).first());
  const events = await t.run((ctx) =>
    ctx.db.query("conversionEvents").withIndex("by_conversation", (q) => q.eq("conversationId", conv!._id)).collect());
  expect(events).toHaveLength(1);
  expect(events[0]!.lane).toBe("ctwa");
  expect(events[0]!.backend).toBe("capi");
  expect(events[0]!.identifier).toBe("clid-int-1");
  expect(events[0]!.status).toBe("pending");
});

test("integration seam: a RAW Meta message with an HY- code in the text flattens via flattenInboundMessage and ingests via processInbound into a code-lane new_lead conversionEvent", async () => {
  process.env.CONVEX_META_DRY_RUN = "1";
  process.env.CONVEX_AI_DRY_RUN = "1";
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Acme");
  await seedAiConfig(t, accountId);
  await seedWebhookEndpoint(t, { accountId, events: ["message.received"] });

  const raw: MetaWebhookMessage = {
    id: "wamid.INT-CODE1",
    from: "15551230002",
    timestamp: "1700000001",
    type: "text",
    text: { body: "hi," + hidden("ABCDEF") + " please" },
  };

  const flattened = flattenInboundMessage(raw);
  if (!flattened) throw new Error("expected a flattened message, got null");
  expect(flattened.wamid).toBe(raw.id);
  expect(flattened.text).toBe("hi," + hidden("ABCDEF") + " please");
  expect(flattened.ctwaClid).toBeUndefined();

  await t.action(internal.ingest.processInbound, {
    accountId,
    from: raw.from,
    message: flattened,
  });

  const conv = await t.run((ctx) =>
    ctx.db.query("conversations").withIndex("by_account", (q) => q.eq("accountId", accountId)).first());
  const events = await t.run((ctx) =>
    ctx.db.query("conversionEvents").withIndex("by_conversation", (q) => q.eq("conversationId", conv!._id)).collect());
  expect(events).toHaveLength(1);
  expect(events[0]!.lane).toBe("code");
  expect(events[0]!.backend).toBe("platformA");
  expect(events[0]!.identifier).toBe("ABCDEF");
  expect(events[0]!.status).toBe("pending");
});

test("integration seam: a RAW Meta CTWA message whose referral carries an UNRECOGNIZED source_type/media_type still ingests (regression: it used to be dropped outright)", async () => {
  process.env.CONVEX_META_DRY_RUN = "1";
  process.env.CONVEX_AI_DRY_RUN = "1";
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Acme");
  await seedAiConfig(t, accountId);

  // Meta is free to introduce ad surfaces/formats outside the closed
  // unions this codebase stores. Before the narrowing in
  // `flattenInboundMessage`, these two fields reached `ingestInbound`'s
  // validator verbatim and threw an ArgumentValidationError — and since
  // `http.ts` schedules `processInbound` AFTER acking Meta 200, the throw
  // was invisible: Meta never retried and the lead vanished. The message
  // must land.
  const raw: MetaWebhookMessage = {
    id: "wamid.INT-CTWA-UNKNOWN-ENUM",
    from: "15551230009",
    timestamp: "1700000000",
    type: "text",
    text: { body: "I saw your ad, send me details" },
    referral: {
      ctwa_clid: "clid-unknown-enum",
      source_id: "120237861630560444",
      source_type: "story_mention",
      media_type: "carousel",
      headline: "Dubai City Tour from AED 199",
      body: "Tap Send Message",
    },
  };

  const flattened = flattenInboundMessage(raw);
  if (!flattened) throw new Error("expected a flattened message, got null");

  await t.action(internal.ingest.processInbound, {
    accountId,
    from: raw.from,
    message: flattened,
  });

  const message = await t.run((ctx) =>
    ctx.db
      .query("messages")
      .withIndex("by_account", (q) => q.eq("accountId", accountId))
      .first(),
  );
  // The customer's actual message survived — the whole point.
  expect(message).not.toBeNull();
  expect(message!.contentText).toBe("I saw your ad, send me details");
  // The creative still renders; only the unrecognized enums are absent.
  expect(message!.referral?.headline).toBe("Dubai City Tour from AED 199");
  expect(message!.referral?.sourceType).toBeUndefined();
  expect(message!.referral?.mediaType).toBeUndefined();
  // Attribution still captured: the adReferrals row (the durable ad-lane
  // source) is written despite the unrecognized enums.
  const referralRow = await t.run((ctx) =>
    ctx.db
      .query("adReferrals")
      .withIndex("by_account", (q) => q.eq("accountId", accountId))
      .first(),
  );
  expect(referralRow).not.toBeNull();
  expect(referralRow!.ctwaClid).toBe("clid-unknown-enum");
  expect(referralRow!.headline).toBe("Dubai City Tour from AED 199");
});

test("integration seam: a RAW Meta message with neither a code nor a referral flattens via flattenInboundMessage and ingests via processInbound with NO attribution signal", async () => {
  process.env.CONVEX_META_DRY_RUN = "1";
  process.env.CONVEX_AI_DRY_RUN = "1";
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Acme");
  await seedAiConfig(t, accountId);
  await seedWebhookEndpoint(t, { accountId, events: ["message.received"] });

  const raw: MetaWebhookMessage = {
    id: "wamid.INT-NONE1",
    from: "15551230003",
    timestamp: "1700000002",
    type: "text",
    text: { body: "just saying hello" },
  };

  const flattened = flattenInboundMessage(raw);
  if (!flattened) throw new Error("expected a flattened message, got null");
  expect(flattened.wamid).toBe(raw.id);
  expect(flattened.ctwaClid).toBeUndefined();

  await t.action(internal.ingest.processInbound, {
    accountId,
    from: raw.from,
    message: flattened,
  });

  const conv = await t.run((ctx) =>
    ctx.db.query("conversations").withIndex("by_account", (q) => q.eq("accountId", accountId)).first());
  const events = await t.run((ctx) =>
    ctx.db.query("conversionEvents").withIndex("by_conversation", (q) => q.eq("conversationId", conv!._id)).collect());
  expect(events).toHaveLength(0);
});

test("processInbound persists the ad referral on the message, denorms it onto the conversation, and marks the contact acquired via ad", async () => {
  process.env.CONVEX_META_DRY_RUN = "1";
  process.env.CONVEX_AI_DRY_RUN = "1";
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Acme");
  await seedAiConfig(t, accountId);

  await t.action(internal.ingest.processInbound, {
    accountId,
    from: "15551230000",
    message: {
      type: "text",
      text: "Hello, how can I get more info?",
      wamid: "wamid.ADLEAD1",
      ctwaClid: "clid-1",
      referral: {
        sourceType: "ad",
        sourceId: "120210000",
        sourceUrl: "https://fb.me/ad123",
        headline: "Dubai 5N/6D Package",
        body: "Starting AED 1,499",
        mediaType: "image",
        imageUrl: "https://scontent.example/ad.jpg",
      },
    },
  });

  const message = await t.run((ctx) =>
    ctx.db
      .query("messages")
      .withIndex("by_message_id", (q) => q.eq("messageId", "wamid.ADLEAD1"))
      .first(),
  );
  expect(message!.referral?.headline).toBe("Dubai 5N/6D Package");
  expect(message!.referral?.sourceType).toBe("ad");

  const conversation = await t.run((ctx) => ctx.db.get(message!.conversationId));
  expect(conversation!.adReferral?.headline).toBe("Dubai 5N/6D Package");
  expect(typeof conversation!.adReferral?.startedAt).toBe("number");

  const contact = await t.run((ctx) => ctx.db.get(conversation!.contactId));
  expect(contact!.acquisitionSource).toBe("ad");
  expect(contact!.acquisitionAd?.sourceId).toBe("120210000");
});

test("processInbound does NOT overwrite an existing conversation adReferral or contact acquisition on a later ad message", async () => {
  process.env.CONVEX_META_DRY_RUN = "1";
  process.env.CONVEX_AI_DRY_RUN = "1";
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Acme");
  await seedAiConfig(t, accountId);

  const send = (wamid: string, headline: string) =>
    t.action(internal.ingest.processInbound, {
      accountId,
      from: "15551230000",
      message: {
        type: "text",
        text: "hi",
        wamid,
        referral: { sourceType: "ad", sourceId: "AD-" + headline, headline },
      },
    });
  await send("wamid.FIRST", "First Ad");
  await send("wamid.SECOND", "Second Ad");

  const conversation = await t.run((ctx) =>
    ctx.db.query("conversations").withIndex("by_account", (q) => q.eq("accountId", accountId)).first(),
  );
  expect(conversation!.adReferral?.headline).toBe("First Ad");
  const contact = await t.run((ctx) => ctx.db.get(conversation!.contactId));
  expect(contact!.acquisitionAd?.sourceId).toBe("AD-First Ad");
});

test("processInbound sets no ad fields for a plain (non-ad) inbound message", async () => {
  process.env.CONVEX_META_DRY_RUN = "1";
  process.env.CONVEX_AI_DRY_RUN = "1";
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Acme");
  await seedAiConfig(t, accountId);
  await t.action(internal.ingest.processInbound, {
    accountId,
    from: "15551239999",
    message: { type: "text", text: "just browsing", wamid: "wamid.PLAIN1" },
  });
  const conversation = await t.run((ctx) =>
    ctx.db.query("conversations").withIndex("by_account", (q) => q.eq("accountId", accountId)).first(),
  );
  expect(conversation!.adReferral).toBeUndefined();
  const contact = await t.run((ctx) => ctx.db.get(conversation!.contactId));
  expect(contact!.acquisitionSource).toBeUndefined();
});

test("processInbound downloads the ad image into R2 and attaches a storedImageKey to the message (not the conversation)", async () => {
  process.env.CONVEX_META_DRY_RUN = "1";
  process.env.CONVEX_AI_DRY_RUN = "1";
  // R2-migration write path (Task 7, completing Task 6): the ad-referral
  // image goes through `files.storeFromUrl` -> R2 — see the voice-note
  // test above for why these are set per-test.
  process.env.R2_BUCKET = "test-bucket";
  process.env.R2_ENDPOINT = "https://test.r2.cloudflarestorage.com";
  process.env.R2_ACCESS_KEY_ID = "test-key";
  process.env.R2_SECRET_ACCESS_KEY = "test-secret";
  process.env.R2_PUBLIC_HOST = "https://objs.amaniworld.com";
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Acme");
  await seedAiConfig(t, accountId);

  // Returns `{ ok: true, blob }` unconditionally, which covers BOTH the
  // ad-image download (called with a plain string URL) and the R2 PUT
  // that now follows (called with a single `Request` object — see the
  // voice-note test above) — `putObject` only inspects `res.ok`.
  const imgBytes = new TextEncoder().encode("jpeg-ad-banner-bytes");
  const fetchMock = vi.fn(async () =>
    ({
      ok: true,
      status: 200,
      // A real `fetch` Response always carries `.headers` —
      // `storeFromUrl` reads `content-type` off it.
      headers: new Headers({ "content-type": "image/jpeg" }),
      blob: async () => new Blob([imgBytes], { type: "image/jpeg" }),
    }) as unknown as Response,
  );
  vi.stubGlobal("fetch", fetchMock);

  await t.action(internal.ingest.processInbound, {
    accountId,
    from: "15551230000",
    message: {
      type: "text",
      text: "info?",
      wamid: "wamid.ADIMG1",
      referral: { sourceType: "ad", headline: "Pkg", imageUrl: "https://scontent.example/ad.jpg" },
    },
  });

  const message = await t.run((ctx) =>
    ctx.db.query("messages").withIndex("by_message_id", (q) => q.eq("messageId", "wamid.ADIMG1")).first(),
  );
  // The fix (R2-migration Task 7): the MESSAGE gets an R2 object key,
  // shaped `<accountId>/ad/<random><ext>` (`convex/lib/r2/keys.ts`'s
  // `buildMediaKey`) — `storedImageUrl` is deliberately left unset (the
  // inbox resolves `key ?? url` lazily at render time instead;
  // `convex/lib/r2/url.ts`'s `resolveMediaUrl`, Task 5).
  expect(message!.referral?.storedImageKey).toBeTruthy();
  expect(message!.referral?.storedImageKey).toMatch(/^[^/]+\/ad\//);
  expect(message!.referral?.storedImageUrl).toBeUndefined();

  // `conversations.adReferral` has no `storedImageKey` counterpart in the
  // schema — only `messages.referral` got one (R2-migration design spec's
  // "Schema changes" table) — and nothing renders its image (confirmed:
  // the inbox's ad-lead badge only checks presence/`startedAt`;
  // `AdReferralCard`, the one place an ad image actually renders, takes
  // the MESSAGE-level referral asserted above, never this denorm).
  // `setAdReferralImage` therefore no longer touches the conversation at
  // all as of Task 7 — this is a deliberate retirement, not a regression.
  const conversation = await t.run((ctx) => ctx.db.get(message!.conversationId));
  expect(conversation!.adReferral?.storedImageUrl).toBeUndefined();

  // The ad-image download, plus the R2 PUT.
  expect(fetchMock).toHaveBeenCalledTimes(2);

  delete process.env.R2_BUCKET;
  delete process.env.R2_ENDPOINT;
  delete process.env.R2_ACCESS_KEY_ID;
  delete process.env.R2_SECRET_ACCESS_KEY;
  delete process.env.R2_PUBLIC_HOST;
});

test("processInbound gives each ad message its OWN storedImageKey — the conversation-level image denorm is retired (Task 7), but its headline still pins to the FIRST ad", async () => {
  process.env.CONVEX_META_DRY_RUN = "1";
  process.env.CONVEX_AI_DRY_RUN = "1";
  // R2-migration write path (Task 7, completing Task 6) — see the
  // voice-note test above.
  process.env.R2_BUCKET = "test-bucket";
  process.env.R2_ENDPOINT = "https://test.r2.cloudflarestorage.com";
  process.env.R2_ACCESS_KEY_ID = "test-key";
  process.env.R2_SECRET_ACCESS_KEY = "test-secret";
  process.env.R2_PUBLIC_HOST = "https://objs.amaniworld.com";
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Acme");
  await seedAiConfig(t, accountId);

  // Distinct bytes per ad creative (adA vs adB) by URL — moot for R2
  // itself (each upload gets a fresh RANDOM key regardless of content,
  // unlike convex-test's content-addressed `ctx.storage.store` this
  // test predates), but harmless to keep: the R2 PUT call is invoked
  // with a `Request` object (not a string), so `String(url)` on it never
  // matches "adB" and both branches return the same `{ ok: true, blob }`
  // shape either way — `putObject` only inspects `res.ok`.
  const fetchMock = vi.fn(async (url: string | URL | Request) => {
    const bytes = new TextEncoder().encode(
      String(url).includes("adB") ? "jpeg-ad-B-bytes" : "jpeg-ad-A-bytes",
    );
    return {
      ok: true,
      status: 200,
      // A real `fetch` Response always carries `.headers` —
      // `storeFromUrl` reads `content-type` off it.
      headers: new Headers({ "content-type": "image/jpeg" }),
      blob: async () => new Blob([bytes], { type: "image/jpeg" }),
    } as unknown as Response;
  });
  vi.stubGlobal("fetch", fetchMock);

  const sendAd = (wamid: string, headline: string, imageUrl: string) =>
    t.action(internal.ingest.processInbound, {
      accountId,
      from: "15551230000",
      message: {
        type: "text",
        text: "info?",
        wamid,
        referral: { sourceType: "ad", headline, imageUrl },
      },
    });

  // ---- Ad A: the FIRST ad on this (new) conversation ----
  await sendAd("wamid.ADA", "Ad A", "https://scontent.example/adA.jpg");
  const msgA = await t.run((ctx) =>
    ctx.db.query("messages").withIndex("by_message_id", (q) => q.eq("messageId", "wamid.ADA")).first(),
  );
  const convAfterA = await t.run((ctx) => ctx.db.get(msgA!.conversationId));
  expect(msgA!.referral?.storedImageKey).toBeTruthy();
  expect(msgA!.referral?.storedImageKey).toMatch(/^[^/]+\/ad\//);
  // The conversation-level image echo is retired as of Task 7 — there is
  // no `storedImageKey` field on `conversations.adReferral` to migrate it
  // to, and nothing ever rendered it (see the test above). This is a
  // deliberate retirement, not an oversight.
  expect(convAfterA!.adReferral?.storedImageUrl).toBeUndefined();
  // The conversation's TEXT fields — unrelated to this task, still set by
  // `ingestInbound`, not `setAdReferralImage` — DO pin to the first ad.
  expect(convAfterA!.adReferral?.headline).toBe("Ad A");

  // ---- Ad B: a returning contact clicks a DIFFERENT ad; the SAME
  // conversation is reused (by_contact lookup), and its `adReferral` text
  // fields are set-once so they still hold Ad A's headline/imageUrl. ----
  await sendAd("wamid.ADB", "Ad B", "https://scontent.example/adB.jpg");
  const msgB = await t.run((ctx) =>
    ctx.db.query("messages").withIndex("by_message_id", (q) => q.eq("messageId", "wamid.ADB")).first(),
  );
  const convAfterB = await t.run((ctx) => ctx.db.get(msgB!.conversationId));

  // Msg B recorded its OWN stored image key (message-scoped — always
  // correct, and always DIFFERENT from Msg A's: each upload mints a fresh
  // random key regardless of content — `buildMediaKey`).
  expect(msgB!.referral?.storedImageKey).toBeTruthy();
  expect(msgB!.referral?.storedImageKey).not.toBe(msgA!.referral?.storedImageKey);
  // The conversation denorm's text fields stay PINNED to Ad A...
  expect(convAfterB!.adReferral?.headline).toBe("Ad A");
  // ...and its image field is still never populated by anyone.
  expect(convAfterB!.adReferral?.storedImageUrl).toBeUndefined();

  delete process.env.R2_BUCKET;
  delete process.env.R2_ENDPOINT;
  delete process.env.R2_ACCESS_KEY_ID;
  delete process.env.R2_SECRET_ACCESS_KEY;
  delete process.env.R2_PUBLIC_HOST;
});

// ============================================================
// Inbound reply linkage — the customer's `context.id` (the wamid of the
// message they replied to) resolves to the parent's internal id so the
// inbox renders the quote.
// ============================================================

test("ingestInbound links a reply to its parent via contextWamid", async () => {
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Acme");
  // Pre-seed the contact + conversation + our outbound message (the one the
  // customer replies to) so ingestInbound reuses that conversation.
  const { conversationId, parentId } = await t.run(async (ctx) => {
    const contactId = await ctx.db.insert("contacts", {
      accountId,
      phone: "15559990000",
      phoneNormalized: "15559990000",
    });
    const conversationId = await ctx.db.insert("conversations", {
      accountId,
      contactId,
      status: "open" as const,
      unreadCount: 0,
    });
    const parentId = await ctx.db.insert("messages", {
      accountId,
      conversationId,
      senderType: "agent" as const,
      contentType: "text" as const,
      contentText: "Here is your quote",
      messageId: "wamid.OURS",
      status: "sent" as const,
    });
    return { conversationId, parentId };
  });

  const res = await t.mutation(internal.ingest.ingestInbound, {
    accountId,
    from: "15559990000",
    name: "Cust",
    message: {
      type: "text",
      text: "thanks!",
      wamid: "wamid.THEIRS",
      contextWamid: "wamid.OURS",
    },
  });

  expect(res.conversationId).toBe(conversationId);
  const stored = await t.run((ctx) => ctx.db.get(res.messageId));
  expect(stored!.replyToMessageId).toBe(parentId);
});

test("ingestInbound leaves replyToMessageId undefined when contextWamid matches nothing", async () => {
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Acme");

  const res = await t.mutation(internal.ingest.ingestInbound, {
    accountId,
    from: "15559990001",
    name: "Cust",
    message: {
      type: "text",
      text: "hi",
      wamid: "wamid.NEW",
      contextWamid: "wamid.MISSING",
    },
  });

  const stored = await t.run((ctx) => ctx.db.get(res.messageId));
  expect(stored!.replyToMessageId).toBeUndefined();
});

// ============================================================
// contactCode — sequential HC-000001-style per-account identifier
// (Contact Section Enhancements, Task 2). `ingestInbound`'s
// contact-create branch must go through the same `allocateContactCode`
// helper `contacts.create`/`findOrCreateContactByPhone` already use, so
// a contact created via inbound WhatsApp ingestion also gets a code.
// ============================================================

test("ingestInbound assigns a contact code when it creates a new contact", async () => {
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Acme");

  const res = await t.mutation(internal.ingest.ingestInbound, {
    accountId,
    from: "+971501234567",
    name: "Guest",
    message: {
      type: "text",
      text: "hello",
      wamid: "wamid.CONTACT-CODE",
    },
  });

  const contact = await t.run((ctx) => ctx.db.get(res.contactId));
  expect(contact!.contactCode).toBe("HC-000001");
});

// ============================================================
// Agent-reply SLA — an ASSIGNED chat where the customer keeps waiting
// escalates to supervisors (bell + staff WhatsApp), and again if the
// agent stays silent. Bot-owned threads never escalate (the bot always
// replies); a newer customer message hands the cycle to its own check.
// ============================================================

async function seedSlaTeam(t: TestConvex<typeof schema>, accountId: Id<"accounts">) {
  return await t.run(async (ctx) => {
    const agentUserId = await ctx.db.insert("users", { name: "Aisha", email: "aisha@x.com" });
    await ctx.db.insert("memberships", {
      userId: agentUserId, accountId, role: "agent", fullName: "Aisha", email: "aisha@x.com",
    });
    const supervisorUserId = await ctx.db.insert("users", { name: "Sam", email: "sam@x.com" });
    await ctx.db.insert("memberships", {
      userId: supervisorUserId, accountId, role: "supervisor", fullName: "Sam",
      email: "sam@x.com", phone: "+971 55 111 2222",
    });
    return { agentUserId, supervisorUserId };
  });
}

async function notificationsFor(t: TestConvex<typeof schema>, accountId: Id<"accounts">) {
  return await t.run((ctx) =>
    ctx.db
      .query("notifications")
      .withIndex("by_account", (q) => q.eq("accountId", accountId))
      .collect(),
  );
}

test("an assigned agent staying silent escalates to the supervisor — bell + staff WhatsApp, then again", async () => {
  process.env.CONVEX_META_DRY_RUN = "1";
  process.env.CONVEX_AI_DRY_RUN = "1";
  vi.useFakeTimers();
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Acme");
  const { agentUserId, supervisorUserId } = await seedSlaTeam(t, accountId);

  await t.action(internal.ingest.processInbound, {
    accountId,
    from: "15551234567",
    message: { type: "text", text: "is my quote ready?", wamid: "wamid.SLA1" },
  });
  const contact = await t.run((ctx) =>
    ctx.db.query("contacts").withIndex("by_account", (q) => q.eq("accountId", accountId)).first(),
  );
  const conversation = await t.run((ctx) =>
    ctx.db.query("conversations").filter((q) => q.eq(q.field("contactId"), contact!._id)).first(),
  );
  // The agent takes the chat from the dashboard… and goes silent.
  await t.run((ctx) => ctx.db.patch(conversation!._id, { assignedToUserId: agentUserId }));

  await t.finishAllScheduledFunctions(vi.runAllTimers);

  const notifications = await notificationsFor(t, accountId);
  const supervisorBells = notifications.filter(
    (n) => n.userId === supervisorUserId && n.type === "sla_alert",
  );
  expect(supervisorBells).toHaveLength(2); // first alert + still-silent repeat
  expect(supervisorBells[0]!.conversationId).toBe(conversation!._id);
  // The silent agent is never the escalation target.
  expect(notifications.filter((n) => n.userId === agentUserId)).toHaveLength(0);
  // Staff WhatsApp alert is gated on the supervisor's OWN 24h messaging
  // window (P0 fix — see `qualificationEngine.ts`'s `notifyStaffText`:
  // Meta silently rejects a free-form send outside it, hours later,
  // invisibly to this action). Sam never messaged the bot, so this is
  // the realistic case — production's own failure mode — and the send
  // is now correctly skipped rather than doomed. The bell notification
  // asserted above is the channel this scenario can actually rely on;
  // the sibling test below covers the window-open case.
  const allMessages = await t.run((ctx) =>
    ctx.db.query("messages").withIndex("by_account", (q) => q.eq("accountId", accountId)).collect(),
  );
  expect(allMessages.some((m) => (m.contentText ?? "").includes("hasn't replied"))).toBe(false);
}, 30_000);

test("an assigned agent staying silent — the staff WhatsApp alert lands when the supervisor's own window is open", async () => {
  process.env.CONVEX_META_DRY_RUN = "1";
  process.env.CONVEX_AI_DRY_RUN = "1";
  vi.useFakeTimers();
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Acme");
  const { agentUserId, supervisorUserId } = await seedSlaTeam(t, accountId);

  await t.action(internal.ingest.processInbound, {
    accountId,
    from: "15551234567",
    message: { type: "text", text: "is my quote ready?", wamid: "wamid.SLA-OPEN1" },
  });
  // `.first()` below is unqualified beyond `accountId`, so the staff/
  // admin contact `ensureAdminConversation` creates must come AFTER this
  // lookup — otherwise it, not the customer, is what "first" returns.
  const contact = await t.run((ctx) =>
    ctx.db.query("contacts").withIndex("by_account", (q) => q.eq("accountId", accountId)).first(),
  );
  const conversation = await t.run((ctx) =>
    ctx.db.query("conversations").filter((q) => q.eq(q.field("contactId"), contact!._id)).first(),
  );
  await t.run((ctx) => ctx.db.patch(conversation!._id, { assignedToUserId: agentUserId }));

  // Unlike the sibling test above, Sam texted the staff-alert bot
  // recently (e.g. about a prior lead) — his own 24h customer service
  // window is open when the escalation fires, so the send can actually
  // reach him. Same fixture otherwise; this is the control proving the
  // skip above is the window gate, not a broken wire.
  const staffTarget = await t.mutation(internal.qualificationEngine.ensureAdminConversation, {
    accountId, phone: "+971 55 111 2222",
  });
  await t.run((ctx) =>
    ctx.db.patch(staffTarget.conversationId, { lastInboundAt: Date.now() }));

  await t.finishAllScheduledFunctions(vi.runAllTimers);

  const supervisorBells = (await notificationsFor(t, accountId)).filter(
    (n) => n.userId === supervisorUserId && n.type === "sla_alert",
  );
  expect(supervisorBells).toHaveLength(2); // unaffected control, mirrors the sibling test

  const allMessages = await t.run((ctx) =>
    ctx.db.query("messages").withIndex("by_account", (q) => q.eq("accountId", accountId)).collect(),
  );
  expect(allMessages.some((m) => (m.contentText ?? "").includes("hasn't replied"))).toBe(true);
}, 30_000);

test("an assigned agent who replied in time never escalates", async () => {
  process.env.CONVEX_META_DRY_RUN = "1";
  process.env.CONVEX_AI_DRY_RUN = "1";
  vi.useFakeTimers();
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Acme");
  const { agentUserId } = await seedSlaTeam(t, accountId);

  await t.action(internal.ingest.processInbound, {
    accountId,
    from: "15551234567",
    message: { type: "text", text: "is my quote ready?", wamid: "wamid.SLA2" },
  });
  const contact = await t.run((ctx) =>
    ctx.db.query("contacts").withIndex("by_account", (q) => q.eq("accountId", accountId)).first(),
  );
  const conversation = await t.run((ctx) =>
    ctx.db.query("conversations").filter((q) => q.eq(q.field("contactId"), contact!._id)).first(),
  );
  await t.run(async (ctx) => {
    await ctx.db.patch(conversation!._id, { assignedToUserId: agentUserId });
    await ctx.db.insert("messages", {
      accountId,
      conversationId: conversation!._id,
      senderType: "agent",
      contentType: "text",
      contentText: "Yes! Sending it over now.",
      status: "sent",
    });
  });

  await t.finishAllScheduledFunctions(vi.runAllTimers);

  expect(await notificationsFor(t, accountId)).toHaveLength(0);
}, 30_000);

test("checkAgentReplySla anchors on the OLDEST unanswered message — rapid pings never reset the clock", async () => {
  process.env.CONVEX_META_DRY_RUN = "1";
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Acme");
  const { agentUserId, supervisorUserId } = await seedSlaTeam(t, accountId);
  const { conversationId, firstMessageId, secondMessageId } = await t.run(async (ctx) => {
    const contactId = await ctx.db.insert("contacts", {
      accountId, phone: "+15551234567", phoneNormalized: "15551234567",
    });
    const conversationId = await ctx.db.insert("conversations", {
      accountId, contactId, status: "open", unreadCount: 0,
    });
    const firstMessageId = await ctx.db.insert("messages", {
      accountId, conversationId, senderType: "customer",
      contentType: "text", contentText: "first", status: "sent",
    });
    const secondMessageId = await ctx.db.insert("messages", {
      accountId, conversationId, senderType: "customer",
      contentType: "text", contentText: "second (still ignored!)", status: "sent",
    });
    return { conversationId, firstMessageId, secondMessageId };
  });

  // Unassigned: the bot owns the thread (it always replies) — no alert.
  await t.mutation(internal.ingest.checkAgentReplySla, {
    accountId, conversationId, inboundMessageId: firstMessageId, stage: 1,
  });
  expect(await notificationsFor(t, accountId)).toHaveLength(0);

  await t.run((ctx) => ctx.db.patch(conversationId, { assignedToUserId: agentUserId }));

  // The NEWER message's check stands down — the oldest unanswered
  // message anchors the cycle (otherwise every rapid ping would push
  // the alert forever while the customer waits).
  await t.mutation(internal.ingest.checkAgentReplySla, {
    accountId, conversationId, inboundMessageId: secondMessageId, stage: 1,
  });
  expect(await notificationsFor(t, accountId)).toHaveLength(0);

  // The anchor's own check FIRES even though newer pings exist.
  await t.mutation(internal.ingest.checkAgentReplySla, {
    accountId, conversationId, inboundMessageId: firstMessageId, stage: 1,
  });
  const bells = await notificationsFor(t, accountId);
  expect(bells.filter((n) => n.userId === supervisorUserId)).toHaveLength(1);
});

test("a bot reply before takeover satisfies the SLA — no false alarm after assignment", async () => {
  process.env.CONVEX_META_DRY_RUN = "1";
  process.env.CONVEX_AI_DRY_RUN = "1";
  // The reply now lands via TWO nested scheduled hops instead of one —
  // the debounced `dispatchInbound`, which itself schedules `deliverReply`
  // after a length-proportional delay once it runs. Pin both hops' delays
  // to a few ms so a small BOUNDED timer advance below can reliably drain
  // both without reaching anywhere near the 10-min SLA check further down:
  // `vi.runAllTimers()`/`t.finishAllScheduledFunctions(vi.runAllTimers)`
  // would also fire (and consume) that far-future SLA timer prematurely,
  // silently degrading the "no false alarm after assignment" check below
  // into a vacuous one (nothing left to fire once assignment happens).
  process.env.AI_REPLY_DEBOUNCE_FAST_MS = "50";
  process.env.AI_TYPING_MIN_MS = "50";
  process.env.AI_TYPING_MAX_MS = "100";
  process.env.AI_TYPING_JITTER = "0";
  vi.useFakeTimers();
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Acme");
  const { agentUserId } = await seedSlaTeam(t, accountId);
  await seedAiConfig(t, accountId);

  await t.action(internal.ingest.processInbound, {
    accountId,
    from: "15551234567",
    message: { type: "text", text: "hello!", wamid: "wamid.SLA3" },
  });
  // Bounded drain: several small steps comfortably cover both ~50-100ms
  // hops (debounce, then delivery) while staying orders of magnitude
  // under the 10-minute SLA window.
  for (let i = 0; i < 5; i++) {
    vi.advanceTimersByTime(500);
    await t.finishInProgressScheduledFunctions();
  }
  delete process.env.AI_REPLY_DEBOUNCE_FAST_MS;
  delete process.env.AI_TYPING_MIN_MS;
  delete process.env.AI_TYPING_MAX_MS;
  delete process.env.AI_TYPING_JITTER;
  const contact = await t.run((ctx) =>
    ctx.db.query("contacts").withIndex("by_account", (q) => q.eq("accountId", accountId)).first(),
  );
  const conversation = await t.run((ctx) =>
    ctx.db.query("conversations").filter((q) => q.eq(q.field("contactId"), contact!._id)).first(),
  );
  const botReplies = (await messagesFor(t, conversation!._id)).filter(
    (m) => m.senderType === "bot",
  );
  expect(botReplies).toHaveLength(1); // the customer WAS answered (by the bot)

  // Routine takeover a few minutes later — then the SLA check fires.
  await t.run((ctx) => ctx.db.patch(conversation!._id, { assignedToUserId: agentUserId }));
  await t.finishAllScheduledFunctions(vi.runAllTimers);

  // The customer isn't waiting: the bot already replied to their last
  // message. No supervisor alarm may fire.
  expect(await notificationsFor(t, accountId)).toHaveLength(0);
}, 30_000);

test("an archived conversation never escalates, even assigned and inside the SLA window (P2 final-fixes Fix 7)", async () => {
  process.env.CONVEX_META_DRY_RUN = "1";
  process.env.CONVEX_AI_DRY_RUN = "1";
  vi.useFakeTimers();
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Acme");
  const { agentUserId } = await seedSlaTeam(t, accountId);

  await t.action(internal.ingest.processInbound, {
    accountId,
    from: "15551234567",
    message: { type: "text", text: "is my quote ready?", wamid: "wamid.SLA-ARCHIVED" },
  });
  const contact = await t.run((ctx) =>
    ctx.db.query("contacts").withIndex("by_account", (q) => q.eq("accountId", accountId)).first(),
  );
  const conversation = await t.run((ctx) =>
    ctx.db.query("conversations").filter((q) => q.eq(q.field("contactId"), contact!._id)).first(),
  );
  // Assigned (so it would otherwise escalate) AND archived — archiving a
  // thread inside the SLA window must suppress the alert exactly like
  // closing it already does. Without the `archivedAt` guard, this fires
  // an `sla_alert` for a conversation nobody is meant to be watching
  // anymore.
  await t.run((ctx) =>
    ctx.db.patch(conversation!._id, {
      assignedToUserId: agentUserId,
      archivedAt: Date.now(),
    }),
  );

  await t.finishAllScheduledFunctions(vi.runAllTimers);

  expect(await notificationsFor(t, accountId)).toHaveLength(0);
}, 30_000);

// ============================================================
// Instant acknowledgement wiring (whole-branch review Fix F5) — the
// headline behaviour of this branch (blue tick + "typing…" the moment
// an inbound lands, not after the debounce) was previously asserted
// ONLY at the `aiReply.ackInbound` action's own gates
// (`aiReply.test.ts`), never at the wiring layer: nothing proved
// `processInbound` actually SCHEDULES it, let alone at delay 0. Deleting
// the scheduling block in `ingest.ts` left the full 1938-test suite
// green — silently restoring the pre-branch bug (customer sees nothing
// until the debounce elapses). This test closes that gap by inspecting
// the `_scheduled_functions` system table directly, the same pattern
// `campaignAds.test.ts`/`conversionEvents.test.ts` already use for
// asserting on scheduled fan-out.
// ============================================================

test("processing a normal text inbound schedules aiReply.ackInbound at delay 0, separately from the debounced aiReply.dispatchInbound", async () => {
  process.env.CONVEX_META_DRY_RUN = "1";
  process.env.CONVEX_AI_DRY_RUN = "1";
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Acme");
  await seedAiConfig(t, accountId);

  const beforeCall = Date.now();
  await t.action(internal.ingest.processInbound, {
    accountId,
    from: "15551234567",
    message: { type: "text", text: "hello there, need some info please", wamid: "wamid.ACKSCHED" },
  });

  const scheduled = await t.run((ctx) =>
    ctx.db.system.query("_scheduled_functions").collect(),
  );
  const ackRows = scheduled.filter((s) => s.name === "aiReply:ackInbound");
  expect(ackRows).toHaveLength(1);
  const ackRow = ackRows[0]!;

  // "Delay 0" means `runAfter(0, ...)` — scheduledTime lands essentially
  // at "now", not after any debounce wait. A generous 1s tolerance
  // absorbs the real (unmocked-timer) DB work `processInbound` awaits
  // before reaching the scheduling call, while staying far below the
  // fastest debounce tier (`AI_REPLY_DEBOUNCE_FAST_MS`, default 2000ms)
  // — so this can't accidentally pass by matching the DEBOUNCED call
  // instead of the instant one.
  expect(ackRow.scheduledTime - beforeCall).toBeLessThan(1000);

  // The ack carries the SAME triggering wamid the inbound arrived with
  // (what F1 elsewhere makes a retry able to reuse for a re-ack).
  expect(ackRow.args[0]).toMatchObject({
    accountId,
    triggerWamid: "wamid.ACKSCHED",
  });

  // The debounced dispatch is a SEPARATE scheduled call, firing
  // meaningfully later than the ack — proving the two are independent
  // schedules, not the same call.
  const dispatchRows = scheduled.filter((s) => s.name === "aiReply:dispatchInbound");
  expect(dispatchRows).toHaveLength(1);
  expect(dispatchRows[0]!.scheduledTime - ackRow.scheduledTime).toBeGreaterThan(1000);
});

// ============================================================
// Lead Analysis follow-up sequence — stop on inbound (P3 Task 6).
// `leadAnalysisEngine.stopOnInbound` runs inside `runBestEffort` — a
// throw there must never fail ingestion (proven below by the "no row"
// no-op case resolving normally, and by the "different account" test not
// existing here since `processInbound` always resolves the correct
// account).
//
// It USED to sit beside P2's `unarchiveOnInbound`. That one moved into
// the message transaction on 2026-07-28: stopping a sequence is
// automation and may be lost, but un-archiving is a correctness
// property of the Inbox — a swallowed failure there hid a customer who
// was actively writing in. See `messages.ts`'s own comment.
// ============================================================

test("a second inbound message stops a running follow-up sequence and resets the counter", async () => {
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Acme");

  // Plain `ingestInbound` (not `processInbound`) for the FIRST message —
  // it returns `conversationId`/`contactId` directly, and only the
  // SECOND message below needs to go through the full `processInbound`
  // fan-out that carries this suite's new `stopOnInbound` hook.
  const first = await t.mutation(internal.ingest.ingestInbound, {
    accountId,
    from: "15551234567",
    message: { type: "text", text: "hi", wamid: "wamid.SEQ1" },
  });
  const conversationId = first.conversationId;
  const contactId = first.contactId;

  const analysisId = await t.run((ctx) =>
    ctx.db.insert("leadAnalyses", {
      accountId,
      conversationId,
      contactId,
      score: 9,
      band: "hot",
      scoreStatus: "scored",
      attempts: 0,
      sequenceStatus: "running",
      followUpsSent: 2,
      nextFollowUpAt: Date.now() + 24 * 60 * 60_000,
    }),
  );

  await t.action(internal.ingest.processInbound, {
    accountId,
    from: "15551234567",
    message: { type: "text", text: "still there?", wamid: "wamid.SEQ2" },
  });

  const row = await t.run((ctx) => ctx.db.get(analysisId));
  expect(row!.sequenceStatus).toBe("stopped");
  expect(row!.stoppedReason).toBe("replied");
  expect(row!.followUpsSent).toBe(0);
  expect(row!.nextFollowUpAt).toBeUndefined();
});

test("an inbound message on a conversation with no leadAnalyses row is a cheap no-op — ingestion still completes normally", async () => {
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Acme");

  const result = await t.action(internal.ingest.processInbound, {
    accountId,
    from: "15551234567",
    message: { type: "text", text: "hello", wamid: "wamid.SEQ3" },
  });

  expect(result.duplicate).toBe(false);
  expect(await t.run((ctx) => ctx.db.query("leadAnalyses").collect())).toHaveLength(0);
});

// ============================================================
// Media understanding runs on ARRIVAL, independent of auto-reply
// (2026-07-25). Before this, transcription lived inside
// `aiReply.dispatchInbound` BELOW its `autoReplyEnabled` gate, so an
// account with auto-reply off — the default — never produced a single
// transcript and every inbound voice note stayed a bare "[voice note]"
// in the inbox. Reading what a customer said and letting the bot answer
// them are different decisions.
// ============================================================

test("processInbound transcribes an inbound voice note even with auto-reply OFF, and still sends no reply", { timeout: 15_000 }, async () => {
  process.env.CONVEX_META_DRY_RUN = "1";
  process.env.CONVEX_AI_DRY_RUN = "1";
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Acme");
  const apiKey = await encrypt("sk-test-key");
  await t.run((ctx) =>
    ctx.db.insert("aiConfigs", {
      accountId,
      provider: "openai" as const,
      model: "gpt-4o-mini",
      apiKey,
      isActive: true,
      autoReplyEnabled: false, // the default the owner has to turn on
    }),
  );

  vi.useFakeTimers();
  await t.action(internal.ingest.processInbound, {
    accountId,
    from: "15551234567",
    name: "Jamie Customer",
    message: {
      type: "audio",
      mediaUrl: "https://example.com/voice.ogg",
      wamid: "wamid.VOICE",
    },
  });
  // Understanding is scheduled off the ingest path, not awaited inline.
  await t.finishAllScheduledFunctions(vi.runAllTimers);

  const contact = await t.run((ctx) =>
    ctx.db
      .query("contacts")
      .withIndex("by_account", (q) => q.eq("accountId", accountId))
      .first(),
  );
  const conversation = await t.run((ctx) =>
    ctx.db
      .query("conversations")
      .filter((q) => q.eq(q.field("contactId"), contact!._id))
      .first(),
  );
  const messages = await messagesFor(t, conversation!._id);

  // The transcript reaches the inbox for the humans working it…
  const audio = messages.find((m) => m.contentType === "audio");
  expect(audio).toBeDefined();
  expect(audio!.aiTranscription).toBe("[dry-run transcript]");
  // …and the bot still says nothing to the customer.
  expect(messages.filter((m) => m.senderType === "bot")).toHaveLength(0);
});

// ============================================================
// Task 5 — cancellation path 5: `stopOnReply`. `processInbound`'s
// automations block also schedules
// `automationsEngine.cancelRunsForContact` (best-effort, unconditional
// on which triggers matched) so a contact who replies stops any
// `stopOnReply` automation's still-waiting run.
// ============================================================

test("stopOnReply cancels a waiting run when the contact replies", async () => {
  vi.useFakeTimers();
  process.env.CONVEX_META_DRY_RUN = "1";
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "StopOnReply");
  const tagId = await seedTag(t, accountId, "post-wait");

  const automationId = await t.run((ctx) =>
    ctx.db.insert("automations", {
      accountId,
      name: "Nudge",
      triggerType: "keyword_match",
      triggerConfig: { keywords: ["quote"], match_type: "contains" },
      isActive: true,
      executionCount: 0,
      stopOnReply: true,
    }),
  );
  await t.run((ctx) =>
    ctx.db.insert("automationSteps", {
      accountId,
      automationId,
      stepType: "wait",
      stepConfig: { amount: 1, unit: "minutes" },
      position: 0,
    }),
  );
  await t.run((ctx) =>
    ctx.db.insert("automationSteps", {
      accountId,
      automationId,
      stepType: "add_tag",
      stepConfig: { tag_id: tagId },
      position: 1,
    }),
  );
  // A customer-facing effect, not just a DB-only one — a `messages`-zero
  // assertion needs something that could actually send if cancellation
  // were broken (post-review fix; `add_tag` alone has no such effect).
  await t.run((ctx) =>
    ctx.db.insert("automationSteps", {
      accountId,
      automationId,
      stepType: "send_message",
      stepConfig: { text: "Still interested?" },
      position: 2,
    }),
  );

  const first = await t.mutation(internal.ingest.ingestInbound, {
    accountId,
    from: "15550009999",
    message: { type: "text", text: "quote please", wamid: "wamid.FIRST" },
  });

  await t.action(internal.automationsEngine.runForTrigger, {
    accountId,
    triggerType: "keyword_match",
    contactId: first.contactId,
    context: { messageText: "quote please", conversationId: first.conversationId },
  });

  const parked = await t.run((ctx) =>
    ctx.db
      .query("automationRuns")
      .withIndex("by_account_automation", (q) =>
        q.eq("accountId", accountId).eq("automationId", automationId),
      )
      .unique(),
  );
  expect(parked?.status).toBe("waiting");

  await t.action(internal.ingest.processInbound, {
    accountId,
    from: "15550009999",
    message: { type: "text", text: "yes please", wamid: "wamid.SECOND" },
  });

  const run = await t.run((ctx) => ctx.db.get(parked!._id));
  expect(run?.status).toBe("cancelled");
  expect(run?.errorMessage).toMatch(/replied/);

  // Zero sends: the original wait's own resume, once it fires, must not
  // apply either post-wait step.
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  expect(await tagLink(t, first.contactId, tagId)).toBeNull();
  const messages = await t.run((ctx) =>
    ctx.db
      .query("messages")
      .withIndex("by_conversation", (q) => q.eq("conversationId", first.conversationId))
      .collect(),
  );
  // Only the two real inbound messages from the customer — never the
  // automation's own post-wait send.
  expect(messages.filter((m) => m.senderType === "bot")).toHaveLength(0);
});

test("without stopOnReply, a reply leaves the waiting run alone", async () => {
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "NoStopOnReply");

  const automationId = await t.run((ctx) =>
    ctx.db.insert("automations", {
      accountId,
      name: "Nudge",
      triggerType: "keyword_match",
      triggerConfig: { keywords: ["quote"], match_type: "contains" },
      isActive: true,
      executionCount: 0,
      // stopOnReply intentionally omitted — default-off.
    }),
  );
  await t.run((ctx) =>
    ctx.db.insert("automationSteps", {
      accountId,
      automationId,
      stepType: "wait",
      stepConfig: { amount: 1, unit: "minutes" },
      position: 0,
    }),
  );

  const first = await t.mutation(internal.ingest.ingestInbound, {
    accountId,
    from: "15550008888",
    message: { type: "text", text: "quote please", wamid: "wamid.FIRST2" },
  });

  await t.action(internal.automationsEngine.runForTrigger, {
    accountId,
    triggerType: "keyword_match",
    contactId: first.contactId,
    context: { messageText: "quote please", conversationId: first.conversationId },
  });

  const parked = await t.run((ctx) =>
    ctx.db
      .query("automationRuns")
      .withIndex("by_account_automation", (q) =>
        q.eq("accountId", accountId).eq("automationId", automationId),
      )
      .unique(),
  );
  expect(parked?.status).toBe("waiting");

  await t.action(internal.ingest.processInbound, {
    accountId,
    from: "15550008888",
    message: { type: "text", text: "still there?", wamid: "wamid.SECOND2" },
  });

  const run = await t.run((ctx) => ctx.db.get(parked!._id));
  expect(run?.status).toBe("waiting");
});
