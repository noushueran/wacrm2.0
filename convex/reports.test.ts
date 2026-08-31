/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import {
  AD_ROW_LIMIT,
  ASSIGNMENT_ROW_LIMIT,
  AWAITING_SAMPLE_CAP,
  STATUS_MIX_CAP,
} from "./reports";

// Convex function modules for convex-test to resolve `api.*` references
// against. Absolute, from-project-root pattern (matches every other
// `convex/*.test.ts` suite — see `convex/conversations.test.ts`'s own
// comment for why this must be absolute rather than a relative "./**").
const modules = import.meta.glob("/convex/**/*.ts");

// ============================================================
// `convex-test` derives every row's `_creationTime` from `Date.now()` at
// insert time, and clamps it forward (never backward) relative to the
// last-inserted row's own creation time (see
// `node_modules/convex-test/dist/index.js`: `now <= this._lastCreationTime
// ? this._lastCreationTime + 0.001 : now`). `reports.ts`'s queries bucket
// on `hourStartMs`/`status`/`archivedAt`, never on `_creationTime`, so none
// of the tests below are actually order-sensitive today — but `makeClock`
// is copied verbatim from `dashboard.test.ts` anyway (same header, same
// discipline), so a test added to this file later that DOES seed by
// relative recency gets an immediate, loud failure instead of the silent
// corruption a bare `vi.setSystemTime` would allow.
//
// Only `Date` is faked (`toFake: ["Date"]`), not timers — convex-test's own
// internals use a real `setTimeout` for scheduled-function simulation
// (irrelevant to these tests, but no reason to risk it).
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

const T0 = Date.parse("2026-08-01T00:00:00.000Z");

/**
 * Seeds one account with a supervisor member (who can call every query in
 * `reports.ts`) and an agent member (who is below the supervisor floor).
 * Same identity-binding shape `dashboard.test.ts`'s `seedAccountMember`
 * plus its inline second-membership pattern use — `t.withIdentity(...)`
 * keyed on `"<userId>|session-<name>"`, plus one `memberships` row per
 * role, rather than a real auth provider.
 */
async function seedAccountWithSupervisor(t: ReturnType<typeof convexTest>) {
  const supervisorUserId = await t.run((ctx) =>
    ctx.db.insert("users", { name: "Sam", email: "sam@example.com" }),
  );
  const accountId = await t.run(async (ctx) => {
    const id = await ctx.db.insert("accounts", {
      name: "Sam's account",
      defaultCurrency: "USD",
      ownerUserId: supervisorUserId,
    });
    await ctx.db.insert("memberships", {
      userId: supervisorUserId,
      accountId: id,
      role: "supervisor",
      fullName: "Sam",
      email: "sam@example.com",
    });
    return id;
  });
  const asSupervisor = t.withIdentity({
    subject: `${supervisorUserId}|session-Sam`,
  });

  const agentUserId = await t.run((ctx) =>
    ctx.db.insert("users", { name: "Ag", email: "ag@example.com" }),
  );
  await t.run((ctx) =>
    ctx.db.insert("memberships", {
      userId: agentUserId,
      accountId,
      role: "agent",
      fullName: "Ag",
      email: "ag@example.com",
    }),
  );
  const asAgent = t.withIdentity({ subject: `${agentUserId}|session-Ag` });

  return { accountId, asSupervisor, asAgent };
}

// ============================================================
// volume
// ============================================================

test("volume folds the rollup into days and totals", async () => {
  const t = convexTest(schema, modules);
  const clock = makeClock(T0);
  clock(T0);
  const { accountId, asSupervisor } = await seedAccountWithSupervisor(t);

  await t.run(async (ctx) => {
    await ctx.db.insert("messageHourlyStats", {
      accountId,
      hourStartMs: Date.parse("2026-08-03T08:00:00Z"),
      incoming: 3,
      outgoing: 1,
      conversationsStarted: 2,
      conversationsStartedAd: 1,
    });
    await ctx.db.insert("messageHourlyStats", {
      accountId,
      hourStartMs: Date.parse("2026-08-04T09:00:00Z"),
      incoming: 1,
      outgoing: 4,
      conversationsStarted: 1,
      conversationsStartedAd: 0,
    });
  });

  const out = await asSupervisor.query(api.reports.volume, {
    sinceMs: Date.parse("2026-08-03T00:00:00Z"),
    untilMs: Date.parse("2026-08-05T00:00:00Z"), // exclusive — covers both seeded days
    keys: ["2026-08-03", "2026-08-04"],
    tzOffsetMinutes: 0,
    granularity: "day",
  });

  expect(out.series).toEqual([
    {
      key: "2026-08-03",
      conversationsStarted: 2,
      conversationsStartedAd: 1,
      incoming: 3,
      outgoing: 1,
      activeConversations: 0,
    },
    {
      key: "2026-08-04",
      conversationsStarted: 1,
      conversationsStartedAd: 0,
      incoming: 1,
      outgoing: 4,
      activeConversations: 0,
    },
  ]);
  expect(out.totals.conversationsStarted).toBe(3);
  expect(out.hourOfDay[8]).toBe(3);
  expect(out.hourOfDay[9]).toBe(1);
});

/**
 * Guards the fold that `keys` cannot protect. `series`/`totals` come from
 * `foldHoursIntoVolume`, which discards any row outside `keys` — so those
 * two stay correct even if the READ over-runs the requested window.
 * `hourOfDay` comes from `foldHoursIntoHourOfDay`, which takes no `keys` and
 * pools every row it is handed — for THAT one, only `readHours`'s own upper
 * bound (`untilMs`) stands between the query and pooling data from outside
 * the window. Two days beyond `untilMs`, not one, so the row cannot land in
 * this test's requested day by any off-by-one in the boundary.
 */
test("volume bounds hourOfDay to the window, not just series/totals", async () => {
  const t = convexTest(schema, modules);
  const clock = makeClock(T0);
  clock(T0);
  const { accountId, asSupervisor } = await seedAccountWithSupervisor(t);

  await t.run(async (ctx) => {
    // Inside the requested window (day 1, 2026-08-03).
    await ctx.db.insert("messageHourlyStats", {
      accountId,
      hourStartMs: Date.parse("2026-08-03T08:00:00Z"),
      incoming: 5,
      outgoing: 0,
    });
    // Two days past the window's exclusive end (2026-08-05, not 2026-08-03)
    // — a different hour-of-day slot than the row above, so a leak is
    // unambiguous rather than just changing a shared slot's total.
    await ctx.db.insert("messageHourlyStats", {
      accountId,
      hourStartMs: Date.parse("2026-08-05T14:00:00Z"),
      incoming: 7,
      outgoing: 0,
    });
  });

  const out = await asSupervisor.query(api.reports.volume, {
    sinceMs: Date.parse("2026-08-03T00:00:00Z"),
    untilMs: Date.parse("2026-08-04T00:00:00Z"), // exclusive — day 1 only
    keys: ["2026-08-03"],
    tzOffsetMinutes: 0,
    granularity: "day",
  });

  expect(out.hourOfDay[8]).toBe(5);
  expect(out.hourOfDay[14]).toBe(0); // the 08-05 row must not leak in
});

test("volume is FORBIDDEN below supervisor", async () => {
  const t = convexTest(schema, modules);
  const { asAgent } = await seedAccountWithSupervisor(t);
  await expect(
    asAgent.query(api.reports.volume, {
      sinceMs: 0,
      untilMs: 0,
      keys: [],
      tzOffsetMinutes: 0,
      granularity: "day",
    }),
  ).rejects.toThrow(/FORBIDDEN/);
});

test("volume returns activeConversations in series and totals", async () => {
  const t = convexTest(schema, modules);
  const clock = makeClock(T0);
  clock(T0);
  const { accountId, asSupervisor } = await seedAccountWithSupervisor(t);

  await t.run(async (ctx) => {
    await ctx.db.insert("messageHourlyStats", {
      accountId,
      hourStartMs: Date.parse("2026-08-03T08:00:00Z"),
      incoming: 1,
      outgoing: 0,
      activeConversations: 2,
    });
    await ctx.db.insert("messageHourlyStats", {
      accountId,
      hourStartMs: Date.parse("2026-08-04T09:00:00Z"),
      incoming: 1,
      outgoing: 0,
      activeConversations: 5,
    });
  });

  const out = await asSupervisor.query(api.reports.volume, {
    sinceMs: Date.parse("2026-08-03T00:00:00Z"),
    untilMs: Date.parse("2026-08-05T00:00:00Z"),
    keys: ["2026-08-03", "2026-08-04"],
    tzOffsetMinutes: 0,
    granularity: "day",
  });

  expect(out.series[0]!.activeConversations).toBe(2);
  expect(out.series[1]!.activeConversations).toBe(5);
  expect(out.totals.activeConversations).toBe(7);
});

// ============================================================
// conversationStatusMix
// ============================================================

test("conversationStatusMix counts each status and reports its cap honestly", async () => {
  const t = convexTest(schema, modules);
  const clock = makeClock(T0);
  clock(T0);
  const { accountId, asSupervisor } = await seedAccountWithSupervisor(t);

  await t.run(async (ctx) => {
    const mk = async (
      status: "open" | "pending" | "closed",
      archived?: number,
    ) => {
      // `phoneNormalized` is required by the `contacts` schema (digits-only
      // form of `phone`) — the brief's own snippet omitted it, which does
      // not compile against schema.ts's `v.string()` (not optional).
      const phone = `+9715${Math.random().toString().slice(2, 10)}`;
      const contactId = await ctx.db.insert("contacts", {
        accountId,
        phone,
        phoneNormalized: phone.replace(/\D/g, ""),
      });
      await ctx.db.insert("conversations", {
        accountId,
        contactId,
        status,
        unreadCount: 0,
        awaitingReply: true,
        archivedAt: archived,
      });
    };
    await mk("open");
    await mk("open");
    await mk("pending");
    await mk("closed");
    await mk("open", Date.now());
  });

  const mix = await asSupervisor.query(api.reports.conversationStatusMix, {});
  expect(mix).toEqual({ open: 2, pending: 1, closed: 1, archived: 1, capped: false });
});

/**
 * The `capped: false` case above passes trivially under any wrong variant
 * of the four-way OR that decides `capped` (drop a bucket from it, typo a
 * status twice) — none of that is exercised unless some bucket actually
 * crosses the ceiling. Analogous to `dashboard.test.ts`'s "metrics caps the
 * open-conversation count rather than collecting the table" (same
 * `by_account_archived_status` index, same take-then-clamp shape); same
 * `60_000` timeout, for the same reason (seeding past the cap one insert at
 * a time is slow regardless of its exact value).
 * Seeds only the "open" bucket past the ceiling, reusing one contact for
 * every conversation exactly as the dashboard test reuses one contact for
 * its 505 — the other three buckets are left at zero, which is enough to
 * prove `capped` is wired to the bucket that actually crossed the ceiling
 * rather than e.g. always true or always false.
 */
test("conversationStatusMix caps the open bucket rather than presenting a clamped count as exact", async () => {
  const t = convexTest(schema, modules);
  const clock = makeClock(T0);
  clock(T0);
  const { accountId, asSupervisor } = await seedAccountWithSupervisor(t);

  await t.run(async (ctx) => {
    const phone = "+97150000000";
    const contactId = await ctx.db.insert("contacts", {
      accountId,
      phone,
      phoneNormalized: phone.replace(/\D/g, ""),
    });
    for (let i = 0; i < STATUS_MIX_CAP + 5; i++) {
      await ctx.db.insert("conversations", {
        accountId,
        contactId,
        status: "open",
        unreadCount: 0,
        awaitingReply: true,
      });
    }
  });

  const mix = await asSupervisor.query(api.reports.conversationStatusMix, {});
  // Reported as "<STATUS_MIX_CAP>+" by the UI rather than a wrong exact
  // number — asserted off the exported constant, never a copy of its value,
  // so retuning the cap does not silently invalidate this test.
  expect(mix.open).toBe(STATUS_MIX_CAP);
  expect(mix.capped).toBe(true);
  expect(mix.pending).toBe(0);
  expect(mix.closed).toBe(0);
  expect(mix.archived).toBe(0);
}, 60_000);

test("conversationStatusMix is FORBIDDEN below supervisor", async () => {
  const t = convexTest(schema, modules);
  const { asAgent } = await seedAccountWithSupervisor(t);
  await expect(
    asAgent.query(api.reports.conversationStatusMix, {}),
  ).rejects.toThrow(/FORBIDDEN/);
});

// ============================================================
// adPerformance
// ============================================================
//
// Every seed below inserts a `contacts` row with an explicit
// `phoneNormalized` (digits-only), for the same reason `conversationStatusMix`'s
// `mk` helper above does: schema.ts's `contacts.phoneNormalized` is a
// required `v.string()`, not optional, so a seed that omits it does not
// compile.

test("adPerformance joins referrals, names and funnel outcomes per ad", async () => {
  const t = convexTest(schema, modules);
  const clock = makeClock(T0);
  clock(T0);
  const { accountId, asSupervisor } = await seedAccountWithSupervisor(t);
  const untilMs = T0 + 24 * 60 * 60 * 1000;

  await t.run(async (ctx) => {
    const phone = "+971500000200";
    const contactId = await ctx.db.insert("contacts", {
      accountId,
      phone,
      phoneNormalized: phone.replace(/\D/g, ""),
    });
    const conversationId = await ctx.db.insert("conversations", {
      accountId,
      contactId,
      status: "open",
      unreadCount: 0,
      awaitingReply: true,
    });
    await ctx.db.insert("adReferrals", {
      accountId,
      contactId,
      conversationId,
      waMessageId: "wamid.ad.1",
      adId: "ad-1",
      sourceType: "ad",
      isFirstTouch: true,
      serviceMatchKey: "visa",
    });
    await ctx.db.insert("campaignAds", {
      accountId,
      adId: "ad-1",
      adName: "Visa Promo",
      adSetName: "Gulf",
      campaignName: "Summer",
      resolveStatus: "resolved",
      attempts: 1,
    });
    await ctx.db.insert("funnelTransitions", {
      accountId,
      conversationId,
      contactId,
      stage: "qualified",
      auto: false,
    });
    await ctx.db.insert("funnelTransitions", {
      accountId,
      conversationId,
      contactId,
      stage: "purchased",
      auto: false,
      saleValue: 1200,
    });
  });

  const out = await asSupervisor.query(api.reports.adPerformance, {
    sinceMs: 0,
    untilMs,
  });
  expect(out.rows).toHaveLength(1);
  expect(out.rows[0]).toMatchObject({
    adId: "ad-1",
    adName: "Visa Promo",
    adSetName: "Gulf",
    campaignName: "Summer",
    conversations: 1,
    firstTouchLeads: 1,
    qualified: 1,
    purchased: 1,
    saleValue: 1200,
  });
  expect(out.rows[0]!.serviceKeys).toEqual(["visa"]);
  expect(out.truncated).toBe(0);
});

// Two referrals on one conversation is one conversation, not two. Counting
// referral ROWS would inflate every busy ad.
test("adPerformance counts distinct conversations, not referral rows", async () => {
  const t = convexTest(schema, modules);
  const clock = makeClock(T0);
  clock(T0);
  const { accountId, asSupervisor } = await seedAccountWithSupervisor(t);
  const untilMs = T0 + 24 * 60 * 60 * 1000;

  await t.run(async (ctx) => {
    const phone = "+971500000201";
    const contactId = await ctx.db.insert("contacts", {
      accountId,
      phone,
      phoneNormalized: phone.replace(/\D/g, ""),
    });
    const conversationId = await ctx.db.insert("conversations", {
      accountId,
      contactId,
      status: "open",
      unreadCount: 0,
      awaitingReply: true,
    });
    for (const wamid of ["wamid.a", "wamid.b"]) {
      await ctx.db.insert("adReferrals", {
        accountId,
        contactId,
        conversationId,
        waMessageId: wamid,
        adId: "ad-2",
        sourceType: "ad",
        isFirstTouch: wamid === "wamid.a",
      });
    }
  });

  const out = await asSupervisor.query(api.reports.adPerformance, {
    sinceMs: 0,
    untilMs,
  });
  expect(out.rows[0]!.conversations).toBe(1);
  expect(out.rows[0]!.firstTouchLeads).toBe(1);
});

test("adPerformance surfaces an unresolved ad by id and counts the resolver backlog", async () => {
  const t = convexTest(schema, modules);
  const clock = makeClock(T0);
  clock(T0);
  const { accountId, asSupervisor } = await seedAccountWithSupervisor(t);
  const untilMs = T0 + 24 * 60 * 60 * 1000;

  await t.run(async (ctx) => {
    const phone = "+971500000202";
    const contactId = await ctx.db.insert("contacts", {
      accountId,
      phone,
      phoneNormalized: phone.replace(/\D/g, ""),
    });
    const conversationId = await ctx.db.insert("conversations", {
      accountId,
      contactId,
      status: "open",
      unreadCount: 0,
      awaitingReply: true,
    });
    await ctx.db.insert("adReferrals", {
      accountId,
      contactId,
      conversationId,
      waMessageId: "wamid.c",
      adId: "ad-3",
      sourceType: "ad",
      isFirstTouch: true,
    });
    await ctx.db.insert("campaignAds", {
      accountId,
      adId: "ad-3",
      resolveStatus: "dormant",
      attempts: 0,
    });
  });

  const out = await asSupervisor.query(api.reports.adPerformance, {
    sinceMs: 0,
    untilMs,
  });
  expect(out.rows[0]!.adName).toBeNull();
  expect(out.rows[0]!.adId).toBe("ad-3");
  expect(out.resolution.dormant).toBe(1);
});

test("adPerformance is FORBIDDEN below supervisor", async () => {
  const t = convexTest(schema, modules);
  const { asAgent } = await seedAccountWithSupervisor(t);
  await expect(
    asAgent.query(api.reports.adPerformance, { sinceMs: 0, untilMs: 0 }),
  ).rejects.toThrow(/FORBIDDEN/);
});

// Correction over the original task-8 brief: a `"post"` referral is an
// organic Facebook/Instagram post tap, not a paid ad — its `source_id` is a
// POST id, not an ad id. `adReferrals.ts:107-125`'s `conversationsStartedAd`
// rollup already gates on `sourceType === "ad"` for exactly this reason;
// this query must agree with it or the Ads tab and the Conversations tab
// report different ad volumes from the same underlying data.
test("adPerformance excludes an organic post tap from the ads table", async () => {
  const t = convexTest(schema, modules);
  const clock = makeClock(T0);
  clock(T0);
  const { accountId, asSupervisor } = await seedAccountWithSupervisor(t);
  const untilMs = T0 + 24 * 60 * 60 * 1000;

  await t.run(async (ctx) => {
    const phone = "+971500000203";
    const contactId = await ctx.db.insert("contacts", {
      accountId,
      phone,
      phoneNormalized: phone.replace(/\D/g, ""),
    });
    const conversationId = await ctx.db.insert("conversations", {
      accountId,
      contactId,
      status: "open",
      unreadCount: 0,
      awaitingReply: true,
    });
    await ctx.db.insert("adReferrals", {
      accountId,
      contactId,
      conversationId,
      waMessageId: "wamid.post",
      adId: "post-1",
      sourceType: "post",
      isFirstTouch: true,
    });
  });

  const out = await asSupervisor.query(api.reports.adPerformance, {
    sinceMs: 0,
    untilMs,
  });
  expect(out.rows).toHaveLength(0);
});

// Correction over the original task-8 brief: the brief gave this query only
// `sinceMs`. An unbounded upper edge would silently pull in every referral
// newer than the window — wrong for any range that does not end at "now"
// (a previous-period comparison, a historical range). Two days past the
// window's exclusive end, not one, so the row cannot land inside by any
// off-by-one at the boundary.
test("adPerformance bounds the adReferrals read to the window, not just since sinceMs", async () => {
  const t = convexTest(schema, modules);
  const clock = makeClock(T0);
  clock(T0);
  const { accountId, asSupervisor } = await seedAccountWithSupervisor(t);
  const untilMs = T0 + 24 * 60 * 60 * 1000;

  await t.run(async (ctx) => {
    const phone = "+971500000204";
    const contactId = await ctx.db.insert("contacts", {
      accountId,
      phone,
      phoneNormalized: phone.replace(/\D/g, ""),
    });
    const conversationId = await ctx.db.insert("conversations", {
      accountId,
      contactId,
      status: "open",
      unreadCount: 0,
      awaitingReply: true,
    });
    await ctx.db.insert("adReferrals", {
      accountId,
      contactId,
      conversationId,
      waMessageId: "wamid.in",
      adId: "ad-in",
      sourceType: "ad",
      isFirstTouch: true,
    });
  });

  clock(untilMs + 2 * 24 * 60 * 60 * 1000);
  await t.run(async (ctx) => {
    const phone = "+971500000205";
    const contactId = await ctx.db.insert("contacts", {
      accountId,
      phone,
      phoneNormalized: phone.replace(/\D/g, ""),
    });
    const conversationId = await ctx.db.insert("conversations", {
      accountId,
      contactId,
      status: "open",
      unreadCount: 0,
      awaitingReply: true,
    });
    await ctx.db.insert("adReferrals", {
      accountId,
      contactId,
      conversationId,
      waMessageId: "wamid.out",
      adId: "ad-out",
      sourceType: "ad",
      isFirstTouch: true,
    });
  });

  const out = await asSupervisor.query(api.reports.adPerformance, {
    sinceMs: 0,
    untilMs,
  });
  const adIds = out.rows.map((r) => r.adId);
  expect(adIds).toContain("ad-in");
  expect(adIds).not.toContain("ad-out");
});

// Same correction, the other scan: a conversation that reached "qualified"
// inside the window but "purchased" only after `untilMs` must not have that
// later transition pulled in either — proving the bound applies to
// `funnelTransitions`, not just `adReferrals`.
test("adPerformance excludes a funnelTransitions row outside the window from qualified/purchased", async () => {
  const t = convexTest(schema, modules);
  const clock = makeClock(T0);
  clock(T0);
  const { accountId, asSupervisor } = await seedAccountWithSupervisor(t);
  const untilMs = T0 + 24 * 60 * 60 * 1000;

  const { conversationId, contactId } = await t.run(async (ctx) => {
    const phone = "+971500000206";
    const contactId = await ctx.db.insert("contacts", {
      accountId,
      phone,
      phoneNormalized: phone.replace(/\D/g, ""),
    });
    const conversationId = await ctx.db.insert("conversations", {
      accountId,
      contactId,
      status: "open",
      unreadCount: 0,
      awaitingReply: true,
    });
    await ctx.db.insert("adReferrals", {
      accountId,
      contactId,
      conversationId,
      waMessageId: "wamid.qual",
      adId: "ad-late-purchase",
      sourceType: "ad",
      isFirstTouch: true,
    });
    await ctx.db.insert("funnelTransitions", {
      accountId,
      conversationId,
      contactId,
      stage: "qualified",
      auto: false,
    });
    return { conversationId, contactId };
  });

  // Purchased AFTER the window's exclusive end — must not count.
  clock(untilMs + 1000);
  await t.run(async (ctx) => {
    await ctx.db.insert("funnelTransitions", {
      accountId,
      conversationId,
      contactId,
      stage: "purchased",
      auto: false,
      saleValue: 500,
    });
  });

  const out = await asSupervisor.query(api.reports.adPerformance, {
    sinceMs: 0,
    untilMs,
  });
  const row = out.rows.find((r) => r.adId === "ad-late-purchase");
  expect(row?.qualified).toBe(1);
  expect(row?.purchased).toBe(0);
  expect(row?.saleValue).toBe(0);
});

// Fix round 1, Finding 2: AD_ROW_LIMIT truncation itself was unpinned —
// three lines guarding the property the brief calls load-bearing, with
// nothing to catch a regression that reorders `sort`/`slice`, or swaps the
// truncation axis for something UI-convenient like `saleValue`. The dropped
// ad below carries the LARGEST saleValue of any ad in the seed, and every
// surviving ad's is smaller — a test that checked only the count/length
// would pass even under a saleValue-sorted truncation; this one does not.
test("adPerformance truncates by conversations descending, never by saleValue", async () => {
  const t = convexTest(schema, modules);
  const clock = makeClock(T0);
  clock(T0);
  const { accountId, asSupervisor } = await seedAccountWithSupervisor(t);
  const untilMs = T0 + 24 * 60 * 60 * 1000;

  await t.run(async (ctx) => {
    const phone = "+971500000300";
    const contactId = await ctx.db.insert("contacts", {
      accountId,
      phone,
      phoneNormalized: phone.replace(/\D/g, ""),
    });

    // The lowest-volume ad (1 conversation) — must be the one dropped. Its
    // saleValue (999,999) is far larger than any surviving ad's (0), so a
    // regression to saleValue-descending truncation would keep THIS ad and
    // drop a real "ad-vol-*" one instead, failing the assertions below.
    const lowConversationId = await ctx.db.insert("conversations", {
      accountId,
      contactId,
      status: "open",
      unreadCount: 0,
      awaitingReply: true,
    });
    await ctx.db.insert("adReferrals", {
      accountId,
      contactId,
      conversationId: lowConversationId,
      waMessageId: "wamid.low",
      adId: "ad-low",
      sourceType: "ad",
      isFirstTouch: false,
    });
    await ctx.db.insert("funnelTransitions", {
      accountId,
      conversationId: lowConversationId,
      contactId,
      stage: "purchased",
      auto: false,
      saleValue: 999_999,
    });

    // AD_ROW_LIMIT ads, each with 2 conversations — strictly more volume
    // than "ad-low"'s 1, so "ad-low" is unambiguously the lowest and every
    // one of these AD_ROW_LIMIT ads survives the cap regardless of how
    // they tie-break against each other. Zero saleValue each (no purchase
    // transitions), so every survivor's saleValue is smaller than
    // "ad-low"'s.
    for (let i = 0; i < AD_ROW_LIMIT; i++) {
      for (let j = 0; j < 2; j++) {
        const conversationId = await ctx.db.insert("conversations", {
          accountId,
          contactId,
          status: "open",
          unreadCount: 0,
          awaitingReply: true,
        });
        await ctx.db.insert("adReferrals", {
          accountId,
          contactId,
          conversationId,
          waMessageId: `wamid.vol.${i}.${j}`,
          adId: `ad-vol-${i}`,
          sourceType: "ad",
          isFirstTouch: false,
        });
      }
    }
  });

  const out = await asSupervisor.query(api.reports.adPerformance, {
    sinceMs: 0,
    untilMs,
  });

  // 101 distinct ads seeded (100 "ad-vol-*" + "ad-low") — exactly one over
  // the cap, so exactly one is dropped.
  expect(out.truncated).toBe(1);
  expect(out.rows).toHaveLength(AD_ROW_LIMIT);
  expect(out.rows.some((r) => r.adId === "ad-low")).toBe(false);
  for (const row of out.rows) {
    expect(row.adId).toMatch(/^ad-vol-/);
    expect(row.conversations).toBe(2);
    expect(row.saleValue).toBeLessThan(999_999);
  }
}, 60_000);

// ============================================================
// responsePerformance
// ============================================================

test("responsePerformance derives averages, exact within-target and percentile ranges", async () => {
  const t = convexTest(schema, modules);
  const clock = makeClock(T0);
  clock(T0);
  const { accountId, asSupervisor } = await seedAccountWithSupervisor(t);

  await t.run(async (ctx) => {
    await ctx.db.insert("messageHourlyStats", {
      accountId,
      hourStartMs: Date.parse("2026-08-03T08:00:00Z"),
      incoming: 0,
      outgoing: 0,
      responseCount: 4,
      responseTotalMs: 4 * 3 * 60_000, // mean 3 min
      responseBuckets: { m1: 0, m5: 2, m15: 2, m60: 0, m240: 0, over: 0 },
    });
  });

  const out = await asSupervisor.query(api.reports.responsePerformance, {
    sinceMs: Date.parse("2026-08-03T00:00:00Z"),
    untilMs: Date.parse("2026-08-04T00:00:00Z"), // exclusive — day 1 only
    keys: ["2026-08-03"],
    tzOffsetMinutes: 0,
    granularity: "day",
    targetMinutes: 5,
  });

  expect(out.samples).toBe(4);
  expect(out.avgMinutes).toBeCloseTo(3);
  // Exactly half the replies landed in the sub-5-minute bucket.
  expect(out.withinTarget).toBeCloseTo(0.5);
  expect(out.series[0]).toMatchObject({ key: "2026-08-03", samples: 4 });
  // A RANGE, never an interpolated point — the histogram does not know the
  // distribution inside a bucket.
  expect(out.p50).toEqual({ lowMinutes: 1, highMinutes: 5 });
  expect(out.byHourOfDay[8]).toMatchObject({ hour: 8, samples: 4 });
});

test("responsePerformance reports null, not zero, with no samples", async () => {
  const t = convexTest(schema, modules);
  const { asSupervisor } = await seedAccountWithSupervisor(t);
  const out = await asSupervisor.query(api.reports.responsePerformance, {
    sinceMs: 0,
    untilMs: Date.parse("2026-08-04T00:00:00Z"),
    keys: ["2026-08-03"],
    tzOffsetMinutes: 0,
    granularity: "day",
    targetMinutes: 5,
  });
  // Zero would read as "we reply instantly", which is the opposite of true.
  expect(out.avgMinutes).toBeNull();
  expect(out.withinTarget).toBeNull();
  expect(out.p50).toBeNull();
  expect(out.p90).toBeNull();
  expect(out.samples).toBe(0);
});

/**
 * Correction over the original task-9 brief, whose own test snippet gave
 * this query only `sinceMs` too. Mirrors "volume bounds hourOfDay to the
 * window, not just series/totals": `series` is protected by `keys`
 * regardless of what the READ over-runs, but `byHourOfDay` pools every row
 * it is handed with no `keys` restriction — see `foldHoursIntoHourOfDay`'s
 * and `readHours`'s own doc comments for why this is the one figure on the
 * panel with nothing but the upper bound protecting it. Two days past
 * `untilMs`, not one, and at hour 14 rather than hour 8, so a leak lands in
 * an unambiguous, different slot.
 */
test("responsePerformance bounds byHourOfDay to the window, not just series", async () => {
  const t = convexTest(schema, modules);
  const clock = makeClock(T0);
  clock(T0);
  const { accountId, asSupervisor } = await seedAccountWithSupervisor(t);

  await t.run(async (ctx) => {
    // Inside the requested window.
    await ctx.db.insert("messageHourlyStats", {
      accountId,
      hourStartMs: Date.parse("2026-08-03T08:00:00Z"),
      incoming: 0,
      outgoing: 0,
      responseCount: 2,
      responseTotalMs: 2 * 3 * 60_000,
    });
    // Two days past the window's exclusive end (2026-08-05, not 2026-08-03)
    // at a different hour-of-day slot than the row above.
    await ctx.db.insert("messageHourlyStats", {
      accountId,
      hourStartMs: Date.parse("2026-08-05T14:00:00Z"),
      incoming: 0,
      outgoing: 0,
      responseCount: 9,
      responseTotalMs: 9 * 60_000,
    });
  });

  const out = await asSupervisor.query(api.reports.responsePerformance, {
    sinceMs: Date.parse("2026-08-03T00:00:00Z"),
    untilMs: Date.parse("2026-08-04T00:00:00Z"), // exclusive — day 1 only
    keys: ["2026-08-03"],
    tzOffsetMinutes: 0,
    granularity: "day",
    targetMinutes: 5,
  });

  expect(out.byHourOfDay[8]).toMatchObject({ samples: 2 });
  expect(out.byHourOfDay[14]).toMatchObject({ samples: 0 }); // the 08-05 row must not leak in
});

test("responsePerformance is FORBIDDEN below supervisor", async () => {
  const t = convexTest(schema, modules);
  const { asAgent } = await seedAccountWithSupervisor(t);
  await expect(
    asAgent.query(api.reports.responsePerformance, {
      sinceMs: 0,
      untilMs: 0,
      keys: [],
      tzOffsetMinutes: 0,
      granularity: "day",
      targetMinutes: 5,
    }),
  ).rejects.toThrow(/FORBIDDEN/);
});

// ============================================================
// awaitingReplyAges
// ============================================================
//
// `phoneNormalized` is added to every `contacts` insert below for the same
// reason `conversationStatusMix`'s tests need it: schema.ts's field is a
// required `v.string()`, not optional.

test("awaitingReplyAges buckets the backlog by age", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asSupervisor } = await seedAccountWithSupervisor(t);
  const now = Date.now();

  await t.run(async (ctx) => {
    const mk = async (agoMs: number) => {
      const phone = `+9715${Math.random().toString().slice(2, 10)}`;
      const contactId = await ctx.db.insert("contacts", {
        accountId,
        phone,
        phoneNormalized: phone.replace(/\D/g, ""),
      });
      await ctx.db.insert("conversations", {
        accountId,
        contactId,
        status: "open",
        unreadCount: 1,
        awaitingReply: true,
        pendingCustomerAtMs: now - agoMs,
      });
    };
    await mk(30 * 60_000); // 30 min
    await mk(2 * 3_600_000); // 2 h
    await mk(10 * 3_600_000); // 10 h
    await mk(50 * 3_600_000); // 50 h
  });

  const out = await asSupervisor.query(api.reports.awaitingReplyAges, {});
  expect(out).toEqual({ under1h: 1, h1to4: 1, h4to24: 1, over24h: 1, capped: false });
});

/**
 * Proves `by_account_lane_last_message`'s equalities are a genuine FILTER,
 * not a binding that happens to pass only because "buckets the backlog by
 * age" above never seeds anything that should be excluded. Each row here
 * carries `awaitingReply: true` and a fresh `pendingCustomerAtMs` — so an
 * implementation that read the awaiting-reply set via any looser range
 * (e.g. dropped the `snoozedUntil`/`chasingForcedAt` equalities, or used
 * `by_account_status` instead) would over-count and still land every one
 * of these in `under1h`, failing this test while still passing the one
 * above. The one control row proves the query is not vacuously returning
 * zero for every case here either.
 */
test("awaitingReplyAges excludes archived, snoozed, force-chased and not-awaiting rows", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asSupervisor } = await seedAccountWithSupervisor(t);
  const now = Date.now();

  await t.run(async (ctx) => {
    const mkContact = async () => {
      const phone = `+9715${Math.random().toString().slice(2, 10)}`;
      return await ctx.db.insert("contacts", {
        accountId,
        phone,
        phoneNormalized: phone.replace(/\D/g, ""),
      });
    };

    // Control: a genuinely live, un-overridden awaiting row — must count.
    await ctx.db.insert("conversations", {
      accountId,
      contactId: await mkContact(),
      status: "open",
      unreadCount: 1,
      awaitingReply: true,
      pendingCustomerAtMs: now - 30 * 60_000,
    });

    // Archived — out of every lane regardless of `awaitingReply`.
    await ctx.db.insert("conversations", {
      accountId,
      contactId: await mkContact(),
      status: "open",
      unreadCount: 1,
      awaitingReply: true,
      pendingCustomerAtMs: now - 30 * 60_000,
      archivedAt: now,
    });

    // Snoozed — an agent deliberately parked this; it must not count as
    // backlog we currently owe a reply on.
    await ctx.db.insert("conversations", {
      accountId,
      contactId: await mkContact(),
      status: "open",
      unreadCount: 1,
      awaitingReply: true,
      pendingCustomerAtMs: now - 30 * 60_000,
      snoozedUntil: now + 3_600_000,
    });

    // Force-chased — same "deliberately set aside" reasoning, the other
    // override field.
    await ctx.db.insert("conversations", {
      accountId,
      contactId: await mkContact(),
      status: "open",
      unreadCount: 1,
      awaitingReply: true,
      pendingCustomerAtMs: now - 30 * 60_000,
      chasingForcedAt: now,
    });

    // We spoke last — not awaiting a reply at all.
    await ctx.db.insert("conversations", {
      accountId,
      contactId: await mkContact(),
      status: "open",
      unreadCount: 0,
      awaitingReply: false,
    });
  });

  const out = await asSupervisor.query(api.reports.awaitingReplyAges, {});
  expect(out).toEqual({ under1h: 1, h1to4: 0, h4to24: 0, over24h: 0, capped: false });
});

/**
 * `awaitingReply: true` also covers an agent-created conversation with no
 * messages at all (schema.ts's own comment on the field: "the conversation
 * has no messages at all... so we owe it the first message"). That row has
 * no CUSTOMER message to time an age from, so it must be skipped rather
 * than counted as zero-age — counting it under `under1h` would flatter the
 * SLA panel with a thread nobody has actually been waiting on.
 */
test("awaitingReplyAges skips a row with no pendingCustomerAtMs rather than bucketing it as zero-age", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asSupervisor } = await seedAccountWithSupervisor(t);

  await t.run(async (ctx) => {
    const phone = `+9715${Math.random().toString().slice(2, 10)}`;
    const contactId = await ctx.db.insert("contacts", {
      accountId,
      phone,
      phoneNormalized: phone.replace(/\D/g, ""),
    });
    await ctx.db.insert("conversations", {
      accountId,
      contactId,
      status: "open",
      unreadCount: 0,
      awaitingReply: true,
      // No pendingCustomerAtMs — an agent opened this thread but has not
      // sent (or received) a single message in it yet.
    });
  });

  const out = await asSupervisor.query(api.reports.awaitingReplyAges, {});
  expect(out).toEqual({ under1h: 0, h1to4: 0, h4to24: 0, over24h: 0, capped: false });
});

/**
 * Same shape as `conversationStatusMix`'s "caps the open bucket rather
 * than presenting a clamped count as exact": one contact reused for every
 * conversation, `AWAITING_SAMPLE_CAP + 5` of them, same `60_000` timeout.
 * Every row lands in the same age bucket, so the four buckets' sum is
 * checkable against `AWAITING_SAMPLE_CAP` exactly — the query must stop
 * reading (and bucketing) at the cap, not silently exceed it.
 */
test("awaitingReplyAges reports capped honestly rather than an exact count past the sample cap", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asSupervisor } = await seedAccountWithSupervisor(t);
  const now = Date.now();

  await t.run(async (ctx) => {
    const phone = "+97150000009";
    const contactId = await ctx.db.insert("contacts", {
      accountId,
      phone,
      phoneNormalized: phone.replace(/\D/g, ""),
    });
    for (let i = 0; i < AWAITING_SAMPLE_CAP + 5; i++) {
      await ctx.db.insert("conversations", {
        accountId,
        contactId,
        status: "open",
        unreadCount: 1,
        awaitingReply: true,
        pendingCustomerAtMs: now - 30 * 60_000,
      });
    }
  });

  const out = await asSupervisor.query(api.reports.awaitingReplyAges, {});
  expect(out.capped).toBe(true);
  expect(out.under1h + out.h1to4 + out.h4to24 + out.over24h).toBe(
    AWAITING_SAMPLE_CAP,
  );
}, 60_000);

test("awaitingReplyAges is FORBIDDEN below supervisor", async () => {
  const t = convexTest(schema, modules);
  const { asAgent } = await seedAccountWithSupervisor(t);
  await expect(
    asAgent.query(api.reports.awaitingReplyAges, {}),
  ).rejects.toThrow(/FORBIDDEN/);
});

// ============================================================
// funnelOverview
// ============================================================

test("funnelOverview counts distinct conversations per stage and sums recorded value", async () => {
  const t = convexTest(schema, modules);
  const clock = makeClock(T0);
  clock(T0);
  const { accountId, asSupervisor } = await seedAccountWithSupervisor(t);
  const untilMs = T0 + 24 * 60 * 60 * 1000;

  await t.run(async (ctx) => {
    // `phoneNormalized` is required by the `contacts` schema (digits-only
    // form of `phone`) — the brief's own snippet omitted it, same defect
    // `conversationStatusMix`'s `mk` helper above was already fixed for.
    const phone = "+971500000300";
    const contactId = await ctx.db.insert("contacts", {
      accountId,
      phone,
      phoneNormalized: phone.replace(/\D/g, ""),
    });
    const conversationId = await ctx.db.insert("conversations", {
      accountId,
      contactId,
      status: "open",
      unreadCount: 0,
      awaitingReply: true,
    });
    // Two transitions into the same stage is ONE conversation reaching it.
    for (let i = 0; i < 2; i++) {
      await ctx.db.insert("funnelTransitions", {
        accountId, conversationId, contactId, stage: "qualified", auto: false,
      });
    }
    await ctx.db.insert("funnelTransitions", {
      accountId, conversationId, contactId, stage: "purchased",
      auto: false, saleValue: 900,
    });
  });

  await buildFunnelRollup(t);
  const out = await asSupervisor.query(api.reports.funnelOverview, {
    sinceMs: 0,
    untilMs,
  });
  const byStage = Object.fromEntries(out.funnel.map((f) => [f.stage, f.count]));
  expect(byStage.qualified).toBe(1);
  // `seedAccountWithSupervisor` sets `defaultCurrency: "USD"` — the brief's
  // own snippet expected "AED", which does not match the shared seed helper
  // it also directs reuse of.
  expect(out.purchase).toMatchObject({ count: 1, totalValue: 900, currency: "USD" });
});

// ============================================================
// `funnelOverview` reads `funnelDailyStats`, not the event logs — see that
// table's comment in schema.ts for the measurement that motivated it. Tests
// below seed `funnelTransitions`/`conversionEvents` DIRECTLY (bypassing
// `applyStageTransition`, which is what maintains the rollup live), so they
// have to build the buckets the same way production will: by running the
// backfill.
//
// That makes these tests do double duty. Their expectations are unchanged
// from when this query scanned the raw rows, so every one of them is now
// also an assertion that the backfill reproduces the live-scan numbers
// EXACTLY — including the "two transitions into one stage is one
// conversation" case, which is precisely where a naively summed rollup
// would drift.
async function buildFunnelRollup(t: TestConvex<typeof schema>) {
  // One call covers BACKFILL_DAYS_PER_CALL days, which is far more than any
  // test seeds — so this finishes synchronously and needs no scheduler
  // drain. That matters here: this suite fakes `Date` only, so there is no
  // mocked timer queue for `finishAllScheduledFunctions` to pump.
  await t.mutation(internal.funnel.backfillFunnelHourlyStats, {});
}

/**
 * Correction over the original task-10 brief, whose own test snippet gave
 * this query only `sinceMs`. Same defect `adPerformance` (task 8) and
 * `responsePerformance` (task 9) were fixed for: an unbounded upper read
 * would silently pool a row newer than `untilMs` into `funnel`/`meta`,
 * which — unlike `volume`'s `series`/`totals` — have no `keys`-style filter
 * of their own to protect them; every row the scan returns is bucketed
 * straight in. The late rows below use a DIFFERENT stage and a DIFFERENT
 * `conversionEvents` status than the in-window rows, so a leak on either
 * scan lands in an unambiguous, separately-checkable bucket rather than
 * just inflating a shared one.
 */
test("funnelOverview bounds both scans to the window, not just since sinceMs", async () => {
  const t = convexTest(schema, modules);
  const clock = makeClock(T0);
  clock(T0);
  const { accountId, asSupervisor } = await seedAccountWithSupervisor(t);
  const untilMs = T0 + 24 * 60 * 60 * 1000;

  const { conversationId, contactId, phone } = await t.run(async (ctx) => {
    const phone = "+971500000301";
    const contactId = await ctx.db.insert("contacts", {
      accountId,
      phone,
      phoneNormalized: phone.replace(/\D/g, ""),
    });
    const conversationId = await ctx.db.insert("conversations", {
      accountId,
      contactId,
      status: "open",
      unreadCount: 0,
      awaitingReply: true,
    });
    await ctx.db.insert("funnelTransitions", {
      accountId, conversationId, contactId, stage: "qualified", auto: false,
    });
    await ctx.db.insert("conversionEvents", {
      accountId,
      conversationId,
      contactId,
      stage: "qualified",
      lane: "ctwa",
      backend: "capi",
      eventName: "QualifiedLead",
      identifier: "clid-in",
      phone,
      waMessageId: "wamid.qual.in",
      firstMessageAt: Date.now(),
      eventId: `${conversationId}:qualified`,
      status: "sent",
      attempts: 1,
    });
    return { conversationId, contactId, phone };
  });

  // Past the window's exclusive end — neither row below must count.
  clock(untilMs + 1000);
  await t.run(async (ctx) => {
    await ctx.db.insert("funnelTransitions", {
      accountId, conversationId, contactId, stage: "purchased",
      auto: false, saleValue: 500,
    });
    await ctx.db.insert("conversionEvents", {
      accountId,
      conversationId,
      contactId,
      stage: "purchased",
      lane: "ctwa",
      backend: "capi",
      eventName: "Purchase",
      identifier: "clid-out",
      phone,
      waMessageId: "wamid.purchase.out",
      firstMessageAt: Date.now(),
      eventId: `${conversationId}:purchased`,
      status: "error",
      attempts: 1,
    });
  });

  await buildFunnelRollup(t);
  const out = await asSupervisor.query(api.reports.funnelOverview, {
    sinceMs: 0,
    untilMs,
  });
  const byStage = Object.fromEntries(out.funnel.map((f) => [f.stage, f.count]));
  expect(byStage.qualified).toBe(1);
  expect(byStage.purchased).toBe(0); // the late transition must not leak in
  expect(out.purchase.count).toBe(0);
  expect(out.meta.sent).toBe(1);
  expect(out.meta.error).toBe(0); // the late event must not leak in
  expect(out.meta.total).toBe(1);
});

test("funnelOverview is FORBIDDEN below supervisor", async () => {
  const t = convexTest(schema, modules);
  const { asAgent } = await seedAccountWithSupervisor(t);
  await expect(
    asAgent.query(api.reports.funnelOverview, { sinceMs: 0, untilMs: 0 }),
  ).rejects.toThrow(/FORBIDDEN/);
});

// ============================================================
// billing
// ============================================================

test("billing folds the rollup's Meta counters into the requested keys", async () => {
  const t = convexTest(schema, modules);
  const clock = makeClock(T0);
  clock(T0);
  const { accountId, asSupervisor } = await seedAccountWithSupervisor(t);

  await t.run(async (ctx) => {
    await ctx.db.insert("messageHourlyStats", {
      accountId,
      hourStartMs: Date.parse("2026-08-03T08:00:00Z"),
      incoming: 0, outgoing: 0,
      metaConversations: 3,
      freeEntryPointConversations: 1,
      billedMessagesByCategory: {
        marketing: 5, utility: 2, service: 1,
        authentication: 0, free: 4, other: 1,
      },
    });
  });

  const out = await asSupervisor.query(api.reports.billing, {
    sinceMs: Date.parse("2026-08-03T00:00:00Z"),
    untilMs: Date.parse("2026-08-04T00:00:00Z"), // exclusive — day 1 only
    keys: ["2026-08-03"],
    tzOffsetMinutes: 0,
    granularity: "day",
  });
  expect(out.totals.metaConversations).toBe(3);
  expect(out.totals.freeEntryPointConversations).toBe(1);
  expect(out.totals.categories.marketing).toBe(5);
  expect(out.totals.categories.other).toBe(1);
  expect(out.series[0]!.key).toBe("2026-08-03");
});

test("billing is FORBIDDEN below supervisor", async () => {
  const t = convexTest(schema, modules);
  const { asAgent } = await seedAccountWithSupervisor(t);
  await expect(
    asAgent.query(api.reports.billing, {
      sinceMs: 0, untilMs: 0, keys: [], tzOffsetMinutes: 0, granularity: "day",
    }),
  ).rejects.toThrow(/FORBIDDEN/);
});


test("funnelOverview does not drag in the hours before a LOCAL midnight window start", async () => {
  const t = convexTest(schema, modules);
  const clock = makeClock(T0);
  clock(T0);
  const { accountId, asSupervisor } = await seedAccountWithSupervisor(t);

  // THE REGRESSION THIS EXISTS FOR. `reportWindow` builds `sinceMs` from a
  // LOCAL midnight, and a local midnight is not a UTC midnight — for a
  // UTC+4 account it is 20:00 UTC the previous day. The first version of
  // this rollup bucketed by UTC DAY and rounded `sinceMs` down to 00:00
  // UTC, so every window silently included the preceding 20 hours.
  // Measured against production before the fix, the 7-day Ads figure came
  // back 22.7% high. An hourly bucket rounds down by at most 59 minutes,
  // and `reportWindow` never produces a mid-hour boundary at all.
  const localMidnightUtc = T0 + 20 * 60 * 60 * 1000; // 20:00 UTC = 00:00 UTC+4

  const mk = async (atMs: number, stage: "qualified" | "price_quoted") => {
    clock(atMs);
    await t.run(async (ctx) => {
      const phone = `+9715000${String(atMs).slice(-5)}`;
      const contactId = await ctx.db.insert("contacts", {
        accountId, phone, phoneNormalized: phone.replace(/\D/g, ""),
      });
      const conversationId = await ctx.db.insert("conversations", {
        accountId, contactId, status: "open", unreadCount: 0,
      });
      await ctx.db.insert("funnelTransitions", {
        accountId, conversationId, contactId, stage, auto: false,
      });
    });
  };

  // 19:00 UTC — the local day BEFORE the window, and the row the daily
  // rollup wrongly counted.
  await mk(localMidnightUtc - 60 * 60 * 1000, "qualified");
  // 21:00 UTC — genuinely inside the window.
  await mk(localMidnightUtc + 60 * 60 * 1000, "price_quoted");

  await buildFunnelRollup(t);
  const out = await asSupervisor.query(api.reports.funnelOverview, {
    sinceMs: localMidnightUtc,
    untilMs: localMidnightUtc + 24 * 60 * 60 * 1000,
  });
  const byStage = Object.fromEntries(out.funnel.map((f) => [f.stage, f.count]));
  expect(byStage.price_quoted).toBe(1);
  expect(byStage.qualified).toBe(0); // 1 with the daily bucketing — the bug
});


// ============================================================
// assignmentsByAgent (Agents tab)
//
// Every test here seeds `conversationEvents` through `clock(...)` rather than
// writing a `_creationTime` field: that column is derived from `Date.now()` at
// insert time and cannot be set directly, and it is the ONLY time key this
// query buckets on. `makeClock`'s non-decreasing guard is therefore load-
// bearing for this suite specifically — an out-of-order seed here would
// silently land rows on the wrong day rather than failing.
// ============================================================

type Thread = { conversationId: Id<"conversations">; contactId: Id<"contacts"> };

/** One conversation to hang handovers off. Returned as a value the caller
 *  holds onto, rather than looked up by key inside `seedAssignment`, so that
 *  "the same thread, reassigned twice" is unambiguously the same id. */
async function seedThread(
  t: ReturnType<typeof convexTest>,
  accountId: Id<"accounts">,
  key: string,
): Promise<Thread> {
  return await t.run(async (ctx) => {
    const contactId = await ctx.db.insert("contacts", {
      accountId,
      phone: `+9715000000${key}`,
      phoneNormalized: `9715000000${key}`,
    });
    const conversationId = await ctx.db.insert("conversations", {
      accountId,
      contactId,
      status: "open",
      unreadCount: 0,
    });
    return { contactId, conversationId };
  });
}

/** One handover event at a fixed instant. */
async function seedAssignment(
  t: ReturnType<typeof convexTest>,
  clock: (ms: number) => void,
  args: {
    accountId: Id<"accounts">;
    atMs: number;
    thread: Thread;
    kind: "assigned" | "unassigned";
    targetUserId?: Id<"users">;
    previousUserId?: Id<"users">;
    source?: "manual" | "takeover" | "release" | "auto_assign";
  },
) {
  clock(args.atMs);
  await t.run((ctx) =>
    ctx.db.insert("conversationEvents", {
      accountId: args.accountId,
      conversationId: args.thread.conversationId,
      contactId: args.thread.contactId,
      kind: args.kind,
      ...(args.targetUserId ? { targetUserId: args.targetUserId } : {}),
      ...(args.previousUserId ? { previousUserId: args.previousUserId } : {}),
      source: args.source ?? "manual",
    }),
  );
}

/** A user plus their `memberships` row, so the query can resolve a name. */
async function seedAgent(
  t: ReturnType<typeof convexTest>,
  accountId: Id<"accounts">,
  name: string,
): Promise<Id<"users">> {
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", {
      name,
      email: `${name.toLowerCase()}@example.com`,
    }),
  );
  await t.run((ctx) =>
    ctx.db.insert("memberships", {
      userId,
      accountId,
      role: "agent",
      fullName: name,
    }),
  );
  return userId;
}

test("assignmentsByAgent counts distinct conversations per agent per day", async () => {
  const t = convexTest(schema, modules);
  const clock = makeClock(T0);
  clock(T0);
  const { accountId, asSupervisor } = await seedAccountWithSupervisor(t);
  const ana = await seedAgent(t, accountId, "Ana");
  const threadA = await seedThread(t, accountId, "1");
  const threadB = await seedThread(t, accountId, "2");

  // Thread A bounces to Ana three times in one day — churn, one lead.
  for (const at of ["08:00", "11:00", "15:00"]) {
    await seedAssignment(t, clock, {
      accountId,
      atMs: Date.parse(`2026-08-03T${at}:00Z`),
      thread: threadA,
      kind: "assigned",
      targetUserId: ana,
    });
  }
  // A second, genuinely different thread the same day.
  await seedAssignment(t, clock, {
    accountId,
    atMs: Date.parse("2026-08-03T16:00:00Z"),
    thread: threadB,
    kind: "assigned",
    targetUserId: ana,
  });

  const out = await asSupervisor.query(api.reports.assignmentsByAgent, {
    sinceMs: Date.parse("2026-08-03T00:00:00Z"),
    untilMs: Date.parse("2026-08-04T00:00:00Z"),
    dayKeys: ["2026-08-03"],
    tzOffsetMinutes: 0,
  });

  // Four events, two leads.
  expect(out.days).toEqual([
    { dayKey: "2026-08-03", byAgent: { [ana]: 2 }, released: 0 },
  ]);
  expect(out.agents).toEqual([{ userId: ana, name: "Ana", total: 2 }]);
  expect(out.truncated).toBe(false);
  expect(out.earliestCoveredDay).toBeNull();
});

test("assignmentsByAgent counts the same lead again on a later day", async () => {
  const t = convexTest(schema, modules);
  const clock = makeClock(T0);
  clock(T0);
  const { accountId, asSupervisor } = await seedAccountWithSupervisor(t);
  const ana = await seedAgent(t, accountId, "Ana");
  const threadA = await seedThread(t, accountId, "1");

  for (const day of ["2026-08-03", "2026-08-04"]) {
    await seedAssignment(t, clock, {
      accountId,
      atMs: Date.parse(`${day}T10:00:00Z`),
      thread: threadA,
      kind: "assigned",
      targetUserId: ana,
    });
  }

  const out = await asSupervisor.query(api.reports.assignmentsByAgent, {
    sinceMs: Date.parse("2026-08-03T00:00:00Z"),
    untilMs: Date.parse("2026-08-05T00:00:00Z"),
    dayKeys: ["2026-08-03", "2026-08-04"],
    tzOffsetMinutes: 0,
  });

  // Deduping is PER DAY, so this is 1 + 1. The total has to equal the row it
  // sits beside — a distinct-over-the-whole-window total would read 1 and
  // contradict its own columns.
  expect(out.days.map((d) => d.byAgent[ana])).toEqual([1, 1]);
  expect(out.agents).toEqual([{ userId: ana, name: "Ana", total: 2 }]);
});

test("assignmentsByAgent credits a takeover to the receiver, not the releaser", async () => {
  const t = convexTest(schema, modules);
  const clock = makeClock(T0);
  clock(T0);
  const { accountId, asSupervisor } = await seedAccountWithSupervisor(t);
  const ana = await seedAgent(t, accountId, "Ana");
  const bo = await seedAgent(t, accountId, "Bo");
  const threadA = await seedThread(t, accountId, "1");

  await seedAssignment(t, clock, {
    accountId,
    atMs: Date.parse("2026-08-03T08:00:00Z"),
    thread: threadA,
    kind: "assigned",
    targetUserId: ana,
  });
  // Bo takes the same thread later the same day. Both worked it; Ana is not
  // debited.
  await seedAssignment(t, clock, {
    accountId,
    atMs: Date.parse("2026-08-03T14:00:00Z"),
    thread: threadA,
    kind: "assigned",
    targetUserId: bo,
    previousUserId: ana,
    source: "takeover",
  });

  const out = await asSupervisor.query(api.reports.assignmentsByAgent, {
    sinceMs: Date.parse("2026-08-03T00:00:00Z"),
    untilMs: Date.parse("2026-08-04T00:00:00Z"),
    dayKeys: ["2026-08-03"],
    tzOffsetMinutes: 0,
  });

  expect(out.days[0].byAgent).toEqual({ [ana]: 1, [bo]: 1 });
  expect(out.days[0].released).toBe(0);
});

test("assignmentsByAgent puts releases in their own column, under no agent", async () => {
  const t = convexTest(schema, modules);
  const clock = makeClock(T0);
  clock(T0);
  const { accountId, asSupervisor } = await seedAccountWithSupervisor(t);
  const ana = await seedAgent(t, accountId, "Ana");
  const threadA = await seedThread(t, accountId, "1");

  await seedAssignment(t, clock, {
    accountId,
    atMs: Date.parse("2026-08-03T08:00:00Z"),
    thread: threadA,
    kind: "assigned",
    targetUserId: ana,
  });
  // Released, re-taken, released again — still ONE lead dropped that day.
  for (const at of ["09:00", "10:00"]) {
    await seedAssignment(t, clock, {
      accountId,
      atMs: Date.parse(`2026-08-03T${at}:00Z`),
      thread: threadA,
      kind: "unassigned",
      previousUserId: ana,
      source: "release",
    });
  }

  const out = await asSupervisor.query(api.reports.assignmentsByAgent, {
    sinceMs: Date.parse("2026-08-03T00:00:00Z"),
    untilMs: Date.parse("2026-08-04T00:00:00Z"),
    dayKeys: ["2026-08-03"],
    tzOffsetMinutes: 0,
  });

  expect(out.days[0].released).toBe(1);
  // The release does NOT debit Ana — she still picked the lead up that day.
  expect(out.days[0].byAgent).toEqual({ [ana]: 1 });
  // And it does not put a nameless row in the agent list either.
  expect(out.agents).toEqual([{ userId: ana, name: "Ana", total: 1 }]);
});

test("assignmentsByAgent buckets by the CALLER's local day, not UTC", async () => {
  const t = convexTest(schema, modules);
  const clock = makeClock(T0);
  clock(T0);
  const { accountId, asSupervisor } = await seedAccountWithSupervisor(t);
  const ana = await seedAgent(t, accountId, "Ana");
  const threadA = await seedThread(t, accountId, "1");

  // 21:00 UTC on the 3rd is 01:00 on the 4th in Dubai (UTC+4 ->
  // tzOffsetMinutes -240, the `getTimezoneOffset` sign convention). Bucketing
  // in UTC would put this on the 3rd.
  await seedAssignment(t, clock, {
    accountId,
    atMs: Date.parse("2026-08-03T21:00:00Z"),
    thread: threadA,
    kind: "assigned",
    targetUserId: ana,
  });

  const out = await asSupervisor.query(api.reports.assignmentsByAgent, {
    sinceMs: Date.parse("2026-08-03T20:00:00Z"),
    untilMs: Date.parse("2026-08-04T20:00:00Z"),
    dayKeys: ["2026-08-03", "2026-08-04"],
    tzOffsetMinutes: -240,
  });

  expect(out.days).toEqual([
    { dayKey: "2026-08-03", byAgent: {}, released: 0 },
    { dayKey: "2026-08-04", byAgent: { [ana]: 1 }, released: 0 },
  ]);
});

test("assignmentsByAgent excludes events outside either window edge", async () => {
  const t = convexTest(schema, modules);
  const clock = makeClock(T0);
  clock(T0);
  const { accountId, asSupervisor } = await seedAccountWithSupervisor(t);
  const ana = await seedAgent(t, accountId, "Ana");
  const before = await seedThread(t, accountId, "1");
  const inside = await seedThread(t, accountId, "2");
  const after = await seedThread(t, accountId, "3");

  for (const [thread, at] of [
    [before, "2026-08-02T23:00:00Z"],
    [inside, "2026-08-03T10:00:00Z"],
    [after, "2026-08-04T01:00:00Z"],
  ] as const) {
    await seedAssignment(t, clock, {
      accountId,
      atMs: Date.parse(at),
      thread,
      kind: "assigned",
      targetUserId: ana,
    });
  }

  const out = await asSupervisor.query(api.reports.assignmentsByAgent, {
    sinceMs: Date.parse("2026-08-03T00:00:00Z"),
    untilMs: Date.parse("2026-08-04T00:00:00Z"), // exclusive
    dayKeys: ["2026-08-03"],
    tzOffsetMinutes: 0,
  });

  expect(out.days[0].byAgent).toEqual({ [ana]: 1 });
  expect(out.agents).toEqual([{ userId: ana, name: "Ana", total: 1 }]);
});

test("assignmentsByAgent ignores another account's handovers", async () => {
  const t = convexTest(schema, modules);
  const clock = makeClock(T0);
  clock(T0);
  const { accountId, asSupervisor } = await seedAccountWithSupervisor(t);
  const ana = await seedAgent(t, accountId, "Ana");
  const mine = await seedThread(t, accountId, "1");

  const otherAccountId = await t.run(async (ctx) => {
    const ownerUserId = await ctx.db.insert("users", {
      name: "Other",
      email: "other@example.com",
    });
    return await ctx.db.insert("accounts", {
      name: "Other account",
      defaultCurrency: "USD",
      ownerUserId,
    });
  });
  const theirs = await seedThread(t, otherAccountId, "9");

  await seedAssignment(t, clock, {
    accountId,
    atMs: Date.parse("2026-08-03T09:00:00Z"),
    thread: mine,
    kind: "assigned",
    targetUserId: ana,
  });
  await seedAssignment(t, clock, {
    accountId: otherAccountId,
    atMs: Date.parse("2026-08-03T10:00:00Z"),
    thread: theirs,
    kind: "assigned",
    targetUserId: ana,
  });

  const out = await asSupervisor.query(api.reports.assignmentsByAgent, {
    sinceMs: Date.parse("2026-08-03T00:00:00Z"),
    untilMs: Date.parse("2026-08-04T00:00:00Z"),
    dayKeys: ["2026-08-03"],
    tzOffsetMinutes: 0,
  });

  expect(out.days[0].byAgent).toEqual({ [ana]: 1 });
});

test("assignmentsByAgent keeps a former member's leads, under a null name", async () => {
  const t = convexTest(schema, modules);
  const clock = makeClock(T0);
  clock(T0);
  const { accountId, asSupervisor } = await seedAccountWithSupervisor(t);
  // A user with NO `memberships` row for this account — someone who has since
  // left the team. Their handovers still happened.
  const gone = await t.run((ctx) =>
    ctx.db.insert("users", { name: "Gone", email: "gone@example.com" }),
  );
  const threadA = await seedThread(t, accountId, "1");

  await seedAssignment(t, clock, {
    accountId,
    atMs: Date.parse("2026-08-03T10:00:00Z"),
    thread: threadA,
    kind: "assigned",
    targetUserId: gone,
  });

  const out = await asSupervisor.query(api.reports.assignmentsByAgent, {
    sinceMs: Date.parse("2026-08-03T00:00:00Z"),
    untilMs: Date.parse("2026-08-04T00:00:00Z"),
    dayKeys: ["2026-08-03"],
    tzOffsetMinutes: 0,
  });

  expect(out.agents).toEqual([{ userId: gone, name: null, total: 1 }]);
  // Dropping them would make this disagree with the column beside it.
  expect(out.days[0].byAgent).toEqual({ [gone]: 1 });
});

test("assignmentsByAgent truncates the OLDEST days and says where", async () => {
  const t = convexTest(schema, modules);
  const clock = makeClock(T0);
  clock(T0);
  const { accountId, asSupervisor } = await seedAccountWithSupervisor(t);
  const ana = await seedAgent(t, accountId, "Ana");
  const threadA = await seedThread(t, accountId, "1");

  // One event on the 2nd...
  await seedAssignment(t, clock, {
    accountId,
    atMs: Date.parse("2026-08-02T10:00:00Z"),
    thread: threadA,
    kind: "assigned",
    targetUserId: ana,
  });

  // ...then the cap PLUS ONE on the 3rd, so the read is genuinely capped and
  // the 2nd falls off the descending take.
  clock(Date.parse("2026-08-03T10:00:00Z"));
  await t.run(async (ctx) => {
    for (let i = 0; i <= ASSIGNMENT_ROW_LIMIT; i++) {
      await ctx.db.insert("conversationEvents", {
        accountId,
        conversationId: threadA.conversationId,
        contactId: threadA.contactId,
        kind: "assigned",
        targetUserId: ana,
        source: "manual",
      });
    }
  });

  const out = await asSupervisor.query(api.reports.assignmentsByAgent, {
    sinceMs: Date.parse("2026-08-02T00:00:00Z"),
    untilMs: Date.parse("2026-08-04T00:00:00Z"),
    dayKeys: ["2026-08-02", "2026-08-03"],
    tzOffsetMinutes: 0,
  });

  expect(out.truncated).toBe(true);
  // The newest day survived — an ASCENDING take would have kept the 2nd and
  // dropped this, rendering a confident, wrong, short bar for the latest day.
  expect(out.earliestCoveredDay).toBe("2026-08-03");
  expect(out.days).toEqual([
    { dayKey: "2026-08-02", byAgent: {}, released: 0 },
    { dayKey: "2026-08-03", byAgent: { [ana]: 1 }, released: 0 },
  ]);
});

test("assignmentsByAgent reports no truncation at exactly the cap", async () => {
  const t = convexTest(schema, modules);
  const clock = makeClock(T0);
  clock(T0);
  const { accountId, asSupervisor } = await seedAccountWithSupervisor(t);
  const ana = await seedAgent(t, accountId, "Ana");
  const threadA = await seedThread(t, accountId, "1");

  clock(Date.parse("2026-08-03T10:00:00Z"));
  await t.run(async (ctx) => {
    for (let i = 0; i < ASSIGNMENT_ROW_LIMIT; i++) {
      await ctx.db.insert("conversationEvents", {
        accountId,
        conversationId: threadA.conversationId,
        contactId: threadA.contactId,
        kind: "assigned",
        targetUserId: ana,
        source: "manual",
      });
    }
  });

  const out = await asSupervisor.query(api.reports.assignmentsByAgent, {
    sinceMs: Date.parse("2026-08-03T00:00:00Z"),
    untilMs: Date.parse("2026-08-04T00:00:00Z"),
    dayKeys: ["2026-08-03"],
    tzOffsetMinutes: 0,
  });

  // Exactly CAP rows is a COMPLETE report, not a capped one. A `take(CAP)`
  // read cannot tell these apart and would warn on a correct report.
  expect(out.truncated).toBe(false);
  expect(out.earliestCoveredDay).toBeNull();
});

test("assignmentsByAgent is supervisor-gated", async () => {
  const t = convexTest(schema, modules);
  const clock = makeClock(T0);
  clock(T0);
  const { asAgent } = await seedAccountWithSupervisor(t);

  await expect(
    asAgent.query(api.reports.assignmentsByAgent, {
      sinceMs: T0,
      untilMs: T0 + 86_400_000,
      dayKeys: ["2026-08-01"],
      tzOffsetMinutes: 0,
    }),
  ).rejects.toThrow();
});
