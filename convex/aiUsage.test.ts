/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import type { AccountRole } from "./lib/roles";

// Convex function modules for convex-test to resolve `api.*`/`internal.*`
// references against. Absolute, from-project-root pattern (matches every
// other `convex/*.test.ts` suite — see `convex/lib/auth.test.ts`'s
// comment for why this must be absolute rather than a relative "./**").
const modules = import.meta.glob("/convex/**/*.ts");

// ============================================================
// `summary`'s range filter is keyed on `_creationTime`, which
// `convex-test` derives from `Date.now()` at insert time (clamped
// forward, never backward, relative to the last-inserted row) — same
// footgun `dashboard.test.ts`'s own `makeClock` comment describes.
// Duplicated here rather than imported, matching this suite's own
// "duplicate small test helpers per file" convention.
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

const T0 = Date.parse("2026-06-20T00:00:00.000Z");
const BEFORE_CUTOFF = Date.parse("2026-07-01T00:00:00.000Z");
const CUTOFF = Date.parse("2026-07-05T00:00:00.000Z");
const AFTER_CUTOFF = Date.parse("2026-07-08T00:00:00.000Z");

/**
 * Seeds a `users` row + an `accounts`/`memberships` row for a fresh
 * account, and returns a convex-test client already authenticated as
 * that user. Duplicated per-suite rather than imported — see
 * `convex/contacts.test.ts`'s own comment on this pattern.
 */
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

// ============================================================
// log — best-effort append, skips all-zero usage
// ============================================================

test("log skips insertion when all token counts are zero", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });

  await t.mutation(internal.aiUsage.log, {
    accountId,
    mode: "draft",
    provider: "openai",
    model: "gpt-4o-mini",
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
  });

  const rows = await t.run((ctx) =>
    ctx.db
      .query("aiUsageLog")
      .withIndex("by_account", (q) => q.eq("accountId", accountId))
      .collect(),
  );
  expect(rows).toHaveLength(0);
});

test("log appends a row when usage is non-zero, conversationId optional", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });

  await t.mutation(internal.aiUsage.log, {
    accountId,
    mode: "auto_reply",
    provider: "anthropic",
    model: "claude-3-5-sonnet",
    promptTokens: 100,
    completionTokens: 50,
    totalTokens: 150,
  });

  const rows = await t.run((ctx) =>
    ctx.db
      .query("aiUsageLog")
      .withIndex("by_account", (q) => q.eq("accountId", accountId))
      .collect(),
  );
  expect(rows).toHaveLength(1);
  expect(rows[0]!.conversationId).toBeUndefined();
  expect(rows[0]!.mode).toBe("auto_reply");
  expect(rows[0]!.provider).toBe("anthropic");
  expect(rows[0]!.model).toBe("claude-3-5-sonnet");
  expect(rows[0]!.promptTokens).toBe(100);
  expect(rows[0]!.completionTokens).toBe(50);
  expect(rows[0]!.totalTokens).toBe(150);
});

test("log records a supplied conversationId", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });
  const contactId = await t.run((ctx) =>
    ctx.db.insert("contacts", {
      accountId,
      phone: "+15550001111",
      phoneNormalized: "15550001111",
    }),
  );
  const conversationId = await t.run((ctx) =>
    ctx.db.insert("conversations", {
      accountId,
      contactId,
      status: "open",
      unreadCount: 0,
    }),
  );

  await t.mutation(internal.aiUsage.log, {
    accountId,
    conversationId,
    mode: "draft",
    provider: "openai",
    model: "gpt-4o-mini",
    promptTokens: 10,
    completionTokens: 5,
    totalTokens: 15,
  });

  const rows = await t.run((ctx) =>
    ctx.db
      .query("aiUsageLog")
      .withIndex("by_account", (q) => q.eq("accountId", accountId))
      .collect(),
  );
  expect(rows).toHaveLength(1);
  expect(rows[0]!.conversationId).toBe(conversationId);
});

// ============================================================
// summary — account-scoped + range-filtered
// ============================================================

test("summary returns only the caller's own account's rows created at/after sinceMs", async () => {
  const t = convexTest(schema, modules);

  const clock = makeClock(T0);
  clock(T0);
  const { asUser: asAlice, accountId: aliceId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });
  const { accountId: bobId } = await seedAccountMember(t, {
    name: "Bob",
    email: "bob@example.com",
    role: "admin",
  });

  // Alice: one row strictly BEFORE the cutoff (must be excluded).
  clock(BEFORE_CUTOFF);
  await t.mutation(internal.aiUsage.log, {
    accountId: aliceId,
    mode: "draft",
    provider: "openai",
    model: "gpt-4o-mini",
    promptTokens: 1,
    completionTokens: 1,
    totalTokens: 2,
  });

  // Alice: one row exactly AT the cutoff (inclusive — must be included).
  clock(CUTOFF);
  await t.mutation(internal.aiUsage.log, {
    accountId: aliceId,
    mode: "draft",
    provider: "openai",
    model: "gpt-4o-mini",
    promptTokens: 10,
    completionTokens: 10,
    totalTokens: 20,
  });

  // Alice: one row AFTER the cutoff (must be included). Bob: one row at
  // the same instant, on HIS OWN account (must never appear for Alice).
  clock(AFTER_CUTOFF);
  await t.mutation(internal.aiUsage.log, {
    accountId: aliceId,
    mode: "auto_reply",
    provider: "anthropic",
    model: "claude-3-5-sonnet",
    promptTokens: 100,
    completionTokens: 100,
    totalTokens: 200,
  });
  await t.mutation(internal.aiUsage.log, {
    accountId: bobId,
    mode: "draft",
    provider: "openai",
    model: "gpt-4o-mini",
    promptTokens: 999,
    completionTokens: 999,
    totalTokens: 1998,
  });

  const result = await asAlice.query(api.aiUsage.summary, {
    sinceMs: CUTOFF,
    dayKeys: ["2026-07-05", "2026-07-06", "2026-07-07", "2026-07-08"],
    tzOffsetMinutes: 0,
  });

  // Alice's two in-window calls only: the 07-01 row is before the window
  // and Bob's is on another account.
  expect(result.totals.calls).toBe(2);
  expect(result.totals.totalTokens).toBe(220);
  expect(result.byMode.draft).toEqual({ calls: 1, tokens: 20 });
  expect(result.byMode.auto_reply).toEqual({ calls: 1, tokens: 200 });
  expect(result.daily).toEqual([
    { date: "2026-07-05", tokens: 20, calls: 1 },
    { date: "2026-07-06", tokens: 0, calls: 0 },
    { date: "2026-07-07", tokens: 0, calls: 0 },
    { date: "2026-07-08", tokens: 200, calls: 1 },
  ]);
  expect(result.byModel).toEqual([
    {
      provider: "anthropic",
      model: "claude-3-5-sonnet",
      calls: 1,
      tokens: 200,
      promptTokens: 100,
      completionTokens: 100,
      cachedPromptTokens: 0,
    },
    {
      provider: "openai",
      model: "gpt-4o-mini",
      calls: 1,
      tokens: 20,
      promptTokens: 10,
      completionTokens: 10,
      cachedPromptTokens: 0,
    },
  ]);
});

test("cross-account denial: B's summary never includes A's usage rows", async () => {
  const t = convexTest(schema, modules);
  const { accountId: aliceId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });
  const { asUser: asBob } = await seedAccountMember(t, {
    name: "Bob",
    email: "bob@example.com",
    role: "admin",
  });

  await t.mutation(internal.aiUsage.log, {
    accountId: aliceId,
    mode: "draft",
    provider: "openai",
    model: "gpt-4o-mini",
    promptTokens: 10,
    completionTokens: 10,
    totalTokens: 20,
  });

  const bobsSummary = await asBob.query(api.aiUsage.summary, {
    sinceMs: 0,
    dayKeys: ["2026-06-20"],
    tzOffsetMinutes: 0,
  });
  expect(bobsSummary.totals.calls).toBe(0);
  expect(bobsSummary.totals.totalTokens).toBe(0);
  expect(bobsSummary.byModel).toEqual([]);
});

// Whole-branch review Fix 2: `summary` used to have no server-side role
// guard at all — the admin-only restriction was enforced ONLY by
// `ai-usage.tsx` skipping the query client-side, which is cosmetic (any
// authenticated member could call `api.aiUsage.summary` directly and see
// raw provider/model/token rows). This pins the guard is now real.
test("summary throws FORBIDDEN for a caller below the admin role", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });
  const supervisorId = await t.run((ctx) =>
    ctx.db.insert("users", { name: "Sam", email: "sam@example.com" }),
  );
  await t.run((ctx) =>
    ctx.db.insert("memberships", {
      userId: supervisorId,
      accountId,
      role: "supervisor",
      fullName: "Sam",
      email: "sam@example.com",
    }),
  );
  const asSupervisor = t.withIdentity({
    subject: `${supervisorId}|session-Sam`,
  });

  await expect(
    asSupervisor.query(api.aiUsage.summary, {
      sinceMs: 0,
      dayKeys: ["2026-06-20"],
      tzOffsetMinutes: 0,
    }),
  ).rejects.toMatchObject({ data: { code: "FORBIDDEN", min: "admin" } });
});

// The ad matcher used to log `mode: "classify"` — the tag suggester's
// own value — so two distinct agents wrote one timesheet line and
// neither could be counted. Split 2026-08-08 for the agent roster.
test("the ad matcher logs match_service, not the tag suggester's classify", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });

  await t.mutation(internal.aiUsage.log, {
    accountId,
    mode: "match_service",
    provider: "openai",
    model: "gpt-5",
    promptTokens: 10,
    completionTokens: 5,
    totalTokens: 15,
  });

  const rows = await t.run((ctx) => ctx.db.query("aiUsageLog").collect());
  expect(rows).toHaveLength(1);
  expect(rows[0]!.mode).toBe("match_service");
});

// The revival agent (spec 2026-08-09) — its own mode so the roster can
// report what it drafted today, separately from replies.
test("the revival agent logs under its own mode", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });

  await t.mutation(internal.aiUsage.log, {
    accountId,
    mode: "revive",
    provider: "openai",
    model: "gpt-5",
    promptTokens: 10,
    completionTokens: 5,
    totalTokens: 15,
  });

  const rows = await t.run((ctx) => ctx.db.query("aiUsageLog").collect());
  expect(rows).toHaveLength(1);
  expect(rows[0]!.mode).toBe("revive");
});

// ============================================================
// aiUsageHourlyStats — the read-bounded rollup behind the Usage tab
//
// `summary` used to `.collect()` the raw log, which is bounded by the
// window but NOT by traffic: at ~4k calls/day the default 30-day view
// asked Convex for ~120k documents and was killed ("too many system
// operations"), so the card showed a skeleton forever. These pin that
// the rollup is written on the same transaction as the ledger row, and
// that a re-run of the backfill converges rather than doubles.
// ============================================================

test("log folds the call into that hour's rollup bucket, one row per hour", async () => {
  const t = convexTest(schema, modules);
  const clock = makeClock(T0);
  clock(T0);
  const { accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });

  // Two calls in the same UTC hour, one in the next.
  clock(T0);
  await t.mutation(internal.aiUsage.log, {
    accountId,
    mode: "auto_reply",
    provider: "openai",
    model: "gpt-5",
    promptTokens: 1000,
    completionTokens: 100,
    totalTokens: 1100,
    cachedPromptTokens: 800,
    reasoningTokens: 40,
  });
  clock(T0 + 60_000);
  await t.mutation(internal.aiUsage.log, {
    accountId,
    mode: "embed",
    provider: "openai",
    model: "text-embedding-3-small",
    promptTokens: 8,
    completionTokens: 0,
    totalTokens: 8,
  });
  clock(T0 + 3_600_000);
  await t.mutation(internal.aiUsage.log, {
    accountId,
    mode: "auto_reply",
    provider: "openai",
    model: "gpt-5",
    promptTokens: 10,
    completionTokens: 2,
    totalTokens: 12,
  });

  const buckets = await t.run((ctx) =>
    ctx.db.query("aiUsageHourlyStats").collect(),
  );
  expect(buckets).toHaveLength(2);

  const first = buckets.find((b) => b.hourStartMs === T0)!;
  expect(first.calls).toBe(2);
  expect(first.totalTokens).toBe(1108);
  expect(first.reasoningTokens).toBe(40);
  // The embedding call reported no cache figure, so it must not dilute
  // the denominator — "not measured" is not a measured zero.
  expect(first.cachedPromptTokens).toBe(800);
  expect(first.cacheablePromptTokens).toBe(1000);
  expect(first.modes).toEqual([
    { mode: "auto_reply", calls: 1, tokens: 1100 },
    { mode: "embed", calls: 1, tokens: 8 },
  ]);
});

test("a zero-token call writes neither a ledger row nor a bucket", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });

  await t.mutation(internal.aiUsage.log, {
    accountId,
    mode: "draft",
    provider: "openai",
    model: "gpt-5",
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
  });

  expect(
    await t.run((ctx) => ctx.db.query("aiUsageHourlyStats").collect()),
  ).toHaveLength(0);
});

test("backfill rebuilds buckets from raw rows, and re-running converges", async () => {
  const t = convexTest(schema, modules);
  const clock = makeClock(T0);
  clock(T0);
  const { asUser: asAlice, accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });

  // Raw rows inserted directly — the shape every row on a deployment
  // that predates the rollup is in.
  clock(CUTOFF);
  await t.run(async (ctx) => {
    for (const totalTokens of [20, 200]) {
      await ctx.db.insert("aiUsageLog", {
        accountId,
        mode: "qualify",
        provider: "openai",
        model: "gpt-5",
        promptTokens: totalTokens - 5,
        completionTokens: 5,
        totalTokens,
      });
    }
  });

  const dayKeys = ["2026-07-05"];
  const before = await asAlice.query(api.aiUsage.summary, {
    sinceMs: CUTOFF,
    dayKeys,
    tzOffsetMinutes: 0,
  });
  expect(before.totals.totalTokens).toBe(0); // no buckets yet

  await t.mutation(internal.aiUsage.backfillAiUsageHourlyStats, {});
  const after = await asAlice.query(api.aiUsage.summary, {
    sinceMs: CUTOFF,
    dayKeys,
    tzOffsetMinutes: 0,
  });
  expect(after.totals.calls).toBe(2);
  expect(after.totals.totalTokens).toBe(220);
  expect(after.byMode.qualify).toEqual({ calls: 2, tokens: 220 });

  // The one property that matters for a hand-run backfill: SET, not
  // increment. A second pass must not double the numbers.
  await t.mutation(internal.aiUsage.backfillAiUsageHourlyStats, {});
  const twice = await asAlice.query(api.aiUsage.summary, {
    sinceMs: CUTOFF,
    dayKeys,
    tzOffsetMinutes: 0,
  });
  expect(twice.totals.totalTokens).toBe(220);
  expect(
    await t.run((ctx) => ctx.db.query("aiUsageHourlyStats").collect()),
  ).toHaveLength(1);
});

// The first production run of this backfill undercounted the two busiest
// days — an hour holding more calls than one batch used to be written
// from the truncated batch and then stepped past. That is a silently
// short bar on exactly the day worth looking at, so the overflow hour is
// re-read in full. BACKFILL_BATCH is 2000; this seeds one hour past it.
test("an hour bigger than one backfill batch is still counted exactly", async () => {
  const t = convexTest(schema, modules);
  const clock = makeClock(T0);
  clock(T0);
  const { asUser: asAlice, accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });

  const CALLS = 2400;
  clock(CUTOFF);
  await t.run(async (ctx) => {
    for (let i = 0; i < CALLS; i++) {
      await ctx.db.insert("aiUsageLog", {
        accountId,
        mode: "embed",
        provider: "openai",
        model: "text-embedding-3-small",
        promptTokens: 8,
        completionTokens: 0,
        totalTokens: 8,
      });
    }
  });

  await t.mutation(internal.aiUsage.backfillAiUsageHourlyStats, {});

  const out = await asAlice.query(api.aiUsage.summary, {
    sinceMs: CUTOFF,
    dayKeys: ["2026-07-05"],
    tzOffsetMinutes: 0,
  });
  expect(out.totals.calls).toBe(CALLS);
  expect(out.totals.totalTokens).toBe(CALLS * 8);
  expect(out.byMode.embed).toEqual({ calls: CALLS, tokens: CALLS * 8 });
});
