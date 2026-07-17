import { convexTest } from "convex-test";
import { expect, test, afterEach } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";

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

async function seedAd(
  t: ReturnType<typeof convexTest>,
  accountId: Id<"accounts">,
  attempts = 0,
  resolveStatus: "pending" | "error" = "pending",
) {
  return await t.run((ctx) =>
    ctx.db.insert("campaignAds", {
      accountId,
      adId: "AD1",
      resolveStatus,
      attempts,
    }),
  );
}

const origToken = process.env.META_ADS_ACCESS_TOKEN;
const origFetch = globalThis.fetch;
afterEach(() => {
  if (origToken === undefined) delete process.env.META_ADS_ACCESS_TOKEN;
  else process.env.META_ADS_ACCESS_TOKEN = origToken;
  globalThis.fetch = origFetch;
});

test("resolveAd is dormant without META_ADS_ACCESS_TOKEN (leaves pending, no attempt bump)", async () => {
  delete process.env.META_ADS_ACCESS_TOKEN;
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t);
  const adId = await seedAd(t, accountId);

  await t.action(internal.campaignAds.resolveAd, { campaignAdId: adId });

  const row = await t.run((ctx) => ctx.db.get(adId));
  expect(row?.resolveStatus).toBe("pending");
  expect(row?.attempts).toBe(0);
});

test("resolveAd resolves ad/adset/campaign names on a 200", async () => {
  process.env.META_ADS_ACCESS_TOKEN = "tok";
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        name: "Maldives Ad",
        adset: { id: "AS1", name: "Maldives AdSet" },
        campaign: { id: "C1", name: "Summer" },
      }),
      { status: 200 },
    )) as typeof fetch;
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t);
  const adId = await seedAd(t, accountId);

  await t.action(internal.campaignAds.resolveAd, { campaignAdId: adId });

  const row = await t.run((ctx) => ctx.db.get(adId));
  expect(row?.resolveStatus).toBe("resolved");
  expect(row?.adName).toBe("Maldives Ad");
  expect(row?.campaignName).toBe("Summer");
  expect(row?.resolvedAt).toBeGreaterThan(0);
});

test("resolveAd records error + bumps attempts on a non-200", async () => {
  process.env.META_ADS_ACCESS_TOKEN = "tok";
  // 400, not 429/5xx: a genuinely bad request is the row's own fault and
  // should still be able to spend the budget and give up.
  globalThis.fetch = (async () =>
    new Response("nope", { status: 400 })) as typeof fetch;
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t);
  const adId = await seedAd(t, accountId);

  await t.action(internal.campaignAds.resolveAd, { campaignAdId: adId });

  const row = await t.run((ctx) => ctx.db.get(adId));
  expect(row?.resolveStatus).toBe("error");
  expect(row?.attempts).toBe(1);
});

// ------------------------------------------------------------
// Transient (429/5xx) vs permanent errors — the resolve budget must only
// ever be spent on errors that are actually the row's fault.
// ------------------------------------------------------------

test("resolveAd: a 429 re-queues as error WITHOUT bumping attempts — throttling can never exhaust the resolve budget", async () => {
  process.env.META_ADS_ACCESS_TOKEN = "tok";
  globalThis.fetch = (async () =>
    new Response("rate limited", { status: 429 })) as typeof fetch;
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t);
  // One bump away from the give-up cap: a 429 here used to retire the row and
  // leave the ad/adset/campaign names unresolved for good.
  const adId = await seedAd(t, accountId, 4);

  await t.action(internal.campaignAds.resolveAd, { campaignAdId: adId });

  const row = await t.run((ctx) => ctx.db.get(adId));
  expect(row?.resolveStatus).toBe("error");
  expect(row?.attempts).toBe(4);
  // Still selectable by the cron — the whole point.
  const batch = await t.query(internal.campaignAds.getResolvable, {});
  expect(batch.map((r) => r._id)).toContain(adId);
});

test("resolveAd: a 5xx re-queues as error WITHOUT bumping attempts", async () => {
  process.env.META_ADS_ACCESS_TOKEN = "tok";
  globalThis.fetch = (async () =>
    new Response("upstream down", { status: 503 })) as typeof fetch;
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t);
  const adId = await seedAd(t, accountId, 4);

  await t.action(internal.campaignAds.resolveAd, { campaignAdId: adId });

  const row = await t.run((ctx) => ctx.db.get(adId));
  expect(row?.resolveStatus).toBe("error");
  expect(row?.attempts).toBe(4);
});

test("getResolvable returns pending + error rows under MAX_RESOLVE_ATTEMPTS", async () => {
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t);
  await seedAd(t, accountId, 0, "pending");
  await seedAd(t, accountId, 5, "error"); // at cap — excluded

  const rows = await t.run(() =>
    t.query(internal.campaignAds.getResolvable, {}),
  );
  expect(rows).toHaveLength(1);
  expect(rows[0].resolveStatus).toBe("pending");
});

test("retryResolutions staggers its fan-out instead of firing the whole batch at once", async () => {
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t);
  for (let i = 0; i < 5; i++) await seedAd(t, accountId);

  await t.action(internal.campaignAds.retryResolutions, {});

  const scheduled = await t.run((ctx) =>
    ctx.db.system.query("_scheduled_functions").collect(),
  );
  expect(scheduled).toHaveLength(5);
  const times = scheduled.map((s) => s.scheduledTime).sort((a, b) => a - b);
  // Each successive resolve is at least one stagger step behind the last;
  // `runAfter(0)` for all of them would leave these within a millisecond.
  for (let i = 1; i < times.length; i++) {
    expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(100);
  }
});
