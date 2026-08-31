import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import type { AccountRole } from "./lib/roles";

// Convex function modules for convex-test to resolve `api.*`/`internal.*`
// references against — the absolute, from-project-root pattern every
// other `convex/*.test.ts` suite uses (see `convex/contacts.test.ts`).
const modules = import.meta.glob("/convex/**/*.ts");

/**
 * Seeds one account (or reuses `opts.accountId`, so a second call can add
 * another member to the SAME account — the RBAC test needs an agent and
 * a viewer sharing one conversation), a `qualificationConfigs` row
 * carrying the working-hours knobs `resolveSnoozeUntilMs` needs
 * (`utcOffsetMinutes: 240, workStartMinute: 600, workDays: [1..6]`, the
 * same Dubai defaults `seedChasing` in `inboxChaseAssign.test.ts` uses),
 * one contact, and one open conversation.
 *
 * `accounts.ownerUserId` and `contacts.phoneNormalized` are supplied
 * because the schema requires them even though this suite never reads
 * either — the same precedent `inboxChaseAssign.test.ts`'s `seedChasing`
 * documents.
 */
async function seedThread(
  t: ReturnType<typeof convexTest>,
  opts: { role: AccountRole; accountId?: Id<"accounts"> },
) {
  // `t.withIdentity` returns a rich test-client object (methods, not
  // data) — it must be built OUTSIDE `t.run`. `t.run`'s callback return
  // value crosses the same serialization boundary a mutation's return
  // value does (see `registration_impl.ts`'s `invokeMutation`), which
  // only accepts plain Convex values. `conversations.test.ts`'s
  // `seedAccountMember` is the precedent this follows.
  const { accountId, userId, contactId, conversationId } = await t.run(
    async (ctx) => {
      const userId = await ctx.db.insert("users", {
        name: `User-${opts.role}`,
        email: `${opts.role}-${Math.random().toString(36).slice(2)}@example.com`,
      });

      let accountId = opts.accountId;
      if (accountId === undefined) {
        accountId = await ctx.db.insert("accounts", {
          name: "Acct",
          defaultCurrency: "AED",
          ownerUserId: userId,
        });
        await ctx.db.insert("qualificationConfigs", {
          accountId,
          enabled: true,
          basicFields: [],
          qualifyThresholdScore: 60,
          timezoneLabel: "Asia/Dubai",
          utcOffsetMinutes: 240,
          workStartMinute: 600,
          workEndMinute: 1260,
          workDays: [1, 2, 3, 4, 5, 6],
          followUpDelaysMinutes: [60],
          maxFollowUps: 4,
          sessionWindowHours: 72,
          closingMessage: "thanks",
          adminAlertEnabled: false,
          adminAlertPhones: [],
          outboundNudgesEnabled: false,
          autoAssignEnabled: true,
        });
      }

      await ctx.db.insert("memberships", {
        userId,
        accountId,
        role: opts.role,
        fullName: `User-${opts.role}`,
        email: `${opts.role}@example.com`,
      });

      const contactId = await ctx.db.insert("contacts", {
        accountId,
        phone: "+971500000099",
        phoneNormalized: "971500000099",
        name: "Cust",
      });

      const conversationId = await ctx.db.insert("conversations", {
        accountId,
        contactId,
        status: "open",
        unreadCount: 0,
        lastMessageAt: Date.now() - 5 * 24 * 3_600_000,
        awaitingReply: false,
      });

      return { accountId, userId, contactId, conversationId };
    },
  );

  const asUser = t.withIdentity({ subject: `${userId}|s-${opts.role}` });
  return { accountId, userId, contactId, asUser, conversationId };
}

test("snooze sets the wake time, the author, and the reason", async () => {
  const t = convexTest(schema, modules);
  const { userId, asUser, conversationId } = await seedThread(t, { role: "agent" });
  await asUser.mutation(api.inboxOverrides.snooze, {
    conversationId, preset: "three_hours", reason: "customer asked to call Tuesday",
  });
  const c = await t.run((ctx) => ctx.db.get(conversationId));
  expect(c!.snoozedUntil).toBeGreaterThan(Date.now());
  expect(c!.snoozedByUserId).toBe(userId);
  expect(c!.snoozedReason).toBe("customer asked to call Tuesday");
});

test("wake CLEARS the fields rather than zeroing them", async () => {
  const t = convexTest(schema, modules);
  const { asUser, conversationId } = await seedThread(t, { role: "agent" });
  await asUser.mutation(api.inboxOverrides.snooze, { conversationId, preset: "tomorrow" });
  await asUser.mutation(api.inboxOverrides.wake, { conversationId });
  const c = await t.run((ctx) => ctx.db.get(conversationId));
  // undefined, NOT 0 — a sentinel would fall out of every lane range.
  expect(c!.snoozedUntil).toBeUndefined();
  expect(c!.snoozedByUserId).toBeUndefined();
  expect(c!.snoozedReason).toBeUndefined();
});

test("snooze and force are mutually exclusive — each clears the other", async () => {
  const t = convexTest(schema, modules);
  const { asUser, conversationId } = await seedThread(t, { role: "agent" });

  await asUser.mutation(api.inboxOverrides.snooze, { conversationId, preset: "tomorrow" });
  await asUser.mutation(api.inboxOverrides.forceChasing, { conversationId });
  let c = await t.run((ctx) => ctx.db.get(conversationId));
  expect(c!.snoozedUntil).toBeUndefined();
  expect(c!.chasingForcedAt).toBeGreaterThan(0);

  await asUser.mutation(api.inboxOverrides.snooze, { conversationId, preset: "tomorrow" });
  c = await t.run((ctx) => ctx.db.get(conversationId));
  expect(c!.chasingForcedAt).toBeUndefined();
  expect(c!.snoozedUntil).toBeGreaterThan(0);
});

test("a custom snooze beyond the ceiling is rejected", async () => {
  const t = convexTest(schema, modules);
  const { asUser, conversationId } = await seedThread(t, { role: "agent" });
  await expect(
    asUser.mutation(api.inboxOverrides.snooze, {
      conversationId, customMs: Date.now() + 45 * 24 * 3_600_000,
    }),
  ).rejects.toThrow();
});

test("an agent may snooze and force; a viewer may do neither", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser: asAgent, conversationId } = await seedThread(t, { role: "agent" });
  const { asUser: asViewer } = await seedThread(t, { role: "viewer", accountId });

  await asAgent.mutation(api.inboxOverrides.snooze, { conversationId, preset: "three_hours" });
  await asAgent.mutation(api.inboxOverrides.wake, { conversationId });
  await asAgent.mutation(api.inboxOverrides.forceChasing, { conversationId });

  await expect(
    asViewer.mutation(api.inboxOverrides.snooze, { conversationId, preset: "three_hours" }),
  ).rejects.toThrow();
  await expect(
    asViewer.mutation(api.inboxOverrides.forceChasing, { conversationId }),
  ).rejects.toThrow();
});

test("the wake sweep clears only snoozes that have come due", async () => {
  const t = convexTest(schema, modules);
  const { conversationId: due } = await seedThread(t, { role: "agent" });
  const { conversationId: notDue } = await seedThread(t, { role: "agent" });
  const now = Date.now();
  await t.run(async (ctx) => {
    await ctx.db.patch(due, { snoozedUntil: now - 60_000 });
    await ctx.db.patch(notDue, { snoozedUntil: now + 3_600_000 });
  });

  await t.mutation(internal.inboxOverrides.sweepSnoozeWake, {});

  expect((await t.run((ctx) => ctx.db.get(due)))!.snoozedUntil).toBeUndefined();
  expect((await t.run((ctx) => ctx.db.get(notDue)))!.snoozedUntil).toBeGreaterThan(now);
});

// ============================================================
// Final whole-branch review — the fix wave.
//
// Three of the five findings were instances of ONE invariant: a
// conversation must always be reachable in exactly one lane, and a
// customer waiting on us must appear in Active. Cleared fields are not
// the whole promise; what the spec actually promises is that the thread
// comes BACK.
// ============================================================

// Finding 5. The sweep test above asserts the fields are cleared, which
// is the mechanism, not the promise — the spec's §Waking says the thread
// "rejoins whichever lane it now derives into". A regression that cleared
// `snoozedUntil` to `0` instead of `undefined`, or that left one of the
// companion fields set, would pass the assertions above and still leave
// the row in no lane at all. So query the lane.
test("a woken thread rejoins its derived lane, not merely its fields", async () => {
  const t = convexTest(schema, modules);
  // `seedThread` seeds `lastMessageAt` 5 days back with
  // `awaitingReply: false`, and its `qualificationConfigs` row sets
  // `sessionWindowHours: 72` — so once awake this derives into Chasing.
  const { asUser, conversationId } = await seedThread(t, { role: "agent" });
  const lane = async (name: "active" | "waiting" | "chasing" | "snoozed") =>
    (
      await asUser.query(api.conversations.list, {
        lane: name,
        paginationOpts: { numItems: 50, cursor: null },
      })
    ).page.map((c) => c._id);

  await asUser.mutation(api.inboxOverrides.snooze, { conversationId, preset: "tomorrow" });
  // Parked: in Snoozed, in no working lane.
  expect(await lane("snoozed")).toEqual([conversationId]);
  for (const l of ["active", "waiting", "chasing"] as const) {
    expect(await lane(l)).not.toContain(conversationId);
  }

  // Bring the wake time forward so the sweep sees it as due.
  await t.run((ctx) => ctx.db.patch(conversationId, { snoozedUntil: Date.now() - 60_000 }));
  await t.mutation(internal.inboxOverrides.sweepSnoozeWake, {});

  // Back in exactly one lane — the one it derives into now, not the one
  // it left.
  expect(await lane("chasing")).toEqual([conversationId]);
  expect(await lane("snoozed")).toEqual([]);
  expect(await lane("active")).not.toContain(conversationId);
  expect(await lane("waiting")).not.toContain(conversationId);
});

// Finding 2. "Chase now" on a thread the CUSTOMER is waiting on drops it
// out of Active into Chasing, which sorts ascending by `lastMessageAt` —
// so a customer who wrote two minutes ago sorts LAST in a cold tab nobody
// watches. That is precisely "an override hid a customer waiting on us",
// the one thing the spec forbids outright.
test("forceChasing refuses a thread the customer is waiting on", async () => {
  const t = convexTest(schema, modules);
  const { asUser, conversationId } = await seedThread(t, { role: "agent" });
  await t.run((ctx) => ctx.db.patch(conversationId, { awaitingReply: true }));

  await expect(
    asUser.mutation(api.inboxOverrides.forceChasing, { conversationId }),
  ).rejects.toThrow(/chase_now_blocked_customer_waiting/);

  // And nothing was written — a rejected override must not leave a
  // half-applied row behind.
  expect((await t.run((ctx) => ctx.db.get(conversationId)))!.chasingForcedAt)
    .toBeUndefined();
});

test("forceChasing still works once we are the ones who spoke last", async () => {
  const t = convexTest(schema, modules);
  const { asUser, conversationId } = await seedThread(t, { role: "agent" });
  // `awaitingReply: false` from the fixture — the ordinary case, which the
  // guard above must not have broken.
  await asUser.mutation(api.inboxOverrides.forceChasing, { conversationId });
  expect((await t.run((ctx) => ctx.db.get(conversationId)))!.chasingForcedAt)
    .toBeGreaterThan(0);
});

// Finding 3. Every lane and both extra tabs bind
// `eq("archivedAt", undefined)`, so an override written onto an archived
// thread is invisible AND permanent: the agent is told "Snoozed until X"
// and the thread is in none of them. It is also the exact stale-override
// state the archive path was written to clear.
test("snooze refuses an archived conversation", async () => {
  const t = convexTest(schema, modules);
  const { asUser, conversationId } = await seedThread(t, { role: "agent" });
  await t.run((ctx) => ctx.db.patch(conversationId, { archivedAt: Date.now() }));

  await expect(
    asUser.mutation(api.inboxOverrides.snooze, { conversationId, preset: "three_hours" }),
  ).rejects.toThrow(/snooze_blocked_archived/);
  expect((await t.run((ctx) => ctx.db.get(conversationId)))!.snoozedUntil)
    .toBeUndefined();
});

test("forceChasing refuses an archived conversation", async () => {
  const t = convexTest(schema, modules);
  const { asUser, conversationId } = await seedThread(t, { role: "agent" });
  await t.run((ctx) => ctx.db.patch(conversationId, { archivedAt: Date.now() }));

  await expect(
    asUser.mutation(api.inboxOverrides.forceChasing, { conversationId }),
  ).rejects.toThrow(/chase_now_blocked_archived/);
  expect((await t.run((ctx) => ctx.db.get(conversationId)))!.chasingForcedAt)
    .toBeUndefined();
});

// Finding 5, and the spec's §Testing line "RBAC: agent can, viewer
// cannot, NEITHER CROSSES ACCOUNTS". The RBAC test above shares one
// account between both members, so it never exercised the tenancy edge —
// an agent with a perfectly valid `agent` role on their OWN account must
// not reach a conversation belonging to a different one, on any of the
// four mutations.
test("no override mutation reaches another account's conversation", async () => {
  const t = convexTest(schema, modules);
  const { asUser: asOutsider } = await seedThread(t, { role: "agent" });
  const { conversationId: theirs } = await seedThread(t, { role: "agent" });

  await expect(
    asOutsider.mutation(api.inboxOverrides.snooze, {
      conversationId: theirs, preset: "three_hours",
    }),
  ).rejects.toThrow();
  await expect(
    asOutsider.mutation(api.inboxOverrides.wake, { conversationId: theirs }),
  ).rejects.toThrow();
  await expect(
    asOutsider.mutation(api.inboxOverrides.forceChasing, { conversationId: theirs }),
  ).rejects.toThrow();
  await expect(
    asOutsider.mutation(api.inboxOverrides.unforceChasing, { conversationId: theirs }),
  ).rejects.toThrow();

  // Not a single field touched on the other account's row.
  const c = await t.run((ctx) => ctx.db.get(theirs));
  expect(c!.snoozedUntil).toBeUndefined();
  expect(c!.chasingForcedAt).toBeUndefined();
});
