import { convexTest } from "convex-test";
import { expect, test, afterEach, vi } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import { MAX_DELIVER_ATTEMPTS } from "./conversionEvents";

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

test("capi: dormant without env retires the row out of the retry partitions (no attempt bump)", async () => {
  delete process.env.META_CAPI_DATASET_ID;
  delete process.env.META_CAPI_ACCESS_TOKEN;
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t);
  const { contactId, conversationId } = await seedConversation(t, accountId);
  await seedWaba(t, accountId);
  const id = await seedEvent(t, accountId, conversationId, contactId, { backend: "capi", lane: "ctwa" });

  await t.action(internal.conversionEvents.deliverConversionEvent, { conversionEventId: id });

  const row = await t.run((ctx) => ctx.db.get(id));
  // Its own status, not `"abandoned"` with an `attempts` tiebreak: dormant is
  // re-sweepable and given-up is not, so they get separate partitions rather
  // than a `.filter()` to tell them apart.
  expect(row?.status).toBe("dormant");
  expect(row?.attempts).toBe(0);
  expect(row?.lastError).toContain("dormant");
});

test("capi: an account with no wabaId is dormant-retired, not left pending", async () => {
  process.env.META_CAPI_DATASET_ID = "DS1";
  process.env.META_CAPI_ACCESS_TOKEN = "tok";
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t);
  const { contactId, conversationId } = await seedConversation(t, accountId);
  // No seedWaba — the account has no WABA configured.
  const id = await seedEvent(t, accountId, conversationId, contactId, { backend: "capi", lane: "ctwa" });

  await t.action(internal.conversionEvents.deliverConversionEvent, { conversionEventId: id });

  const row = await t.run((ctx) => ctx.db.get(id));
  expect(row?.status).toBe("dormant");
  expect(row?.attempts).toBe(0);
});

test("platformA: dormant without env retires the row (no attempt bump)", async () => {
  delete process.env.LANDING_CONVERSION_URL;
  delete process.env.WA_CONVERSION_SHARED_SECRET;
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t);
  const { contactId, conversationId } = await seedConversation(t, accountId);
  const id = await seedEvent(t, accountId, conversationId, contactId, { backend: "platformA", lane: "code" });

  await t.action(internal.conversionEvents.deliverConversionEvent, { conversionEventId: id });

  const row = await t.run((ctx) => ctx.db.get(id));
  expect(row?.status).toBe("dormant");
  expect(row?.attempts).toBe(0);
});

// ------------------------------------------------------------
// Transient (429/5xx) vs permanent errors — the retry budget must only
// ever be spent on errors that are actually the row's fault.
// ------------------------------------------------------------

test("capi: a 429 re-queues as error WITHOUT bumping attempts — rate limiting can never retire a live conversion", async () => {
  process.env.META_CAPI_DATASET_ID = "DS1";
  process.env.META_CAPI_ACCESS_TOKEN = "tok";
  globalThis.fetch = (async () => new Response("rate limited", { status: 429 })) as typeof fetch;
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t);
  const { contactId, conversationId } = await seedConversation(t, accountId);
  await seedWaba(t, accountId);
  // One bump away from the give-up cap: a 429 here used to abandon the row
  // and lose the conversion permanently.
  const id = await seedEvent(t, accountId, conversationId, contactId, { backend: "capi", lane: "ctwa", attempts: 4 });

  await t.action(internal.conversionEvents.deliverConversionEvent, { conversionEventId: id });

  const row = await t.run((ctx) => ctx.db.get(id));
  expect(row?.status).toBe("error");
  expect(row?.attempts).toBe(4);
  // Still selectable by the cron — the whole point.
  const batch = await t.query(internal.conversionEvents.getPendingToRetry, {});
  expect(batch.map((r) => r._id)).toContain(id);
});

test("capi: a 5xx re-queues as error WITHOUT bumping attempts", async () => {
  process.env.META_CAPI_DATASET_ID = "DS1";
  process.env.META_CAPI_ACCESS_TOKEN = "tok";
  globalThis.fetch = (async () => new Response("upstream down", { status: 503 })) as typeof fetch;
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t);
  const { contactId, conversationId } = await seedConversation(t, accountId);
  await seedWaba(t, accountId);
  const id = await seedEvent(t, accountId, conversationId, contactId, { backend: "capi", lane: "ctwa", attempts: 4 });

  await t.action(internal.conversionEvents.deliverConversionEvent, { conversionEventId: id });

  const row = await t.run((ctx) => ctx.db.get(id));
  expect(row?.status).toBe("error");
  expect(row?.attempts).toBe(4);
});

test("platformA: a 429 re-queues as error WITHOUT bumping attempts", async () => {
  process.env.LANDING_CONVERSION_URL = "https://a.example/whatsapp-conversion";
  process.env.WA_CONVERSION_SHARED_SECRET = "secret";
  globalThis.fetch = (async () => new Response("slow down", { status: 429 })) as typeof fetch;
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t);
  const { contactId, conversationId } = await seedConversation(t, accountId);
  const id = await seedEvent(t, accountId, conversationId, contactId, { backend: "platformA", lane: "code", attempts: 4 });

  await t.action(internal.conversionEvents.deliverConversionEvent, { conversionEventId: id });

  const row = await t.run((ctx) => ctx.db.get(id));
  expect(row?.status).toBe("error");
  expect(row?.attempts).toBe(4);
});

test("capi: POSTs the business_messaging payload and marks sent + fbTraceId", async () => {
  process.env.META_CAPI_DATASET_ID = "DS1";
  process.env.META_CAPI_ACCESS_TOKEN = "tok";
  let captured:
    | {
        data: Array<{
          event_name: string;
          action_source: string;
          messaging_channel: string;
          user_data: Record<string, string>;
          custom_data: Record<string, unknown>;
        }>;
      }
    | null = null;
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

  const ev = captured!.data[0];
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
  let captured:
    | { code: string; stage: string; event: string; phone: string }
    | null = null;
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

  expect(captured!.code).toBe("ABCDEF");
  expect(captured!.stage).toBe("new_lead");
  expect(captured!.event).toBe("Lead");
  expect(captured!.phone).toBe("+15551230000");
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

test("a permanent (4xx) error bumps attempts; the bump that reaches MAX retires to abandoned", async () => {
  process.env.META_CAPI_DATASET_ID = "DS1";
  process.env.META_CAPI_ACCESS_TOKEN = "tok";
  // 400, not 429/5xx: a genuinely bad request is the row's own fault and
  // must still be able to exhaust the budget and give up.
  globalThis.fetch = (async () => new Response("bad payload", { status: 400 })) as typeof fetch;
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

test("a network failure (no HTTP status) bumps attempts — still terminal after MAX", async () => {
  process.env.META_CAPI_DATASET_ID = "DS1";
  process.env.META_CAPI_ACCESS_TOKEN = "tok";
  globalThis.fetch = (async () => { throw new Error("ECONNREFUSED"); }) as typeof fetch;
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

// ------------------------------------------------------------
// getPendingToRetry / retryConversionEvents — window saturation + fan-out.
// ------------------------------------------------------------

test("dormant rows never saturate the retry window: a newer pending row is still reachable behind 100 of them", async () => {
  delete process.env.META_CAPI_DATASET_ID;
  delete process.env.META_CAPI_ACCESS_TOKEN;
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t);
  const { contactId, conversationId } = await seedConversation(t, accountId);
  await seedWaba(t, accountId);

  // Exactly the prod shape: CAPI env unset, so every CTWA ad lead seeds a row
  // that delivery can do nothing with. 100 of them = the cron's whole
  // oldest-first `.take(100)` budget.
  for (let i = 0; i < 100; i++) {
    const id = await t.run((ctx) =>
      ctx.db.insert("conversionEvents", {
        accountId, conversationId, contactId,
        stage: "new_lead", lane: "ctwa", backend: "capi",
        eventName: "LeadSubmitted", identifier: `clid-${i}`,
        phone: "+15551230000", waMessageId: `wamid.${i}`, firstMessageAt: 1_000_000,
        eventId: `${conversationId}:dormant-${i}`, status: "pending", attempts: 0,
      }),
    );
    await t.action(internal.conversionEvents.deliverConversionEvent, { conversionEventId: id });
  }

  // A fresh lead arrives *after* that backlog.
  const fresh = await t.run((ctx) =>
    ctx.db.insert("conversionEvents", {
      accountId, conversationId, contactId,
      stage: "new_lead", lane: "code", backend: "platformA",
      eventName: "Lead", identifier: "ABCDEF",
      phone: "+15551230000", waMessageId: "wamid.fresh", firstMessageAt: 2_000_000,
      eventId: `${conversationId}:fresh`, status: "pending", attempts: 0,
    }),
  );

  const batch = await t.query(internal.conversionEvents.getPendingToRetry, {});
  expect(batch.map((r) => r._id)).toContain(fresh);
});

test("retryConversionEvents staggers its fan-out instead of firing 100 Graph POSTs at once", async () => {
  process.env.META_CAPI_DATASET_ID = "DS1";
  process.env.META_CAPI_ACCESS_TOKEN = "tok";
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t);
  const { contactId, conversationId } = await seedConversation(t, accountId);
  await seedWaba(t, accountId);
  for (let i = 0; i < 5; i++) {
    await t.run((ctx) =>
      ctx.db.insert("conversionEvents", {
        accountId, conversationId, contactId,
        stage: "new_lead", lane: "ctwa", backend: "capi",
        eventName: "LeadSubmitted", identifier: `clid-${i}`,
        phone: "+15551230000", waMessageId: `wamid.${i}`, firstMessageAt: 1_000_000,
        eventId: `${conversationId}:stagger-${i}`, status: "pending", attempts: 0,
      }),
    );
  }

  await t.action(internal.conversionEvents.retryConversionEvents, {});

  const scheduled = await t.run((ctx) =>
    ctx.db.system.query("_scheduled_functions").collect());
  expect(scheduled).toHaveLength(5);
  const times = scheduled.map((s) => s.scheduledTime).sort((a, b) => a - b);
  // Each successive delivery is at least one stagger step later than the
  // last; `runAfter(0)` for all 5 would leave these within a millisecond.
  for (let i = 1; i < times.length; i++) {
    expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(100);
  }
});

/**
 * `getDormantToSweep` reads `by_status_backend` with BOTH keys bound, so it
 * has no `.filter()` left: one range per configured backend. Previously it
 * ranged `"abandoned"` and filtered on `attempts < MAX` plus the backend list —
 * a scan across a partition that genuinely-given-up rows never leave, so it
 * walked further every time one accumulated. This asserts the three things
 * that separation buys: the other backend's dormant rows are not swept, a
 * given-up row is not swept, and a live pending row is not swept.
 */
test("getDormantToSweep returns only dormant rows for the configured backend", async () => {
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t);
  const { contactId, conversationId } = await seedConversation(t, accountId);

  const capiDormant = await seedEvent(t, accountId, conversationId, contactId, {
    backend: "capi", stage: "new_lead", status: "dormant", attempts: 0,
  });
  await seedEvent(t, accountId, conversationId, contactId, {
    backend: "platformA", stage: "qualified", status: "dormant", attempts: 0,
  });
  await seedEvent(t, accountId, conversationId, contactId, {
    backend: "capi", stage: "purchased", status: "abandoned", attempts: 5,
  });
  await seedEvent(t, accountId, conversationId, contactId, {
    backend: "capi", stage: "invoice_sent", status: "pending", attempts: 0,
  });

  const swept = await t.run(() =>
    t.query(internal.conversionEvents.getDormantToSweep, { backends: ["capi"] }),
  );

  expect(swept.map((r) => r._id)).toEqual([capiDormant]);
});

/**
 * Rows retired by the PREVIOUS release are sitting at `"abandoned"` with
 * `attempts < MAX`, which the new sweep no longer reads. Production has 19 of
 * them — real undelivered CTWA conversions — so without this migration they
 * would never deliver once CAPI is configured, silently. `attempts` is what
 * identifies them: the give-up path can only ever land on `>= MAX`.
 */
test("migrateDormantOutOfAbandoned reclassifies legacy rows and leaves genuine give-ups alone", async () => {
  vi.useFakeTimers();
  try {
    const t = convexTest(schema, modules);
    const accountId = await seedAccount(t);
    const { contactId, conversationId } = await seedConversation(t, accountId);

    const legacyDormant = await seedEvent(t, accountId, conversationId, contactId, {
      backend: "capi", stage: "new_lead", status: "abandoned", attempts: 0,
    });
    const gaveUp = await seedEvent(t, accountId, conversationId, contactId, {
      backend: "capi", stage: "purchased", status: "abandoned", attempts: MAX_DELIVER_ATTEMPTS,
    });

    await t.mutation(internal.conversionEvents.migrateDormantOutOfAbandoned, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect((await t.run((ctx) => ctx.db.get(legacyDormant)))?.status).toBe("dormant");
    expect((await t.run((ctx) => ctx.db.get(gaveUp)))?.status).toBe("abandoned");
  } finally {
    vi.useRealTimers();
  }
});

test("retryConversionEvents leaves dormant rows alone while their backend is unconfigured, and re-sweeps them once it is", async () => {
  delete process.env.META_CAPI_DATASET_ID;
  delete process.env.META_CAPI_ACCESS_TOKEN;
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t);
  const { contactId, conversationId } = await seedConversation(t, accountId);
  await seedWaba(t, accountId);
  const id = await seedEvent(t, accountId, conversationId, contactId, { backend: "capi", lane: "ctwa" });
  await t.action(internal.conversionEvents.deliverConversionEvent, { conversionEventId: id });
  expect((await t.run((ctx) => ctx.db.get(id)))?.status).toBe("dormant");

  // Env still unset: sweeping it would only churn the scheduler.
  await t.action(internal.conversionEvents.retryConversionEvents, {});
  expect(await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect())).toHaveLength(0);

  // Env now configured — the row must come back and deliver.
  process.env.META_CAPI_DATASET_ID = "DS1";
  process.env.META_CAPI_ACCESS_TOKEN = "tok";
  globalThis.fetch = (async () => new Response(JSON.stringify({ fbtrace_id: "trace-1" }), { status: 200 })) as typeof fetch;

  vi.useFakeTimers();
  try {
    await t.action(internal.conversionEvents.retryConversionEvents, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
  } finally {
    vi.useRealTimers();
  }

  const row = await t.run((ctx) => ctx.db.get(id));
  expect(row?.status).toBe("sent");
  expect(row?.fbTraceId).toBe("trace-1");
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
