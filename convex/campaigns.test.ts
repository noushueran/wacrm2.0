import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";

const modules = import.meta.glob("/convex/**/*.ts");

async function seedAdmin(t: ReturnType<typeof convexTest>) {
  const userId = await t.run((ctx) => ctx.db.insert("users", { name: "Ada", email: "ada@example.com" }));
  const accountId = await t.run(async (ctx) => {
    const id = await ctx.db.insert("accounts", { name: "Ada", defaultCurrency: "AED", ownerUserId: userId });
    await ctx.db.insert("memberships", { userId, accountId: id, role: "admin", fullName: "Ada", email: "ada@example.com" });
    return id;
  });
  return { userId, accountId, asAdmin: t.withIdentity({ subject: `${userId}|s-Ada` }) };
}

async function seedConv(t: ReturnType<typeof convexTest>, accountId: Id<"accounts">, stage: string, saleValue?: number) {
  return await t.run(async (ctx) => {
    const contactId = await ctx.db.insert("contacts", { accountId, phone: "+9715", phoneNormalized: "9715" });
    const conversationId = await ctx.db.insert("conversations", {
      accountId, contactId, status: "open", unreadCount: 0,
      funnel: { stage: stage as "new_lead", stageUpdatedAt: 1, ...(saleValue !== undefined ? { saleValue, saleCurrency: "AED" } : {}) },
    });
    // one transition per reached stage (simplified: just the current stage)
    await ctx.db.insert("funnelTransitions", { accountId, conversationId, contactId, stage: stage as "new_lead", auto: false });
    return { contactId, conversationId };
  });
}

test("overview rolls up per-stage counts, purchases, and Meta status", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asAdmin } = await seedAdmin(t);
  await seedConv(t, accountId, "new_lead");
  await seedConv(t, accountId, "price_quoted");
  const { conversationId, contactId } = await seedConv(t, accountId, "purchased", 4200);
  // a sent Purchase conversion event + a pending lead event
  await t.run((ctx) => ctx.db.insert("conversionEvents", {
    accountId, conversationId, contactId,
    stage: "purchased", lane: "ctwa", backend: "capi", eventName: "Purchase", identifier: "c1",
    value: 4200, currency: "AED", phone: "+9715", waMessageId: "w1", firstMessageAt: 1,
    eventId: `${conversationId}:purchased`, status: "sent", attempts: 0,
  }));

  const o = await asAdmin.query(api.campaigns.overview, {});
  const byStage = Object.fromEntries(o.funnel.map((f) => [f.stage, f.count]));
  expect(byStage.new_lead).toBe(1);
  expect(byStage.price_quoted).toBe(1);
  expect(byStage.purchased).toBe(1);
  expect(o.purchase.count).toBe(1);
  expect(o.purchase.reportedValue).toBe(4200);
  expect(o.purchase.currency).toBe("AED");
  expect(o.meta.sent).toBe(1);
  expect(o.meta.total).toBe(1);
});

test("overview is admin-gated", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAdmin(t);
  const agentId = await t.run((ctx) => ctx.db.insert("users", { name: "Ag", email: "ag@example.com" }));
  await t.run((ctx) => ctx.db.insert("memberships", { userId: agentId, accountId, role: "agent", fullName: "Ag", email: "ag@example.com" }));
  const asAgent = t.withIdentity({ subject: `${agentId}|s-Ag` });
  await expect(asAgent.query(api.campaigns.overview, {})).rejects.toThrow();
});
