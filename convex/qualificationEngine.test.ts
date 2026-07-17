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

test("analyzeInbound stamps readiness when checklist satisfied + score >= threshold + >=3 answers", async () => {
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
  expect(s.status).toBe("collecting"); // completion is P2's job
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
