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
  });

  expect(result).toHaveLength(2);
  expect(result.every((row) => row.accountId === aliceId)).toBe(true);
  expect(result.every((row) => row._creationTime >= CUTOFF)).toBe(true);
  const totalTokensSeen = result.map((row) => row.totalTokens).sort();
  expect(totalTokensSeen).toEqual([20, 200]);
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

  const bobsSummary = await asBob.query(api.aiUsage.summary, { sinceMs: 0 });
  expect(bobsSummary).toHaveLength(0);
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
    asSupervisor.query(api.aiUsage.summary, { sinceMs: 0 }),
  ).rejects.toMatchObject({ data: { code: "FORBIDDEN", min: "admin" } });
});
