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

test("create inserts a group scoped to the account and auto-assigns position", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId } = await seedAccountMember(t, { name: "Sup", email: "s@x.com", role: "supervisor" });

  const g0 = await asUser.mutation(api.tagGroups.create, { name: "Product", selectionMode: "single" });
  const g1 = await asUser.mutation(api.tagGroups.create, { name: "Destination", selectionMode: "multi" });

  const rows = await asUser.query(api.tagGroups.list);
  expect(rows.map((r) => r.name)).toEqual(["Product", "Destination"]);
  expect(rows[0].accountId).toBe(accountId);
  expect(rows[0].position).toBe(0);
  expect(rows[1].position).toBe(1);
  expect(rows[0]._id).toBe(g0);
  expect(rows[1]._id).toBe(g1);
});

test("create is FORBIDDEN below supervisor", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, { name: "Ag", email: "a@x.com", role: "agent" });
  await expect(
    asUser.mutation(api.tagGroups.create, { name: "Nope", selectionMode: "single" }),
  ).rejects.toMatchObject({ data: { code: "FORBIDDEN", min: "supervisor" } });
});

test("update changes name/mode; cross-account update is NOT_FOUND", async () => {
  const t = convexTest(schema, modules);
  const alice = await seedAccountMember(t, { name: "Al", email: "al@x.com", role: "supervisor" });
  const bob = await seedAccountMember(t, { name: "Bo", email: "bo@x.com", role: "supervisor" });
  const gid = await alice.asUser.mutation(api.tagGroups.create, { name: "Product", selectionMode: "single" });

  await alice.asUser.mutation(api.tagGroups.update, { groupId: gid, name: "Products", selectionMode: "multi" });
  const [row] = await alice.asUser.query(api.tagGroups.list);
  expect(row.name).toBe("Products");
  expect(row.selectionMode).toBe("multi");

  await expect(
    bob.asUser.mutation(api.tagGroups.update, { groupId: gid, name: "Hacked" }),
  ).rejects.toMatchObject({ data: { code: "NOT_FOUND", entity: "tagGroup" } });
});

test("remove ungroups its tags rather than deleting them", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId } = await seedAccountMember(t, { name: "Sup", email: "s2@x.com", role: "supervisor" });
  const gid = await asUser.mutation(api.tagGroups.create, { name: "Product", selectionMode: "single" });
  // Insert the tag directly — tags.create doesn't accept groupId until Task 3.
  const tagId = await t.run((ctx) =>
    ctx.db.insert("tags", { accountId, name: "UAE Visa", color: "#3b82f6", groupId: gid }),
  );

  await asUser.mutation(api.tagGroups.remove, { groupId: gid });

  expect(await asUser.query(api.tagGroups.list)).toHaveLength(0);
  const tag = await t.run((ctx) => ctx.db.get(tagId));
  expect(tag).not.toBeNull();          // tag survives
  expect(tag!.groupId).toBeUndefined(); // now ungrouped
});

test("reorder rewrites positions to array order", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, { name: "Sup", email: "s3@x.com", role: "supervisor" });
  const a = await asUser.mutation(api.tagGroups.create, { name: "A", selectionMode: "single" });
  const b = await asUser.mutation(api.tagGroups.create, { name: "B", selectionMode: "single" });
  await asUser.mutation(api.tagGroups.reorder, { orderedIds: [b, a] });
  const rows = await asUser.query(api.tagGroups.list);
  expect(rows.map((r) => r.name)).toEqual(["B", "A"]);
});
