/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import type { AccountRole } from "./lib/roles";

// Convex function modules for convex-test to resolve `api.*` references
// against. Absolute, from-project-root pattern (matches every other
// `convex/*.test.ts` suite — see `convex/conversations.test.ts`'s own
// comment for why this must be absolute rather than a relative "./**").
const modules = import.meta.glob("/convex/**/*.ts");

// ============================================================
// `convex-test` derives every row's `_creationTime` from `Date.now()`
// at insert time, and clamps it forward (never backward) relative to
// the last-inserted row's own creation time (see
// `node_modules/convex-test/dist/index.js`: `now <= this._lastCreationTime
// ? this._lastCreationTime + 0.001 : now`). Since `dashboard.ts`'s
// aggregations bucket almost entirely on `_creationTime`, every seed
// call in this file has to happen while a fake clock is pinned to a
// value that is >= every previously-used value — otherwise a seed
// meant to land "before yesterday" would silently get clamped to
// "just after whatever was inserted last" instead, corrupting the
// scenario without any visible error. `makeClock` turns that silent
// footgun into an immediate, loud test failure instead.
//
// Only `Date` is faked (`toFake: ["Date"]`), not timers — convex-test's
// own internals use a real `setTimeout` for scheduled-function
// simulation (irrelevant to these tests, but no reason to risk it).
// ============================================================

function makeClock(startMs: number) {
  let last = startMs - 1;
  return (ms: number) => {
    if (ms < last) {
      throw new Error(
        `Test bug: tried to seed at ${new Date(ms).toISOString()}, but a ` +
          `previous seed already moved the fake clock past ` +
          `${new Date(last).toISOString()} — convex-test derives ` +
          `_creationTime from Date.now() and clamps it forward only, so ` +
          `every seed call must happen in non-decreasing time order.`,
      );
    }
    last = ms;
    vi.setSystemTime(ms);
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
});
afterEach(() => {
  vi.useRealTimers();
});

// Shared reference instants. Strictly increasing, so any test seeding
// through them in this order never needs to move the clock backwards.
const T0 = Date.parse("2026-06-20T00:00:00.000Z"); // seedAccountMember baseline
const BEFORE_YESTERDAY = Date.parse("2026-07-01T00:00:00.000Z");
const YESTERDAY_START = Date.parse("2026-07-08T00:00:00.000Z");
const TODAY_START = Date.parse("2026-07-09T00:00:00.000Z");
const NOW = Date.parse("2026-07-09T12:00:00.000Z");

// ============================================================
// Seed helpers. Every one just performs a direct `t.run` insert using
// WHATEVER fake time is currently pinned (via a preceding `clock(ms)`
// call in the test body) — none of them touch the clock themselves, so
// the chronological sequence stays fully explicit and auditable at the
// call site. `automations.ts`/`broadcasts.ts` don't exist yet in this
// codebase, so those two (plus `automationLogs`) are seeded directly
// rather than via a mutation, same as `conversations.test.ts` seeds
// `conversations` directly.
// ============================================================

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
      defaultCurrency: "USD",
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
  const asUser = t.withIdentity({
    subject: `${userId}|session-${opts.name}`,
  });
  return { userId, accountId, asUser };
}

async function seedContact(
  t: ReturnType<typeof convexTest>,
  opts: { accountId: Id<"accounts">; phone: string; name?: string },
) {
  return await t.run((ctx) =>
    ctx.db.insert("contacts", {
      accountId: opts.accountId,
      phone: opts.phone,
      phoneNormalized: opts.phone.replace(/\D/g, ""),
      name: opts.name,
    }),
  );
}

async function seedConversation(
  t: ReturnType<typeof convexTest>,
  opts: {
    accountId: Id<"accounts">;
    contactId: Id<"contacts">;
    status?: "open" | "pending" | "closed";
  },
) {
  return await t.run((ctx) =>
    ctx.db.insert("conversations", {
      accountId: opts.accountId,
      contactId: opts.contactId,
      status: opts.status ?? "open",
      unreadCount: 0,
    }),
  );
}

async function seedMessage(
  t: ReturnType<typeof convexTest>,
  opts: {
    accountId: Id<"accounts">;
    conversationId: Id<"conversations">;
    senderType: "customer" | "agent" | "bot";
  },
) {
  return await t.run((ctx) =>
    ctx.db.insert("messages", {
      accountId: opts.accountId,
      conversationId: opts.conversationId,
      senderType: opts.senderType,
      contentType: "text",
      contentText: "hello",
      status: "sent",
    }),
  );
}

async function seedPipelineWithStages(
  t: ReturnType<typeof convexTest>,
  opts: {
    accountId: Id<"accounts">;
    stages: { name: string; color: string }[];
  },
) {
  const pipelineId = await t.run((ctx) =>
    ctx.db.insert("pipelines", { accountId: opts.accountId, name: "Sales" }),
  );
  const stageIds: Id<"pipelineStages">[] = [];
  for (const [index, stage] of opts.stages.entries()) {
    const stageId = await t.run((ctx) =>
      ctx.db.insert("pipelineStages", {
        accountId: opts.accountId,
        pipelineId,
        name: stage.name,
        color: stage.color,
        position: index,
      }),
    );
    stageIds.push(stageId);
  }
  return { pipelineId, stageIds };
}

async function seedDeal(
  t: ReturnType<typeof convexTest>,
  opts: {
    accountId: Id<"accounts">;
    pipelineId: Id<"pipelines">;
    stageId: Id<"pipelineStages">;
    title: string;
    value: number;
    status?: "open" | "won" | "lost";
    updatedAt?: number;
  },
) {
  return await t.run((ctx) =>
    ctx.db.insert("deals", {
      accountId: opts.accountId,
      pipelineId: opts.pipelineId,
      stageId: opts.stageId,
      title: opts.title,
      value: opts.value,
      status: opts.status ?? "open",
      updatedAt: opts.updatedAt,
    }),
  );
}

async function seedBroadcast(
  t: ReturnType<typeof convexTest>,
  opts: {
    accountId: Id<"accounts">;
    name: string;
    status: "draft" | "scheduled" | "sending" | "sent" | "failed";
    totalRecipients: number;
  },
) {
  return await t.run((ctx) =>
    ctx.db.insert("broadcasts", {
      accountId: opts.accountId,
      name: opts.name,
      templateName: "hello_template",
      templateLanguage: "en_US",
      status: opts.status,
      totalRecipients: opts.totalRecipients,
      sentCount: 0,
      deliveredCount: 0,
      readCount: 0,
      repliedCount: 0,
      failedCount: 0,
    }),
  );
}

async function seedAutomation(
  t: ReturnType<typeof convexTest>,
  opts: { accountId: Id<"accounts">; name: string },
) {
  return await t.run((ctx) =>
    ctx.db.insert("automations", {
      accountId: opts.accountId,
      name: opts.name,
      triggerType: "keyword",
      isActive: true,
      executionCount: 0,
    }),
  );
}

async function seedAutomationLog(
  t: ReturnType<typeof convexTest>,
  opts: {
    accountId: Id<"accounts">;
    automationId: Id<"automations">;
    contactId?: Id<"contacts">;
    status?: "success" | "partial" | "failed";
  },
) {
  return await t.run((ctx) =>
    ctx.db.insert("automationLogs", {
      accountId: opts.accountId,
      automationId: opts.automationId,
      contactId: opts.contactId,
      triggerEvent: "keyword_match",
      status: opts.status ?? "success",
    }),
  );
}

// ============================================================
// metrics
// ============================================================

test("metrics reports active/new conversations, contacts, open deals, and agent messages scoped to the caller's account", async () => {
  const t = convexTest(schema, modules);
  const clock = makeClock(T0);
  clock(T0);
  const { asUser: asAlice, accountId: aliceId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const { asUser: asBob, accountId: bobId } = await seedAccountMember(t, {
    name: "Bob",
    email: "bob@example.com",
    role: "agent",
  });

  clock(BEFORE_YESTERDAY);
  const aliceContact = await seedContact(t, { accountId: aliceId, phone: "1000" });
  await seedConversation(t, { accountId: aliceId, contactId: aliceContact, status: "open" }); // old-open #1
  await seedConversation(t, { accountId: aliceId, contactId: aliceContact, status: "open" }); // old-open #2
  const hostConv = await seedConversation(t, {
    accountId: aliceId,
    contactId: aliceContact,
    status: "closed", // just hosts messages; must not count as an open conversation
  });
  await seedContact(t, { accountId: aliceId, phone: "2006" }); // before yesterday -> neither bucket
  const { pipelineId, stageIds } = await seedPipelineWithStages(t, {
    accountId: aliceId,
    stages: [{ name: "New Lead", color: "#3b82f6" }],
  });
  await seedDeal(t, {
    accountId: aliceId,
    pipelineId,
    stageId: stageIds[0]!,
    title: "Open A",
    value: 100,
    status: "open",
  });
  await seedMessage(t, { accountId: aliceId, conversationId: hostConv, senderType: "agent" }); // too old, excluded
  await seedMessage(t, { accountId: aliceId, conversationId: hostConv, senderType: "agent" }); // too old, excluded

  clock(YESTERDAY_START + 3_600_000);
  await seedConversation(t, { accountId: aliceId, contactId: aliceContact, status: "open" }); // yesterday-open
  await seedContact(t, { accountId: aliceId, phone: "2004" });
  await seedContact(t, { accountId: aliceId, phone: "2005" });
  await seedMessage(t, { accountId: aliceId, conversationId: hostConv, senderType: "agent" });
  await seedMessage(t, { accountId: aliceId, conversationId: hostConv, senderType: "agent" });
  await seedMessage(t, { accountId: aliceId, conversationId: hostConv, senderType: "agent" });

  clock(NOW);
  await seedConversation(t, { accountId: aliceId, contactId: aliceContact, status: "open" }); // today-open #1
  await seedConversation(t, { accountId: aliceId, contactId: aliceContact, status: "open" }); // today-open #2
  await seedConversation(t, { accountId: aliceId, contactId: aliceContact, status: "closed" }); // excluded: not open
  await seedContact(t, { accountId: aliceId, phone: "2001" });
  await seedContact(t, { accountId: aliceId, phone: "2002" });
  await seedContact(t, { accountId: aliceId, phone: "2003" });
  await seedDeal(t, { accountId: aliceId, pipelineId, stageId: stageIds[0]!, title: "Open B", value: 250, status: "open" });
  await seedDeal(t, { accountId: aliceId, pipelineId, stageId: stageIds[0]!, title: "Won", value: 500, status: "won" }); // excluded
  await seedDeal(t, { accountId: aliceId, pipelineId, stageId: stageIds[0]!, title: "Lost", value: 10, status: "lost" }); // excluded
  for (let i = 0; i < 4; i++) {
    await seedMessage(t, { accountId: aliceId, conversationId: hostConv, senderType: "agent" });
  }
  for (let i = 0; i < 5; i++) {
    // Customer-authored -> must NOT count toward messagesSentToday.
    await seedMessage(t, { accountId: aliceId, conversationId: hostConv, senderType: "customer" });
  }

  // Decoy account: larger-magnitude, same-shaped data that must never
  // leak into Alice's numbers.
  const bobContact = await seedContact(t, { accountId: bobId, phone: "9999" });
  await seedConversation(t, { accountId: bobId, contactId: bobContact, status: "open" });
  await seedContact(t, { accountId: bobId, phone: "9998" });
  const { pipelineId: bobPipelineId, stageIds: bobStageIds } = await seedPipelineWithStages(t, {
    accountId: bobId,
    stages: [{ name: "Bob Stage", color: "#000000" }],
  });
  await seedDeal(t, {
    accountId: bobId,
    pipelineId: bobPipelineId,
    stageId: bobStageIds[0]!,
    title: "Bob Deal",
    value: 99_999,
    status: "open",
  });
  const bobConv = await seedConversation(t, { accountId: bobId, contactId: bobContact, status: "open" });
  await seedMessage(t, { accountId: bobId, conversationId: bobConv, senderType: "agent" });

  const aliceResult = await asAlice.query(api.dashboard.metrics, {
    todayStartMs: TODAY_START,
    yesterdayStartMs: YESTERDAY_START,
  });
  expect(aliceResult.activeConversations).toEqual({ current: 5, previous: 1 });
  expect(aliceResult.newContactsToday).toEqual({ current: 3, previous: 2 });
  expect(aliceResult.openDealsValue).toBe(350);
  expect(aliceResult.openDealsCount).toBe(2);
  expect(aliceResult.messagesSentToday).toEqual({ current: 4, previous: 3 });

  // Symmetric check: Bob sees his own (much larger) numbers, proving
  // isolation holds in both directions rather than Alice's exact-match
  // assertions above merely happening not to be polluted.
  const bobResult = await asBob.query(api.dashboard.metrics, {
    todayStartMs: TODAY_START,
    yesterdayStartMs: YESTERDAY_START,
  });
  expect(bobResult.openDealsValue).toBe(99_999);
  expect(bobResult.openDealsCount).toBe(1);
});

test("metrics splits new leads by acquisition source (ad vs direct), today and yesterday", async () => {
  const t = convexTest(schema, modules);
  const clock = makeClock(T0);
  clock(T0);
  const { asUser, accountId } = await seedAccountMember(t, {
    name: "Cara",
    email: "cara@example.com",
    role: "admin",
  });

  const seedLead = (phone: string, ad: boolean) =>
    t.run((ctx) =>
      ctx.db.insert("contacts", {
        accountId,
        phone,
        phoneNormalized: phone.replace(/\D/g, ""),
        ...(ad ? { acquisitionSource: "ad" as const } : {}),
      }),
    );

  clock(YESTERDAY_START + 3_600_000);
  await seedLead("3001", true); // ad, yesterday
  await seedLead("3002", false); // direct, yesterday

  clock(NOW);
  await seedLead("3003", true); // ad, today
  await seedLead("3004", true); // ad, today
  await seedLead("3005", false); // direct, today

  const res = await asUser.query(api.dashboard.metrics, {
    todayStartMs: TODAY_START,
    yesterdayStartMs: YESTERDAY_START,
  });
  // The pre-existing total must still hold…
  expect(res.newContactsToday).toEqual({ current: 3, previous: 2 });
  // …and now split by source.
  expect(res.newLeadsBySource).toEqual({
    adToday: 2,
    directToday: 1,
    adYesterday: 1,
    directYesterday: 1,
  });
});

// ============================================================
// conversationsSeries
// ============================================================

test("conversationsSeries buckets messages into the provided day keys, scoped to the caller's account", async () => {
  const t = convexTest(schema, modules);
  const clock = makeClock(T0);
  clock(T0);
  const { asUser: asAlice, accountId: aliceId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const { accountId: bobId } = await seedAccountMember(t, {
    name: "Bob",
    email: "bob@example.com",
    role: "agent",
  });

  clock(BEFORE_YESTERDAY);
  const contact = await seedContact(t, { accountId: aliceId, phone: "1" });
  const conv = await seedConversation(t, { accountId: aliceId, contactId: contact });
  const bobContact = await seedContact(t, { accountId: bobId, phone: "2" });
  const bobConv = await seedConversation(t, { accountId: bobId, contactId: bobContact });

  const day2 = Date.parse("2026-07-07T00:00:00.000Z");
  const day1 = Date.parse("2026-07-08T00:00:00.000Z");
  const day0 = Date.parse("2026-07-09T00:00:00.000Z");
  void day0;
  const dayKeys = ["2026-07-07", "2026-07-08", "2026-07-09"];

  clock(day2 + 1000);
  await seedMessage(t, { accountId: aliceId, conversationId: conv, senderType: "customer" });
  clock(day2 + 2000);
  await seedMessage(t, { accountId: aliceId, conversationId: conv, senderType: "customer" });
  clock(day2 + 3000);
  await seedMessage(t, { accountId: aliceId, conversationId: conv, senderType: "agent" });

  clock(day1 + 1000);
  await seedMessage(t, { accountId: aliceId, conversationId: conv, senderType: "customer" });
  clock(day1 + 2000);
  await seedMessage(t, { accountId: aliceId, conversationId: conv, senderType: "agent" });
  clock(day1 + 2500);
  await seedMessage(t, { accountId: bobId, conversationId: bobConv, senderType: "customer" }); // decoy, must not leak
  clock(day1 + 3000);
  await seedMessage(t, { accountId: aliceId, conversationId: conv, senderType: "bot" });

  // day0 (2026-07-09): no Alice messages at all -> must still render a
  // zero point rather than being omitted.

  const result = await asAlice.query(api.dashboard.conversationsSeries, {
    sinceMs: day2,
    dayKeys,
    tzOffsetMinutes: 0,
  });

  expect(result).toEqual([
    { day: "2026-07-07", incoming: 2, outgoing: 1 },
    { day: "2026-07-08", incoming: 1, outgoing: 2 },
    { day: "2026-07-09", incoming: 0, outgoing: 0 },
  ]);
});

test("conversationsSeries buckets a message into its LOCAL day, not its UTC day, for a non-zero tzOffsetMinutes", async () => {
  const t = convexTest(schema, modules);
  const clock = makeClock(T0);
  clock(T0);
  const { asUser: asAlice, accountId: aliceId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });

  clock(BEFORE_YESTERDAY);
  const contact = await seedContact(t, { accountId: aliceId, phone: "1" });
  const conv = await seedConversation(t, { accountId: aliceId, contactId: contact });

  // 20:00 UTC on the 8th is 01:30 local in India (UTC+5:30) on the 9th.
  clock(Date.parse("2026-07-08T20:00:00.000Z"));
  await seedMessage(t, { accountId: aliceId, conversationId: conv, senderType: "customer" });

  const result = await asAlice.query(api.dashboard.conversationsSeries, {
    sinceMs: Date.parse("2026-07-07T00:00:00.000Z"),
    dayKeys: ["2026-07-08", "2026-07-09"],
    tzOffsetMinutes: -330,
  });

  expect(result).toEqual([
    { day: "2026-07-08", incoming: 0, outgoing: 0 },
    { day: "2026-07-09", incoming: 1, outgoing: 0 },
  ]);
});

// ============================================================
// pipelineDonut
// ============================================================

test("pipelineDonut groups open deals by stage, hides empty stages, and excludes another account's pipeline", async () => {
  const t = convexTest(schema, modules);
  const clock = makeClock(T0);
  clock(T0);
  const { asUser: asAlice, accountId: aliceId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const { accountId: bobId } = await seedAccountMember(t, {
    name: "Bob",
    email: "bob@example.com",
    role: "agent",
  });

  clock(BEFORE_YESTERDAY);
  const { pipelineId, stageIds } = await seedPipelineWithStages(t, {
    accountId: aliceId,
    stages: [
      { name: "New Lead", color: "#3b82f6" },
      { name: "Qualified", color: "" }, // falsy color -> fallback
      { name: "Won", color: "#22c55e" }, // stays empty -> hidden from output
    ],
  });
  await seedDeal(t, { accountId: aliceId, pipelineId, stageId: stageIds[0]!, title: "D1", value: 100, status: "open" });
  await seedDeal(t, { accountId: aliceId, pipelineId, stageId: stageIds[0]!, title: "D2", value: 50, status: "open" });
  await seedDeal(t, { accountId: aliceId, pipelineId, stageId: stageIds[1]!, title: "D3", value: 200, status: "open" });
  await seedDeal(t, { accountId: aliceId, pipelineId, stageId: stageIds[1]!, title: "D4", value: 999, status: "won" }); // excluded: not open

  const { pipelineId: bobPipelineId, stageIds: bobStageIds } = await seedPipelineWithStages(t, {
    accountId: bobId,
    stages: [{ name: "Bob Stage", color: "#000000" }],
  });
  await seedDeal(t, {
    accountId: bobId,
    pipelineId: bobPipelineId,
    stageId: bobStageIds[0]!,
    title: "Bob Deal",
    value: 5000,
    status: "open",
  });

  const result = await asAlice.query(api.dashboard.pipelineDonut, {});

  expect(result.stages.map((s) => s.id)).toEqual([stageIds[0], stageIds[1]]);
  expect(result.stages[0]).toMatchObject({
    name: "New Lead",
    color: "#3b82f6",
    dealCount: 2,
    totalValue: 150,
  });
  expect(result.stages[1]).toMatchObject({
    name: "Qualified",
    color: "#64748b", // fallback for the falsy color above
    dealCount: 1,
    totalValue: 200,
  });
  expect(result.totalValue).toBe(350);
});

// ============================================================
// responseTime
// ============================================================

test("responseTime pairs customer messages with the next reply, dedupes repeated customer messages, buckets by local day-of-week, and computes this/last week averages", async () => {
  const t = convexTest(schema, modules);
  const clock = makeClock(T0);
  clock(T0);
  const { asUser: asAlice, accountId: aliceId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const { accountId: bobId } = await seedAccountMember(t, {
    name: "Bob",
    email: "bob@example.com",
    role: "agent",
  });

  clock(BEFORE_YESTERDAY);
  const contact = await seedContact(t, { accountId: aliceId, phone: "1" });
  const convA = await seedConversation(t, { accountId: aliceId, contactId: contact });
  const convB = await seedConversation(t, { accountId: aliceId, contactId: contact });
  const bobContact = await seedContact(t, { accountId: bobId, phone: "2" });
  const bobConv = await seedConversation(t, { accountId: bobId, contactId: bobContact });

  const WED_LAST_WEEK = Date.parse("2026-07-01T09:00:00.000Z");
  const TUE_THIS_WEEK = Date.parse("2026-07-07T10:00:00.000Z");

  // convB (last week, Wednesday): two customer messages before a single
  // reply -> only the FIRST customer message counts (dedupe), 20 min later.
  clock(WED_LAST_WEEK);
  await seedMessage(t, { accountId: aliceId, conversationId: convB, senderType: "customer" });
  clock(WED_LAST_WEEK + 5 * 60_000);
  await seedMessage(t, { accountId: aliceId, conversationId: convB, senderType: "customer" });
  clock(WED_LAST_WEEK + 20 * 60_000);
  await seedMessage(t, { accountId: aliceId, conversationId: convB, senderType: "bot" });

  // Decoy: Bob's own conversation with a much slower (60 min) reply, in
  // the same this-week Tuesday bucket if it ever leaked.
  clock(TUE_THIS_WEEK);
  await seedMessage(t, { accountId: bobId, conversationId: bobConv, senderType: "customer" });
  clock(TUE_THIS_WEEK + 60 * 60_000);
  await seedMessage(t, { accountId: bobId, conversationId: bobConv, senderType: "agent" });

  // convA (this week, Tuesday): single customer message, 10 min reply.
  clock(TUE_THIS_WEEK + 61 * 60_000);
  await seedMessage(t, { accountId: aliceId, conversationId: convA, senderType: "customer" });
  clock(TUE_THIS_WEEK + 71 * 60_000);
  await seedMessage(t, { accountId: aliceId, conversationId: convA, senderType: "agent" });

  clock(NOW); // responseTime's handler reads Date.now() for this/last-week boundaries
  const result = await asAlice.query(api.dashboard.responseTime, {
    sinceMs: Date.parse("2026-06-26T00:00:00.000Z"),
    tzOffsetMinutes: 0,
  });

  expect(result.thisWeekAvg).toBe(10);
  expect(result.lastWeekAvg).toBe(20);
  expect(result.buckets).toHaveLength(7);
  expect(result.buckets[1]).toEqual({ dow: 1, avgMinutes: 10, samples: 1 }); // Tuesday
  expect(result.buckets[2]).toEqual({ dow: 2, avgMinutes: 20, samples: 1 }); // Wednesday
  for (const bucket of result.buckets) {
    if (bucket.dow === 1 || bucket.dow === 2) continue;
    expect(bucket).toEqual({ dow: bucket.dow, avgMinutes: null, samples: 0 });
  }
});

// ============================================================
// activity
// ============================================================

test("activity interleaves messages/contacts/deals/broadcasts/automation logs by recency, embeds display names, respects limit, and excludes another account's rows", async () => {
  const t = convexTest(schema, modules);
  const clock = makeClock(T0);
  clock(T0);
  const { asUser: asAlice, accountId: aliceId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const { accountId: bobId } = await seedAccountMember(t, {
    name: "Bob",
    email: "bob@example.com",
    role: "agent",
  });

  const T1 = Date.parse("2026-07-01T00:00:00.000Z");
  const T2 = Date.parse("2026-07-02T00:00:00.000Z");
  const T3 = Date.parse("2026-07-03T00:00:00.000Z");
  const T4 = Date.parse("2026-07-04T00:00:00.000Z");
  const T5 = Date.parse("2026-07-05T00:00:00.000Z");
  const T6 = Date.parse("2026-07-06T00:00:00.000Z");
  const T7 = Date.parse("2026-07-07T00:00:00.000Z");
  const T8 = Date.parse("2026-07-08T00:00:00.000Z");
  const T9 = Date.parse("2026-07-09T00:00:00.000Z");

  clock(T1);
  const contact = await seedContact(t, { accountId: aliceId, phone: "1", name: "Jonas" });
  const { pipelineId, stageIds } = await seedPipelineWithStages(t, {
    accountId: aliceId,
    stages: [
      { name: "New Lead", color: "#3b82f6" },
      { name: "Won", color: "#22c55e" },
    ],
  });
  // Created (and last updated) before everything else below -> must
  // sort as the OLDEST item, i.e. dead last.
  const dealOld = await seedDeal(t, {
    accountId: aliceId,
    pipelineId,
    stageId: stageIds[0]!,
    title: "Deal Old",
    value: 10,
    status: "open",
    updatedAt: T1 - 1000,
  });

  clock(T2);
  const conv = await seedConversation(t, { accountId: aliceId, contactId: contact });

  clock(T3);
  const messageId = await seedMessage(t, { accountId: aliceId, conversationId: conv, senderType: "customer" });

  clock(T4);
  // Created here, but `updatedAt` is bumped all the way to T9 below —
  // proves activity sorts deals by `updatedAt`, not `_creationTime`.
  const dealMoved = await seedDeal(t, {
    accountId: aliceId,
    pipelineId,
    stageId: stageIds[1]!,
    title: "Deal Moved",
    value: 20,
    status: "open",
    updatedAt: T9,
  });

  clock(T5);
  const broadcastId = await seedBroadcast(t, {
    accountId: aliceId,
    name: "Promo",
    status: "sent",
    totalRecipients: 42,
  });

  clock(T6);
  const automationId = await seedAutomation(t, { accountId: aliceId, name: "Welcome Bot" });
  const autoLogSuccessId = await seedAutomationLog(t, {
    accountId: aliceId,
    automationId,
    contactId: contact,
    status: "success",
  });

  clock(T7);
  const autoLogFailedId = await seedAutomationLog(t, {
    accountId: aliceId,
    automationId,
    status: "failed", // no contactId -> "a contact" fallback
  });

  // Decoy account: same-shaped rows timestamped into the same window,
  // must never appear in Alice's feed.
  clock(T8);
  const bobContact = await seedContact(t, { accountId: bobId, phone: "2", name: "BobContact" });
  const bobConv = await seedConversation(t, { accountId: bobId, contactId: bobContact });
  await seedMessage(t, { accountId: bobId, conversationId: bobConv, senderType: "customer" });
  const { pipelineId: bobPipelineId, stageIds: bobStageIds } = await seedPipelineWithStages(t, {
    accountId: bobId,
    stages: [{ name: "Bob Stage", color: "#000000" }],
  });
  await seedDeal(t, {
    accountId: bobId,
    pipelineId: bobPipelineId,
    stageId: bobStageIds[0]!,
    title: "Bob Deal",
    value: 1,
    status: "open",
    updatedAt: T9 + 1000, // even newer than Alice's newest -> would sort first if it leaked
  });
  await seedBroadcast(t, { accountId: bobId, name: "Bob Broadcast", status: "sent", totalRecipients: 1 });
  const bobAutomationId = await seedAutomation(t, { accountId: bobId, name: "Bob Automation" });
  await seedAutomationLog(t, {
    accountId: bobId,
    automationId: bobAutomationId,
    contactId: bobContact,
    status: "success",
  });

  const result = await asAlice.query(api.dashboard.activity, { limit: 20 });

  expect(result.map((item) => item.id)).toEqual([
    `deal-${dealMoved}`,
    `auto-${autoLogFailedId}`,
    `auto-${autoLogSuccessId}`,
    `broadcast-${broadcastId}`,
    `msg-${messageId}`,
    `contact-${contact}`,
    `deal-${dealOld}`,
  ]);

  expect(result[0]).toMatchObject({
    kind: "deal",
    text: 'Deal "Deal Moved" in Won',
    href: "/pipelines",
    at: new Date(T9).toISOString(),
  });
  expect(result[1]).toMatchObject({
    kind: "automation",
    text: 'Automation "Welcome Bot" failed for a contact',
  });
  expect(result[1]!.href).toBeUndefined();
  expect(result[2]).toMatchObject({
    kind: "automation",
    text: 'Automation "Welcome Bot" triggered for Jonas',
  });
  expect(result[3]).toMatchObject({
    kind: "broadcast",
    text: 'Broadcast "Promo" sent to 42 contacts',
    href: "/broadcasts",
  });
  expect(result[4]).toMatchObject({
    kind: "message",
    text: "New message from Jonas",
    href: `/inbox?c=${conv}`,
    at: new Date(T3).toISOString(),
  });
  expect(result[5]).toMatchObject({
    kind: "contact",
    text: "New contact: Jonas",
    href: "/contacts",
  });
  expect(result[6]).toMatchObject({
    kind: "deal",
    text: 'Deal "Deal Old" in New Lead',
  });

  const limited = await asAlice.query(api.dashboard.activity, { limit: 3 });
  expect(limited.map((item) => item.id)).toEqual([
    `deal-${dealMoved}`,
    `auto-${autoLogFailedId}`,
    `auto-${autoLogSuccessId}`,
  ]);
});

/**
 * The one place `by_account_updated` changes behaviour rather than preserving
 * it. `activity` fetches the 10 most-recently-updated deals; ranging that on
 * the index means Convex's ordering decides membership, and Convex sorts a
 * MISSING field before every present value — so descending, a deal with no
 * `updatedAt` sorts last and drops out of the fetched 10. The old full scan
 * sorted in JS on `updatedAt ?? _creationTime`, which promoted such a row to
 * the front on the strength of its creation time alone.
 *
 * This is unreachable through the app: every `deals` insert sets `updatedAt`
 * (`deals.create` and `automationsEngine`'s deal step both do), and both
 * production rows carry it — `v.optional` here is defensive, not a real state.
 * It needs >10 deals to show at all, since below that the anomaly is fetched
 * anyway and its `atMs` fallback still ranks it. Pinned so the trade-off is
 * asserted rather than assumed.
 */
test("activity drops a deal with no updatedAt from the fetched window rather than ranking it by creation time", async () => {
  const t = convexTest(schema, modules);
  const clock = makeClock(T0);
  clock(T0);
  const { asUser: asAlice, accountId: aliceId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const { pipelineId, stageIds } = await seedPipelineWithStages(t, {
    accountId: aliceId,
    stages: [{ name: "New Lead", color: "#3b82f6" }],
  });

  const BASE = Date.parse("2026-07-01T00:00:00.000Z");
  clock(BASE);
  for (let i = 0; i < 10; i++) {
    await seedDeal(t, {
      accountId: aliceId,
      pipelineId,
      stageId: stageIds[0]!,
      title: `Deal ${i}`,
      value: 1,
      status: "open",
      updatedAt: BASE + i,
    });
  }

  // Created well AFTER all ten, but carrying no `updatedAt` at all. On the
  // old JS sort its creation time put it first; on the index it sorts last.
  clock(BASE + 1_000_000);
  const noUpdatedAt = await seedDeal(t, {
    accountId: aliceId,
    pipelineId,
    stageId: stageIds[0]!,
    title: "No updatedAt",
    value: 1,
    status: "open",
  });

  const items = await asAlice.query(api.dashboard.activity, { limit: 50 });

  expect(items.some((i) => i.id === `deal-${noUpdatedAt}`)).toBe(false);
  // The ten that do carry `updatedAt` are all present, so the window is full
  // rather than merely empty.
  expect(items.filter((i) => i.kind === "deal")).toHaveLength(10);
});

// ============================================================
// cross-cutting denial — every dashboard query requires an identity
// ============================================================

test("metrics throws UNAUTHENTICATED when there is no identity", async () => {
  const t = convexTest(schema, modules);
  await expect(
    t.query(api.dashboard.metrics, { todayStartMs: 0, yesterdayStartMs: 0 }),
  ).rejects.toMatchObject({ data: { code: "UNAUTHENTICATED" } });
});

test("conversationsSeries throws UNAUTHENTICATED when there is no identity", async () => {
  const t = convexTest(schema, modules);
  await expect(
    t.query(api.dashboard.conversationsSeries, {
      sinceMs: 0,
      dayKeys: [],
      tzOffsetMinutes: 0,
    }),
  ).rejects.toMatchObject({ data: { code: "UNAUTHENTICATED" } });
});

test("pipelineDonut throws UNAUTHENTICATED when there is no identity", async () => {
  const t = convexTest(schema, modules);
  await expect(t.query(api.dashboard.pipelineDonut, {})).rejects.toMatchObject({
    data: { code: "UNAUTHENTICATED" },
  });
});

test("responseTime throws UNAUTHENTICATED when there is no identity", async () => {
  const t = convexTest(schema, modules);
  await expect(
    t.query(api.dashboard.responseTime, { sinceMs: 0, tzOffsetMinutes: 0 }),
  ).rejects.toMatchObject({ data: { code: "UNAUTHENTICATED" } });
});

test("activity throws UNAUTHENTICATED when there is no identity", async () => {
  const t = convexTest(schema, modules);
  await expect(
    t.query(api.dashboard.activity, { limit: 10 }),
  ).rejects.toMatchObject({ data: { code: "UNAUTHENTICATED" } });
});
