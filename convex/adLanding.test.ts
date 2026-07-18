/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, expect, test } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import type { Doc, Id } from "./_generated/dataModel";

// Convex function modules for convex-test to resolve `internal.*`
// references against — same absolute-glob pattern as every other suite
// (see `convex/lib/auth.test.ts`'s comment on why absolute).
const modules = import.meta.glob("/convex/**/*.ts");

// `CONVEX_AI_DRY_RUN` makes `adLanding.ensureFresh` store a synthetic
// extraction instead of touching the network (same offline convention as
// `aiReply.ts`'s `syntheticGeneration`) — these tests exercise the
// claim/store lifecycle, not real HTTP.
beforeEach(() => {
  process.env.CONVEX_AI_DRY_RUN = "1";
});
afterEach(() => {
  delete process.env.CONVEX_AI_DRY_RUN;
});

/** Minimal tenant for internal-function tests — no auth needed. */
async function seedAccount(t: TestConvex<typeof schema>): Promise<Id<"accounts">> {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {
      name: "Owner",
      email: "owner@example.com",
    });
    return await ctx.db.insert("accounts", {
      name: "Test account",
      defaultCurrency: "USD",
      ownerUserId: userId,
    });
  });
}

async function allRows(t: TestConvex<typeof schema>): Promise<Doc<"adLandingPages">[]> {
  return await t.run((ctx) => ctx.db.query("adLandingPages").collect());
}

const AD_URL = "https://holidayys.co/packages/georgia-summer?fbclid=AbC123#gallery";
const AD_URL_KEY = "https://holidayys.co/packages/georgia-summer";

test("ensureFresh (dry-run) stores one ok row under the normalized key", async () => {
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t);

  await t.action(internal.adLanding.ensureFresh, { accountId, url: AD_URL });

  const rows = await allRows(t);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.urlKey).toBe(AD_URL_KEY);
  expect(rows[0]!.status).toBe("ok");
  expect(rows[0]!.title).toBe("[dry-run] landing page");
  expect(rows[0]!.content).toContain(AD_URL);
  expect(rows[0]!.fetchedAt).toBeTypeOf("number");
});

test("a fresh row makes ensureFresh a no-op — one row per ad, however many clicks", async () => {
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t);

  await t.action(internal.adLanding.ensureFresh, { accountId, url: AD_URL });
  const [first] = await allRows(t);

  // Same ad, different click id — same normalized key, still fresh.
  await t.action(internal.adLanding.ensureFresh, {
    accountId,
    url: "https://holidayys.co/packages/georgia-summer?fbclid=another-click",
  });

  const rows = await allRows(t);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.fetchedAt).toBe(first!.fetchedAt); // untouched — no refetch
});

test("a stale ok row is re-claimed and refreshed; a young pending row is not stolen", async () => {
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t);

  await t.action(internal.adLanding.ensureFresh, { accountId, url: AD_URL });
  const [row] = await allRows(t);

  // Back-date the completed fetch beyond the 24h ok-TTL → re-claimable.
  await t.run((ctx) =>
    ctx.db.patch(row!._id, { fetchedAt: Date.now() - 25 * 3_600_000 }),
  );
  const stale = await t.mutation(internal.adLanding.claimFetch, {
    accountId,
    urlKey: AD_URL_KEY,
    url: AD_URL,
  });
  expect(stale.claimed).toBe(true);

  // The row is now freshly `pending` (claimed just above) — a second
  // concurrent claimant must lose.
  const concurrent = await t.mutation(internal.adLanding.claimFetch, {
    accountId,
    urlKey: AD_URL_KEY,
    url: AD_URL,
  });
  expect(concurrent.claimed).toBe(false);

  // …until the pending claim looks dead (older than the takeover gate).
  await t.run((ctx) =>
    ctx.db.patch(row!._id, { fetchStartedAt: Date.now() - 10 * 60_000 }),
  );
  const takeover = await t.mutation(internal.adLanding.claimFetch, {
    accountId,
    urlKey: AD_URL_KEY,
    url: AD_URL,
  });
  expect(takeover.claimed).toBe(true);
});

test("a failed refresh keeps the last good extraction (status flips, content stays)", async () => {
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t);

  await t.action(internal.adLanding.ensureFresh, { accountId, url: AD_URL });
  await t.mutation(internal.adLanding.storeResult, {
    accountId,
    urlKey: AD_URL_KEY,
    ok: false,
    error: "HTTP 503",
  });

  const rows = await allRows(t);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.status).toBe("error");
  expect(rows[0]!.error).toBe("HTTP 503");
  // Last good extraction survives the failure — the assistant keeps its
  // context while the retry TTL runs down.
  expect(rows[0]!.title).toBe("[dry-run] landing page");
  expect(rows[0]!.content).toContain(AD_URL);
});

test("unfetchable urls are refused outright — no row, no fetch", async () => {
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t);

  await t.action(internal.adLanding.ensureFresh, { accountId, url: "http://localhost/admin" });
  await t.action(internal.adLanding.ensureFresh, { accountId, url: "not a url" });

  expect(await allRows(t)).toHaveLength(0);
});
