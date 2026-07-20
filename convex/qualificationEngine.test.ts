import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import { holidayysDefaultConfig } from "./lib/qualification/defaults";

const modules = import.meta.glob("/convex/**/*.ts");

// Same two-flag DRY-RUN convention as aiReply.test.ts: the analysis
// pass skips the real LLM under CONVEX_AI_DRY_RUN, and any Meta send it
// might trigger later phases stays synthetic under CONVEX_META_DRY_RUN.
beforeEach(() => {
  process.env.CONVEX_AI_DRY_RUN = "1";
  process.env.CONVEX_META_DRY_RUN = "1";
});
afterEach(() => {
  delete process.env.CONVEX_AI_DRY_RUN;
  delete process.env.CONVEX_META_DRY_RUN;
});

async function seed(
  t: ReturnType<typeof convexTest>,
  opts: { enabled: boolean; adminPhones?: string[] } = { enabled: true },
) {
  const base = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { name: "U", email: "u@example.com" });
    const accountId = await ctx.db.insert("accounts", {
      name: "A", defaultCurrency: "AED", ownerUserId: userId,
    });
    await ctx.db.insert("memberships", {
      userId, accountId, role: "admin", fullName: "U", email: "u@example.com",
    });
    await ctx.db.insert("qualificationConfigs", {
      accountId,
      ...holidayysDefaultConfig(),
      enabled: opts.enabled,
      adminAlertPhones: opts.adminPhones ?? [],
    });
    const contactId = await ctx.db.insert("contacts", {
      accountId, phone: "+971500000001", phoneNormalized: "971500000001",
    });
    const conversationId = await ctx.db.insert("conversations", {
      accountId, contactId, status: "open", unreadCount: 0,
    });
    return { userId, accountId, contactId, conversationId };
  });
  const asUser = t.withIdentity({ subject: `${base.userId}|session-u` });
  return { ...base, asUser };
}

/** Admin upsert of an active AI config (encrypts the key properly). */
async function configureAi(
  asUser: ReturnType<TestConvex<typeof schema>["withIdentity"]>,
) {
  await asUser.mutation(api.aiConfig.upsert, {
    provider: "openai" as const,
    model: "gpt-4o-mini",
    isActive: true,
    autoReplyEnabled: true,
    apiKey: "sk-test-key",
  });
}

async function seedCustomerMessage(
  t: ReturnType<typeof convexTest>,
  accountId: Id<"accounts">,
  conversationId: Id<"conversations">,
  text: string,
) {
  await t.run((ctx) =>
    ctx.db.insert("messages", {
      accountId,
      conversationId,
      senderType: "customer",
      contentType: "text",
      contentText: text,
      status: "delivered",
    }),
  );
}

// `TestConvex<typeof schema>` for `.withIndex` — same documented gotcha
// as `convex/funnel.test.ts`'s `eventsFor` / `track.test.ts`'s helper.
function sessionsFor(
  t: TestConvex<typeof schema>,
  conversationId: Id<"conversations">,
) {
  return t.run((ctx) =>
    ctx.db
      .query("qualificationSessions")
      .withIndex("by_conversation", (q) => q.eq("conversationId", conversationId))
      .collect(),
  );
}

test("onInbound creates a collecting session and stamps activity", async () => {
  const t = convexTest(schema, modules);
  const { accountId, contactId, conversationId } = await seed(t);
  await t.mutation(internal.qualificationEngine.onInbound, {
    accountId, conversationId, contactId, phoneNormalized: "971500000001",
  });
  const rows = await sessionsFor(t, conversationId);
  expect(rows).toHaveLength(1);
  expect(rows[0].status).toBe("collecting");
  expect(rows[0].origin).toBe("inbound");
  expect(rows[0].lastCustomerMessageAt).toBeGreaterThan(0);
});

test("onInbound is a no-op when the feature is disabled", async () => {
  const t = convexTest(schema, modules);
  const { accountId, contactId, conversationId } = await seed(t, { enabled: false });
  await t.mutation(internal.qualificationEngine.onInbound, {
    accountId, conversationId, contactId, phoneNormalized: "971500000001",
  });
  expect(await sessionsFor(t, conversationId)).toHaveLength(0);
});

test("onInbound never opens a session for an admin-alert number (loop guard)", async () => {
  const t = convexTest(schema, modules);
  const { accountId, contactId, conversationId } = await seed(t, {
    enabled: true, adminPhones: ["+971 50 000 0001"],
  });
  await t.mutation(internal.qualificationEngine.onInbound, {
    accountId, conversationId, contactId, phoneNormalized: "971500000001",
  });
  expect(await sessionsFor(t, conversationId)).toHaveLength(0);
});

test("appendInternal (agent send) opens an outbound session and stamps humanTouchedAt", async () => {
  const t = convexTest(schema, modules);
  const { accountId, conversationId } = await seed(t);
  await t.mutation(internal.messages.appendInternal, {
    accountId, conversationId, senderType: "agent",
    contentType: "text", contentText: "Hello from an agent",
  });
  const rows = await sessionsFor(t, conversationId);
  expect(rows).toHaveLength(1);
  expect(rows[0].origin).toBe("outbound");
  expect(rows[0].humanTouchedAt).toBeGreaterThan(0);
});

test("appendInternal (bot send) opens a session but never sets humanTouchedAt; disabled config no-ops", async () => {
  const t = convexTest(schema, modules);
  const { accountId, conversationId } = await seed(t);
  await t.mutation(internal.messages.appendInternal, {
    accountId, conversationId, senderType: "bot",
    contentType: "text", contentText: "template blast",
  });
  const rows = await sessionsFor(t, conversationId);
  expect(rows).toHaveLength(1);
  expect(rows[0].humanTouchedAt).toBeUndefined();

  const off = await seed(t, { enabled: false });
  await t.mutation(internal.messages.appendInternal, {
    accountId: off.accountId, conversationId: off.conversationId, senderType: "agent",
    contentType: "text", contentText: "hi",
  });
  expect(await sessionsFor(t, off.conversationId)).toHaveLength(0);
});

test("onInbound leaves closed conversations alone", async () => {
  const t = convexTest(schema, modules);
  const { accountId, contactId, conversationId } = await seed(t);
  await t.run(async (ctx) => {
    await ctx.db.patch(conversationId, { status: "closed" });
  });
  await t.mutation(internal.qualificationEngine.onInbound, {
    accountId, conversationId, contactId, phoneNormalized: "971500000001",
  });
  expect(await sessionsFor(t, conversationId)).toHaveLength(0);
});

// ---- P1: analysis pipeline (DRY-RUN synthetic — see syntheticAnalysisRaw) ----

test("analyzeInbound extracts fields, score and pendingQuestion into the session", async () => {
  const t = convexTest(schema, modules);
  const { accountId, contactId, conversationId, asUser } = await seed(t);
  await configureAi(asUser);
  await seedCustomerMessage(t, accountId, conversationId,
    "field:nationality=Indian;field:travel_dates=August; score:70");
  await t.action(internal.qualificationEngine.analyzeInbound, {
    accountId, conversationId, contactId,
  });
  const [s] = await sessionsFor(t, conversationId);
  const byKey = Object.fromEntries(s.fields.map((f) => [f.key, f.value]));
  expect(byKey.nationality).toBe("Indian");
  expect(byKey.travel_dates).toBe("August");
  expect(s.score).toBe(70);
  expect(s.answeredCount).toBe(2);
  expect(s.expectedCount).toBeGreaterThanOrEqual(2);
  expect(s.serviceName).toBe("UAE visa");
  expect(s.pendingQuestion?.text).toBeTruthy();
  expect(s.checklistSatisfiedAt).toBeUndefined();
  expect(s.status).toBe("collecting");
});

test("analyzeInbound stamps readiness AND completes when checklist satisfied + score >= threshold + >=3 answers", async () => {
  const t = convexTest(schema, modules);
  const { accountId, contactId, conversationId, asUser } = await seed(t);
  await configureAi(asUser);
  await seedCustomerMessage(t, accountId, conversationId,
    "[[COMPLETE]] score:80 field:a=1;field:b=2;field:c=3");
  await t.action(internal.qualificationEngine.analyzeInbound, {
    accountId, conversationId, contactId,
  });
  const [s] = await sessionsFor(t, conversationId);
  expect(s.checklistSatisfiedAt).toBeGreaterThan(0);
  expect(s.status).toBe("qualified"); // P2: readiness triggers completion
});

test("analyzeInbound does NOT stamp readiness below the answer floor", async () => {
  const t = convexTest(schema, modules);
  const { accountId, contactId, conversationId, asUser } = await seed(t);
  await configureAi(asUser);
  await seedCustomerMessage(t, accountId, conversationId,
    "[[COMPLETE]] score:80 field:a=1;field:b=2");
  await t.action(internal.qualificationEngine.analyzeInbound, {
    accountId, conversationId, contactId,
  });
  const [s] = await sessionsFor(t, conversationId);
  expect(s.checklistSatisfiedAt).toBeUndefined();
});

test("opt-out intent closes the session and silences the bot", async () => {
  const t = convexTest(schema, modules);
  const { accountId, contactId, conversationId, asUser } = await seed(t);
  await configureAi(asUser);
  await seedCustomerMessage(t, accountId, conversationId, "[[STOP]] please stop messaging");
  await t.action(internal.qualificationEngine.analyzeInbound, {
    accountId, conversationId, contactId,
  });
  const [s] = await sessionsFor(t, conversationId);
  expect(s.status).toBe("opted_out");
  expect(s.closedReason).toBe("opted_out");
  const conversation = await t.run((ctx) => ctx.db.get(conversationId));
  expect(conversation?.aiAutoreplyDisabled).toBe(true);
});

test("wants-human intent flags the thread for the team while the bot keeps replying", async () => {
  const t = convexTest(schema, modules);
  const { accountId, contactId, conversationId, asUser } = await seed(t);
  await configureAi(asUser);
  await seedCustomerMessage(t, accountId, conversationId, "[[HUMAN]] can I talk to someone");
  await t.action(internal.qualificationEngine.analyzeInbound, {
    accountId, conversationId, contactId,
  });
  const [s] = await sessionsFor(t, conversationId);
  expect(s.status).toBe("collecting");
  const conversation = await t.run((ctx) => ctx.db.get(conversationId));
  // Handoff is manual-only: the thread is SURFACED (pending + summary)
  // but the bot is never silenced and nobody is auto-assigned.
  expect(conversation?.aiAutoreplyDisabled).not.toBe(true);
  expect(conversation?.status).toBe("pending");
  expect(conversation?.aiHandoffSummary).toContain("human");
  expect(conversation?.assignedToUserId).toBeUndefined();
});

test("a failed relay send un-claims the answer so injection can still deliver it", async () => {
  const t = convexTest(schema, modules);
  const base = await seed(t, { enabled: true, adminPhones: ["+971 55 999 8888"] });
  await configureAi(base.asUser);
  const inquiryId = await t.run((ctx) =>
    ctx.db.insert("adminInquiries", {
      accountId: base.accountId, conversationId: base.conversationId,
      contactId: base.contactId, question: "Q?",
      customerName: "Ravi", customerPhone: "+971500000001",
      status: "answered", answer: "Visa on arrival, 30 days", askedAt: 1, answeredAt: Date.now(),
    }));
  // Force the Meta send to FAIL: no whatsappConfig row + META dry-run off
  // ("WhatsApp not configured" throw). AI dry-run stays on (compose step).
  delete process.env.CONVEX_META_DRY_RUN;
  await t.action(internal.qualificationEngine.relayAnswerToCustomer, { inquiryId });
  const inquiry = await t.run((ctx) => ctx.db.get(inquiryId));
  // NOT stuck on "delivered": the failed send un-claims so pendingAnswers
  // injection (status "answered") still gets it to the customer later.
  expect(inquiry?.status).toBe("answered");
  expect(await messagesFor(t, base.conversationId)).toHaveLength(0);
});

test("follow-up nudges yield once a human is assigned (assignment = takeover)", async () => {
  const t = convexTest(schema, modules);
  const base = await seedAllHours(t);
  const sessionId = await seedDueSession(t, base);
  await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { name: "A", email: "a@x.com" });
    await ctx.db.patch(base.conversationId, { assignedToUserId: userId });
  });
  await t.action(internal.qualificationEngine.sendFollowUp, { sessionId });
  expect(await messagesFor(t, base.conversationId)).toHaveLength(0); // no nudge
  const [s] = await sessionsFor(t, base.conversationId);
  expect(s.status).toBe("collecting");
  expect(s.nextFollowUpAt).toBeGreaterThan(Date.now()); // parked, not sent
});

test("ask-admin with no admin numbers flags the thread pending but never silences the bot", async () => {
  const t = convexTest(schema, modules);
  const base = await seed(t);
  await configureAi(base.asUser);
  await t.action(internal.qualificationEngine.relayQuestionToAdmin, {
    accountId: base.accountId,
    conversationId: base.conversationId,
    contactId: base.contactId,
    question: "What is the Georgia visa fee?",
  });
  const conversation = await t.run((ctx) => ctx.db.get(base.conversationId));
  expect(conversation?.status).toBe("pending");
  expect(conversation?.aiHandoffSummary).toContain("Georgia visa fee");
  expect(conversation?.aiAutoreplyDisabled).not.toBe(true);
});

test("analyzeInbound is a no-op without an active AI config or on terminal sessions", async () => {
  const t = convexTest(schema, modules);
  const { accountId, contactId, conversationId } = await seed(t);
  // no aiConfig at all
  await seedCustomerMessage(t, accountId, conversationId, "field:x=1");
  await t.action(internal.qualificationEngine.analyzeInbound, {
    accountId, conversationId, contactId,
  });
  let rows = await sessionsFor(t, conversationId);
  expect(rows.length === 0 || rows[0].fields.length === 0).toBe(true);

  // terminal session
  const second = await seed(t);
  await configureAi(second.asUser);
  await t.run(async (ctx) => {
    await ctx.db.insert("qualificationSessions", {
      accountId: second.accountId, conversationId: second.conversationId,
      contactId: second.contactId, status: "expired", origin: "inbound",
      fields: [], expectedCount: 0, answeredCount: 0,
      followUpsSent: 0, phrasingCursor: 0, sendAttemptErrors: 0,
    });
  });
  await seedCustomerMessage(t, second.accountId, second.conversationId, "field:x=1");
  await t.action(internal.qualificationEngine.analyzeInbound, {
    accountId: second.accountId, conversationId: second.conversationId,
    contactId: second.contactId,
  });
  rows = await sessionsFor(t, second.conversationId);
  expect(rows[0].fields).toHaveLength(0);
});

test("getObjectives returns collected + next question for a collecting session, null when dormant", async () => {
  const t = convexTest(schema, modules);
  const { accountId, contactId, conversationId } = await seed(t);
  await t.run(async (ctx) => {
    await ctx.db.insert("qualificationSessions", {
      accountId, conversationId, contactId, status: "collecting", origin: "inbound",
      fields: [
        { key: "destination", label: "Destination", value: "Bali", confidence: "high", updatedAt: 1 },
        { key: "budget", value: "5000", confidence: "low", updatedAt: 1 },
      ],
      expectedCount: 4, answeredCount: 1,
      pendingQuestion: { key: "travel_dates", text: "When are you planning to travel?", alternates: [] },
      followUpsSent: 0, phrasingCursor: 0, sendAttemptErrors: 0,
    });
  });
  const objectives = await t.query(internal.qualificationEngine.getObjectives, {
    accountId, conversationId,
  });
  expect(objectives?.collected).toEqual([{ label: "Destination", value: "Bali" }]);
  expect(objectives?.nextQuestion).toBe("When are you planning to travel?");

  const off = await seed(t, { enabled: false });
  expect(
    await t.query(internal.qualificationEngine.getObjectives, {
      accountId: off.accountId, conversationId: off.conversationId,
    }),
  ).toBeNull();
});

test("getObjectives falls back to the first unanswered required basic field when no pendingQuestion", async () => {
  const t = convexTest(schema, modules);
  const { accountId, contactId, conversationId } = await seed(t);
  await t.run(async (ctx) => {
    await ctx.db.insert("qualificationSessions", {
      accountId, conversationId, contactId, status: "collecting", origin: "inbound",
      fields: [
        { key: "looking_for", value: "Bali package", confidence: "high", updatedAt: 1 },
      ],
      expectedCount: 4, answeredCount: 1,
      followUpsSent: 0, phrasingCursor: 0, sendAttemptErrors: 0,
    });
  });
  const objectives = await t.query(internal.qualificationEngine.getObjectives, {
    accountId, conversationId,
  });
  // looking_for is answered → next required basic field is travel_dates
  expect(objectives?.nextQuestion).toContain("travel");
});

// ---- P2: completion pipeline ----

async function seedAttributed(t: ReturnType<typeof convexTest>) {
  const base = await seed(t);
  await t.run(async (ctx) => {
    await ctx.db.patch(base.conversationId, {
      attribution: { lane: "ctwa", ctwaClid: "clid-123", firstSeenAt: 111 },
    });
  });
  await configureAi(base.asUser);
  return base;
}

function transitionsFor(t: TestConvex<typeof schema>, conversationId: Id<"conversations">) {
  return t.run((ctx) =>
    ctx.db.query("funnelTransitions")
      .withIndex("by_conversation", (q) => q.eq("conversationId", conversationId))
      .collect());
}

test("readiness completes the lead: session qualified, funnel auto-advanced, Meta event seeded, handoff + notification", async () => {
  const t = convexTest(schema, modules);
  const { accountId, contactId, conversationId, userId } = await seedAttributed(t);
  await seedCustomerMessage(t, accountId, conversationId,
    "[[COMPLETE]] score:80 field:a=1;field:b=2;field:c=3");
  await t.action(internal.qualificationEngine.analyzeInbound, {
    accountId, conversationId, contactId,
  });

  const [s] = await sessionsFor(t, conversationId);
  expect(s.status).toBe("qualified");
  expect(s.qualifiedAt).toBeGreaterThan(0);

  const conversation = await t.run((ctx) => ctx.db.get(conversationId));
  expect(conversation?.funnel?.stage).toBe("qualified");
  // v3 change: the assistant KEEPS replying after qualification — only a
  // real human takeover (assign / pause) silences it.
  expect(conversation?.aiAutoreplyDisabled).toBeFalsy();
  expect(conversation?.assignedToUserId).toBeUndefined();
  expect(conversation?.status).toBe("pending");
  expect(conversation?.aiHandoffSummary).toContain("Qualified lead");

  const events = await t.run((ctx) =>
    ctx.db.query("conversionEvents")
      .withIndex("by_event_id", (q) => q.eq("eventId", `${conversationId}:qualified`))
      .collect());
  expect(events).toHaveLength(1);
  expect(events[0].eventName).toBe("QualifiedLead");

  const notifications = await t.run((ctx) =>
    ctx.db.query("notifications")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect());
  expect(notifications.some((n) => n.type === "lead_qualified")).toBe(true);
});

test("completion never downgrades a human-advanced funnel stage and is idempotent", async () => {
  const t = convexTest(schema, modules);
  const { accountId, contactId, conversationId } = await seedAttributed(t);
  await t.run(async (ctx) => {
    await ctx.db.patch(conversationId, {
      funnel: { stage: "price_quoted", stageUpdatedAt: 1 },
    });
  });
  await seedCustomerMessage(t, accountId, conversationId,
    "[[COMPLETE]] score:80 field:a=1;field:b=2;field:c=3");
  await t.action(internal.qualificationEngine.analyzeInbound, {
    accountId, conversationId, contactId,
  });
  await t.action(internal.qualificationEngine.analyzeInbound, {
    accountId, conversationId, contactId,
  }); // second run: terminal session → no-op

  const conversation = await t.run((ctx) => ctx.db.get(conversationId));
  expect(conversation?.funnel?.stage).toBe("price_quoted"); // untouched
  const [s] = await sessionsFor(t, conversationId);
  expect(s.status).toBe("qualified");
  const transitions = await transitionsFor(t, conversationId);
  expect(transitions.filter((tr) => tr.stage === "qualified")).toHaveLength(0);
});

test("sendClosingMessage sends the configured text as a bot message on a qualified session only", async () => {
  const t = convexTest(schema, modules);
  const { accountId, contactId, conversationId } = await seedAttributed(t);
  // not qualified yet → nothing sent
  await t.action(internal.qualificationEngine.sendClosingMessage, { accountId, conversationId });
  let messages = await t.run((ctx) =>
    ctx.db.query("messages")
      .withIndex("by_conversation", (q) => q.eq("conversationId", conversationId))
      .collect());
  expect(messages).toHaveLength(0);

  await t.run(async (ctx) => {
    await ctx.db.insert("qualificationSessions", {
      accountId, conversationId, contactId, status: "qualified", origin: "inbound",
      fields: [], expectedCount: 0, answeredCount: 3, qualifiedAt: 1,
      followUpsSent: 0, phrasingCursor: 0, sendAttemptErrors: 0,
    });
  });
  await t.action(internal.qualificationEngine.sendClosingMessage, { accountId, conversationId });
  messages = await t.run((ctx) =>
    ctx.db.query("messages")
      .withIndex("by_conversation", (q) => q.eq("conversationId", conversationId))
      .collect());
  expect(messages).toHaveLength(1);
  expect(messages[0].senderType).toBe("bot");
  expect(messages[0].contentText).toContain("travel expert");
});

test("sendAdminAlerts creates a silenced internal conversation, sends the alert, and never opens a session on it", async () => {
  const t = convexTest(schema, modules);
  const { accountId, contactId, conversationId, asUser } = await seedAttributed(t);
  await asUser.mutation(api.qualification.updateConfig, {
    patch: { adminAlertEnabled: true, adminAlertPhones: ["+971 55 999 8888"] },
  });
  const sessionId = await t.run((ctx) =>
    ctx.db.insert("qualificationSessions", {
      accountId, conversationId, contactId, status: "qualified", origin: "inbound",
      fields: [{ key: "destination", label: "Destination", value: "Bali", confidence: "high", updatedAt: 1 }],
      expectedCount: 3, answeredCount: 3, score: 82, serviceName: "Packages",
      summary: "Bali family trip", qualifiedAt: 1,
      followUpsSent: 0, phrasingCursor: 0, sendAttemptErrors: 0,
    }));
  await t.action(internal.qualificationEngine.sendAdminAlerts, { accountId, sessionId });

  const adminContact = await t.run((ctx) =>
    ctx.db.query("contacts")
      .withIndex("by_account_phone", (q) =>
        q.eq("accountId", accountId).eq("phoneNormalized", "971559998888"))
      .unique());
  expect(adminContact).toBeTruthy();
  const adminConversation = await t.run((ctx) =>
    ctx.db.query("conversations")
      .withIndex("by_contact", (q) => q.eq("contactId", adminContact!._id))
      .unique());
  expect(adminConversation?.aiAutoreplyDisabled).toBe(true);
  expect(adminContact?.contactCode).toMatch(/^HC-/); // review fix: allocator invariant
  const alertMessages = await t.run((ctx) =>
    ctx.db.query("messages")
      .withIndex("by_conversation", (q) => q.eq("conversationId", adminConversation!._id))
      .collect());
  expect(alertMessages).toHaveLength(1);
  expect(alertMessages[0].contentText).toContain("+971500000001"); // customer phone
  expect(alertMessages[0].contentText).toContain("82");
  // loop guard: the alert send must NOT have opened a qualification session
  expect(await sessionsFor(t, adminConversation!._id)).toHaveLength(0);
});

// ---- P3: follow-up engine ----

async function seedAllHours(t: TestConvex<typeof schema>) {
  const base = await seed(t);
  await t.run(async (ctx) => {
    const config = await ctx.db.query("qualificationConfigs")
      .withIndex("by_account", (q) => q.eq("accountId", base.accountId)).unique();
    // 24/7 window so these tests never depend on the wall clock; the
    // working-hours clamp itself is covered by schedule.test.ts.
    await ctx.db.patch(config!._id, { workStartMinute: 0, workEndMinute: 1440, workDays: [0, 1, 2, 3, 4, 5, 6] });
  });
  await configureAi(base.asUser);
  return base;
}

async function seedDueSession(
  t: ReturnType<typeof convexTest>,
  base: { accountId: Id<"accounts">; contactId: Id<"contacts">; conversationId: Id<"conversations"> },
  overrides: Record<string, unknown> = {},
) {
  return await t.run((ctx) =>
    ctx.db.insert("qualificationSessions", {
      accountId: base.accountId, conversationId: base.conversationId, contactId: base.contactId,
      status: "collecting", origin: "inbound",
      fields: [], expectedCount: 4, answeredCount: 1,
      pendingQuestion: {
        key: "travel_dates",
        text: "When are you planning to travel?",
        alternates: ["Rough month works too — when?"],
      },
      lastCustomerMessageAt: Date.now() - 2 * 3_600_000, // 2h ago: inside 24h
      followUpsSent: 0, phrasingCursor: 0, sendAttemptErrors: 0,
      nextFollowUpAt: Date.now() - 1000,
      ...overrides,
    }),
  );
}

function messagesFor(t: TestConvex<typeof schema>, conversationId: Id<"conversations">) {
  return t.run((ctx) =>
    ctx.db.query("messages")
      .withIndex("by_conversation", (q) => q.eq("conversationId", conversationId))
      .collect());
}

test("onInbound arms the follow-up clock while fields are missing", async () => {
  const t = convexTest(schema, modules);
  const { accountId, contactId, conversationId } = await seedAllHours(t);
  await t.mutation(internal.qualificationEngine.onInbound, {
    accountId, conversationId, contactId, phoneNormalized: "971500000001",
  });
  const [s] = await sessionsFor(t, conversationId);
  expect(s.nextFollowUpAt).toBeGreaterThan(Date.now());
});

test("sendFollowUp inside the 24h window sends the rotating free-form question", async () => {
  const t = convexTest(schema, modules);
  const base = await seedAllHours(t);
  const sessionId = await seedDueSession(t, base);
  await t.action(internal.qualificationEngine.sendFollowUp, { sessionId });
  let msgs = await messagesFor(t, base.conversationId);
  expect(msgs).toHaveLength(1);
  expect(msgs[0].senderType).toBe("bot");
  expect(msgs[0].contentText).toBe("When are you planning to travel?");
  let [s] = await sessionsFor(t, base.conversationId);
  expect(s.followUpsSent).toBe(1);
  expect(s.phrasingCursor).toBe(1);
  expect(s.nextFollowUpAt).toBeGreaterThan(Date.now());

  // force due again → the ALTERNATE phrasing goes out
  await t.run((ctx) => ctx.db.patch(sessionId, { nextFollowUpAt: Date.now() - 1000 }));
  await t.action(internal.qualificationEngine.sendFollowUp, { sessionId });
  msgs = await messagesFor(t, base.conversationId);
  expect(msgs).toHaveLength(2);
  expect(msgs[1].contentText).toBe("Rough month works too — when?");
  [s] = await sessionsFor(t, base.conversationId);
  expect(s.followUpsSent).toBe(2);
});

test("sendFollowUp beyond 24h uses the re-engagement template, or waits for expiry without one", async () => {
  const t = convexTest(schema, modules);
  const base = await seedAllHours(t);
  // Defaults now ship WITH a re-engagement template (the submitted
  // qualification_followup) — clear it to exercise the no-template branch.
  await t.run(async (ctx) => {
    const config = await ctx.db.query("qualificationConfigs")
      .withIndex("by_account", (q) => q.eq("accountId", base.accountId)).unique();
    await ctx.db.patch(config!._id, {
      reengagementTemplateName: undefined,
      reengagementTemplateLanguage: undefined,
    });
  });
  const sessionId = await seedDueSession(t, base, {
    lastCustomerMessageAt: Date.now() - 30 * 3_600_000, // 30h ago: window closed
  });
  await t.action(internal.qualificationEngine.sendFollowUp, { sessionId });
  expect(await messagesFor(t, base.conversationId)).toHaveLength(0);
  let [s] = await sessionsFor(t, base.conversationId);
  expect(s.followUpsSent).toBe(0);
  expect(s.nextFollowUpAt).toBeGreaterThan(Date.now());

  // with a template configured → template message
  await base.asUser.mutation(api.qualification.updateConfig, {
    patch: { reengagementTemplateName: "qualification_followup", reengagementTemplateLanguage: "en" },
  });
  await t.run((ctx) => ctx.db.patch(sessionId, { nextFollowUpAt: Date.now() - 1000 }));
  await t.action(internal.qualificationEngine.sendFollowUp, { sessionId });
  const msgs = await messagesFor(t, base.conversationId);
  expect(msgs).toHaveLength(1);
  expect(msgs[0].contentType).toBe("template");
  expect(msgs[0].templateName).toBe("qualification_followup");
  [s] = await sessionsFor(t, base.conversationId);
  expect(s.followUpsSent).toBe(1);
});

test("sendFollowUp expires a session silent for 72h and yields to humans", async () => {
  const t = convexTest(schema, modules);
  const base = await seedAllHours(t);
  const sessionId = await seedDueSession(t, base, {
    lastCustomerMessageAt: Date.now() - 73 * 3_600_000,
  });
  await t.action(internal.qualificationEngine.sendFollowUp, { sessionId });
  let [s] = await sessionsFor(t, base.conversationId);
  expect(s.status).toBe("expired");
  expect(s.closedReason).toBe("no_response");
  expect(await messagesFor(t, base.conversationId)).toHaveLength(0);

  // human engaged → no send, rescheduled (extraction may still qualify it)
  const second = await seedAllHours(t);
  const humanSession = await seedDueSession(t, second, {
    humanTouchedAt: Date.now() - 1 * 3_600_000, // newer than lastCustomerMessageAt
    lastCustomerMessageAt: Date.now() - 2 * 3_600_000,
  });
  await t.action(internal.qualificationEngine.sendFollowUp, { sessionId: humanSession });
  [s] = await sessionsFor(t, second.conversationId);
  expect(s.status).toBe("collecting");
  expect(s.followUpsSent).toBe(0);
  expect(await messagesFor(t, second.conversationId)).toHaveLength(0);
  expect(s.nextFollowUpAt).toBeGreaterThan(Date.now());
});

test("getDueSessions picks only due collecting sessions", async () => {
  const t = convexTest(schema, modules);
  const base = await seedAllHours(t);
  await seedDueSession(t, base); // due
  const other = await seedAllHours(t);
  await seedDueSession(t, other, { nextFollowUpAt: Date.now() + 3_600_000 }); // future
  const third = await seedAllHours(t);
  await seedDueSession(t, third, { status: "expired", nextFollowUpAt: Date.now() - 500 }); // terminal
  const fourth = await seedAllHours(t);
  await seedDueSession(t, fourth, { nextFollowUpAt: undefined }); // never armed — must NOT leak into the range
  const due = await t.query(internal.qualificationEngine.getDueSessions, {});
  expect(due).toHaveLength(1);
  expect(due[0].conversationId).toBe(base.conversationId);
});

test("sendFollowUp at the nudge cap sends nothing and waits out the expiry clock", async () => {
  const t = convexTest(schema, modules);
  const base = await seedAllHours(t);
  const sessionId = await seedDueSession(t, base, { followUpsSent: 4 }); // cap (default maxFollowUps=4)
  await t.action(internal.qualificationEngine.sendFollowUp, { sessionId });
  const [s] = await sessionsFor(t, base.conversationId);
  expect(s.followUpsSent).toBe(4);
  expect(await messagesFor(t, base.conversationId)).toHaveLength(0);
  expect(s.status).toBe("collecting");
  expect(s.nextFollowUpAt).toBeGreaterThan(Date.now()); // expiry revisit booked
});

// ---- Review fixes (independent review of PR #18) ----

test("REVIEW-1: the analysis path never opens a session on the admin-alert channel", async () => {
  const t = convexTest(schema, modules);
  const base = await seed(t, { enabled: true, adminPhones: ["+971 50 000 0001"] });
  await configureAi(base.asUser);
  await seedCustomerMessage(t, base.accountId, base.conversationId,
    "field:a=1;field:b=2;field:c=3; [[COMPLETE]] score:90");
  await t.action(internal.qualificationEngine.analyzeInbound, {
    accountId: base.accountId, conversationId: base.conversationId, contactId: base.contactId,
  });
  expect(await sessionsFor(t, base.conversationId)).toHaveLength(0);
});

test("REVIEW-2: a customer reply after the nudge cap re-arms toward the expiry revisit", async () => {
  const t = convexTest(schema, modules);
  const base = await seedAllHours(t);
  await seedDueSession(t, base, { followUpsSent: 4, nextFollowUpAt: undefined });
  await t.mutation(internal.qualificationEngine.onInbound, {
    accountId: base.accountId, conversationId: base.conversationId,
    contactId: base.contactId, phoneNormalized: "971500000001",
  });
  const [s] = await sessionsFor(t, base.conversationId);
  // expiry revisit ≈ now + 72h — the sweep can still expire the session
  expect(s.nextFollowUpAt).toBeGreaterThan(Date.now() + 71 * 3_600_000);
});

test("REVIEW-3: outbound sends into a closed conversation open no session", async () => {
  const t = convexTest(schema, modules);
  const { accountId, conversationId } = await seed(t);
  await t.run((ctx) => ctx.db.patch(conversationId, { status: "closed" }));
  await t.mutation(internal.messages.appendInternal, {
    accountId, conversationId, senderType: "bot",
    contentType: "text", contentText: "note into closed thread",
  });
  expect(await sessionsFor(t, conversationId)).toHaveLength(0);
});

test("REVIEW-4: the follow-up slot is claimed before sending — a second claim loses", async () => {
  const t = convexTest(schema, modules);
  const base = await seedAllHours(t);
  const sessionId = await seedDueSession(t, base);
  const first = await t.mutation(internal.qualificationEngine.claimFollowUpSlot, {
    sessionId, nextCursor: 1,
  });
  const second = await t.mutation(internal.qualificationEngine.claimFollowUpSlot, {
    sessionId, nextCursor: 2,
  });
  expect(first).toBe(true);
  expect(second).toBe(false); // slot already claimed — no duplicate send possible
  // and sequential sendFollowUp cannot double-send either
  const other = await seedAllHours(t);
  await seedDueSession(t, other);
  await t.action(internal.qualificationEngine.sendFollowUp, {
    sessionId: (await sessionsFor(t, other.conversationId))[0]._id,
  });
  await t.action(internal.qualificationEngine.sendFollowUp, {
    sessionId: (await sessionsFor(t, other.conversationId))[0]._id,
  });
  expect(await messagesFor(t, other.conversationId)).toHaveLength(1);
});

test("REVIEW-6: updateConfig rejects wrong-typed and invalid values cleanly, and ignores unknown keys", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seed(t);
  await expect(
    asUser.mutation(api.qualification.updateConfig, { patch: { workDays: 5 } }),
  ).rejects.toThrow();
  await expect(
    asUser.mutation(api.qualification.updateConfig, {
      patch: { adminAlertPhones: ["not-a-phone"] },
    }),
  ).rejects.toThrow();
  // unknown keys are stripped, not stored and not a server error
  await asUser.mutation(api.qualification.updateConfig, {
    patch: { enabled: true, bogusKey: 123 },
  });
  const config = await asUser.query(api.qualification.getConfig, {});
  expect(config.enabled).toBe(true);
  expect((config as Record<string, unknown>).bogusKey).toBeUndefined();
});

// ---- v3: ask-admin relay ----

test("V3-B: unknown info → holding reply to customer + question relayed to admin as plain text", async () => {
  vi.useFakeTimers();
  const t = convexTest(schema, modules);
  const base = await seed(t, { enabled: true, adminPhones: ["+971 55 999 8888"] });
  await configureAi(base.asUser);
  await seedCustomerMessage(t, base.accountId, base.conversationId,
    "[[NEEDINFO:Is Georgia visa on arrival for Indian nationals?]]");
  await t.action(internal.aiReply.dispatchInbound, {
    accountId: base.accountId, conversationId: base.conversationId, contactId: base.contactId,
  });
  // The reply now lands via a scheduled `deliverReply` (length-proportional
  // delay) instead of sending inline. Fire ONLY that one pending timer —
  // NOT `vi.runAllTimers()`/`t.finishAllScheduledFunctions()`, which would
  // also execute the `relayQuestionToAdmin` call `deliverReply` itself
  // schedules at delay 0, defeating the "run it directly" check below.
  vi.runOnlyPendingTimers();
  await t.finishInProgressScheduledFunctions();
  // customer got the holding reply
  const customerMsgs = await messagesFor(t, base.conversationId);
  const bot = customerMsgs.filter((m) => m.senderType === "bot");
  expect(bot).toHaveLength(1);
  expect(bot[0].contentText).toContain("check with my team");
  expect(bot[0].contentText).not.toContain("ASK_ADMIN"); // marker stripped
  // inquiry recorded pending (relay action is scheduled; run it directly)
  let inquiries = await t.run((ctx) =>
    ctx.db.query("adminInquiries")
      .withIndex("by_conversation", (q) => q.eq("conversationId", base.conversationId))
      .collect());
  expect(inquiries).toHaveLength(0); // not yet — scheduler didn't run in test
  await t.action(internal.qualificationEngine.relayQuestionToAdmin, {
    accountId: base.accountId, conversationId: base.conversationId,
    contactId: base.contactId, question: "Is Georgia visa on arrival for Indian nationals?",
  });
  inquiries = await t.run((ctx) =>
    ctx.db.query("adminInquiries")
      .withIndex("by_conversation", (q) => q.eq("conversationId", base.conversationId))
      .collect());
  expect(inquiries).toHaveLength(1);
  expect(inquiries[0].status).toBe("pending");
  // the admin conversation got a PLAIN TEXT question (no template)
  const adminContact = await t.run((ctx) =>
    ctx.db.query("contacts")
      .withIndex("by_account_phone", (q) =>
        q.eq("accountId", base.accountId).eq("phoneNormalized", "971559998888"))
      .unique());
  const adminConversation = await t.run((ctx) =>
    ctx.db.query("conversations")
      .withIndex("by_contact", (q) => q.eq("contactId", adminContact!._id))
      .first());
  const adminMsgs = await messagesFor(t, adminConversation!._id);
  expect(adminMsgs).toHaveLength(1);
  expect(adminMsgs[0].contentType).toBe("text");
  expect(adminMsgs[0].contentText).toContain("Georgia visa");
  vi.useRealTimers();
});

test("V3-B: admin reply answers the latest pending inquiry and is relayed to the customer", async () => {
  const t = convexTest(schema, modules);
  const base = await seed(t, { enabled: true, adminPhones: ["+971 55 999 8888"] });
  await configureAi(base.asUser);
  const inquiryId = await t.run((ctx) =>
    ctx.db.insert("adminInquiries", {
      accountId: base.accountId, conversationId: base.conversationId,
      contactId: base.contactId, question: "Is Georgia visa on arrival for Indians?",
      customerName: "Ravi", customerPhone: "+971500000001",
      status: "pending", askedAt: Date.now(),
    }));
  await t.mutation(internal.qualificationEngine.onAdminInbound, {
    accountId: base.accountId, phoneNormalized: "971559998888",
    text: "Yes — visa on arrival, 30 days, roughly 90 AED",
  });
  let inquiry = await t.run((ctx) => ctx.db.get(inquiryId));
  expect(inquiry?.status).toBe("answered");
  expect(inquiry?.answer).toContain("visa on arrival");
  // scheduled relay → run directly in test
  await t.action(internal.qualificationEngine.relayAnswerToCustomer, { inquiryId });
  const customerMsgs = await messagesFor(t, base.conversationId);
  expect(customerMsgs).toHaveLength(1);
  expect(customerMsgs[0].senderType).toBe("bot");
  expect(customerMsgs[0].contentText).toContain("visa on arrival");
  inquiry = await t.run((ctx) => ctx.db.get(inquiryId));
  expect(inquiry?.status).toBe("delivered");
});

test("V3-B: a human-owned thread stops the auto-relay; non-admin numbers never answer inquiries", async () => {
  const t = convexTest(schema, modules);
  const base = await seed(t, { enabled: true, adminPhones: ["+971 55 999 8888"] });
  await configureAi(base.asUser);
  const inquiryId = await t.run(async (ctx) => {
    await ctx.db.patch(base.conversationId, { assignedToUserId: base.userId });
    return await ctx.db.insert("adminInquiries", {
      accountId: base.accountId, conversationId: base.conversationId,
      contactId: base.contactId, question: "Q?",
      customerName: "Ravi", customerPhone: "+971500000001",
      status: "answered", answer: "A", askedAt: 1, answeredAt: Date.now(),
    });
  });
  await t.action(internal.qualificationEngine.relayAnswerToCustomer, { inquiryId });
  expect(await messagesFor(t, base.conversationId)).toHaveLength(0);
  expect((await t.run((ctx) => ctx.db.get(inquiryId)))?.status).toBe("answered");

  // a random customer's message never claims a pending inquiry
  const other = await seed(t, { enabled: true, adminPhones: ["+971 55 999 8888"] });
  await t.run((ctx) =>
    ctx.db.insert("adminInquiries", {
      accountId: other.accountId, conversationId: other.conversationId,
      contactId: other.contactId, question: "Q2?",
      customerName: "X", customerPhone: "+971500000001",
      status: "pending", askedAt: Date.now(),
    }));
  await t.mutation(internal.qualificationEngine.onAdminInbound, {
    accountId: other.accountId, phoneNormalized: "971500000001", text: "not an admin",
  });
  const stillPending = await t.run((ctx) =>
    ctx.db.query("adminInquiries")
      .withIndex("by_account_status", (q) =>
        q.eq("accountId", other.accountId).eq("status", "pending"))
      .collect());
  expect(stillPending).toHaveLength(1);
});

// ---- v3: multiple leads per contact ----

test("V3-C: a new service inquiry after a qualified lead opens a SECOND session with carried profile fields", async () => {
  const t = convexTest(schema, modules);
  const base = await seed(t);
  await configureAi(base.asUser);
  // first lead: qualified, with profile fields worth carrying
  await t.run((ctx) =>
    ctx.db.insert("qualificationSessions", {
      accountId: base.accountId, conversationId: base.conversationId, contactId: base.contactId,
      status: "qualified", origin: "inbound", serviceName: "Dubai Holiday Packages",
      fields: [
        { key: "nationality", label: "Nationality", value: "Indian", confidence: "high", updatedAt: 1 },
        { key: "email", label: "Email", value: "ravi@x.com", confidence: "high", updatedAt: 1 },
        { key: "travel_dates", label: "Travel dates", value: "August", confidence: "high", updatedAt: 1 },
      ],
      expectedCount: 4, answeredCount: 3, score: 80, qualifiedAt: 5,
      followUpsSent: 0, phrasingCursor: 0, sendAttemptErrors: 0,
    }));
  await seedCustomerMessage(t, base.accountId, base.conversationId,
    "[[NEW]] field:destination_country=Georgia; score:30");
  await t.action(internal.qualificationEngine.analyzeInbound, {
    accountId: base.accountId, conversationId: base.conversationId, contactId: base.contactId,
  });
  const sessions = await sessionsFor(t, base.conversationId);
  expect(sessions).toHaveLength(2);
  const fresh = sessions.find((s) => s.status === "collecting")!;
  expect(fresh).toBeTruthy();
  const byKey = Object.fromEntries(fresh.fields.map((f) => [f.key, f]));
  expect(byKey.destination_country.value).toBe("Georgia"); // new extraction
  expect(byKey.nationality.value).toBe("Indian"); // carried over
  expect(byKey.nationality.confidence).toBe("medium"); // verify-not-reask
  expect(byKey.nationality.carried).toBe(true);
  expect(byKey.email.carried).toBe(true);
  expect(byKey.travel_dates).toBeUndefined(); // trip-specific — never carried
  // the chip/board surface the NEW session
  const chip = await base.asUser.query(api.qualification.getSessionForConversation, {
    conversationId: base.conversationId,
  });
  expect(chip?.status).toBe("collecting");
});

test("V3-C: post-qualification chit-chat does NOT open a new lead", async () => {
  const t = convexTest(schema, modules);
  const base = await seed(t);
  await configureAi(base.asUser);
  await t.run((ctx) =>
    ctx.db.insert("qualificationSessions", {
      accountId: base.accountId, conversationId: base.conversationId, contactId: base.contactId,
      status: "qualified", origin: "inbound", serviceName: "Dubai Holiday Packages",
      fields: [], expectedCount: 4, answeredCount: 4, score: 80, qualifiedAt: 5,
      followUpsSent: 0, phrasingCursor: 0, sendAttemptErrors: 0,
    }));
  await seedCustomerMessage(t, base.accountId, base.conversationId, "thanks a lot!");
  await t.action(internal.qualificationEngine.analyzeInbound, {
    accountId: base.accountId, conversationId: base.conversationId, contactId: base.contactId,
  });
  expect(await sessionsFor(t, base.conversationId)).toHaveLength(1);
});

// ---- v4: duplicate-lead bug fixes ----

test("V4-BUG: contact details / greetings after completion NEVER reopen — even if the model claims newInquiry without evidence", async () => {
  const t = convexTest(schema, modules);
  const base = await seed(t);
  await configureAi(base.asUser);
  await t.run((ctx) =>
    ctx.db.insert("qualificationSessions", {
      accountId: base.accountId, conversationId: base.conversationId, contactId: base.contactId,
      status: "qualified", origin: "inbound", serviceName: "UAE visa",
      fields: [], expectedCount: 4, answeredCount: 4, score: 90, qualifiedAt: Date.now(),
      followUpsSent: 0, phrasingCursor: 0, sendAttemptErrors: 0,
    }));
  // [[NEW]] but NO fields → no evidence → blocked
  await seedCustomerMessage(t, base.accountId, base.conversationId, "[[NEW]] hello again");
  await t.action(internal.qualificationEngine.analyzeInbound, {
    accountId: base.accountId, conversationId: base.conversationId, contactId: base.contactId,
  });
  expect(await sessionsFor(t, base.conversationId)).toHaveLength(1);
});

test("V4-BUG: the SAME service cannot reopen within 48h of completing (the Italy-duplicate case)", async () => {
  const t = convexTest(schema, modules);
  const base = await seed(t);
  await configureAi(base.asUser);
  // synthetic analysis always says service "UAE visa" — make the terminal
  // session the SAME service, finished just now
  await t.run((ctx) =>
    ctx.db.insert("qualificationSessions", {
      accountId: base.accountId, conversationId: base.conversationId, contactId: base.contactId,
      status: "qualified", origin: "inbound", serviceName: "UAE visa",
      fields: [], expectedCount: 4, answeredCount: 4, score: 90, qualifiedAt: Date.now(),
      followUpsSent: 0, phrasingCursor: 0, sendAttemptErrors: 0,
    }));
  await seedCustomerMessage(t, base.accountId, base.conversationId,
    "[[NEW]] field:nationality=Indian;field:visa_type=60-day;field:email=x@y.com; [[COMPLETE]] score:95");
  await t.action(internal.qualificationEngine.analyzeInbound, {
    accountId: base.accountId, conversationId: base.conversationId, contactId: base.contactId,
  });
  expect(await sessionsFor(t, base.conversationId)).toHaveLength(1); // no duplicate

  // …but the same service CAN reopen after 48h (months-later re-booking)
  await t.run(async (ctx) => {
    const [s] = await ctx.db.query("qualificationSessions")
      .withIndex("by_conversation", (q) => q.eq("conversationId", base.conversationId))
      .collect();
    await ctx.db.patch(s._id, { qualifiedAt: Date.now() - 49 * 3_600_000 });
  });
  await t.action(internal.qualificationEngine.analyzeInbound, {
    accountId: base.accountId, conversationId: base.conversationId, contactId: base.contactId,
  });
  expect(await sessionsFor(t, base.conversationId)).toHaveLength(2);
});

test("V4-BUG: analysis after completion only sees messages SINCE completion (no re-extraction from history)", async () => {
  const t = convexTest(schema, modules);
  const base = await seed(t);
  await configureAi(base.asUser);
  // history full of qualifying markers from the FINISHED inquiry
  await seedCustomerMessage(t, base.accountId, base.conversationId,
    "[[NEW]] field:destination=Italy;field:travelers=2; [[COMPLETE]] score:95");
  await t.run((ctx) =>
    ctx.db.insert("qualificationSessions", {
      accountId: base.accountId, conversationId: base.conversationId, contactId: base.contactId,
      status: "qualified", origin: "inbound", serviceName: "Packages",
      fields: [], expectedCount: 4, answeredCount: 4, score: 95, qualifiedAt: Date.now() + 1,
      followUpsSent: 0, phrasingCursor: 0, sendAttemptErrors: 0,
    }));
  // the ONLY post-completion message is harmless — the old marker-laden
  // history must NOT leak into the analysis (latest visible = "thanks!")
  await new Promise((r) => setTimeout(r, 5));
  await seedCustomerMessage(t, base.accountId, base.conversationId, "thanks!");
  await t.action(internal.qualificationEngine.analyzeInbound, {
    accountId: base.accountId, conversationId: base.conversationId, contactId: base.contactId,
  });
  expect(await sessionsFor(t, base.conversationId)).toHaveLength(1);
});

test("V4-BUG: the assistant stays silent on the completion turn (closing message is the reply) and keeps the never-re-ask list afterwards", async () => {
  const t = convexTest(schema, modules);
  const base = await seed(t);
  await configureAi(base.asUser);
  await t.run((ctx) =>
    ctx.db.insert("qualificationSessions", {
      accountId: base.accountId, conversationId: base.conversationId, contactId: base.contactId,
      status: "qualified", origin: "inbound", serviceName: "UAE visa",
      fields: [{ key: "email", label: "Email", value: "ravi@x.com", confidence: "high", updatedAt: 1 }],
      expectedCount: 4, answeredCount: 4, score: 90, qualifiedAt: Date.now(),
      followUpsSent: 0, phrasingCursor: 0, sendAttemptErrors: 0,
    }));
  await seedCustomerMessage(t, base.accountId, base.conversationId, "great thanks");
  await t.action(internal.aiReply.dispatchInbound, {
    accountId: base.accountId, conversationId: base.conversationId, contactId: base.contactId,
  });
  // fresh completion (< 90s) → no extra assistant reply
  expect((await messagesFor(t, base.conversationId)).filter((m) => m.senderType === "bot")).toHaveLength(1 - 1);

  // after the suppression window, objectives STILL list collected fields
  await t.run(async (ctx) => {
    const [s] = await ctx.db.query("qualificationSessions")
      .withIndex("by_conversation", (q) => q.eq("conversationId", base.conversationId))
      .collect();
    await ctx.db.patch(s._id, { qualifiedAt: Date.now() - 10 * 60_000 });
  });
  const objectives = await t.query(internal.qualificationEngine.getObjectives, {
    accountId: base.accountId, conversationId: base.conversationId,
  });
  expect(objectives?.collected).toEqual([{ label: "Email", value: "ravi@x.com" }]);
  expect(objectives?.nextQuestion).toBeNull();
});

// ---- v4: mandatory auto-tag + cleanup ----

test("V4: qualification auto-tags the contact with the service; a second lead stacks a second tag", async () => {
  const t = convexTest(schema, modules);
  const base = await seedAttributed(t);
  await seedCustomerMessage(t, base.accountId, base.conversationId,
    "[[COMPLETE]] score:80 field:a=1;field:b=2;field:c=3");
  await t.action(internal.qualificationEngine.analyzeInbound, {
    accountId: base.accountId, conversationId: base.conversationId, contactId: base.contactId,
  });
  let links = await t.run(async (ctx) => {
    const rows = await ctx.db.query("contactTags")
      .withIndex("by_contact", (q) => q.eq("contactId", base.contactId)).collect();
    return await Promise.all(rows.map(async (r) => ({
      source: r.source, name: (await ctx.db.get(r.tagId))?.name,
    })));
  });
  expect(links).toHaveLength(1);
  expect(links[0].name).toBe("UAE visa"); // synthetic service
  expect(links[0].source).toBe("ai");

  // second lead for a DIFFERENT service → a second tag stacks
  await t.run(async (ctx) => {
    await ctx.db.insert("qualificationSessions", {
      accountId: base.accountId, conversationId: base.conversationId, contactId: base.contactId,
      status: "collecting", origin: "inbound", serviceName: "Italy package",
      fields: [], expectedCount: 4, answeredCount: 3,
      checklistSatisfiedAt: Date.now(), lastCustomerMessageAt: Date.now(),
      followUpsSent: 0, phrasingCursor: 0, sendAttemptErrors: 0,
    });
  });
  await t.mutation(internal.qualificationEngine.completeQualification, {
    accountId: base.accountId, conversationId: base.conversationId,
  });
  links = await t.run(async (ctx) => {
    const rows = await ctx.db.query("contactTags")
      .withIndex("by_contact", (q) => q.eq("contactId", base.contactId)).collect();
    return await Promise.all(rows.map(async (r) => ({
      source: r.source, name: (await ctx.db.get(r.tagId))?.name,
    })));
  });
  expect(links.map((l) => l.name).sort()).toEqual(["Italy package", "UAE visa"]);
});

test("V4: cleanupDuplicateLeads retires same-service qualified duplicates within 48h, keeps distinct services", async () => {
  const t = convexTest(schema, modules);
  const base = await seed(t);
  const mk = (serviceName: string, qualifiedAt: number) =>
    t.run((ctx) =>
      ctx.db.insert("qualificationSessions", {
        accountId: base.accountId, conversationId: base.conversationId, contactId: base.contactId,
        status: "qualified", origin: "inbound", serviceName,
        fields: [], expectedCount: 4, answeredCount: 4, score: 90, qualifiedAt,
        followUpsSent: 0, phrasingCursor: 0, sendAttemptErrors: 0,
      }));
  const now = Date.now();
  await mk("Italy package", now - 3_600_000);      // keep (first)
  await mk("Italy package", now - 3_000_000);      // duplicate
  await mk("Italy package", now - 2_000_000);      // duplicate
  await mk("UAE visa", now - 1_000_000);           // distinct service — keep
  const { removed } = await t.mutation(internal.qualificationEngine.cleanupDuplicateLeads, {
    accountId: base.accountId,
  });
  expect(removed).toBe(2);
  const sessions = await sessionsFor(t, base.conversationId);
  expect(sessions.filter((s) => s.status === "qualified")).toHaveLength(2);
  expect(sessions.filter((s) => s.closedReason === "duplicate")).toHaveLength(2);
});

// ---- P6: staff channel generalization + contact card ----

test("P6: a MEMBER's own number is staff — no sessions open on it (inbound or outbound)", async () => {
  const t = convexTest(schema, modules);
  const base = await seed(t); // contact phone +971500000001
  await t.run(async (ctx) => {
    // make the seeded contact's number a MEMBER phone (agent's own)
    const uid = await ctx.db.insert("users", { name: "Agent P", email: "ap@example.com" });
    await ctx.db.insert("memberships", {
      userId: uid, accountId: base.accountId, role: "agent",
      fullName: "Agent P", email: "ap@example.com", phone: "+971 50 000 0001",
    });
  });
  await t.mutation(internal.qualificationEngine.onInbound, {
    accountId: base.accountId, conversationId: base.conversationId,
    contactId: base.contactId, phoneNormalized: "971500000001",
  });
  expect(await sessionsFor(t, base.conversationId)).toHaveLength(0);
  await t.mutation(internal.messages.appendInternal, {
    accountId: base.accountId, conversationId: base.conversationId,
    senderType: "bot", contentType: "text", contentText: "offer msg",
  });
  expect(await sessionsFor(t, base.conversationId)).toHaveLength(0);
});

test("P6: sendContactCard persists a readable card row (dry-run)", async () => {
  const t = convexTest(schema, modules);
  const base = await seed(t);
  await t.action(internal.metaSend.sendContactCard, {
    accountId: base.accountId, conversationId: base.conversationId,
    to: "+971500000001", cardName: "Agent P", cardPhone: "+971 55 123 4567",
  });
  const msgs = await messagesFor(t, base.conversationId);
  expect(msgs).toHaveLength(1);
  expect(msgs[0].senderType).toBe("bot");
  expect(msgs[0].contentText).toContain("Agent P");
  expect(msgs[0].contentText).toContain("+971 55 123 4567");
});

// ---- P6: consent-based lead offers ----

async function seedAgentWithTag(
  t: TestConvex<typeof schema>,
  accountId: Id<"accounts">,
  opts: { name: string; phone: string; tagName: string },
) {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { name: opts.name, email: `${opts.name}@example.com` });
    await ctx.db.insert("memberships", {
      userId, accountId, role: "agent", fullName: opts.name,
      email: `${opts.name}@example.com`, phone: opts.phone,
    });
    const tags = await ctx.db.query("tags")
      .withIndex("by_account", (q) => q.eq("accountId", accountId)).collect();
    let tag = tags.find((x) => x.name === opts.tagName);
    if (!tag) {
      const tagId = await ctx.db.insert("tags", { accountId, name: opts.tagName, color: "#0ea5e9" });
      tag = (await ctx.db.get(tagId))!;
    }
    await ctx.db.insert("memberTags", { accountId, userId, tagId: tag._id });
    return { userId };
  });
}

async function offersFor(t: TestConvex<typeof schema>, sessionId: Id<"qualificationSessions">) {
  return t.run((ctx) =>
    ctx.db.query("leadOffers")
      .withIndex("by_session", (q) => q.eq("sessionId", sessionId)).collect());
}

test("P6: qualification offers the lead to a matching agent; YES assigns, announces and sends the contact card", async () => {
  const t = convexTest(schema, modules);
  const base = await seedAttributed(t);
  const agent = await seedAgentWithTag(t, base.accountId, {
    name: "Sara", phone: "+971 55 700 8899", tagName: "UAE visa",
  });
  await seedCustomerMessage(t, base.accountId, base.conversationId,
    "[[COMPLETE]] score:85 field:a=1;field:b=2;field:c=3");
  await t.action(internal.qualificationEngine.analyzeInbound, {
    accountId: base.accountId, conversationId: base.conversationId, contactId: base.contactId,
  });
  const [session] = (await sessionsFor(t, base.conversationId)).filter((s) => s.status === "qualified");
  // scheduler doesn't auto-run — drive the offer directly
  await t.action(internal.qualificationEngine.startLeadOffer, {
    accountId: base.accountId, sessionId: session._id,
  });
  let offers = await offersFor(t, session._id);
  expect(offers).toHaveLength(1);
  expect(offers[0].status).toBe("offered");
  expect(offers[0].agentUserId).toBe(agent.userId);

  // the agent's staff chat received the YES/NO offer
  const staffContact = await t.run((ctx) =>
    ctx.db.query("contacts").withIndex("by_account_phone", (q) =>
      q.eq("accountId", base.accountId).eq("phoneNormalized", "971557008899")).unique());
  const staffConversation = await t.run((ctx) =>
    ctx.db.query("conversations").withIndex("by_contact", (q) =>
      q.eq("contactId", staffContact!._id)).first());
  const staffMsgs = await messagesFor(t, staffConversation!._id);
  expect(staffMsgs.some((m) => m.contentText?.includes("Reply YES"))).toBe(true);

  // the agent replies YES
  await t.mutation(internal.qualificationEngine.onAdminInbound, {
    accountId: base.accountId, phoneNormalized: "971557008899", text: "yes",
  });
  offers = await offersFor(t, session._id);
  expect(offers[0].status).toBe("accepted");
  const conversation = await t.run((ctx) => ctx.db.get(base.conversationId));
  expect(conversation?.assignedToUserId).toBe(agent.userId);

  // announcement (scheduled) — run directly: customer gets the intro + card
  await t.action(internal.qualificationEngine.announceAssignment, { offerId: offers[0]._id });
  const customerMsgs = await messagesFor(t, base.conversationId);
  const bots = customerMsgs.filter((m) => m.senderType === "bot");
  expect(bots.some((m) => m.contentText?.includes("Sara"))).toBe(true);
  expect(bots.some((m) => m.contentText?.includes("📇"))).toBe(true);
});

test("P6: NO passes the lead to the next agent (fewest recent accepts first); timeout sweep does the same", async () => {
  const t = convexTest(schema, modules);
  const base = await seedAttributed(t);
  const a1 = await seedAgentWithTag(t, base.accountId, { name: "A1", phone: "+971551110001", tagName: "UAE visa" });
  const a2 = await seedAgentWithTag(t, base.accountId, { name: "A2", phone: "+971551110002", tagName: "UAE visa" });
  // a1 has a recent accept → a2 should be offered FIRST
  await t.run(async (ctx) => {
    const contactId = await ctx.db.insert("contacts", {
      accountId: base.accountId, phone: "+971509999990", phoneNormalized: "971509999990",
    });
    const conversationId = await ctx.db.insert("conversations", {
      accountId: base.accountId, contactId, status: "open", unreadCount: 0,
    });
    const sessionId = await ctx.db.insert("qualificationSessions", {
      accountId: base.accountId, conversationId, contactId,
      status: "qualified", origin: "inbound", serviceName: "UAE visa",
      fields: [], expectedCount: 4, answeredCount: 4, qualifiedAt: 1,
      followUpsSent: 0, phrasingCursor: 0, sendAttemptErrors: 0,
    });
    await ctx.db.insert("leadOffers", {
      accountId: base.accountId, sessionId, conversationId, contactId,
      agentUserId: a1.userId, agentPhone: "+971551110001",
      status: "accepted", offeredAt: Date.now() - 1000, respondedAt: Date.now() - 500,
    });
  });
  const sessionId = await t.run((ctx) =>
    ctx.db.insert("qualificationSessions", {
      accountId: base.accountId, conversationId: base.conversationId, contactId: base.contactId,
      status: "qualified", origin: "inbound", serviceName: "UAE visa",
      fields: [], expectedCount: 4, answeredCount: 4, score: 80, qualifiedAt: Date.now(),
      followUpsSent: 0, phrasingCursor: 0, sendAttemptErrors: 0,
    }));
  await t.action(internal.qualificationEngine.startLeadOffer, {
    accountId: base.accountId, sessionId,
  });
  let offers = await offersFor(t, sessionId);
  expect(offers).toHaveLength(1);
  expect(offers[0].agentUserId).toBe(a2.userId); // fewest recent accepts

  // a2 declines → a1 gets the offer next
  await t.mutation(internal.qualificationEngine.onAdminInbound, {
    accountId: base.accountId, phoneNormalized: "971551110002", text: "no",
  });
  await t.action(internal.qualificationEngine.startLeadOffer, {
    accountId: base.accountId, sessionId,
  });
  offers = await offersFor(t, sessionId);
  expect(offers).toHaveLength(2);
  const second = offers.find((o) => o.status === "offered")!;
  expect(second.agentUserId).toBe(a1.userId);

  // timeout sweep expires it (force the clock) and there's nobody left
  await t.run((ctx) => ctx.db.patch(second._id, { offeredAt: Date.now() - 11 * 60_000 }));
  await t.action(internal.qualificationEngine.sweepLeadOffers, {});
  offers = await offersFor(t, sessionId);
  expect(offers.find((o) => o._id === second._id)?.status).toBe("timed_out");
});

test("P6: agent feedback on an accepted lead lands as a contact note and resets the reminder clock", async () => {
  const t = convexTest(schema, modules);
  const base = await seedAttributed(t);
  const agent = await seedAgentWithTag(t, base.accountId, {
    name: "Sara", phone: "+971551110003", tagName: "UAE visa",
  });
  const sessionId = await t.run((ctx) =>
    ctx.db.insert("qualificationSessions", {
      accountId: base.accountId, conversationId: base.conversationId, contactId: base.contactId,
      status: "qualified", origin: "inbound", serviceName: "UAE visa",
      fields: [], expectedCount: 4, answeredCount: 4, qualifiedAt: 1,
      followUpsSent: 0, phrasingCursor: 0, sendAttemptErrors: 0,
    }));
  const offerId = await t.run((ctx) =>
    ctx.db.insert("leadOffers", {
      accountId: base.accountId, sessionId, conversationId: base.conversationId,
      contactId: base.contactId, agentUserId: agent.userId, agentPhone: "+971551110003",
      status: "accepted", offeredAt: Date.now() - 5000, respondedAt: Date.now() - 4000,
    }));
  await t.mutation(internal.qualificationEngine.onAdminInbound, {
    accountId: base.accountId, phoneNormalized: "971551110003",
    text: "Spoke to the customer, sending the quote tomorrow morning",
  });
  const offer = await t.run((ctx) => ctx.db.get(offerId));
  expect(offer?.feedback).toContain("quote tomorrow");
  const notes = await t.run((ctx) =>
    ctx.db.query("contactNotes")
      .withIndex("by_contact", (q) => q.eq("contactId", base.contactId)).collect());
  expect(notes).toHaveLength(1);
  expect(notes[0].noteText).toContain("Sara");
});

// ---- P6: staff loops (reminders + keepalive) ----

test("P6: a silent assigned lead gets a reminder after 4 working-hours; the second quiet-day escalates to supervisors", async () => {
  const t = convexTest(schema, modules);
  const base = await seedAllHours(t); // 24/7 hours so the test never skips
  const agent = await seedAgentWithTag(t, base.accountId, {
    name: "Sara", phone: "+971551110004", tagName: "UAE visa",
  });
  const sessionId = await t.run(async (ctx) => {
    await ctx.db.patch(base.conversationId, { assignedToUserId: agent.userId });
    return await ctx.db.insert("qualificationSessions", {
      accountId: base.accountId, conversationId: base.conversationId, contactId: base.contactId,
      status: "qualified", origin: "inbound", serviceName: "UAE visa",
      fields: [], expectedCount: 4, answeredCount: 4, qualifiedAt: 1,
      followUpsSent: 0, phrasingCursor: 0, sendAttemptErrors: 0,
    });
  });
  const offerId = await t.run((ctx) =>
    ctx.db.insert("leadOffers", {
      accountId: base.accountId, sessionId, conversationId: base.conversationId,
      contactId: base.contactId, agentUserId: agent.userId, agentPhone: "+971551110004",
      status: "accepted", offeredAt: Date.now() - 50 * 3_600_000,
      respondedAt: Date.now() - 49 * 3_600_000, // quiet for 49h → escalation due
    }));
  await t.action(internal.qualificationEngine.runStaffLoops, {});
  const offer = await t.run((ctx) => ctx.db.get(offerId));
  expect(offer?.remindersSent).toBe(1);
  expect(offer?.escalatedAt).toBeGreaterThan(0);
  // supervisor pool (the seeded admin) got the escalation bell
  const bells = await t.run((ctx) =>
    ctx.db.query("notifications")
      .withIndex("by_user", (q) => q.eq("userId", base.userId)).collect());
  expect(bells.some((n) => n.title.includes("needs attention"))).toBe(true);
  // the agent got the WhatsApp reminder
  const staffContact = await t.run((ctx) =>
    ctx.db.query("contacts").withIndex("by_account_phone", (q) =>
      q.eq("accountId", base.accountId).eq("phoneNormalized", "971551110004")).unique());
  const staffConversation = await t.run((ctx) =>
    ctx.db.query("conversations").withIndex("by_contact", (q) =>
      q.eq("contactId", staffContact!._id)).first());
  const msgs = await messagesFor(t, staffConversation!._id);
  expect(msgs.some((m) => m.contentText?.includes("Quick reminder"))).toBe(true);

  // running again immediately does NOT double-remind (daily repeat)
  await t.action(internal.qualificationEngine.runStaffLoops, {});
  expect((await t.run((ctx) => ctx.db.get(offerId)))?.remindersSent).toBe(1);
});

test("P6: staff keepalive — closed window gets the template, and never twice in 20h", async () => {
  const t = convexTest(schema, modules);
  const base = await seedAllHours(t);
  await seedAgentWithTag(t, base.accountId, {
    name: "Sara", phone: "+971551110005", tagName: "UAE visa",
  });
  // no prior inbound from Sara at all → window closed → template path
  await t.action(internal.qualificationEngine.runStaffLoops, {});
  const staffContact = await t.run((ctx) =>
    ctx.db.query("contacts").withIndex("by_account_phone", (q) =>
      q.eq("accountId", base.accountId).eq("phoneNormalized", "971551110005")).unique());
  const staffConversation = await t.run((ctx) =>
    ctx.db.query("conversations").withIndex("by_contact", (q) =>
      q.eq("contactId", staffContact!._id)).first());
  let msgs = await messagesFor(t, staffConversation!._id);
  expect(msgs).toHaveLength(1);
  expect(msgs[0].contentType).toBe("template");
  expect(msgs[0].templateName).toBe("staff_checkin");

  // second run within 20h → no repeat
  await t.action(internal.qualificationEngine.runStaffLoops, {});
  msgs = await messagesFor(t, staffConversation!._id);
  expect(msgs).toHaveLength(1);
});

// ---- sales checklist hook ----

test("completing qualification posts the sales checklist on the lead", async () => {
  vi.useFakeTimers();
  try {
    const t = convexTest(schema, modules);
    const base = await seed(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("qualificationSessions", {
        accountId: base.accountId, conversationId: base.conversationId, contactId: base.contactId,
        status: "collecting", origin: "inbound", serviceName: "Bali package",
        fields: [], expectedCount: 4, answeredCount: 4,
        checklistSatisfiedAt: Date.now(), lastCustomerMessageAt: Date.now(),
        followUpsSent: 0, phrasingCursor: 0, sendAttemptErrors: 0,
      });
    });

    await t.mutation(internal.qualificationEngine.completeQualification, {
      accountId: base.accountId, conversationId: base.conversationId,
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const session = await t.run((ctx) =>
      ctx.db.query("qualificationSessions")
        .withIndex("by_conversation", (q) => q.eq("conversationId", base.conversationId))
        .order("desc").first());
    expect(session!.status).toBe("qualified");

    const checklist = await t.run((ctx) =>
      ctx.db.query("salesChecklists")
        .withIndex("by_session", (q) => q.eq("sessionId", session!._id))
        .unique());
    expect(checklist).not.toBeNull();
    expect(checklist!.source).toBe("default"); // no AI config in this seed
    expect(checklist!.items.length).toBeGreaterThanOrEqual(6);
    expect(checklist!.items.every((i) => !i.done)).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});

// ============================================================
// staffCheckinsDue — last-inbound derived from the newest CUSTOMER
// message (read-bound via by_conversation_sender)
// ============================================================

test("staffCheckinsDue keys a staff member's last inbound off their newest CUSTOMER message, ignoring newer outbound noise", async () => {
  // The seeded contact's own phone doubles as the configured staff number,
  // so `staffCheckinsDue` walks THIS conversation. A stale (>20h) customer
  // message with fresh bot chatter on top must still read as "stale" — the
  // lookup ranges the customer partition, so a newer bot message can't make
  // the member look freshly-active and silently drop their check-in. (If
  // the scan picked the newest message of ANY type, `now - lastInbound` <
  // CHECKIN_EVERY_MS would exclude this member and the assertion fails.)
  const t = convexTest(schema, modules);
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const NOW = Date.parse("2026-07-09T12:00:00.000Z");
    const OLD = NOW - 30 * 3_600_000; // 30h ago — older than CHECKIN_EVERY_MS (20h)

    vi.setSystemTime(OLD);
    const { accountId, conversationId } = await seed(t, {
      enabled: true,
      adminPhones: ["+971500000001"],
    });
    await t.run((ctx) =>
      ctx.db.insert("messages", {
        accountId,
        conversationId,
        senderType: "customer",
        contentType: "text",
        contentText: "hello (30h ago)",
        status: "sent",
      }),
    );

    // Newer bot message right now — must NOT be treated as the last inbound.
    vi.setSystemTime(NOW);
    await t.run((ctx) =>
      ctx.db.insert("messages", {
        accountId,
        conversationId,
        senderType: "bot",
        contentType: "text",
        contentText: "auto-nudge (just now)",
        status: "sent",
      }),
    );

    const due = await t.query(
      internal.qualificationEngine.staffCheckinsDue,
      {},
    );
    const entry = due.find((d) => d.phoneNormalized === "971500000001");
    expect(entry).toBeDefined();
    // 30h since the last CUSTOMER inbound → outside the 24h WhatsApp window.
    expect(entry!.windowOpen).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});

// ============================================================
// staffLoopsDue — newest-first take so fresh acceptances aren't starved
// ============================================================

test("staffLoopsDue reaches a freshly accepted offer instead of starving it behind 200 older ones", async () => {
  // `accepted` is terminal and only accumulates. An UNORDERED `.take(200)`
  // returns the OLDEST 200 by `offeredAt`, so once >200 exist the newest
  // acceptance — the one whose feedback loop actually needs nudging — never
  // enters the sweep. Newest-first keeps it reachable. Every offer here is
  // firing-eligible, so on the pre-fix ordering the newest is simply absent.
  const t = convexTest(schema, modules);
  const now = Date.parse("2026-07-08T10:00:00.000Z");
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    vi.setSystemTime(now);
    const ctxIds = await t.run(async (ctx) => {
      const agentUserId = await ctx.db.insert("users", {
        name: "Agent",
        email: "agent@example.com",
      });
      const accountId = await ctx.db.insert("accounts", {
        name: "A",
        defaultCurrency: "AED",
        ownerUserId: agentUserId,
      });
      await ctx.db.insert("memberships", {
        userId: agentUserId,
        accountId,
        role: "admin",
        fullName: "Agent",
        email: "agent@example.com",
      });
      await ctx.db.insert("qualificationConfigs", {
        accountId,
        ...holidayysDefaultConfig(),
        enabled: true,
        adminAlertPhones: [],
        // 24/7 so the working-hours guard never skips this fixture.
        workDays: [0, 1, 2, 3, 4, 5, 6],
        workStartMinute: 0,
        workEndMinute: 1440,
      });
      const contactId = await ctx.db.insert("contacts", {
        accountId,
        phone: "+971500000001",
        phoneNormalized: "971500000001",
        name: "Cara",
      });
      const conversationId = await ctx.db.insert("conversations", {
        accountId,
        contactId,
        status: "open",
        unreadCount: 0,
        assignedToUserId: agentUserId,
      });
      const sessionId = await ctx.db.insert("qualificationSessions", {
        accountId,
        conversationId,
        contactId,
        status: "qualified",
        origin: "inbound",
        serviceName: "UAE visa",
        fields: [],
        expectedCount: 4,
        answeredCount: 4,
        qualifiedAt: 1,
        followUpsSent: 0,
        phrasingCursor: 0,
        sendAttemptErrors: 0,
      });
      return { accountId, agentUserId, conversationId, contactId, sessionId };
    });

    // respondedAt older than REMINDER_FIRST_MS (4h) and no prior reminder/
    // feedback → every offer is due for its first reminder.
    const respondedAt = now - 5 * 3_600_000;
    const targetOfferId = await t.run(async (ctx) => {
      for (let i = 0; i < 200; i++) {
        await ctx.db.insert("leadOffers", {
          accountId: ctxIds.accountId,
          sessionId: ctxIds.sessionId,
          conversationId: ctxIds.conversationId,
          contactId: ctxIds.contactId,
          agentUserId: ctxIds.agentUserId,
          agentPhone: "+971551110001",
          status: "accepted",
          offeredAt: now - 10 * 3_600_000 + i, // all older than the target
          respondedAt,
        });
      }
      // Newest acceptance — the 201st, so an oldest-200 take never sees it.
      return await ctx.db.insert("leadOffers", {
        accountId: ctxIds.accountId,
        sessionId: ctxIds.sessionId,
        conversationId: ctxIds.conversationId,
        contactId: ctxIds.contactId,
        agentUserId: ctxIds.agentUserId,
        agentPhone: "+971551110001",
        status: "accepted",
        offeredAt: now,
        respondedAt,
      });
    });

    const reminders = await t.query(
      internal.qualificationEngine.staffLoopsDue,
      {},
    );
    expect(reminders.some((r) => r.offerId === targetOfferId)).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});

// ============================================================
// PURCHASE SIGNALS (spec 2026-07-19-purchase-signals) — the proxy Meta
// Purchase judge that runs only on already-qualified sessions.
// ============================================================

async function enablePurchaseSignals(
  t: TestConvex<typeof schema>,
  accountId: Id<"accounts">,
) {
  await t.run(async (ctx) => {
    const config = await ctx.db
      .query("qualificationConfigs")
      .withIndex("by_account", (q) => q.eq("accountId", accountId))
      .unique();
    if (config) await ctx.db.patch(config._id, { purchaseSignalsEnabled: true });
  });
}

/** Drives a session to `qualified` through the normal analysis path,
 *  drains completion's scheduled fan-out (incl. the automatic first
 *  purchase evaluation) so tests aren't raced by it, and clears the
 *  eval debounce so the test's own evaluations run deterministically. */
async function qualifySession(
  t: TestConvex<typeof schema>,
  base: { accountId: Id<"accounts">; conversationId: Id<"conversations">; contactId: Id<"contacts"> },
) {
  // Fake timers must be active BEFORE completion schedules its fan-out:
  // a `runAfter(0)` created under real timers is a real setTimeout that
  // `vi.runAllTimers` cannot drain — the stray automatic first purchase
  // evaluation would then race the test's own evaluations and re-arm
  // the debounce mid-assertion (observed flake).
  const hadFakeTimers = vi.isFakeTimers();
  if (!hadFakeTimers) vi.useFakeTimers();
  try {
    await seedCustomerMessage(t, base.accountId, base.conversationId,
      "[[COMPLETE]] score:80 field:a=1;field:b=2;field:c=3");
    await t.action(internal.qualificationEngine.analyzeInbound, {
      accountId: base.accountId,
      conversationId: base.conversationId,
      contactId: base.contactId,
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
  } finally {
    if (!hadFakeTimers) vi.useRealTimers();
  }
  await clearPurchaseDebounce(t, base.conversationId);
}

/** Clears the eval debounce so a follow-up evaluatePurchase isn't skipped. */
async function clearPurchaseDebounce(
  t: TestConvex<typeof schema>,
  conversationId: Id<"conversations">,
) {
  await t.run(async (ctx) => {
    const session = await ctx.db
      .query("qualificationSessions")
      .withIndex("by_conversation", (q) => q.eq("conversationId", conversationId))
      .order("desc")
      .first();
    if (session?.purchase) {
      await ctx.db.patch(session._id, {
        purchase: { ...session.purchase, evaluatedAt: Date.now() - 60_000 },
      });
    }
  });
}

function purchasedEventsFor(
  t: TestConvex<typeof schema>,
  conversationId: Id<"conversations">,
) {
  return t.run((ctx) =>
    ctx.db.query("conversionEvents")
      .withIndex("by_event_id", (q) => q.eq("eventId", `${conversationId}:purchased`))
      .collect());
}

/** Ticks off the auto-generated sales checklist so the agent's real
 *  `setStage("purchased")` passes the deal-discipline gate. */
async function completeSalesChecklist(
  t: TestConvex<typeof schema>,
  conversationId: Id<"conversations">,
) {
  await t.run(async (ctx) => {
    const session = await ctx.db
      .query("qualificationSessions")
      .withIndex("by_conversation", (q) => q.eq("conversationId", conversationId))
      .order("desc")
      .first();
    if (!session) return;
    const checklist = await ctx.db
      .query("salesChecklists")
      .withIndex("by_session", (q) => q.eq("sessionId", session._id))
      .unique();
    if (!checklist) return;
    await ctx.db.patch(checklist._id, {
      items: checklist.items.map((item) => ({
        ...item,
        done: true,
        doneAt: Date.now(),
        note: item.note ?? "done",
      })),
    });
  });
}

test("PS: criteria met fires the proxy Purchase — outbox row + session stamp + notification, funnel stage UNTOUCHED", async () => {
  const t = convexTest(schema, modules);
  const base = await seedAttributed(t);
  await enablePurchaseSignals(t, base.accountId);
  await qualifySession(t, base);

  await seedCustomerMessage(t, base.accountId, base.conversationId,
    "Budget is fine [[PURCHASE]] pvalue:9000; pcurrency:AED;");
  await t.action(internal.qualificationEngine.evaluatePurchase, {
    accountId: base.accountId, conversationId: base.conversationId,
  });

  const events = await purchasedEventsFor(t, base.conversationId);
  expect(events).toHaveLength(1);
  expect(events[0].eventName).toBe("Purchase");
  expect(events[0].lane).toBe("ctwa");
  expect(events[0].identifier).toBe("clid-123");
  expect(events[0].value).toBe(9000);
  expect(events[0].currency).toBe("AED");
  expect(events[0].status).toBe("pending");

  const [s] = await sessionsFor(t, base.conversationId);
  expect(s.purchase?.status).toBe("sent");
  expect(s.purchase?.conversionEventId).toBe(events[0]._id);
  expect(s.purchase?.value).toBe(9000);
  expect(s.purchase?.manual).toBeFalsy();

  // Operational funnel untouched: still at the auto-advanced "qualified",
  // and NO purchased transition was logged.
  const conversation = await t.run((ctx) => ctx.db.get(base.conversationId));
  expect(conversation?.funnel?.stage).toBe("qualified");
  const transitions = await transitionsFor(t, base.conversationId);
  expect(transitions.filter((tr) => tr.stage === "purchased")).toHaveLength(0);

  const notifications = await t.run((ctx) =>
    ctx.db.query("notifications")
      .withIndex("by_user", (q) => q.eq("userId", base.userId))
      .collect());
  expect(notifications.some((n) => n.type === "purchase_signal")).toBe(true);
});

test("PS: not-met stamps the verdict without firing; a later inbound re-evaluates and can fire", async () => {
  const t = convexTest(schema, modules);
  const base = await seedAttributed(t);
  await enablePurchaseSignals(t, base.accountId);
  await qualifySession(t, base);

  await seedCustomerMessage(t, base.accountId, base.conversationId, "thinking about it");
  await t.action(internal.qualificationEngine.evaluatePurchase, {
    accountId: base.accountId, conversationId: base.conversationId,
  });
  let [s] = await sessionsFor(t, base.conversationId);
  expect(s.purchase?.status).toBe("not_met");
  expect(await purchasedEventsFor(t, base.conversationId)).toHaveLength(0);

  await clearPurchaseDebounce(t, base.conversationId);
  await seedCustomerMessage(t, base.accountId, base.conversationId,
    "ok budget confirmed [[PURCHASE]]");
  await t.action(internal.qualificationEngine.evaluatePurchase, {
    accountId: base.accountId, conversationId: base.conversationId,
  });
  [s] = await sessionsFor(t, base.conversationId);
  expect(s.purchase?.status).toBe("sent");
  expect(await purchasedEventsFor(t, base.conversationId)).toHaveLength(1);
});

test("PS: proxy-then-agent — the later real sale links the SAME outbox row, no second event", async () => {
  const t = convexTest(schema, modules);
  const base = await seedAttributed(t);
  await enablePurchaseSignals(t, base.accountId);
  await qualifySession(t, base);
  await seedCustomerMessage(t, base.accountId, base.conversationId, "[[PURCHASE]] pvalue:9000;");
  await t.action(internal.qualificationEngine.evaluatePurchase, {
    accountId: base.accountId, conversationId: base.conversationId,
  });
  const [proxyEvent] = await purchasedEventsFor(t, base.conversationId);

  await completeSalesChecklist(t, base.conversationId);
  await base.asUser.mutation(api.funnel.setStage, {
    conversationId: base.conversationId,
    stage: "purchased",
    saleValue: 12_000,
    saleCurrency: "AED",
  });

  const events = await purchasedEventsFor(t, base.conversationId);
  expect(events).toHaveLength(1); // still just the proxy row
  expect(events[0]._id).toBe(proxyEvent._id);
  const conversation = await t.run((ctx) => ctx.db.get(base.conversationId));
  expect(conversation?.funnel?.stage).toBe("purchased"); // CRM truth advanced
  const transitions = await transitionsFor(t, base.conversationId);
  const purchasedTr = transitions.filter((tr) => tr.stage === "purchased");
  expect(purchasedTr).toHaveLength(1);
  expect(purchasedTr[0].conversionEventId).toBe(proxyEvent._id); // linked, not duplicated
});

test("PS: agent-then-proxy — an already-recorded real sale makes the judge a no-op on the outbox", async () => {
  const t = convexTest(schema, modules);
  const base = await seedAttributed(t);
  await enablePurchaseSignals(t, base.accountId);
  await qualifySession(t, base);
  await completeSalesChecklist(t, base.conversationId);
  await base.asUser.mutation(api.funnel.setStage, {
    conversationId: base.conversationId,
    stage: "purchased",
    saleValue: 12_000,
    saleCurrency: "AED",
  });
  const [agentEvent] = await purchasedEventsFor(t, base.conversationId);

  await seedCustomerMessage(t, base.accountId, base.conversationId, "[[PURCHASE]]");
  await t.action(internal.qualificationEngine.evaluatePurchase, {
    accountId: base.accountId, conversationId: base.conversationId,
  });

  const events = await purchasedEventsFor(t, base.conversationId);
  expect(events).toHaveLength(1);
  expect(events[0]._id).toBe(agentEvent._id);
  expect(events[0].value).toBe(12_000); // the real sale's value stands
  const [s] = await sessionsFor(t, base.conversationId);
  expect(s.purchase?.status).toBe("sent"); // session reflects: Meta has it
});

test("PS: gates — disabled toggle, organic conversation, unqualified session, expired window all skip evaluation", async () => {
  const t = convexTest(schema, modules);

  // Toggle off (default): nothing happens even for a qualified lead.
  const off = await seedAttributed(t);
  await qualifySession(t, off);
  await seedCustomerMessage(t, off.accountId, off.conversationId, "[[PURCHASE]]");
  await t.action(internal.qualificationEngine.evaluatePurchase, {
    accountId: off.accountId, conversationId: off.conversationId,
  });
  let [s] = await sessionsFor(t, off.conversationId);
  expect(s.purchase).toBeUndefined();

  // Organic (no attribution): no evaluation.
  const organic = await seed(t);
  await configureAi(organic.asUser);
  await enablePurchaseSignals(t, organic.accountId);
  await qualifySession(t, organic);
  await seedCustomerMessage(t, organic.accountId, organic.conversationId, "[[PURCHASE]]");
  await t.action(internal.qualificationEngine.evaluatePurchase, {
    accountId: organic.accountId, conversationId: organic.conversationId,
  });
  [s] = await sessionsFor(t, organic.conversationId);
  expect(s.purchase).toBeUndefined();
  expect(await purchasedEventsFor(t, organic.conversationId)).toHaveLength(0);

  // Still collecting: the judge never runs before qualification.
  const collecting = await seedAttributed(t);
  await enablePurchaseSignals(t, collecting.accountId);
  await seedCustomerMessage(t, collecting.accountId, collecting.conversationId,
    "field:a=1; [[PURCHASE]]");
  await t.action(internal.qualificationEngine.analyzeInbound, {
    accountId: collecting.accountId, conversationId: collecting.conversationId,
    contactId: collecting.contactId,
  });
  await t.action(internal.qualificationEngine.evaluatePurchase, {
    accountId: collecting.accountId, conversationId: collecting.conversationId,
  });
  [s] = await sessionsFor(t, collecting.conversationId);
  expect(s.status).toBe("collecting");
  expect(s.purchase).toBeUndefined();

  // Window expired: qualified 8 days ago → no more evaluations (the
  // in-window completion eval may have stamped a not_met verdict; what
  // matters is that nothing ever fires once the window closes).
  const stale = await seedAttributed(t);
  await enablePurchaseSignals(t, stale.accountId);
  await qualifySession(t, stale);
  await t.run(async (ctx) => {
    const session = await ctx.db
      .query("qualificationSessions")
      .withIndex("by_conversation", (q) => q.eq("conversationId", stale.conversationId))
      .order("desc")
      .first();
    if (session) await ctx.db.patch(session._id, { qualifiedAt: Date.now() - 8 * 24 * 3_600_000 });
  });
  await seedCustomerMessage(t, stale.accountId, stale.conversationId, "[[PURCHASE]]");
  await t.action(internal.qualificationEngine.evaluatePurchase, {
    accountId: stale.accountId, conversationId: stale.conversationId,
  });
  [s] = await sessionsFor(t, stale.conversationId);
  expect(s.purchase?.status ?? "not_met").toBe("not_met"); // never "sent"
  expect(await purchasedEventsFor(t, stale.conversationId)).toHaveLength(0);
});

test("PS: a media message (visa documents) on a qualified session triggers evaluation via onInbound", async () => {
  vi.useFakeTimers();
  try {
    const t = convexTest(schema, modules);
    const base = await seedAttributed(t);
    await enablePurchaseSignals(t, base.accountId);
    await qualifySession(t, base);
    await t.finishAllScheduledFunctions(vi.runAllTimers); // drain completion's own eval
    await clearPurchaseDebounce(t, base.conversationId);

    // The documents arrive as an image with a caption — the dry-run
    // marker rides the caption exactly like a real doc description would.
    await t.run((ctx) =>
      ctx.db.insert("messages", {
        accountId: base.accountId,
        conversationId: base.conversationId,
        senderType: "customer",
        contentType: "image",
        contentText: "passport copy [[PURCHASE]]",
        status: "delivered",
      }),
    );
    await t.mutation(internal.qualificationEngine.onInbound, {
      accountId: base.accountId,
      conversationId: base.conversationId,
      contactId: base.contactId,
      phoneNormalized: "971500000001",
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const [s] = await sessionsFor(t, base.conversationId);
    expect(s.purchase?.status).toBe("sent");
    expect(await purchasedEventsFor(t, base.conversationId)).toHaveLength(1);
  } finally {
    vi.useRealTimers();
  }
});

test("PS: applyPurchaseVerdict enforces the confidence floor and idempotency", async () => {
  const t = convexTest(schema, modules);
  const base = await seedAttributed(t);
  await enablePurchaseSignals(t, base.accountId);
  await qualifySession(t, base);

  // met but hesitant → never fires.
  const hesitant = await t.mutation(internal.qualificationEngine.applyPurchaseVerdict, {
    accountId: base.accountId,
    conversationId: base.conversationId,
    verdict: { met: true, confidence: 50, reasons: ["maybe"], value: null, currency: null, criteriaFound: true },
  });
  expect(hesitant.fired).toBe(false);
  let [s] = await sessionsFor(t, base.conversationId);
  expect(s.purchase?.status).toBe("not_met");
  expect(await purchasedEventsFor(t, base.conversationId)).toHaveLength(0);

  // criteria section missing → never fires, whatever met says.
  const noCriteria = await t.mutation(internal.qualificationEngine.applyPurchaseVerdict, {
    accountId: base.accountId,
    conversationId: base.conversationId,
    verdict: { met: true, confidence: 95, reasons: ["?"], value: null, currency: null, criteriaFound: false },
  });
  expect(noCriteria.fired).toBe(false);

  // Confident met fires once; a duplicate verdict is a no-op.
  const fired = await t.mutation(internal.qualificationEngine.applyPurchaseVerdict, {
    accountId: base.accountId,
    conversationId: base.conversationId,
    verdict: { met: true, confidence: 90, reasons: ["all criteria met"], value: 3000, currency: null, criteriaFound: true },
  });
  expect(fired.fired).toBe(true);
  const again = await t.mutation(internal.qualificationEngine.applyPurchaseVerdict, {
    accountId: base.accountId,
    conversationId: base.conversationId,
    verdict: { met: true, confidence: 90, reasons: ["all criteria met"], value: 3000, currency: null, criteriaFound: true },
  });
  expect(again.fired).toBe(false);
  const events = await purchasedEventsFor(t, base.conversationId);
  expect(events).toHaveLength(1);
  expect(events[0].currency).toBe("AED"); // account default backfills a value-bearing event
  [s] = await sessionsFor(t, base.conversationId);
  expect(s.purchase?.status).toBe("sent");
});

test("PS: completing qualification schedules the first purchase evaluation automatically", async () => {
  vi.useFakeTimers();
  try {
    const t = convexTest(schema, modules);
    const base = await seedAttributed(t);
    await enablePurchaseSignals(t, base.accountId);
    // One message carries BOTH vocabularies: qualification completes AND
    // the scheduled first evaluation immediately finds criteria met.
    await seedCustomerMessage(t, base.accountId, base.conversationId,
      "[[COMPLETE]] score:80 field:a=1;field:b=2;field:c=3 [[PURCHASE]] pvalue:3000;");
    await t.action(internal.qualificationEngine.analyzeInbound, {
      accountId: base.accountId, conversationId: base.conversationId, contactId: base.contactId,
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const [s] = await sessionsFor(t, base.conversationId);
    expect(s.status).toBe("qualified");
    expect(s.purchase?.status).toBe("sent");
    expect(s.purchase?.value).toBe(3000);
    expect(await purchasedEventsFor(t, base.conversationId)).toHaveLength(1);
  } finally {
    vi.useRealTimers();
  }
});

test("PS: sendPurchaseSignal — supervisor+ fires manually (works with auto toggle OFF), agents rejected, organic rejected", async () => {
  const t = convexTest(schema, modules);
  const base = await seedAttributed(t); // asUser = admin; purchase toggle stays OFF
  await qualifySession(t, base);
  const [s] = await sessionsFor(t, base.conversationId);

  // Below supervisor → FORBIDDEN.
  const agentUserId = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { name: "Agent", email: "agent@example.com" });
    await ctx.db.insert("memberships", {
      userId, accountId: base.accountId, role: "agent", fullName: "Agent", email: "agent@example.com",
    });
    return userId;
  });
  const asAgent = t.withIdentity({ subject: `${agentUserId}|s2` });
  await expect(
    asAgent.mutation(api.qualification.sendPurchaseSignal, { sessionId: s._id }),
  ).rejects.toThrow();

  // Admin fires — even though purchaseSignalsEnabled is false (manual is
  // explicit human intent, the toggle only governs the automatic judge).
  await base.asUser.mutation(api.qualification.sendPurchaseSignal, { sessionId: s._id });
  const events = await purchasedEventsFor(t, base.conversationId);
  expect(events).toHaveLength(1);
  expect(events[0].eventName).toBe("Purchase");
  const [after] = await sessionsFor(t, base.conversationId);
  expect(after.purchase?.status).toBe("sent");
  expect(after.purchase?.manual).toBe(true);

  // Firing twice is rejected cleanly.
  await expect(
    base.asUser.mutation(api.qualification.sendPurchaseSignal, { sessionId: s._id }),
  ).rejects.toThrow();

  // Organic conversation → BAD_REQUEST not_attributed.
  const organic = await seed(t);
  await configureAi(organic.asUser);
  await qualifySession(t, organic);
  const [os] = await sessionsFor(t, organic.conversationId);
  await expect(
    organic.asUser.mutation(api.qualification.sendPurchaseSignal, { sessionId: os._id }),
  ).rejects.toThrow();
});

test("PS: leadsBoard and getSessionForConversation expose the purchase verdict", async () => {
  const t = convexTest(schema, modules);
  const base = await seedAttributed(t);
  await enablePurchaseSignals(t, base.accountId);
  await qualifySession(t, base);
  await seedCustomerMessage(t, base.accountId, base.conversationId,
    "[[PURCHASE]] pvalue:9000; pcurrency:AED;");
  await t.action(internal.qualificationEngine.evaluatePurchase, {
    accountId: base.accountId, conversationId: base.conversationId,
  });

  const board = await base.asUser.query(api.qualification.leadsBoard, {});
  const [ls] = await sessionsFor(t, base.conversationId);
  const row = board.leads.find((l) => l.sessionId === ls._id);
  expect(row?.purchase?.status).toBe("sent");
  expect(row?.purchase?.value).toBe(9000);
  expect(row?.purchase?.currency).toBe("AED");
  expect(row?.purchase?.manual).toBe(false);

  const chip = await base.asUser.query(api.qualification.getSessionForConversation, {
    conversationId: base.conversationId,
  });
  expect(chip?.purchase?.status).toBe("sent");
  expect(chip?.purchase?.confidence).toBe(90);
});

// ============================================================
// Routing failsafe — `offerContext` used to return a bare `null` for
// seven different conditions, three benign and four genuine routing
// failures, and `startLeadOffer` treated all seven as "nothing to do".
// Because no `leadOffers` row was written in the failure cases, the
// `sweepLeadOffers` cron (which finds work via `by_status_offered`)
// could never retry them, so the lead was orphaned permanently.
// ============================================================

/** Drives a conversation to a qualified session and returns it. */
async function qualifyLead(t: TestConvex<typeof schema>, base: Awaited<ReturnType<typeof seedAttributed>>) {
  await seedCustomerMessage(t, base.accountId, base.conversationId,
    "[[COMPLETE]] score:85 field:a=1;field:b=2;field:c=3");
  await t.action(internal.qualificationEngine.analyzeInbound, {
    accountId: base.accountId, conversationId: base.conversationId, contactId: base.contactId,
  });
  const [session] = (await sessionsFor(t, base.conversationId)).filter((s) => s.status === "qualified");
  return session;
}

test("failsafe: a service nobody is linked to still reaches the team, flagged as fallback", async () => {
  const t = convexTest(schema, modules);
  const base = await seedAttributed(t);
  // Sara is a perfectly good agent — she is just linked to a DIFFERENT
  // service than the synthetic "UAE visa" this lead qualifies for, so
  // the "UAE visa" tag ends up with zero memberTags links.
  const sara = await seedAgentWithTag(t, base.accountId, {
    name: "Sara", phone: "+971 55 700 8899", tagName: "Georgia tours",
  });
  const session = await qualifyLead(t, base);

  const decision = await t.query(internal.qualificationEngine.offerContext, {
    sessionId: session._id,
  });
  expect(decision.kind).toBe("offer");
  if (decision.kind !== "offer") throw new Error("unreachable");
  // the engine created the "UAE visa" tag at completion, so it exists
  // with zero links — a stricter assertion than the old boolean, which
  // could not tell this apart from the three other fallback causes
  expect(decision.fallback).toBe("tag_unlinked");
  expect(decision.agent.userId).toBe(sara.userId);

  // and it really is offered, not just classified
  await t.action(internal.qualificationEngine.startLeadOffer, {
    accountId: base.accountId, sessionId: session._id,
  });
  const offers = await offersFor(t, session._id);
  expect(offers).toHaveLength(1);
  expect(offers[0].agentUserId).toBe(sara.userId);

  // once the fallback pool itself is spent, that is exhaustion too
  await t.mutation(internal.qualificationEngine.onAdminInbound, {
    accountId: base.accountId, phoneNormalized: "971557008899", text: "no",
  });
  expect(await t.query(internal.qualificationEngine.offerContext, { sessionId: session._id }))
    .toMatchObject({ kind: "exhausted" });
});

test("failsafe: a tag linked only to unreachable members falls back to the team", async () => {
  const t = convexTest(schema, modules);
  const base = await seedAttributed(t);
  const omar = await seedAgentWithTag(t, base.accountId, {
    name: "Omar", phone: "+971551110002", tagName: "Georgia tours",
  });
  const session = await qualifyLead(t, base);

  // Nadia IS linked to the lead's own service, but has no WhatsApp
  // number, so she can never actually receive an offer — the link
  // exists on paper only. Added after qualification so it attaches to
  // the service tag the engine itself created.
  const tagId = await t.run(async (ctx) => {
    const tag = (await ctx.db.query("tags")
      .withIndex("by_account", (q) => q.eq("accountId", base.accountId)).collect())
      .find((x) => x.name === "UAE visa");
    if (!tag) return null;
    const userId = await ctx.db.insert("users", { name: "Nadia", email: "nadia@example.com" });
    await ctx.db.insert("memberships", {
      userId, accountId: base.accountId, role: "agent",
      fullName: "Nadia", email: "nadia@example.com", // deliberately no phone
    });
    await ctx.db.insert("memberTags", { accountId: base.accountId, userId, tagId: tag._id });
    return tag._id;
  });
  expect(tagId).not.toBeNull(); // the premise: the engine made the service tag

  const decision = await t.query(internal.qualificationEngine.offerContext, {
    sessionId: session._id,
  });
  expect(decision.kind).toBe("offer");
  if (decision.kind !== "offer") throw new Error("unreachable");
  // Nadia IS linked, so the remedy is a phone number, not another link
  expect(decision.fallback).toBe("links_ineligible");
  expect(decision.agent.userId).toBe(omar.userId);
});

test("failsafe: an account with no agent at all is unroutable, not silent", async () => {
  const t = convexTest(schema, modules);
  const base = await seedAttributed(t);
  const session = await qualifyLead(t, base);

  const decision = await t.query(internal.qualificationEngine.offerContext, {
    sessionId: session._id,
  });
  expect(decision).toMatchObject({ kind: "unroutable", reason: "no_agents", serviceName: "UAE visa" });
});

test("failsafe: linked agents who have all passed mean exhausted — the team is NOT widened to", async () => {
  const t = convexTest(schema, modules);
  const base = await seedAttributed(t);
  // Linked to the real service: routing intent WAS expressed for Lina.
  const lina = await seedAgentWithTag(t, base.accountId, {
    name: "Lina", phone: "+971551110001", tagName: "UAE visa",
  });
  // Omar is eligible but deliberately NOT linked to "UAE visa".
  await seedAgentWithTag(t, base.accountId, {
    name: "Omar", phone: "+971551110002", tagName: "Georgia tours",
  });
  const session = await qualifyLead(t, base);

  // Lina is offered first, then declines.
  await t.action(internal.qualificationEngine.startLeadOffer, {
    accountId: base.accountId, sessionId: session._id,
  });
  expect((await offersFor(t, session._id))[0].agentUserId).toBe(lina.userId);
  await t.mutation(internal.qualificationEngine.onAdminInbound, {
    accountId: base.accountId, phoneNormalized: "971551110001", text: "no",
  });

  // Intent was expressed and honoured, so this is exhausted — Omar must
  // NOT be pulled in behind Lina's back.
  const decision = await t.query(internal.qualificationEngine.offerContext, {
    sessionId: session._id,
  });
  expect(decision).toMatchObject({ kind: "exhausted", serviceName: "UAE visa" });
  expect(await offersFor(t, session._id)).toHaveLength(1);
});

test("failsafe: the three benign cases stay noop", async () => {
  const t = convexTest(schema, modules);
  const base = await seedAttributed(t);
  await seedAgentWithTag(t, base.accountId, {
    name: "Sara", phone: "+971 55 700 8899", tagName: "UAE visa",
  });
  const session = await qualifyLead(t, base);

  const patchConfig = async (patch: { autoAssignEnabled: boolean }) => {
    await t.run(async (ctx) => {
      const config = await ctx.db.query("qualificationConfigs")
        .withIndex("by_account", (q) => q.eq("accountId", base.accountId)).unique();
      if (config) await ctx.db.patch(config._id, patch);
    });
  };

  // (a) already assigned
  await t.run((ctx) => ctx.db.patch(base.conversationId, { assignedToUserId: base.userId }));
  expect(await t.query(internal.qualificationEngine.offerContext, { sessionId: session._id }))
    .toEqual({ kind: "noop" });
  await t.run((ctx) => ctx.db.patch(base.conversationId, { assignedToUserId: undefined }));

  // (b) auto-assign turned off — checked BEFORE any offer exists, so a
  // pass here cannot be the live-offer guard passing by coincidence
  await patchConfig({ autoAssignEnabled: false });
  expect(await t.query(internal.qualificationEngine.offerContext, { sessionId: session._id }))
    .toEqual({ kind: "noop" });
  await patchConfig({ autoAssignEnabled: true });

  // (c) a live offer already exists
  await t.action(internal.qualificationEngine.startLeadOffer, {
    accountId: base.accountId, sessionId: session._id,
  });
  expect(await t.query(internal.qualificationEngine.offerContext, { sessionId: session._id }))
    .toEqual({ kind: "noop" });
});

/** Every message sent to a staff/admin WhatsApp number, newest last. */
async function staffMessagesTo(
  t: TestConvex<typeof schema>,
  accountId: Id<"accounts">,
  phoneNormalized: string,
) {
  const contact = await t.run((ctx) =>
    ctx.db.query("contacts").withIndex("by_account_phone", (q) =>
      q.eq("accountId", accountId).eq("phoneNormalized", phoneNormalized)).unique());
  if (!contact) return [];
  const conversation = await t.run((ctx) =>
    ctx.db.query("conversations").withIndex("by_contact", (q) =>
      q.eq("contactId", contact._id)).first());
  if (!conversation) return [];
  return await messagesFor(t, conversation._id);
}

/** Points the account's admin alerts at one number. */
async function setAdminAlertPhone(
  t: TestConvex<typeof schema>,
  accountId: Id<"accounts">,
  phone: string,
) {
  await t.run(async (ctx) => {
    const config = await ctx.db.query("qualificationConfigs")
      .withIndex("by_account", (q) => q.eq("accountId", accountId)).unique();
    if (config) await ctx.db.patch(config._id, { adminAlertPhones: [phone] });
  });
}

test("failsafe: a fallback offer tells admins the tag has no linked agent", async () => {
  const t = convexTest(schema, modules);
  const base = await seedAttributed(t);
  await seedAgentWithTag(t, base.accountId, {
    name: "Sara", phone: "+971 55 700 8899", tagName: "Georgia tours",
  });
  await setAdminAlertPhone(t, base.accountId, "+971559456999");
  const session = await qualifyLead(t, base);

  await t.action(internal.qualificationEngine.startLeadOffer, {
    accountId: base.accountId, sessionId: session._id,
  });

  const msgs = await staffMessagesTo(t, base.accountId, "971559456999");
  expect(msgs.some((m) => m.contentText?.includes("UAE visa"))).toBe(true);
  expect(msgs.some((m) => m.contentText?.includes("whole team"))).toBe(true);
  // the lead still went out — the alert is in addition, not instead
  expect(await offersFor(t, session._id)).toHaveLength(1);
});

test("failsafe: an exhausted cycle tells admins the lead is stranded", async () => {
  const t = convexTest(schema, modules);
  const base = await seedAttributed(t);
  await seedAgentWithTag(t, base.accountId, {
    name: "Lina", phone: "+971551110001", tagName: "UAE visa",
  });
  await setAdminAlertPhone(t, base.accountId, "+971559456999");
  const session = await qualifyLead(t, base);

  await t.action(internal.qualificationEngine.startLeadOffer, {
    accountId: base.accountId, sessionId: session._id,
  });
  await t.mutation(internal.qualificationEngine.onAdminInbound, {
    accountId: base.accountId, phoneNormalized: "971551110001", text: "no",
  });
  // the decline re-triggers the offer, which now finds nobody left
  await t.action(internal.qualificationEngine.startLeadOffer, {
    accountId: base.accountId, sessionId: session._id,
  });

  const msgs = await staffMessagesTo(t, base.accountId, "971559456999");
  expect(msgs.some((m) => m.contentText?.includes("not taken"))).toBe(true);
});

test("failsafe: no admin numbers configured means no send, and no crash", async () => {
  const t = convexTest(schema, modules);
  const base = await seedAttributed(t);
  const session = await qualifyLead(t, base);
  // no agents and no admin phones: unroutable, but nothing to send to.
  // (Convex actions can't return `undefined` — a void handler resolves
  // to `null` over the test-client boundary, same as every other action
  // in this file; asserting `toBeNull()` is "didn't throw" here.)
  await expect(t.action(internal.qualificationEngine.startLeadOffer, {
    accountId: base.accountId, sessionId: session._id,
  })).resolves.toBeNull();
  expect(await offersFor(t, session._id)).toHaveLength(0);
});

test("failsafe: an alert whose own config lookup throws is swallowed, never propagated", async () => {
  const t = convexTest(schema, modules);
  const base = await seed(t, { enabled: true, adminPhones: ["+971559456999"] });

  // Positive control FIRST, while the config is still readable: the alert
  // really does reach the admin. Without this half, a future refactor that
  // gutted `alertRoutingFailure` into a no-op would still satisfy the
  // "resolves" assertion below and the test would rot into a tautology.
  await t.action(internal.qualificationEngine.alertRoutingFailure, {
    accountId: base.accountId, text: "⚠️ control: routing alert",
  });
  expect((await staffMessagesTo(t, base.accountId, "971559456999"))
    .some((m) => m.contentText?.includes("control"))).toBe(true);

  // Now break the read side the same way production would: a second
  // `qualificationConfigs` row for one account makes `routingAlertPhones`'s
  // `.unique()` throw. (`routingAlertPhones` queries the table directly and
  // ignores `enabled`, so the duplicate throws whatever its flags say.)
  await t.run((ctx) =>
    ctx.db.insert("qualificationConfigs", {
      accountId: base.accountId,
      ...holidayysDefaultConfig(),
      enabled: true,
      adminAlertPhones: ["+971559456999"],
    }));

  // The property under test: alerting is best-effort, so this RESOLVES.
  // Before the fix it rejected, and in `startLeadOffer`'s fallback branch
  // that rejection escaped past an already-written "offered" leadOffers
  // row — so the agent never heard about a lead that `offerContext`'s
  // live-offer guard then made un-retryable by the sweep cron. Keeping
  // this green is what keeps that silent drop dead. (`toBeNull()` reads
  // as "resolved"; see the no-admin-numbers test above for why a void
  // Convex action resolves to `null` rather than `undefined`.)
  await expect(t.action(internal.qualificationEngine.alertRoutingFailure, {
    accountId: base.accountId, text: "⚠️ routing alert with a broken config",
  })).resolves.toBeNull();
});

/**
 * Inserts a qualified session directly, bypassing the analysis path.
 *
 * Needed because the dry-run stub hardcodes `service: "UAE visa"`
 * (`syntheticAnalysisRaw`) with no way to suppress it, so a session with
 * no service name — or with a service no tag matches — is unreachable
 * through `analyzeInbound`. Same direct-insert shape as the P6
 * fewest-recent-accepts test above. `serviceName` is OMITTED rather than
 * set to `null` because the schema field is `v.optional(v.string())`,
 * which is exactly the state production leaves it in: the insert at
 * `qualificationEngine.ts:381` never writes it and `patch.serviceName`
 * is only set `if (analysis.serviceName)`.
 */
async function seedQualifiedSession(
  t: TestConvex<typeof schema>,
  base: Awaited<ReturnType<typeof seedAttributed>>,
  opts: { serviceName?: string } = {},
) {
  return await t.run((ctx) =>
    ctx.db.insert("qualificationSessions", {
      accountId: base.accountId,
      conversationId: base.conversationId,
      contactId: base.contactId,
      status: "qualified",
      origin: "inbound",
      ...(opts.serviceName === undefined ? {} : { serviceName: opts.serviceName }),
      fields: [], expectedCount: 4, answeredCount: 4, score: 80, qualifiedAt: Date.now(),
      followUpsSent: 0, phrasingCursor: 0, sendAttemptErrors: 0,
    }));
}

/** Messages sent to the admin alert number, as plain text. */
async function alertTextsTo(
  t: TestConvex<typeof schema>,
  accountId: Id<"accounts">,
  phoneNormalized: string,
) {
  return (await staffMessagesTo(t, accountId, phoneNormalized))
    .map((m) => m.contentText ?? "");
}

test("failsafe C1: a qualified lead with NO service name still reaches an agent, with an honest alert", async () => {
  const t = convexTest(schema, modules);
  const base = await seedAttributed(t);
  const sara = await seedAgentWithTag(t, base.accountId, {
    name: "Sara", phone: "+971 55 700 8899", tagName: "Georgia tours",
  });
  await setAdminAlertPhone(t, base.accountId, "+971559456999");
  // The AI qualified the lead without ever naming a service. This is the
  // state `analyzeInbound` leaves behind whenever the model returns no
  // `service`, and the old guard (`|| !session.serviceName`) turned it
  // into a `noop` — no offer row, so `sweepLeadOffers` was structurally
  // blind to it and the lead was lost permanently and silently.
  const sessionId = await seedQualifiedSession(t, base);

  const decision = await t.query(internal.qualificationEngine.offerContext, { sessionId });
  expect(decision.kind).toBe("offer"); // NOT noop — this is the whole finding
  if (decision.kind !== "offer") throw new Error("unreachable");
  expect(decision.fallback).toBe("no_service_name");
  expect(decision.agent.userId).toBe(sara.userId);

  // and it genuinely routes, not merely classifies
  await t.action(internal.qualificationEngine.startLeadOffer, {
    accountId: base.accountId, sessionId,
  });
  const offers = await offersFor(t, sessionId);
  expect(offers).toHaveLength(1);
  expect(offers[0].agentUserId).toBe(sara.userId);

  // the agent's offer text uses the placeholder, never a bare "undefined"
  const agentMsgs = await alertTextsTo(t, base.accountId, "971557008899");
  expect(agentMsgs.some((m) => m.includes("Reply YES"))).toBe(true);
  expect(agentMsgs.some((m) => m.includes("undefined"))).toBe(false);

  // and the admin is told the real cause, not "link an agent to the tag"
  const alerts = await alertTextsTo(t, base.accountId, "971559456999");
  const alert = alerts.find((m) => m.includes("Routing not configured"));
  expect(alert).toBeDefined();
  expect(alert).toContain("without the AI identifying a service");
  expect(alert).not.toContain("No agent is linked to the tag");
});

test("failsafe T2-m2: the fallback alert fires once per LEAD, not once per offer attempt", async () => {
  const t = convexTest(schema, modules);
  const base = await seedAttributed(t);
  // Two eligible agents, neither linked to the lead's service, so the
  // whole-team fallback walks both of them in turn.
  await seedAgentWithTag(t, base.accountId, {
    name: "A1", phone: "+971551110001", tagName: "Georgia tours",
  });
  await seedAgentWithTag(t, base.accountId, {
    name: "A2", phone: "+971551110002", tagName: "Georgia tours",
  });
  await setAdminAlertPhone(t, base.accountId, "+971559456999");
  const session = await qualifyLead(t, base);

  await t.action(internal.qualificationEngine.startLeadOffer, {
    accountId: base.accountId, sessionId: session._id,
  });
  const first = (await offersFor(t, session._id))[0];
  // whoever was picked declines, which re-triggers the offer for the next
  await t.mutation(internal.qualificationEngine.onAdminInbound, {
    accountId: base.accountId,
    phoneNormalized: first.agentPhone.replace(/\D/g, ""),
    text: "no",
  });
  await t.action(internal.qualificationEngine.startLeadOffer, {
    accountId: base.accountId, sessionId: session._id,
  });

  // the lead really did walk to a second agent...
  const offers = await offersFor(t, session._id);
  expect(offers).toHaveLength(2);
  // ...but the owner's phone got exactly ONE misconfiguration alert.
  const alerts = await alertTextsTo(t, base.accountId, "971559456999");
  expect(alerts.filter((m) => m.includes("Routing not configured"))).toHaveLength(1);
});

test("failsafe I1: the exhausted alert never claims the whole team passed when only linked agents were asked", async () => {
  const t = convexTest(schema, modules);
  const base = await seedAttributed(t);
  // Lina is linked to the real service; Omar is eligible but NOT linked,
  // so he is deliberately never asked (the intent rule).
  await seedAgentWithTag(t, base.accountId, {
    name: "Lina", phone: "+971551110001", tagName: "UAE visa",
  });
  await seedAgentWithTag(t, base.accountId, {
    name: "Omar", phone: "+971551110002", tagName: "Georgia tours",
  });
  await setAdminAlertPhone(t, base.accountId, "+971559456999");
  const session = await qualifyLead(t, base);

  await t.action(internal.qualificationEngine.startLeadOffer, {
    accountId: base.accountId, sessionId: session._id,
  });
  await t.mutation(internal.qualificationEngine.onAdminInbound, {
    accountId: base.accountId, phoneNormalized: "971551110001", text: "no",
  });
  const decision = await t.query(internal.qualificationEngine.offerContext, {
    sessionId: session._id,
  });
  expect(decision).toMatchObject({ kind: "exhausted", scope: "linked" });
  await t.action(internal.qualificationEngine.startLeadOffer, {
    accountId: base.accountId, sessionId: session._id,
  });

  const alerts = await alertTextsTo(t, base.accountId, "971559456999");
  const stranded = alerts.find((m) => m.includes("Lead not taken"));
  expect(stranded).toBeDefined();
  // Omar was never asked, so this claim would be false...
  expect(stranded).not.toContain("Everyone eligible has passed");
  // ...and the truthful version names the service and the unasked rest
  expect(stranded).toContain('Every agent linked to "UAE visa"');
  expect(stranded).toContain("nobody else was asked");
});

test("failsafe I1: a whole-team cycle that runs out DOES say everyone passed", async () => {
  const t = convexTest(schema, modules);
  const base = await seedAttributed(t);
  // Nobody is linked to the lead's service, so the fallback asked the
  // entire team — here "everyone eligible" is literally true.
  await seedAgentWithTag(t, base.accountId, {
    name: "Sara", phone: "+971 55 700 8899", tagName: "Georgia tours",
  });
  await setAdminAlertPhone(t, base.accountId, "+971559456999");
  const session = await qualifyLead(t, base);

  await t.action(internal.qualificationEngine.startLeadOffer, {
    accountId: base.accountId, sessionId: session._id,
  });
  await t.mutation(internal.qualificationEngine.onAdminInbound, {
    accountId: base.accountId, phoneNormalized: "971557008899", text: "no",
  });
  expect(await t.query(internal.qualificationEngine.offerContext, { sessionId: session._id }))
    .toMatchObject({ kind: "exhausted", scope: "team" });
  await t.action(internal.qualificationEngine.startLeadOffer, {
    accountId: base.accountId, sessionId: session._id,
  });

  const alerts = await alertTextsTo(t, base.accountId, "971559456999");
  const stranded = alerts.find((m) => m.includes("Lead not taken"));
  expect(stranded).toContain("Everyone eligible has passed");
});

test("failsafe I2: each fallback cause names its own remedy", async () => {
  const t = convexTest(schema, modules);
  const base = await seedAttributed(t);
  await seedAgentWithTag(t, base.accountId, {
    name: "Sara", phone: "+971 55 700 8899", tagName: "Georgia tours",
  });
  await setAdminAlertPhone(t, base.accountId, "+971559456999");

  // (a) the tag row is genuinely absent — reachable because the
  // completion-time auto-tag is best-effort inside a try/catch. Telling
  // an admin to "link agents to that tag" sends them hunting for a tag
  // that does not exist.
  const missing = await seedQualifiedSession(t, base, { serviceName: "Kenya safari" });
  expect(await t.query(internal.qualificationEngine.offerContext, { sessionId: missing }))
    .toMatchObject({ kind: "offer", fallback: "tag_missing" });
  await t.action(internal.qualificationEngine.startLeadOffer, {
    accountId: base.accountId, sessionId: missing,
  });
  let alerts = await alertTextsTo(t, base.accountId, "971559456999");
  const absent = alerts.find((m) => m.includes("Kenya safari"));
  expect(absent).toContain('No tag named "Kenya safari" exists');
  expect(absent).toContain("Settings → Tags");

  // (b) links exist but every linked member is unreachable — the remedy
  // is a phone number or a role change, NOT another link.
  const tagId = await t.run(async (ctx) => {
    const id = await ctx.db.insert("tags", {
      accountId: base.accountId, name: "Baku tours", color: "#0ea5e9",
    });
    const userId = await ctx.db.insert("users", { name: "Nadia", email: "nadia2@example.com" });
    await ctx.db.insert("memberships", {
      userId, accountId: base.accountId, role: "agent",
      fullName: "Nadia", email: "nadia2@example.com", // deliberately no phone
    });
    await ctx.db.insert("memberTags", { accountId: base.accountId, userId, tagId: id });
    return id;
  });
  expect(tagId).toBeDefined();
  const ineligible = await seedQualifiedSession(t, base, { serviceName: "Baku tours" });
  expect(await t.query(internal.qualificationEngine.offerContext, { sessionId: ineligible }))
    .toMatchObject({ kind: "offer", fallback: "links_ineligible" });
  await t.action(internal.qualificationEngine.startLeadOffer, {
    accountId: base.accountId, sessionId: ineligible,
  });
  alerts = await alertTextsTo(t, base.accountId, "971559456999");
  const unreachable = alerts.find((m) => m.includes("Baku tours"));
  expect(unreachable).toContain("is unreachable");
  expect(unreachable).toContain("missing a WhatsApp number");
  // the false remedy from the old single message must NOT appear here
  expect(unreachable).not.toContain("No agent is linked to the tag");
});
