import { convexTest } from "convex-test";
import { expect, test, afterEach } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import { MAX_RESOLVE_ATTEMPTS } from "./campaignAds";

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

test("the error bump that reaches MAX_RESOLVE_ATTEMPTS retires the row to abandoned", async () => {
  process.env.META_ADS_ACCESS_TOKEN = "tok";
  globalThis.fetch = (async () =>
    new Response("nope", { status: 400 })) as typeof fetch;
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t);
  const adId = await seedAd(t, accountId, MAX_RESOLVE_ATTEMPTS - 1, "error");

  await t.action(internal.campaignAds.resolveAd, { campaignAdId: adId });

  const row = await t.run((ctx) => ctx.db.get(adId));
  expect(row?.resolveStatus).toBe("abandoned");
  expect(row?.attempts).toBe(MAX_RESOLVE_ATTEMPTS);
});

// The point of the terminal state is the *scan*, not the label: `getResolvable`
// reads the `by_status` "error" partition and `.filter()`s on `attempts`, which
// does not narrow what Convex reads. A row that gives up while still tagged
// "error" therefore stays in that partition forever, matching nothing — so the
// cron re-scans a monotonically growing set of dead rows on every run. Retiring
// to "abandoned" is what actually drains it.
test("an abandoned row leaves the error partition getResolvable scans", async () => {
  process.env.META_ADS_ACCESS_TOKEN = "tok";
  globalThis.fetch = (async () =>
    new Response("nope", { status: 400 })) as typeof fetch;
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t);
  const adId = await seedAd(t, accountId, MAX_RESOLVE_ATTEMPTS - 1, "error");

  await t.action(internal.campaignAds.resolveAd, { campaignAdId: adId });

  const stillErrored = await t.run((ctx) =>
    ctx.db
      .query("campaignAds")
      .withIndex("by_status", (q) => q.eq("resolveStatus", "error"))
      .collect(),
  );
  expect(stillErrored).toHaveLength(0);
});
