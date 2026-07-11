/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { api } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import type { AccountRole } from "./lib/roles";

// Absolute glob — see `convex/contacts.test.ts`'s comment on why this
// must be `/convex/**/*.ts`, not a relative `./**`.
const modules = import.meta.glob("/convex/**/*.ts");

/**
 * Seeds a fresh `users` row + a brand-new `accounts` row owned by them
 * + an `owner` `memberships` row, and returns a convex-test client
 * authenticated as that user. Same shape as every other suite's
 * `seedAccountMember` (see `convex/contacts.test.ts`), renamed
 * `seedOwner` here because this suite also needs `addMember` to add
 * *more* members into an already-seeded account (multi-member
 * scenarios are the whole point of testing `members.ts`).
 */
async function seedOwner(
  t: ReturnType<typeof convexTest>,
  opts: { name: string; email: string },
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
      role: "owner",
      fullName: opts.name,
      email: opts.email,
    });
    return id;
  });
  const asUser = t.withIdentity({ subject: `${userId}|session-${opts.name}` });
  return { userId, accountId, asUser };
}

/** Adds a new user as a member of an *existing* account (no new account created). */
async function addMember(
  t: ReturnType<typeof convexTest>,
  accountId: Id<"accounts">,
  opts: { name: string; email: string; role: AccountRole },
) {
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { name: opts.name, email: opts.email }),
  );
  await t.run((ctx) =>
    ctx.db.insert("memberships", {
      userId,
      accountId,
      role: opts.role,
      fullName: opts.name,
      email: opts.email,
    }),
  );
  const asUser = t.withIdentity({ subject: `${userId}|session-${opts.name}` });
  return { userId, asUser };
}

// ============================================================
// list
// ============================================================

test("list only returns members of the caller's own account", async () => {
  const t = convexTest(schema, modules);
  const { accountId: accountA, asUser: asOwnerA } = await seedOwner(t, {
    name: "Alice",
    email: "alice@example.com",
  });
  const { asUser: asOwnerB } = await seedOwner(t, {
    name: "Bob",
    email: "bob@example.com",
  });
  await addMember(t, accountA, {
    name: "Extra",
    email: "extra@example.com",
    role: "agent",
  });

  const bView = await asOwnerB.query(api.members.list, {});
  expect(bView).toHaveLength(1);

  const aView = await asOwnerA.query(api.members.list, {});
  expect(aView).toHaveLength(2);
});

test("list includes email only for admin+ callers, and nulls it out otherwise", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser: asOwner } = await seedOwner(t, {
    name: "Olga",
    email: "olga@example.com",
  });
  await addMember(t, accountId, {
    name: "Vic",
    email: "vic@example.com",
    role: "viewer",
  });
  const { asUser: asViewer } = await addMember(t, accountId, {
    name: "Val",
    email: "val@example.com",
    role: "viewer",
  });

  const ownerView = await asOwner.query(api.members.list, {});
  expect(ownerView).toHaveLength(3);
  for (const member of ownerView) {
    expect(member.email).not.toBeNull();
  }

  const viewerView = await asViewer.query(api.members.list, {});
  expect(viewerView).toHaveLength(3);
  for (const member of viewerView) {
    expect(member.email).toBeNull();
  }
});

// ============================================================
// setRole
// ============================================================

test("setRole throws FORBIDDEN for a caller below the admin role", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedOwner(t, {
    name: "Olga",
    email: "olga@example.com",
  });
  const { asUser: asAgent } = await addMember(t, accountId, {
    name: "Alex",
    email: "alex@example.com",
    role: "agent",
  });
  const { userId: targetId } = await addMember(t, accountId, {
    name: "Vera",
    email: "vera@example.com",
    role: "viewer",
  });

  await expect(
    asAgent.mutation(api.members.setRole, { userId: targetId, role: "agent" }),
  ).rejects.toMatchObject({ data: { code: "FORBIDDEN", min: "admin" } });
});

test("setRole lets an admin change a teammate's role (agent -> viewer)", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedOwner(t, {
    name: "Olga",
    email: "olga@example.com",
  });
  const { asUser: asAdmin } = await addMember(t, accountId, {
    name: "Ada",
    email: "ada@example.com",
    role: "admin",
  });
  const { userId: agentId } = await addMember(t, accountId, {
    name: "Casper",
    email: "casper@example.com",
    role: "agent",
  });

  await asAdmin.mutation(api.members.setRole, {
    userId: agentId,
    role: "viewer",
  });

  const row = await t.run((ctx) =>
    ctx.db
      .query("memberships")
      .withIndex("by_user", (q) => q.eq("userId", agentId))
      .first(),
  );
  expect(row!.role).toBe("viewer");
});

test("setRole rejects a caller targeting themself", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedOwner(t, {
    name: "Olga",
    email: "olga@example.com",
  });
  const { asUser: asAdmin, userId: adminId } = await addMember(t, accountId, {
    name: "Ada",
    email: "ada@example.com",
    role: "admin",
  });

  const error: unknown = await asAdmin
    .mutation(api.members.setRole, { userId: adminId, role: "viewer" })
    .catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ConvexError);
  expect((error as { data: unknown }).data).toEqual({
    code: "CANNOT_TARGET_SELF",
  });
});

test("setRole rejects changing the owner's role", async () => {
  const t = convexTest(schema, modules);
  const { accountId, userId: ownerId } = await seedOwner(t, {
    name: "Olga",
    email: "olga@example.com",
  });
  const { asUser: asAdmin } = await addMember(t, accountId, {
    name: "Ada",
    email: "ada@example.com",
    role: "admin",
  });

  await expect(
    asAdmin.mutation(api.members.setRole, { userId: ownerId, role: "admin" }),
  ).rejects.toMatchObject({ data: { code: "TARGET_IS_OWNER" } });
});

test("setRole rejects promoting a member to owner", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedOwner(t, {
    name: "Olga",
    email: "olga@example.com",
  });
  const { asUser: asAdmin } = await addMember(t, accountId, {
    name: "Ada",
    email: "ada@example.com",
    role: "admin",
  });
  const { userId: agentId } = await addMember(t, accountId, {
    name: "Casper",
    email: "casper@example.com",
    role: "agent",
  });

  await expect(
    asAdmin.mutation(api.members.setRole, { userId: agentId, role: "owner" }),
  ).rejects.toMatchObject({ data: { code: "CANNOT_ASSIGN_OWNER_ROLE" } });
});

test("setRole rejects a target from a different account", async () => {
  const t = convexTest(schema, modules);
  const { accountId: accountA } = await seedOwner(t, {
    name: "Alice",
    email: "alice@example.com",
  });
  const { asUser: asAdminA } = await addMember(t, accountA, {
    name: "Ada",
    email: "ada@example.com",
    role: "admin",
  });
  const { accountId: accountB } = await seedOwner(t, {
    name: "Bob",
    email: "bob@example.com",
  });
  const { userId: userInB } = await addMember(t, accountB, {
    name: "Guest",
    email: "guest@example.com",
    role: "agent",
  });

  await expect(
    asAdminA.mutation(api.members.setRole, {
      userId: userInB,
      role: "viewer",
    }),
  ).rejects.toMatchObject({ data: { code: "NOT_FOUND", entity: "member" } });
});

// ============================================================
// remove
// ============================================================

test("remove throws FORBIDDEN for a caller below the admin role", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedOwner(t, {
    name: "Olga",
    email: "olga@example.com",
  });
  const { asUser: asAgent } = await addMember(t, accountId, {
    name: "Alex",
    email: "alex@example.com",
    role: "agent",
  });
  const { userId: targetId } = await addMember(t, accountId, {
    name: "Vera",
    email: "vera@example.com",
    role: "viewer",
  });

  await expect(
    asAgent.mutation(api.members.remove, { userId: targetId }),
  ).rejects.toMatchObject({ data: { code: "FORBIDDEN", min: "admin" } });
});

test("remove rejects a caller targeting themself", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedOwner(t, {
    name: "Olga",
    email: "olga@example.com",
  });
  const { asUser: asAdmin, userId: adminId } = await addMember(t, accountId, {
    name: "Ada",
    email: "ada@example.com",
    role: "admin",
  });

  await expect(
    asAdmin.mutation(api.members.remove, { userId: adminId }),
  ).rejects.toMatchObject({ data: { code: "CANNOT_TARGET_SELF" } });
});

test("remove rejects targeting the owner", async () => {
  const t = convexTest(schema, modules);
  const { accountId, userId: ownerId } = await seedOwner(t, {
    name: "Olga",
    email: "olga@example.com",
  });
  const { asUser: asAdmin } = await addMember(t, accountId, {
    name: "Ada",
    email: "ada@example.com",
    role: "admin",
  });

  await expect(
    asAdmin.mutation(api.members.remove, { userId: ownerId }),
  ).rejects.toMatchObject({ data: { code: "TARGET_IS_OWNER" } });
});

test("remove rejects a target from a different account", async () => {
  const t = convexTest(schema, modules);
  const { accountId: accountA } = await seedOwner(t, {
    name: "Alice",
    email: "alice@example.com",
  });
  const { asUser: asAdminA } = await addMember(t, accountA, {
    name: "Ada",
    email: "ada@example.com",
    role: "admin",
  });
  const { accountId: accountB } = await seedOwner(t, {
    name: "Bob",
    email: "bob@example.com",
  });
  const { userId: userInB } = await addMember(t, accountB, {
    name: "Guest",
    email: "guest@example.com",
    role: "agent",
  });

  await expect(
    asAdminA.mutation(api.members.remove, { userId: userInB }),
  ).rejects.toMatchObject({ data: { code: "NOT_FOUND", entity: "member" } });
});

test("remove deletes the target's membership and gives them a fresh personal account", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedOwner(t, {
    name: "Olga",
    email: "olga@example.com",
  });
  const { asUser: asAdmin } = await addMember(t, accountId, {
    name: "Ada",
    email: "ada@example.com",
    role: "admin",
  });
  const { userId: agentId } = await addMember(t, accountId, {
    name: "Casper",
    email: "casper@example.com",
    role: "agent",
  });

  const newAccountId = await asAdmin.mutation(api.members.remove, {
    userId: agentId,
  });

  // The old membership (in the original account) is gone.
  const oldMembership = await t.run((ctx) =>
    ctx.db
      .query("memberships")
      .withIndex("by_user_account", (q) =>
        q.eq("userId", agentId).eq("accountId", accountId),
      )
      .first(),
  );
  expect(oldMembership).toBeNull();

  // A fresh personal account was created, owned by the ejected user.
  const newAccount = await t.run((ctx) => ctx.db.get(newAccountId));
  expect(newAccount).not.toBeNull();
  expect(newAccount!.ownerUserId).toBe(agentId);
  expect(newAccount!.name).toBe("Casper");

  // Their only remaining membership is `owner` of the new account.
  const memberships = await t.run((ctx) =>
    ctx.db
      .query("memberships")
      .withIndex("by_user", (q) => q.eq("userId", agentId))
      .collect(),
  );
  expect(memberships).toHaveLength(1);
  expect(memberships[0]!.accountId).toBe(newAccountId);
  expect(memberships[0]!.role).toBe("owner");
});

test("admin can set a member's role to supervisor", async () => {
  const t = convexTest(schema, modules);
  const adminId = await t.run((ctx) => ctx.db.insert("users", { name: "Ad", email: "ad@x.com" }));
  const targetId = await t.run((ctx) => ctx.db.insert("users", { name: "Ag", email: "ag@x.com" }));
  const accountId = await t.run(async (ctx) => {
    const id = await ctx.db.insert("accounts", { name: "Acme", defaultCurrency: "USD", ownerUserId: adminId });
    await ctx.db.insert("memberships", { userId: adminId, accountId: id, role: "admin" });
    await ctx.db.insert("memberships", { userId: targetId, accountId: id, role: "agent" });
    return id;
  });
  const asAdmin = t.withIdentity({ subject: `${adminId}|s` });
  await asAdmin.mutation(api.members.setRole, { userId: targetId, role: "supervisor" });
  const m = await t.run((ctx) =>
    ctx.db.query("memberships")
      .withIndex("by_user_account", (q) => q.eq("userId", targetId).eq("accountId", accountId))
      .first(),
  );
  expect(m?.role).toBe("supervisor");
});

test("supervisor cannot change roles", async () => {
  const t = convexTest(schema, modules);
  const supId = await t.run((ctx) => ctx.db.insert("users", { name: "Su", email: "su@x.com" }));
  const targetId = await t.run((ctx) => ctx.db.insert("users", { name: "Ag", email: "ag@x.com" }));
  await t.run(async (ctx) => {
    const id = await ctx.db.insert("accounts", { name: "Acme", defaultCurrency: "USD", ownerUserId: supId });
    await ctx.db.insert("memberships", { userId: supId, accountId: id, role: "supervisor" });
    await ctx.db.insert("memberships", { userId: targetId, accountId: id, role: "agent" });
  });
  const asSup = t.withIdentity({ subject: `${supId}|s` });
  await expect(
    asSup.mutation(api.members.setRole, { userId: targetId, role: "viewer" }),
  ).rejects.toMatchObject({ data: { code: "FORBIDDEN", min: "admin" } });
});
