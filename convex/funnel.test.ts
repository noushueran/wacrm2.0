import { convexTest, type TestConvex } from "convex-test";
import { expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import type { AccountRole } from "./lib/roles";

const modules = import.meta.glob("/convex/**/*.ts");

async function seedAccountMember(
  t: ReturnType<typeof convexTest>,
  opts: { name: string; email: string; role: AccountRole },
) {
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { name: opts.name, email: opts.email }),
  );
  const accountId = await t.run(async (ctx) => {
    const id = await ctx.db.insert("accounts", {
      name: `${opts.name}'s account`,
      defaultCurrency: "AED",
      ownerUserId: userId,
    });
    await ctx.db.insert("memberships", {
      userId,
      accountId: id,
      role: opts.role,
      fullName: opts.name,
      email: opts.email,
    });
    return id;
  });
  return { userId, accountId, asUser: t.withIdentity({ subject: `${userId}|session-${opts.name}` }) };
}

// Seeds a contact + conversation, optionally attributed with a first-touch
// new_lead conversionEvent anchor (mimicking what Phase 1's ingest seeds).
async function seedConv(
  t: ReturnType<typeof convexTest>,
  accountId: Id<"accounts">,
  opts: { lane?: "code" | "ctwa"; identifier?: string; assignedToUserId?: Id<"users"> } = {},
) {
  return await t.run(async (ctx) => {
    const contactId = await ctx.db.insert("contacts", {
      accountId, phone: "+971500000000", phoneNormalized: "971500000000",
    });
    const conversationId = await ctx.db.insert("conversations", {
      accountId, contactId, status: "open", unreadCount: 0,
      assignedToUserId: opts.assignedToUserId,
      ...(opts.lane
        ? {
            attribution: {
              lane: opts.lane,
              ...(opts.lane === "code" ? { code: opts.identifier } : { ctwaClid: opts.identifier }),
              firstSeenAt: 1_000_000,
            },
          }
        : {}),
    });
    if (opts.lane) {
      await ctx.db.insert("conversionEvents", {
        accountId, conversationId, contactId,
        stage: "new_lead", lane: opts.lane,
        backend: opts.lane === "code" ? "platformA" : "capi",
        eventName: opts.lane === "code" ? "Lead" : "LeadSubmitted",
        identifier: opts.identifier!,
        phone: "971500000000", waMessageId: "wamid.first", firstMessageAt: 1_000_000,
        eventId: `${conversationId}:new_lead`, status: "pending", attempts: 0,
      });
    }
    return { contactId, conversationId };
  });
}

// `t` here is `TestConvex<typeof schema>` (not the bare `ReturnType<typeof
// convexTest>` the other helpers use) because these two call `.withIndex`:
// the unparameterized type loses this suite's concrete index names, so
// `.withIndex("by_conversation", ...)` can't resolve under `tsc --noEmit`.
// Same documented gotcha/workaround as `convex/aiReply.test.ts`'s
// `messagesFor` and `convex/automationsEngine.test.ts`'s comment on it.
async function eventsFor(t: TestConvex<typeof schema>, conversationId: Id<"conversations">) {
  return await t.run((ctx) =>
    ctx.db.query("conversionEvents").withIndex("by_conversation", (q) => q.eq("conversationId", conversationId)).collect());
}
async function transitionsFor(t: TestConvex<typeof schema>, conversationId: Id<"conversations">) {
  return await t.run((ctx) =>
    ctx.db.query("funnelTransitions").withIndex("by_conversation", (q) => q.eq("conversationId", conversationId)).collect());
}

test("setStage advances the stage, logs a transition, and seeds a capi conversion event for an ad lead", async () => {
  const t = convexTest(schema, modules);
  const { accountId, userId, asUser } = await seedAccountMember(t, { name: "Ann", email: "ann@example.com", role: "agent" });
  const { conversationId } = await seedConv(t, accountId, { lane: "ctwa", identifier: "clid-1", assignedToUserId: userId });

  await asUser.mutation(api.funnel.setStage, { conversationId, stage: "price_quoted" });

  const conv = await t.run((ctx) => ctx.db.get(conversationId));
  expect(conv?.funnel?.stage).toBe("price_quoted");
  expect(conv?.funnel?.stageUpdatedByUserId).toBe(userId);

  const evs = await eventsFor(t, conversationId);
  const quote = evs.find((e) => e.stage === "price_quoted");
  expect(quote?.backend).toBe("capi");
  expect(quote?.eventName).toBe("InitiateCheckout");
  expect(quote?.identifier).toBe("clid-1");
  expect(quote?.eventId).toBe(`${conversationId}:price_quoted`);

  const trans = await transitionsFor(t, conversationId);
  const t2 = trans.find((x) => x.stage === "price_quoted");
  expect(t2?.auto).toBe(false);
  expect(t2?.byUserId).toBe(userId);
  expect(t2?.conversionEventId).toBe(quote?._id);
});

test("setStage purchased requires a sale value; with one, seeds a Purchase event carrying value+currency", async () => {
  const t = convexTest(schema, modules);
  const { accountId, userId, asUser } = await seedAccountMember(t, { name: "Ben", email: "ben@example.com", role: "agent" });
  const { conversationId } = await seedConv(t, accountId, { lane: "ctwa", identifier: "clid-2", assignedToUserId: userId });

  await expect(
    asUser.mutation(api.funnel.setStage, { conversationId, stage: "purchased" }),
  ).rejects.toThrow();

  await asUser.mutation(api.funnel.setStage, { conversationId, stage: "purchased", saleValue: 4200 });

  const conv = await t.run((ctx) => ctx.db.get(conversationId));
  expect(conv?.funnel?.stage).toBe("purchased");
  expect(conv?.funnel?.saleValue).toBe(4200);
  expect(conv?.funnel?.saleCurrency).toBe("AED"); // account defaultCurrency

  const evs = await eventsFor(t, conversationId);
  const purchase = evs.find((e) => e.stage === "purchased");
  expect(purchase?.eventName).toBe("Purchase");
  expect(purchase?.value).toBe(4200);
  expect(purchase?.currency).toBe("AED");
});

test("setStage to an internal-only stage logs a transition but seeds NO conversion event", async () => {
  const t = convexTest(schema, modules);
  const { accountId, userId, asUser } = await seedAccountMember(t, { name: "Cyd", email: "cyd@example.com", role: "agent" });
  const { conversationId } = await seedConv(t, accountId, { lane: "ctwa", identifier: "clid-3", assignedToUserId: userId });

  await asUser.mutation(api.funnel.setStage, { conversationId, stage: "itinerary_created" });

  const evs = await eventsFor(t, conversationId);
  expect(evs.some((e) => e.stage === "itinerary_created")).toBe(false);
  const trans = await transitionsFor(t, conversationId);
  expect(trans.some((x) => x.stage === "itinerary_created")).toBe(true);
});

test("setStage on an ORGANIC conversation records CRM state only (no conversion event)", async () => {
  const t = convexTest(schema, modules);
  const { accountId, userId, asUser } = await seedAccountMember(t, { name: "Dan", email: "dan@example.com", role: "agent" });
  const { conversationId } = await seedConv(t, accountId, { assignedToUserId: userId }); // no lane = organic

  await asUser.mutation(api.funnel.setStage, { conversationId, stage: "price_quoted" });

  const conv = await t.run((ctx) => ctx.db.get(conversationId));
  expect(conv?.funnel?.stage).toBe("price_quoted");
  const evs = await eventsFor(t, conversationId);
  expect(evs).toHaveLength(0);
  const trans = await transitionsFor(t, conversationId);
  expect(trans.some((x) => x.stage === "price_quoted")).toBe(true);
});

test("setStage dedups the conversion event per (conversation, stage)", async () => {
  const t = convexTest(schema, modules);
  const { accountId, userId, asUser } = await seedAccountMember(t, { name: "Eve", email: "eve@example.com", role: "agent" });
  const { conversationId } = await seedConv(t, accountId, { lane: "code", identifier: "ABCDEF", assignedToUserId: userId });

  await asUser.mutation(api.funnel.setStage, { conversationId, stage: "itinerary_sent" });
  await asUser.mutation(api.funnel.setStage, { conversationId, stage: "itinerary_sent" });

  const evs = (await eventsFor(t, conversationId)).filter((e) => e.stage === "itinerary_sent");
  expect(evs).toHaveLength(1);
  expect(evs[0].backend).toBe("platformA");
  expect(evs[0].eventName).toBe("AddToCart");
});

test("setStage is forbidden for a viewer", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountMember(t, { name: "Own", email: "own@example.com", role: "owner" });
  const { asUser: asViewer } = await (async () => {
    const uid = await t.run((ctx) => ctx.db.insert("users", { name: "Vic", email: "vic@example.com" }));
    await t.run((ctx) => ctx.db.insert("memberships", { userId: uid, accountId, role: "viewer", fullName: "Vic", email: "vic@example.com" }));
    return { asUser: t.withIdentity({ subject: `${uid}|session-Vic` }) };
  })();
  const { conversationId } = await seedConv(t, accountId, { lane: "ctwa", identifier: "clid-9" });

  await expect(
    asViewer.mutation(api.funnel.setStage, { conversationId, stage: "qualified" }),
  ).rejects.toThrow();
});

test("setStage is forbidden for an agent who is not the assignee (own-mode, not view)", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountMember(t, { name: "Own", email: "own@example.com", role: "owner" });
  // A second agent on the SAME account, NOT assigned the conversation.
  const otherAgentId = await t.run((ctx) => ctx.db.insert("users", { name: "Ari", email: "ari@example.com" }));
  await t.run((ctx) =>
    ctx.db.insert("memberships", { userId: otherAgentId, accountId, role: "agent", fullName: "Ari", email: "ari@example.com" }),
  );
  const asOtherAgent = t.withIdentity({ subject: `${otherAgentId}|session-Ari` });
  // Attributed but UNASSIGNED conversation (no assignedToUserId).
  const { conversationId } = await seedConv(t, accountId, { lane: "ctwa", identifier: "clid-own" });

  await expect(
    asOtherAgent.mutation(api.funnel.setStage, { conversationId, stage: "qualified" }),
  ).rejects.toThrow();
});
