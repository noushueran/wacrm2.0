/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { ACTIVE_CONVERSATIONS_CAP } from "./dashboard";
import { hourStartMs } from "./lib/messageStats";
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

/** A further member of an ALREADY-SEEDED account. `seedAccountMember`
 *  creates a fresh account per call, which is right for isolation tests and
 *  wrong for role tests — those need several roles looking at ONE snapshot
 *  row. */
async function seedAccountMemberIn(
  t: ReturnType<typeof convexTest>,
  accountId: Id<"accounts">,
  opts: { name: string; email: string; role: AccountRole },
) {
  const userId = await t.run(async (ctx) => {
    const id = await ctx.db.insert("users", {
      name: opts.name,
      email: opts.email,
    });
    await ctx.db.insert("memberships", {
      userId: id,
      accountId,
      role: opts.role,
      fullName: opts.name,
      email: opts.email,
    });
    return id;
  });
  return {
    userId,
    asUser: t.withIdentity({ subject: `${userId}|session-${opts.name}` }),
  };
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

// `TestConvex<typeof schema>` rather than this file's usual
// `ReturnType<typeof convexTest>`: the latter erases the schema type
// argument, so `ctx.db.query("messageHourlyStats")` degrades to the
// system-table overload and the index below stops typechecking. Same
// typed form `aiReply.test.ts` already uses.
async function seedMessage(
  t: TestConvex<typeof schema>,
  opts: {
    accountId: Id<"accounts">;
    conversationId: Id<"conversations">;
    senderType: "customer" | "agent" | "bot";
  },
) {
  return await t.run(async (ctx) => {
    const messageId = await ctx.db.insert("messages", {
      accountId: opts.accountId,
      conversationId: opts.conversationId,
      senderType: opts.senderType,
      contentType: "text",
      contentText: "hello",
      status: "sent",
    });

    // `conversationsSeries` reads the hourly rollup rather than raw
    // messages (see `messageHourlyStats` in schema.ts), so a seeded
    // message has to fold into it the way production's single
    // `insert("messages")` choke point does — otherwise these tests would
    // assert against a chart with no data behind it.
    //
    // Bucketed on the row's own `_creationTime`, not `Date.now()`: this
    // suite drives a fake clock (`makeClock`) to place messages on
    // specific days, and the whole point of the day-bucketing tests is
    // that those placements land where they should.
    const row = (await ctx.db.get(messageId))!;
    const bucketStart = hourStartMs(row._creationTime);
    const inbound = opts.senderType === "customer";
    const existing = await ctx.db
      .query("messageHourlyStats")
      .withIndex("by_account_hour", (q) =>
        q.eq("accountId", opts.accountId).eq("hourStartMs", bucketStart),
      )
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, {
        incoming: existing.incoming + (inbound ? 1 : 0),
        outgoing: existing.outgoing + (inbound ? 0 : 1),
      });
    } else {
      await ctx.db.insert("messageHourlyStats", {
        accountId: opts.accountId,
        hourStartMs: bucketStart,
        incoming: inbound ? 1 : 0,
        outgoing: inbound ? 0 : 1,
      });
    }

    // `responseTime` likewise reads the rollup rather than pairing raw
    // messages on the fly, so a seeded message has to run the same pairing
    // production runs at its `insert("messages")` choke point
    // (`insertMessageAndUpdateConversation`) — otherwise these tests would
    // assert against a chart with no data behind it. Same reasoning, and the
    // same `_creationTime`-not-`Date.now()` bucketing, as the counts above.
    const conversation = (await ctx.db.get(opts.conversationId))!;
    const pendingAtMs = conversation.pendingCustomerAtMs;
    if (inbound) {
      if (pendingAtMs === undefined) {
        await ctx.db.patch(opts.conversationId, {
          pendingCustomerAtMs: row._creationTime,
        });
      }
    } else if (pendingAtMs !== undefined) {
      await ctx.db.patch(opts.conversationId, {
        pendingCustomerAtMs: undefined,
      });
      const elapsedMs = row._creationTime - pendingAtMs;
      const replyBucketStart = hourStartMs(pendingAtMs);
      const replyBucket = await ctx.db
        .query("messageHourlyStats")
        .withIndex("by_account_hour", (q) =>
          q.eq("accountId", opts.accountId).eq("hourStartMs", replyBucketStart),
        )
        .unique();
      if (replyBucket) {
        await ctx.db.patch(replyBucket._id, {
          responseCount: (replyBucket.responseCount ?? 0) + 1,
          responseTotalMs: (replyBucket.responseTotalMs ?? 0) + elapsedMs,
        });
      } else {
        await ctx.db.insert("messageHourlyStats", {
          accountId: opts.accountId,
          hourStartMs: replyBucketStart,
          incoming: 0,
          outgoing: 0,
          responseCount: 1,
          responseTotalMs: elapsedMs,
        });
      }
    }

    return messageId;
  });
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
// The KPI tiles are no longer a live aggregation — `dashboard.snapshot`
// reads one row that the `dashboard-snapshot` cron builds via
// `refreshSnapshots`. Every tile assertion therefore has to run the
// refresher first; `readSnapshot` keeps that a single call so a test that
// forgets it fails on a null row rather than silently asserting against a
// stale one.
//
// `refreshSnapshots` stamps `computedAtMs` and its 72-hour window from
// `Date.now()`, which these tests fake — so it must be called with the
// clock at "now", after all seeding, exactly as the cron would run it.
// ============================================================
async function readSnapshot(
  t: TestConvex<typeof schema>,
  asUser: { query: TestConvex<typeof schema>["query"] },
  args: { todayStartMs: number; yesterdayStartMs: number },
) {
  await t.mutation(internal.dashboard.refreshSnapshots, {});
  const row = await asUser.query(api.dashboard.snapshot, args);
  if (row === null) throw new Error("refreshSnapshots wrote no snapshot row");
  return row;
}

// ============================================================
// snapshot (the KPI tiles)
// ============================================================

test("snapshot reports active/new conversations, contacts, open deals, and agent messages scoped to the caller's account", async () => {
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

  const aliceResult = await readSnapshot(t, asAlice, {
    todayStartMs: TODAY_START,
    yesterdayStartMs: YESTERDAY_START,
  });
  expect(aliceResult.activeConversations).toEqual({
    current: 5,
    previous: 1,
    capped: false, // well under ACTIVE_CONVERSATIONS_CAP, so `current` is exact
  });
  expect(aliceResult.newContactsToday).toEqual({ current: 3, previous: 2 });
  expect(aliceResult.openDealsValue).toBe(350);
  expect(aliceResult.openDealsCount).toBe(2);
  // `messagesSentToday` is deliberately absent. No component ever rendered
  // it, and deriving it meant collecting every message in a two-day window
  // — measured at ~1,300 documents, the bulk of this query's old 1,882-read
  // cost, and the reason the dashboard's first read touched `messages` at
  // all. Asserted rather than merely deleted so re-adding it is a conscious
  // act with a visible price.
  expect("messagesSentToday" in aliceResult).toBe(false);

  // Symmetric check: Bob sees his own (much larger) numbers, proving
  // isolation holds in both directions rather than Alice's exact-match
  // assertions above merely happening not to be polluted.
  const bobResult = await readSnapshot(t, asBob, {
    todayStartMs: TODAY_START,
    yesterdayStartMs: YESTERDAY_START,
  });
  expect(bobResult.openDealsValue).toBe(99_999);
  expect(bobResult.openDealsCount).toBe(1);
});

test("snapshot splits new leads by acquisition source (ad vs direct), today and yesterday", async () => {
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

  const res = await readSnapshot(t, asUser, {
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
// snapshot: the three behaviours the snapshot introduced that the old
// live `metrics` query had no equivalent for.
// ============================================================

test("snapshot returns null before the cron has ever run", async () => {
  const t = convexTest(schema, modules);
  const clock = makeClock(T0);
  clock(NOW);
  const { asUser } = await seedAccountMember(t, {
    name: "Dana",
    email: "dana@example.com",
    role: "owner",
  });

  // Deliberately NOT an error and NOT zeros. A freshly deployed backend
  // (or an account created since the last tick) has no row yet; the page
  // renders "preparing" for it, where zeros would read as "no work today".
  await expect(
    asUser.query(api.dashboard.snapshot, {
      todayStartMs: TODAY_START,
      yesterdayStartMs: YESTERDAY_START,
    }),
  ).resolves.toBeNull();
});

test("snapshot scopes waitingOnReply to the caller's role, from one shared row", async () => {
  const t = convexTest(schema, modules);
  const clock = makeClock(T0);
  clock(T0);
  // One account, three roles. The snapshot row is account-wide and shared,
  // so this is the test that the PRE-SPLIT counts in it are resolved per
  // caller rather than handing everyone the account total — the property
  // `conversations.unreadTotal` gave for free by scoping at read time.
  const { asUser: asOwner, accountId } = await seedAccountMember(t, {
    name: "Olive",
    email: "olive@example.com",
    role: "owner",
  });
  const agent = await seedAccountMemberIn(t, accountId, {
    name: "Aggie",
    email: "aggie@example.com",
    role: "agent",
  });
  const other = await seedAccountMemberIn(t, accountId, {
    name: "Otto",
    email: "otto@example.com",
    role: "agent",
  });
  const viewer = await seedAccountMemberIn(t, accountId, {
    name: "Vera",
    email: "vera@example.com",
    role: "viewer",
  });

  clock(NOW);
  const contactId = await seedContact(t, { accountId, phone: "+15550000200" });
  const withUnread = async (assignedToUserId?: Id<"users">) => {
    const id = await seedConversation(t, { accountId, contactId });
    await t.run((ctx) =>
      ctx.db.patch(id, {
        unreadCount: 1,
        ...(assignedToUserId ? { assignedToUserId } : {}),
      }),
    );
  };
  await withUnread();                 // pool
  await withUnread();                 // pool
  await withUnread(agent.userId);     // Aggie's
  await withUnread(other.userId);     // Otto's
  await withUnread(other.userId);     // Otto's
  // A read thread must not count for anyone.
  await seedConversation(t, { accountId, contactId });

  const args = { todayStartMs: TODAY_START, yesterdayStartMs: YESTERDAY_START };
  // Supervisor+ — everything.
  expect((await readSnapshot(t, asOwner, args)).waitingOnReply).toBe(5);
  // Agent — own plus the pool, never a colleague's.
  expect((await readSnapshot(t, agent.asUser, args)).waitingOnReply).toBe(3);
  expect((await readSnapshot(t, other.asUser, args)).waitingOnReply).toBe(4);
  // Viewer — the pool alone.
  expect((await readSnapshot(t, viewer.asUser, args)).waitingOnReply).toBe(2);
});

test("snapshot folds its UTC hours into the CALLER's local day, not the cron's", async () => {
  const t = convexTest(schema, modules);
  const clock = makeClock(T0);
  clock(T0);
  const { asUser, accountId } = await seedAccountMember(t, {
    name: "Tara",
    email: "tara@example.com",
    role: "owner",
  });

  // Two contacts either side of a UTC midnight: one an hour before, one an
  // hour after. The refresher buckets both by UTC hour and stores them
  // unfolded, which is the whole point — whether they land in the same
  // local day depends entirely on who is asking.
  // TODAY_START is already a UTC midnight, and sits after T0 — which the
  // clock guard requires, since `seedAccountMember` above ran at T0.
  const utcMidnight = TODAY_START;
  clock(utcMidnight - 3_600_000);
  await seedContact(t, { accountId, phone: "+15550000301" }); // 23:00 UTC Jan 14
  clock(utcMidnight + 3_600_000);
  await seedContact(t, { accountId, phone: "+15550000302" }); // 01:00 UTC Jan 15
  clock(utcMidnight + 7_200_000);

  // A viewer in UTC: the two contacts fall on different local days.
  const utcView = await readSnapshot(t, asUser, {
    todayStartMs: utcMidnight,
    yesterdayStartMs: utcMidnight - 86_400_000,
  });
  expect(utcView.newContactsToday).toEqual({ current: 1, previous: 1 });

  // The SAME stored row, read by someone at UTC-05:00, whose local day
  // began at 05:00 UTC — both contacts now sit before it, in yesterday.
  const westView = await readSnapshot(t, asUser, {
    todayStartMs: utcMidnight + 5 * 3_600_000,
    yesterdayStartMs: utcMidnight - 19 * 3_600_000,
  });
  expect(westView.newContactsToday).toEqual({ current: 0, previous: 2 });
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
// responseTime
// ============================================================

// Reproduces the production failure this query was rewritten to fix:
// `[CONVEX Q(dashboard:responseTime)] Your request timed out performing too
// many system operations`, which crashed the whole `/dashboard` route (the
// page has no Error Boundary, so a throwing `useQuery` takes the tree down).
//
// The old handler `.collect()`ed every message in the window. A window bounds
// the SPAN, not the ROW COUNT, so the read grew with traffic until it blew
// Convex's per-transaction ceiling — the identical mistake `conversationsSeries`
// had made, and was fixed by rolling counts up on write.
//
// `documentsRead: 1000` is the whole point of the test. The 14-day window is
// 336 hourly buckets and everything else the query reads is fixed (the
// caller's membership + user row), so a window-bounded handler lands far
// under 1000 no matter how busy the account is, while a volume-bounded one
// needs one read per message and cannot fit. The `toEqual`s below are what
// stop that budget from being satisfied the cheap way, by returning nothing:
// a handler that reads no rows also reports no samples.
test("responseTime's read cost is bounded by the window, not by message volume", async () => {
  const t = convexTest({
    schema,
    modules,
    transactionLimits: { documentsRead: 1000 },
  });
  const clock = makeClock(T0);
  clock(T0);
  const { asUser, accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });

  // Seeded at T0, before the window: `makeClock` only moves forward, and the
  // message loop below starts at `WINDOW_START`.
  const contact = await seedContact(t, { accountId, phone: "1" });
  const conversation = await seedConversation(t, { accountId, contactId: contact });

  // 600 customer/reply pairs — 1200 messages, comfortably past the 1000-doc
  // budget — spread one pair every 30 minutes so they span most of the
  // window (300 hours, ending before `NOW`) and fall across many distinct
  // hourly buckets rather than piling into one.
  const PAIRS = 600;
  const PAIR_SPACING_MIN = 30;
  const REPLY_DELAY_MIN = 10;
  const WINDOW_START = Date.parse("2026-06-26T00:00:00.000Z");
  for (let i = 0; i < PAIRS; i++) {
    const askedAt = WINDOW_START + i * PAIR_SPACING_MIN * 60_000;
    clock(askedAt);
    await seedMessage(t, { accountId, conversationId: conversation, senderType: "customer" });
    clock(askedAt + REPLY_DELAY_MIN * 60_000);
    await seedMessage(t, { accountId, conversationId: conversation, senderType: "agent" });
  }

  clock(NOW);
  const result = await asUser.query(api.dashboard.responseTime, {
    sinceMs: WINDOW_START,
    tzOffsetMinutes: 0,
  });

  // Every pair was replied to in exactly 10 minutes, so each populated
  // bucket must average 10 and the sample counts must add up to all 600 —
  // proof the query stayed both correct and complete under the budget.
  const totalSamples = result.buckets.reduce((sum, b) => sum + b.samples, 0);
  expect(totalSamples).toBe(PAIRS);
  for (const bucket of result.buckets) {
    if (bucket.samples === 0) continue;
    expect(bucket.avgMinutes).toBeCloseTo(REPLY_DELAY_MIN, 10);
  }
});

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
  // Supervisor because `activity` gates there (see its own role test
  // below); this test is about interleaving and scoping, not policy.
  const { asUser: asAlice, accountId: aliceId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "supervisor",
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
    role: "supervisor", // `activity` gates on supervisor
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

test("activity surfaces only customer messages (not bot/agent) via by_account_sender", async () => {
  // Guards the read-bound rewrite: the customer-message feed now filters
  // to senderType==="customer" inside the `by_account_sender` index range
  // instead of a post-scan `.filter()`, so this pins that the filter is
  // still applied — a newer bot and agent message must NOT surface as
  // message items. (convex-test counts only rows a query RETURNS, never
  // `.filter()`-skipped scans, so it cannot reproduce the production
  // read-limit this fix targets; this asserts the preserved semantics.)
  const t = convexTest(schema, modules);
  const clock = makeClock(T0);
  clock(NOW);
  const { asUser, accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "supervisor", // `activity` gates on supervisor
  });
  const contactId = await seedContact(t, {
    accountId,
    phone: "+15551110000",
    name: "Cara",
  });
  const conv = await seedConversation(t, { accountId, contactId });
  const customerMsg = await seedMessage(t, {
    accountId,
    conversationId: conv,
    senderType: "customer",
  });
  // Newer bot + agent messages: index-range filtering must exclude them.
  await seedMessage(t, { accountId, conversationId: conv, senderType: "bot" });
  await seedMessage(t, { accountId, conversationId: conv, senderType: "agent" });

  const items = await asUser.query(api.dashboard.activity, { limit: 20 });
  const messageItems = items.filter((it) => it.kind === "message");
  expect(messageItems).toHaveLength(1);
  expect(messageItems[0]!.id).toBe(`msg-${customerMsg}`);
});

// ============================================================
// cross-cutting denial — every dashboard query requires an identity
// ============================================================

test("snapshot throws UNAUTHENTICATED when there is no identity", async () => {
  const t = convexTest(schema, modules);
  await expect(
    t.query(api.dashboard.snapshot, { todayStartMs: 0, yesterdayStartMs: 0 }),
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

// `activity` returns account-wide rows — the newest customer messages
// with their `/inbox?c=<id>` deep links, plus contact names (falling
// back to the RAW phone when a contact has no name). It applied neither
// `conversationScope` nor `maskContactPhone`, so an agent or viewer
// could call it directly and learn which contacts have live threads —
// including colleagues' assigned conversations that
// `messages.listByConversation` would refuse them.
//
// `/dashboard` is supervisor+ in `SUPERVISOR_NAV` (src/lib/auth/roles.ts),
// so the floor matches the nav. This is the same nav-vs-query gap already
// closed for `campaigns.overview` — there the query was stricter than the
// nav; here it ran the other way. Pins BOTH ends: a supervisor succeeds,
// and the next role down gets FORBIDDEN rather than just "some error".
test("activity allows a supervisor and rejects an agent with FORBIDDEN", async () => {
  const t = convexTest(schema, modules);
  const { asUser: asSupervisor, accountId } = await seedAccountMember(t, {
    name: "Sam",
    email: "sam@example.com",
    role: "supervisor",
  });
  await expect(
    asSupervisor.query(api.dashboard.activity, { limit: 10 }),
  ).resolves.toEqual([]);

  const agentId = await t.run((ctx) =>
    ctx.db.insert("users", { name: "Ag", email: "ag@example.com" }),
  );
  await t.run((ctx) =>
    ctx.db.insert("memberships", {
      userId: agentId,
      accountId,
      role: "agent",
      fullName: "Ag",
      email: "ag@example.com",
    }),
  );
  const asAgent = t.withIdentity({ subject: `${agentId}|s-Ag` });
  await expect(
    asAgent.query(api.dashboard.activity, { limit: 10 }),
  ).rejects.toMatchObject({ data: { code: "FORBIDDEN", min: "supervisor" } });
});

// ============================================================
// metrics: the open-conversation count is bounded
//
// `openConversations` was a `.collect()` over `by_account_status`
// (accountId, "open"). The in-code comment claimed that bounded it
// because "the closed set grows forever" — but nothing in the app ever
// auto-closes a conversation (the only writers are an optional automation
// action and a manual per-thread control), so in practice essentially
// every conversation stays open and this collected the entire table, on
// the landing page.
//
// It is a COUNT, so it does not need the rows. `.take(CAP + 1)` on the
// same index is genuinely bounded — every row in that range is a match,
// so there is no `.filter()` starvation — and the extra row is what
// distinguishes "exactly CAP" from "more than CAP".
// ============================================================

test("snapshot returns an exact open-conversation count below the cap", async () => {
  const t = convexTest(schema, modules);
  const clock = makeClock(T0);
  clock(T0);
  const { asUser, accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "supervisor",
  });
  const contactId = await seedContact(t, { accountId, phone: "+15550000000" });
  clock(NOW);
  for (let i = 0; i < 3; i++) {
    await seedConversation(t, { accountId, contactId });
  }

  const result = await readSnapshot(t, asUser, {
    todayStartMs: TODAY_START,
    yesterdayStartMs: YESTERDAY_START,
  });
  expect(result.activeConversations.current).toBe(3);
  expect(result.activeConversations.capped).toBe(false);
});

test("snapshot caps the open-conversation count rather than collecting the table", async () => {
  const t = convexTest(schema, modules);
  const clock = makeClock(T0);
  clock(T0);
  const { asUser, accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "supervisor",
  });
  const contactId = await seedContact(t, { accountId, phone: "+15550000000" });
  clock(NOW);
  for (let i = 0; i < ACTIVE_CONVERSATIONS_CAP + 5; i++) {
    await seedConversation(t, { accountId, contactId });
  }

  const result = await readSnapshot(t, asUser, {
    todayStartMs: TODAY_START,
    yesterdayStartMs: YESTERDAY_START,
  });
  // Reported as "CAP+" by the UI rather than a wrong exact number.
  expect(result.activeConversations.current).toBe(ACTIVE_CONVERSATIONS_CAP);
  expect(result.activeConversations.capped).toBe(true);
}, 60_000);

test("snapshot still derives today-vs-yesterday from a bounded window when capped", async () => {
  const t = convexTest(schema, modules);
  const clock = makeClock(T0);
  clock(T0);
  const { asUser, accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "supervisor",
  });
  const contactId = await seedContact(t, { accountId, phone: "+15550000000" });

  // Old, still-open conversations — these must NOT count as "new today",
  // and must not be needed in memory to work that out.
  clock(BEFORE_YESTERDAY);
  for (let i = 0; i < 4; i++) await seedConversation(t, { accountId, contactId });
  clock(YESTERDAY_START);
  await seedConversation(t, { accountId, contactId });
  clock(TODAY_START);
  for (let i = 0; i < 3; i++) await seedConversation(t, { accountId, contactId });

  const result = await readSnapshot(t, asUser, {
    todayStartMs: TODAY_START,
    yesterdayStartMs: YESTERDAY_START,
  });
  expect(result.activeConversations.current).toBe(8);
  expect(result.activeConversations.capped).toBe(false);
  expect(result.activeConversations.previous).toBe(2); // 3 today - 1 yesterday
});

// ============================================================
// metrics: archived conversations are not open work (Lead Analysis P2,
// Task 6). `openConversations`/`newOpenToday` don't exist on the return
// value — the real shape is `activeConversations: { current, previous,
// capped }` (see the tests above) — so these assert on that shape.
// ============================================================

test("snapshot does not count an archived conversation as open", async () => {
  const t = convexTest(schema, modules);
  const clock = makeClock(T0);
  clock(T0);
  const { asUser, accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "owner",
  });
  const contactId = await seedContact(t, { accountId, phone: "+15550000101" });
  clock(NOW);
  await seedConversation(t, { accountId, contactId, status: "open" }); // stays open
  const archivedId = await seedConversation(t, { accountId, contactId, status: "open" });
  await t.run((ctx) => ctx.db.patch(archivedId, { archivedAt: Date.now() }));

  const result = await readSnapshot(t, asUser, {
    todayStartMs: TODAY_START,
    yesterdayStartMs: YESTERDAY_START,
  });
  expect(result.activeConversations.current).toBe(1);
});

test("restoring a conversation returns it to the open count", async () => {
  const t = convexTest(schema, modules);
  const clock = makeClock(T0);
  clock(T0);
  const { asUser, accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "owner",
  });
  const contactId = await seedContact(t, { accountId, phone: "+15550000102" });
  clock(NOW);
  const lead = await seedConversation(t, { accountId, contactId, status: "open" });
  await asUser.mutation(api.leadAnalysis.archive, { conversationId: lead });
  await asUser.mutation(api.leadAnalysis.restore, { conversationId: lead });

  const result = await readSnapshot(t, asUser, {
    todayStartMs: TODAY_START,
    yesterdayStartMs: YESTERDAY_START,
  });
  expect(result.activeConversations.current).toBe(1);
});

test("a conversation archived today is not counted as new-open today", async () => {
  const t = convexTest(schema, modules);
  const clock = makeClock(T0);
  clock(T0);
  const { asUser, accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "owner",
  });
  const contactId = await seedContact(t, { accountId, phone: "+15550000103" });
  clock(NOW);
  const archivedId = await seedConversation(t, { accountId, contactId, status: "open" });
  await t.run((ctx) => ctx.db.patch(archivedId, { archivedAt: Date.now() }));

  const result = await readSnapshot(t, asUser, {
    todayStartMs: TODAY_START,
    yesterdayStartMs: YESTERDAY_START,
  });
  expect(result.activeConversations.current).toBe(0);
  // Would be 1 (today's delta counting the archived-today thread as
  // new-open) without the archive check in the JS-filtered predicate.
  expect(result.activeConversations.previous).toBe(0);
});

test("archiving drops the thread out of the unread badge", async () => {
  const t = convexTest(schema, modules);
  const clock = makeClock(T0);
  clock(T0);
  const { asUser, accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "owner",
  });
  const contactId = await seedContact(t, { accountId, phone: "+15550000104" });
  clock(NOW);
  const lead = await seedConversation(t, { accountId, contactId, status: "open" });
  await t.run((ctx) => ctx.db.patch(lead, { unreadCount: 3 }));
  expect(await asUser.query(api.conversations.unreadTotal, {})).toBe(1);

  await asUser.mutation(api.leadAnalysis.archive, { conversationId: lead });

  // Load-bearing: `archive` zeroes `unreadCount`, so archived rows leave
  // the `by_account_unread` range without `unreadTotal` needing to know
  // anything about archiving.
  expect(await asUser.query(api.conversations.unreadTotal, {})).toBe(0);
});

test("the deprecated metrics shim still answers, for clients deployed before snapshot", async () => {
  const t = convexTest(schema, modules);
  const clock = makeClock(T0);
  clock(T0);
  const { asUser, accountId } = await seedAccountMember(t, {
    name: "Legacy", email: "legacy@example.com", role: "owner",
  });
  const contactId = await seedContact(t, { accountId, phone: "+15550000400" });
  clock(NOW);
  await seedConversation(t, { accountId, contactId, status: "open" });
  await seedContact(t, { accountId, phone: "+15550000401" });

  // Deliberately WITHOUT running `refreshSnapshots`. The shim exists for the
  // deploy window in which the backend is new and the client is old, and in
  // that window the cron may not have written a snapshot row yet — so it has
  // to stand alone, which is exactly why it kept the original live
  // implementation instead of re-deriving from `dashboardSnapshots`.
  const res = await asUser.query(api.dashboard.metrics, {
    todayStartMs: TODAY_START,
    yesterdayStartMs: YESTERDAY_START,
  });

  expect(res.activeConversations.current).toBe(1);
  expect(res.newContactsToday.current).toBe(1);
  // The old shape, in full — an old client destructures all of it.
  expect(res).toHaveProperty("openDealsValue");
  expect(res).toHaveProperty("openDealsCount");
  expect(res).toHaveProperty("messagesSentToday");
  expect(res).toHaveProperty("newLeadsBySource");
});
