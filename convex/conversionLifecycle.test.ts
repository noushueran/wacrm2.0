// ============================================================
// Acceptance tests for the Meta lead-lifecycle CAPI integration —
// one test per lettered case in the integration spec's §20, in order,
// named so a failure reads back as the acceptance criterion it broke.
//
// These are BEHAVIOURAL and end-to-end within the backend: they drive
// the real `funnel.setStage` mutation an agent drives from the UI and
// assert on the real `conversionEvents` outbox, rather than calling the
// seeding helpers directly. The defect class they exist for is
// "every lead fires all four events" — which every unit test of a single
// stage passes and which only a whole-journey test can catch.
//
// EVENT NAMES. The spec's illustrative names (`MarketingQualifiedLead`,
// `SalesQualifiedLead`, `ConvertedLead`) are NOT what goes on the wire on
// the WhatsApp/CTWA lane, and these tests pin the names that do. Meta's
// Conversions API for Business Messaging accepts a FIXED event
// vocabulary — Purchase, LeadSubmitted, InitiateCheckout, AddToCart,
// ViewContent, OrderCreated, OrderShipped, OrderDelivered, OrderCanceled,
// OrderReturned, CartAbandoned, QualifiedLead, RatingProvided,
// ReviewProvided — and an invented name is not a custom event there, it
// is a rejected one. The spec anticipates exactly this ("follow the
// latest official Meta developer specification"); the lifecycle→event
// mapping is documented in META_MANUAL_SETUP.md and pinned in
// `convex/lib/funnel.ts`.
// ============================================================

import { convexTest, type TestConvex } from "convex-test";
import { expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";

const modules = import.meta.glob("/convex/**/*.ts");

/**
 * The four business milestones the spec names, and the CRM stage +
 * on-the-wire CTWA event name each one actually is. SQL maps to
 * `price_quoted` because that is the stage whose entry criteria match the
 * spec's §2.3 evidence for Sales Qualified — a quotation discussed or
 * sent, a real next sales step — rather than because of any name
 * similarity.
 */
const LIFECYCLE = {
  lead: { stage: "new_lead", event: "LeadSubmitted" },
  mql: { stage: "qualified", event: "QualifiedLead" },
  sql: { stage: "price_quoted", event: "InitiateCheckout" },
  converted: { stage: "purchased", event: "Purchase" },
} as const;

async function seedAgent(t: ReturnType<typeof convexTest>, name: string) {
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { name, email: `${name}@example.com` }),
  );
  const accountId = await t.run(async (ctx) => {
    const id = await ctx.db.insert("accounts", {
      name: `${name} account`,
      defaultCurrency: "AED",
      ownerUserId: userId,
    });
    await ctx.db.insert("memberships", {
      userId,
      accountId: id,
      role: "agent",
      fullName: name,
      email: `${name}@example.com`,
    });
    return id;
  });
  return {
    userId,
    accountId,
    asAgent: t.withIdentity({ subject: `${userId}|session-${name}` }),
  };
}

/**
 * A Click-to-WhatsApp lead as it stands the instant after ingest: the
 * conversation carries its `ctwa_clid` attribution and the ONE first-touch
 * `new_lead` outbox row, and nothing else. Every test starts here, so
 * "which events exist now" is always a statement about what the journey
 * under test caused.
 */
async function seedCtwaLead(
  t: ReturnType<typeof convexTest>,
  accountId: Id<"accounts">,
  assignedToUserId: Id<"users">,
  clid: string,
) {
  return await t.run(async (ctx) => {
    const contactId = await ctx.db.insert("contacts", {
      accountId,
      phone: "+971585824488",
      phoneNormalized: "971585824488",
    });
    const conversationId = await ctx.db.insert("conversations", {
      accountId,
      contactId,
      status: "open",
      unreadCount: 0,
      assignedToUserId,
      attribution: { lane: "ctwa", ctwaClid: clid, firstSeenAt: 1_000_000 },
    });
    await ctx.db.insert("conversionEvents", {
      accountId,
      conversationId,
      contactId,
      stage: "new_lead",
      lane: "ctwa",
      backend: "capi",
      eventName: "LeadSubmitted",
      identifier: clid,
      phone: "971585824488",
      waMessageId: "wamid.first",
      firstMessageAt: 1_000_000,
      eventId: `${conversationId}:new_lead`,
      status: "pending",
      attempts: 0,
    });
    return { contactId, conversationId };
  });
}

async function eventsFor(
  t: TestConvex<typeof schema>,
  conversationId: Id<"conversations">,
) {
  return await t.run((ctx) =>
    ctx.db
      .query("conversionEvents")
      .withIndex("by_conversation", (q) => q.eq("conversationId", conversationId))
      .collect(),
  );
}

/** The event names actually queued for Meta, sorted for stable compare. */
async function firedEvents(
  t: TestConvex<typeof schema>,
  conversationId: Id<"conversations">,
) {
  return (await eventsFor(t, conversationId)).map((e) => e.eventName).sort();
}

// ---------- Test A — Junk lead ----------
// The headline requirement: a lead that never qualifies must send Lead
// and NOTHING else. This is the test that fails if anyone ever "helpfully"
// pre-seeds the downstream milestones at lead creation.
test("A: a junk lead fires Lead only — no MQL, SQL or Converted", async () => {
  const t = convexTest(schema, modules);
  const { accountId, userId, asAgent } = await seedAgent(t, "Ann");
  const { conversationId } = await seedCtwaLead(t, accountId, userId, "clid-A");

  // Classified as junk — a terminal exit, not a milestone.
  await asAgent.mutation(api.funnel.setStage, {
    conversationId,
    stage: "lost",
    // `other` — the junk bucket. `LOSS_CATEGORIES` is a fixed sales
    // vocabulary (price/competitor/budget/timing/unresponsive/
    // changed_plans/other) with no spam entry; the detail carries the why.
    lossCategory: "other",
    lossDetail: "Supplier solicitation, not a customer",
  });

  expect(await firedEvents(t, conversationId)).toEqual(["LeadSubmitted"]);
});

// ---------- Test B — Qualified but not sales ready ----------
test("B: a qualified-but-not-sales-ready lead fires Lead + MQL only", async () => {
  const t = convexTest(schema, modules);
  const { accountId, userId, asAgent } = await seedAgent(t, "Ben");
  const { conversationId } = await seedCtwaLead(t, accountId, userId, "clid-B");

  await asAgent.mutation(api.funnel.setStage, {
    conversationId,
    stage: LIFECYCLE.mql.stage,
  });

  expect(await firedEvents(t, conversationId)).toEqual([
    LIFECYCLE.mql.event,
    LIFECYCLE.lead.event,
  ].sort());
});

// ---------- Test C — Serious opportunity, no payment ----------
test("C: a serious opportunity that never pays fires Lead + MQL + SQL, never Converted", async () => {
  const t = convexTest(schema, modules);
  const { accountId, userId, asAgent } = await seedAgent(t, "Cyd");
  const { conversationId } = await seedCtwaLead(t, accountId, userId, "clid-C");

  await asAgent.mutation(api.funnel.setStage, { conversationId, stage: LIFECYCLE.mql.stage });
  await asAgent.mutation(api.funnel.setStage, { conversationId, stage: LIFECYCLE.sql.stage });
  // An itinerary went out and an invoice was raised — the spec is explicit
  // that neither is a conversion. They map to their own Meta events; what
  // matters here is that Purchase is not among them.
  await asAgent.mutation(api.funnel.setStage, { conversationId, stage: "itinerary_sent" });
  await asAgent.mutation(api.funnel.setStage, { conversationId, stage: "invoice_sent" });

  const fired = await firedEvents(t, conversationId);
  expect(fired).toContain(LIFECYCLE.lead.event);
  expect(fired).toContain(LIFECYCLE.mql.event);
  expect(fired).toContain(LIFECYCLE.sql.event);
  // Invoice sent is NOT converted. Money has not arrived.
  expect(fired).not.toContain(LIFECYCLE.converted.event);
});

// ---------- Test D — Paying customer ----------
test("D: a paying customer fires all four, and Converted carries value + currency", async () => {
  const t = convexTest(schema, modules);
  const { accountId, userId, asAgent } = await seedAgent(t, "Dee");
  const { conversationId } = await seedCtwaLead(t, accountId, userId, "clid-D");

  await asAgent.mutation(api.funnel.setStage, { conversationId, stage: LIFECYCLE.mql.stage });
  await asAgent.mutation(api.funnel.setStage, { conversationId, stage: LIFECYCLE.sql.stage });
  await asAgent.mutation(api.funnel.setStage, {
    conversationId,
    stage: LIFECYCLE.converted.stage,
    saleValue: 2499,
  });

  const fired = await firedEvents(t, conversationId);
  for (const m of Object.values(LIFECYCLE)) expect(fired).toContain(m.event);

  const purchase = (await eventsFor(t, conversationId)).find(
    (e) => e.stage === LIFECYCLE.converted.stage,
  );
  expect(purchase?.value).toBe(2499);
  expect(purchase?.currency).toBe("AED");
});

// Converted must not be reachable without money, whatever the UI does.
test("D': Converted cannot be recorded without a sale value", async () => {
  const t = convexTest(schema, modules);
  const { accountId, userId, asAgent } = await seedAgent(t, "Dan");
  const { conversationId } = await seedCtwaLead(t, accountId, userId, "clid-D2");

  await expect(
    asAgent.mutation(api.funnel.setStage, {
      conversationId,
      stage: LIFECYCLE.converted.stage,
    }),
  ).rejects.toThrow();

  expect(await firedEvents(t, conversationId)).toEqual([LIFECYCLE.lead.event]);
});

// ---------- Test E — Save the same stage twice ----------
test("E: re-saving the same stage fires the lifecycle event exactly once", async () => {
  const t = convexTest(schema, modules);
  const { accountId, userId, asAgent } = await seedAgent(t, "Eve");
  const { conversationId } = await seedCtwaLead(t, accountId, userId, "clid-E");

  await asAgent.mutation(api.funnel.setStage, { conversationId, stage: LIFECYCLE.mql.stage });
  await asAgent.mutation(api.funnel.setStage, { conversationId, stage: LIFECYCLE.mql.stage });
  await asAgent.mutation(api.funnel.setStage, { conversationId, stage: LIFECYCLE.mql.stage });

  const mqls = (await eventsFor(t, conversationId)).filter(
    (e) => e.eventName === LIFECYCLE.mql.event,
  );
  expect(mqls).toHaveLength(1);
  // The CRM audit trail still records all three saves — deduping the Meta
  // event must not cost the internal history.
  const transitions = await t.run((ctx) =>
    ctx.db
      .query("funnelTransitions")
      .withIndex("by_conversation", (q) => q.eq("conversationId", conversationId))
      .collect(),
  );
  expect(
    transitions.filter((tr) => tr.stage === LIFECYCLE.mql.stage).length,
  ).toBe(3);
});

// ---------- Test F — Temporary Meta failure ----------
// The retry/backoff mechanics themselves are covered exhaustively in
// conversionEvents.test.ts (transient vs permanent budgets, the abandon
// threshold). What this asserts is the acceptance criterion those tests
// do not state in the spec's own terms: a transient failure keeps the row
// queued under its ORIGINAL identity, so a retry cannot become a second
// logical event.
test("F: a transient failure re-queues the same event_id without spending the permanent budget", async () => {
  const origFetch = globalThis.fetch;
  process.env.META_CAPI_DATASET_ID = "DS1";
  process.env.META_CAPI_ACCESS_TOKEN = "tok";
  let attempts = 0;
  const seenEventIds: string[] = [];
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    attempts += 1;
    const body = JSON.parse(init.body as string) as {
      data: Array<{ event_id: string }>;
    };
    seenEventIds.push(body.data[0].event_id);
    // Fail transiently once (503), then succeed.
    return attempts === 1
      ? new Response("upstream down", { status: 503 })
      : new Response(JSON.stringify({ fbtrace_id: "trace-F" }), { status: 200 });
  }) as typeof fetch;

  try {
    const t = convexTest(schema, modules);
    const { accountId, userId } = await seedAgent(t, "Fay");
    await t.run((ctx) =>
      ctx.db.insert("whatsappConfig", {
        accountId,
        wabaId: "WABA-F",
        phoneNumberId: "PN-F",
        accessToken: "wa-token",
        status: "connected",
      }),
    );
    const { conversationId } = await seedCtwaLead(t, accountId, userId, "clid-F");
    const row = (await eventsFor(t, conversationId))[0];

    const { internal } = await import("./_generated/api");
    await t.action(internal.conversionEvents.deliverConversionEvent, {
      conversionEventId: row._id,
    });

    const afterFail = await t.run((ctx) => ctx.db.get(row._id));
    expect(afterFail?.status).toBe("error");
    // A 503 is the backend's fault, not the row's: the permanent budget
    // is untouched, so an outage cannot retire a live conversion.
    expect(afterFail?.attempts).toBe(0);
    expect(afterFail?.transientAttempts).toBe(1);

    // Clear the backoff gate the way the passage of time would, then retry.
    await t.run((ctx) => ctx.db.patch(row._id, { nextAttemptAt: 0 }));
    await t.action(internal.conversionEvents.deliverConversionEvent, {
      conversionEventId: row._id,
    });

    const afterRetry = await t.run((ctx) => ctx.db.get(row._id));
    expect(afterRetry?.status).toBe("sent");
    // ONE logical event: the same identity on both attempts, so Meta
    // dedupes them into one even though two POSTs were made.
    expect(seenEventIds).toEqual([
      `${conversationId}:new_lead`,
      `${conversationId}:new_lead`,
    ]);
    // And still exactly one outbox row — a retry never mints a new one.
    expect(await eventsFor(t, conversationId)).toHaveLength(1);
  } finally {
    globalThis.fetch = origFetch;
    delete process.env.META_CAPI_DATASET_ID;
    delete process.env.META_CAPI_ACCESS_TOKEN;
  }
});

// ---------- Test G — Website Pixel + CAPI Lead deduplication ----------
// On the website lane the browser Pixel and this server both report the
// original Lead. Meta collapses them only if BOTH copies carry the same
// event name and the same event_id, and the downstream milestones must
// stay distinct events rather than being deduped against Lead.
test("G: the website lane's Lead carries a stable dedup id, distinct from later milestones", async () => {
  const t = convexTest(schema, modules);
  const { accountId, userId, asAgent } = await seedAgent(t, "Gus");
  const { conversationId } = await t.run(async (ctx) => {
    const contactId = await ctx.db.insert("contacts", {
      accountId,
      phone: "+971585824488",
      phoneNormalized: "971585824488",
    });
    const cid = await ctx.db.insert("conversations", {
      accountId,
      contactId,
      status: "open",
      unreadCount: 0,
      assignedToUserId: userId,
      attribution: { lane: "code", code: "ABCDEF", firstSeenAt: 1_000_000 },
    });
    await ctx.db.insert("conversionEvents", {
      accountId,
      conversationId: cid,
      contactId,
      stage: "new_lead",
      lane: "code",
      backend: "platformA",
      eventName: "Lead",
      identifier: "ABCDEF",
      phone: "971585824488",
      waMessageId: "wamid.web",
      firstMessageAt: 1_000_000,
      eventId: `${cid}:new_lead`,
      status: "pending",
      attempts: 0,
    });
    return { conversationId: cid };
  });

  await asAgent.mutation(api.funnel.setStage, { conversationId, stage: LIFECYCLE.mql.stage });

  const events = await eventsFor(t, conversationId);
  const lead = events.find((e) => e.stage === "new_lead")!;
  const mql = events.find((e) => e.stage === LIFECYCLE.mql.stage)!;

  // Deterministic and derived from the lead, so the browser copy can be
  // given the identical value and Meta collapses the pair.
  expect(lead.eventId).toBe(`${conversationId}:new_lead`);
  // The web lane fires the standard web-Pixel name for Lead.
  expect(lead.eventName).toBe("Lead");
  // The MQL is a SEPARATE event: a different event_id, so Meta cannot
  // collapse it into the Lead the browser Pixel also reported.
  expect(mql.eventId).not.toBe(lead.eventId);
});

// KNOWN LIMITATION, pinned deliberately rather than left to be discovered
// in Events Manager.
//
// On the WEBSITE (code) lane, `FUNNEL_STAGES` maps BOTH `new_lead` and
// `qualified` to the web-Pixel event name "Lead". The two are distinct
// events to Meta (different event_id, so they are not deduped) but they
// are INDISTINGUISHABLE BY NAME — so the website lane currently carries
// no separate MQL signal to optimize toward, which is the very thing this
// integration exists to provide. The CTWA lane does not have this problem:
// it maps qualified to Meta's distinct `QualifiedLead`.
//
// Not silently "fixed" here because `webPixel` names are the wire contract
// with the external landing site that fires them (the `platformA`
// backend), and renaming one changes what that service receives. Unlike
// business messaging, the web Pixel DOES accept custom event names, so the
// fix is available — it is a coordinated deploy, not a code question.
// See META_MANUAL_SETUP.md, "Open decisions".
//
// This test asserts the CURRENT behaviour so that changing it is a
// deliberate act that updates this test, not an accident.
test("KNOWN GAP: the website lane reports MQL under the same name as Lead", async () => {
  const t = convexTest(schema, modules);
  const { accountId, userId, asAgent } = await seedAgent(t, "Nia");
  const { conversationId } = await t.run(async (ctx) => {
    const contactId = await ctx.db.insert("contacts", {
      accountId, phone: "+971585824488", phoneNormalized: "971585824488",
    });
    const cid = await ctx.db.insert("conversations", {
      accountId, contactId, status: "open", unreadCount: 0,
      assignedToUserId: userId,
      attribution: { lane: "code", code: "ZZZZZZ", firstSeenAt: 1_000_000 },
    });
    return { conversationId: cid };
  });

  await asAgent.mutation(api.funnel.setStage, { conversationId, stage: LIFECYCLE.mql.stage });

  const mql = (await eventsFor(t, conversationId)).find(
    (e) => e.stage === LIFECYCLE.mql.stage,
  );
  expect(mql?.eventName).toBe("Lead"); // <- not "QualifiedLead", as on CTWA
});

// ---------- Test H — WhatsApp attribution ----------
test("H: a CTWA lead keeps its ctwa_clid on every milestone and invents no Instant Form lead id", async () => {
  const t = convexTest(schema, modules);
  const { accountId, userId, asAgent } = await seedAgent(t, "Hal");
  const { conversationId } = await seedCtwaLead(t, accountId, userId, "clid-H-real");

  await asAgent.mutation(api.funnel.setStage, { conversationId, stage: LIFECYCLE.mql.stage });
  await asAgent.mutation(api.funnel.setStage, { conversationId, stage: LIFECYCLE.sql.stage });
  await asAgent.mutation(api.funnel.setStage, {
    conversationId,
    stage: LIFECYCLE.converted.stage,
    saleValue: 900,
  });

  const events = await eventsFor(t, conversationId);
  expect(events.length).toBeGreaterThanOrEqual(4);
  for (const e of events) {
    // The click id is carried forward onto every downstream milestone —
    // losing it after lead creation is the failure this guards.
    expect(e.identifier).toBe("clid-H-real");
    expect(e.lane).toBe("ctwa");
    // Business-messaging delivery, never the web-pixel relay.
    expect(e.backend).toBe("capi");
  }
  // The conversation's stored attribution is the durable copy.
  const conv = await t.run((ctx) => ctx.db.get(conversationId));
  expect(conv?.attribution?.ctwaClid).toBe("clid-H-real");
});

// ---------- §11 Out-of-order stages ----------
// The spec's first-version policy: strict actual-stage events. Skipping
// MQL must NOT backfill a fabricated one.
test("§11: skipping a stage does not fabricate the skipped milestone", async () => {
  const t = convexTest(schema, modules);
  const { accountId, userId, asAgent } = await seedAgent(t, "Ivy");
  const { conversationId } = await seedCtwaLead(t, accountId, userId, "clid-I");

  // Straight from Lead to SQL — MQL never happened.
  await asAgent.mutation(api.funnel.setStage, { conversationId, stage: LIFECYCLE.sql.stage });

  const fired = await firedEvents(t, conversationId);
  expect(fired).toContain(LIFECYCLE.sql.event);
  expect(fired).not.toContain(LIFECYCLE.mql.event);
});

// ---------- §12 Stage reversal ----------
test("§12: moving a lead backwards does not resend the milestone it returns to", async () => {
  const t = convexTest(schema, modules);
  const { accountId, userId, asAgent } = await seedAgent(t, "Joe");
  const { conversationId } = await seedCtwaLead(t, accountId, userId, "clid-J");

  await asAgent.mutation(api.funnel.setStage, { conversationId, stage: LIFECYCLE.mql.stage });
  await asAgent.mutation(api.funnel.setStage, { conversationId, stage: LIFECYCLE.sql.stage });
  // SQL → MQL. A milestone that already happened is not re-reported.
  await asAgent.mutation(api.funnel.setStage, { conversationId, stage: LIFECYCLE.mql.stage });

  const events = await eventsFor(t, conversationId);
  expect(events.filter((e) => e.eventName === LIFECYCLE.mql.event)).toHaveLength(1);
  expect(events.filter((e) => e.eventName === LIFECYCLE.sql.event)).toHaveLength(1);
});

test("§12: reopening a converted deal does not resend Converted", async () => {
  const t = convexTest(schema, modules);
  const { accountId, userId, asAgent } = await seedAgent(t, "Kim");
  const { conversationId } = await seedCtwaLead(t, accountId, userId, "clid-K");

  await asAgent.mutation(api.funnel.setStage, {
    conversationId,
    stage: LIFECYCLE.converted.stage,
    saleValue: 1000,
  });
  await asAgent.mutation(api.funnel.setStage, { conversationId, stage: LIFECYCLE.sql.stage });
  await asAgent.mutation(api.funnel.setStage, {
    conversationId,
    stage: LIFECYCLE.converted.stage,
    saleValue: 1200,
  });

  const purchases = (await eventsFor(t, conversationId)).filter(
    (e) => e.eventName === LIFECYCLE.converted.event,
  );
  expect(purchases).toHaveLength(1);
  // The ORIGINAL reported amount stands. A revision after the fact does
  // not mint a second Purchase, so Meta is never told the sale happened
  // twice; the CRM's own transition log keeps the revised figure.
  expect(purchases[0].value).toBe(1000);
});

// ---------- Rule A, stated as one assertion ----------
// The spec's single most emphatic instruction ("Do NOT fire MQL, SQL and
// Converted immediately when Lead is created"), pinned directly.
test("Rule A: creating a lead fires exactly one event", async () => {
  const t = convexTest(schema, modules);
  const { accountId, userId } = await seedAgent(t, "Lee");
  const { conversationId } = await seedCtwaLead(t, accountId, userId, "clid-L");

  const events = await eventsFor(t, conversationId);
  expect(events).toHaveLength(1);
  expect(events[0].eventName).toBe(LIFECYCLE.lead.event);
});

// ---------- Organic leads are never reported ----------
// Not in the spec's list, but the corollary of "only Meta-attributable
// inquiries are leads": an unattributed conversation must produce no Meta
// traffic at all, however far it progresses.
test("an organic (unattributed) conversation reports nothing to Meta", async () => {
  const t = convexTest(schema, modules);
  const { accountId, userId, asAgent } = await seedAgent(t, "Mia");
  const { conversationId } = await t.run(async (ctx) => {
    const contactId = await ctx.db.insert("contacts", {
      accountId,
      phone: "+971500000001",
      phoneNormalized: "971500000001",
    });
    return {
      conversationId: await ctx.db.insert("conversations", {
        accountId,
        contactId,
        status: "open",
        unreadCount: 0,
        assignedToUserId: userId,
      }),
    };
  });

  await asAgent.mutation(api.funnel.setStage, { conversationId, stage: LIFECYCLE.mql.stage });
  await asAgent.mutation(api.funnel.setStage, {
    conversationId,
    stage: LIFECYCLE.converted.stage,
    saleValue: 5000,
  });

  expect(await eventsFor(t, conversationId)).toHaveLength(0);
});
