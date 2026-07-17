import { convexTest, type TestConvex } from "convex-test";
import { expect, test } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import { holidayysDefaultConfig } from "./lib/qualification/defaults";

const modules = import.meta.glob("/convex/**/*.ts");

async function seed(
  t: ReturnType<typeof convexTest>,
  opts: { enabled: boolean; adminPhones?: string[] } = { enabled: true },
) {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { name: "U", email: "u@example.com" });
    const accountId = await ctx.db.insert("accounts", {
      name: "A", defaultCurrency: "AED", ownerUserId: userId,
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
    return { accountId, contactId, conversationId };
  });
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
