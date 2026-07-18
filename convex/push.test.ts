/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { api, internal } from "./_generated/api";
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
 * `convex/notifications.test.ts`'s own comment on this pattern.
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
 * Adds a second membership row to an *existing* account and returns an
 * authenticated client for them — matches `convex/conversations.test.ts`'s
 * own `seedTeammate`/`seedUserInAccount` pattern (a bare `userId` alone
 * isn't enough here since every `assembleDelivery` case needs each
 * teammate to be able to `subscribe`/`setPreferences` as themselves).
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
  const userId = await t.run(async (ctx) => {
    const id = await ctx.db.insert("users", {
      name: opts.name,
      email: opts.email,
    });
    await ctx.db.insert("memberships", {
      userId: id,
      accountId: opts.accountId,
      role: opts.role,
      fullName: opts.name,
      email: opts.email,
    });
    return id;
  });
  const asUser = t.withIdentity({ subject: `${userId}|session-${opts.name}` });
  return { userId, asUser };
}

/**
 * Seeds a contact + its conversation in one call, optionally
 * pre-assigned — mirrors `convex/conversations.test.ts`'s own `seedConv`.
 */
async function seedConversation(
  t: ReturnType<typeof convexTest>,
  opts: {
    accountId: Id<"accounts">;
    contactName?: string;
    phone?: string;
    assignedToUserId?: Id<"users">;
  },
) {
  const phone = opts.phone ?? "+15550001111";
  const contactId = await t.run((ctx) =>
    ctx.db.insert("contacts", {
      accountId: opts.accountId,
      phone,
      phoneNormalized: phone.replace(/\D/g, ""),
      name: opts.contactName,
    }),
  );
  const conversationId = await t.run((ctx) =>
    ctx.db.insert("conversations", {
      accountId: opts.accountId,
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

// ============================================================
// subscribe / unsubscribe — one row per device (endpoint), upserted.
// ============================================================

test("subscribe upserts by endpoint: same endpoint twice = one row, keys+lastSeenAt updated", async () => {
  const t = convexTest(schema, modules);
  const { asUser, userId, accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });

  await asUser.mutation(api.push.subscribe, {
    endpoint: "e1",
    p256dh: "k1",
    auth: "a1",
  });
  const firstRow = await t.run((ctx) =>
    ctx.db
      .query("pushSubscriptions")
      .withIndex("by_endpoint", (q) => q.eq("endpoint", "e1"))
      .first(),
  );
  expect(firstRow).not.toBeNull();
  const firstLastSeenAt = firstRow!.lastSeenAt;

  // Ensure the clock actually advances between the two calls so a stale
  // `lastSeenAt` couldn't accidentally look "updated" — same pattern as
  // `convex/presence.test.ts`'s own "a second touch updates..." test.
  await new Promise((resolve) => setTimeout(resolve, 5));

  await asUser.mutation(api.push.subscribe, {
    endpoint: "e1",
    p256dh: "k2",
    auth: "a2",
  });

  const rows = await t.run((ctx) =>
    ctx.db
      .query("pushSubscriptions")
      .withIndex("by_endpoint", (q) => q.eq("endpoint", "e1"))
      .collect(),
  );
  expect(rows).toHaveLength(1);
  expect(rows[0]!._id).toBe(firstRow!._id);
  expect(rows[0]!.p256dh).toBe("k2");
  expect(rows[0]!.auth).toBe("a2");
  expect(rows[0]!.accountId).toBe(accountId);
  expect(rows[0]!.userId).toBe(userId);
  expect(rows[0]!.lastSeenAt).toBeGreaterThan(firstLastSeenAt);
});

test("unsubscribe deletes only the caller's own subscription by endpoint", async () => {
  const t = convexTest(schema, modules);
  const { asUser: asAlice, accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const { asUser: asBob } = await seedTeammate(t, {
    accountId,
    name: "Bob",
    email: "bob@example.com",
    role: "agent",
  });

  await asAlice.mutation(api.push.subscribe, {
    endpoint: "eAlice",
    p256dh: "k",
    auth: "a",
  });
  await asBob.mutation(api.push.subscribe, {
    endpoint: "eBob",
    p256dh: "k",
    auth: "a",
  });

  // Alice tries to unsubscribe Bob's endpoint — must be a no-op, since
  // `existing.userId !== ctx.userId`.
  await asAlice.mutation(api.push.unsubscribe, { endpoint: "eBob" });
  const bobsRowAfterNoop = await t.run((ctx) =>
    ctx.db
      .query("pushSubscriptions")
      .withIndex("by_endpoint", (q) => q.eq("endpoint", "eBob"))
      .first(),
  );
  expect(bobsRowAfterNoop).not.toBeNull();

  // Alice unsubscribes her OWN endpoint — succeeds.
  await asAlice.mutation(api.push.unsubscribe, { endpoint: "eAlice" });
  const alicesRow = await t.run((ctx) =>
    ctx.db
      .query("pushSubscriptions")
      .withIndex("by_endpoint", (q) => q.eq("endpoint", "eAlice"))
      .first(),
  );
  expect(alicesRow).toBeNull();

  // Bob's row was never touched by either of Alice's calls.
  const bobsRowFinal = await t.run((ctx) =>
    ctx.db
      .query("pushSubscriptions")
      .withIndex("by_endpoint", (q) => q.eq("endpoint", "eBob"))
      .first(),
  );
  expect(bobsRowFinal).not.toBeNull();
});

// ============================================================
// getPreferences / setPreferences — per (user, account) row, defaults
// when absent.
// ============================================================

test("getPreferences defaults to pushEnabled=true, hidePreview=false with no row", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });

  expect(await asUser.query(api.push.getPreferences, {})).toEqual({
    pushEnabled: true,
    hidePreview: false,
  });
});

test("setPreferences upserts: inserts on first call, patches (without resetting other fields) on the next", async () => {
  const t = convexTest(schema, modules);
  const { asUser, userId, accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });

  await asUser.mutation(api.push.setPreferences, { hidePreview: true });
  expect(await asUser.query(api.push.getPreferences, {})).toEqual({
    pushEnabled: true,
    hidePreview: true,
  });
  const rowsAfterInsert = await t.run((ctx) =>
    ctx.db
      .query("notificationPreferences")
      .withIndex("by_user_account", (q) =>
        q.eq("userId", userId).eq("accountId", accountId),
      )
      .collect(),
  );
  expect(rowsAfterInsert).toHaveLength(1);

  // A later, partial call only touches the field it supplies.
  await asUser.mutation(api.push.setPreferences, { pushEnabled: false });
  expect(await asUser.query(api.push.getPreferences, {})).toEqual({
    pushEnabled: false,
    hidePreview: true, // untouched by the second call
  });
  const rowsAfterPatch = await t.run((ctx) =>
    ctx.db
      .query("notificationPreferences")
      .withIndex("by_user_account", (q) =>
        q.eq("userId", userId).eq("accountId", accountId),
      )
      .collect(),
  );
  expect(rowsAfterPatch).toHaveLength(1); // patched in place, not duplicated
});

// ============================================================
// assembleDelivery — the core of this module: resolves recipients,
// gates by preferences, builds payloads, loads subscriptions.
// ============================================================

test("assembleDelivery: assigned conversation delivers to the assignee, title = contact name", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountMember(t, {
    name: "Owner",
    email: "owner@example.com",
    role: "owner",
  });
  const { userId: annaId, asUser: asAnna } = await seedTeammate(t, {
    accountId,
    name: "Anna",
    email: "anna@example.com",
    role: "agent",
  });
  await asAnna.mutation(api.push.subscribe, {
    endpoint: "eAnna",
    p256dh: "kAnna",
    auth: "aAnna",
  });

  const { conversationId } = await seedConversation(t, {
    accountId,
    contactName: "Ravi Kumar",
    assignedToUserId: annaId,
  });

  const result = await t.query(internal.push.assembleDelivery, {
    accountId,
    conversationId,
    contentType: "text",
    text: "I'd like to book Bali",
  });

  expect(result.jobs).toHaveLength(1);
  expect(result.jobs[0]).toMatchObject({
    endpoint: "eAnna",
    p256dh: "kAnna",
    auth: "aAnna",
  });
  expect(result.jobs[0]!.payload.title).toBe("Ravi Kumar");
  expect(result.jobs[0]!.payload.body).toBe("I'd like to book Bali");
  expect(result.jobs[0]!.payload.url).toBe(`/inbox?c=${conversationId}`);
});

test("assembleDelivery: hidePreview collapses the payload to the generic body", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountMember(t, {
    name: "Owner",
    email: "owner@example.com",
    role: "owner",
  });
  const { userId: annaId, asUser: asAnna } = await seedTeammate(t, {
    accountId,
    name: "Anna",
    email: "anna@example.com",
    role: "agent",
  });
  await asAnna.mutation(api.push.subscribe, {
    endpoint: "eAnna",
    p256dh: "kAnna",
    auth: "aAnna",
  });
  await asAnna.mutation(api.push.setPreferences, { hidePreview: true });

  const { conversationId } = await seedConversation(t, {
    accountId,
    contactName: "Ravi Kumar",
    assignedToUserId: annaId,
  });

  const result = await t.query(internal.push.assembleDelivery, {
    accountId,
    conversationId,
    contentType: "text",
    text: "secret trip details",
  });

  expect(result.jobs).toHaveLength(1);
  expect(result.jobs[0]!.payload.title).toBe("Holidayys WA CRM");
  expect(result.jobs[0]!.payload.body).toBe("New WhatsApp message");
  // Routing still works even with the preview hidden.
  expect(result.jobs[0]!.payload.url).toBe(`/inbox?c=${conversationId}`);
});

test("assembleDelivery: pushEnabled=false excludes the recipient entirely", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountMember(t, {
    name: "Owner",
    email: "owner@example.com",
    role: "owner",
  });
  const { userId: annaId, asUser: asAnna } = await seedTeammate(t, {
    accountId,
    name: "Anna",
    email: "anna@example.com",
    role: "agent",
  });
  await asAnna.mutation(api.push.subscribe, {
    endpoint: "eAnna",
    p256dh: "kAnna",
    auth: "aAnna",
  });
  await asAnna.mutation(api.push.setPreferences, { pushEnabled: false });

  const { conversationId } = await seedConversation(t, {
    accountId,
    contactName: "Ravi Kumar",
    assignedToUserId: annaId,
  });

  const result = await t.query(internal.push.assembleDelivery, {
    accountId,
    conversationId,
    contentType: "text",
    text: "hello",
  });

  expect(result.jobs).toEqual([]);
});

test("assembleDelivery: unassigned conversation delivers to supervisor+ only, never agents/viewers", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser: asOwner } = await seedAccountMember(t, {
    name: "Owner",
    email: "owner@example.com",
    role: "owner",
  });
  const { asUser: asSup } = await seedTeammate(t, {
    accountId,
    name: "Sam Supervisor",
    email: "sam@example.com",
    role: "supervisor",
  });
  const { asUser: asAgent } = await seedTeammate(t, {
    accountId,
    name: "Alan Agent",
    email: "alan@example.com",
    role: "agent",
  });
  const { asUser: asViewer } = await seedTeammate(t, {
    accountId,
    name: "Vera Viewer",
    email: "vera@example.com",
    role: "viewer",
  });

  await asOwner.mutation(api.push.subscribe, {
    endpoint: "eOwner",
    p256dh: "k",
    auth: "a",
  });
  await asSup.mutation(api.push.subscribe, {
    endpoint: "eSup",
    p256dh: "k",
    auth: "a",
  });
  await asAgent.mutation(api.push.subscribe, {
    endpoint: "eAgent",
    p256dh: "k",
    auth: "a",
  });
  await asViewer.mutation(api.push.subscribe, {
    endpoint: "eViewer",
    p256dh: "k",
    auth: "a",
  });

  const { conversationId } = await seedConversation(t, {
    accountId,
    contactName: "Unassigned Lead",
    // no assignedToUserId — falls to the whole-pool policy.
  });

  const result = await t.query(internal.push.assembleDelivery, {
    accountId,
    conversationId,
    contentType: "text",
    text: "Hi there",
  });

  const endpoints = result.jobs.map((j) => j.endpoint).sort();
  expect(endpoints).toEqual(["eOwner", "eSup"]);
});

test("assembleDelivery: a subscription row scoped to a different account is never included", async () => {
  const t = convexTest(schema, modules);
  const { accountId, userId: ownerId } = await seedAccountMember(t, {
    name: "Owner",
    email: "owner@example.com",
    role: "owner",
  });
  const { accountId: otherAccountId } = await seedAccountMember(t, {
    name: "Other",
    email: "other-owner@example.com",
    role: "owner",
  });

  // Owner has TWO subscription rows for the SAME userId: one correctly
  // scoped to `accountId`, and one scoped to `otherAccountId` (e.g. a
  // stray row from acting on a different tenant). `pushSubscriptions`'s
  // `by_user` index is keyed only on `userId`, so a naive implementation
  // that loaded subs by `userId` alone (without also filtering by
  // `accountId`) would leak the second row into this account's jobs.
  // Inserted directly via `t.run` since the public `subscribe` mutation
  // always stamps the CALLER's own `ctx.accountId`, which can't be
  // steered to a second account for the same identity.
  await t.run((ctx) => {
    const now = Date.now();
    return ctx.db.insert("pushSubscriptions", {
      accountId,
      userId: ownerId,
      endpoint: "eOwnerHome",
      p256dh: "k1",
      auth: "a1",
      createdAt: now,
      lastSeenAt: now,
    });
  });
  await t.run((ctx) => {
    const now = Date.now();
    return ctx.db.insert("pushSubscriptions", {
      accountId: otherAccountId,
      userId: ownerId,
      endpoint: "eOwnerStray",
      p256dh: "k2",
      auth: "a2",
      createdAt: now,
      lastSeenAt: now,
    });
  });

  const { conversationId } = await seedConversation(t, {
    accountId,
    contactName: "Isolation Check",
    assignedToUserId: ownerId,
  });

  const result = await t.query(internal.push.assembleDelivery, {
    accountId,
    conversationId,
    contentType: "text",
    text: "hi",
  });

  expect(result.jobs.map((j) => j.endpoint)).toEqual(["eOwnerHome"]);
});

test("assembleDelivery: a conversation belonging to a different account returns no jobs", async () => {
  const t = convexTest(schema, modules);
  const { accountId: accountAId } = await seedAccountMember(t, {
    name: "Owner A",
    email: "owner-a@example.com",
    role: "owner",
  });
  const {
    accountId: accountBId,
    userId: ownerBId,
    asUser: asOwnerB,
  } = await seedAccountMember(t, {
    name: "Owner B",
    email: "owner-b@example.com",
    role: "owner",
  });

  // A subscribed, assignable member exists in account B, so if the
  // conversation-level guard were ever removed, the recipient-resolution
  // and subscription-loading logic below it would happily find and
  // return this job — proving the guard itself is what's under test.
  await asOwnerB.mutation(api.push.subscribe, {
    endpoint: "eOwnerB",
    p256dh: "kOwnerB",
    auth: "aOwnerB",
  });

  const { conversationId: conversationInB } = await seedConversation(t, {
    accountId: accountBId,
    contactName: "Account B Lead",
    assignedToUserId: ownerBId,
  });

  // Account A calls assembleDelivery for a conversation it doesn't own.
  const result = await t.query(internal.push.assembleDelivery, {
    accountId: accountAId,
    conversationId: conversationInB,
    contentType: "text",
    text: "hi",
  });

  expect(result).toEqual({ jobs: [] });
});

// ============================================================
// Opt-in account policy: "don't push for an inbound message a no-code
// flow fully handled." Default OFF (unset `suppressBotHandledPush` must
// never suppress — backward compatible with every test above, none of
// which pass `flowConsumed` at all). Suppression requires BOTH
// `flowConsumed: true` on the call AND the account flag ON.
// ============================================================

test("assembleDelivery: flowConsumed=true AND the account's suppressBotHandledPush=true returns no jobs", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser: asOwner } = await seedAccountMember(t, {
    name: "Owner",
    email: "owner@example.com",
    role: "owner",
  });
  const { userId: annaId, asUser: asAnna } = await seedTeammate(t, {
    accountId,
    name: "Anna",
    email: "anna@example.com",
    role: "agent",
  });
  // A subscribed assignee exists, so if the gate were missing (or
  // checked the wrong flag/arg), this would happily produce a job —
  // proving the gate itself is what's under test.
  await asAnna.mutation(api.push.subscribe, {
    endpoint: "eAnna",
    p256dh: "kAnna",
    auth: "aAnna",
  });
  await asOwner.mutation(api.push.setAccountPushPolicy, {
    suppressBotHandled: true,
  });

  const { conversationId } = await seedConversation(t, {
    accountId,
    contactName: "Ravi Kumar",
    assignedToUserId: annaId,
  });

  const result = await t.query(internal.push.assembleDelivery, {
    accountId,
    conversationId,
    contentType: "text",
    text: "handled entirely by the flow",
    flowConsumed: true,
  });

  expect(result.jobs).toEqual([]);
});

test("assembleDelivery: flowConsumed=true but suppressBotHandledPush is OFF (default) — jobs ARE produced", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountMember(t, {
    name: "Owner",
    email: "owner@example.com",
    role: "owner",
  });
  const { userId: annaId, asUser: asAnna } = await seedTeammate(t, {
    accountId,
    name: "Anna",
    email: "anna@example.com",
    role: "agent",
  });
  await asAnna.mutation(api.push.subscribe, {
    endpoint: "eAnna",
    p256dh: "kAnna",
    auth: "aAnna",
  });
  // No setAccountPushPolicy call — the flag stays at its default (unset).

  const { conversationId } = await seedConversation(t, {
    accountId,
    contactName: "Ravi Kumar",
    assignedToUserId: annaId,
  });

  const result = await t.query(internal.push.assembleDelivery, {
    accountId,
    conversationId,
    contentType: "text",
    text: "handled entirely by the flow",
    flowConsumed: true,
  });

  expect(result.jobs).toHaveLength(1);
  expect(result.jobs[0]).toMatchObject({
    endpoint: "eAnna",
    p256dh: "kAnna",
    auth: "aAnna",
  });
});

test("assembleDelivery: flowConsumed=false but suppressBotHandledPush=true — jobs ARE produced (suppression requires BOTH)", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser: asOwner } = await seedAccountMember(t, {
    name: "Owner",
    email: "owner@example.com",
    role: "owner",
  });
  const { userId: annaId, asUser: asAnna } = await seedTeammate(t, {
    accountId,
    name: "Anna",
    email: "anna@example.com",
    role: "agent",
  });
  await asAnna.mutation(api.push.subscribe, {
    endpoint: "eAnna",
    p256dh: "kAnna",
    auth: "aAnna",
  });
  await asOwner.mutation(api.push.setAccountPushPolicy, {
    suppressBotHandled: true,
  });

  const { conversationId } = await seedConversation(t, {
    accountId,
    contactName: "Ravi Kumar",
    assignedToUserId: annaId,
  });

  const result = await t.query(internal.push.assembleDelivery, {
    accountId,
    conversationId,
    contentType: "text",
    text: "a message the flow did NOT consume",
    flowConsumed: false,
  });

  expect(result.jobs).toHaveLength(1);
  expect(result.jobs[0]).toMatchObject({
    endpoint: "eAnna",
    p256dh: "kAnna",
    auth: "aAnna",
  });
});

test("setAccountPushPolicy: an admin can set the policy and getAccountPushPolicy reflects it", async () => {
  const t = convexTest(schema, modules);
  const { asUser: asAdmin } = await seedAccountMember(t, {
    name: "Amara Admin",
    email: "amara@example.com",
    role: "admin",
  });

  expect(await asAdmin.query(api.push.getAccountPushPolicy, {})).toEqual({
    suppressBotHandled: false,
  });

  await asAdmin.mutation(api.push.setAccountPushPolicy, {
    suppressBotHandled: true,
  });

  expect(await asAdmin.query(api.push.getAccountPushPolicy, {})).toEqual({
    suppressBotHandled: true,
  });
});

test("setAccountPushPolicy: a non-admin (agent) is rejected with FORBIDDEN", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountMember(t, {
    name: "Amara Admin",
    email: "amara@example.com",
    role: "admin",
  });
  const { asUser: asAgent } = await seedTeammate(t, {
    accountId,
    name: "Alan Agent",
    email: "alan@example.com",
    role: "agent",
  });

  await expect(
    asAgent.mutation(api.push.setAccountPushPolicy, {
      suppressBotHandled: true,
    }),
  ).rejects.toMatchObject({ data: { code: "FORBIDDEN", min: "admin" } });
});

// ============================================================
// assembleQualifiedLeadDelivery — qualification P2. Same recipient/
// preference rules as assembleDelivery; payload from the session.
// ============================================================

test("assembleQualifiedLeadDelivery: builds jobs for supervisor+ with score in the body, nothing without a qualified session", async () => {
  const t = convexTest(schema, modules);
  const { accountId, userId, asUser } = await seedAccountMember(t, {
    name: "Owner", email: "owner@example.com", role: "owner",
  });
  await asUser.mutation(api.push.subscribe, {
    endpoint: "eOwner", p256dh: "kOwner", auth: "aOwner",
  });
  const { contactId, conversationId } = await seedConversation(t, {
    accountId, contactName: "Ravi Kumar",
  });

  // no session → no jobs
  let result = await t.query(internal.push.assembleQualifiedLeadDelivery, {
    accountId, conversationId,
  });
  expect(result.jobs).toHaveLength(0);

  await t.run((ctx) =>
    ctx.db.insert("qualificationSessions", {
      accountId, conversationId, contactId,
      status: "qualified", origin: "inbound",
      fields: [], expectedCount: 4, answeredCount: 4,
      score: 82, serviceName: "UAE visa", qualifiedAt: 1,
      followUpsSent: 0, phrasingCursor: 0, sendAttemptErrors: 0,
    }),
  );
  result = await t.query(internal.push.assembleQualifiedLeadDelivery, {
    accountId, conversationId,
  });
  expect(result.jobs).toHaveLength(1);
  expect(result.jobs[0].payload.title).toContain("qualified lead");
  expect(result.jobs[0].payload.body).toContain("Ravi Kumar");
  expect(result.jobs[0].payload.body).toContain("82");
  expect(result.jobs[0].payload.tag).toBe(`qualified-${conversationId}`);

  // hidePreview collapses the body
  await asUser.mutation(api.push.setPreferences, {
    pushEnabled: true, hidePreview: true,
  });
  result = await t.query(internal.push.assembleQualifiedLeadDelivery, {
    accountId, conversationId,
  });
  expect(result.jobs[0].payload.body).toBe("New qualified lead");
  expect(result.jobs[0].payload.body).not.toContain("Ravi");
  void userId;
});
