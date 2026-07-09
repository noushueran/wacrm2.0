/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, expect, test, vi } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import {
  evaluateConditionPredicate,
  isAutoAdvancing,
  isSuspending,
  isTerminal,
  matchesKeywordTrigger,
  matchReplyId,
} from "./flowsEngine";
import type { Id } from "./_generated/dataModel";

// Convex function modules for convex-test to resolve `internal.*`
// references against. Absolute, from-project-root pattern (matches
// every other `convex/*.test.ts` suite).
const modules = import.meta.glob("/convex/**/*.ts");

afterEach(() => {
  // Belt-and-suspenders: a thrown assertion could skip a test's own
  // cleanup — guard every other test in this file from inheriting fake
  // timers or a leaked DRY-RUN env var (mirrors
  // `automationsEngine.test.ts`'s own afterEach).
  vi.useRealTimers();
  delete process.env.CONVEX_META_DRY_RUN;
});

// ============================================================
// Seed helpers — no `memberships` row unless a test specifically
// needs one (the handoff test, for its assignee) since every entry
// point here is an `internal*` function with an explicit,
// caller-supplied `accountId` — there is no user session to derive
// from a membership the way `contacts.test.ts` etc. need one.
// ============================================================

async function seedAccount(t: ReturnType<typeof convexTest>, name: string) {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { name, email: `${name.toLowerCase()}@example.com` });
    return await ctx.db.insert("accounts", { name: `${name}'s account`, defaultCurrency: "USD", ownerUserId: userId });
  });
}

async function seedContactAndConversation(
  t: ReturnType<typeof convexTest>,
  accountId: Id<"accounts">,
  phone: string,
) {
  return await t.run(async (ctx) => {
    const contactId = await ctx.db.insert("contacts", { accountId, phone, phoneNormalized: phone });
    const conversationId = await ctx.db.insert("conversations", {
      accountId,
      contactId,
      status: "open",
      unreadCount: 0,
    });
    return { contactId, conversationId };
  });
}

async function seedTag(t: ReturnType<typeof convexTest>, accountId: Id<"accounts">, name: string) {
  return await t.run((ctx) => ctx.db.insert("tags", { accountId, name, color: "#000000" }));
}

async function seedFlow(
  t: ReturnType<typeof convexTest>,
  opts: {
    accountId: Id<"accounts">;
    name?: string;
    status?: "draft" | "active" | "archived";
    triggerType: "keyword" | "first_inbound_message" | "manual";
    triggerConfig?: unknown;
    entryNodeId: string;
    fallbackPolicy?: unknown;
    createdByUserId?: Id<"users">;
  },
) {
  return await t.run((ctx) =>
    ctx.db.insert("flows", {
      accountId: opts.accountId,
      createdByUserId: opts.createdByUserId,
      name: opts.name ?? "Test flow",
      status: opts.status ?? "active",
      triggerType: opts.triggerType,
      triggerConfig: opts.triggerConfig,
      entryNodeId: opts.entryNodeId,
      fallbackPolicy: opts.fallbackPolicy,
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
    nodeType:
      | "start"
      | "send_buttons"
      | "send_list"
      | "send_message"
      | "send_media"
      | "collect_input"
      | "condition"
      | "set_tag"
      | "handoff"
      | "http_fetch"
      | "end";
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

// Scans (not `.withIndex`) — a helper function parameter typed as the
// bare `ReturnType<typeof convexTest>` loses this suite's concrete
// index names, so a `.withIndex(...)` call inside a helper can't
// resolve; `.filter()` needs no declared index name and is plenty fast
// at this suite's tiny scale. Mirrors `automationsEngine.test.ts`'s own
// documented `tagLink` workaround for the identical gotcha.
async function messagesFor(t: ReturnType<typeof convexTest>, conversationId: Id<"conversations">) {
  return await t.run((ctx) =>
    ctx.db.query("messages").filter((q) => q.eq(q.field("conversationId"), conversationId)).collect(),
  );
}

async function eventsFor(t: ReturnType<typeof convexTest>, flowRunId: Id<"flowRuns">) {
  return await t.run((ctx) =>
    ctx.db.query("flowRunEvents").filter((q) => q.eq(q.field("flowRunId"), flowRunId)).collect(),
  );
}

// ============================================================
// Pure-helper tests — ported from `src/lib/flows/engine.test.ts`
// (byte-faithful: same function signatures, same assertions).
// ============================================================

test("matchReplyId: null for nodes without options; matches send_buttons/send_list; null on no match", () => {
  expect(matchReplyId({ node_type: "start", config: { next_node_key: "x" } }, "y")).toBeNull();
  expect(matchReplyId({ node_type: "send_message", config: {} }, "y")).toBeNull();
  expect(matchReplyId({ node_type: "end", config: {} }, "y")).toBeNull();

  const buttons = {
    node_type: "send_buttons",
    config: {
      text: "Pick one",
      buttons: [
        { reply_id: "yes", title: "Yes", next_node_key: "confirmed" },
        { reply_id: "no", title: "No", next_node_key: "declined" },
      ],
    },
  };
  expect(matchReplyId(buttons, "yes")).toBe("confirmed");
  expect(matchReplyId(buttons, "no")).toBe("declined");
  expect(matchReplyId(buttons, "nope")).toBeNull();

  const list = {
    node_type: "send_list",
    config: {
      text: "Pick an order",
      button_label: "View",
      sections: [
        { title: "Recent", rows: [{ reply_id: "o1", title: "Order 1", next_node_key: "ord_1" }] },
        {
          title: "Older",
          rows: [
            { reply_id: "o2", title: "Order 2", next_node_key: "ord_2" },
            { reply_id: "o3", title: "Order 3", next_node_key: "ord_3" },
          ],
        },
      ],
    },
  };
  expect(matchReplyId(list, "o1")).toBe("ord_1");
  expect(matchReplyId(list, "o3")).toBe("ord_3");
  expect(matchReplyId(list, "o99")).toBeNull();
  expect(matchReplyId({ node_type: "send_list", config: { text: "x", sections: [] } }, "x")).toBeNull();
});

test("matchesKeywordTrigger: contains/exact, case sensitivity, empty inputs, multi-keyword", () => {
  expect(matchesKeywordTrigger("", { keywords: ["hi"] })).toBe(false);
  expect(matchesKeywordTrigger("anything", { keywords: [] })).toBe(false);

  const contains = { keywords: ["support"] };
  expect(matchesKeywordTrigger("I need SUPPORT please", contains)).toBe(true);
  expect(matchesKeywordTrigger("Help me", contains)).toBe(false);

  const exact = { keywords: ["help"], match_type: "exact" as const };
  expect(matchesKeywordTrigger("help", exact)).toBe(true);
  expect(matchesKeywordTrigger("help me", exact)).toBe(false);

  const caseSensitive = { keywords: ["Support"], case_sensitive: true };
  expect(matchesKeywordTrigger("I need Support", caseSensitive)).toBe(true);
  expect(matchesKeywordTrigger("I need support", caseSensitive)).toBe(false);

  const multi = { keywords: ["help", "support", "issue"] };
  expect(matchesKeywordTrigger("I have an issue", multi)).toBe(true);
  expect(matchesKeywordTrigger("nothing to see here", multi)).toBe(false);

  expect(matchesKeywordTrigger("support center", { keywords: ["", "support", ""] })).toBe(true);
});

test("isAutoAdvancing/isSuspending/isTerminal classify every known node type, mutually exclusively", () => {
  expect(isAutoAdvancing("start")).toBe(true);
  expect(isAutoAdvancing("send_message")).toBe(true);
  expect(isAutoAdvancing("send_media")).toBe(true);
  expect(isAutoAdvancing("condition")).toBe(true);
  expect(isAutoAdvancing("set_tag")).toBe(true);
  expect(isAutoAdvancing("send_buttons")).toBe(false);

  expect(isSuspending("send_buttons")).toBe(true);
  expect(isSuspending("send_list")).toBe(true);
  expect(isSuspending("collect_input")).toBe(true);
  expect(isSuspending("start")).toBe(false);

  expect(isTerminal("handoff")).toBe(true);
  expect(isTerminal("end")).toBe(true);
  expect(isTerminal("start")).toBe(false);

  const types = [
    "start",
    "send_message",
    "send_buttons",
    "send_list",
    "send_media",
    "collect_input",
    "condition",
    "set_tag",
    "handoff",
    "end",
  ];
  for (const t of types) {
    const flags = [isAutoAdvancing(t), isSuspending(t), isTerminal(t)];
    expect(flags.filter(Boolean).length).toBe(1);
  }
});

test("evaluateConditionPredicate: present/absent/equals/contains semantics", () => {
  expect(evaluateConditionPredicate({ operator: "present", subjectValue: "alice@example.com", configValue: undefined })).toBe(true);
  expect(evaluateConditionPredicate({ operator: "present", subjectValue: undefined, configValue: undefined })).toBe(false);
  expect(evaluateConditionPredicate({ operator: "present", subjectValue: "", configValue: undefined })).toBe(false);

  expect(evaluateConditionPredicate({ operator: "absent", subjectValue: undefined, configValue: undefined })).toBe(true);
  expect(evaluateConditionPredicate({ operator: "absent", subjectValue: "x", configValue: undefined })).toBe(false);

  expect(evaluateConditionPredicate({ operator: "equals", subjectValue: "VIP", configValue: "VIP" })).toBe(true);
  expect(evaluateConditionPredicate({ operator: "equals", subjectValue: "vip", configValue: "VIP" })).toBe(false);
  expect(evaluateConditionPredicate({ operator: "equals", subjectValue: undefined, configValue: "" })).toBe(false);

  expect(evaluateConditionPredicate({ operator: "contains", subjectValue: "support@example.com", configValue: "@example.com" })).toBe(true);
  expect(evaluateConditionPredicate({ operator: "contains", subjectValue: "support@other.com", configValue: "@example.com" })).toBe(false);
  expect(evaluateConditionPredicate({ operator: "contains", subjectValue: undefined, configValue: "anything" })).toBe(false);
});

// ============================================================
// 1. Keyword trigger starts a run and executes the first node.
// ============================================================

test("an inbound matching a flow's keyword trigger starts a run and executes the first node (sent message + run active)", async () => {
  process.env.CONVEX_META_DRY_RUN = "1";
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Acme");
  const { contactId, conversationId } = await seedContactAndConversation(t, accountId, "15551234567");

  const flowId = await seedFlow(t, {
    accountId,
    triggerType: "keyword",
    triggerConfig: { keywords: ["hi"], match_type: "contains" },
    entryNodeId: "start",
    fallbackPolicy: { on_unknown_reply: "reprompt", max_reprompts: 2, on_timeout_hours: 24, on_exhaust: "handoff" },
  });
  await seedNode(t, { accountId, flowId, nodeKey: "start", nodeType: "start", config: { next_node_key: "greet" } });
  await seedNode(t, {
    accountId,
    flowId,
    nodeKey: "greet",
    nodeType: "send_message",
    config: { text: "Hello!", next_node_key: "menu" },
  });
  await seedNode(t, {
    accountId,
    flowId,
    nodeKey: "menu",
    nodeType: "send_buttons",
    config: {
      text: "Pick one",
      buttons: [
        { reply_id: "a", title: "Option A", next_node_key: "end1" },
        { reply_id: "b", title: "Option B", next_node_key: "end1" },
      ],
    },
  });
  await seedNode(t, { accountId, flowId, nodeKey: "end1", nodeType: "end", config: {} });

  const result = await t.action(internal.flowsEngine.dispatchInbound, {
    accountId,
    contactId,
    message: { kind: "text", text: "hi there", metaMessageId: "wamid-1" },
    isFirstInboundMessage: false,
  });

  expect(result.consumed).toBe(true);
  expect(result.outcome).toBe("started");

  const messages = await messagesFor(t, conversationId);
  expect(messages).toHaveLength(2);
  expect(messages[0]!.contentType).toBe("text");
  expect(messages[0]!.contentText).toBe("Hello!");
  expect(messages[1]!.contentType).toBe("interactive");
  expect(messages[1]!.messageId).toMatch(/^dry-run-[0-9a-f]{16}$/);

  const run = await t.run((ctx) => ctx.db.get(result.flowRunId!));
  expect(run!.status).toBe("active");
  expect(run!.currentNodeKey).toBe("menu");
  expect(run!.lastPromptMessageId).toBe(messages[1]!._id);
  expect(run!.fallbackTimeoutId).toBeDefined();

  const flow = await t.run((ctx) => ctx.db.get(flowId));
  expect(flow!.executionCount).toBe(1);
  expect(flow!.lastExecutedAt).toBeDefined();
});

// ============================================================
// 2. collect_input suspends; a matching reply advances + captures.
// ============================================================

test("a collect_input node suspends; a matching text reply captures the var and advances", async () => {
  process.env.CONVEX_META_DRY_RUN = "1";
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Acme");
  const { contactId, conversationId } = await seedContactAndConversation(t, accountId, "15551234567");

  const flowId = await seedFlow(t, {
    accountId,
    triggerType: "keyword",
    triggerConfig: { keywords: ["signup"] },
    entryNodeId: "start",
  });
  await seedNode(t, { accountId, flowId, nodeKey: "start", nodeType: "start", config: { next_node_key: "ask_email" } });
  await seedNode(t, {
    accountId,
    flowId,
    nodeKey: "ask_email",
    nodeType: "collect_input",
    config: { prompt_text: "What's your email?", var_key: "email", next_node_key: "thanks" },
  });
  await seedNode(t, {
    accountId,
    flowId,
    nodeKey: "thanks",
    nodeType: "send_message",
    config: { text: "Thanks, {{vars.email}}!", next_node_key: "end1" },
  });
  await seedNode(t, { accountId, flowId, nodeKey: "end1", nodeType: "end", config: {} });

  const started = await t.action(internal.flowsEngine.dispatchInbound, {
    accountId,
    contactId,
    message: { kind: "text", text: "signup", metaMessageId: "wamid-1" },
    isFirstInboundMessage: false,
  });
  expect(started.outcome).toBe("started");

  let run = await t.run((ctx) => ctx.db.get(started.flowRunId!));
  expect(run!.status).toBe("active");
  expect(run!.currentNodeKey).toBe("ask_email");
  const messagesAfterPrompt = await messagesFor(t, conversationId);
  expect(messagesAfterPrompt).toHaveLength(1);
  expect(messagesAfterPrompt[0]!.contentText).toBe("What's your email?");

  const resumed = await t.action(internal.flowsEngine.dispatchInbound, {
    accountId,
    contactId,
    message: { kind: "text", text: "alice@example.com", metaMessageId: "wamid-2" },
    isFirstInboundMessage: false,
  });
  expect(resumed.consumed).toBe(true);
  expect(resumed.outcome).toBe("completed");
  expect(resumed.flowRunId).toBe(started.flowRunId);

  run = await t.run((ctx) => ctx.db.get(started.flowRunId!));
  expect(run!.status).toBe("completed");
  expect(run!.endReason).toBe("end_node");
  expect(run!.vars).toEqual({ email: "alice@example.com" });

  const messages = await messagesFor(t, conversationId);
  expect(messages.map((m) => m.contentText)).toEqual(["What's your email?", "Thanks, alice@example.com!"]);
});

// ============================================================
// 3. condition node branches correctly.
// ============================================================

test("a condition node (tag presence) branches to the correct child", async () => {
  process.env.CONVEX_META_DRY_RUN = "1";
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Acme");
  const vipTagId = await seedTag(t, accountId, "vip");

  const flowId = await seedFlow(t, { accountId, triggerType: "keyword", triggerConfig: { keywords: ["hi"] }, entryNodeId: "start" });
  await seedNode(t, { accountId, flowId, nodeKey: "start", nodeType: "start", config: { next_node_key: "check_vip" } });
  await seedNode(t, {
    accountId,
    flowId,
    nodeKey: "check_vip",
    nodeType: "condition",
    config: { subject: "tag", subject_key: vipTagId, operator: "present", true_next: "vip_msg", false_next: "std_msg" },
  });
  await seedNode(t, { accountId, flowId, nodeKey: "vip_msg", nodeType: "send_message", config: { text: "VIP welcome!", next_node_key: "end1" } });
  await seedNode(t, { accountId, flowId, nodeKey: "std_msg", nodeType: "send_message", config: { text: "Standard welcome", next_node_key: "end1" } });
  await seedNode(t, { accountId, flowId, nodeKey: "end1", nodeType: "end", config: {} });

  const { contactId: plainContactId, conversationId: plainConversationId } = await seedContactAndConversation(t, accountId, "15550000001");
  await t.action(internal.flowsEngine.dispatchInbound, {
    accountId,
    contactId: plainContactId,
    message: { kind: "text", text: "hi", metaMessageId: "wamid-plain" },
    isFirstInboundMessage: false,
  });
  const plainMessages = await messagesFor(t, plainConversationId);
  expect(plainMessages.map((m) => m.contentText)).toEqual(["Standard welcome"]);

  const { contactId: vipContactId, conversationId: vipConversationId } = await seedContactAndConversation(t, accountId, "15550000002");
  await t.run((ctx) => ctx.db.insert("contactTags", { accountId, contactId: vipContactId, tagId: vipTagId }));
  await t.action(internal.flowsEngine.dispatchInbound, {
    accountId,
    contactId: vipContactId,
    message: { kind: "text", text: "hi", metaMessageId: "wamid-vip" },
    isFirstInboundMessage: false,
  });
  const vipMessages = await messagesFor(t, vipConversationId);
  expect(vipMessages.map((m) => m.contentText)).toEqual(["VIP welcome!"]);
});

// ============================================================
// 4. handoff node assigns the conversation + ends the run.
// ============================================================

test("a handoff node assigns the conversation to the configured agent and ends the run", async () => {
  process.env.CONVEX_META_DRY_RUN = "1";
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Acme");
  const { contactId, conversationId } = await seedContactAndConversation(t, accountId, "15551234567");
  const agentUserId = await t.run((ctx) => ctx.db.insert("users", { name: "Agent Smith", email: "agent@example.com" }));
  await t.run((ctx) => ctx.db.insert("memberships", { userId: agentUserId, accountId, role: "agent" }));

  const flowId = await seedFlow(t, { accountId, triggerType: "keyword", triggerConfig: { keywords: ["help"] }, entryNodeId: "start" });
  await seedNode(t, { accountId, flowId, nodeKey: "start", nodeType: "start", config: { next_node_key: "escalate" } });
  await seedNode(t, {
    accountId,
    flowId,
    nodeKey: "escalate",
    nodeType: "handoff",
    config: { note: "needs a human", assign_to: agentUserId },
  });

  const result = await t.action(internal.flowsEngine.dispatchInbound, {
    accountId,
    contactId,
    message: { kind: "text", text: "help", metaMessageId: "wamid-1" },
    isFirstInboundMessage: false,
  });
  expect(result.outcome).toBe("handed_off");

  const conversation = await t.run((ctx) => ctx.db.get(conversationId));
  expect(conversation!.status).toBe("pending");
  expect(conversation!.assignedToUserId).toBe(agentUserId);

  const run = await t.run((ctx) => ctx.db.get(result.flowRunId!));
  expect(run!.status).toBe("handed_off");
  expect(run!.endReason).toBe("handoff_node");
  expect(run!.fallbackTimeoutId).toBeUndefined();

  const events = await eventsFor(t, result.flowRunId!);
  expect(events.some((e) => e.eventType === "handoff")).toBe(true);
});

// ============================================================
// 5. Fallback timeout via the scheduler (no flows cron).
// ============================================================

test("fallback: after finishAllScheduledFunctions, a stale active run has the fallback policy applied", async () => {
  process.env.CONVEX_META_DRY_RUN = "1";
  vi.useFakeTimers();
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Acme");
  const { contactId } = await seedContactAndConversation(t, accountId, "15551234567");

  const flowId = await seedFlow(t, {
    accountId,
    triggerType: "keyword",
    triggerConfig: { keywords: ["hi"] },
    entryNodeId: "start",
    // max_reprompts: 0 + on_exhaust: "end" makes a single timeout fire
    // resolve deterministically to "end" (rather than another reprompt
    // cycle), keeping the assertion below unambiguous.
    fallbackPolicy: { on_unknown_reply: "reprompt", max_reprompts: 0, on_timeout_hours: 1, on_exhaust: "end" },
  });
  await seedNode(t, { accountId, flowId, nodeKey: "start", nodeType: "start", config: { next_node_key: "menu" } });
  await seedNode(t, {
    accountId,
    flowId,
    nodeKey: "menu",
    nodeType: "send_buttons",
    config: { text: "Pick one", buttons: [{ reply_id: "a", title: "A", next_node_key: "end1" }] },
  });
  await seedNode(t, { accountId, flowId, nodeKey: "end1", nodeType: "end", config: {} });

  const result = await t.action(internal.flowsEngine.dispatchInbound, {
    accountId,
    contactId,
    message: { kind: "text", text: "hi", metaMessageId: "wamid-1" },
    isFirstInboundMessage: false,
  });
  expect(result.outcome).toBe("started");

  let run = await t.run((ctx) => ctx.db.get(result.flowRunId!));
  expect(run!.status).toBe("active");
  expect(run!.fallbackTimeoutId).toBeDefined();

  await t.finishAllScheduledFunctions(vi.runAllTimers);

  run = await t.run((ctx) => ctx.db.get(result.flowRunId!));
  expect(run!.status).toBe("completed");
  expect(run!.endReason).toBe("fallback_exhausted_end");
  expect(run!.fallbackTimeoutId).toBeUndefined();

  const events = await eventsFor(t, result.flowRunId!);
  expect(events.some((e) => e.eventType === "timeout")).toBe(true);

  vi.useRealTimers();
});

// ============================================================
// 6. Account isolation.
// ============================================================

test("account isolation: account B's inbound never advances account A's run; dispatch for A only considers A's flows", async () => {
  process.env.CONVEX_META_DRY_RUN = "1";
  const t = convexTest(schema, modules);
  const accountA = await seedAccount(t, "Acme");
  const accountB = await seedAccount(t, "Globex");

  const { contactId: contactA } = await seedContactAndConversation(t, accountA, "15550000001");
  const { contactId: contactB } = await seedContactAndConversation(t, accountB, "15550000002");

  // Same trigger keyword in both accounts so a leak would be observable.
  const flowA = await seedFlow(t, { accountId: accountA, triggerType: "keyword", triggerConfig: { keywords: ["help"] }, entryNodeId: "start" });
  await seedNode(t, { accountId: accountA, flowId: flowA, nodeKey: "start", nodeType: "start", config: { next_node_key: "menu" } });
  await seedNode(t, {
    accountId: accountA,
    flowId: flowA,
    nodeKey: "menu",
    nodeType: "send_buttons",
    config: { text: "Pick one", buttons: [{ reply_id: "opt1", title: "Option 1", next_node_key: "end1" }] },
  });
  await seedNode(t, { accountId: accountA, flowId: flowA, nodeKey: "end1", nodeType: "end", config: {} });

  const flowB = await seedFlow(t, { accountId: accountB, triggerType: "keyword", triggerConfig: { keywords: ["help"] }, entryNodeId: "startB" });
  await seedNode(t, { accountId: accountB, flowId: flowB, nodeKey: "startB", nodeType: "start", config: { next_node_key: "endB" } });
  await seedNode(t, { accountId: accountB, flowId: flowB, nodeKey: "endB", nodeType: "end", config: {} });

  // Dispatch for account A's own contact — must only ever consider flowA.
  const resultA = await t.action(internal.flowsEngine.dispatchInbound, {
    accountId: accountA,
    contactId: contactA,
    message: { kind: "text", text: "help", metaMessageId: "wamid-a1" },
    isFirstInboundMessage: false,
  });
  expect(resultA.outcome).toBe("started");

  const flowBDoc = await t.run((ctx) => ctx.db.get(flowB));
  expect(flowBDoc!.executionCount).toBe(0);

  let runA = await t.run((ctx) => ctx.db.get(resultA.flowRunId!));
  expect(runA!.status).toBe("active");
  expect(runA!.currentNodeKey).toBe("menu");
  const eventsBefore = await eventsFor(t, resultA.flowRunId!);

  // Dispatch for account B's own contact with an interactive_reply
  // carrying the SAME replyId A's buttons use. B's contact has no
  // active run of its own (interactive replies never start a new flow),
  // so this must be a clean no-op that never touches A's run.
  const resultB = await t.action(internal.flowsEngine.dispatchInbound, {
    accountId: accountB,
    contactId: contactB,
    message: { kind: "interactive_reply", replyId: "opt1", replyTitle: "Option 1", metaMessageId: "wamid-b1" },
    isFirstInboundMessage: false,
  });
  expect(resultB.consumed).toBe(false);
  expect(resultB.outcome).toBe("no_match");

  runA = await t.run((ctx) => ctx.db.get(resultA.flowRunId!));
  expect(runA!.status).toBe("active");
  expect(runA!.currentNodeKey).toBe("menu");
  const eventsAfter = await eventsFor(t, resultA.flowRunId!);
  expect(eventsAfter).toHaveLength(eventsBefore.length);
});
