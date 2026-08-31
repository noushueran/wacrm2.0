/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

// Convex function modules for convex-test to resolve `api.*` references
// against (mirrors every other convex/*.test.ts suite).
const modules = import.meta.glob("./**/*.ts");

const HOUR_MS = 1000 * 60 * 60;

/**
 * Seeds one user with two live sessions — a phone and a laptop — plus a
 * refresh token on the phone session, so the test can prove that
 * revoking the phone also tears down its token tree.
 *
 * The session ids must be REAL `authSessions` ids: `invalidateSessions`
 * validates `except` as `v.array(v.id("authSessions"))`, so the fake
 * string session ids used elsewhere in this suite family (e.g.
 * `${userId}|test-session` in accounts.test.ts) would be rejected here.
 */
async function seedTwoDevices(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {
      name: "Sarah",
      email: "sarah@example.com",
    });
    const phoneSessionId = await ctx.db.insert("authSessions", {
      userId,
      expirationTime: Date.now() + HOUR_MS,
    });
    const laptopSessionId = await ctx.db.insert("authSessions", {
      userId,
      expirationTime: Date.now() + HOUR_MS,
    });
    await ctx.db.insert("authRefreshTokens", {
      sessionId: phoneSessionId,
      expirationTime: Date.now() + HOUR_MS,
    });
    return { userId, phoneSessionId, laptopSessionId };
  });
}

test("revokes every other session and keeps the caller's own", async () => {
  const t = convexTest(schema, modules);
  const { userId, phoneSessionId, laptopSessionId } = await seedTwoDevices(t);

  const asLaptop = t.withIdentity({ subject: `${userId}|${laptopSessionId}` });
  const result = await asLaptop.action(api.sessions.signOutOtherDevices, {});
  expect(result).toBeNull();

  await t.run(async (ctx) => {
    expect(await ctx.db.get(laptopSessionId)).not.toBeNull();
    expect(await ctx.db.get(phoneSessionId)).toBeNull();
  });
});

test("tears down the revoked session's refresh tokens", async () => {
  const t = convexTest(schema, modules);
  const { userId, phoneSessionId, laptopSessionId } = await seedTwoDevices(t);

  const asLaptop = t.withIdentity({ subject: `${userId}|${laptopSessionId}` });
  await asLaptop.action(api.sessions.signOutOtherDevices, {});

  await t.run(async (ctx) => {
    const orphans = await ctx.db
      .query("authRefreshTokens")
      .withIndex("sessionId", (q) => q.eq("sessionId", phoneSessionId))
      .collect();
    // A surviving refresh token would let the revoked device mint a new
    // JWT and walk straight back in.
    expect(orphans).toEqual([]);
  });
});

test("leaves another user's sessions alone", async () => {
  const t = convexTest(schema, modules);
  const { userId, laptopSessionId } = await seedTwoDevices(t);

  const strangerSessionId = await t.run(async (ctx) => {
    const strangerId = await ctx.db.insert("users", {
      name: "Lee",
      email: "lee@example.com",
    });
    return await ctx.db.insert("authSessions", {
      userId: strangerId,
      expirationTime: Date.now() + HOUR_MS,
    });
  });

  const asLaptop = t.withIdentity({ subject: `${userId}|${laptopSessionId}` });
  await asLaptop.action(api.sessions.signOutOtherDevices, {});

  await t.run(async (ctx) => {
    expect(await ctx.db.get(strangerSessionId)).not.toBeNull();
  });
});

test("rejects an unauthenticated caller", async () => {
  const t = convexTest(schema, modules);
  // Pins the plan's stated contract — ConvexError({ code: "UNAUTHENTICATED" })
  // — not just "something threw". convex-test round-trips a ConvexError's
  // payload on `.data`, so this fails if the guard is ever swapped for a
  // generic Error, a different code, or a validator rejection instead.
  await expect(
    t.action(api.sessions.signOutOtherDevices, {}),
  ).rejects.toMatchObject({ data: { code: "UNAUTHENTICATED" } });
});
