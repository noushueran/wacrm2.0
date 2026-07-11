/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import type { AccountRole } from "./lib/roles";

// Convex function modules for convex-test to resolve `api.*` references
// against. Absolute, from-project-root pattern (matches
// `convex/contacts.test.ts` — see that file's comment for why this must
// be absolute rather than a relative "./**").
const modules = import.meta.glob("/convex/**/*.ts");

async function seedUserInAccount(
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
  return { userId, asUser: t.withIdentity({ subject: `${userId}|s-${opts.name}` }) };
}

/**
 * Seeds a contact + its conversation in one call, optionally
 * pre-assigned — unlike `seedConversation` above, which takes an
 * already-created `contactId` and has no `assignedToUserId` knob. Used
 * by the role-scoped visibility tests to seed "mine" / "pool" /
 * "a teammate's" conversations.
 */
async function seedConv(
  t: ReturnType<typeof convexTest>,
  accountId: Id<"accounts">,
  opts: { phone: string; name: string; assignedToUserId?: Id<"users"> },
) {
  const contactId = await t.run((ctx) =>
    ctx.db.insert("contacts", {
      accountId,
      phone: opts.phone,
      phoneNormalized: opts.phone.replace(/\D/g, ""),
      name: opts.name,
    }),
  );
  const conversationId = await t.run((ctx) =>
    ctx.db.insert("conversations", {
      accountId,
      contactId,
      status: "open" as const,
      unreadCount: 0,
      ...(opts.assignedToUserId
        ? { assignedToUserId: opts.assignedToUserId }
        : {}),
    }),
  );
  return { contactId, conversationId };
}

/**
 * Seeds a bare account + its owner membership with no `asUser` client
 * of its own — the role-scoped visibility tests build their own
 * differently-roled teammates via `seedUserInAccount` and never need
 * to act as the owner directly.
 */
async function seedAccountWithOwner(t: ReturnType<typeof convexTest>) {
  const ownerId = await t.run((ctx) =>
    ctx.db.insert("users", { name: "Owner", email: "owner@x.com" }),
  );
  const accountId = await t.run(async (ctx) => {
    const id = await ctx.db.insert("accounts", {
      name: "Acme",
      defaultCurrency: "USD",
      ownerUserId: ownerId,
    });
    await ctx.db.insert("memberships", { userId: ownerId, accountId: id, role: "owner" });
    return id;
  });
  return { ownerId, accountId };
}

// ============================================================
// chargeLeadIfAgent (Phase 2, Task 2) — the helper wired into
// `conversations.assign` and `conversations.setAutoreplyPaused`.
// Feature-off / agents-only / idempotent / value-snapshot behavior.
// ============================================================

async function setRate(t: ReturnType<typeof convexTest>, accountId: Id<"accounts">, value: number) {
  await t.run((ctx) => ctx.db.patch(accountId, { leadValue: value }));
}
const rows = (t: ReturnType<typeof convexTest>) => t.run((ctx) => ctx.db.query("leadCharges").collect());

test("agent self-claim writes one charge with a snapshot", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountWithOwner(t);
  await setRate(t, accountId, 5);
  const a = await seedUserInAccount(t, accountId, { name: "A", email: "a@x.com", role: "agent" });
  const { conversationId } = await seedConv(t, accountId, { phone: "1", name: "L" });
  await a.asUser.mutation(api.conversations.assign, { conversationId, userId: a.userId });
  const all = await rows(t);
  expect(all).toHaveLength(1);
  expect(all[0]).toMatchObject({ userId: a.userId, conversationId, value: 5, currency: "USD" });
});

test("supervisor assigning to an agent charges the agent", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountWithOwner(t);
  await setRate(t, accountId, 5);
  const s = await seedUserInAccount(t, accountId, { name: "S", email: "s@x.com", role: "supervisor" });
  const a = await seedUserInAccount(t, accountId, { name: "A", email: "a@x.com", role: "agent" });
  const { conversationId } = await seedConv(t, accountId, { phone: "1", name: "L" });
  await s.asUser.mutation(api.conversations.assign, { conversationId, userId: a.userId });
  const all = await rows(t);
  expect(all).toHaveLength(1);
  expect(all[0].userId).toBe(a.userId);
});

test("no charge when target is not an agent (supervisor self-assign)", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountWithOwner(t);
  await setRate(t, accountId, 5);
  const s = await seedUserInAccount(t, accountId, { name: "S", email: "s@x.com", role: "supervisor" });
  const { conversationId } = await seedConv(t, accountId, { phone: "1", name: "L" });
  await s.asUser.mutation(api.conversations.assign, { conversationId, userId: s.userId });
  expect(await rows(t)).toHaveLength(0);
});

test("no charge when feature is off (leadValue unset)", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountWithOwner(t);
  const a = await seedUserInAccount(t, accountId, { name: "A", email: "a@x.com", role: "agent" });
  const { conversationId } = await seedConv(t, accountId, { phone: "1", name: "L" });
  await a.asUser.mutation(api.conversations.assign, { conversationId, userId: a.userId });
  expect(await rows(t)).toHaveLength(0);
});

test("idempotent: release + re-claim = one charge", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountWithOwner(t);
  await setRate(t, accountId, 5);
  const a = await seedUserInAccount(t, accountId, { name: "A", email: "a@x.com", role: "agent" });
  const { conversationId } = await seedConv(t, accountId, { phone: "1", name: "L" });
  await a.asUser.mutation(api.conversations.assign, { conversationId, userId: a.userId });
  await a.asUser.mutation(api.conversations.unassign, { conversationId });
  await a.asUser.mutation(api.conversations.assign, { conversationId, userId: a.userId });
  expect(await rows(t)).toHaveLength(1);
});

test("reassign A->B (by supervisor) = two independent charges", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountWithOwner(t);
  await setRate(t, accountId, 5);
  const s = await seedUserInAccount(t, accountId, { name: "S", email: "s@x.com", role: "supervisor" });
  const a = await seedUserInAccount(t, accountId, { name: "A", email: "a@x.com", role: "agent" });
  const b = await seedUserInAccount(t, accountId, { name: "B", email: "b@x.com", role: "agent" });
  const { conversationId } = await seedConv(t, accountId, { phone: "1", name: "L" });
  await s.asUser.mutation(api.conversations.assign, { conversationId, userId: a.userId });
  await s.asUser.mutation(api.conversations.assign, { conversationId, userId: b.userId });
  const all = await rows(t);
  expect(all).toHaveLength(2);
  expect(all.map((r) => r.userId).sort()).toEqual([a.userId, b.userId].sort());
});

test("value snapshot survives a later rate change", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountWithOwner(t);
  await setRate(t, accountId, 5);
  const a = await seedUserInAccount(t, accountId, { name: "A", email: "a@x.com", role: "agent" });
  const b = await seedUserInAccount(t, accountId, { name: "B", email: "b@x.com", role: "agent" });
  const c1 = await seedConv(t, accountId, { phone: "1", name: "L1" });
  await a.asUser.mutation(api.conversations.assign, { conversationId: c1.conversationId, userId: a.userId });
  await setRate(t, accountId, 9);
  const c2 = await seedConv(t, accountId, { phone: "2", name: "L2" });
  await b.asUser.mutation(api.conversations.assign, { conversationId: c2.conversationId, userId: b.userId });
  const all = await rows(t);
  expect(all.find((r) => r.userId === a.userId)?.value).toBe(5);
  expect(all.find((r) => r.userId === b.userId)?.value).toBe(9);
});

// ============================================================
// setAutoreplyPaused — the second `chargeLeadIfAgent` call site
// (Take-over/self-claim while pausing the AI bot). Same helper as
// `assign` above, so this section only proves the wiring at *this*
// call site: `paused:true` + `assignToMe:true` self-claims and
// charges; `assignToMe:false` never assigns, so never charges;
// `paused:false` (Resume AI) never calls the helper at all (lead-value
// fix wave, Task 2b — previously zero coverage on this path).
// ============================================================

test("setAutoreplyPaused(paused:true, assignToMe:true) writes one charge for the claiming agent", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountWithOwner(t);
  await setRate(t, accountId, 5);
  const a = await seedUserInAccount(t, accountId, { name: "A", email: "a@x.com", role: "agent" });
  const { conversationId } = await seedConv(t, accountId, { phone: "1", name: "L" });

  await a.asUser.mutation(api.conversations.setAutoreplyPaused, {
    conversationId,
    paused: true,
    assignToMe: true,
  });

  const all = await rows(t);
  expect(all).toHaveLength(1);
  expect(all[0]).toMatchObject({ userId: a.userId, conversationId, value: 5, currency: "USD" });
});

test("setAutoreplyPaused(paused:true, assignToMe:false) writes no charge", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountWithOwner(t);
  await setRate(t, accountId, 5);
  const a = await seedUserInAccount(t, accountId, { name: "A", email: "a@x.com", role: "agent" });
  const { conversationId } = await seedConv(t, accountId, { phone: "1", name: "L" });

  await a.asUser.mutation(api.conversations.setAutoreplyPaused, {
    conversationId,
    paused: true,
    assignToMe: false,
  });

  expect(await rows(t)).toHaveLength(0);
});

test("setAutoreplyPaused(paused:false) resume writes no charge", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountWithOwner(t);
  await setRate(t, accountId, 5);
  const a = await seedUserInAccount(t, accountId, { name: "A", email: "a@x.com", role: "agent" });
  const { conversationId } = await seedConv(t, accountId, { phone: "1", name: "L" });

  await a.asUser.mutation(api.conversations.setAutoreplyPaused, {
    conversationId,
    paused: false,
  });

  expect(await rows(t)).toHaveLength(0);
});
