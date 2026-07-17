import { convexTest, type TestConvex } from "convex-test";
import { expect, test } from "vitest";
import schema from "../../schema";
import type { Id } from "../../_generated/dataModel";
import { holidayysDefaultConfig } from "./defaults";
import {
  ensureSession,
  recordInboundActivity,
  recordOutboundSend,
  isAdminAlertNumber,
  loadEnabledConfig,
} from "./track";

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

// `TestConvex<typeof schema>` (not the bare `ReturnType<typeof convexTest>`
// the seed helper uses) because this calls `.withIndex`: the
// unparameterized type loses the concrete index names — the same
// documented gotcha as `convex/funnel.test.ts`'s `eventsFor`.
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

test("holidayysDefaultConfig matches the approved spec defaults", () => {
  const d = holidayysDefaultConfig();
  expect(d.enabled).toBe(false);
  expect(d.qualifyThresholdScore).toBe(60);
  expect(d.workStartMinute).toBe(600); // 10:00
  expect(d.workEndMinute).toBe(1260); // 21:00
  expect(d.workDays).toEqual([1, 2, 3, 4, 5, 6]); // closed Sunday (0)
  expect(d.utcOffsetMinutes).toBe(240); // Asia/Dubai
  expect(d.followUpDelaysMinutes).toEqual([60, 180, 720, 1440]);
  expect(d.maxFollowUps).toBe(4);
  expect(d.sessionWindowHours).toBe(72);
  const keys = d.basicFields.map((f) => f.key);
  expect(keys).toEqual(["looking_for", "travel_dates", "travelers", "email"]);
  expect(d.basicFields.every((f) => f.phrasings.length >= 2)).toBe(true);
});

test("ensureSession is idempotent and first-wins on origin", async () => {
  const t = convexTest(schema, modules);
  const { accountId, contactId, conversationId } = await seed(t);
  await t.run(async (ctx) => {
    const a = await ensureSession(ctx, { accountId, conversationId, contactId, origin: "outbound", now: 1000 });
    const b = await ensureSession(ctx, { accountId, conversationId, contactId, origin: "inbound", now: 2000 });
    expect(a).toBe(b);
  });
  const rows = await sessionsFor(t, conversationId);
  expect(rows).toHaveLength(1);
  expect(rows[0].origin).toBe("outbound"); // first-wins
  expect(rows[0].status).toBe("collecting");
});

test("recordInboundActivity bumps the clock and clears a pending follow-up, only while collecting", async () => {
  const t = convexTest(schema, modules);
  const { accountId, contactId, conversationId } = await seed(t);
  await t.run(async (ctx) => {
    await recordInboundActivity(ctx, { accountId, conversationId, contactId, now: 5000 });
  });
  let [s] = await sessionsFor(t, conversationId);
  expect(s.lastCustomerMessageAt).toBe(5000);
  await t.run(async (ctx) => {
    await ctx.db.patch(s._id, { nextFollowUpAt: 9999, sendAttemptErrors: 2 });
    await recordInboundActivity(ctx, { accountId, conversationId, contactId, now: 6000 });
  });
  [s] = await sessionsFor(t, conversationId);
  expect(s.lastCustomerMessageAt).toBe(6000);
  expect(s.nextFollowUpAt).toBeUndefined();
  expect(s.sendAttemptErrors).toBe(0);
  await t.run(async (ctx) => {
    await ctx.db.patch(s._id, { status: "qualified" });
    await recordInboundActivity(ctx, { accountId, conversationId, contactId, now: 7000 });
  });
  [s] = await sessionsFor(t, conversationId);
  expect(s.lastCustomerMessageAt).toBe(6000); // terminal session untouched
});

test("recordOutboundSend creates an outbound session; only agent sends set humanTouchedAt", async () => {
  const t = convexTest(schema, modules);
  const { accountId, conversationId } = await seed(t);
  await t.run(async (ctx) => {
    await recordOutboundSend(ctx, { accountId, conversationId, senderType: "bot", now: 100 });
  });
  let [s] = await sessionsFor(t, conversationId);
  expect(s.origin).toBe("outbound");
  expect(s.humanTouchedAt).toBeUndefined();
  await t.run(async (ctx) => {
    await recordOutboundSend(ctx, { accountId, conversationId, senderType: "agent", now: 200 });
  });
  [s] = await sessionsFor(t, conversationId);
  expect(s.humanTouchedAt).toBe(200);
});

test("loadEnabledConfig returns null when disabled; isAdminAlertNumber matches normalized phones", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seed(t, { enabled: false, adminPhones: ["+971 50 111 2222"] });
  await t.run(async (ctx) => {
    expect(await loadEnabledConfig(ctx, accountId)).toBeNull();
    const config = await ctx.db
      .query("qualificationConfigs")
      .withIndex("by_account", (q) => q.eq("accountId", accountId))
      .unique();
    expect(isAdminAlertNumber(config!, "971501112222")).toBe(true);
    expect(isAdminAlertNumber(config!, "971509999999")).toBe(false);
  });
});
