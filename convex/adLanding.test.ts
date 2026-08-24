/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
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
  vi.unstubAllGlobals();
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

const AD_URL = "https://amaniworld.com/packages/georgia-summer?fbclid=AbC123#gallery";
const AD_URL_KEY = "https://amaniworld.com/packages/georgia-summer";

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
    url: "https://amaniworld.com/packages/georgia-summer?fbclid=another-click",
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

// ============================================================
// Login walls — the network path, with `CONVEX_AI_DRY_RUN` off so
// `fetchAndExtract` actually runs against a stubbed `fetch`.
// ============================================================

/** A `fetch` result shaped like the fields `fetchAndExtract` reads. Built
 *  by hand rather than with `new Response(...)` because `Response.url` —
 *  the post-redirect URL this whole guard turns on — is read-only and
 *  always "" on a constructed one. */
function htmlResponse(html: string, finalUrl: string): Response {
  return {
    ok: true,
    status: 200,
    url: finalUrl,
    headers: new Headers({ "content-type": "text/html; charset=utf-8" }),
    text: async () => html,
  } as unknown as Response;
}

/** What Meta served for 230 of production's 434 successful fetches. */
const FB_WALL_HTML =
  "<html><head><title>Facebook</title>" +
  '<meta property="og:title" content="Facebook">' +
  '<meta property="og:description" content="Log into Facebook to start sharing and connecting with your friends, family and people you know.">' +
  "</head><body><form>" +
  "<div>Explore the things you love.</div><div>Log into Facebook</div>" +
  "<div>Email or mobile number</div><div>Password</div><div>Forgot password?</div>" +
  "<div>Create new account</div>" +
  '<input type="text" name="email"><input type="password" name="pass">' +
  "</form></body></html>";

const IG_POST_HTML =
  "<html><head>" +
  '<meta property="og:title" content="Amani Travel &amp; Tourism on Instagram">' +
  '<meta property="og:description" content="Visa Change by Bus for Indians for AED 799 — transportation, accommodation and border fees included.">' +
  "</head><body><article><p>Visa Change by Bus for Indians for AED 799, including " +
  "transportation, accommodation, border fees and immediate return arrangements.</p>" +
  "</article></body></html>";

/** Back-date the row past `FRESH_OK_MS` so the next `ensureFresh` claims
 *  it instead of trusting the cache. */
async function makeStale(t: TestConvex<typeof schema>, id: Id<"adLandingPages">) {
  await t.run((ctx) => ctx.db.patch(id, { fetchedAt: Date.now() - 25 * 3_600_000 }));
}

test("a fetch that lands on a login wall is a failure — the last good extraction survives", async () => {
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t);

  // A good extraction is already cached (dry-run stands in for the fetch
  // that produced it) …
  await t.action(internal.adLanding.ensureFresh, { accountId, url: AD_URL });
  const [good] = await allRows(t);
  await makeStale(t, good!._id);

  // … and the refresh gets Meta's login page instead of the ad's post.
  delete process.env.CONVEX_AI_DRY_RUN;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      htmlResponse(FB_WALL_HTML, "https://www.facebook.com/login/?next=%2Fstory.php"),
    ),
  );
  await t.action(internal.adLanding.ensureFresh, { accountId, url: AD_URL });

  const rows = await allRows(t);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.status).toBe("error");
  expect(rows[0]!.error).toBe("login wall");
  // The wall never reaches the row: the previous good extraction is
  // still what `loadAdContext` would read.
  expect(rows[0]!.title).toBe("[dry-run] landing page");
  expect(rows[0]!.content).toContain(AD_URL);
  expect(rows[0]!.content).not.toContain("Log into Facebook");
});

test("a wall served at the ad's own URL (no redirect to give it away) is caught on the page text", async () => {
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t);

  delete process.env.CONVEX_AI_DRY_RUN;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => htmlResponse(FB_WALL_HTML, "https://www.instagram.com/p/DbEKZNHsJne/")),
  );
  await t.action(internal.adLanding.ensureFresh, {
    accountId,
    url: "https://www.instagram.com/p/DbEKZNHsJne/",
  });

  const rows = await allRows(t);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.status).toBe("error");
  expect(rows[0]!.error).toBe("login wall");
  expect(rows[0]!.content).toBeUndefined(); // nothing good to keep, and nothing bad stored
});

test("the real post behind the same link still stores — the wall guard is not a blanket refusal", async () => {
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t);

  delete process.env.CONVEX_AI_DRY_RUN;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => htmlResponse(IG_POST_HTML, "https://www.instagram.com/p/DbEKZNHsJne/")),
  );
  await t.action(internal.adLanding.ensureFresh, { accountId, url: "https://fb.me/27uVR4iqUN" });

  const rows = await allRows(t);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.status).toBe("ok");
  expect(rows[0]!.description).toContain("AED 799");
  expect(rows[0]!.content).toContain("AED 799");
  // `fb.me` stays fetchable on purpose: the wall is transient, and the
  // same short link serves the real post on a later attempt.
  expect(rows[0]!.finalUrl).toBe("https://www.instagram.com/p/DbEKZNHsJne/");
});

// ============================================================
// clearJunkLandingContent — the one-shot cleanup for the two kinds of
// junk written before this module learned to reject them.
// ============================================================

/** The verbatim shape of a production wall row. */
async function seedWallRow(
  t: TestConvex<typeof schema>,
  accountId: Id<"accounts">,
  urlKey: string,
): Promise<Id<"adLandingPages">> {
  return await t.run((ctx) =>
    ctx.db.insert("adLandingPages", {
      accountId,
      urlKey,
      url: urlKey,
      status: "ok" as const,
      title: "Facebook",
      content:
        "Explore the things you love.\n\nLog into Facebook\n\nEmail or mobile number\n\n" +
        "Password\n\nForgot password?\n\nCreate new account",
      finalUrl: "https://www.facebook.com/login/?next=%2Fstory.php",
      fetchStartedAt: Date.now() - 30 * 3_600_000,
      fetchedAt: Date.now() - 30 * 3_600_000,
    }),
  );
}

test("clearLoginWallRows empties the wall rows, spares the good ones, and is idempotent", async () => {
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t);

  const wallId = await seedWallRow(t, accountId, "https://fb.me/27uVR4iqUN");
  const goodId = await t.run((ctx) =>
    ctx.db.insert("adLandingPages", {
      accountId,
      urlKey: "https://www.instagram.com/p/DbEKZNHsJne/",
      url: "https://www.instagram.com/p/DbEKZNHsJne/",
      status: "ok" as const,
      title: "Amani Travel & Tourism on Instagram",
      description: "Visa Change by Bus for Indians for AED 799.",
      content: "Transportation, accommodation and border fees included.",
      finalUrl: "https://www.instagram.com/p/DbEKZNHsJne/",
      fetchStartedAt: Date.now(),
      fetchedAt: Date.now(),
    }),
  );

  // A dry run reports the same count without touching anything.
  const dry = await t.mutation(internal.adLanding.clearJunkLandingContent, { dryRun: true });
  expect(dry).toMatchObject({ isDone: true, scanned: 2, walls: 1, junkContent: 0 });
  expect((await t.run((ctx) => ctx.db.get(wallId)))!.content).toContain("Log into Facebook");

  const first = await t.mutation(internal.adLanding.clearJunkLandingContent, {});
  expect(first).toMatchObject({ isDone: true, walls: 1, junkContent: 0 });

  const wall = (await t.run((ctx) => ctx.db.get(wallId)))!;
  expect(wall.title).toBeUndefined();
  expect(wall.description).toBeUndefined();
  expect(wall.content).toBeUndefined();
  expect(wall.status).toBe("error");
  expect(wall.error).toBe("login wall");
  // Kept: the breadcrumb for why this row was cleared.
  expect(wall.finalUrl).toBe("https://www.facebook.com/login/?next=%2Fstory.php");

  // The real landing page is untouched.
  const good = (await t.run((ctx) => ctx.db.get(goodId)))!;
  expect(good.status).toBe("ok");
  expect(good.description).toContain("AED 799");

  // Second pass is a no-op — nothing left to clear is the "complete" signal.
  const second = await t.mutation(internal.adLanding.clearJunkLandingContent, {});
  expect(second).toMatchObject({ walls: 0, junkContent: 0 });
});

test("a cleared row refills itself on the next click rather than staying blank", async () => {
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t);
  const url = "https://fb.me/27uVR4iqUN";
  await seedWallRow(t, accountId, url);

  await t.mutation(internal.adLanding.clearJunkLandingContent, {});

  // `fetchedAt` is deliberately left alone, so the (now `error`) row is
  // already past the 1h retry TTL and the next ad click re-fetches it.
  delete process.env.CONVEX_AI_DRY_RUN;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => htmlResponse(IG_POST_HTML, "https://www.instagram.com/p/DbEKZNHsJne/")),
  );
  await t.action(internal.adLanding.ensureFresh, { accountId, url });

  const rows = await allRows(t);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.status).toBe("ok");
  expect(rows[0]!.description).toContain("AED 799");
});

test("the cursor traverses every page, leaving no wall row behind", async () => {
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t);
  for (const slug of ["a", "b", "c", "d", "e"]) {
    await seedWallRow(t, accountId, `https://fb.me/${slug}`);
  }

  let cursor: string | null = null;
  let isDone = false;
  let cleared = 0;
  let pages = 0;
  while (!isDone) {
    const page: { cursor: string; isDone: boolean; walls: number } = await t.mutation(
      internal.adLanding.clearJunkLandingContent,
      { cursor, batchSize: 2 },
    );
    cursor = page.cursor;
    isDone = page.isDone;
    cleared += page.walls;
    pages++;
    expect(pages).toBeLessThan(10); // a stalled cursor must fail, not spin
  }

  expect(pages).toBeGreaterThan(1); // genuinely paginated
  expect(cleared).toBe(5);
  expect((await allRows(t)).every((r) => r.content === undefined)).toBe(true);
});

/** The 4000-char residue of a truncated inline `<script>` — what 179
 *  production rows held under "Linked page content (extracted)". */
const META_JSON_JUNK =
  '{"require":[["ScheduledServerJS","handle",null,[{"__bbox":{"define":' +
  '[["cr:4474",["PolarisSearchBoxContainer.react"],{"__rc":["PolarisSearchBoxContainer.react",null]},-1]'.repeat(
    20,
  );

test("a junk-content row loses only its content — the ad copy in its metadata survives", async () => {
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t);
  const junkId = await t.run((ctx) =>
    ctx.db.insert("adLandingPages", {
      accountId,
      urlKey: "https://www.instagram.com/p/DbEKZNHsJne/",
      url: "https://www.instagram.com/p/DbEKZNHsJne/",
      status: "ok" as const,
      title: "Amani Travel & Tourism on Instagram",
      description: "Visa Change by Bus for Indians for AED 799.",
      content: META_JSON_JUNK,
      finalUrl: "https://www.instagram.com/p/DbEKZNHsJne/",
      fetchStartedAt: Date.now(),
      fetchedAt: Date.now(),
    }),
  );
  // A row with real prose in the same batch, to prove the detector is not
  // just clearing every `content` it meets.
  const proseId = await t.run((ctx) =>
    ctx.db.insert("adLandingPages", {
      accountId,
      urlKey: "https://amaniworld.com/packages/georgia",
      url: "https://amaniworld.com/packages/georgia",
      status: "ok" as const,
      title: "Georgia Summer Package | Amani",
      content: "5 nights across Tbilisi, Gudauri and Batumi, visa assistance included.",
      fetchStartedAt: Date.now(),
      fetchedAt: Date.now(),
    }),
  );

  const result = await t.mutation(internal.adLanding.clearJunkLandingContent, {});
  expect(result).toMatchObject({ walls: 0, junkContent: 1 });

  const junk = (await t.run((ctx) => ctx.db.get(junkId)))!;
  expect(junk.content).toBeUndefined();
  // Everything else is untouched: the row IS good, the fetch DID reach the
  // page, and this metadata is the real ad grounding.
  expect(junk.status).toBe("ok");
  expect(junk.title).toBe("Amani Travel & Tourism on Instagram");
  expect(junk.description).toContain("AED 799");

  const prose = (await t.run((ctx) => ctx.db.get(proseId)))!;
  expect(prose.content).toContain("Tbilisi");

  const second = await t.mutation(internal.adLanding.clearJunkLandingContent, {});
  expect(second).toMatchObject({ walls: 0, junkContent: 0 });
});
