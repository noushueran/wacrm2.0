import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, expect, test } from "vitest";
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
    autoReplyMaxPerConversation: 3,
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

test("wants-human intent hands off to the human queue while the session keeps collecting", async () => {
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
  expect(conversation?.aiAutoreplyDisabled).toBe(true);
  expect(conversation?.status).toBe("pending");
  expect(conversation?.aiHandoffSummary).toContain("human");
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
  expect(conversation?.aiAutoreplyDisabled).toBe(true);
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
  // no template configured → no message, rescheduled towards expiry
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
