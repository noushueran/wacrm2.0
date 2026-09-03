import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { convexTest } from "convex-test";
import schema from "./schema";
import { internal } from "./_generated/api";
import { redactTokens } from "./metaEventStats";
import type { Id } from "./_generated/dataModel";
import { encrypt } from "./lib/whatsappEncryption";

// This repo declares the module glob per test file rather than sharing
// a setup module — see convex/campaignAds.test.ts:11.
const modules = import.meta.glob("/convex/**/*.ts");

async function seedAccount(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {
      name: "Acme",
      email: "acme@example.com",
    });
    return await ctx.db.insert("accounts", {
      name: "Acme's account",
      defaultCurrency: "USD",
      ownerUserId: userId,
    });
  });
}

/**
 * `syncDatasetStats` decrypts `config.accessToken` whenever
 * `META_CAPI_ACCESS_TOKEN` is unset (exactly the case these tests
 * exercise), so the seeded token must be real ciphertext `decrypt` can
 * open — `convex/conversionEvents.test.ts`'s `seedWaba` gets away with a
 * plain `"test-token"` only because every one of its no-env-var tests
 * also unsets `META_CAPI_DATASET_ID`, which short-circuits before
 * `decrypt` is ever reached. Ours does not, so this uses `encrypt` the
 * way `convex/automationsEngine.test.ts:1972` does for the same reason.
 */
async function seedWhatsappConfig(
  t: ReturnType<typeof convexTest>,
  accountId: Id<"accounts">,
) {
  await t.run(async (ctx) => {
    await ctx.db.insert("whatsappConfig", {
      accountId,
      wabaId: "WABA1",
      phoneNumberId: "PN1",
      accessToken: await encrypt("secret-token"),
      status: "connected",
    });
  });
}

describe("upsertDayCounts", () => {
  it("writes one row per event name for the day", async () => {
    const t = convexTest(schema, modules);
    const accountId = await seedAccount(t);
    await t.mutation(internal.metaEventStats.upsertDayCounts, {
      accountId,
      datasetId: "ds1",
      dayKey: "2026-09-02",
      counts: { LeadSubmitted: 40, QualifiedLead: 8 },
    });
    const rows = await t.run(async (ctx) =>
      ctx.db.query("metaEventDailyStats").collect(),
    );
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.eventName === "QualifiedLead")!.count).toBe(8);
  });

  it("OVERWRITES on re-sync rather than accumulating", async () => {
    const t = convexTest(schema, modules);
    const accountId = await seedAccount(t);
    const args = {
      accountId,
      datasetId: "ds1",
      dayKey: "2026-09-02",
      counts: { QualifiedLead: 8 },
    };
    await t.mutation(internal.metaEventStats.upsertDayCounts, args);
    await t.mutation(internal.metaEventStats.upsertDayCounts, {
      ...args,
      counts: { QualifiedLead: 9 },
    });
    const rows = await t.run(async (ctx) =>
      ctx.db.query("metaEventDailyStats").collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].count).toBe(9);
  });

  it("DELETES a row for an event Meta no longer reports for that day", async () => {
    // The stale-row deletion in `upsertDayCounts` had no test. It is not
    // tidying: a row left behind from an earlier sync is a count Meta no
    // longer reports, and it would sum into `recorded` as a delivery
    // surplus that does not exist — the same lie as double-counting.
    const t = convexTest(schema, modules);
    const accountId = await seedAccount(t);
    await t.mutation(internal.metaEventStats.upsertDayCounts, {
      accountId,
      datasetId: "ds1",
      dayKey: "2026-09-02",
      counts: { LeadSubmitted: 40, QualifiedLead: 8 },
    });
    await t.mutation(internal.metaEventStats.upsertDayCounts, {
      accountId,
      datasetId: "ds1",
      dayKey: "2026-09-02",
      counts: { LeadSubmitted: 41 },
    });
    const rows = await t.run(async (ctx) =>
      ctx.db.query("metaEventDailyStats").collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].eventName).toBe("LeadSubmitted");
    expect(rows[0].count).toBe(41);
  });

  it("keeps two datasets' counts for the same day apart", async () => {
    const t = convexTest(schema, modules);
    const accountId = await seedAccount(t);
    await t.mutation(internal.metaEventStats.upsertDayCounts, {
      accountId, datasetId: "ds1", dayKey: "2026-09-02", counts: { Purchase: 1 },
    });
    await t.mutation(internal.metaEventStats.upsertDayCounts, {
      accountId, datasetId: "ds2", dayKey: "2026-09-02", counts: { Purchase: 7 },
    });
    const rows = await t.run(async (ctx) =>
      ctx.db.query("metaEventDailyStats").collect(),
    );
    expect(rows).toHaveLength(2);
  });
});

describe("putSyncState", () => {
  it("keeps exactly one row per account across repeated writes", async () => {
    const t = convexTest(schema, modules);
    const accountId = await seedAccount(t);
    await t.mutation(internal.metaEventStats.putSyncState, {
      accountId, datasetId: "ds1", available: true,
      tzName: "Asia/Dubai", tzOffsetMinutes: -240, lastSyncedAt: 1,
    });
    await t.mutation(internal.metaEventStats.putSyncState, {
      accountId, datasetId: "ds1", available: false, lastError: "boom",
    });
    const rows = await t.run(async (ctx) =>
      ctx.db.query("metaDatasetSyncState").collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].available).toBe(false);
    expect(rows[0].lastError).toBe("boom");
  });

  it("retains the last known offset through a failed sync", async () => {
    const t = convexTest(schema, modules);
    const accountId = await seedAccount(t);
    await t.mutation(internal.metaEventStats.putSyncState, {
      accountId, datasetId: "ds1", available: true,
      tzName: "Asia/Dubai", tzOffsetMinutes: -240, lastSyncedAt: 1,
    });
    await t.mutation(internal.metaEventStats.putSyncState, {
      accountId, datasetId: "ds1", available: false, lastError: "boom",
    });
    const state = await t.query(internal.metaEventStats.getSyncState, { accountId });
    // The offset already-synced days were written under must survive, or
    // history becomes unreadable the moment one sync fails.
    expect(state!.tzOffsetMinutes).toBe(-240);
  });

  it("clears lastError once a prior failure is followed by a success", async () => {
    // Coverage gap flagged in Task 2's review: the "clear lastError on
    // success" rule is enforced by `putSyncState`'s patch branch, but
    // nothing previously drove it failure-then-success. This is the
    // direct test for that property.
    const t = convexTest(schema, modules);
    const accountId = await seedAccount(t);
    await t.mutation(internal.metaEventStats.putSyncState, {
      accountId, datasetId: "ds1", available: false, lastError: "boom",
    });
    await t.mutation(internal.metaEventStats.putSyncState, {
      accountId, datasetId: "ds1", available: true,
      tzName: "Asia/Dubai", tzOffsetMinutes: -240, lastSyncedAt: 1,
    });
    const state = await t.query(internal.metaEventStats.getSyncState, { accountId });
    expect(state!.available).toBe(true);
    expect(state!.lastError).toBeUndefined();
  });
});

const origFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = origFetch;
  delete process.env.META_CAPI_DATASET_ID;
});
beforeEach(() => {
  process.env.META_CAPI_DATASET_ID = "ds1";
});

/** `localDayKeyFromMs` inlined at Asia/Dubai's offset (UTC+4 → -240 in
 *  this codebase's convention), so the assertions below build the same
 *  day keys the action will. */
const DUBAI_OFFSET_MINUTES = -240;
const DAY_MS = 86_400_000;
function dubaiDayKey(daysAgo = 0): string {
  return new Date(
    Date.now() - DUBAI_OFFSET_MINUTES * 60_000 - daysAgo * DAY_MS,
  )
    .toISOString()
    .slice(0, 10);
}

/** Mocks Graph with `body` and returns the array the request URLs land
 *  in — the requested window is the thing under test in the coverage
 *  cases, so it has to be observable. */
function captureFetch(body: unknown): string[] {
  const urls: string[] = [];
  globalThis.fetch = (async (input: unknown) => {
    urls.push(String(input));
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
  return urls;
}

function startTimeMs(url: string): number {
  return Number(new URL(url).searchParams.get("start_time")) * 1000;
}

const OK_BODY = { timezone_name: "Asia/Dubai", data: [] };

describe("syncDatasetStats coverage window", () => {
  it("reaches back the full initial window on a first sync, and records both bounds", async () => {
    // The defect this replaces: the sync stored ~3 days while the range
    // picker offers up to 90 and defaults to 30, so `recorded` was
    // summed over 3 of 30 days against a `delivered` counted over all
    // 30 — a large negative delta on every row, from the first cron run
    // onward.
    const t = convexTest(schema, modules);
    const accountId = await seedAccount(t);
    await seedWhatsappConfig(t, accountId);
    const urls = captureFetch(OK_BODY);
    await t.action(internal.metaEventStats.syncDatasetStats, { accountId });

    const daysRequested = (Date.now() - startTimeMs(urls[0])) / DAY_MS;
    // 90 whole days back from a floored anchor: at least 90, and under
    // 92 (the anchor carries a day of slack because no dataset offset is
    // known yet on a first run).
    expect(daysRequested).toBeGreaterThanOrEqual(90);
    expect(daysRequested).toBeLessThan(92);

    const state = await t.query(internal.metaEventStats.getSyncState, { accountId });
    expect(state!.coveredUntilDayKey).toBe(dubaiDayKey(1));
    // Asserted as a RELATION, not as one exact key. The first-run anchor
    // carries a day of slack (no dataset offset is known yet), so the
    // claim lands 90 or 91 days back depending on the time of day — and
    // the property that matters is not which of those it is, but that
    // the widest window the picker offers is inside it. A 90-day window
    // runs from `dubaiDayKey(89)` through today (see
    // `metaEventReconciliation`'s `datasetDayKeys`).
    //
    // String comparison on `YYYY-MM-DD` is chronological comparison.
    expect(state!.coveredSinceDayKey! <= dubaiDayKey(89)).toBe(true);
    // ...and not absurdly further, which would mean claiming days the
    // request never reached.
    expect(state!.coveredSinceDayKey! >= dubaiDayKey(91)).toBe(true);
  });

  it("claims only COMPLETE days — a mid-day run stops at yesterday", async () => {
    // `end_time` is `now`, a time-of-day, so today has been read only up
    // to this instant. Claiming it would let `metaEventReconciliation`
    // fold a stale, still-settling count for today against a live
    // `reached`/`delivered` and render the difference as a plain number
    // with no degraded marker — this feature's own failure mode, in
    // miniature. Today's counts are still STORED; they are just not
    // claimed.
    const t = convexTest(schema, modules);
    const accountId = await seedAccount(t);
    await seedWhatsappConfig(t, accountId);
    captureFetch({
      timezone_name: "Asia/Dubai",
      data: [
        { date: dubaiDayKey(0), event: "QualifiedLead", count: 3 },
        { date: dubaiDayKey(1), event: "QualifiedLead", count: 8 },
      ],
    });
    await t.action(internal.metaEventStats.syncDatasetStats, { accountId });

    const state = await t.query(internal.metaEventStats.getSyncState, { accountId });
    expect(state!.coveredUntilDayKey).toBe(dubaiDayKey(1));
    expect(state!.coveredUntilDayKey).not.toBe(dubaiDayKey(0));

    // Today's partial count is real and is kept — it simply is not part
    // of the covered range, so nothing reconciles against it yet.
    const rows = await t.run(async (ctx) =>
      ctx.db.query("metaEventDailyStats").collect(),
    );
    expect(rows.map((r) => r.dayKey).sort()).toEqual(
      [dubaiDayKey(1), dubaiDayKey(0)].sort(),
    );
  });

  it("stores a paginated response's rows but claims NO coverage for it", async () => {
    // `paging.next` is Meta saying rows exist that this response did not
    // carry. Storing page 1 and claiming the whole 90-day window as read
    // would put the false zeros back in by another route, silently. The
    // rows are kept — they are real — and the claim is withheld, so the
    // tab reads "unknown" rather than confidently wrong.
    const t = convexTest(schema, modules);
    const accountId = await seedAccount(t);
    await seedWhatsappConfig(t, accountId);
    captureFetch({
      timezone_name: "Asia/Dubai",
      data: [{ date: dubaiDayKey(1), event: "QualifiedLead", count: 8 }],
      paging: { next: "https://graph.facebook.com/v25.0/ds1/stats?after=CURSOR" },
    });
    await t.action(internal.metaEventStats.syncDatasetStats, { accountId });

    const state = await t.query(internal.metaEventStats.getSyncState, { accountId });
    // Still a successful READ — this is not an error state, and the
    // timezone and sync time are worth keeping.
    expect(state!.available).toBe(true);
    expect(state!.coveredSinceDayKey).toBeUndefined();
    expect(state!.coveredUntilDayKey).toBeUndefined();

    const rows = await t.run(async (ctx) =>
      ctx.db.query("metaEventDailyStats").collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].count).toBe(8);
  });

  it("leaves an EXISTING claim untouched when a later response is paginated", async () => {
    // The claim is withheld, not withdrawn: coverage already earned by
    // earlier complete reads stays exactly as it was, the same rule a
    // failed sync follows.
    const t = convexTest(schema, modules);
    const accountId = await seedAccount(t);
    await seedWhatsappConfig(t, accountId);
    await t.run(async (ctx) => {
      await ctx.db.insert("metaDatasetSyncState", {
        accountId,
        datasetId: "ds1",
        available: true,
        tzName: "Asia/Dubai",
        tzOffsetMinutes: DUBAI_OFFSET_MINUTES,
        lastSyncedAt: Date.now() - DAY_MS,
        coveredSinceDayKey: dubaiDayKey(30),
        coveredUntilDayKey: dubaiDayKey(2),
      });
    });
    captureFetch({
      timezone_name: "Asia/Dubai",
      data: [{ date: dubaiDayKey(1), event: "QualifiedLead", count: 8 }],
      paging: { next: "https://graph.facebook.com/v25.0/ds1/stats?after=CURSOR" },
    });
    await t.action(internal.metaEventStats.syncDatasetStats, { accountId });
    const state = await t.query(internal.metaEventStats.getSyncState, { accountId });
    expect(state!.coveredSinceDayKey).toBe(dubaiDayKey(30));
    expect(state!.coveredUntilDayKey).toBe(dubaiDayKey(2));
  });

  it("claims coverage normally when paging carries only cursors", async () => {
    // Graph returns `paging.cursors` on COMPLETE responses too. Gating on
    // the presence of a `paging` object rather than on `next` would
    // degrade a perfectly good endpoint forever.
    const t = convexTest(schema, modules);
    const accountId = await seedAccount(t);
    await seedWhatsappConfig(t, accountId);
    captureFetch({
      timezone_name: "Asia/Dubai",
      data: [{ date: dubaiDayKey(1), event: "QualifiedLead", count: 8 }],
      paging: { cursors: { before: "BEFORE", after: "AFTER" } },
    });
    await t.action(internal.metaEventStats.syncDatasetStats, { accountId });
    const state = await t.query(internal.metaEventStats.getSyncState, { accountId });
    expect(state!.coveredUntilDayKey).toBe(dubaiDayKey(1));
  });

  it("closes a gap left by failed runs instead of leaving a hole in the coverage", async () => {
    const t = convexTest(schema, modules);
    const accountId = await seedAccount(t);
    await seedWhatsappConfig(t, accountId);
    // Ten days of failed nightly runs: coverage stops ten days ago.
    await t.run(async (ctx) => {
      await ctx.db.insert("metaDatasetSyncState", {
        accountId,
        datasetId: "ds1",
        available: true,
        tzName: "Asia/Dubai",
        tzOffsetMinutes: DUBAI_OFFSET_MINUTES,
        lastSyncedAt: Date.now() - 10 * DAY_MS,
        coveredSinceDayKey: dubaiDayKey(40),
        coveredUntilDayKey: dubaiDayKey(10),
      });
    });
    const urls = captureFetch(OK_BODY);
    await t.action(internal.metaEventStats.syncDatasetStats, { accountId });

    // The request reaches back to the last covered day, not merely the
    // three settling days — otherwise days 4..10 would stay unread while
    // the coverage claimed them.
    const daysRequested = (Date.now() - startTimeMs(urls[0])) / DAY_MS;
    expect(daysRequested).toBeGreaterThanOrEqual(10);

    const state = await t.query(internal.metaEventStats.getSyncState, { accountId });
    // Widened, not replaced: the older bound survives.
    expect(state!.coveredSinceDayKey).toBe(dubaiDayKey(40));
    expect(state!.coveredUntilDayKey).toBe(dubaiDayKey(1));
  });

  it("requests whole dataset-local days, never a time-of-day", async () => {
    // Important-3: `since` was `Date.now()` minus N days, i.e. a
    // mid-afternoon instant. If Meta honours a sub-day `start_time`, the
    // run on day X+3 returns a PARTIAL count for day X and
    // `upsertDayCounts` patches it over the complete one an earlier run
    // wrote — last writer wins, and the last writer is always partial.
    const t = convexTest(schema, modules);
    const accountId = await seedAccount(t);
    await seedWhatsappConfig(t, accountId);
    await t.run(async (ctx) => {
      await ctx.db.insert("metaDatasetSyncState", {
        accountId,
        datasetId: "ds1",
        available: true,
        tzName: "Asia/Dubai",
        tzOffsetMinutes: DUBAI_OFFSET_MINUTES,
        lastSyncedAt: Date.now() - DAY_MS,
        coveredSinceDayKey: dubaiDayKey(30),
        coveredUntilDayKey: dubaiDayKey(1),
      });
    });
    const urls = captureFetch(OK_BODY);
    await t.action(internal.metaEventStats.syncDatasetStats, { accountId });
    // Midnight in Asia/Dubai: (ms - tzOffsetMinutes*60_000) lands exactly
    // on a UTC day boundary.
    const startMs = startTimeMs(urls[0]);
    expect((startMs - DUBAI_OFFSET_MINUTES * 60_000) % DAY_MS).toBe(0);
    // Three trailing days back, not one: the routine window is
    // `min(coveredUntilDayKey, today - DEFAULT_TRAILING_DAYS)`, because
    // the settling days are re-read on every run even when they are
    // already claimed as covered.
    expect(startMs).toBe(
      Date.parse(`${dubaiDayKey(3)}T00:00:00Z`) + DUBAI_OFFSET_MINUTES * 60_000,
    );
  });

  it("drops an unreachable older claim rather than spanning a hole", async () => {
    // A gap wider than a single request can close (MAX_SYNC_DAYS). The
    // union of old and new coverage would have a hole in it, and a hole
    // reads as zeros — so the narrower honest range wins.
    const t = convexTest(schema, modules);
    const accountId = await seedAccount(t);
    await seedWhatsappConfig(t, accountId);
    await t.run(async (ctx) => {
      await ctx.db.insert("metaDatasetSyncState", {
        accountId,
        datasetId: "ds1",
        available: true,
        tzName: "Asia/Dubai",
        tzOffsetMinutes: DUBAI_OFFSET_MINUTES,
        lastSyncedAt: Date.now() - 200 * DAY_MS,
        coveredSinceDayKey: dubaiDayKey(260),
        coveredUntilDayKey: dubaiDayKey(200),
      });
    });
    captureFetch(OK_BODY);
    await t.action(internal.metaEventStats.syncDatasetStats, { accountId });
    const state = await t.query(internal.metaEventStats.getSyncState, { accountId });
    // The ancient claim is gone; what remains is only what this run
    // could actually reach.
    expect(state!.coveredSinceDayKey! > dubaiDayKey(200)).toBe(true);
    expect(state!.coveredSinceDayKey! <= dubaiDayKey(89)).toBe(true);
    expect(state!.coveredUntilDayKey).toBe(dubaiDayKey(1));
  });

  it("leaves coverage untouched when a sync fails", async () => {
    // Same rule as `tzOffsetMinutes`: a failure must neither widen the
    // claim (days no read reached) nor clear it (every window degrades
    // on one bad night).
    const t = convexTest(schema, modules);
    const accountId = await seedAccount(t);
    await seedWhatsappConfig(t, accountId);
    captureFetch(OK_BODY);
    await t.action(internal.metaEventStats.syncDatasetStats, { accountId });
    const before = await t.query(internal.metaEventStats.getSyncState, { accountId });

    globalThis.fetch = (async () =>
      new Response("nope", { status: 500 })) as typeof fetch;
    await t.action(internal.metaEventStats.syncDatasetStats, { accountId });
    const after = await t.query(internal.metaEventStats.getSyncState, { accountId });
    expect(after!.available).toBe(false);
    expect(after!.coveredSinceDayKey).toBe(before!.coveredSinceDayKey);
    expect(after!.coveredUntilDayKey).toBe(before!.coveredUntilDayKey);
  });

  it("does not inherit another dataset's coverage after a dataset switch", async () => {
    const t = convexTest(schema, modules);
    const accountId = await seedAccount(t);
    await seedWhatsappConfig(t, accountId);
    await t.run(async (ctx) => {
      await ctx.db.insert("metaDatasetSyncState", {
        accountId,
        datasetId: "OLD-DATASET",
        available: true,
        tzName: "Asia/Dubai",
        tzOffsetMinutes: DUBAI_OFFSET_MINUTES,
        lastSyncedAt: Date.now(),
        coveredSinceDayKey: dubaiDayKey(40),
        coveredUntilDayKey: dubaiDayKey(0),
      });
    });
    captureFetch(OK_BODY);
    // `META_CAPI_DATASET_ID` is "ds1" — a different dataset, whose
    // history we have never read.
    await t.action(internal.metaEventStats.syncDatasetStats, { accountId });
    const state = await t.query(internal.metaEventStats.getSyncState, { accountId });
    expect(state!.datasetId).toBe("ds1");
    // Reached back the full initial window, rather than inheriting the
    // old dataset's `coveredUntilDayKey` and re-reading three days.
    expect(state!.coveredSinceDayKey).not.toBe(dubaiDayKey(40));
    expect(state!.coveredSinceDayKey! <= dubaiDayKey(89)).toBe(true);
  });
});

describe("syncDatasetStats", () => {
  it("records unavailable with a reason when the dataset is unconfigured", async () => {
    delete process.env.META_CAPI_DATASET_ID;
    const t = convexTest(schema, modules);
    const accountId = await seedAccount(t);
    await t.action(internal.metaEventStats.syncDatasetStats, { accountId });
    const state = await t.query(internal.metaEventStats.getSyncState, { accountId });
    expect(state!.available).toBe(false);
    expect(state!.lastError).toMatch(/META_CAPI_DATASET_ID/);
  });

  it("records unavailable when Meta returns an error, and writes NO counts", async () => {
    const t = convexTest(schema, modules);
    const accountId = await seedAccount(t);
    await seedWhatsappConfig(t, accountId);
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: { message: "nope" } }), {
        status: 400,
      })) as typeof fetch;
    await t.action(internal.metaEventStats.syncDatasetStats, { accountId });
    const state = await t.query(internal.metaEventStats.getSyncState, { accountId });
    expect(state!.available).toBe(false);
    expect(state!.lastError).toContain("400");
    const rows = await t.run(async (ctx) =>
      ctx.db.query("metaEventDailyStats").collect(),
    );
    // A failed fetch must never be recorded as "Meta had zero events".
    expect(rows).toHaveLength(0);
  });

  it("records unavailable when the stored access token is not valid ciphertext, and writes NO counts", async () => {
    // `decrypt` THROWS (never returns null/empty) on a corrupted or
    // key-mismatched ciphertext (convex/lib/whatsappEncryption.ts) — this
    // locks in that the throw is caught and routed through the same
    // `fail()` path as every other failure, rather than escaping
    // `syncDatasetStats` uncaught and leaving the sync state stale.
    const t = convexTest(schema, modules);
    const accountId = await seedAccount(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("whatsappConfig", {
        accountId,
        wabaId: "WABA1",
        phoneNumberId: "PN1",
        accessToken: "not-ciphertext",
        status: "connected",
      });
    });
    await t.action(internal.metaEventStats.syncDatasetStats, { accountId });
    const state = await t.query(internal.metaEventStats.getSyncState, { accountId });
    expect(state!.available).toBe(false);
    expect(state!.lastError).toMatch(/decrypt/i);
    const rows = await t.run(async (ctx) =>
      ctx.db.query("metaEventDailyStats").collect(),
    );
    expect(rows).toHaveLength(0);
  });

  // The two unresolvable-offset cases must read differently, because only
  // one of them is something a reader can act on. Both still degrade.
  it("reports an ABSENT timezone as Meta not exposing these counts", async () => {
    const t = convexTest(schema, modules);
    const accountId = await seedAccount(t);
    await seedWhatsappConfig(t, accountId);
    // The real shape observed against dataset 2683479032111674: no
    // timezone_name, no rows. /stats is a web-pixel edge a
    // business-messaging dataset does not populate.
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: [] }), { status: 200 })) as typeof fetch;
    await t.action(internal.metaEventStats.syncDatasetStats, { accountId });
    const state = await t.query(internal.metaEventStats.getSyncState, { accountId });
    expect(state!.available).toBe(false);
    expect(state!.lastError).toMatch(/does not expose per-event counts/i);
    expect(state!.lastError).toMatch(/Events Manager/i);
    // Must NOT blame the timezone: as a standing message that sends a
    // reader hunting for a setting that does not exist anywhere.
    expect(state!.lastError).not.toMatch(/timezone could not be determined/i);
  });

  it("still reports an UNPARSEABLE timezone as a timezone problem", async () => {
    const t = convexTest(schema, modules);
    const accountId = await seedAccount(t);
    await seedWhatsappConfig(t, accountId);
    // Meta named a zone this runtime cannot resolve — genuinely a timezone
    // fault, and actionable, so it keeps the timezone wording.
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ timezone_name: "Not/AZone", data: [] }),
        { status: 200 },
      )) as typeof fetch;
    await t.action(internal.metaEventStats.syncDatasetStats, { accountId });
    const state = await t.query(internal.metaEventStats.getSyncState, { accountId });
    expect(state!.available).toBe(false);
    expect(state!.lastError).toMatch(/timezone could not be determined/i);
    expect(state!.lastError).toContain("Not/AZone");
  });

  it("stores counts and marks available on a good response", async () => {
    const t = convexTest(schema, modules);
    const accountId = await seedAccount(t);
    await seedWhatsappConfig(t, accountId);
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          timezone_name: "Asia/Dubai",
          data: [
            { date: "2026-09-02", event: "QualifiedLead", count: 8 },
            { date: "2026-09-02", event: "LeadSubmitted", count: 40 },
          ],
        }),
        { status: 200 },
      )) as typeof fetch;
    await t.action(internal.metaEventStats.syncDatasetStats, { accountId });
    const state = await t.query(internal.metaEventStats.getSyncState, { accountId });
    expect(state!.available).toBe(true);
    expect(state!.tzOffsetMinutes).toBe(-240);
    expect(state!.lastError).toBeUndefined();
    const rows = await t.run(async (ctx) =>
      ctx.db.query("metaEventDailyStats").collect(),
    );
    expect(rows.find((r) => r.eventName === "QualifiedLead")!.count).toBe(8);
  });

  // --- shape mismatch vs. a genuinely empty dataset ---------------------
  //
  // The endpoint's response shape is a HYPOTHESIS (see the action's own
  // header). The most likely way it turns out wrong is a parseable body
  // with different field names or a different date encoding — and the
  // pre-fix code answered that by skipping every row and writing
  // `available: true` with no counts, i.e. stating "Meta received
  // nothing" with full confidence. These two tests pin the distinction
  // the whole feature rests on: cannot-read is not the same claim as
  // has-none.

  it("fails on a non-empty response whose every row is rejected, and writes NO counts", async () => {
    const t = convexTest(schema, modules);
    const accountId = await seedAccount(t);
    await seedWhatsappConfig(t, accountId);
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          timezone_name: "Asia/Dubai",
          // Right names, wrong date encoding — the rows would be stored
          // under keys `datasetDayKeys` can never generate, so every
          // `recorded` would come back 0 forever.
          data: [
            { date: "2026-09-02T00:00:00+0400", event: "QualifiedLead", count: 8 },
            { date: "2026-09-01T00:00:00+0400", event: "LeadSubmitted", count: 40 },
          ],
        }),
        { status: 200 },
      )) as typeof fetch;
    await t.action(internal.metaEventStats.syncDatasetStats, { accountId });
    const state = await t.query(internal.metaEventStats.getSyncState, { accountId });
    expect(state!.available).toBe(false);
    // The reason has to carry a sample: the repo owner cannot fix a shape
    // mismatch they cannot see.
    expect(state!.lastError).toMatch(/shape/i);
    expect(state!.lastError).toContain("2026-09-02T00:00:00+0400");
    const rows = await t.run(async (ctx) =>
      ctx.db.query("metaEventDailyStats").collect(),
    );
    expect(rows).toHaveLength(0);
    // Coverage must not advance on a failure either — a claimed range
    // with no rows behind it is the false zero by another route.
    expect(state!.coveredUntilDayKey).toBeUndefined();
  });

  it("fails on a non-empty response under entirely different field names", async () => {
    const t = convexTest(schema, modules);
    const accountId = await seedAccount(t);
    await seedWhatsappConfig(t, accountId);
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          timezone_name: "Asia/Dubai",
          data: [{ day: "2026-09-02", event_name: "QualifiedLead", value: 8 }],
        }),
        { status: 200 },
      )) as typeof fetch;
    await t.action(internal.metaEventStats.syncDatasetStats, { accountId });
    const state = await t.query(internal.metaEventStats.getSyncState, { accountId });
    expect(state!.available).toBe(false);
    expect(state!.lastError).toMatch(/shape/i);
  });

  it("treats a genuinely EMPTY data: [] as available with no counts", async () => {
    // The other half of the same distinction, and the reason the fail
    // above is conditioned on a NON-EMPTY `data`. Meta legitimately
    // holding no events in the window is a successful read.
    const t = convexTest(schema, modules);
    const accountId = await seedAccount(t);
    await seedWhatsappConfig(t, accountId);
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ timezone_name: "Asia/Dubai", data: [] }),
        { status: 200 },
      )) as typeof fetch;
    await t.action(internal.metaEventStats.syncDatasetStats, { accountId });
    const state = await t.query(internal.metaEventStats.getSyncState, { accountId });
    expect(state!.available).toBe(true);
    expect(state!.lastError).toBeUndefined();
    const rows = await t.run(async (ctx) =>
      ctx.db.query("metaEventDailyStats").collect(),
    );
    expect(rows).toHaveLength(0);
  });

  it("stores the well-formed rows and ignores a single malformed one alongside them", async () => {
    // A partially bad response is NOT a shape mismatch: the parser
    // understood the response, so what it did parse is real.
    const t = convexTest(schema, modules);
    const accountId = await seedAccount(t);
    await seedWhatsappConfig(t, accountId);
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          timezone_name: "Asia/Dubai",
          data: [
            { date: "2026-09-02", event: "QualifiedLead", count: 8 },
            { date: "not-a-date", event: "QualifiedLead", count: 3 },
          ],
        }),
        { status: 200 },
      )) as typeof fetch;
    await t.action(internal.metaEventStats.syncDatasetStats, { accountId });
    const state = await t.query(internal.metaEventStats.getSyncState, { accountId });
    expect(state!.available).toBe(true);
    const rows = await t.run(async (ctx) =>
      ctx.db.query("metaEventDailyStats").collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].dayKey).toBe("2026-09-02");
  });

  it("is idempotent — a second sync of the same day does not double", async () => {
    const t = convexTest(schema, modules);
    const accountId = await seedAccount(t);
    await seedWhatsappConfig(t, accountId);
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          timezone_name: "Asia/Dubai",
          data: [{ date: "2026-09-02", event: "QualifiedLead", count: 8 }],
        }),
        { status: 200 },
      )) as typeof fetch;
    await t.action(internal.metaEventStats.syncDatasetStats, { accountId });
    await t.action(internal.metaEventStats.syncDatasetStats, { accountId });
    const rows = await t.run(async (ctx) =>
      ctx.db.query("metaEventDailyStats").collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].count).toBe(8);
  });
});

describe("redactTokens", () => {
  it("strips the token from a URL string", () => {
    expect(redactTokens("https://graph.facebook.com/x?a=1&access_token=SECRET")).toBe(
      "https://graph.facebook.com/x?a=1&access_token=REDACTED",
    );
  });

  it("strips a token nested inside paging.next — the case that leaked", () => {
    // Meta returns `paging.next` as a complete follow-up URL carrying a
    // live token. Redacting only our own request URL left this one intact.
    const body = {
      data: [{ aggregation: "event_total_counts" }],
      paging: {
        cursors: { after: "MTc4NzgyMDE1MgZDZD" },
        next: "https://graph.facebook.com/v25.0/123/stats?aggregation=x&access_token=EAAlivetoken123&limit=25",
      },
    };
    const out = redactTokens(body);
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain("EAAlivetoken123");
    expect(out.paging.next).toContain("access_token=REDACTED");
    // Everything that is not a credential survives untouched.
    expect(out.paging.cursors.after).toBe("MTc4NzgyMDE1MgZDZD");
    expect(out.data[0].aggregation).toBe("event_total_counts");
  });

  it("strips every occurrence, not just the first", () => {
    const out = redactTokens({
      a: "x?access_token=ONE",
      b: "y?access_token=TWO",
    });
    expect(JSON.stringify(out)).not.toContain("ONE");
    expect(JSON.stringify(out)).not.toContain("TWO");
  });

  it("returns a value it cannot serialize unchanged rather than throwing", () => {
    // A diagnostic must not fail on the shape of what it is diagnosing.
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => redactTokens(circular)).not.toThrow();
  });
});

describe("capiStatsProbe redaction", () => {
  it("redacts a token Meta returns inside the response body", async () => {
    const t = convexTest(schema, modules);
    const accountId = await seedAccount(t);
    await seedWhatsappConfig(t, accountId);
    // Meta hands `paging.next` back as a complete follow-up URL with a
    // live token in it. This is the real shape observed against dataset
    // 2683479032111674 — the probe echoed it verbatim and published the
    // credential.
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          data: [{ aggregation: "event_total_counts" }],
          paging: {
            cursors: { after: "MTc4NzgyMDE1MgZDZD" },
            next: "https://graph.facebook.com/v25.0/123/stats?aggregation=event_total_counts&access_token=EAAlivetoken123&limit=25",
          },
        }),
        { status: 200 },
      )) as typeof fetch;

    const out = await t.action(internal.metaEventStats.capiStatsProbe, {
      accountId,
      aggregation: "event_total_counts",
    });

    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain("EAAlivetoken123");
    expect(serialized).toContain("access_token=REDACTED");
    // Non-credential content still comes back intact, or the probe is
    // useless for the diagnosis it exists to support.
    expect(serialized).toContain("MTc4NzgyMDE1MgZDZD");
    expect(serialized).toContain("event_total_counts");
  });
});
