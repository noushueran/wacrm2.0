/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { api } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import type { AccountRole } from "./lib/roles";
import { hashInviteToken } from "./lib/inviteToken";

// Absolute glob — see `convex/contacts.test.ts`'s comment on why this
// must be `/convex/**/*.ts`, not a relative `./**`.
const modules = import.meta.glob("/convex/**/*.ts");

/**
 * Seeds a fresh `users` row + a brand-new `accounts` row owned by them
 * + an `owner` `memberships` row, and returns a convex-test client
 * authenticated as that user. Same shape as `convex/members.test.ts`'s
 * `seedOwner` (each suite owns its own copy, per this codebase's
 * established convention — see `convex/contacts.test.ts`'s comment on
 * `seedAccountMember`).
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
// create / list / revoke — admin-gated, account-scoped
// ============================================================

test("create throws FORBIDDEN for a caller below the admin role", async () => {
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

  await expect(
    asAgent.mutation(api.invitations.create, { role: "viewer" }),
  ).rejects.toMatchObject({ data: { code: "FORBIDDEN", min: "admin" } });
});

test("create stores only the token hash and returns the plaintext token once", async () => {
  const t = convexTest(schema, modules);
  const { asUser: asOwner } = await seedOwner(t, {
    name: "Olga",
    email: "olga@example.com",
  });

  const created = await asOwner.mutation(api.invitations.create, {
    role: "agent",
    label: "Engineering",
  });

  expect(created.token).toHaveLength(43);
  expect(await hashInviteToken(created.token)).not.toBe(created.token);

  const row = await t.run((ctx) => ctx.db.get(created.invitationId));
  expect(row!.tokenHash).toBe(await hashInviteToken(created.token));
  expect(row!.tokenHash).not.toBe(created.token);
  expect(row!.role).toBe("agent");
  expect(row!.label).toBe("Engineering");
});

test("list only returns the caller's own account's invitations, admin-gated", async () => {
  const t = convexTest(schema, modules);
  const { accountId: accountA, asUser: asOwnerA } = await seedOwner(t, {
    name: "Alice",
    email: "alice@example.com",
  });
  await asOwnerA.mutation(api.invitations.create, { role: "viewer" });
  const { asUser: asOwnerB } = await seedOwner(t, {
    name: "Bob",
    email: "bob@example.com",
  });
  const { asUser: asAgentA } = await addMember(t, accountA, {
    name: "Alex",
    email: "alex@example.com",
    role: "agent",
  });

  expect(await asOwnerB.query(api.invitations.list, {})).toEqual([]);
  expect(await asOwnerA.query(api.invitations.list, {})).toHaveLength(1);
  await expect(
    asAgentA.query(api.invitations.list, {}),
  ).rejects.toMatchObject({ data: { code: "FORBIDDEN", min: "admin" } });
});

test("list never exposes tokenHash", async () => {
  const t = convexTest(schema, modules);
  const { asUser: asOwner } = await seedOwner(t, {
    name: "Olga",
    email: "olga@example.com",
  });
  await asOwner.mutation(api.invitations.create, { role: "viewer" });

  const rows = await asOwner.query(api.invitations.list, {});
  expect(rows).toHaveLength(1);
  expect(rows[0]).not.toHaveProperty("tokenHash");
});

test("revoke deletes an invitation scoped to the caller's own account", async () => {
  const t = convexTest(schema, modules);
  const { asUser: asOwner } = await seedOwner(t, {
    name: "Olga",
    email: "olga@example.com",
  });
  const created = await asOwner.mutation(api.invitations.create, {
    role: "viewer",
  });

  await asOwner.mutation(api.invitations.revoke, {
    invitationId: created.invitationId,
  });

  expect(await t.run((ctx) => ctx.db.get(created.invitationId))).toBeNull();
});

test("revoke throws when the invitation belongs to a different account", async () => {
  const t = convexTest(schema, modules);
  const { asUser: asOwnerA } = await seedOwner(t, {
    name: "Alice",
    email: "alice@example.com",
  });
  const created = await asOwnerA.mutation(api.invitations.create, {
    role: "viewer",
  });
  const { asUser: asOwnerB } = await seedOwner(t, {
    name: "Bob",
    email: "bob@example.com",
  });

  await expect(
    asOwnerB.mutation(api.invitations.revoke, {
      invitationId: created.invitationId,
    }),
  ).rejects.toMatchObject({ data: { code: "NOT_FOUND", entity: "invitation" } });

  // Untouched by the denied attempt.
  expect(await t.run((ctx) => ctx.db.get(created.invitationId))).not.toBeNull();
});

// ============================================================
// peek — public, minimal, never leaks
// ============================================================

test("peek returns ONLY {ok, accountName, role, expiresAt} for a valid invite", async () => {
  const t = convexTest(schema, modules);
  const { asUser: asOwner } = await seedOwner(t, {
    name: "Nadia",
    email: "nadia@example.com",
  });
  const created = await asOwner.mutation(api.invitations.create, {
    role: "agent",
    label: "Secret internal label",
  });
  const tokenHash = await hashInviteToken(created.token);

  const result = await t.query(api.invitations.peek, { tokenHash });

  expect(result).toEqual({
    ok: true,
    accountName: "Nadia's account",
    role: "agent",
    expiresAt: created.expiresAt,
  });
});

test("peek returns {ok:false, reason:'not_found'} for an unknown token hash", async () => {
  const t = convexTest(schema, modules);
  const result = await t.query(api.invitations.peek, {
    tokenHash: "does-not-exist",
  });
  expect(result).toEqual({ ok: false, reason: "not_found" });
});

test("peek returns {ok:false, reason:'expired'} for an expired invite", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedOwner(t, {
    name: "Olga",
    email: "olga@example.com",
  });
  const tokenHash = await hashInviteToken("expired-token");
  await t.run((ctx) =>
    ctx.db.insert("accountInvitations", {
      accountId,
      tokenHash,
      role: "viewer",
      expiresAt: Date.now() - 1000,
    }),
  );

  const result = await t.query(api.invitations.peek, { tokenHash });
  expect(result).toEqual({ ok: false, reason: "expired" });
});

test("peek returns {ok:false, reason:'used'} for an already-redeemed invite", async () => {
  const t = convexTest(schema, modules);
  const { accountId, userId: ownerId } = await seedOwner(t, {
    name: "Olga",
    email: "olga@example.com",
  });
  const tokenHash = await hashInviteToken("used-token");
  await t.run((ctx) =>
    ctx.db.insert("accountInvitations", {
      accountId,
      tokenHash,
      role: "viewer",
      expiresAt: Date.now() + 100_000,
      acceptedAt: Date.now(),
      acceptedByUserId: ownerId,
    }),
  );

  const result = await t.query(api.invitations.peek, { tokenHash });
  expect(result).toEqual({ ok: false, reason: "used" });
});

// ============================================================
// redeem
// ============================================================

test("redeem moves a fresh personal-account user into the invited account with the invite's role, marks the invite used, and cleans up the old account", async () => {
  const t = convexTest(schema, modules);
  const { accountId: targetAccountId, asUser: asTargetOwner } =
    await seedOwner(t, { name: "Nadia", email: "nadia@example.com" });
  const created = await asTargetOwner.mutation(api.invitations.create, {
    role: "agent",
  });
  const tokenHash = await hashInviteToken(created.token);

  const {
    userId: newUserId,
    accountId: oldAccountId,
    asUser: asNewUser,
  } = await seedOwner(t, { name: "Femi", email: "femi@example.com" });

  const joinedAccountId = await asNewUser.mutation(api.invitations.redeem, {
    tokenHash,
  });

  expect(joinedAccountId).toBe(targetAccountId);

  const membership = await t.run((ctx) =>
    ctx.db
      .query("memberships")
      .withIndex("by_user", (q) => q.eq("userId", newUserId))
      .first(),
  );
  expect(membership!.accountId).toBe(targetAccountId);
  expect(membership!.role).toBe("agent");

  const invitation = await t.run((ctx) =>
    ctx.db
      .query("accountInvitations")
      .withIndex("by_token_hash", (q) => q.eq("tokenHash", tokenHash))
      .first(),
  );
  expect(invitation!.acceptedAt).not.toBeUndefined();
  expect(invitation!.acceptedByUserId).toBe(newUserId);

  // Old personal account cleaned up.
  expect(await t.run((ctx) => ctx.db.get(oldAccountId))).toBeNull();

  // The now-used invite reports as such through `peek` too.
  expect(await t.query(api.invitations.peek, { tokenHash })).toEqual({
    ok: false,
    reason: "used",
  });
});

test("redeem creates a membership for an invited user who has no account yet (fresh invited signup), without creating or deleting a personal account", async () => {
  const t = convexTest(schema, modules);
  const { accountId: targetAccountId, asUser: asTargetOwner } =
    await seedOwner(t, { name: "Nadia", email: "nadia@example.com" });
  const created = await asTargetOwner.mutation(api.invitations.create, {
    role: "agent",
  });
  const tokenHash = await hashInviteToken(created.token);

  // A brand-new invitee: the sign-up-with-invite flow deliberately skips
  // `accounts.bootstrapAccount` (see src/app/(auth)/signup/page.tsx) and
  // `/join` isn't wrapped by the AuthProvider that would otherwise
  // bootstrap as a backstop, so this user is authenticated with NO
  // membership at all when they hit `redeem`. Seed exactly that: a bare
  // `users` row and an identity, no account, no membership.
  const newUserId = await t.run((ctx) =>
    ctx.db.insert("users", { name: "Femi", email: "femi@example.com" }),
  );
  const asNewUser = t.withIdentity({ subject: `${newUserId}|session-femi` });

  const accountsBefore = await t.run((ctx) =>
    ctx.db.query("accounts").collect(),
  );

  const joinedAccountId = await asNewUser.mutation(api.invitations.redeem, {
    tokenHash,
  });

  expect(joinedAccountId).toBe(targetAccountId);

  const membership = await t.run((ctx) =>
    ctx.db
      .query("memberships")
      .withIndex("by_user", (q) => q.eq("userId", newUserId))
      .first(),
  );
  expect(membership).not.toBeNull();
  expect(membership!.accountId).toBe(targetAccountId);
  expect(membership!.role).toBe("agent");
  // Display snapshot carried over from the user doc, same as bootstrap.
  expect(membership!.fullName).toBe("Femi");
  expect(membership!.email).toBe("femi@example.com");

  const invitation = await t.run((ctx) =>
    ctx.db
      .query("accountInvitations")
      .withIndex("by_token_hash", (q) => q.eq("tokenHash", tokenHash))
      .first(),
  );
  expect(invitation!.acceptedAt).not.toBeUndefined();
  expect(invitation!.acceptedByUserId).toBe(newUserId);

  // No throwaway personal account was created (and none deleted): the
  // only account in existence is still the inviter's target account.
  const accountsAfter = await t.run((ctx) => ctx.db.query("accounts").collect());
  expect(accountsAfter.map((a) => a._id)).toEqual(
    accountsBefore.map((a) => a._id),
  );
  expect(accountsAfter).toHaveLength(1);
  expect(accountsAfter[0]._id).toBe(targetAccountId);
});

test("redeem rejects an unauthenticated caller", async () => {
  const t = convexTest(schema, modules);
  const { asUser: asOwner } = await seedOwner(t, {
    name: "Olga",
    email: "olga@example.com",
  });
  const created = await asOwner.mutation(api.invitations.create, {
    role: "viewer",
  });
  const tokenHash = await hashInviteToken(created.token);

  await expect(
    t.mutation(api.invitations.redeem, { tokenHash }),
  ).rejects.toMatchObject({ data: { code: "UNAUTHENTICATED" } });
});

test("redeem rejects an unknown token hash", async () => {
  const t = convexTest(schema, modules);
  const { asUser: asNewUser } = await seedOwner(t, {
    name: "Femi",
    email: "femi@example.com",
  });

  await expect(
    asNewUser.mutation(api.invitations.redeem, {
      tokenHash: "does-not-exist",
    }),
  ).rejects.toMatchObject({
    data: { code: "INVALID_INVITATION", reason: "not_found" },
  });
});

test("redeem rejects an already-used token", async () => {
  const t = convexTest(schema, modules);
  const { asUser: asTargetOwner } = await seedOwner(t, {
    name: "Nadia",
    email: "nadia@example.com",
  });
  const created = await asTargetOwner.mutation(api.invitations.create, {
    role: "viewer",
  });
  const tokenHash = await hashInviteToken(created.token);

  const { asUser: firstRedeemer } = await seedOwner(t, {
    name: "Femi",
    email: "femi@example.com",
  });
  await firstRedeemer.mutation(api.invitations.redeem, { tokenHash });

  const { asUser: secondRedeemer } = await seedOwner(t, {
    name: "Grace",
    email: "grace@example.com",
  });
  await expect(
    secondRedeemer.mutation(api.invitations.redeem, { tokenHash }),
  ).rejects.toMatchObject({
    data: { code: "INVALID_INVITATION", reason: "used" },
  });
});

test("redeem rejects an expired token", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedOwner(t, {
    name: "Olga",
    email: "olga@example.com",
  });
  const tokenHash = await hashInviteToken("expired-token");
  await t.run((ctx) =>
    ctx.db.insert("accountInvitations", {
      accountId,
      tokenHash,
      role: "viewer",
      expiresAt: Date.now() - 1000,
    }),
  );
  const { asUser: asNewUser } = await seedOwner(t, {
    name: "Femi",
    email: "femi@example.com",
  });

  await expect(
    asNewUser.mutation(api.invitations.redeem, { tokenHash }),
  ).rejects.toMatchObject({
    data: { code: "INVALID_INVITATION", reason: "expired" },
  });
});

test("redeem rejects when the caller is already a member of the invite's account", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser: asOwner } = await seedOwner(t, {
    name: "Olga",
    email: "olga@example.com",
  });
  const created = await asOwner.mutation(api.invitations.create, {
    role: "viewer",
  });
  const tokenHash = await hashInviteToken(created.token);
  const { asUser: asAdmin } = await addMember(t, accountId, {
    name: "Ada",
    email: "ada@example.com",
    role: "admin",
  });

  await expect(
    asAdmin.mutation(api.invitations.redeem, { tokenHash }),
  ).rejects.toMatchObject({ data: { code: "ALREADY_MEMBER" } });
});

test("redeem rejects when the caller is a member (not sole owner) of another shared account", async () => {
  const t = convexTest(schema, modules);
  const { asUser: asTargetOwner } = await seedOwner(t, {
    name: "Target",
    email: "target@example.com",
  });
  const created = await asTargetOwner.mutation(api.invitations.create, {
    role: "viewer",
  });
  const tokenHash = await hashInviteToken(created.token);

  const { accountId: otherAccountId } = await seedOwner(t, {
    name: "Other",
    email: "other@example.com",
  });
  const { asUser: asOtherAgent } = await addMember(t, otherAccountId, {
    name: "Guest",
    email: "guest@example.com",
    role: "agent",
  });

  await expect(
    asOtherAgent.mutation(api.invitations.redeem, { tokenHash }),
  ).rejects.toMatchObject({ data: { code: "NOT_SOLE_OWNER" } });
});

test("redeem rejects when the caller's own account already has domain data", async () => {
  const t = convexTest(schema, modules);
  const { asUser: asTargetOwner } = await seedOwner(t, {
    name: "Target",
    email: "target@example.com",
  });
  const created = await asTargetOwner.mutation(api.invitations.create, {
    role: "viewer",
  });
  const tokenHash = await hashInviteToken(created.token);

  const { asUser: asNewUser } = await seedOwner(t, {
    name: "Femi",
    email: "femi@example.com",
  });
  await asNewUser.mutation(api.contacts.create, { phone: "555-0000" });

  await expect(
    asNewUser.mutation(api.invitations.redeem, { tokenHash }),
  ).rejects.toMatchObject({ data: { code: "ACCOUNT_HAS_DATA" } });
});

test("a foreign/unknown token reveals nothing through peek or redeem", async () => {
  const t = convexTest(schema, modules);
  const { asUser: asNewUser } = await seedOwner(t, {
    name: "Femi",
    email: "femi@example.com",
  });

  const peeked = await t.query(api.invitations.peek, {
    tokenHash: "totally-made-up",
  });
  expect(peeked).toEqual({ ok: false, reason: "not_found" });

  const error: unknown = await asNewUser
    .mutation(api.invitations.redeem, { tokenHash: "totally-made-up" })
    .catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ConvexError);
  expect((error as { data: unknown }).data).toEqual({
    code: "INVALID_INVITATION",
    reason: "not_found",
  });
});
