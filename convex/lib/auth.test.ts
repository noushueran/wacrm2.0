/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { api } from "../_generated/api";
import schema from "../schema";
import type { Id } from "../_generated/dataModel";
import type { AccountRole } from "./roles";

// Convex function modules for convex-test to resolve `api.*` references
// against (mirrors `convex/accounts.test.ts`). Must be an absolute,
// from-project-root pattern here (not a relative "../**"): convex-test's
// moduleCache assumes every matched key shares one uniform prefix
// (derived from wherever "_generated" lands), but Vite normalizes a
// relative glob's keys to each match's own shortest relative path —
// from this file (one directory below the convex root), files inside
// `lib/` would come back "./foo.ts" while everything else comes back
// "../foo.ts", a mixed prefix that breaks that lookup. An absolute
// pattern keys every match uniformly as "/convex/...", regardless of
// this file's own nesting depth.
const modules = import.meta.glob("/convex/**/*.ts");

/**
 * Same auth-simulation pattern established in `convex/accounts.test.ts`:
 * insert a `users` row ourselves, then hand convex-test an identity whose
 * `subject` is `"<userId>|<sessionId>"` — `getAuthUserId` splits on `"|"`
 * and returns the first segment, so this round-trips to our seeded user.
 */
async function insertUser(
  t: ReturnType<typeof convexTest>,
  user: { name: string; email: string },
) {
  return await t.run(async (ctx) => ctx.db.insert("users", user));
}

/** Seed one account + one membership row directly (bypassing bootstrapAccount,
 * since this suite tests the `accountQuery`/`accountMutation` wrapper in
 * isolation, not `convex/accounts.ts`). Returns the new `accountId`. */
async function insertMembership(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
  role: AccountRole,
) {
  return await t.run(async (ctx) => {
    const accountId = await ctx.db.insert("accounts", {
      name: "Acme",
      defaultCurrency: "USD",
      ownerUserId: userId,
    });
    await ctx.db.insert("memberships", { userId, accountId, role });
    return accountId;
  });
}

test("accountQuery throws UNAUTHENTICATED when there is no identity", async () => {
  const t = convexTest(schema, modules);

  const error: unknown = await t
    .query(api.lib.authFixtures.whoAmI, {})
    .catch((e: unknown) => e);

  expect(error).toBeInstanceOf(ConvexError);
  expect((error as { data: unknown }).data).toEqual({
    code: "UNAUTHENTICATED",
  });
});

test("accountMutation throws UNAUTHENTICATED when there is no identity", async () => {
  const t = convexTest(schema, modules);

  await expect(
    t.mutation(api.lib.authFixtures.requireAtLeast, { min: "admin" }),
  ).rejects.toMatchObject({ data: { code: "UNAUTHENTICATED" } });
});

test("accountQuery throws NO_ACCOUNT when the identity has no membership", async () => {
  const t = convexTest(schema, modules);
  const userId = await insertUser(t, {
    name: "Nomad",
    email: "nomad@example.com",
  });
  const asNomad = t.withIdentity({ subject: `${userId}|session-nomad` });

  await expect(
    asNomad.query(api.lib.authFixtures.whoAmI, {}),
  ).rejects.toMatchObject({ data: { code: "NO_ACCOUNT" } });
});

test("accountQuery injects the caller's userId, accountId, and role from their membership", async () => {
  const t = convexTest(schema, modules);
  const userId = await insertUser(t, {
    name: "Priya",
    email: "priya@example.com",
  });
  const accountId = await insertMembership(t, userId, "admin");
  const asPriya = t.withIdentity({ subject: `${userId}|session-priya` });

  const result = await asPriya.query(api.lib.authFixtures.whoAmI, {});

  expect(result).toEqual({ userId, accountId, role: "admin" });
});

test("requireRole allows a caller whose role exactly matches the minimum", async () => {
  const t = convexTest(schema, modules);
  const userId = await insertUser(t, {
    name: "Agent",
    email: "agent@example.com",
  });
  await insertMembership(t, userId, "agent");
  const asAgent = t.withIdentity({ subject: `${userId}|session-agent` });

  await expect(
    asAgent.mutation(api.lib.authFixtures.requireAtLeast, { min: "agent" }),
  ).resolves.toEqual({ ok: true });
});

test("requireRole allows a caller whose role exceeds the minimum", async () => {
  const t = convexTest(schema, modules);
  const userId = await insertUser(t, {
    name: "Owner",
    email: "owner@example.com",
  });
  await insertMembership(t, userId, "owner");
  const asOwner = t.withIdentity({ subject: `${userId}|session-owner` });

  await expect(
    asOwner.mutation(api.lib.authFixtures.requireAtLeast, { min: "admin" }),
  ).resolves.toEqual({ ok: true });
});

test("requireRole throws FORBIDDEN for a caller below the minimum", async () => {
  const t = convexTest(schema, modules);
  const userId = await insertUser(t, {
    name: "Viewer",
    email: "viewer@example.com",
  });
  await insertMembership(t, userId, "viewer");
  const asViewer = t.withIdentity({ subject: `${userId}|session-viewer` });

  await expect(
    asViewer.mutation(api.lib.authFixtures.requireAtLeast, { min: "admin" }),
  ).rejects.toMatchObject({ data: { code: "FORBIDDEN", min: "admin" } });
});
