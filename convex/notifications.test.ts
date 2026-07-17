/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
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

/**
 * Adds a second membership row to an *existing* account — matches
 * `convex/conversations.test.ts`'s own `seedTeammate`.
 */
async function seedTeammate(
  t: ReturnType<typeof convexTest>,
  opts: {
    accountId: Id<"accounts">;
    name: string;
    email: string;
    role: AccountRole;
  },
) {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {
      name: opts.name,
      email: opts.email,
    });
    await ctx.db.insert("memberships", {
      userId,
      accountId: opts.accountId,
      role: opts.role,
      fullName: opts.name,
      email: opts.email,
    });
    return userId;
  });
}

// ============================================================
// create — agent+ gate, target must be a real member of the account
// ============================================================

test("create throws FORBIDDEN for a caller below the agent role", async () => {
  const t = convexTest(schema, modules);
  const { asUser, userId } = await seedAccountMember(t, {
    name: "Vera",
    email: "vera@example.com",
    role: "viewer",
  });

  await expect(
    asUser.mutation(api.notifications.create, {
      userId,
      type: "conversation_assigned",
      title: "Hi",
    }),
  ).rejects.toMatchObject({ data: { code: "FORBIDDEN", min: "agent" } });
});

test("create rejects a userId that is not a member of the account", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const { userId: outsiderId } = await seedAccountMember(t, {
    name: "Outsider",
    email: "outsider@example.com",
    role: "agent",
  });

  await expect(
    asUser.mutation(api.notifications.create, {
      userId: outsiderId,
      type: "conversation_assigned",
      title: "Hi",
    }),
  ).rejects.toMatchObject({ data: { code: "NOT_FOUND", entity: "member" } });
});

test("create inserts a notification the target member can see in their own list", async () => {
  const t = convexTest(schema, modules);
  const { asUser: asAlice, accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const carolId = await seedTeammate(t, {
    accountId,
    name: "Carol",
    email: "carol@example.com",
    role: "agent",
  });
  const asCarol = t.withIdentity({ subject: `${carolId}|session-Carol` });

  await asAlice.mutation(api.notifications.create, {
    userId: carolId,
    type: "conversation_assigned",
    title: "New conversation assigned",
    body: "Alice assigned you a conversation with a contact",
  });

  const carolsView = await asCarol.query(api.notifications.list, {});
  expect(carolsView).toHaveLength(1);
  expect(carolsView[0]!.userId).toBe(carolId);
  expect(carolsView[0]!.title).toBe("New conversation assigned");
  expect(carolsView[0]!.readAt).toBeUndefined();

  // Not visible in the creator's own list — it's Carol's notification,
  // not Alice's.
  const alicesView = await asAlice.query(api.notifications.list, {});
  expect(alicesView).toHaveLength(0);
});

// ============================================================
// list — scoped to the caller, newest-first
// ============================================================

test("list only ever returns the caller's own notifications, never a teammate's", async () => {
  const t = convexTest(schema, modules);
  const { asUser: asAlice, accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const bobId = await seedTeammate(t, {
    accountId,
    name: "Bob",
    email: "bob@example.com",
    role: "agent",
  });
  const asBob = t.withIdentity({ subject: `${bobId}|session-Bob` });

  await asAlice.mutation(api.notifications.create, {
    userId: bobId,
    type: "conversation_assigned",
    title: "For Bob",
  });

  expect(await asAlice.query(api.notifications.list, {})).toHaveLength(0);
  const bobsView = await asBob.query(api.notifications.list, {});
  expect(bobsView).toHaveLength(1);
  expect(bobsView[0]!.title).toBe("For Bob");
});

test("list orders notifications newest-first", async () => {
  const t = convexTest(schema, modules);
  const { asUser, userId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });

  const firstId = await asUser.mutation(api.notifications.create, {
    userId,
    type: "conversation_assigned",
    title: "First",
  });
  const secondId = await asUser.mutation(api.notifications.create, {
    userId,
    type: "conversation_assigned",
    title: "Second",
  });

  const result = await asUser.query(api.notifications.list, {});
  expect(result.map((n) => n._id)).toEqual([secondId, firstId]);
});

// ============================================================
// listRecent / unreadCount — the header bell's bounded reads. The bell
// mounts on every authenticated page, so unlike `list` (the
// /notifications page, loaded only when visited) neither of these may
// grow with the caller's notification history.
// ============================================================

/** An authenticated convex-test client, as `seedAccountMember` returns. */
type AsUser = ReturnType<ReturnType<typeof convexTest>["withIdentity"]>;

/** Creates `count` notifications for `userId`, oldest first. */
async function seedNotifications(
  asUser: AsUser,
  userId: Id<"users">,
  count: number,
) {
  const ids: Id<"notifications">[] = [];
  for (let i = 0; i < count; i++) {
    ids.push(
      await asUser.mutation(api.notifications.create, {
        userId,
        type: "conversation_assigned",
        title: `N${i}`,
      }),
    );
  }
  return ids;
}

test("listRecent returns only the newest `limit` notifications, newest-first", async () => {
  const t = convexTest(schema, modules);
  const { asUser, userId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });

  const ids = await seedNotifications(asUser, userId, 5);

  const recent = await asUser.query(api.notifications.listRecent, { limit: 2 });
  expect(recent.map((n) => n._id)).toEqual([ids[4], ids[3]]);
});

test("listRecent clamps a non-positive limit instead of throwing", async () => {
  const t = convexTest(schema, modules);
  const { asUser, userId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  await seedNotifications(asUser, userId, 3);

  // A negative limit makes Convex's `.take()` throw; the bell subscribes
  // to this on every page, so a bad client value must degrade to empty,
  // never a 500.
  const recent = await asUser.query(api.notifications.listRecent, {
    limit: -1,
  });
  expect(recent).toEqual([]);
});

test("listRecent never returns a teammate's notifications", async () => {
  const t = convexTest(schema, modules);
  const { asUser: asAlice, accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });
  const bobUserId = await t.run(async (ctx) => {
    const id = await ctx.db.insert("users", {
      name: "Bob",
      email: "bob@example.com",
    });
    await ctx.db.insert("memberships", {
      userId: id,
      accountId,
      role: "agent",
      fullName: "Bob",
      email: "bob@example.com",
    });
    return id;
  });

  await asAlice.mutation(api.notifications.create, {
    userId: bobUserId,
    type: "conversation_assigned",
    title: "For Bob",
  });

  expect(
    await asAlice.query(api.notifications.listRecent, { limit: 6 }),
  ).toEqual([]);
});

test("unreadCount returns the exact number of unread notifications below the cap", async () => {
  const t = convexTest(schema, modules);
  const { asUser, userId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });

  const ids = await seedNotifications(asUser, userId, 3);
  await asUser.mutation(api.notifications.markRead, { notificationId: ids[0] });

  expect(await asUser.query(api.notifications.unreadCount, {})).toBe(2);
});

test("unreadCount saturates at 10 so the badge can render '9+' without an unbounded read", async () => {
  const t = convexTest(schema, modules);
  const { asUser, userId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });

  await seedNotifications(asUser, userId, 25);

  // Saturates rather than reporting 25: `formatUnreadBadge` only needs
  // exact values 1-9 and renders anything >9 as "9+", so the read stops
  // at the cap instead of walking the caller's whole history.
  expect(await asUser.query(api.notifications.unreadCount, {})).toBe(10);
});

test("unreadCount never counts a teammate's unread notifications", async () => {
  const t = convexTest(schema, modules);
  const { asUser: asAlice, accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });
  const bobUserId = await t.run(async (ctx) => {
    const id = await ctx.db.insert("users", {
      name: "Bob",
      email: "bob@example.com",
    });
    await ctx.db.insert("memberships", {
      userId: id,
      accountId,
      role: "agent",
      fullName: "Bob",
      email: "bob@example.com",
    });
    return id;
  });

  await asAlice.mutation(api.notifications.create, {
    userId: bobUserId,
    type: "conversation_assigned",
    title: "For Bob",
  });

  expect(await asAlice.query(api.notifications.unreadCount, {})).toBe(0);
});

// ============================================================
// markRead / markAllRead — scoped to the caller
// ============================================================

test("markRead sets readAt on the caller's own notification", async () => {
  const t = convexTest(schema, modules);
  const { asUser, userId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const notificationId = await asUser.mutation(api.notifications.create, {
    userId,
    type: "conversation_assigned",
    title: "Hi",
  });

  const before = Date.now();
  const result = await asUser.mutation(api.notifications.markRead, {
    notificationId,
  });
  expect(result).toBe(notificationId);

  const row = await t.run((ctx) => ctx.db.get(notificationId));
  expect(row!.readAt).toBeGreaterThanOrEqual(before);
});

test("markRead throws NOT_FOUND for a notification belonging to a different recipient in the same account", async () => {
  const t = convexTest(schema, modules);
  const { asUser: asAlice, accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const bobId = await seedTeammate(t, {
    accountId,
    name: "Bob",
    email: "bob@example.com",
    role: "agent",
  });
  const asBob = t.withIdentity({ subject: `${bobId}|session-Bob` });

  const notificationId = await asAlice.mutation(api.notifications.create, {
    userId: bobId,
    type: "conversation_assigned",
    title: "For Bob",
  });

  await expect(
    asAlice.mutation(api.notifications.markRead, { notificationId }),
  ).rejects.toMatchObject({
    data: { code: "NOT_FOUND", entity: "notification" },
  });

  // Bob himself can mark it read — proves the throw above is really
  // about recipient isolation, not a broken markRead in general.
  await asBob.mutation(api.notifications.markRead, { notificationId });
  const row = await t.run((ctx) => ctx.db.get(notificationId));
  expect(row!.readAt).not.toBeUndefined();
});

test("markRead throws NOT_FOUND for a notification belonging to a different account", async () => {
  const t = convexTest(schema, modules);
  const { asUser: asAlice, userId: aliceId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const { asUser: asBob } = await seedAccountMember(t, {
    name: "Bob",
    email: "bob@example.com",
    role: "agent",
  });

  const notificationId = await asAlice.mutation(api.notifications.create, {
    userId: aliceId,
    type: "conversation_assigned",
    title: "For Alice",
  });

  await expect(
    asBob.mutation(api.notifications.markRead, { notificationId }),
  ).rejects.toMatchObject({
    data: { code: "NOT_FOUND", entity: "notification" },
  });
});

test("markAllRead marks every one of the caller's unread notifications, and none of a teammate's", async () => {
  const t = convexTest(schema, modules);
  const {
    asUser: asAlice,
    userId: aliceId,
    accountId,
  } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const bobId = await seedTeammate(t, {
    accountId,
    name: "Bob",
    email: "bob@example.com",
    role: "agent",
  });

  const a1 = await asAlice.mutation(api.notifications.create, {
    userId: aliceId,
    type: "conversation_assigned",
    title: "Alice 1",
  });
  const a2 = await asAlice.mutation(api.notifications.create, {
    userId: aliceId,
    type: "conversation_assigned",
    title: "Alice 2",
  });
  const bobNotificationId = await asAlice.mutation(api.notifications.create, {
    userId: bobId,
    type: "conversation_assigned",
    title: "Bob 1",
  });

  const count = await asAlice.mutation(api.notifications.markAllRead, {});
  expect(count).toBe(2);

  const [row1, row2, bobRow] = await t.run((ctx) =>
    Promise.all([
      ctx.db.get(a1),
      ctx.db.get(a2),
      ctx.db.get(bobNotificationId),
    ]),
  );
  expect(row1!.readAt).not.toBeUndefined();
  expect(row2!.readAt).not.toBeUndefined();
  // Bob's own notification is untouched by Alice's markAllRead.
  expect(bobRow!.readAt).toBeUndefined();
});

test("markAllRead is a no-op (returns 0) when the caller already has no unread notifications", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });

  const count = await asUser.mutation(api.notifications.markAllRead, {});
  expect(count).toBe(0);
});
