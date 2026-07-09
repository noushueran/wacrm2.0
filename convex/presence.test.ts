/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { AccountRole } from "./lib/roles";

// Convex function modules for convex-test to resolve `api.*` references
// against. Absolute, from-project-root pattern (matches every other
// `convex/*.test.ts` suite — see `convex/lib/auth.test.ts`'s comment for
// why this must be absolute rather than a relative "./**").
const modules = import.meta.glob("/convex/**/*.ts");

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
// touch — upsert semantics, no role gate
// ============================================================

test("touch inserts a fresh row on the caller's first heartbeat, with no requireRole gate (a viewer can call it)", async () => {
  const t = convexTest(schema, modules);
  const { asUser, userId, accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "viewer",
  });

  const before = Date.now();
  await asUser.mutation(api.presence.touch, { status: "online" });

  const rows = await t.run((ctx) =>
    ctx.db
      .query("memberPresence")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect(),
  );
  expect(rows).toHaveLength(1);
  expect(rows[0]!.accountId).toBe(accountId);
  expect(rows[0]!.status).toBe("online");
  expect(rows[0]!.lastSeenAt).toBeGreaterThanOrEqual(before);
});

test("a second touch updates the same row rather than inserting a duplicate", async () => {
  const t = convexTest(schema, modules);
  const { asUser, userId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });

  const firstId = await asUser.mutation(api.presence.touch, {
    status: "online",
  });
  const firstSeenAt = await t.run(async (ctx) => {
    const row = await ctx.db.get(firstId);
    return row!.lastSeenAt;
  });

  // Ensure the clock actually advances between beats so a stale
  // `lastSeenAt` couldn't accidentally look "updated".
  await new Promise((resolve) => setTimeout(resolve, 5));

  const secondId = await asUser.mutation(api.presence.touch, {
    status: "away",
  });
  expect(secondId).toBe(firstId);

  const rows = await t.run((ctx) =>
    ctx.db
      .query("memberPresence")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect(),
  );
  expect(rows).toHaveLength(1);
  expect(rows[0]!.status).toBe("away");
  expect(rows[0]!.lastSeenAt).toBeGreaterThan(firstSeenAt);
});

// ============================================================
// list — account-scoped read
// ============================================================

test("list returns every presence row for the caller's own account, and none from another account", async () => {
  const t = convexTest(schema, modules);
  const { asUser: asAlice, accountId: aliceAccountId } =
    await seedAccountMember(t, {
      name: "Alice",
      email: "alice@example.com",
      role: "agent",
    });
  const { asUser: asBob } = await seedAccountMember(t, {
    name: "Bob",
    email: "bob@example.com",
    role: "agent",
  });

  await asAlice.mutation(api.presence.touch, { status: "online" });
  await asBob.mutation(api.presence.touch, { status: "away" });

  const aliceView = await asAlice.query(api.presence.list, {});
  expect(aliceView).toHaveLength(1);
  expect(aliceView[0]!.accountId).toBe(aliceAccountId);
  expect(aliceView[0]!.status).toBe("online");
});

test("list reflects multiple teammates' presence in the same account", async () => {
  const t = convexTest(schema, modules);
  const { asUser: asAlice, accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const carolId = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {
      name: "Carol",
      email: "carol@example.com",
    });
    await ctx.db.insert("memberships", {
      userId,
      accountId,
      role: "agent",
      fullName: "Carol",
      email: "carol@example.com",
    });
    return userId;
  });
  const asCarol = t.withIdentity({ subject: `${carolId}|session-Carol` });

  await asAlice.mutation(api.presence.touch, { status: "online" });
  await asCarol.mutation(api.presence.touch, { status: "away" });

  const view = await asAlice.query(api.presence.list, {});
  expect(view).toHaveLength(2);
  const statuses = view.map((row) => row.status).sort();
  expect(statuses).toEqual(["away", "online"]);
});
