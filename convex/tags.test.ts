/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { AccountRole } from "./lib/roles";

// Convex function modules for convex-test to resolve `api.*` references
// against. Absolute, from-project-root pattern (matches
// `convex/contacts.test.ts`/`convex/quickReplies.test.ts` — see those
// files' comments for why this must be absolute rather than a relative
// "./**").
const modules = import.meta.glob("/convex/**/*.ts");

/**
 * Seeds a `users` row + an `accounts`/`memberships` row for a fresh
 * account, and returns a convex-test client already authenticated as
 * that user. Duplicated from `convex/contacts.test.ts` rather than
 * imported — each `convex/*.test.ts` suite owns its own copy of this
 * helper (see that file's own comment on `seedAccountMember`).
 *
 * `convex/contacts.test.ts` already covers `tags.ts`'s account-scoping
 * (list/create isolation) and cascade-on-delete behavior (removing a
 * tag deletes its `contactTags` links) end-to-end through the
 * contacts+tags interaction — this file only covers what's specific to
 * `tags.ts` itself: the `create`/`remove` role floor (raised to
 * `supervisor` — see `convex/lib/roles.ts`'s "Settings split") and
 * `remove`'s cross-account `NOT_FOUND`.
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
// create
// ============================================================

test("create inserts a tag scoped to the caller's own account, from ctx — not from any client-supplied arg", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId } = await seedAccountMember(t, {
    name: "Sup",
    email: "sup@example.com",
    role: "supervisor",
  });

  const tagId = await asUser.mutation(api.tags.create, {
    name: "VIP",
    color: "#f00",
  });

  const row = await t.run((ctx) => ctx.db.get(tagId));
  expect(row).not.toBeNull();
  expect(row!.accountId).toBe(accountId);
  expect(row!.name).toBe("VIP");
  expect(row!.color).toBe("#f00");
});

test("create throws FORBIDDEN for a caller below the supervisor role", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Vera",
    email: "vera@example.com",
    role: "viewer",
  });

  await expect(
    asUser.mutation(api.tags.create, { name: "VIP", color: "#f00" }),
  ).rejects.toMatchObject({ data: { code: "FORBIDDEN", min: "supervisor" } });
});

test("supervisor can create a tag; agent cannot", async () => {
  const t = convexTest(schema, modules);
  const s = await seedAccountMember(t, { name: "Sup", email: "s@x.com", role: "supervisor" });
  await expect(
    s.asUser.mutation(api.tags.create, { name: "VIP", color: "#f00" }),
  ).resolves.not.toBeNull();

  const ag = await seedAccountMember(t, { name: "Ag", email: "ag@x.com", role: "agent" });
  await expect(
    ag.asUser.mutation(api.tags.create, { name: "Nope", color: "#00f" }),
  ).rejects.toMatchObject({ data: { code: "FORBIDDEN", min: "supervisor" } });
});

// ============================================================
// remove
// ============================================================

test("remove throws NOT_FOUND (not a silent no-op) for a different account's tag, and leaves it in place — the owning account can still remove it", async () => {
  const t = convexTest(schema, modules);
  const { asUser: asAlice } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "supervisor",
  });
  const { asUser: asBob } = await seedAccountMember(t, {
    name: "Bob",
    email: "bob@example.com",
    role: "supervisor",
  });
  const tagId = await asAlice.mutation(api.tags.create, {
    name: "VIP",
    color: "#f00",
  });

  await expect(
    asBob.mutation(api.tags.remove, { tagId }),
  ).rejects.toMatchObject({ data: { code: "NOT_FOUND", entity: "tag" } });
  expect(await t.run((ctx) => ctx.db.get(tagId))).not.toBeNull();

  // Positive control — proves the throw above is really about
  // cross-account isolation, not a broken mutation.
  await asAlice.mutation(api.tags.remove, { tagId });
  expect(await t.run((ctx) => ctx.db.get(tagId))).toBeNull();
});

test("supervisor can remove a tag; agent cannot", async () => {
  const t = convexTest(schema, modules);
  const sup = await seedAccountMember(t, {
    name: "Sup",
    email: "sup2@x.com",
    role: "supervisor",
  });
  const tagId = await sup.asUser.mutation(api.tags.create, {
    name: "VIP",
    color: "#f00",
  });

  const ag = await seedAccountMember(t, {
    name: "Ag",
    email: "ag2@x.com",
    role: "agent",
  });
  await expect(
    ag.asUser.mutation(api.tags.remove, { tagId }),
  ).rejects.toMatchObject({ data: { code: "FORBIDDEN", min: "supervisor" } });
  expect(await t.run((ctx) => ctx.db.get(tagId))).not.toBeNull();

  await sup.asUser.mutation(api.tags.remove, { tagId });
  expect(await t.run((ctx) => ctx.db.get(tagId))).toBeNull();
});

// ============================================================
// create with groupId + position
// ============================================================

test("create attaches a groupId + position when supplied", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, { name: "Sup", email: "sc@x.com", role: "supervisor" });
  const gid = await asUser.mutation(api.tagGroups.create, { name: "Product", selectionMode: "single" });
  const tagId = await asUser.mutation(api.tags.create, { name: "UAE Visa", color: "#3b82f6", groupId: gid, position: 2 });
  const row = await t.run((ctx) => ctx.db.get(tagId));
  expect(row!.groupId).toBe(gid);
  expect(row!.position).toBe(2);
});

// ============================================================
// update
// ============================================================

test("update renames, recolors, and moves a tag between groups", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, { name: "Sup", email: "su@x.com", role: "supervisor" });
  const g1 = await asUser.mutation(api.tagGroups.create, { name: "Product", selectionMode: "single" });
  const g2 = await asUser.mutation(api.tagGroups.create, { name: "Destination", selectionMode: "multi" });
  const tagId = await asUser.mutation(api.tags.create, { name: "Thailand", color: "#10b981", groupId: g1 });

  await asUser.mutation(api.tags.update, { tagId, name: "Thailand ✈", color: "#06b6d4", groupId: g2 });
  const row = await t.run((ctx) => ctx.db.get(tagId));
  expect(row!.name).toBe("Thailand ✈");
  expect(row!.color).toBe("#06b6d4");
  expect(row!.groupId).toBe(g2);
});

test("update is FORBIDDEN below supervisor and NOT_FOUND cross-account", async () => {
  const t = convexTest(schema, modules);
  const sup = await seedAccountMember(t, { name: "Sup", email: "su2@x.com", role: "supervisor" });
  const ag = await seedAccountMember(t, { name: "Ag", email: "ag3@x.com", role: "agent" });
  const tagId = await sup.asUser.mutation(api.tags.create, { name: "VIP", color: "#f00" });
  await expect(
    ag.asUser.mutation(api.tags.update, { tagId, name: "x" }),
  ).rejects.toMatchObject({ data: { code: "FORBIDDEN", min: "supervisor" } });

  const bob = await seedAccountMember(t, { name: "Bo", email: "bo2@x.com", role: "supervisor" });
  await expect(
    bob.asUser.mutation(api.tags.update, { tagId, name: "x" }),
  ).rejects.toMatchObject({ data: { code: "NOT_FOUND", entity: "tag" } });
});
