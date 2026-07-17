import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import schema from "./schema";

const modules = import.meta.glob("/convex/**/*.ts");

test("schema accepts qualificationConfigs, qualificationSessions and lead_qualified notifications", async () => {
  const t = convexTest(schema, modules);
  await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { name: "U", email: "u@example.com" });
    const accountId = await ctx.db.insert("accounts", {
      name: "A", defaultCurrency: "AED", ownerUserId: userId,
    });
    const contactId = await ctx.db.insert("contacts", {
      accountId, phone: "+971500000001", phoneNormalized: "971500000001",
    });
    const conversationId = await ctx.db.insert("conversations", {
      accountId, contactId, status: "open", unreadCount: 0,
    });
    const configId = await ctx.db.insert("qualificationConfigs", {
      accountId, enabled: false,
      basicFields: [{ key: "destination", label: "Destination", required: true, phrasings: ["Where would you like to go?"] }],
      qualifyThresholdScore: 60,
      timezoneLabel: "Asia/Dubai", utcOffsetMinutes: 240,
      workStartMinute: 600, workEndMinute: 1260, workDays: [1, 2, 3, 4, 5, 6],
      followUpDelaysMinutes: [60, 180, 720, 1440], maxFollowUps: 4, sessionWindowHours: 72,
      closingMessage: "Thank you! Our travel expert will contact you shortly.",
      adminAlertEnabled: false, adminAlertPhones: [], outboundNudgesEnabled: false,
    });
    const sessionId = await ctx.db.insert("qualificationSessions", {
      accountId, conversationId, contactId,
      status: "collecting", origin: "inbound",
      fields: [], expectedCount: 0, answeredCount: 0,
      followUpsSent: 0, phrasingCursor: 0, sendAttemptErrors: 0,
    });
    await ctx.db.insert("notifications", {
      accountId, userId, type: "lead_qualified", title: "New qualified lead",
    });
    expect(configId).toBeDefined();
    const bySession = await ctx.db
      .query("qualificationSessions")
      .withIndex("by_conversation", (q) => q.eq("conversationId", conversationId))
      .unique();
    expect(bySession?._id).toBe(sessionId);
  });
});
