import { describe, it, expect, vi } from "vitest";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { META_EVENT_CATALOGUE } from "./lib/metaEventStats";
import { encrypt } from "./lib/whatsappEncryption";

// This repo declares the module glob per test file rather than sharing a
// setup module — see convex/campaignAds.test.ts:11.
const modules = import.meta.glob("/convex/**/*.ts");

/**
 * Seeds one account with a supervisor member (who can call
 * `metaEventReconciliation`) and an agent member (who is below the
 * supervisor floor). Copied from `reports.test.ts`'s
 * `seedAccountWithSupervisor` rather than imported — this repo has no
 * shared test-setup module, and every other `convex/*.test.ts` file
 * duplicates its own seed helper rather than reaching into a sibling
 * file (see e.g. `dashboard.test.ts`'s own `seedAccountMember`). The
 * brief for this task names a `seedAccountWithRoles` helper on
 * `reports.test.ts`; no such helper exists there — this is the real one,
 * under its real name.
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

/** Asia/Dubai is UTC+4, i.e. `tzOffsetMinutes` -240 in this codebase's
 *  convention. This is `localDayKeyFromMs` inlined at that offset, so the
 *  fixtures below build the same day keys the query will. */
const DUBAI_OFFSET_MINUTES = -240;
function dubaiDayKey(daysAgo = 0): string {
  return new Date(
    Date.now() - DUBAI_OFFSET_MINUTES * 60_000 - daysAgo * 86_400_000,
  )
    .toISOString()
    .slice(0, 10);
}

/**
 * Runs `fn` with the clock wound back `daysAgo` days, so every row it
 * inserts gets a `_creationTime` inside the reconciliation window.
 *
 * `metaEventReconciliation`'s window ends at YESTERDAY's local midnight —
 * settled days only, see its `untilMs` comment — so on day Q the last day
 * it covers is Q-2. A fixture created at the real `Date.now()`, or even
 * one day back, falls outside every window by construction; two days back
 * is the first that lands inside one.
 *
 * `convex-test` takes `_creationTime` from `Date.now()` and keeps it
 * monotonic per instance, which is why the ACCOUNT seed has to happen
 * inside this too: a real-time insert first would push every later
 * "backdated" row forward to match it.
 *
 * Only `Date` is faked; faking timers as well would stall the awaits.
 */
async function seededDaysAgo<T>(daysAgo: number, fn: () => Promise<T>): Promise<T> {
  const realNow = Date.now();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(realNow - daysAgo * 86_400_000);
  try {
    return await fn();
  } finally {
    vi.useRealTimers();
  }
}

let seq = 0;

/**
 * Inserts one `conversionEvents` row, on its own freshly-created
 * conversation/contact (so distinct calls count as distinct leads for the
 * DISTINCT-CONVERSATION folds in `buildReconciliation`), with every
 * required field from `convex/schema.ts:2611` supplied. Defaults to the
 * `ctwa` lane, since that is the lane the query under test must select —
 * override it to seed a `code`-lane row for the lane-filter test.
 */
async function seedConversionEvent(
  t: ReturnType<typeof convexTest>,
  accountId: Id<"accounts">,
  opts: {
    stage:
      | "new_lead"
      | "qualified"
      | "price_quoted"
      | "itinerary_created"
      | "itinerary_sent"
      | "invoice_sent"
      | "purchased";
    eventName: string;
    status: "pending" | "sent" | "unmatched" | "error" | "abandoned" | "dormant";
    lane?: "code" | "ctwa";
  },
) {
  seq += 1;
  const n = seq;
  return await t.run(async (ctx) => {
    const phone = `+97150000${String(1000 + n).slice(-4)}`;
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
    const lane = opts.lane ?? "ctwa";
    await ctx.db.insert("conversionEvents", {
      accountId,
      conversationId,
      contactId,
      stage: opts.stage,
      lane,
      backend: lane === "ctwa" ? "capi" : "platformA",
      eventName: opts.eventName,
      identifier: `clid-${n}`,
      phone,
      waMessageId: `wamid.${n}`,
      firstMessageAt: Date.now(),
      eventId: `${conversationId}:${opts.stage}`,
      status: opts.status,
      attempts: 1,
    });
    return { conversationId, contactId, phone };
  });
}

describe("metaEventReconciliation", () => {
  it("requires supervisor", async () => {
    const t = convexTest(schema, modules);
    const { asAgent } = await seedAccountWithSupervisor(t);
    await expect(
      asAgent.query(api.reports.metaEventReconciliation, { rangeDays: 7 }),
    ).rejects.toThrow(/FORBIDDEN/);
  });

  it("returns a row per catalogue entry with Meta unknown when never synced", async () => {
    const t = convexTest(schema, modules);
    const { asSupervisor } = await seedAccountWithSupervisor(t);
    const out = await asSupervisor.query(api.reports.metaEventReconciliation, {
      rangeDays: 7,
    });
    expect(out.meta.available).toBe(false);
    // Never synced is UNKNOWN, not zero.
    expect(out.rows.every((r) => r.recorded === null)).toBe(true);
  });

  it("pins the window to the DATASET timezone, not the viewer's", async () => {
    const t = convexTest(schema, modules);
    const { asSupervisor, accountId } = await seedAccountWithSupervisor(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("metaDatasetSyncState", {
        accountId,
        datasetId: "ds1",
        available: true,
        tzName: "Asia/Dubai",
        tzOffsetMinutes: -240,
        lastSyncedAt: Date.now(),
      });
    });
    const out = await asSupervisor.query(api.reports.metaEventReconciliation, {
      rangeDays: 7,
    });
    expect(out.meta.tzOffsetMinutes).toBe(-240);
    // The window's lower bound is a local midnight in the DATASET's zone:
    // 00:00 Asia/Dubai is 20:00 UTC the previous day.
    expect(new Date(out.meta.sinceMs).getUTCHours()).toBe(20);
  });

  it("counts reached and delivered from conversionEvents in the window", async () => {
    const t = convexTest(schema, modules);
    const { asSupervisor, accountId } = await seededDaysAgo(2, async () => {
      const seeded = await seedAccountWithSupervisor(t);
      await seedConversionEvent(t, seeded.accountId, {
        stage: "qualified",
        eventName: "QualifiedLead",
        status: "sent",
      });
      await seedConversionEvent(t, seeded.accountId, {
        stage: "qualified",
        eventName: "QualifiedLead",
        status: "unmatched",
      });
      return seeded;
    });
    void accountId;
    const out = await asSupervisor.query(api.reports.metaEventReconciliation, {
      rangeDays: 7,
    });
    const row = out.rows.find((r) => r.stage === "qualified")!;
    expect(row.reached).toBe(2);
    expect(row.delivered).toBe(1);
    expect(row.byStatus.unmatched).toBe(1);
  });

  // OVERRIDE 1 — the Recorded column can only ever hold CTWA (business-
  // messaging / CAPI) counts: the code lane (web pixel) reports to a
  // completely different Meta surface. Without this filter, a web-pixel
  // conversion would inflate `reached`/`delivered` against a `recorded`
  // column that structurally can never contain it, manufacturing a
  // permanent false delivery gap. See the filter's own comment in
  // `reports.ts`.
  it("counts only the ctwa lane toward reached — a code-lane row at the same stage must not count", async () => {
    const t = convexTest(schema, modules);
    const { asSupervisor } = await seededDaysAgo(2, async () => {
      const seeded = await seedAccountWithSupervisor(t);
      await seedConversionEvent(t, seeded.accountId, {
        stage: "qualified",
        eventName: "QualifiedLead",
        status: "sent",
        lane: "ctwa",
      });
      await seedConversionEvent(t, seeded.accountId, {
        stage: "qualified",
        eventName: "Lead",
        status: "sent",
        lane: "code",
      });
      return seeded;
    });
    const out = await asSupervisor.query(api.reports.metaEventReconciliation, {
      rangeDays: 7,
    });
    const row = out.rows.find((r) => r.stage === "qualified")!;
    expect(row.reached).toBe(1);
    expect(row.delivered).toBe(1);
  });

  it("fills recorded from stored Meta counts once available", async () => {
    const t = convexTest(schema, modules);
    const { asSupervisor, accountId } = await seedAccountWithSupervisor(t);
    const tzOffsetMinutes = DUBAI_OFFSET_MINUTES;
    // Two days back: the window ends at YESTERDAY's local midnight, so a
    // count stored under today's or yesterday's key is outside it by
    // design.
    const lastCompleteKey = dubaiDayKey(2);
    await t.run(async (ctx) => {
      await ctx.db.insert("metaDatasetSyncState", {
        accountId,
        datasetId: "ds1",
        available: true,
        tzName: "Asia/Dubai",
        tzOffsetMinutes,
        lastSyncedAt: Date.now(),
        // Coverage spanning the whole requested window is now a
        // PRECONDITION for any number appearing in `recorded` — see the
        // uncovered-window test below.
        coveredSinceDayKey: dubaiDayKey(30),
        coveredUntilDayKey: dubaiDayKey(1),
      });
      await ctx.db.insert("metaEventDailyStats", {
        accountId,
        datasetId: "ds1",
        dayKey: lastCompleteKey,
        eventName: "QualifiedLead",
        count: 8,
        syncedAt: Date.now(),
      });
    });
    const out = await asSupervisor.query(api.reports.metaEventReconciliation, {
      rangeDays: 7,
    });
    expect(out.rows.find((r) => r.stage === "qualified")!.recorded).toBe(8);
  });

  // --- coverage: the difference between "Meta has none" and "we have not
  // --- read that far back" ------------------------------------------------
  //
  // THE discriminating test of the coverage fix. Before it, any successful
  // sync set `available: true`, the query built a counts Map from the
  // handful of days it happened to hold, and `buildReconciliation`'s
  // `?? 0` turned the other 27 days of a default 30-day window into
  // zeros — a large negative delta on every row, alleging a delivery
  // failure that never happened, on the default tab state.
  it("reports every recorded as UNKNOWN when the sync has not read back across the window", async () => {
    const t = convexTest(schema, modules);
    const { asSupervisor, accountId } = await seedAccountWithSupervisor(t);
    await seedConversionEvent(t, accountId, {
      stage: "qualified",
      eventName: "QualifiedLead",
      status: "sent",
    });
    await t.run(async (ctx) => {
      await ctx.db.insert("metaDatasetSyncState", {
        accountId,
        datasetId: "ds1",
        available: true,
        tzName: "Asia/Dubai",
        tzOffsetMinutes: DUBAI_OFFSET_MINUTES,
        lastSyncedAt: Date.now(),
        // Three days of coverage — what the incremental sync alone
        // produces — against the 30-day window requested below.
        coveredSinceDayKey: dubaiDayKey(2),
        coveredUntilDayKey: dubaiDayKey(1),
      });
      await ctx.db.insert("metaEventDailyStats", {
        accountId,
        datasetId: "ds1",
        dayKey: dubaiDayKey(0),
        eventName: "QualifiedLead",
        count: 8,
        syncedAt: Date.now(),
      });
    });
    const out = await asSupervisor.query(api.reports.metaEventReconciliation, {
      rangeDays: 30,
    });
    // EVERY row, not just the ones with no stored counts. A partial sum
    // is the dangerous answer precisely because it looks like a number:
    // the `qualified` row would otherwise report Meta's 8 for one day
    // against 30 days of `delivered`.
    expect(out.rows.every((r) => r.recorded === null)).toBe(true);
    expect(out.rows.every((r) => r.delta === null)).toBe(true);
    // Reported as a coverage gap, not as an error: the sync worked.
    expect(out.meta.coverageGap).toBe(`${dubaiDayKey(2)} to ${dubaiDayKey(1)}`);
    expect(out.meta.lastError).toBeNull();
    expect(out.meta.available).toBe(true);
  });

  it("fills recorded on a window the coverage DOES span", async () => {
    // The positive control for the test above — same fixture, narrower
    // window — so the null result there cannot be passing for some
    // unrelated reason.
    const t = convexTest(schema, modules);
    const { asSupervisor, accountId } = await seedAccountWithSupervisor(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("metaDatasetSyncState", {
        accountId,
        datasetId: "ds1",
        available: true,
        tzName: "Asia/Dubai",
        tzOffsetMinutes: DUBAI_OFFSET_MINUTES,
        lastSyncedAt: Date.now(),
        coveredSinceDayKey: dubaiDayKey(3),
        coveredUntilDayKey: dubaiDayKey(1),
      });
      await ctx.db.insert("metaEventDailyStats", {
        accountId,
        datasetId: "ds1",
        dayKey: dubaiDayKey(2),
        eventName: "QualifiedLead",
        count: 8,
        syncedAt: Date.now(),
      });
    });
    // Two days: the window ends at yesterday's midnight, so this asks for
    // days Q-3 and Q-2 — both inside the seeded coverage.
    const out = await asSupervisor.query(api.reports.metaEventReconciliation, {
      rangeDays: 2,
    });
    expect(out.meta.coverageGap).toBeNull();
    expect(out.rows.find((r) => r.stage === "qualified")!.recorded).toBe(8);
  });

  it("counts a window as covered when the sync reached only YESTERDAY", async () => {
    // The state a DAILY cron leaves behind for most of every day, and the
    // reason the window stops at today's local midnight. When the window
    // ran to tomorrow's midnight it always contained today, so
    // `coversWindow` required `coveredUntil >= today` and the tab blacked
    // out from local midnight until the next sync — which at a bad cron
    // phase is nearly the whole day.
    const t = convexTest(schema, modules);
    const { asSupervisor, accountId } = await seedAccountWithSupervisor(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("metaDatasetSyncState", {
        accountId,
        datasetId: "ds1",
        available: true,
        tzName: "Asia/Dubai",
        tzOffsetMinutes: DUBAI_OFFSET_MINUTES,
        // Yesterday's run, and nothing since.
        lastSyncedAt: Date.now() - 86_400_000,
        coveredSinceDayKey: dubaiDayKey(30),
        coveredUntilDayKey: dubaiDayKey(1),
      });
      await ctx.db.insert("metaEventDailyStats", {
        accountId,
        datasetId: "ds1",
        dayKey: dubaiDayKey(2),
        eventName: "QualifiedLead",
        count: 8,
        syncedAt: Date.now() - 86_400_000,
      });
    });
    const out = await asSupervisor.query(api.reports.metaEventReconciliation, {
      rangeDays: 7,
    });
    expect(out.meta.coverageGap).toBeNull();
    expect(out.rows.find((r) => r.stage === "qualified")!.recorded).toBe(8);
    // The window itself: settled days only, ending at YESTERDAY's local
    // midnight.
    expect(out.meta.untilMs).toBe(
      Date.parse(`${dubaiDayKey(1)}T00:00:00Z`) + DUBAI_OFFSET_MINUTES * 60_000,
    );
  });

  // THE cross-midnight case, and the one no other test exercised: a real
  // sync run, then the clock crosses the dataset's local midnight with NO
  // further sync, then a query. It is the shape of every morning under a
  // daily cron, and it is where an off-by-one in the day boundary hides —
  // every fixture-driven test above pins `coveredUntilDayKey` by hand and
  // so cannot catch the two sides drifting apart.
  //
  // Work it through: the sync runs on day R and claims through R-1; the
  // query happens on day R+1 (= Q, so R = Q-1) and asks for days through
  // Q-2 = R-1. `coveredUntil >= dayKeys[last]` holds exactly, with nothing
  // to spare — which is the point. Ending the query's window one day later
  // (at today's midnight) makes it ask for Q-1 = R, one day past what any
  // sync on day R can claim, and the tab em-dashes until that day's run.
  it("keeps coverage across the local midnight, with no sync since yesterday", async () => {
    const t = convexTest(schema, modules);
    const { asSupervisor, accountId } = await seedAccountWithSupervisor(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("whatsappConfig", {
        accountId,
        wabaId: "WABA1",
        phoneNumberId: "PN1",
        accessToken: await encrypt("secret-token"),
        status: "connected",
      });
    });

    // Resolved HERE, at the real clock, and captured. The mock body runs
    // when `fetch` is called — inside the wound-back clock below — so
    // computing these lazily would date every row a further day back.
    const settledDay = dubaiDayKey(2);
    const dayOfTheRun = dubaiDayKey(1);

    const realFetch = globalThis.fetch;
    process.env.META_CAPI_DATASET_ID = "ds1";
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          timezone_name: "Asia/Dubai",
          data: [
            // The last day that had closed when the sync ran.
            { date: settledDay, event: "QualifiedLead", count: 8 },
            // ...and the day it ran on, still in progress then. Stored,
            // but outside the query's window and outside the claim.
            { date: dayOfTheRun, event: "QualifiedLead", count: 3 },
          ],
        }),
        { status: 200 },
      )) as typeof fetch;
    try {
      // Run the sync as it would have run YESTERDAY, then let the clock
      // return to now — i.e. cross the local midnight with no further run.
      await seededDaysAgo(1, () =>
        t.action(internal.metaEventStats.syncDatasetStats, { accountId }),
      );
    } finally {
      globalThis.fetch = realFetch;
      delete process.env.META_CAPI_DATASET_ID;
    }

    const state = await t.run(async (ctx) =>
      ctx.db.query("metaDatasetSyncState").unique(),
    );
    // Yesterday's run claimed through the day before it — nothing since.
    expect(state!.coveredUntilDayKey).toBe(dubaiDayKey(2));

    const out = await asSupervisor.query(api.reports.metaEventReconciliation, {
      rangeDays: 7,
    });
    // Still covered this morning, and `recorded` is a NUMBER — not the
    // em dash a blacked-out tab would show.
    expect(out.meta.coverageGap).toBeNull();
    // 8, not 11: the day the sync RAN on is stored but sits outside both
    // the claim and the window, so it cannot leak into the reconciliation.
    expect(out.rows.find((r) => r.stage === "qualified")!.recorded).toBe(8);
  });

  it("reports unknown when an available sync recorded no coverage bounds at all", async () => {
    // The migration state: rows written before the coverage fields
    // existed. Absent bounds are UNKNOWN bounds, never "everything".
    const t = convexTest(schema, modules);
    const { asSupervisor, accountId } = await seedAccountWithSupervisor(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("metaDatasetSyncState", {
        accountId,
        datasetId: "ds1",
        available: true,
        tzName: "Asia/Dubai",
        tzOffsetMinutes: DUBAI_OFFSET_MINUTES,
        lastSyncedAt: Date.now(),
      });
      await ctx.db.insert("metaEventDailyStats", {
        accountId,
        datasetId: "ds1",
        dayKey: dubaiDayKey(2),
        eventName: "QualifiedLead",
        count: 8,
        syncedAt: Date.now(),
      });
    });
    const out = await asSupervisor.query(api.reports.metaEventReconciliation, {
      rangeDays: 7,
    });
    expect(out.rows.every((r) => r.recorded === null)).toBe(true);
    // Empty string, not null: there IS a gap, we just cannot name the
    // range it covers. The panel has its own copy for this case.
    expect(out.meta.coverageGap).toBe("");
  });

  // Important-1 fix regression: `rangeDays` had no lower bound. A value
  // that collapses `sinceMs >= untilMs` (0, negative, or the un-truncated
  // fractional case) made `datasetDayKeys` return an EMPTY array, and the
  // `metaEventDailyStats` range read then passed `dayKeys[0]` /
  // `dayKeys[dayKeys.length - 1]` — both `undefined` — straight into
  // `.gte("dayKey", ...).lte("dayKey", ...)`.
  //
  // A prior version of this test only asserted "does not throw" plus some
  // shape checks on `rows`. That does NOT discriminate: `convex-test`'s
  // in-memory index engine tolerates `undefined` bounds silently (returns
  // zero rows) rather than throwing the way a real deployed backend would,
  // so that test passed identically whether or not the clamp was applied —
  // confirmed by hand, and it is exactly the kind of test that reads as
  // coverage while proving nothing.
  //
  // The clamp's OWN arithmetic effect does not depend on the index/harness
  // at all: it changes the WIDTH of the window this query returns in
  // `meta`. `rangeDays: 0` unclamped leaves `sinceMs === untilMs` (a
  // zero-width window); clamped, `Math.max(1, ...)` floors it to exactly
  // one day. Asserting that span fails on the unclamped code and passes on
  // the clamped code, in any harness, because it tests the computation
  // that was actually changed rather than something downstream of it.
  it("clamps rangeDays: 0 to a one-day window (against an available sync)", async () => {
    const t = convexTest(schema, modules);
    const { asSupervisor, accountId } = await seedAccountWithSupervisor(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("metaDatasetSyncState", {
        accountId,
        datasetId: "ds1",
        available: true,
        tzName: "Asia/Dubai",
        tzOffsetMinutes: -240,
        lastSyncedAt: Date.now(),
        coveredSinceDayKey: dubaiDayKey(2),
        coveredUntilDayKey: dubaiDayKey(1),
      });
    });
    const out = await asSupervisor.query(api.reports.metaEventReconciliation, {
      rangeDays: 0,
    });
    expect(out.meta.untilMs - out.meta.sinceMs).toBe(86_400_000);
    // Kept from the prior version: the query still comes back with the
    // full catalogue and a resolved (never `undefined`) `recorded` per
    // reportable row, rather than blowing up on the way there.
    expect(out.rows).toHaveLength(META_EVENT_CATALOGUE.length);
    for (const row of out.rows) {
      if (row.eventName === null) {
        expect(row.recorded).toBeNull();
      } else {
        expect(typeof row.recorded).toBe("number");
      }
    }
  });

  // `Math.trunc` is the other half of the same clamp — it closes the
  // fractional-`rangeDays` case (`v.number()` admits e.g. `2.5`). Same
  // span-based assertion: 2.5 truncated is 2 whole days; untruncated it
  // would leave a fractional-day window (`untilMs - sinceMs` would not be
  // a whole multiple of `86_400_000`).
  it("truncates a fractional rangeDays to whole days", async () => {
    const t = convexTest(schema, modules);
    const { asSupervisor, accountId } = await seedAccountWithSupervisor(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("metaDatasetSyncState", {
        accountId,
        datasetId: "ds1",
        available: true,
        tzName: "Asia/Dubai",
        tzOffsetMinutes: -240,
        lastSyncedAt: Date.now(),
      });
    });
    const out = await asSupervisor.query(api.reports.metaEventReconciliation, {
      rangeDays: 2.5,
    });
    expect(out.meta.untilMs - out.meta.sinceMs).toBe(2 * 86_400_000);
  });
});
