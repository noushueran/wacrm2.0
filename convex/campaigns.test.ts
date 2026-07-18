import { convexTest } from "convex-test";
import { expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";

const modules = import.meta.glob("/convex/**/*.ts");
const DAY_MS = 24 * 60 * 60 * 1000;

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

async function seedEvent(
  t: ReturnType<typeof convexTest>,
  accountId: Id<"accounts">,
  conversationId: Id<"conversations">,
  contactId: Id<"contacts">,
  opts: { stage: string; status: string; value?: number },
) {
  await t.run((ctx) =>
    ctx.db.insert("conversionEvents", {
      accountId, conversationId, contactId,
      stage: opts.stage as "purchased", lane: "ctwa", backend: "capi", eventName: "Purchase", identifier: "c1",
      ...(opts.value !== undefined ? { value: opts.value, currency: "AED" } : {}),
      phone: "+9715", waMessageId: "w1", firstMessageAt: 1,
      eventId: `${conversationId}:${opts.stage}`, status: opts.status as "sent", attempts: 0,
    }),
  );
}

test("overview rolls up per-stage counts, purchases, and total value", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asAdmin } = await seedAdmin(t);
  await seedConv(t, accountId, "new_lead");
  await seedConv(t, accountId, "price_quoted");
  const { conversationId, contactId } = await seedConv(t, accountId, "purchased", 4200);
  // a sent Purchase conversion event
  await seedEvent(t, accountId, conversationId, contactId, { stage: "purchased", status: "sent", value: 4200 });

  const o = await asAdmin.query(api.campaigns.overview, {});
  const byStage = Object.fromEntries(o.funnel.map((f) => [f.stage, f.count]));
  expect(byStage.new_lead).toBe(1);
  expect(byStage.price_quoted).toBe(1);
  expect(byStage.purchased).toBe(1);
  expect(o.purchase.count).toBe(1);
  expect(o.purchase.totalValue).toBe(4200);
  expect(o.purchase.currency).toBe("AED");
  expect(o.meta.sent).toBe(1);
  expect(o.meta.total).toBe(1);
  expect(o.windowDays).toBe(365);
});

test("overview is admin-gated", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAdmin(t);
  const agentId = await t.run((ctx) => ctx.db.insert("users", { name: "Ag", email: "ag@example.com" }));
  await t.run((ctx) => ctx.db.insert("memberships", { userId: agentId, accountId, role: "agent", fullName: "Ag", email: "ag@example.com" }));
  const asAgent = t.withIdentity({ subject: `${agentId}|s-Ag` });
  await expect(asAgent.query(api.campaigns.overview, {})).rejects.toThrow();
});

test("overview counts DISTINCT conversations per stage (repeat transitions dedupe)", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asAdmin } = await seedAdmin(t);
  const { conversationId, contactId } = await seedConv(t, accountId, "qualified");
  // a SECOND transition into the same stage for the same conversation
  await t.run((ctx) =>
    ctx.db.insert("funnelTransitions", { accountId, conversationId, contactId, stage: "qualified", auto: false }),
  );

  const o = await asAdmin.query(api.campaigns.overview, {});
  const byStage = Object.fromEntries(o.funnel.map((f) => [f.stage, f.count]));
  expect(byStage.qualified).toBe(1);
});

// Post-rebase integration: main gave conversionEvents a 6th status
// ("dormant" — backend env unconfigured, parked until credentials exist).
// overview's meta buckets must carry it too, or dormant rows count toward
// `total` while landing in no named bucket and the /campaigns delivery grid
// stops summing.
test("meta buckets include dormant and always sum to total", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asAdmin } = await seedAdmin(t);
  const { conversationId, contactId } = await seedConv(t, accountId, "new_lead");
  await seedEvent(t, accountId, conversationId, contactId, { stage: "new_lead", status: "sent" });
  await seedEvent(t, accountId, conversationId, contactId, { stage: "qualified", status: "dormant" });
  await seedEvent(t, accountId, conversationId, contactId, { stage: "price_quoted", status: "pending" });

  const o = await asAdmin.query(api.campaigns.overview, {});
  expect(o.meta.dormant).toBe(1);
  expect(o.meta.total).toBe(3);
  expect(
    o.meta.sent + o.meta.pending + o.meta.dormant + o.meta.unmatched + o.meta.error + o.meta.abandoned,
  ).toBe(o.meta.total);
});

test("purchase totalValue sums ALL purchased events regardless of Meta delivery status", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asAdmin } = await seedAdmin(t);
  const { conversationId, contactId } = await seedConv(t, accountId, "purchased", 500);
  // Meta delivery dormant → event stays "pending", but it carries a sale value
  await seedEvent(t, accountId, conversationId, contactId, { stage: "purchased", status: "pending", value: 500 });

  const o = await asAdmin.query(api.campaigns.overview, {});
  expect(o.purchase.count).toBe(1);
  expect(o.purchase.totalValue).toBe(500); // counted even though not "sent"
  expect(o.meta.pending).toBe(1);
  expect(o.meta.sent).toBe(0);
});

test("overview excludes transitions and events older than the window", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const NOW = 1_800_000_000_000; // fixed instant (~2027)
    const t = convexTest(schema, modules);

    // Insert oldest-first so convex-test's _creationTime stays monotonic.
    vi.setSystemTime(new Date(NOW - 2000 * DAY_MS)); // ~2000 days ago: outside any window
    const { accountId, asAdmin } = await seedAdmin(t);
    const old = await seedConv(t, accountId, "purchased", 999);
    await seedEvent(t, accountId, old.conversationId, old.contactId, { stage: "purchased", status: "sent", value: 999 });

    vi.setSystemTime(new Date(NOW)); // now
    await seedConv(t, accountId, "new_lead");
    const fresh = await seedConv(t, accountId, "purchased", 100);
    await seedEvent(t, accountId, fresh.conversationId, fresh.contactId, { stage: "purchased", status: "sent", value: 100 });

    const o = await asAdmin.query(api.campaigns.overview, {});
    const byStage = Object.fromEntries(o.funnel.map((f) => [f.stage, f.count]));
    expect(byStage.new_lead).toBe(1);
    expect(byStage.purchased).toBe(1); // the ~2000-day-old purchased conversation is excluded
    expect(o.purchase.count).toBe(1);
    expect(o.purchase.totalValue).toBe(100); // old 999 excluded
    expect(o.meta.sent).toBe(1); // old event excluded
    expect(o.meta.total).toBe(1);
  } finally {
    vi.useRealTimers();
  }
});

// B2: conversionEvents rows exist ONLY for attributed (ad/website)
// conversations, but funnelTransitions exist for every conversation, incl.
// organic. totalValue must therefore be read off funnelTransitions (Task
// B1's saleValue field), not conversionEvents — else an organic purchase
// counts toward purchase.count but contributes 0 to purchase.totalValue.
test("organic purchases (no conversionEvents row at all) contribute their value via funnelTransitions", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asAdmin } = await seedAdmin(t);
  await t.run(async (ctx) => {
    const contactId = await ctx.db.insert("contacts", { accountId, phone: "+9715", phoneNormalized: "9715" });
    const conversationId = await ctx.db.insert("conversations", {
      accountId, contactId, status: "open", unreadCount: 0,
      funnel: { stage: "purchased", stageUpdatedAt: 1, saleValue: 750, saleCurrency: "AED" },
    });
    // Organic: a real applyStageTransition writes saleValue directly onto
    // the transition row (Task B1); NO conversionEvents row is ever
    // created for an organic conversation.
    await ctx.db.insert("funnelTransitions", {
      accountId, conversationId, contactId, stage: "purchased", auto: false,
      saleValue: 750, saleCurrency: "AED",
    });
  });

  const o = await asAdmin.query(api.campaigns.overview, {});
  expect(o.purchase.count).toBe(1);
  expect(o.purchase.totalValue).toBe(750); // previously 0: no conversionEvents row exists for organic
  expect(o.meta.total).toBe(0); // confirms no Meta/conversionEvents rows are involved at all
});

test("totalValue sums an organic purchase (transition-only value) AND an attributed legacy purchase (event-fallback value)", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asAdmin } = await seedAdmin(t);

  // Attributed, pre-B1-shaped row: value lives only on the conversionEvents
  // row (seedConv's transition carries no saleValue) — the fallback path.
  const { conversationId: attrConvId, contactId: attrContactId } = await seedConv(t, accountId, "purchased", 4200);
  await seedEvent(t, accountId, attrConvId, attrContactId, { stage: "purchased", status: "sent", value: 4200 });

  // Organic, post-B1-shaped row: value lives only on funnelTransitions.
  await t.run(async (ctx) => {
    const contactId = await ctx.db.insert("contacts", { accountId, phone: "+9716", phoneNormalized: "9716" });
    const conversationId = await ctx.db.insert("conversations", {
      accountId, contactId, status: "open", unreadCount: 0,
      funnel: { stage: "purchased", stageUpdatedAt: 1, saleValue: 300, saleCurrency: "AED" },
    });
    await ctx.db.insert("funnelTransitions", {
      accountId, conversationId, contactId, stage: "purchased", auto: false, saleValue: 300, saleCurrency: "AED",
    });
  });

  const o = await asAdmin.query(api.campaigns.overview, {});
  expect(o.purchase.count).toBe(2);
  expect(o.purchase.totalValue).toBe(4500); // 4200 (attributed, event-fallback) + 300 (organic, transition value)
});
