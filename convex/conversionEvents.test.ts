import { convexTest } from "convex-test";
import { expect, test, afterEach } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";

const modules = import.meta.glob("/convex/**/*.ts");

async function seedAccount(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { name: "Acme", email: "acme@example.com" });
    return await ctx.db.insert("accounts", { name: "Acme", defaultCurrency: "USD", ownerUserId: userId });
  });
}

async function seedConversation(t: ReturnType<typeof convexTest>, accountId: Id<"accounts">) {
  return await t.run(async (ctx) => {
    const contactId = await ctx.db.insert("contacts", { accountId, phone: "+15551230000", phoneNormalized: "15551230000" });
    const conversationId = await ctx.db.insert("conversations", { accountId, contactId, status: "open", unreadCount: 0 });
    return { contactId, conversationId };
  });
}

async function seedWaba(t: ReturnType<typeof convexTest>, accountId: Id<"accounts">) {
  await t.run((ctx) =>
    ctx.db.insert("whatsappConfig", {
      accountId,
      wabaId: "WABA1",
      phoneNumberId: "PN1",
      accessToken: "test-token",
      status: "connected",
    }),
  );
}

async function seedEvent(
  t: ReturnType<typeof convexTest>,
  accountId: Id<"accounts">,
  conversationId: Id<"conversations">,
  contactId: Id<"contacts">,
  over: Partial<{ backend: "platformA" | "capi"; lane: "code" | "ctwa"; eventName: string; identifier: string; stage: string; value: number; currency: string; status: string; attempts: number }> = {},
) {
  return await t.run((ctx) =>
    ctx.db.insert("conversionEvents", {
      accountId, conversationId, contactId,
      stage: (over.stage ?? "new_lead") as "new_lead",
      lane: over.lane ?? "ctwa",
      backend: over.backend ?? "capi",
      eventName: over.eventName ?? "LeadSubmitted",
      identifier: over.identifier ?? "clid-1",
      value: over.value,
      currency: over.currency,
      phone: "+15551230000",
      waMessageId: "wamid.1",
      firstMessageAt: 1_000_000,
      eventId: `${conversationId}:${over.stage ?? "new_lead"}`,
      status: (over.status ?? "pending") as "pending",
      attempts: over.attempts ?? 0,
    }),
  );
}

const env = ["META_CAPI_DATASET_ID", "META_CAPI_ACCESS_TOKEN", "LANDING_CONVERSION_URL", "WA_CONVERSION_SHARED_SECRET"];
const orig: Record<string, string | undefined> = {};
for (const k of env) orig[k] = process.env[k];
const origFetch = globalThis.fetch;
afterEach(() => {
  for (const k of env) { if (orig[k] === undefined) delete process.env[k]; else process.env[k] = orig[k]; }
  globalThis.fetch = origFetch;
});

test("capi: dormant without env leaves the row pending (no attempt bump)", async () => {
  delete process.env.META_CAPI_DATASET_ID;
  delete process.env.META_CAPI_ACCESS_TOKEN;
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t);
  const { contactId, conversationId } = await seedConversation(t, accountId);
  await seedWaba(t, accountId);
  const id = await seedEvent(t, accountId, conversationId, contactId, { backend: "capi", lane: "ctwa" });

  await t.action(internal.conversionEvents.deliverConversionEvent, { conversionEventId: id });

  const row = await t.run((ctx) => ctx.db.get(id));
  expect(row?.status).toBe("pending");
  expect(row?.attempts).toBe(0);
});

test("capi: POSTs the business_messaging payload and marks sent + fbTraceId", async () => {
  process.env.META_CAPI_DATASET_ID = "DS1";
  process.env.META_CAPI_ACCESS_TOKEN = "tok";
  let captured: any = null;
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    captured = JSON.parse(init.body as string);
    return new Response(JSON.stringify({ fbtrace_id: "trace-9" }), { status: 200 });
  }) as typeof fetch;
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t);
  const { contactId, conversationId } = await seedConversation(t, accountId);
  await seedWaba(t, accountId);
  const id = await seedEvent(t, accountId, conversationId, contactId, {
    backend: "capi", lane: "ctwa", stage: "purchased", eventName: "Purchase", value: 1500, currency: "AED",
  });

  await t.action(internal.conversionEvents.deliverConversionEvent, { conversionEventId: id });

  const ev = captured.data[0];
  expect(ev.event_name).toBe("Purchase");
  expect(ev.action_source).toBe("business_messaging");
  expect(ev.messaging_channel).toBe("whatsapp");
  expect(ev.user_data.whatsapp_business_account_id).toBe("WABA1");
  expect(ev.user_data.ctwa_clid).toBe("clid-1");
  expect(ev.custom_data).toEqual({ value: 1500, currency: "AED" });
  const row = await t.run((ctx) => ctx.db.get(id));
  expect(row?.status).toBe("sent");
  expect(row?.fbTraceId).toBe("trace-9");
});

test("platformA: POSTs code + stage/event and marks sent on matched", async () => {
  process.env.LANDING_CONVERSION_URL = "https://a.example/whatsapp-conversion";
  process.env.WA_CONVERSION_SHARED_SECRET = "secret";
  let captured: any = null;
  let authHeader: string | null = null;
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    captured = JSON.parse(init.body as string);
    authHeader = (init.headers as Record<string, string>).Authorization;
    return new Response(JSON.stringify({ matched: true, firedAt: 123, offerSlug: "maldives" }), { status: 200 });
  }) as typeof fetch;
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t);
  const { contactId, conversationId } = await seedConversation(t, accountId);
  const id = await seedEvent(t, accountId, conversationId, contactId, {
    backend: "platformA", lane: "code", eventName: "Lead", identifier: "ABCDEF",
  });

  await t.action(internal.conversionEvents.deliverConversionEvent, { conversionEventId: id });

  expect(captured.code).toBe("ABCDEF");
  expect(captured.stage).toBe("new_lead");
  expect(captured.event).toBe("Lead");
  expect(captured.phone).toBe("+15551230000");
  expect(authHeader).toBe("Bearer secret");
  const row = await t.run((ctx) => ctx.db.get(id));
  expect(row?.status).toBe("sent");
  expect(row?.matchResult).toBe("maldives");
});

test("platformA: marks unmatched when Platform A returns matched:false", async () => {
  process.env.LANDING_CONVERSION_URL = "https://a.example/whatsapp-conversion";
  process.env.WA_CONVERSION_SHARED_SECRET = "secret";
  globalThis.fetch = (async () => new Response(JSON.stringify({ matched: false, reason: "no click" }), { status: 200 })) as typeof fetch;
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t);
  const { contactId, conversationId } = await seedConversation(t, accountId);
  const id = await seedEvent(t, accountId, conversationId, contactId, { backend: "platformA", lane: "code", eventName: "Lead", identifier: "ABCDEF" });

  await t.action(internal.conversionEvents.deliverConversionEvent, { conversionEventId: id });

  const row = await t.run((ctx) => ctx.db.get(id));
  expect(row?.status).toBe("unmatched");
});

test("platformA: a malformed 200 body is a retryable error, not terminal unmatched", async () => {
  process.env.LANDING_CONVERSION_URL = "https://a.example/whatsapp-conversion";
  process.env.WA_CONVERSION_SHARED_SECRET = "secret";
  globalThis.fetch = (async () => new Response("<html>not json</html>", { status: 200 })) as typeof fetch;
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t);
  const { contactId, conversationId } = await seedConversation(t, accountId);
  const id = await seedEvent(t, accountId, conversationId, contactId, { backend: "platformA", lane: "code", eventName: "Lead", identifier: "ABCDEF" });

  await t.action(internal.conversionEvents.deliverConversionEvent, { conversionEventId: id });

  const row = await t.run((ctx) => ctx.db.get(id));
  expect(row?.status).toBe("error");
  expect(row?.attempts).toBe(1);
});

test("error path bumps attempts; the bump that reaches MAX retires to abandoned", async () => {
  process.env.META_CAPI_DATASET_ID = "DS1";
  process.env.META_CAPI_ACCESS_TOKEN = "tok";
  globalThis.fetch = (async () => new Response("boom", { status: 500 })) as typeof fetch;
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t);
  const { contactId, conversationId } = await seedConversation(t, accountId);
  await seedWaba(t, accountId);
  const id = await seedEvent(t, accountId, conversationId, contactId, { backend: "capi", lane: "ctwa", attempts: 4 });

  await t.action(internal.conversionEvents.deliverConversionEvent, { conversionEventId: id });

  const row = await t.run((ctx) => ctx.db.get(id));
  expect(row?.status).toBe("abandoned");
  expect(row?.attempts).toBe(5);
});

test("already-sent row is a no-op (idempotent)", async () => {
  process.env.META_CAPI_DATASET_ID = "DS1";
  process.env.META_CAPI_ACCESS_TOKEN = "tok";
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return new Response("{}", { status: 200 }); }) as typeof fetch;
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t);
  const { contactId, conversationId } = await seedConversation(t, accountId);
  await seedWaba(t, accountId);
  const id = await seedEvent(t, accountId, conversationId, contactId, { backend: "capi", lane: "ctwa", status: "sent" });

  await t.action(internal.conversionEvents.deliverConversionEvent, { conversionEventId: id });
  expect(calls).toBe(0);
});

test("seedNewLead (code): sets attribution + a platformA new_lead row, once", async () => {
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t);
  const { contactId, conversationId } = await seedConversation(t, accountId);

  const first = await t.mutation(internal.conversionEvents.seedNewLead, {
    accountId, contactId, conversationId, waMessageId: "wamid.1",
    phone: "+15551230000", firstMessageAt: 1_000_000, code: "ABCDEF",
  });
  expect(first).not.toBeNull();

  const conv = await t.run((ctx) => ctx.db.get(conversationId));
  expect(conv?.attribution?.lane).toBe("code");
  expect(conv?.attribution?.code).toBe("ABCDEF");

  const rows = await t.run((ctx) =>
    ctx.db.query("conversionEvents").withIndex("by_conversation", (q) => q.eq("conversationId", conversationId)).collect());
  expect(rows).toHaveLength(1);
  expect(rows[0].backend).toBe("platformA");
  expect(rows[0].lane).toBe("code");
  expect(rows[0].eventName).toBe("Lead");
  expect(rows[0].identifier).toBe("ABCDEF");
  expect(rows[0].eventId).toBe(`${conversationId}:new_lead`);

  // Idempotent: a second call for the same conversation seeds nothing new.
  const second = await t.mutation(internal.conversionEvents.seedNewLead, {
    accountId, contactId, conversationId, waMessageId: "wamid.2",
    phone: "+15551230000", firstMessageAt: 1_000_050, code: "ABCDEF",
  });
  expect(second).toBeNull();
  const after = await t.run((ctx) =>
    ctx.db.query("conversionEvents").withIndex("by_conversation", (q) => q.eq("conversationId", conversationId)).collect());
  expect(after).toHaveLength(1);
});

test("seedNewLead (ctwa): a capi new_lead row with LeadSubmitted", async () => {
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t);
  const { contactId, conversationId } = await seedConversation(t, accountId);

  await t.mutation(internal.conversionEvents.seedNewLead, {
    accountId, contactId, conversationId, waMessageId: "wamid.1",
    phone: "+15551230000", firstMessageAt: 1_000_000, ctwaClid: "clid-9",
  });

  const conv = await t.run((ctx) => ctx.db.get(conversationId));
  expect(conv?.attribution?.lane).toBe("ctwa");
  expect(conv?.attribution?.ctwaClid).toBe("clid-9");
  const rows = await t.run((ctx) =>
    ctx.db.query("conversionEvents").withIndex("by_conversation", (q) => q.eq("conversationId", conversationId)).collect());
  expect(rows[0].backend).toBe("capi");
  expect(rows[0].eventName).toBe("LeadSubmitted");
  expect(rows[0].identifier).toBe("clid-9");
});

test("seedNewLead: code wins when both identifiers present; both retained", async () => {
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t);
  const { contactId, conversationId } = await seedConversation(t, accountId);

  await t.mutation(internal.conversionEvents.seedNewLead, {
    accountId, contactId, conversationId, waMessageId: "wamid.1",
    phone: "+15551230000", firstMessageAt: 1_000_000, code: "ABCDEF", ctwaClid: "clid-9",
  });

  const conv = await t.run((ctx) => ctx.db.get(conversationId));
  expect(conv?.attribution?.lane).toBe("code");
  expect(conv?.attribution?.code).toBe("ABCDEF");
  expect(conv?.attribution?.ctwaClid).toBe("clid-9");
  const rows = await t.run((ctx) =>
    ctx.db.query("conversionEvents").withIndex("by_conversation", (q) => q.eq("conversationId", conversationId)).collect());
  expect(rows[0].backend).toBe("platformA");
});

test("seedNewLead: returns null and writes nothing for an organic message", async () => {
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t);
  const { contactId, conversationId } = await seedConversation(t, accountId);

  const res = await t.mutation(internal.conversionEvents.seedNewLead, {
    accountId, contactId, conversationId, waMessageId: "wamid.1",
    phone: "+15551230000", firstMessageAt: 1_000_000,
  });
  expect(res).toBeNull();
  const conv = await t.run((ctx) => ctx.db.get(conversationId));
  expect(conv?.attribution).toBeUndefined();
  const rows = await t.run((ctx) =>
    ctx.db.query("conversionEvents").withIndex("by_conversation", (q) => q.eq("conversationId", conversationId)).collect());
  expect(rows).toHaveLength(0);
});
